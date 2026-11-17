import test from 'node:test';
import assert from 'node:assert/strict';
import {handle} from '../src/aws-api.mjs';
import {digest} from '../src/aws-auth.mjs';
import {hashPassword, checkPassword, totp} from '../src/dashboard-auth.mjs';
import {DynamoMetadataStore} from '../src/dynamodb-store.mjs';
import {MemoryDynamo, commandClasses} from './memory-dynamo.mjs';

const address = 'ada@example.com', password = 'Synthetic!123';
const sendPath = '/api/auth/email/link', confirmPath = sendPath + '/confirm';
const tenantId = email => 'email-' + digest(email);
const sent = {ok: true, message: 'Check your email'};
function world(options = {}) {
  let shift = 0;
  const client = new MemoryDynamo(), calls = [], mailbox = [], diagnostics = [];
  const store = new DynamoMetadataStore({client, commands: commandClasses(), tableName: 'metadata', now: () => Math.floor(Date.now() / 1000) + shift, ...options});
  const send = client.send.bind(client);
  client.send = command => { calls.push(command.name); return send(command); };
  // Each identity uses the real fixed-window counter without unrelated hash-slot
  // collisions; bounded-table collision behavior has its own store tests.
  const rates = new Map(); let rateTime = 1792880000;
  store.consumeRate = input => {
    const key = JSON.stringify([input.scope, input.identity]);
    if (!rates.has(key)) rates.set(key, new DynamoMetadataStore({client: new MemoryDynamo(), commands: commandClasses(), tableName: 'rates', now: () => rateTime}));
    return rates.get(key).consumeRate(input);
  };
  const env = {ENABLED: true, GITHUB_CLIENT_ID: 'synthetic-client', GITHUB_CLIENT_SECRET: 'synthetic-secret', APP_ORIGIN: 'https://supatrace.dev', EMAIL_FROM: 'member@example.com', sourceIp: '203.0.113.40', store, objects: {}, MFA_ENABLED: true,
    sendEmail: async message => { mailbox.push(message); }, apiDiagnostic: event => diagnostics.push(event), authDiagnostic: event => diagnostics.push(event)};
  return {env, store, client, calls, mailbox, diagnostics, advance: n => { shift += n; }, advanceRates: n => { rateTime += n; }};
}
function call(w, path, {method = 'GET', body, headers = {}} = {}) {
  return handle(new Request(w.env.APP_ORIGIN + path, {method, headers, ...(body !== undefined ? {body} : {})}), w.env);
}
const post = (w, path, body, headers = {}) => call(w, path, {method: 'POST', body: JSON.stringify(body), headers: {origin: w.env.APP_ORIGIN, 'content-type': 'application/json', ...headers}});
const rawToken = mail => new URL(mail.text.match(/https:\/\/\S+/)[0]).searchParams.get('token');
async function issue(w, email = address) {
  const response = await post(w, sendPath, {email});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), sent);
  return rawToken(w.mailbox.at(-1));
}
const confirm = (w, token, extra = {}) => post(w, confirmPath, {token, ...extra});
const rows = w => [...w.client.items.values()];
const accountCount = async w => (await w.store._get({pk: 'SYS', sk: 'CAPACITY'}))?.accounts || 0;
const sessions = w => rows(w).filter(row => row.pk.startsWith('SESSION#'));
function sessionCookie(response) { return response.headers.getSetCookie().find(value => value.startsWith('__Host-supatrace='))?.split(';')[0]; }
async function invalid(response, status = 400, error = 'invalid_code') {
  assert.equal(response.status, status); assert.deepEqual(await response.json(), {error});
  assert.equal(sessionCookie(response), undefined);
}

test('email links store only a hash, normalize addresses, and send the same single-use copy', async () => {
  const w = world(), token = await issue(w, ' ADA@Example.COM ');
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const row = await w.store.peekAuthChallenge('LINK', digest(token));
  assert.equal(row.pk, 'LINK#' + digest(token)); assert.equal(row.email, address); assert.equal(row.id_hash, digest(token));
  assert.equal(row.expires_at - w.store.now(), 900); assert.equal(row.ttl, row.expires_at);
  assert.equal(JSON.stringify(rows(w)).includes(token), false);
  assert.equal(w.mailbox[0].to, address); assert.equal(w.mailbox[0].subject, 'Your SupaTrace sign-in link');
  assert.match(w.mailbox[0].text, /works once and expires in 15 minutes/);
  assert.match(w.mailbox[0].text, /If you did not ask for this, ignore this email/);
  assert.equal(await accountCount(w), 0);
});

test('scanner GET peeks without consuming and redirects only valid links to the app with safe headers', async () => {
  const w = world(), token = await issue(w);
  const open = () => call(w, sendPath + '?token=' + token);
  const response = await open();
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), w.env.APP_ORIGIN + '/app/?link=' + token);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(response.headers.getSetCookie(), []);
  assert.ok(await w.store.peekAuthChallenge('LINK', digest(token)));
  assert.equal(await accountCount(w), 0);
  assert.equal((await confirm(w, token)).status, 200);
  assert.equal((await open()).headers.get('location'), w.env.APP_ORIGIN + '/app/?auth_error=link_invalid');
});

test('unknown, expired, used, missing and malformed links have identical clean redirects', async () => {
  const w = world(), expired = await issue(w);
  w.advance(900); w.advanceRates(60);
  const used = await issue(w); assert.equal((await confirm(w, used)).status, 200);
  const outcomes = [];
  for (const token of [expired, used, 'Z'.repeat(43), '', 'short', '/'.repeat(43), 'a'.repeat(44), 'a'.repeat(43) + '\n', null]) {
    const response = await call(w, sendPath + (token === null ? '' : '?token=' + encodeURIComponent(token)));
    outcomes.push({status: response.status, headers: [...response.headers], body: await response.text()});
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), w.env.APP_ORIGIN + '/app/?auth_error=link_invalid');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  for (const outcome of outcomes) assert.deepEqual(outcome, outcomes[0]);
});

test('duplicate normalized requests suppress mail with identical responses for new and existing accounts', async () => {
  const outcomes = [];
  for (const existing of [false, true]) {
    const w = world(); if (existing) await w.store.createVerifiedEmailAccount(address, hashPassword(password));
    const first = await post(w, sendPath, {email: address});
    const token = rawToken(w.mailbox[0]);
    w.advanceRates(1);
    const repeated = await Promise.all(Array.from({length: 3}, () => post(w, sendPath, {email: ' ADA@Example.COM '})));
    for (const response of [first, ...repeated]) {
      assert.equal(response.status, 200); assert.deepEqual(await response.json(), sent);
    }
    assert.equal(w.mailbox.length, 1);
    assert.ok(await w.store.peekAuthChallenge('LINK', digest(token)));
    await issue(w, 'other@example.com'); assert.equal(w.mailbox.length, 2);
    // Advance the rate store clock into the next minute; older links remain valid.
    w.advanceRates(60);
    const newer = await issue(w); assert.equal(w.mailbox.length, 3); assert.notEqual(newer, token);
    assert.equal((await confirm(w, token)).status, 200);
    assert.equal((await confirm(w, newer)).status, 200);
    outcomes.push(w.mailbox.length);
  }
  assert.deepEqual(outcomes, [3, 3]);
});

test('a successful duplicate keeps the original challenge expiry instead of extending it', async () => {
  const w = world(), token = await issue(w);
  const before = await w.store.peekAuthChallenge('LINK', digest(token));
  w.advance(30); w.advanceRates(30);
  const duplicate = await post(w, sendPath, {email: address});
  assert.equal(duplicate.status, 200); assert.deepEqual(await duplicate.json(), sent);
  const after = await w.store.peekAuthChallenge('LINK', digest(token));
  assert.equal(after.expires_at, before.expires_at);
  assert.equal(w.mailbox.length, 1);
  assert.equal((await confirm(w, token)).status, 200);
});

test('resend cooldown spans calendar-minute boundaries with the production limiter', async () => {
  let now = 1800000059;
  const w = world({now: () => now});
  w.store.consumeRate = DynamoMetadataStore.prototype.consumeRate.bind(w.store);
  const older = await issue(w);
  now++;
  for (const elapsed of [0, 58]) {
    now += elapsed;
    const duplicate = await post(w, sendPath, {email: address});
    assert.equal(duplicate.status, 200); assert.deepEqual(await duplicate.json(), sent);
    assert.equal(w.mailbox.length, 1);
    assert.ok(await w.store.peekAuthChallenge('LINK', digest(older)), 'dedupe success retains the delivered challenge');
  }
  now++;
  const newer = await issue(w); assert.equal(w.mailbox.length, 2);
  assert.ok(await w.store.peekAuthChallenge('LINK', digest(older)));
  assert.ok(await w.store.peekAuthChallenge('LINK', digest(newer)));
});

for (const failure of ['transport', 'budget']) test(`failed ${failure} reservation permits a truthful immediate retry with the production limiter`, async () => {
  const w = world({now: () => 1800000000});
  const consume = DynamoMetadataStore.prototype.consumeRate.bind(w.store);
  let failBudget = failure === 'budget';
  w.store.consumeRate = input => {
    if (input.scope === 'linknet' && failBudget) { failBudget = false; return {allowed: false, retry_after: 60}; }
    return consume(input);
  };
  if (failure === 'transport') w.env.sendEmail = async () => { throw Error('synthetic transport failure'); };
  await invalid(await post(w, sendPath, {email: address}), failure === 'transport' ? 503 : 429, failure === 'transport' ? 'email_unavailable' : 'rate_limit');
  assert.equal(w.mailbox.length, 0);
  w.env.sendEmail = async mail => { w.mailbox.push(mail); };
  const token = await issue(w); assert.equal(w.mailbox.length, 1);
  assert.ok(await w.store.peekAuthChallenge('LINK', digest(token)));
});

test('a cooldown hash-slot collision returns a truthful rate limit instead of a delivery claim', async () => {
  const w = world({now: () => 1800000000});
  w.store.consumeRate = DynamoMetadataStore.prototype.consumeRate.bind(w.store);
  const slots = new Map(); let pair;
  for (let i = 0; !pair; i++) {
    const email = `collision${i}@example.com`;
    const bucket = digest(JSON.stringify(['linkresend', digest(email), 60, 'cooldown']));
    const slot = Number(BigInt('0x' + bucket) % BigInt(w.store.limits.rateSlots));
    if (slots.has(slot)) pair = [slots.get(slot), email];
    else slots.set(slot, email);
  }
  await issue(w, pair[0]);
  const response = await post(w, sendPath, {email: pair[1]});
  await invalid(response, 429, 'rate_limit');
  assert.equal(response.headers.get('retry-after'), '60');
  assert.equal(w.mailbox.length, 1);
  assert.equal(w.mailbox[0].to, pair[0]);
});

for (const fails of [false, true]) test(`concurrent duplicate waits for accepted mail when the original ${fails ? 'fails' : 'succeeds'}`, async () => {
  const w = world({now: () => 1800000000});
  const consume = DynamoMetadataStore.prototype.consumeRate.bind(w.store);
  let observePending, enter, finish;
  const pending = new Promise(resolve => { observePending = resolve; });
  const entered = new Promise(resolve => { enter = resolve; });
  const completed = new Promise(resolve => { finish = resolve; });
  w.store.consumeRate = async input => {
    const rate = await consume(input);
    if (rate.pending) observePending();
    return rate;
  };
  let sends = 0;
  w.env.sendEmail = async mail => {
    if (++sends === 1) { enter(); await completed; if (fails) throw Error('synthetic transport failure'); }
    w.mailbox.push(mail);
  };
  const first = post(w, sendPath, {email: address});
  await entered;
  let duplicateReturned = false;
  const second = post(w, sendPath, {email: address}).then(response => { duplicateReturned = true; return response; });
  await Promise.race([pending, second]);
  try { assert.equal(duplicateReturned, false); } finally { finish(); }
  const original = await first, duplicate = await second;
  if (fails) await invalid(original, 503, 'email_unavailable');
  else { assert.equal(original.status, 200); assert.deepEqual(await original.json(), sent); }
  assert.equal(duplicate.status, 200); assert.deepEqual(await duplicate.json(), sent);
  assert.equal(w.mailbox.length, 1);
  assert.ok(await w.store.peekAuthChallenge('LINK', digest(rawToken(w.mailbox[0]))));
});

test('confirmation creates a verified passwordless account, signs it in, and cannot be reused', async () => {
  const w = world(), token = await issue(w), response = await confirm(w, token);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), {ok: true, new_account: true});
  const cookie = sessionCookie(response); assert.ok(cookie);
  const session = await w.store.getSession(digest(cookie.split('=')[1])); assert.equal(session.tenant_id, tenantId(address));
  const account = await w.store.getEmailAccount(address); assert.equal(account.verified, true); assert.equal('password_hash' in account, false);
  assert.equal(await accountCount(w), 1); await invalid(await confirm(w, token)); assert.equal(await accountCount(w), 1);
});

test('links expire at exactly 15 minutes, not a second sooner', async () => {
  for (const seconds of [899, 900, 901]) {
    const w = world(), token = await issue(w); w.advance(seconds);
    const response = await confirm(w, token);
    if (seconds < 900) assert.equal(response.status, 200);
    else { await invalid(response); assert.equal(await accountCount(w), 0); assert.equal(sessions(w).length, 0); }
  }
});

test('malformed tokens fail on both routes without any session or account', async () => {
  for (const value of ['', 'short', 'a'.repeat(44), 'a'.repeat(42), '/'.repeat(43), 'a'.repeat(43) + '\n', null, 123, ['a'.repeat(43)]]) {
    const w = world(); await invalid(await confirm(w, value));
    if (!Array.isArray(value)) assert.equal((await call(w, sendPath + '?token=' + encodeURIComponent(value ?? ''))).headers.get('location'), w.env.APP_ORIGIN + '/app/?auth_error=link_invalid');
    assert.equal(await accountCount(w), 0); assert.equal(sessions(w).length, 0);
  }
});

test('existing and unknown email requests have identical responses and equal store and mail work', async () => {
  const outcomes = [];
  for (const existing of [false, true]) {
    const w = world(); if (existing) await w.store.createVerifiedEmailAccount(address, hashPassword(password));
    w.calls.length = 0;
    const response = await post(w, sendPath, {email: address});
    outcomes.push({status: response.status, body: await response.json(), calls: w.calls.slice(), mail: w.mailbox.length, copy: w.mailbox[0].text.replace(/token=\S+/, 'token=REDACTED')});
  }
  assert.deepEqual(outcomes[0], outcomes[1]); assert.deepEqual(outcomes[0].body, sent); assert.equal(outcomes[0].status, 200);
});

test('password and email link sign-in share one tenant; unrelated GitHub tenant stays untouched', async () => {
  const w = world(); await w.store.createVerifiedEmailAccount(address, hashPassword(password));
  const github = await w.store.getOrCreateTenant(42), before = structuredClone(github);
  const passwordResponse = await post(w, '/api/auth/email/sign-in', {email: address, password}); assert.equal(passwordResponse.status, 204);
  const response = await confirm(w, await issue(w)); assert.deepEqual(await response.json(), {ok: true, new_account: false});
  for (const res of [passwordResponse, response]) assert.equal((await w.store.getSession(digest(sessionCookie(res).split('=')[1]))).tenant_id, tenantId(address));
  assert.equal(await accountCount(w), 2); assert.deepEqual(await w.store.getTenant(github.tenant_id), before);
});

for (const kind of ['email', 'ip', 'network', 'domain', 'global']) test('email link ' + kind + ' rate limit returns Retry-After and sends nothing extra', async () => {
  const w = world(), cap = {email: 5, ip: 5, network: 20, domain: 30, global: 200}[kind];
  for (let i = 0; i <= cap; i++) {
    w.env.sourceIp = kind === 'ip' || kind === 'network' ? '2001:db8:1:2::' + (i + 1) : `203.0.${Math.floor(i / 250)}.${i % 250 + 1}`;
    const email = kind === 'email' ? address : kind === 'domain' ? `u${i}@shared.test` : `u${i}@d${i}.test`;
    // Hourly network cap must be independent of its 5-minute cap.
    if (kind === 'network' && i > 0 && i % 5 === 0) w.advanceRates(300);
    if (kind === 'email') {
      if (i < cap) await w.store.consumeRate({scope: 'link', identity: 'email:' + digest(email), limit: 5, windowSeconds: 300});
      else {
        const response = await post(w, sendPath, {email});
        assert.equal(response.status, 429); assert.equal(w.mailbox.length, 0); return;
      }
      continue;
    }
    const response = await post(w, sendPath, {email});
    if (i < cap) assert.equal(response.status, 200, String(i));
    else {
      assert.equal(response.status, 429); assert.deepEqual(await response.json(), {error: 'rate_limit'});
      assert.ok(Number(response.headers.get('retry-after')) > 0); assert.equal(w.mailbox.length, cap);
    }
  }
});

test('confirm has its own IP budget and Retry-After', async () => {
  const w = world();
  for (let i = 0; i < 10; i++) await invalid(await confirm(w, 'Z'.repeat(43)));
  const response = await confirm(w, 'Z'.repeat(43)); await invalid(response, 429, 'rate_limit'); assert.ok(Number(response.headers.get('retry-after')) > 0);
});

test('send failure returns email_unavailable, burns the challenge, and never logs its token', async () => {
  const w = world();
  w.env.sendEmail = async message => { w.mailbox.push(message); throw new Error('synthetic transport failure'); };
  await invalid(await post(w, sendPath, {email: address}), 503, 'email_unavailable');
  const token = rawToken(w.mailbox[0]); assert.equal(await w.store.peekAuthChallenge('LINK', digest(token)), null);
  await invalid(await confirm(w, token)); assert.equal(sessions(w).length, 0); assert.equal(await accountCount(w), 0);
  assert.equal(JSON.stringify(w.diagnostics).includes(token), false);
});

test('MFA enrolled accounts get a pending challenge and no full session until the second factor', async () => {
  const w = world(), secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  await w.store.createVerifiedEmailAccount(address, hashPassword(password));
  await w.store.setTenantFields(tenantId(address), 'SET mfa_secret = :secret', {':secret': secret});
  const response = await confirm(w, await issue(w)); assert.equal(response.status, 200); assert.deepEqual(await response.json(), {mfa_required: true});
  assert.equal(sessionCookie(response), undefined); assert.equal(sessions(w).length, 0);
  const pending = response.headers.getSetCookie().find(value => value.startsWith('__Host-supatrace-mfa=')).split(';')[0];
  const verified = await post(w, '/api/auth/mfa', {code: totp(secret)}, {cookie: pending}); assert.equal(verified.status, 204); assert.ok(sessionCookie(verified));
});

test('concurrent confirms of one token consume it once', async () => {
  const w = world(), token = await issue(w);
  const responses = await Promise.all([confirm(w, token), confirm(w, token)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 400]); assert.equal(await accountCount(w), 1); assert.equal(sessions(w).length, 1);
});

test('concurrent distinct links create exactly one email account and both resolve to its tenant', async () => {
  const w = world(), older = await issue(w); w.advanceRates(60);
  const tokens = [older, await issue(w)];
  const responses = await Promise.all(tokens.map(token => confirm(w, token)));
  assert.deepEqual(responses.map(r => r.status), [200, 200]);
  const values = await Promise.all(responses.map(r => r.json())); assert.deepEqual(values.map(v => v.new_account).sort(), [false, true]);
  assert.equal(await accountCount(w), 1); assert.equal(rows(w).filter(r => r.sk === 'LOGIN').length, 1);
  assert.equal(sessions(w).length, 2); assert.ok(sessions(w).every(r => r.tenant_id === tenantId(address)));
});

test('passwordless account fails closed for passwords and signup; reset lets the owner set one', async () => {
  const w = world(); await confirm(w, await issue(w));
  assert.equal(checkPassword(password, undefined), false);
  for (const value of ['', password, 'supatrace-dummy-password']) await invalid(await post(w, '/api/auth/email/sign-in', {email: address, password: value}), 401, 'invalid_credentials');
  await invalid(await post(w, '/api/auth/email/sign-up', {email: address, password}), 409, 'email_already_registered');
  assert.equal((await post(w, '/api/auth/email/reset', {email: address})).status, 200);
  const code = w.mailbox.at(-1).text.match(/\b\d{6}\b/)[0];
  const proof = await post(w, '/api/auth/email/reset/confirm', {email: address, code}); assert.equal(proof.status, 200);
  const resetCookie = proof.headers.getSetCookie().find(value => value.startsWith('__Host-supatrace-reset=')).split(';')[0];
  assert.equal((await post(w, '/api/auth/email/reset/password', {password}, {cookie: resetCookie})).status, 200);
  const signedIn = await post(w, '/api/auth/email/sign-in', {email: address, password});
  assert.equal(signedIn.status, 204, await signedIn.text());
  assert.equal((await w.store.getTenant(tenantId(address))).session_epoch, 1);
  w.advanceRates(60);
  assert.deepEqual(await (await confirm(w, await issue(w))).json(), {ok: true, new_account: false});
});

test('a pending password signup cannot replace a passwordless account or its tenant', async () => {
  const w = world(); assert.equal((await post(w, '/api/auth/email/sign-up', {email: address, password})).status, 200);
  const signupToken = rawToken(w.mailbox[0]); await confirm(w, await issue(w));
  await invalid(await post(w, '/api/auth/email/verify', {email: address, password, token: signupToken}), 409, 'email_already_registered');
  assert.equal((await w.store.getEmailAccount(address)).password_hash, undefined); assert.equal(await accountCount(w), 1);
});

test('cross-origin and missing-origin POSTs fail before storing or consuming any link', async () => {
  const w = world(), token = await issue(w);
  for (const origin of ['https://attacker.example', 'null', '']) for (const [path, body] of [[sendPath, {email: address}], [confirmPath, {token}]]) await invalid(await post(w, path, body, {origin}), 403, 'origin_required');
  assert.ok(await w.store.peekAuthChallenge('LINK', digest(token))); assert.equal(w.mailbox.length, 1); assert.equal(sessions(w).length, 0);
});

test('invalid addresses and unbounded or non-JSON bodies are rejected', async () => {
  const w = world();
  for (const email of ['', 'not-an-email', 'a'.repeat(255) + '@example.com']) await invalid(await post(w, sendPath, {email}), 400, 'invalid_email');
  for (const path of [sendPath, confirmPath]) {
    await invalid(await post(w, path, {email: address, token: 'Z'.repeat(43), padding: 'x'.repeat(4096)}), 413, 'batch_too_large');
    await invalid(await post(w, path, {}, {'content-type': 'text/plain'}), 415, 'json_required');
    await invalid(await call(w, path, {method: 'POST', body: '{', headers: {origin: w.env.APP_ORIGIN, 'content-type': 'application/json'}}), 400, 'invalid_json');
  }
  assert.equal(w.mailbox.length, 0); assert.equal(sessions(w).length, 0);
});

test('link for A ignores a supplied B address and never signs in B', async () => {
  const w = world(), other = 'bob@example.com'; await w.store.createVerifiedEmailAccount(other, hashPassword(password));
  const response = await confirm(w, await issue(w), {email: other, tenant_id: tenantId(other)});
  assert.equal((await w.store.getSession(digest(sessionCookie(response).split('=')[1]))).tenant_id, tenantId(address));
  assert.equal(sessions(w).some(r => r.tenant_id === tenantId(other)), false);
});

test('DynamoMetadataStore supports isolated SIGNUP RESET MFA LINK kinds and conditional passwordless creation', async () => {
  const store = new DynamoMetadataStore({client: new MemoryDynamo(), commands: commandClasses(), tableName: 'metadata'}), id = digest('synthetic-challenge-id');
  for (const kind of ['SIGNUP', 'RESET', 'MFA', 'LINK']) await store.createAuthChallenge(kind, id, {email: address, marker: kind}, 900);
  for (const kind of ['LINK', 'MFA', 'RESET', 'SIGNUP']) {
    assert.equal((await store.peekAuthChallenge(kind, id)).marker, kind);
    assert.equal((await store.consumeAuthChallenge(kind, id)).marker, kind);
    assert.equal(await store.consumeAuthChallenge(kind, id), null);
  }
  const results = await Promise.all([store.createPasswordlessEmailAccount(address), store.createPasswordlessEmailAccount(address)]);
  assert.deepEqual(results.map(row => row.new_account).sort(), [false, true]); assert.ok(results.every(row => row.password_hash === undefined));
});

for (const kind of ['MFA', 'RESET', 'SIGNUP']) test(kind + ' challenges cannot confirm a LINK', async () => {
  const w = world(), token = 'Z'.repeat(43); await w.store.createAuthChallenge(kind, digest(token), {email: address}, 900);
  await invalid(await confirm(w, token)); assert.ok(await w.store.peekAuthChallenge(kind, digest(token))); assert.equal(sessions(w).length, 0);
});

test('disabled email provider rejects send, open and confirm', async () => {
  const w = world(); delete w.env.EMAIL_FROM;
  assert.equal((await (await call(w, '/api/auth/providers')).json()).email, false);
  for (const response of [await post(w, sendPath, {email: address}), await call(w, sendPath + '?token=' + 'Z'.repeat(43)), await confirm(w, 'Z'.repeat(43))]) await invalid(response, 404, 'email_sign_in_unavailable');
  assert.equal(w.mailbox.length, 0); assert.equal(await accountCount(w), 0);
});

test('alpha cap refuses a new account with no session; an existing email account still signs in', async () => {
  const w = world({accounts: 1}); await w.store.createVerifiedEmailAccount(address, hashPassword(password));
  await invalid(await confirm(w, await issue(w, 'bob@example.com')), 429, 'account_capacity'); assert.equal(sessions(w).length, 0);
  assert.equal((await confirm(w, await issue(w))).status, 200); assert.equal(await accountCount(w), 1);
});

test('mismatched tenant rows fail closed and cannot redirect A into B', async () => {
  const w = world(); await w.store.createVerifiedEmailAccount(address, hashPassword(password));
  await w.store.updateEmailAccount(address, 'SET tenant_id = :tenant', {':tenant': 'github-42'});
  await invalid(await confirm(w, await issue(w)), 401, 'invalid_credentials'); assert.equal(sessions(w).length, 0);
});

test('a reset between reading the account and session issuance rejects the stale epoch', async () => {
  const w = world(); await w.store.createVerifiedEmailAccount(address, hashPassword(password));
  const read = w.store.getEmailAccount.bind(w.store);
  w.store.getEmailAccount = async email => { const account = await read(email); await w.store.resetEmailPassword(email, tenantId(email), hashPassword(password)); return account; };
  await invalid(await confirm(w, await issue(w)), 409, 'session_changed'); assert.equal(sessions(w).length, 0);
});

test('tokens never appear in JSON responses or diagnostics on success and store failures', async () => {
  const w = world(), token = await issue(w), response = await confirm(w, token);
  assert.equal((await response.text()).includes(token), false); assert.equal(JSON.stringify(w.diagnostics).includes(token), false);
  const failed = world(), badToken = await issue(failed);
  failed.store.getEmailAccount = async () => { throw new Error('synthetic store failure'); };
  const unavailable = await confirm(failed, badToken); assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.text()).includes(badToken), false); assert.equal(JSON.stringify(failed.diagnostics).includes(badToken), false);
});

// Exercise the committed sign-in module with a small DOM; browser tests cover native focus and layout.
for (const outcome of ['success', '429', 'network']) test(`different-address recovery ignores a stale ${outcome} resend while a new send is pending`, async t => {
  let focused;
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.hidden = false; this.disabled = false; this.value = ''; this.classList = {add() {}}; this.text = ''; }
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
    get childNodes() { return this.children; }
    setAttribute(key, value) { this.attrs[key] = value; if (key === 'hidden') this.hidden = true; }
    getAttribute(key) { return this.attrs[key]; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    find(predicate) { if (predicate(this)) return this; for (const child of this.children) { const found = child.find(predicate); if (found) return found; } }
    querySelector(selector) { return this.find(node => selector.startsWith('#') ? node.attrs.id === selector.slice(1) : (node.attrs.class || '').split(' ').includes(selector.slice(1))); }
    focus() { focused = this; }
    scrollIntoView() {}
  }
  const root = new Element('div'), slot = 'supatrace-sent-link', storage = new Map([[slot, JSON.stringify({sentEmail: address, resendAt: 0, expiresAt: Date.now() + 900000})]]), requests = [];
  const globals = {Node: Element, document: {createElement: tag => new Element(tag), createTextNode: text => Object.assign(new Element('#text'), {textContent: text})},
    location: new URL('https://supatrace.invalid/app/'), sessionStorage: {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key)},
    requestAnimationFrame: callback => callback()};
  for (const [name, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {value, configurable: true, writable: true});
    t.after(() => original ? Object.defineProperty(globalThis, name, original) : delete globalThis[name]);
  }
  t.mock.method(globalThis, 'setTimeout', () => 0);
  t.mock.method(globalThis, 'fetch', (path, init) => new Promise((resolve, reject) => requests.push({path, body: JSON.parse(init.body), resolve, reject})));
  const until = async predicate => {
    const deadline = performance.now() + 2000;
    while (!predicate() && performance.now() < deadline) await new Promise(setImmediate);
    assert.ok(predicate(), 'expected request/state transition');
  };
  const {mountSignIn} = await import('../public/signin.js');
  mountSignIn(root, {email: true});
  const view = root.find(node => node.attrs['data-view'] === 'linkSent'), main = root.find(node => node.attrs['data-view'] === 'main');
  const resend = view.find(node => node.tag === 'button' && node.textContent === 'Resend sign-in link');
  const oldSend = resend.listeners.click();
  await until(() => requests.length === 1);
  view.find(node => node.textContent === 'Use a different email').listeners.click();
  const input = root.querySelector('#link-email'), form = main.find(node => node.tag === 'form'), submit = form.find(node => node.tag === 'button');
  assert.equal(main.hidden, false); assert.equal(view.hidden, true); assert.equal(storage.has(slot), false); assert.equal(focused, input);
  input.value = 'replacement@example.com';
  form.listeners.submit({preventDefault() {}});
  await until(() => requests.length === 2);
  assert.equal(submit.disabled, true);
  if (outcome === 'network') requests[0].reject(Error('synthetic network failure'));
  else requests[0].resolve(new Response(JSON.stringify(outcome === '429' ? {error: 'rate_limit'} : sent), {status: outcome === '429' ? 429 : 200, headers: {'Retry-After': '90'}}));
  await oldSend;
  assert.equal(main.hidden, false); assert.equal(view.hidden, true); assert.equal(storage.has(slot), false);
  assert.equal(root.querySelector('#auth-status').textContent, ''); assert.equal(focused, input); assert.equal(submit.disabled, true); assert.equal(resend.disabled, true);
  requests[1].resolve(new Response(JSON.stringify(sent)));
  await until(() => !view.hidden);
  assert.equal(main.hidden, true); assert.equal(JSON.parse(storage.get(slot)).sentEmail, 'replacement@example.com');
  assert.equal(view.children[1].textContent, 'We sent a sign-in link to replacement@example.com.');
  assert.equal(resend.disabled, true); assert.equal(requests.length, 2);
});
