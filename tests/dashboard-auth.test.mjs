import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inflateRawSync} from 'node:zlib';
import {handle} from '../src/aws-api.mjs';
import {digest} from '../src/aws-auth.mjs';
import {DynamoMetadataStore} from '../src/dynamodb-store.mjs';
import {encodeBase32, networkIdentity, totp} from '../src/dashboard-auth.mjs';
import {MemoryDynamo, commandClasses} from './memory-dynamo.mjs';
import {oktaResponse} from './saml-fixture.mjs';
import {first as firstSession, collisions, free as freeSessions, token as sessionToken, withSessionTokens} from './session-token-fixtures.mjs';
import {SAML} from '@node-saml/node-saml';

const password = 'Supatrace!1';
const email = 'ada@example.com';
const idpIssuer = 'http://www.okta.com/exk-test';
// Fixed windows keep mail-cap fixtures independent of wall-clock hash-slot collisions.
// Production collision/fail-closed behavior stays covered by dynamodb-store.test.mjs.
const MAIL_RATE_FIXTURE_TIME = 1792880000;

function idpMaterial() {
  const dir = mkdtempSync(join(tmpdir(), 'supatrace-saml-'));
  const key = join(dir, 'key.pem'), cert = join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', cert, '-days', '2', '-nodes', '-subj', '/CN=okta-test'], {stdio: 'ignore'});
  const material = {privateKey: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8')};
  rmSync(dir, {recursive: true, force: true});
  return material;
}

function world(extra = {}, limits = {}) {
  const config={client:new MemoryDynamo(),commands:commandClasses(),tableName:'metadata',...limits};
  const store=new DynamoMetadataStore(config);
  // Exercise the real limiter against the same table with a deterministic rate clock.
  // Session, challenge, certificate and TOTP clocks remain real.
  const rates=new DynamoMetadataStore({...config,now:()=>MAIL_RATE_FIXTURE_TIME});
  store.consumeRate=input=>rates.consumeRate(input);
  const mailbox = [];
  const env = {
    ENABLED: true, APP_ORIGIN: 'https://supatrace.dev', GITHUB_CLIENT_ID: 'synthetic-client', GITHUB_CLIENT_SECRET: 'synthetic-secret',
    store, objects: {}, sourceIp: '203.0.113.40', mailbox, ...extra
  };
  return {env, store, mailbox};
}
function dashboardEnv(limits = {}) {
  const keys = idpMaterial();
  const {env, store, mailbox} = world({
    CHATGPT_CLIENT_ID: 'chatgpt-client', CHATGPT_CLIENT_SECRET: 'chatgpt-secret',
    CHATGPT_AUTHORIZE_URL: 'http://127.0.0.1:9/authorize', CHATGPT_TOKEN_URL: 'http://127.0.0.1:9/token', CHATGPT_USERINFO_URL: 'http://127.0.0.1:9/userinfo',
    SSO_EMAIL_DOMAINS: 'hooli.com', SSO_IDP_SSO_URL: 'http://127.0.0.1:9/sso', SSO_IDP_ISSUER: idpIssuer, SSO_IDP_CERT: keys.cert,
    EMAIL_FROM: 'member@example.com', MFA_ENABLED: true, sendEmail: async message => { mailbox.push(message); }
  }, limits);
  return {env, store, mailbox, keys};
}
function cookie(response, name) {
  const hit = response.headers.getSetCookie().find(value => value.startsWith(name + '='));
  assert.ok(hit, name);
  return hit.split(';')[0];
}
function call(env, path, {method = 'GET', body, headers = {}, cookieHeader} = {}) {
  const requestHeaders = {...headers};
  if (body !== undefined && !requestHeaders['content-type']) requestHeaders['content-type'] = 'application/json';
  if (cookieHeader) requestHeaders.cookie = cookieHeader;
  return handle(new Request('https://supatrace.dev' + path, {method, headers: requestHeaders, body}), env);
}
const post = (env, path, body, extra = {}) => call(env, path, {method: 'POST', body: JSON.stringify(body), headers: {origin: env.APP_ORIGIN}, ...extra});
async function errorOf(response) { return {status: response.status, error: (await response.json()).error}; }
async function accounts(store) {
  return (await store._get({pk: 'SYS', sk: 'CAPACITY'}))?.accounts ?? 0;
}
function tokenFrom(text) { return text.match(/token=([A-Za-z0-9_-]{43})/)[1]; }
async function confirmEmail(env, text, passwordValue = password) {
  const link = text.match(/https:\/\/supatrace\.dev\/\S+/)[0];
  const url = new URL(link);
  const response = await post(env, '/api/auth/email/verify', {email: url.searchParams.get('email'), token: url.searchParams.get('token'), password: passwordValue});
  assert.equal(response.status, 204, 'confirmation signs in only when the password matches');
  assert.equal(response.headers.getSetCookie().some(value => value.startsWith('__Host-supatrace=')), true);
  return response;
}

async function postSaml(env, xml, relay, cookieHeader) {
  return call(env, '/api/auth/sso/callback', {method: 'POST', body: new URLSearchParams({SAMLResponse: xml, RelayState: relay}).toString(), headers: {'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader}});
}

test('providers stay off until each one is configured', async () => {
  const {env} = world();
  assert.ok(readFileSync(new URL('../docs/sign-in.md', import.meta.url), 'utf8').includes('MFA is enabled on supatrace.dev'));
  assert.deepEqual(await (await call(env, '/api/auth/providers')).json(), {github: true, chatgpt: false, sso: false, email: false, google: false, mfa: false, mfa_enabled: false});
  assert.deepEqual(await errorOf(await post(env, '/api/auth/mfa', {code: '000000'})), {status: 404, error: 'mfa_unavailable'});
  assert.deepEqual(await errorOf(await call(env, '/api/auth/chatgpt')), {status: 404, error: 'chatgpt_sign_in_unavailable'});
  assert.deepEqual(await errorOf(await call(env, '/api/auth/sso?email=gavin@hooli.com')), {status: 404, error: 'sso_sign_in_unavailable'});
  assert.deepEqual(await errorOf(await post(env, '/api/auth/email/sign-up', {email, password})), {status: 404, error: 'email_sign_in_unavailable'});
  const github = await call(env, '/api/auth/login');
  assert.equal(github.status, 302);
  assert.equal(new URL(github.headers.get('location')).origin, 'https://github.com');
});

test('a confirmation link does not sign anyone in, and only the newest password is set', async () => {
  const {env, store, mailbox} = dashboardEnv();
  const signup = await post(env, '/api/auth/email/sign-up', {email, password});
  assert.equal(signup.status, 200);
  const first = tokenFrom(mailbox[0].text);
  assert.equal(mailbox[0].subject, 'Finish signing up for Supatrace');
  assert.ok(mailbox[0].text === `Open this link and enter the password you chose. You will be signed in. The link expires in 10 minutes.\n${env.APP_ORIGIN}/?email=${encodeURIComponent(email)}&token=${first}\n`, 'signup email explains sign-in and expiry and preserves the confirmation link');
  assert.equal(mailbox[0].text.includes('The link does not create the account or sign you in.'), false);
  assert.equal(await accounts(store), 0);
  assert.equal(await store.getEmailAccount(email), null);
  await post(env, '/api/auth/email/sign-up', {email, password: 'Supatrace!2'});
  const second = tokenFrom(mailbox[1].text);
  assert.notEqual(first, second);
  assert.equal(await accounts(store), 0);
  const opened = await call(env, `/api/auth/email/verify?email=${encodeURIComponent(email)}&token=${second}`);
  assert.equal(opened.status, 302);
  const landed = new URL(opened.headers.get('location'));
  assert.equal(landed.searchParams.get('email'), email);
  assert.equal(landed.searchParams.get('token'), second);
  assert.equal(opened.headers.getSetCookie().some(value => value.startsWith('__Host-supatrace=')), false, 'opening the link must not set a session');
  assert.equal(await accounts(store), 0, 'opening the link must not create the account');
  assert.deepEqual(await errorOf(await post(env, '/api/auth/email/verify', {email, token: second, password})), {status: 401, error: 'invalid_credentials'});
  assert.equal(await accounts(store), 0, 'the earlier password must not confirm the newest sign-up');
  assert.deepEqual(await errorOf(await post(env, '/api/auth/email/verify', {email, token: first, password})), {status: 400, error: 'invalid_code'});
  assert.deepEqual(await errorOf(await post(env, '/api/auth/email/sign-in', {email, password: 'Supatrace!2'})), {status: 401, error: 'invalid_credentials'});
  const verify = await post(env, '/api/auth/email/verify', {email, token: second, password: 'Supatrace!2'});
  assert.equal(verify.status, 204);
  assert.equal(verify.headers.getSetCookie().some(value => value.startsWith('__Host-supatrace=')), true, 'matching password confirmation sets a session');
  const confirmedMe = await (await call(env, '/api/me', {cookieHeader: cookie(verify, '__Host-supatrace')})).json();
  assert.equal(confirmedMe.email, email);
  assert.equal(await accounts(store), 1);
  assert.deepEqual(await errorOf(await post(env, '/api/auth/email/sign-in', {email, password})), {status: 401, error: 'invalid_credentials'});
  const signedIn = await post(env, '/api/auth/email/sign-in', {email, password: 'Supatrace!2'});
  assert.equal(signedIn.status, 204);
  const body = await (await call(env, '/api/me', {cookieHeader: cookie(signedIn, '__Host-supatrace')})).json();
  assert.match(body.tenant_id, /^email-[a-f0-9]{64}$/);
  assert.equal(body.mfa, false);
  assert.equal(body.mfa_enabled, true);
  assert.deepEqual(await errorOf(await post(env, '/api/auth/email/sign-up', {email, password})), {status: 409, error: 'email_already_registered'});
});

test('signup is limited per email and per IPv6 prefix', async () => {
  const {env} = dashboardEnv();
  env.sourceIp = '2001:db8:1:2::10';
  for (let i = 0; i < 3; i++) assert.equal((await post(env, '/api/auth/email/sign-up', {email: `p${i}@net${i}.example`, password})).status, 200);
  env.sourceIp = '2001:db8:1:2::99';
  assert.deepEqual(await errorOf(await post(env, '/api/auth/email/sign-up', {email: 'p3@net3.example', password})), {status: 429, error: 'rate_limit'});
  env.sourceIp = '2001:db8:9:9::1';
  assert.equal((await post(env, '/api/auth/email/sign-up', {email: 'p3@net3.example', password})).status, 200);
  for (let i = 0; i < 5; i++) {
    env.sourceIp = `2001:db8:${i + 10}:1::1`;
    assert.equal((await post(env, '/api/auth/email/sign-up', {email: 'same@example.com', password})).status, 200);
  }
  env.sourceIp = '198.51.100.8';
  assert.deepEqual(await errorOf(await post(env, '/api/auth/email/sign-up', {email: 'same@example.com', password})), {status: 429, error: 'rate_limit'});
  assert.equal(networkIdentity('2001:db8:1:2::10'), networkIdentity('2001:db8:1:2::99'));
  assert.notEqual(networkIdentity('2001:db8:1:2::10'), networkIdentity('2001:db8:9:9::1'));
});

test('signup is capped per hour for the whole service and for each domain', async () => {
  // A wide rate table keeps this assertion on the caps. Production uses 5000 slots, and a collision there fails closed.
  const domain = dashboardEnv({rateSlots: 100000});
  for (let i = 0; i < 8; i++) {
    domain.env.sourceIp = `198.51.100.${i + 1}`;
    assert.equal((await post(domain.env, '/api/auth/email/sign-up', {email: `u${i}@cap-domain.test`, password})).status, 200);
  }
  domain.env.sourceIp = '198.51.100.20';
  assert.deepEqual(await errorOf(await post(domain.env, '/api/auth/email/sign-up', {email: 'u8@cap-domain.test', password})), {status: 429, error: 'rate_limit'});
  assert.equal((await post(domain.env, '/api/auth/email/sign-up', {email: 'other@other-domain.test', password})).status, 200);
  const global = dashboardEnv({rateSlots: 100000});
  for (let i = 0; i < 20; i++) {
    global.env.sourceIp = `203.0.113.${i + 1}`;
    assert.equal((await post(global.env, '/api/auth/email/sign-up', {email: `g${i}@hour${i}.example`, password})).status, 200, i);
  }
  global.env.sourceIp = '203.0.113.40';
  assert.deepEqual(await errorOf(await post(global.env, '/api/auth/email/sign-up', {email: 'late@hour21.example', password})), {status: 429, error: 'rate_limit'});
});

test('requests that fail before mail is sent do not spend the hourly caps', async () => {
  const domain = dashboardEnv({rateSlots: 100000});
  for (let i = 0; i < 20; i++) {
    domain.env.sourceIp = `198.51.100.${i + 1}`;
    assert.deepEqual(await errorOf(await post(domain.env, '/api/auth/email/sign-up', {email: `bad${i}@shared.test`, password: 'no'})), {status: 400, error: 'password_rejected'});
  }
  for (let i = 0; i < 8; i++) {
    domain.env.sourceIp = `198.51.100.${i + 1}`;
    assert.equal((await post(domain.env, '/api/auth/email/sign-up', {email: `ok${i}@shared.test`, password})).status, 200, 'rejected passwords must not spend the domain cap');
  }
  domain.env.sourceIp = '198.51.100.40';
  assert.deepEqual(await errorOf(await post(domain.env, '/api/auth/email/sign-up', {email: 'over@shared.test', password})), {status: 429, error: 'rate_limit'});
  const global = dashboardEnv({rateSlots: 100000});
  for (let i = 0; i < 30; i++) {
    global.env.sourceIp = `203.0.113.${(i % 20) + 1}`;
    assert.deepEqual(await errorOf(await post(global.env, '/api/auth/email/sign-up', {email: `junk${i}@hour${i}.example`, password: 'no'})), {status: 400, error: 'password_rejected'});
  }
  for (let i = 0; i < 20; i++) {
    global.env.sourceIp = `192.0.2.${i + 1}`;
    assert.equal((await post(global.env, '/api/auth/email/sign-up', {email: `g${i}@kept${i}.example`, password})).status, 200, i);
  }
});

test('each network can send only a few sign-up emails an hour', async () => {
  const {env} = dashboardEnv({rateSlots: 100000});
  env.sourceIp = '2001:db8:7:7::1';
  for (let i = 0; i < 3; i++) assert.equal((await post(env, '/api/auth/email/sign-up', {email: `n${i}@net${i}.example`, password})).status, 200);
  env.sourceIp = '2001:db8:7:7::abcd';
  assert.deepEqual(await errorOf(await post(env, '/api/auth/email/sign-up', {email: 'n3@net3.example', password})), {status: 429, error: 'rate_limit'});
  env.sourceIp = '2001:db8:8:8::1';
  assert.equal((await post(env, '/api/auth/email/sign-up', {email: 'n3@net3.example', password})).status, 200);
});

test('one reset code is live, and five misses burn it', async () => {
  const {env, mailbox} = dashboardEnv();
  await post(env, '/api/auth/email/sign-up', {email, password});
  await confirmEmail(env, mailbox[0].text);
  mailbox.length = 0;
  await post(env, '/api/auth/email/reset', {email});
  const first = mailbox[0].text.match(/reset code is (\d{6})/)[1];
  await post(env, '/api/auth/email/reset', {email});
  const second = mailbox[1].text.match(/reset code is (\d{6})/)[1];
  assert.notEqual(first, second);
  assert.deepEqual(await errorOf(await post(env, '/api/auth/email/reset/confirm', {email, code: first})), {status: 400, error: 'invalid_code'});
  for (let i = 0; i < 4; i++) assert.deepEqual(await errorOf(await post(env, '/api/auth/email/reset/confirm', {email, code: '000000'})), {status: 400, error: 'invalid_code'});
  assert.deepEqual(await errorOf(await post(env, '/api/auth/email/reset/confirm', {email, code: second})), {status: 400, error: 'invalid_code'});
  mailbox.length = 0;
  await post(env, '/api/auth/email/reset', {email});
  const code = mailbox[0].text.match(/reset code is (\d{6})/)[1];
  const confirmed = await post(env, '/api/auth/email/reset/confirm', {email, code});
  const resetCookie = cookie(confirmed, '__Host-supatrace-reset');
  assert.deepEqual(await errorOf(await post(env, '/api/auth/email/reset/password', {password: 'short'}, {cookieHeader: resetCookie})), {status: 400, error: 'password_rejected'});
  assert.equal((await post(env, '/api/auth/email/reset/password', {password: 'Next!2345'}, {cookieHeader: resetCookie})).status, 200);
  assert.equal((await post(env, '/api/auth/email/sign-in', {email, password: 'Next!2345'})).status, 204);
});

test('resetting the password ends every existing session', async () => {
  const {env, mailbox} = dashboardEnv();
  await post(env, '/api/auth/email/sign-up', {email, password});
  await confirmEmail(env, mailbox[0].text);
  const first = cookie(await withSessionTokens([firstSession], () => post(env, '/api/auth/email/sign-in', {email, password})), '__Host-supatrace');
  const second = cookie(await withSessionTokens([freeSessions[0]], () => post(env, '/api/auth/email/sign-in', {email, password})), '__Host-supatrace');
  assert.notEqual(first, second);
  assert.equal((await call(env, '/api/me', {cookieHeader: first})).status, 200);
  assert.equal((await call(env, '/api/me', {cookieHeader: second})).status, 200);
  mailbox.length = 0;
  await post(env, '/api/auth/email/reset', {email});
  const code = mailbox[0].text.match(/reset code is (\d{6})/)[1];
  const resetCookie = cookie(await post(env, '/api/auth/email/reset/confirm', {email, code}), '__Host-supatrace-reset');
  assert.deepEqual(await errorOf(await post(env, '/api/auth/email/reset/password', {password: 'short'}, {cookieHeader: resetCookie})), {status: 400, error: 'password_rejected'});
  assert.equal((await call(env, '/api/me', {cookieHeader: first})).status, 200, 'a rejected password leaves existing sessions signed in');
  assert.equal((await post(env, '/api/auth/email/reset/password', {password: 'Next!2345'}, {cookieHeader: resetCookie})).status, 200);
  assert.equal((await call(env, '/api/me', {cookieHeader: first})).status, 401);
  assert.equal((await call(env, '/api/me', {cookieHeader: second})).status, 401);
  // Force the observed occupied-slot mechanism; keep every revocation assertion.
  const again = await withSessionTokens([collisions[0], freeSessions[1]], async () => {
    const response = await post(env, '/api/auth/email/sign-in', {email, password: 'Next!2345'});
    assert.equal(response.status, 204, 'session reissue: ' + (response.status === 204 ? 'ok' : (await response.json()).error));
    return response;
  });
  assert.equal(cookie(again, '__Host-supatrace'), '__Host-supatrace=' + sessionToken(freeSessions[1]));
  assert.equal((await call(env, '/api/me', {cookieHeader: cookie(again, '__Host-supatrace')})).status, 200);
  assert.equal((await call(env, '/api/me', {cookieHeader: first})).status, 401);
});

test('a repeat sign-up for an existing account does not spend another hourly slot', async () => {
  const {env, mailbox} = dashboardEnv({rateSlots: 100000});
  assert.equal((await post(env, '/api/auth/email/sign-up', {email, password})).status, 200);
  await confirmEmail(env, mailbox[0].text);
  for (let i = 0; i < 4; i++) {
    env.sourceIp = `198.51.100.${i + 1}`;
    assert.deepEqual(await errorOf(await post(env, '/api/auth/email/sign-up', {email, password})), {status: 409, error: 'email_already_registered'});
  }
  for (let i = 0; i < 7; i++) {
    env.sourceIp = `203.0.113.${i + 1}`;
    assert.equal((await post(env, '/api/auth/email/sign-up', {email: `more${i}@example.com`, password})).status, 200);
  }
  env.sourceIp = '203.0.113.20';
  assert.deepEqual(await errorOf(await post(env, '/api/auth/email/sign-up', {email: 'ninth@example.com', password})), {status: 429, error: 'rate_limit'});
});

test('totp secrets are base32 and a challenge burns after five misses', async () => {
  assert.equal(encodeBase32(Buffer.from('12345678901234567890')), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59 * 1000), '287082');
  const {env, mailbox, store} = dashboardEnv();
  await post(env, '/api/auth/email/sign-up', {email, password});
  await confirmEmail(env, mailbox[0].text);
  const session = cookie(await post(env, '/api/auth/email/sign-in', {email, password}), '__Host-supatrace');
  const enrolled = await post(env, '/api/auth/mfa/enroll', {}, {cookieHeader: session});
  const {secret, otpauth} = await enrolled.json();
  assert.match(secret, /^[A-Z2-7]+$/);
  assert.match(otpauth, new RegExp('secret=' + secret));
  const confirmed = await post(env, '/api/auth/mfa/confirm', {code: totp(secret)}, {cookieHeader: session});
  const {recovery_codes} = await confirmed.json();
  assert.equal(recovery_codes.length, 8);
  const account = await store.getEmailAccount(email);
  const first = await post(env, '/api/auth/email/sign-in', {email, password});
  const mfaCookie = cookie(first, '__Host-supatrace-mfa');
  for (let i = 0; i < 4; i++) assert.deepEqual(await errorOf(await post(env, '/api/auth/mfa', {code: '000000'}, {cookieHeader: mfaCookie})), {status: 401, error: 'invalid_code'});
  const locked = await post(env, '/api/auth/mfa', {code: '000000'}, {cookieHeader: mfaCookie});
  assert.equal(locked.status, 429);
  assert.equal((await locked.json()).error, 'mfa_locked');
  assert.ok(Number(locked.headers.get('retry-after')) > 240 && Number(locked.headers.get('retry-after')) <= 300);
  assert.deepEqual(await errorOf(await post(env, '/api/auth/mfa', {code: totp(secret)}, {cookieHeader: mfaCookie})), {status: 401, error: 'sign_in_required'});
  assert.deepEqual(await errorOf(await post(env, '/api/auth/email/sign-in', {email, password})), {status: 429, error: 'mfa_locked'});
  const past = Math.floor(Date.now() / 1000) - 5;
  await store.setTenantFields(account.tenant_id, 'SET mfa_locked_until = :until', {':until': past});
  const again = await post(env, '/api/auth/email/sign-in', {email, password});
  const againCookie = cookie(again, '__Host-supatrace-mfa');
  for (let i = 0; i < 4; i++) assert.deepEqual(await errorOf(await post(env, '/api/auth/mfa', {code: '000000'}, {cookieHeader: againCookie})), {status: 401, error: 'invalid_code'});
  const longer = await post(env, '/api/auth/mfa', {code: '000000'}, {cookieHeader: againCookie});
  assert.equal((await longer.json()).error, 'mfa_locked');
  assert.ok(Number(longer.headers.get('retry-after')) > 540 && Number(longer.headers.get('retry-after')) <= 600, 'the second lock lasts about ten minutes');
  await store.setTenantFields(account.tenant_id, 'SET mfa_locked_until = :until', {':until': past});
  const held = cookie(await post(env, '/api/auth/email/sign-in', {email, password}), '__Host-supatrace-mfa');
  await store.setTenantFields(account.tenant_id, 'SET mfa_locked_until = :until', {':until': Math.floor(Date.now() / 1000) + 300});
  assert.deepEqual(await errorOf(await post(env, '/api/auth/mfa', {code: totp(secret)}, {cookieHeader: held})), {status: 429, error: 'mfa_locked'});
  assert.deepEqual(await errorOf(await post(env, '/api/auth/mfa/recovery', {code: recovery_codes[0]}, {cookieHeader: held})), {status: 429, error: 'mfa_locked'});
  await store.setTenantFields(account.tenant_id, 'SET mfa_locked_until = :until', {':until': past});
  const passed = await post(env, '/api/auth/mfa/recovery', {code: recovery_codes[0]}, {cookieHeader: held});
  assert.equal(passed.status, 204, 'a recovery code works after the lock, and the locked attempts did not spend it');
  const cleared = await store.getTenant(account.tenant_id);
  assert.equal(cleared.mfa_failures, 0);
  assert.equal(cleared.mfa_locked_until, 0);
  const fresh = cookie(passed, '__Host-supatrace');
  assert.equal((await post(env, '/api/auth/mfa/enroll', {}, {cookieHeader: fresh})).status, 200, 'a recent sign-in can set it up again');
  // The older-session fixture uses a fixed slot. Retire completed random
  // sessions first so slot contention cannot replace its MFA freshness checks.
  for(const prior of [session,fresh])await store.deleteSession(digest(prior.split('=')[1]));
  const row = await store.getEmailAccount(email);
  const oldToken = 'o'.repeat(43);
  await store.createSession(digest(oldToken), row.tenant_id, Math.floor(Date.now() / 1000) + 86400 - 700);
  const oldCookie = `__Host-supatrace=${oldToken}`;
  assert.deepEqual(await errorOf(await post(env, '/api/auth/mfa/disable', {}, {cookieHeader: oldCookie})), {status: 401, error: 'mfa_required'});
  assert.equal((await post(env, '/api/auth/mfa/disable', {code: totp(secret)}, {cookieHeader: oldCookie})).status, 200);
  // This session is no longer used by the MFA scenario. Retire it before
  // checking password-only sign-in, so random bounded-slot contention does not
  // replace this assertion. Real collision rejection has dedicated store tests.
  await store.deleteSession(digest(oldToken));
  assert.equal((await post(env, '/api/auth/email/sign-in', {email, password})).status, 204);
});

async function beginSso(env) {
  const start = await call(env, '/api/auth/sso?email=gavin@hooli.com');
  const url = new URL((await start.json()).url);
  const relay = url.searchParams.get('RelayState');
  const requestXml = inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest'), 'base64')).toString();
  const requestId = requestXml.match(/\bID="([^"]+)"/)[1];
  const issued = start.headers.getSetCookie().find(value => value.startsWith('supatrace-sso='));
  assert.match(issued, /Path=\/api\/auth\/sso\/callback/);
  assert.match(issued, /HttpOnly/);
  assert.match(issued, /Secure/);
  assert.match(issued, /SameSite=None/);
  assert.match(issued, /Max-Age=600/);
  assert.equal(issued.includes('__Host-'), false);
  return {relay, requestId, browser: cookie(start, 'supatrace-sso')};
}

test('sso verifies an Okta-signed assertion and rejects the surrounding forgeries', async () => {
  const {env, keys} = dashboardEnv();
  assert.deepEqual(await errorOf(await call(env, '/api/auth/sso?email=ada@other.com')), {status: 404, error: 'sso_domain_unknown'});
  const probe = await beginSso(env);
  assert.notEqual(probe.requestId, probe.relay);
  assert.notEqual(probe.requestId, '_' + probe.relay);
  const soon = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const past = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  const other = idpMaterial();
  async function forged(overrides, relay = null, browser = null) {
    const flow = relay ? null : await beginSso(env);
    const xml = oktaResponse({privateKey: keys.privateKey, cert: keys.cert, requestId: flow?.requestId || probe.requestId, nameId: 'gavin@hooli.com', notBefore: now, notOnOrAfter: soon, ...overrides});
    return errorOf(await postSaml(env, xml, relay || flow.relay, browser || flow.browser));
  }
  assert.deepEqual(await forged({privateKey: other.privateKey, cert: other.cert}), {status: 401, error: 'identity_not_verified'});
  assert.deepEqual(await forged({notBefore: past, notOnOrAfter: past}), {status: 401, error: 'identity_not_verified'});
  assert.deepEqual(await forged({audienceValue: 'https://elsewhere.example'}), {status: 401, error: 'identity_not_verified'});
  assert.deepEqual(await forged({requestId: '_not-the-request'}), {status: 401, error: 'identity_not_verified'});
  const held = await beginSso(env);
  const good = oktaResponse({privateKey: keys.privateKey, cert: keys.cert, requestId: held.requestId, nameId: 'gavin@hooli.com', notBefore: now, notOnOrAfter: soon});
  assert.deepEqual(await errorOf(await postSaml(env, good, 'x'.repeat(43), held.browser)), {status: 400, error: 'invalid_oauth_state'});
  const ok = await postSaml(env, good, held.relay, held.browser);
  assert.equal(ok.status, 302, 'a mismatched RelayState does not burn the request, and the signed assertion is accepted');
  const me = await call(env, '/api/me', {cookieHeader: cookie(ok, '__Host-supatrace')});
  assert.match((await me.json()).tenant_id, /^sso-[a-f0-9]{64}$/);
  assert.deepEqual(await errorOf(await postSaml(env, good, held.relay, held.browser)), {status: 401, error: 'identity_not_verified'});
});

// Inject IDs only into the test's SDK instance; production keeps node-saml's
// cryptographic generator. Fixtures prove real hash collisions, not mocked errors.
function controlledSamlIds(t, ids) {
  const original = SAML.prototype.generateAuthorizeRequestAsync;
  const used = [];
  t.mock.method(SAML.prototype, 'generateAuthorizeRequestAsync', async function(...args) {
    const id = ids.shift(); assert.ok(id, 'unexpected SAML start attempt'); used.push(id);
    this.options.generateUniqueId = () => id;
    return original.apply(this, args);
  });
  return used;
}
function signedFor(keys, flow, nameId='gavin@hooli.com') {
  return oktaResponse({privateKey:keys.privateKey, cert:keys.cert, requestId:flow.requestId, nameId, notBefore:new Date(Date.now()-1000).toISOString(), notOnOrAfter:new Date(Date.now()+300000).toISOString()});
}
test('SAML colliding start retries a fresh ID without evicting a held signed login or accepting replay', async t => {
  const heldId='_synthetic-held-request', collisionId='_synthetic-forgery-293', freeId='_synthetic-forgery-0';
  const slot=id=>Number(BigInt('0x'+digest(id))%1000n);
  assert.equal(slot(heldId),slot(collisionId)); assert.notEqual(slot(heldId),slot(freeId));
  const used=controlledSamlIds(t,[heldId,collisionId,freeId]);
  const {env,store,keys}=dashboardEnv();
  const held=await beginSso(env), old=await store.readSamlCache(held.requestId);
  const next=await beginSso(env);
  assert.deepEqual(used,[heldId,collisionId,freeId]); assert.equal(next.requestId,freeId);
  assert.equal(await store.readSamlCache(heldId),old); assert.equal(await store.readSamlCache(collisionId),null);
  const rejected=await postSaml(env,signedFor(keys,{requestId:collisionId},'ada@hooli.com'),next.relay,next.browser);
  assert.deepEqual(await errorOf(rejected),{status:401,error:'identity_not_verified'});
  assert.equal(rejected.headers.getSetCookie().length,0);
  assert.equal(await store.readSamlCache(heldId),old,'an unreserved colliding ID cannot consume the held login');
  assert.equal(await accounts(store),0,'a rejected collision cannot provision an identity');
  const good=signedFor(keys,held);
  assert.deepEqual(await errorOf(await postSaml(env,good,'x'.repeat(43),held.browser)),{status:400,error:'invalid_oauth_state'});
  const heldLogin=await postSaml(env,good,held.relay,held.browser);
  assert.equal(heldLogin.status,302);
  assert.deepEqual(await errorOf(await postSaml(env,good,held.relay,held.browser)),{status:401,error:'identity_not_verified'});
  const nextLogin=await postSaml(env,signedFor(keys,next,'ada@hooli.com'),next.relay,next.browser);
  assert.equal(nextLogin.status,302);
  const heldMe=await (await call(env,'/api/me',{cookieHeader:cookie(heldLogin,'__Host-supatrace')})).json();
  const nextMe=await (await call(env,'/api/me',{cookieHeader:cookie(nextLogin,'__Host-supatrace')})).json();
  assert.equal(heldMe.tenant_id,'sso-'+digest('gavin@hooli.com'));
  assert.equal(nextMe.tenant_id,'sso-'+digest('ada@hooli.com'));
  assert.notEqual(heldMe.project_id,nextMe.project_id,'distinct signed identities retain distinct projects');
  assert.deepEqual(await errorOf(await call(env,'/api/runs?project='+nextMe.project_id,{cookieHeader:cookie(heldLogin,'__Host-supatrace')})),{status:403,error:'project_unavailable'});
});
test('SAML exhausted collision retries return a retryable error with no login URL or cookie and preserve the holder', async t => {
  const heldId='_synthetic-held-request', collisionId='_synthetic-forgery-293';
  const used=controlledSamlIds(t,[heldId,collisionId,collisionId,collisionId]);
  const {env,store,keys}=dashboardEnv(); const held=await beginSso(env);
  const response=await call(env,'/api/auth/sso?email=gavin@hooli.com');
  assert.equal(response.headers.getSetCookie().length,0);
  assert.deepEqual(await errorOf(response),{status:503,error:'sso_request_busy'});
  assert.equal(used.length,4); assert.ok(await store.readSamlCache(heldId));
  assert.equal((await postSaml(env,signedFor(keys,held),held.relay,held.browser)).status,302);
});
test('SAML ambiguous reservation failure is not retried and returns no redirect or cookie', async t => {
  const {env,store}=dashboardEnv(); let saves=0;
  t.mock.method(store,'saveSamlCache',async()=>{saves++; throw Error('synthetic network failure after possible write');});
  const response=await call(env,'/api/auth/sso?email=gavin@hooli.com');
  assert.equal(response.headers.getSetCookie().length,0);
  assert.deepEqual(await errorOf(response),{status:503,error:'temporarily_unavailable'}); assert.equal(saves,1);
});

test('chatgpt accepts a subject that contains a bar and stays off without endpoints', async () => {
  const {env} = dashboardEnv();
  delete env.CHATGPT_USERINFO_URL;
  assert.deepEqual(await errorOf(await call(env, '/api/auth/chatgpt')), {status: 404, error: 'chatgpt_sign_in_unavailable'});
  env.CHATGPT_USERINFO_URL = 'http://127.0.0.1:9/userinfo';
  const start = await call(env, '/api/auth/chatgpt');
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  env.fetcher = async (url) => {
    if (String(url).endsWith('/token')) return Response.json({access_token: 'chatgpt-access-token'});
    return Response.json({sub: 'org|user|1'});
  };
  const back = await call(env, `/api/auth/chatgpt/callback?code=one-time&state=${state}`, {cookieHeader: cookie(start, '__Host-supatrace-oauth')});
  assert.equal(back.status, 302);
  const me = await (await call(env, '/api/me', {cookieHeader: cookie(back, '__Host-supatrace')})).json();
  assert.match(me.tenant_id, /^chatgpt-[a-f0-9]{64}$/);
  const again = await call(env, '/api/auth/chatgpt');
  const state2 = new URL(again.headers.get('location')).searchParams.get('state');
  env.fetcher = async url => String(url).endsWith('/token') ? Response.json({access_token: 'chatgpt-access-token'}) : Response.json({sub: 'has space'});
  assert.deepEqual(await errorOf(await call(env, `/api/auth/chatgpt/callback?code=one-time&state=${state2}`, {cookieHeader: cookie(again, '__Host-supatrace-oauth')})), {status: 401, error: 'identity_not_verified'});
});
// Two-factor discoverability belongs with the dashboard sign-in tests; loaded here so the root `npm test` list does not change.
import './mfa-status.test.mjs';

test('confirmation cannot issue a session across a concurrent password reset',async()=>{
 const {env,store,mailbox}=dashboardEnv();await post(env,'/api/auth/email/sign-up',{email,password});
 const create=store.createVerifiedEmailAccount.bind(store);
 store.createVerifiedEmailAccount=async(...args)=>{const account=await create(...args);await store.resetEmailPassword(email,account.tenant_id,'synthetic-replaced-password-hash');return account;};
 const response=await post(env,'/api/auth/email/verify',{email,password,token:tokenFrom(mailbox[0].text)});
 assert.equal(response.status,409);assert.equal((await response.json()).error,'session_changed');assert.equal(response.headers.getSetCookie().some(v=>v.startsWith('__Host-supatrace=')),false);
});
