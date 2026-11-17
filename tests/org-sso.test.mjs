// Per-organization SAML SSO, enforcement and SCIM 2.0 Users (#124), against the real handler with a SAML test IdP
// (an RSA key and self-signed certificate that sign Okta-shaped assertions; see tests/saml-fixture.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inflateRawSync} from 'node:zlib';
import {start as startHarness} from './harness.mjs';
// These tests exercise paid features, so every fixture organization is on Enterprise. tests/entitlements.test.mjs covers the gates.
const start = (options = {}) => startHarness({plan: 'enterprise', ...options});
import {digest} from '../src/aws-auth.mjs';
import {oktaResponse} from './saml-fixture.mjs';
import {joinBySso, orgSso, scimApi} from '../src/org-sso.mjs';
import {totp} from '../src/dashboard-auth.mjs';
import {identityIngressRequest} from '../src/identity-ingress.mjs';

function idpMaterial(name) {
  const dir = mkdtempSync(join(tmpdir(), 'supatrace-org-saml-')), key = join(dir, 'key.pem'), cert = join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', cert, '-days', '2', '-nodes', '-subj', '/CN=' + name], {stdio: 'ignore'});
  const material = {privateKey: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8')}; rmSync(dir, {recursive: true, force: true}); return material;
}
const acme = idpMaterial('acme-idp'), rogue = idpMaterial('rogue-idp'), ISSUER = 'https://idp.acme.example/saml';
async function account(live, id) { let cookie = ''; const tenant = await live.signIn({addCookies: async value => { cookie = value.map(c => c.name + '=' + c.value).join('; '); }}, id); return {tenant, cookie}; }
const post = (live, who, path, data) => fetch(live.origin + '/api/' + path, {method: 'POST', headers: {cookie: who.cookie, origin: live.origin, 'content-type': 'application/json'}, body: JSON.stringify(data)});
const get = (live, who, path) => fetch(live.origin + '/api/' + path, {headers: {cookie: who.cookie}});
const ok = async (response, status = 200) => { assert.equal(response.status, status, await response.clone().text()); return response.json(); };
const refused = async (response, status, code) => { assert.equal(response.status, status, await response.clone().text()); assert.equal((await response.json()).error, code); };
const cookieOf = (response, name) => response.headers.getSetCookie().find(value => value.startsWith(name + '='))?.split(';')[0];
// DNS is the test's: a TXT record exists only when the test publishes it.
async function world(options = {}) { let environment; const dns = new Map(), live = await start({...options, configureEnvironment: env => { environment = env; env.resolveTxt = async name => { if (!dns.has(name)) { const error = new Error('ENOTFOUND'); error.code = 'ENOTFOUND'; throw error; } return [[dns.get(name)]]; }; }}); return {live, dns, env: environment}; }
const settings = (org, extra = {}) => ({organization_id: org, idp_sso_url: 'https://idp.acme.example/sso', idp_issuer: ISSUER, idp_cert: acme.cert, default_role: 'developer', domains: ['acme.example'], ...extra});
async function configured(live, dns, owner, org = owner.tenant) {
  if (org === owner.tenant) await ok(await post(live, owner, 'workspaces', {name: 'Acme'}), 201);
  const saved = await ok(await post(live, owner, 'orgs/sso', settings(org))), record = saved.domains[0].record; dns.set(record.name, record.value);
  return ok(await post(live, owner, 'orgs/sso/verify', {organization_id: org, domain: 'acme.example'}));
}
// Browser side of SP-initiated sign-in: start, read the request id, post the IdP's signed response back with the relay cookie.
async function begin(live, email) { const response = await fetch(live.origin + '/api/auth/sso?email=' + encodeURIComponent(email)); if (response.status !== 200) return {response}; const url = new URL((await response.json()).url), xml = inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest'), 'base64')).toString(); return {response, url, relay: url.searchParams.get('RelayState'), requestId: xml.match(/\bID="([^"]+)"/)[1], cookie: cookieOf(response, 'supatrace-sso')}; }
const identityConfig = {apiId: 'identity1', region: 'us-east-1', edgeToken: 'E'.repeat(40)};
const adaptedIdentity = (method, path, body, headers = {}, cookie = '') => {
  const url = new URL('https://supatrace.dev' + path), route = path.startsWith('/api/auth/') ? 'POST /api/auth/sso/callback' : 'ANY /api/scim/v2/{proxy+}';
  const {request} = identityIngressRequest({version: '2.0', routeKey: route, rawPath: url.pathname, rawQueryString: url.search.slice(1),
    headers: {'x-supatrace-edge': identityConfig.edgeToken, 'x-supatrace-viewer-ip': '203.0.113.1', 'x-supatrace-host': 'supatrace.dev', ...headers},
    cookies: cookie ? [cookie] : [], requestContext: {apiId: identityConfig.apiId, domainName: 'identity1.execute-api.us-east-1.amazonaws.com', routeKey: route, stage: '$default', http: {method, path: url.pathname}},
    ...(body === undefined ? {} : {body, isBase64Encoded: false})}, identityConfig);
  return request;
};
const finish = (live, flow, xml) => {
  const body = new URLSearchParams({SAMLResponse: xml, RelayState: flow.relay}).toString();
  const request = adaptedIdentity('POST', '/api/auth/sso/callback', body, {'content-type': 'application/x-www-form-urlencoded'}, flow.cookie);
  return fetch(live.origin + '/api/auth/sso/callback', {method: 'POST', redirect: 'manual', headers: request.headers, body});
};
const assertion = (flow, nameId, overrides = {}) => oktaResponse({privateKey: acme.privateKey, cert: acme.cert, requestId: flow.requestId, nameId, notBefore: new Date(Date.now() - 60000).toISOString(), notOnOrAfter: new Date(Date.now() + 240000).toISOString(), issuer: ISSUER, ...overrides});
async function signInBySso(live, email) { const flow = await begin(live, email), done = await finish(live, flow, assertion(flow, email)); assert.equal(done.status, 302, await done.clone().text()); return {tenant: 'sso-' + digest(email), cookie: cookieOf(done, '__Host-supatrace')}; }

test('owner configures SAML for an organization; a domain counts only after its DNS TXT record is published', async () => {
  const {live, dns} = await world(); try {
    const owner = await account(live, 4242), admin = await account(live, 5252), other = await account(live, 6262);
    await ok(await post(live, owner, 'workspaces', {name: 'Acme'}), 201);
    const invite = await ok(await post(live, owner, 'workspaces/invite', {recipient_id: admin.tenant, role: 'admin'}), 201); await ok(await post(live, admin, 'workspaces/accept', {workspace_id: owner.tenant, token: invite.token}));
    assert.deepEqual((await ok(await get(live, owner, 'orgs/sso'))).configured, false);
    assert.equal((await (await fetch(live.origin + '/api/auth/providers')).json()).sso, false);
    // Owner only; input is validated before anything is stored.
    await refused(await get(live, admin, 'orgs/sso?workspace=' + owner.tenant), 403, 'workspace_owner_required');
    await refused(await post(live, admin, 'orgs/sso', settings(owner.tenant)), 403, 'workspace_owner_required');
    await refused(await post(live, other, 'orgs/sso', settings(owner.tenant)), 403, 'workspace_unavailable');
    for (const [bad, code] of [[{idp_cert: 'not a certificate'}, 'invalid_sso_certificate'], [{idp_cert: acme.privateKey}, 'invalid_sso_certificate'], [{idp_sso_url: 'http://idp.acme.example/sso'}, 'invalid_sso_configuration'], [{idp_issuer: ''}, 'invalid_sso_configuration'], [{default_role: 'owner'}, 'invalid_sso_configuration'], [{domains: ['Acme.example']}, 'invalid_sso_domain'], [{domains: ['a', 'b']}, 'invalid_sso_domain'], [{domains: ['x.example', 'x.example']}, 'invalid_sso_domain']])
      await refused(await post(live, owner, 'orgs/sso', settings(owner.tenant, bad)), 400, code);
    const saved = await ok(await post(live, owner, 'orgs/sso', settings(owner.tenant)));
    assert.deepEqual([saved.configured, saved.enforce, saved.default_role, saved.idp_issuer, saved.scim.token_set], [true, false, 'developer', ISSUER, false]);
    assert.deepEqual(saved.service_provider, {entity_id: 'https://supatrace.dev/api/auth/sso', acs_url: 'https://supatrace.dev/api/auth/sso/callback', name_id: 'emailAddress'});
    assert.match(saved.idp_cert_sha256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/); assert.equal(JSON.stringify(saved).includes('BEGIN CERTIFICATE'), false, 'the certificate is shown by fingerprint only');
    const [domain] = saved.domains; assert.deepEqual([domain.domain, domain.verified, domain.record.name, domain.record.type], ['acme.example', false, '_supatrace.acme.example', 'TXT']); assert.match(domain.record.value, /^supatrace-verification=[A-Za-z0-9_-]{24}$/);
    // Unverified: sign-in does not know the domain, enforcement cannot be turned on.
    assert.equal((await begin(live, 'ada@acme.example')).response.status, 404);
    await refused(await post(live, owner, 'orgs/sso/enforce', {organization_id: owner.tenant, enforce: true}), 409, 'sso_not_ready');
    await refused(await post(live, owner, 'orgs/sso/verify', {organization_id: owner.tenant, domain: 'acme.example'}), 409, 'sso_domain_not_verified');
    dns.set(domain.record.name, 'supatrace-verification=wrong'); await refused(await post(live, owner, 'orgs/sso/verify', {organization_id: owner.tenant, domain: 'acme.example'}), 409, 'sso_domain_not_verified');
    await refused(await post(live, owner, 'orgs/sso/verify', {organization_id: owner.tenant, domain: 'other.example'}), 400, 'invalid_sso_domain');
    dns.set(domain.record.name, domain.record.value);
    assert.equal((await ok(await post(live, owner, 'orgs/sso/verify', {organization_id: owner.tenant, domain: 'acme.example'}))).domains[0].verified, true);
    assert.equal((await (await fetch(live.origin + '/api/auth/providers')).json()).sso, true, 'the sign-in page now offers SSO');
    // A second organization cannot claim a verified domain, even with the DNS record for its own token in place.
    await ok(await post(live, other, 'workspaces', {name: 'Squatter'}), 201);
    const theirs = await ok(await post(live, other, 'orgs/sso', settings(other.tenant))); dns.set(theirs.domains[0].record.name, theirs.domains[0].record.value);
    await refused(await post(live, other, 'orgs/sso/verify', {organization_id: other.tenant, domain: 'acme.example'}), 409, 'sso_domain_claimed');
    // Saving again keeps the verification; removing the domain gives up the claim.
    assert.equal((await ok(await post(live, owner, 'orgs/sso', settings(owner.tenant, {default_role: 'viewer'})))).domains[0].verified, true);
    assert.deepEqual((await ok(await post(live, owner, 'orgs/sso', settings(owner.tenant, {domains: []})))).domains, []); assert.equal((await begin(live, 'ada@acme.example')).response.status, 404);
    const events = (await ok(await get(live, owner, 'audit?action=sso'))).events; assert.deepEqual(events.map(e => e.action), ['sso.config_changed', 'sso.config_changed', 'sso.domain_verified', 'sso.config_changed']);
    assert.equal(JSON.stringify(events).includes('BEGIN CERTIFICATE'), false);
  } finally { await live.close(); }
});

test('SSO sign-in with the organization IdP: a signed assertion signs in and joins with the default role; forgeries do not', async () => {
  const {live, dns} = await world(); try {
    const owner = await account(live, 4242); await configured(live, dns, owner);
    const flow = await begin(live, 'ada@acme.example'); assert.equal(flow.url.origin + flow.url.pathname, 'https://idp.acme.example/sso'); assert.match(flow.response.headers.getSetCookie().join(), /supatrace-sso=.*SameSite=None/);
    // Wrong key, wrong issuer, another domain, no relay cookie, replayed request id.
    const forged = oktaResponse({privateKey: rogue.privateKey, cert: rogue.cert, requestId: flow.requestId, nameId: 'ada@acme.example', notBefore: new Date(Date.now() - 60000).toISOString(), notOnOrAfter: new Date(Date.now() + 240000).toISOString(), issuer: ISSUER});
    await refused(await finish(live, flow, forged), 401, 'identity_not_verified');
    const second = await begin(live, 'ada@acme.example'); await refused(await finish(live, second, assertion(second, 'ada@acme.example', {issuer: 'https://evil.example/saml'})), 401, 'identity_not_verified');
    const third = await begin(live, 'ada@acme.example'); await refused(await finish(live, third, assertion(third, 'ada@elsewhere.example')), 401, 'identity_not_verified');
    const fourth = await begin(live, 'ada@acme.example'); assert.equal((await finish(live, {...fourth, cookie: ''}, assertion(fourth, 'ada@acme.example'))).status, 400);
    const good = await begin(live, 'ada@acme.example'), xml = assertion(good, 'ada@acme.example'), done = await finish(live, good, xml);
    assert.equal(done.status, 302); assert.equal(done.headers.get('location'), '/app/'); const ada = {tenant: 'sso-' + digest('ada@acme.example'), cookie: cookieOf(done, '__Host-supatrace')};
    await refused(await finish(live, good, xml), 401, 'identity_not_verified');
    // Ada is signed in as her own SSO account and is already a member with the default role.
    assert.equal((await ok(await get(live, ada, 'me'))).tenant_id, ada.tenant);
    assert.deepEqual((await ok(await get(live, ada, 'orgs'))).organizations.map(o => [o.id, o.role]), [[ada.tenant, 'owner'], [owner.tenant, 'developer']]);
    assert.equal((await get(live, ada, 'runs?workspace=' + owner.tenant)).status, 200);
    const member = (await ok(await get(live, owner, 'workspaces/members'))).members.find(m => m.user_id === ada.tenant); assert.deepEqual([member.role, member.active], ['developer', true]);
    // A second sign-in does not add a second membership or event.
    await signInBySso(live, 'ada@acme.example');
    assert.deepEqual((await ok(await get(live, owner, 'audit?action=sso.member_joined'))).events.map(e => [e.actor, e.target, e.detail.role]), [[ada.tenant, ada.tenant, 'developer']]);
    // A domain nobody verified is unknown to sign-in.
    assert.equal((await begin(live, 'bob@unclaimed.example')).response.status, 404);
  } finally { await live.close(); }
});

test('SSO enforcement: members must come through the organization IdP; the owner keeps access', async () => {
  const {live, dns} = await world(); try {
    const owner = await account(live, 4242), github = await account(live, 5252), scope = '?workspace=' + owner.tenant; await configured(live, dns, owner);
    const invite = await ok(await post(live, owner, 'workspaces/invite', {recipient_id: github.tenant, role: 'admin'}), 201); await ok(await post(live, github, 'workspaces/accept', {workspace_id: owner.tenant, token: invite.token}));
    const ada = await signInBySso(live, 'ada@acme.example');
    assert.equal((await get(live, github, 'runs' + scope)).status, 200);
    await refused(await post(live, github, 'orgs/sso/enforce', {organization_id: owner.tenant, enforce: true}), 403, 'workspace_owner_required');
    assert.equal((await post(live, owner, 'orgs/sso/enforce', {organization_id: owner.tenant, enforce: 'yes'})).status, 400);
    assert.equal((await ok(await post(live, owner, 'orgs/sso/enforce', {organization_id: owner.tenant, enforce: true}))).enforce, true);
    // The GitHub-account member is refused everywhere in the organization and flagged in the list; the SSO member and the owner are not.
    for (const path of ['runs', 'usage', 'workspace', 'keys', 'environments', 'drains']) await refused(await get(live, github, path + scope), 403, 'sso_required');
    await refused(await post(live, github, 'environments' + scope, {id: 'dev', name: 'Dev'}), 403, 'sso_required');
    assert.equal((await ok(await get(live, github, 'orgs'))).organizations.find(o => o.id === owner.tenant).sso_required, true);
    assert.equal((await get(live, github, 'runs')).status, 200, 'their personal organization is not affected');
    assert.equal((await get(live, ada, 'runs' + scope)).status, 200); assert.equal((await ok(await get(live, ada, 'orgs'))).organizations.find(o => o.id === owner.tenant).sso_required, false);
    assert.equal((await get(live, owner, 'runs')).status, 200); assert.equal((await get(live, owner, 'workspaces/members')).status, 200);
    // Removing the last verified domain turns enforcement off rather than locking everyone out.
    const cleared = await ok(await post(live, owner, 'orgs/sso', settings(owner.tenant, {domains: []}))); assert.equal(cleared.enforce, false); assert.equal((await get(live, github, 'runs' + scope)).status, 200);
    assert.deepEqual((await ok(await get(live, owner, 'audit?action=sso.enforcement_changed'))).events.map(e => e.detail.enabled), [true]);
  } finally { await live.close(); }
});

test('SCIM: an existing SSO member created inactive is deactivated; concurrent creates cannot pass the cap', async () => {
  const {live, dns} = await world(); try {
    const owner = await account(live, 4242); await configured(live, dns, owner);
    const token = 'stscim_' + randomBytes(32).toString('base64url'); await ok(await post(live, owner, 'orgs/sso/scim-token', {organization_id: owner.tenant, token_hash: digest(token)}), 201);
    const scim = (method, path, body) => fetch(live.origin + '/api/scim/v2' + path, {method, headers: {authorization: 'Bearer ' + token, 'content-type': 'application/scim+json'}, ...(body ? {body: JSON.stringify(body)} : {})});
    const ada = await signInBySso(live, 'ada@acme.example'); assert.equal((await get(live, ada, 'runs?workspace=' + owner.tenant)).status, 200);
    const made = await scim('POST', '/Users', {userName: 'ada@acme.example', active: false}); assert.equal(made.status, 201); assert.equal((await made.json()).active, false);
    await refused(await get(live, ada, 'runs?workspace=' + owner.tenant), 403, 'workspace_unavailable');
    assert.equal((await scim('PUT', '/Users/' + ada.tenant, {active: true})).status, 200); assert.equal((await get(live, ada, 'runs?workspace=' + owner.tenant)).status, 200);
    // The owner removes her by hand; a SCIM "inactive" that matches the record still leaves her out, and "active" brings her back.
    const row = (await ok(await get(live, owner, 'workspaces/members'))).members.find(m => m.user_id === ada.tenant); await ok(await post(live, owner, 'workspaces/member', {user_id: ada.tenant, role: 'removed', version: row.version}));
    assert.equal((await scim('PUT', '/Users/' + ada.tenant, {active: true})).status, 200); assert.equal((await get(live, ada, 'runs?workspace=' + owner.tenant)).status, 200);
    // A sign-in that lands in the middle of an inactive create cannot leave the person a member, whichever side runs second.
    for (const when of ['before the record', 'after the record']) {
      const email = `mid-${when.split(' ')[0]}@acme.example`, person = (await live.store.getOrCreateSsoTenant(email)).tenant_id, sso = await orgSso(live.store, owner.tenant), env = {store: Object.create(live.store), APP_ORIGIN: 'https://supatrace.dev', sourceIp: '127.0.0.1'};
      const tx = live.store._tx.bind(live.store); let joined = false;
      // Run the join immediately before, or immediately after, the transaction that writes the SCIM record.
      env.store._tx = async items => { const record = items.some(item => item.Put?.Item?.sk === 'SCIMUSER#' + person); if (record && !joined && when === 'before the record') { joined = true; await joinBySso({store: live.store, sourceIp: '127.0.0.1'}, sso, person); } const result = await tx(items); if (record && !joined) { joined = true; await joinBySso({store: live.store, sourceIp: '127.0.0.1'}, sso, person); } return result; };
      const response = await scimApi(new Request('https://supatrace.dev/api/scim/v2/Users', {method: 'POST', headers: {authorization: 'Bearer ' + token, 'content-type': 'application/scim+json'}, body: JSON.stringify({userName: email, active: false})}), env);
      assert.equal(response.status, 201, when); assert.equal((await response.json()).active, false); assert.equal(joined, true);
      assert.notEqual((await live.store._get({pk: 'TENANT#' + owner.tenant, sk: 'MEMBER#' + person}))?.active, true, 'joined ' + when + ': not a member afterwards');
    }
    // Two SCIM requests for one user: an activation that is overtaken by a delete must not leave access behind.
    {
      const email = 'overtaken@acme.example', made = await scim('POST', '/Users', {userName: email, active: false}), id = (await made.json()).id; assert.equal(made.status, 201);
      const env = {store: Object.create(live.store), APP_ORIGIN: 'https://supatrace.dev', sourceIp: '127.0.0.1'}, tx = live.store._tx.bind(live.store); let deleted = false;
      // The activation has written its record and is about to activate the membership when the delete runs to completion.
      env.store._tx = async items => { if (!deleted && items.some(item => item.Put?.Item?.sk === 'MEMBER#' + id && item.Put.Item.active === true)) { deleted = true; assert.equal((await scim('DELETE', '/Users/' + id)).status, 204); } return tx(items); };
      const activation = await scimApi(new Request('https://supatrace.dev/api/scim/v2/Users/' + id, {method: 'PUT', headers: {authorization: 'Bearer ' + token, 'content-type': 'application/scim+json'}, body: JSON.stringify({active: true})}), env);
      assert.equal(deleted, true); assert.equal(activation.status, 409, 'the overtaken activation is refused');
      assert.notEqual((await live.store._get({pk: 'TENANT#' + owner.tenant, sk: 'MEMBER#' + id}))?.active, true); assert.equal((await scim('GET', '/Users/' + id)).status, 404);
      // A DELETE whose membership write fails after the record was marked deleted is finished by its retry.
      {
        const mail = 'retry@acme.example', created = await scim('POST', '/Users', {userName: mail}), uid = (await created.json()).id, broken = {store: Object.create(live.store), APP_ORIGIN: 'https://supatrace.dev', sourceIp: '127.0.0.1'};
        broken.store._tx = async items => { if (items.some(item => item.Put?.Item?.sk === 'MEMBER#' + uid)) throw new Error('synthetic storage failure'); return live.store._tx(items); };
        const first = await scimApi(new Request('https://supatrace.dev/api/scim/v2/Users/' + uid, {method: 'DELETE', headers: {authorization: 'Bearer ' + token}}), broken); assert.equal(first.status, 503);
        assert.equal((await live.store._get({pk: 'TENANT#' + owner.tenant, sk: 'MEMBER#' + uid})).active, true, 'the failed attempt left the membership active');
        assert.equal((await scim('DELETE', '/Users/' + uid)).status, 204); assert.equal((await live.store._get({pk: 'TENANT#' + owner.tenant, sk: 'MEMBER#' + uid})).active, false);
        assert.equal((await scim('DELETE', '/Users/' + uid)).status, 204, 'and deleting again stays a no-op'); assert.equal((await scim('GET', '/Users/' + uid)).status, 404);
      }
      // And the reverse order: a delete overtaken by nothing, then a stale activation of the deleted record, is a 404.
      assert.equal((await scim('PUT', '/Users/' + id, {active: true})).status, 404);
    }
    // Thirty creates at once: exactly the remaining places succeed, and no more accounts than the cap exist.
    const results = await Promise.all(Array.from({length: 30}, (_, i) => scim('POST', '/Users', {userName: `race${i}@acme.example`, active: false}).then(r => r.status)));
    assert.equal(results.filter(status => status === 201).length, 15); assert.equal(results.filter(status => status === 409).length, 15);
    const accounts = [...live.store.client.items.keys()].filter(key => key.startsWith('TENANT#sso-') && key.endsWith('\0META')).length; assert.equal(accounts, 20);
  } finally { await live.close(); }
});

test('SCIM 2.0 Users: bearer token, provision, list, filter, deactivate, reactivate, delete', async () => {
  const {live, dns} = await world(); try {
    const owner = await account(live, 4242), outsider = await account(live, 5252); await configured(live, dns, owner);
    const token = 'stscim_' + randomBytes(32).toString('base64url'), base = live.origin + '/api/scim/v2';
    const scim = (method, path, body, bearer = token) => {
      const raw = body ? JSON.stringify(body) : undefined;
      const request = adaptedIdentity(method, '/api/scim/v2' + path, raw, {...(bearer ? {authorization: 'Bearer ' + bearer} : {}), ...(body ? {'content-type': 'application/scim+json'} : {})});
      return fetch(base + path, {method, headers: request.headers, ...(raw ? {body: raw} : {})});
    };
    const fine = async (response, status = 200) => { assert.equal(response.status, status, await response.clone().text()); assert.match(response.headers.get('content-type'), /^application\/scim\+json/); return response.json(); };
    // No token yet, wrong token, session cookie instead of a token: all refused.
    assert.equal((await scim('GET', '/Users')).status, 401); assert.equal((await scim('GET', '/Users', null, '')).status, 401);
    assert.equal((await fetch(base + '/Users', {headers: {cookie: owner.cookie}})).status, 401);
    await refused(await post(live, outsider, 'orgs/sso/scim-token', {organization_id: owner.tenant, token_hash: digest(token)}), 403, 'workspace_unavailable');
    assert.equal((await post(live, owner, 'orgs/sso/scim-token', {organization_id: owner.tenant, token_hash: token})).status, 400, 'only the SHA-256 is accepted');
    assert.equal((await ok(await post(live, owner, 'orgs/sso/scim-token', {organization_id: owner.tenant, token_hash: digest(token)}), 201)).scim.token_set, true);
    assert.equal((await fine(await scim('GET', '/ServiceProviderConfig'))).patch.supported, true);
    assert.deepEqual(await fine(await scim('GET', '/Users')), {schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults: 0, startIndex: 1, itemsPerPage: 0, Resources: []});
    // Provision: only addresses in a verified domain; the person becomes a member with the default role before they ever sign in.
    for (const bad of [{userName: 'not-an-email'}, {userName: 'eve@elsewhere.example'}, {userName: 'x@acme.example', externalId: 5}, {}]) assert.equal((await scim('POST', '/Users', {schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], ...bad})).status, 400, JSON.stringify(bad));
    const made = await fine(await scim('POST', '/Users', {schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'Grace@Acme.example', externalId: '00u1', active: true}), 201), id = 'sso-' + digest('grace@acme.example');
    assert.deepEqual([made.id, made.userName, made.externalId, made.active, made.emails[0].value, made.meta.resourceType, made.meta.location], [id, 'grace@acme.example', '00u1', true, 'grace@acme.example', 'User', 'https://supatrace.dev/api/scim/v2/Users/' + id]);
    assert.equal((await scim('POST', '/Users', {userName: 'grace@acme.example'})).status, 409);
    const member = async () => (await ok(await get(live, owner, 'workspaces/members'))).members.find(m => m.user_id === id); assert.deepEqual([(await member()).role, (await member()).active], ['developer', true]);
    const grace = await signInBySso(live, 'grace@acme.example'); assert.equal(grace.tenant, id); assert.equal((await get(live, grace, 'runs?workspace=' + owner.tenant)).status, 200);
    await fine(await scim('POST', '/Users', {userName: 'linus@acme.example', active: false}), 201);
    assert.equal((await fine(await scim('GET', '/Users'))).totalResults, 2); assert.equal((await fine(await scim('GET', '/Users?startIndex=2&count=1'))).Resources.length, 1);
    assert.deepEqual((await fine(await scim('GET', '/Users?filter=' + encodeURIComponent('userName eq "grace@acme.example"')))).Resources.map(u => u.id), [id]);
    assert.equal((await scim('GET', '/Users?filter=' + encodeURIComponent('displayName co "x"'))).status, 400);
    assert.equal((await fine(await scim('GET', '/Users/' + id))).userName, 'grace@acme.example'); assert.equal((await scim('GET', '/Users/sso-' + '0'.repeat(64))).status, 404); assert.equal((await scim('GET', '/Users/' + owner.tenant)).status, 404);
    // Deactivate (both PATCH shapes IdPs send), which ends access at once; reactivate; replace; delete.
    assert.equal((await fine(await scim('PATCH', '/Users/' + id, {schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{op: 'replace', value: {active: false}}]}))).active, false);
    assert.equal((await member()).active, false); await refused(await get(live, grace, 'runs?workspace=' + owner.tenant), 403, 'workspace_unavailable');
    assert.equal((await fine(await scim('PATCH', '/Users/' + id, {Operations: [{op: 'Replace', path: 'active', value: true}]}))).active, true); assert.equal((await get(live, grace, 'runs?workspace=' + owner.tenant)).status, 200);
    assert.equal((await scim('PATCH', '/Users/' + id, {Operations: [{op: 'add', path: 'nickName', value: 'g'}]})).status, 400);
    assert.equal((await fine(await scim('PUT', '/Users/' + id, {userName: 'grace@acme.example', active: false}))).active, false);
    assert.equal((await scim('DELETE', '/Users/' + id)).status, 204); assert.equal((await scim('GET', '/Users/' + id)).status, 404); assert.equal((await member()).active, false);
    // Signing in again does not undo the deactivation or the delete: only SCIM or the owner brings a person back.
    const again = await signInBySso(live, 'grace@acme.example'); await refused(await get(live, again, 'runs?workspace=' + owner.tenant), 403, 'workspace_unavailable'); assert.equal((await member()).active, false);
    const linus = await signInBySso(live, 'linus@acme.example'); await refused(await get(live, linus, 'runs?workspace=' + owner.tenant), 403, 'workspace_unavailable'); assert.equal((await ok(await get(live, linus, 'orgs'))).organizations.length, 1, 'a user provisioned inactive is not admitted by signing in');
    // Recreating a deleted user restores the same account and does not use another place.
    assert.equal((await fine(await scim('POST', '/Users', {userName: 'grace@acme.example'}), 201)).id, id); assert.equal((await member()).active, true); assert.equal((await scim('DELETE', '/Users/' + id)).status, 204);
    // The cap counts every address ever provisioned, so creating and deleting cannot mint accounts without limit.
    for (let i = 0; i < 18; i++) { const made = await scim('POST', '/Users', {userName: `bulk${i}@acme.example`, active: false}); assert.equal(made.status, 201); if (i % 2) assert.equal((await scim('DELETE', '/Users/' + (await made.json()).id)).status, 204); }
    const full = await scim('POST', '/Users', {userName: 'one-too-many@acme.example', active: false}); assert.equal(full.status, 409); assert.equal((await full.json()).scimType, 'tooMany');
    assert.equal((await fine(await scim('GET', '/Users'))).totalResults, 10, 'deleted users are not listed');
    // A person who joined through SSO first and is then created inactive by SCIM loses access, and stays out.
    const joined = await signInBySso(live, 'bulk0@acme.example'); await refused(await get(live, joined, 'runs?workspace=' + owner.tenant), 403, 'workspace_unavailable');
    // A new token replaces the old one; SCIM cannot touch the owner; another organization's token sees nothing here.
    const next = 'stscim_' + randomBytes(32).toString('base64url'); await ok(await post(live, owner, 'orgs/sso/scim-token', {organization_id: owner.tenant, token_hash: digest(next)}), 201);
    assert.equal((await scim('GET', '/Users')).status, 401); assert.equal((await scim('GET', '/Users', null, next)).status, 200);
    const events = (await ok(await get(live, owner, 'audit?action=scim'))).events; assert.deepEqual(events.map(e => e.action).reverse(), ['scim.token_created', 'scim.user_provisioned', 'scim.user_deactivated', 'scim.user_provisioned', 'scim.user_deactivated', 'scim.user_provisioned', 'scim.user_deactivated', 'scim.token_created']);
    assert.ok(events.every(e => !JSON.stringify(e).includes(token) && !JSON.stringify(e).includes(digest(token)))); assert.match(events.at(-2).actor, /^scim:[a-f0-9]{12}$/);
  } finally { await live.close(); }
});

// ---- Regressions from the adversarial pass over every SSO and SCIM state change. Each failed before its fix. ----
const memberRow = (live, org, id) => live.store._get({pk: 'TENANT#' + org, sk: 'MEMBER#' + id});
// Sessions live in a bounded slot table; a random token can land on an occupied slot, as in production, where sign-in retries with a new token.
const sessionFor = async (live, tenant, sso = null) => { for (;;) { const token = randomBytes(32).toString('base64url'); try { await live.store.createSession(digest(token), tenant, undefined, undefined, sso); return {tenant, cookie: '__Host-supatrace=' + token}; } catch (error) { if (error?.code !== 'session_slot_collision') throw error; } } };
const scimToken = async (live, owner) => { const token = 'stscim_' + randomBytes(32).toString('base64url'); await ok(await post(live, owner, 'orgs/sso/scim-token', {organization_id: owner.tenant, token_hash: digest(token)}), 201); return token; };
const scimCall = (live, token) => (method, path, body) => fetch(live.origin + '/api/scim/v2' + path, {method, headers: {authorization: 'Bearer ' + token, 'content-type': 'application/scim+json'}, ...(body ? {body: JSON.stringify(body)} : {})});
const direct = (live, token, method, path, body, store) => scimApi(new Request('https://supatrace.dev/api/scim/v2' + path, {method, headers: {authorization: 'Bearer ' + token, 'content-type': 'application/scim+json'}, ...(body ? {body: JSON.stringify(body)} : {})}), {store, APP_ORIGIN: 'https://supatrace.dev', sourceIp: '127.0.0.1'});

test('require SSO accepts only a session that this organization\'s current IdP vouched for', async () => {
  const {live, dns, env} = await world(); try {
    const owner = await account(live, 4242), scope = '?workspace=' + owner.tenant, runs = who => get(live, who, 'runs' + scope); await configured(live, dns, owner);
    const ada = await signInBySso(live, 'ada@acme.example'); await ok(await post(live, owner, 'orgs/sso/enforce', {organization_id: owner.tenant, enforce: true}));
    assert.equal((await runs(ada)).status, 200); assert.deepEqual((await live.store.getSession(digest(ada.cookie.split('=')[1]))).sso, {org: owner.tenant, idp_version: 1});
    // The same SSO account, signed in some other way (a linked sign-in method, another organization's IdP, an older version of the settings): refused.
    for (const sso of [null, {org: 'github-999', idp_version: 1}, {org: owner.tenant, idp_version: 0}, {org: owner.tenant, idp_version: 2}]) {
      const other = await sessionFor(live, ada.tenant, sso); await refused(await runs(other), 403, 'sso_required'); await refused(await get(live, other, 'environments' + scope), 403, 'sso_required');
      assert.equal((await ok(await get(live, other, 'orgs'))).organizations.find(o => o.id === owner.tenant).sso_required, true); assert.equal((await ok(await get(live, other, 'projects'))).projects.find(p => p.workspace_id === owner.tenant).sso_required, true);
    }
    // A personal access token carries no SSO sign-in, so it cannot read an organization that requires SSO. The owner's token can.
    const pat = async who => { const token = 'stpat_' + randomBytes(32).toString('base64url'); await ok(await post(live, who, 'tokens', {name: 'ci', token_hash: digest(token)}), 201); return token; };
    const v1 = token => fetch(live.origin + '/api/v1/traces' + scope, {headers: {authorization: 'Bearer ' + token}});
    await refused(await v1(await pat(ada)), 403, 'sso_required'); assert.equal((await v1(await pat(owner))).status, 200);
    // The operator later lists the same domain for the deployment's IdP. Sign-in for the domain now goes to that IdP, whose
    // sessions are not the organization's: its members are refused until they come through the organization's IdP again.
    const DEPLOYMENT = 'https://idp.deployment.example/saml'; Object.assign(env, {SSO_EMAIL_DOMAINS: 'acme.example', SSO_IDP_SSO_URL: 'https://idp.deployment.example/sso', SSO_IDP_ISSUER: DEPLOYMENT, SSO_IDP_CERT: rogue.cert});
    const flow = await begin(live, 'ada@acme.example'); assert.equal(flow.url.origin, 'https://idp.deployment.example');
    const done = await finish(live, flow, oktaResponse({privateKey: rogue.privateKey, cert: rogue.cert, requestId: flow.requestId, nameId: 'ada@acme.example', notBefore: new Date(Date.now() - 60000).toISOString(), notOnOrAfter: new Date(Date.now() + 240000).toISOString(), issuer: DEPLOYMENT}));
    assert.equal(done.status, 302, await done.clone().text()); const viaDeployment = {tenant: ada.tenant, cookie: cookieOf(done, '__Host-supatrace')};
    assert.equal((await get(live, viaDeployment, 'runs')).status, 200, 'the same account, signed in'); await refused(await runs(viaDeployment), 403, 'sso_required');
    // The domain is the deployment's now. The session the organization's IdP made for it earlier no longer counts, SCIM cannot
    // provision it, and the organization's IdP cannot assert it, even in a request started for another domain the organization has.
    await refused(await runs(ada), 403, 'sso_required');
    const second = (await ok(await post(live, owner, 'orgs/sso', settings(owner.tenant, {domains: ['acme.example', 'second.example']})))).domains.find(d => d.domain === 'second.example').record; dns.set(second.name, second.value); await ok(await post(live, owner, 'orgs/sso/verify', {organization_id: owner.tenant, domain: 'second.example'}));
    const cross = await begin(live, 'zed@second.example'); assert.equal(cross.url.origin, 'https://idp.acme.example'); assert.equal((await finish(live, cross, assertion(cross, 'victim@acme.example'))).status, 401, 'an organization IdP cannot assert a deployment domain');
    assert.equal(await live.store.getTenant('sso-' + digest('victim@acme.example')), null); const own = await begin(live, 'zed@second.example'); assert.equal((await finish(live, own, assertion(own, 'zed@second.example'))).status, 302);
    const reservedScim = scimCall(live, await scimToken(live, owner)); assert.equal((await reservedScim('POST', '/Users', {userName: 'new@acme.example'})).status, 400); assert.equal((await reservedScim('POST', '/Users', {userName: 'new@second.example'})).status, 201);
    // A domain the deployment's IdP owns cannot be verified by an organization at all.
    env.SSO_EMAIL_DOMAINS = 'corp.example'; const added = await ok(await post(live, owner, 'orgs/sso', settings(owner.tenant, {domains: ['acme.example', 'second.example', 'corp.example']}))), record = added.domains.find(d => d.domain === 'corp.example').record; dns.set(record.name, record.value);
    await refused(await post(live, owner, 'orgs/sso/verify', {organization_id: owner.tenant, domain: 'corp.example'}), 409, 'sso_domain_claimed');
    for (const name of ['SSO_EMAIL_DOMAINS', 'SSO_IDP_SSO_URL', 'SSO_IDP_ISSUER', 'SSO_IDP_CERT']) delete env[name];
    // Saving settings that keep the IdP (another default role, another domain list) keeps sessions; replacing the certificate ends them.
    await ok(await post(live, owner, 'orgs/sso', settings(owner.tenant, {default_role: 'viewer'}))); assert.equal((await runs(ada)).status, 200);
    await ok(await post(live, owner, 'orgs/sso', settings(owner.tenant, {idp_cert: rogue.cert}))); await refused(await runs(ada), 403, 'sso_required');
    const old = await begin(live, 'ada@acme.example'); assert.equal((await finish(live, old, assertion(old, 'ada@acme.example'))).status, 401, 'the replaced IdP can no longer sign anyone in');
    const again = await begin(live, 'ada@acme.example'), fresh = await finish(live, again, assertion(again, 'ada@acme.example', {privateKey: rogue.privateKey, cert: rogue.cert})); assert.equal(fresh.status, 302);
    assert.equal((await runs({cookie: cookieOf(fresh, '__Host-supatrace')})).status, 200); await refused(await runs(ada), 403, 'sso_required');
    // Replacing only the issuer or only the sign-on URL is a new IdP too.
    for (const change of [{idp_issuer: ISSUER + '/2'}, {idp_sso_url: 'https://idp2.acme.example/sso'}]) { const before = (await live.store._get({pk: 'TENANT#' + owner.tenant, sk: 'SSO#CONFIG'})).idp_version; await ok(await post(live, owner, 'orgs/sso', settings(owner.tenant, {idp_cert: rogue.cert, ...change}))); const now = await live.store._get({pk: 'TENANT#' + owner.tenant, sk: 'SSO#CONFIG'}); assert.equal(now.idp_version, before + 1); assert.equal((await live.store._get({pk: 'TENANT#' + owner.tenant, sk: 'WORKSPACE#META'})).sso_idp_version, now.idp_version); }
  } finally { await live.close(); }
});

test('require SSO: the organization binding survives the two-factor step of an SSO sign-in', async () => {
  const {live, dns} = await world({mfa: true}); try {
    const owner = await account(live, 4242), scope = '?workspace=' + owner.tenant; await configured(live, dns, owner);
    const ada = await signInBySso(live, 'ada@acme.example'); await ok(await post(live, owner, 'orgs/sso/enforce', {organization_id: owner.tenant, enforce: true}));
    const secret = (await ok(await post(live, ada, 'auth/mfa/enroll', {}))).secret; await ok(await post(live, ada, 'auth/mfa/confirm', {code: totp(secret)}));
    const flow = await begin(live, 'ada@acme.example'), done = await finish(live, flow, assertion(flow, 'ada@acme.example')); assert.equal(done.status, 302); assert.equal(cookieOf(done, '__Host-supatrace'), undefined, 'no session before the code');
    const verified = await fetch(live.origin + '/api/auth/mfa', {method: 'POST', headers: {cookie: cookieOf(done, '__Host-supatrace-mfa'), origin: live.origin, 'content-type': 'application/json'}, body: JSON.stringify({code: totp(secret)})}); assert.equal(verified.status, 204, await verified.clone().text());
    const session = {cookie: cookieOf(verified, '__Host-supatrace')}; assert.equal((await get(live, session, 'runs' + scope)).status, 200);
    assert.deepEqual((await live.store.getSession(digest(session.cookie.split('=')[1]))).sso, {org: owner.tenant, idp_version: 1});
  } finally { await live.close(); }
});

test('a sign-in never brings back a member who was removed while it was in flight, and joins only under the IdP it was checked against', async () => {
  const {live, dns} = await world(); try {
    const owner = await account(live, 4242); await configured(live, dns, owner); const sso = await orgSso(live.store, owner.tenant);
    const remove = async id => { const row = (await ok(await get(live, owner, 'workspaces/members'))).members.find(m => m.user_id === id); await ok(await post(live, owner, 'workspaces/member', {user_id: id, role: 'removed', version: row.version})); };
    // Sign-in A has seen "no membership". Sign-in B then joins and the owner removes the person, at each later step of A in turn.
    for (const when of ['before A reads the membership again', 'before A writes']) {
      const person = (await live.store.getOrCreateSsoTenant(`flight-${when.length}@acme.example`)).tenant_id, store = Object.create(live.store); let reads = 0, done = false;
      const interleave = async () => { if (done) return; done = true; assert.equal((await joinBySso({store: live.store, sourceIp: '127.0.0.1'}, sso, person)).created, true); await remove(person); };
      store._get = async key => { if (key.sk === 'MEMBER#' + person && ++reads === 2 && when.startsWith('before A reads')) await interleave(); return live.store._get(key); };
      store._tx = async items => { if (items.some(item => item.Put?.Item?.sk === 'MEMBER#' + person)) await interleave(); return live.store._tx(items); };
      const result = await joinBySso({store, sourceIp: '127.0.0.1'}, sso, person); assert.equal(done, true, when); assert.equal(result.created, false, when); assert.equal(result.active, false, when);
      assert.equal((await memberRow(live, owner.tenant, person)).active, false, 'removed ' + when + ': still removed');
      assert.equal((await joinBySso({store: live.store, sourceIp: '127.0.0.1'}, sso, person)).active, false, 'and a later sign-in leaves it so');
    }
    // The owner replaces the IdP while a response signed by the old one is being processed: that response joins nobody.
    const late = (await live.store.getOrCreateSsoTenant('late@acme.example')).tenant_id; await ok(await post(live, owner, 'orgs/sso', settings(owner.tenant, {idp_cert: rogue.cert})));
    assert.deepEqual(await joinBySso({store: live.store, sourceIp: '127.0.0.1'}, sso, late), {created: false, active: false}); assert.equal(await memberRow(live, owner.tenant, late), null);
    assert.equal((await joinBySso({store: live.store, sourceIp: '127.0.0.1'}, await orgSso(live.store, owner.tenant), late)).created, true);
  } finally { await live.close(); }
});

test('an invitation issued earlier cannot undo a SCIM deactivation or an owner\'s removal of someone who joined by SSO', async () => {
  const {live, dns} = await world(); try {
    const owner = await account(live, 4242); await configured(live, dns, owner); const scim = scimCall(live, await scimToken(live, owner));
    const invite = async id => ok(await post(live, owner, 'workspaces/invite', {recipient_id: id, role: 'admin'}), 201), accept = who => post(live, who, 'workspaces/accept', {workspace_id: owner.tenant});
    const remove = async id => { const row = (await ok(await get(live, owner, 'workspaces/members'))).members.find(m => m.user_id === id); await ok(await post(live, owner, 'workspaces/member', {user_id: id, role: 'removed', version: row.version})); };
    // Invited as admin, joins by SSO instead (developer), is removed by the owner: the unused invitation is spent by the join.
    const bob = (await live.store.getOrCreateSsoTenant('bob@acme.example')).tenant_id; await invite(bob); const bobIn = await signInBySso(live, 'bob@acme.example');
    assert.equal((await memberRow(live, owner.tenant, bob)).role, 'developer'); await remove(bob); await refused(await accept(bobIn), 409, 'invitation_unavailable'); assert.equal((await memberRow(live, owner.tenant, bob)).active, false);
    // Invited, joins by SSO, then is deactivated by SCIM: the invitation goes with it. An active member cannot be invited again (#195).
    const cyId = (await live.store.getOrCreateSsoTenant('cy@acme.example')).tenant_id; await invite(cyId); const cy = await signInBySso(live, 'cy@acme.example'); await refused(await post(live, owner, 'workspaces/invite', {recipient_id: cy.tenant, role: 'admin'}), 409, 'already_a_member'); assert.equal((await scim('POST', '/Users', {userName: 'cy@acme.example', active: false})).status, 201);
    await refused(await accept(cy), 409, 'invitation_unavailable'); assert.equal((await memberRow(live, owner.tenant, cy.tenant)).active, false);
    // Never a member, invited, then created inactive by SCIM: the invitation cannot make them one.
    const di = await sessionFor(live, (await live.store.getOrCreateSsoTenant('di@acme.example')).tenant_id); await invite(di.tenant); assert.equal((await scim('POST', '/Users', {userName: 'di@acme.example', active: false})).status, 201);
    await refused(await accept(di), 409, 'invitation_unavailable'); assert.equal(await memberRow(live, owner.tenant, di.tenant), null);
    // Nothing to deactivate, and the invitation is accepted between SCIM's two reads: SCIM does not report success over a live membership.
    {
      const fay = await sessionFor(live, (await live.store.getOrCreateSsoTenant('fay@acme.example')).tenant_id), token = await scimToken(live, owner); assert.equal((await scimCall(live, token)('POST', '/Users', {userName: 'fay@acme.example'})).status, 201);
      const row = (await ok(await get(live, owner, 'workspaces/members'))).members.find(m => m.user_id === fay.tenant); await ok(await post(live, owner, 'workspaces/member', {user_id: fay.tenant, role: 'removed', version: row.version})); await invite(fay.tenant);
      const store = Object.create(live.store); let accepted = false; store._get = async key => { if (!accepted && key.sk === 'INVITE#' + fay.tenant) { accepted = true; await ok(await accept(fay)); } return live.store._get(key); };
      const overtaken = await direct(live, token, 'PUT', '/Users/' + fay.tenant, {active: false}, store); assert.equal(accepted, true); assert.equal(overtaken.status, 409, 'the deactivation that lost the race is refused, not reported as done');
      assert.equal((await scimCall(live, token)('PUT', '/Users/' + fay.tenant, {active: false})).status, 200); assert.equal((await memberRow(live, owner.tenant, fay.tenant)).active, false, 'and its retry deactivates the membership');
    }
    // The owner invites while a SCIM deactivation or an SSO join is between its read of the invitation and its write: the
    // change is refused, and its retry spends that invitation. It never completes with the invitation left usable.
    {
      const token = await scimToken(live, owner), hooked = id => { const store = Object.create(live.store); let invited = false; store._tx = async items => { if (!invited && items.some(item => (item.ConditionCheck?.Key ?? item.Put?.Item)?.sk === 'MEMBER#' + id)) { invited = true; await invite(id); } return live.store._tx(items); }; return {store, invited: () => invited}; };
      const hal = await sessionFor(live, (await live.store.getOrCreateSsoTenant('hal@acme.example')).tenant_id), racing = hooked(hal.tenant);
      const created = await direct(live, token, 'POST', '/Users', {userName: 'hal@acme.example', active: false}, racing.store); assert.equal(racing.invited(), true); assert.equal(created.status, 409, 'not reported as done');
      assert.equal((await scimCall(live, token)('PUT', '/Users/' + hal.tenant, {active: false})).status, 200); await refused(await accept(hal), 409, 'invitation_unavailable'); assert.equal(await memberRow(live, owner.tenant, hal.tenant), null);
      const ivy = await sessionFor(live, (await live.store.getOrCreateSsoTenant('ivy@acme.example')).tenant_id), join = hooked(ivy.tenant), sso = await orgSso(live.store, owner.tenant);
      assert.deepEqual(await joinBySso({store: join.store, sourceIp: '127.0.0.1'}, sso, ivy.tenant), {created: false, active: false}); assert.equal(join.invited(), true);
      assert.equal((await joinBySso({store: live.store, sourceIp: '127.0.0.1'}, sso, ivy.tenant)).created, true); await remove(ivy.tenant); await refused(await accept(ivy), 409, 'invitation_unavailable'); assert.equal((await memberRow(live, owner.tenant, ivy.tenant)).active, false);
    }
    // An invitation the owner sends afterwards is a new decision and works.
    await invite(di.tenant); await ok(await accept(di)); assert.equal((await memberRow(live, owner.tenant, di.tenant)).active, true);
  } finally { await live.close(); }
});

test('SCIM: a request authenticated before the token was replaced cannot write after it', async () => {
  const {live, dns} = await world(); try {
    const owner = await account(live, 4242); await configured(live, dns, owner); const token = await scimToken(live, owner), scim = scimCall(live, token);
    const made = await scim('POST', '/Users', {userName: 'eve@acme.example'}), eve = (await made.json()).id; assert.equal(made.status, 201);
    const rotateAt = (match) => { const store = Object.create(live.store); let rotated = null; store._tx = async items => { if (!rotated && items.some(match)) rotated = await scimToken(live, owner); return live.store._tx(items); }; return {store, rotated: () => rotated}; };
    // Create: the token is replaced just before the slot reservation, the record write, or the membership write.
    for (const [name, match] of [['slot', item => item.Put?.Item?.sk?.startsWith('SCIMSLOT#')], ['record', item => item.Put?.Item?.sk?.startsWith('SCIMUSER#')], ['membership', item => item.Put?.Item?.sk?.startsWith('MEMBER#')]]) {
      const email = name + '@acme.example', id = 'sso-' + digest(email), hooked = rotateAt(match), response = await direct(live, (await live.store._get({pk: 'TENANT#' + owner.tenant, sk: 'SSO#CONFIG'})).scim_token_hash && token, 'POST', '/Users', {userName: email}, hooked.store);
      assert.ok(hooked.rotated(), name); assert.ok([401, 409].includes(response.status), name + ' ' + response.status); assert.notEqual((await memberRow(live, owner.tenant, id))?.active, true, name + ': no membership from the replaced token');
      // Later requests in this loop use the token that replaced it.
      await ok(await post(live, owner, 'orgs/sso/scim-token', {organization_id: owner.tenant, token_hash: digest(token)}), 201);
    }
    // Deactivate and delete: the replaced token changes nothing.
    for (const [method, body] of [['PUT', {active: false}], ['DELETE', null]]) {
      const hooked = rotateAt(item => item.Put?.Item?.sk === 'SCIMUSER#' + eve), response = await direct(live, token, method, '/Users/' + eve, body, hooked.store);
      assert.ok(hooked.rotated()); assert.equal(response.status, 409, method); assert.equal((await memberRow(live, owner.tenant, eve)).active, true); assert.equal((await live.store._get({pk: 'TENANT#' + owner.tenant, sk: 'SCIMUSER#' + eve})).active, true);
      await ok(await post(live, owner, 'orgs/sso/scim-token', {organization_id: owner.tenant, token_hash: digest(token)}), 201);
    }
  } finally { await live.close(); }
});

test('in a personal organization neither sign-in nor SCIM makes a membership row for the owner', async () => {
  const {live, dns} = await world(); try {
    // The owner's own account is an SSO account in the domain the organization verifies.
    const root = await sessionFor(live, (await live.store.getOrCreateSsoTenant('root@acme.example')).tenant_id); await configured(live, dns, root);
    const before = (await live.store._get({pk: 'TENANT#' + root.tenant, sk: 'WORKSPACE#META'})).members;
    const signedIn = await signInBySso(live, 'root@acme.example'); assert.equal(signedIn.tenant, root.tenant); assert.equal((await get(live, signedIn, 'runs')).status, 200);
    const scim = scimCall(live, await scimToken(live, root)); assert.equal((await scim('POST', '/Users', {userName: 'root@acme.example'})).status, 201);
    assert.equal(await memberRow(live, root.tenant, root.tenant), null); assert.equal((await live.store._get({pk: 'TENANT#' + root.tenant, sk: 'WORKSPACE#META'})).members, before);
    assert.equal((await scim('PUT', '/Users/' + root.tenant, {active: false})).status, 409); assert.equal((await scim('DELETE', '/Users/' + root.tenant)).status, 409);
    const record = await live.store._get({pk: 'TENANT#' + root.tenant, sk: 'SCIMUSER#' + root.tenant}); assert.deepEqual([record.active, record.deleted], [true, undefined], 'a refused request leaves the SCIM record as it was');
    assert.equal((await get(live, signedIn, 'workspaces/members')).status, 200, 'the owner is still the owner');
  } finally { await live.close(); }
});

test('SCIM: activating a stored user needs the same verified domain as creating one', async () => {
  const {live, dns, env} = await world(); try {
    const owner = await account(live, 4242); await configured(live, dns, owner); const scim = scimCall(live, await scimToken(live, owner));
    const made = await scim('POST', '/Users', {userName: 'gil@acme.example', active: false}), gil = (await made.json()).id; assert.equal(made.status, 201);
    const patch = active => scim('PATCH', '/Users/' + gil, {Operations: [{op: 'replace', path: 'active', value: active}]});
    // The operator lists the domain for the deployment's IdP: the organization's token can no longer activate the user, by PUT or PATCH.
    env.SSO_EMAIL_DOMAINS = 'acme.example';
    assert.equal((await scim('PUT', '/Users/' + gil, {active: true})).status, 400); assert.equal((await patch(true)).status, 400); assert.equal(await memberRow(live, owner.tenant, gil), null);
    assert.equal((await live.store._get({pk: 'TENANT#' + owner.tenant, sk: 'SCIMUSER#' + gil})).active, false, 'the record is unchanged'); assert.equal((await patch(false)).status, 200, 'deactivating still works');
    delete env.SSO_EMAIL_DOMAINS;
    // The owner removes the domain from the organization: same refusal. With the domain back and verified, activation works.
    await ok(await post(live, owner, 'orgs/sso', settings(owner.tenant, {domains: []}))); assert.equal((await scim('PUT', '/Users/' + gil, {active: true})).status, 400); assert.equal(await memberRow(live, owner.tenant, gil), null);
    const back = (await ok(await post(live, owner, 'orgs/sso', settings(owner.tenant)))).domains[0].record; dns.set(back.name, back.value); assert.equal((await scim('PUT', '/Users/' + gil, {active: true})).status, 400, 'listed again but not yet verified');
    await ok(await post(live, owner, 'orgs/sso/verify', {organization_id: owner.tenant, domain: 'acme.example'})); assert.equal((await scim('PUT', '/Users/' + gil, {active: true})).status, 200); assert.equal((await memberRow(live, owner.tenant, gil)).active, true);
    assert.equal((await scim('DELETE', '/Users/' + gil)).status, 204);
  } finally { await live.close(); }
});

test('SSO settings with an issuer or domain list longer than an audit detail are saved, and the event records them shortened (#216)', async () => {
  const {live} = await world(); try {
    const owner = await account(live, 4242); await ok(await post(live, owner, 'workspaces', {name: 'Acme'}), 201);
    const issuer = 'https://idp.acme.example/' + 'a'.repeat(900), domains = [1, 2, 3, 4, 5].map(n => 'sso-' + n + '-' + 'x'.repeat(40) + '.acme.example');
    const saved = await ok(await post(live, owner, 'orgs/sso', settings(owner.tenant, {idp_issuer: issuer, domains})));
    assert.equal(saved.idp_issuer, issuer, 'the setting itself is stored in full'); assert.equal(saved.domains.length, 5);
    const event = (await ok(await get(live, owner, 'audit'))).events.find(item => item.action === 'sso.config_changed');
    assert.equal(event.detail.issuer.length, 160); assert.ok(event.detail.issuer.endsWith('…') && issuer.startsWith(event.detail.issuer.slice(0, -1)));
    assert.equal(event.detail.domains.length, 160);
  } finally { await live.close(); }
});

test('sso_saml and scim follow the plan: on a plan without them SSO sign-in is not offered, the IdP is not trusted, SCIM answers 403 and "require SSO" stops applying; Enterprise brings them back', async () => {
  const {live, dns} = await world(); try {
    const owner = await account(live, 4242); await configured(live, dns, owner); const scim = scimCall(live, await scimToken(live, owner));
    const member = await signInBySso(live, 'bob@acme.example');
    assert.equal((await scim('GET', '/Users')).status, 200);
    await ok(await post(live, owner, 'orgs/sso/enforce', {organization_id: owner.tenant, enforce: true}));
    const plan = value => { live.store.client.items.get('TENANT#' + owner.tenant + '\0META').plan_id = value; };
    // Downgrade to Pro: neither feature.
    plan('pro');
    const flow = await begin(live, 'carol@acme.example'); assert.notEqual(flow.response.status, 200, 'SSO sign-in is not offered for the domain');
    // SCIM off-plan gives no access but still takes it away: provisioning and reactivation are refused, reads and deprovisioning work.
    const off = await scim('POST', '/Users', {schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'dan@acme.example', active: true}); assert.equal(off.status, 403); assert.match((await off.json()).detail, /not included in this organization's plan/);
    assert.equal(await memberRow(live, owner.tenant, 'sso-' + digest('dan@acme.example')), null, 'nobody was provisioned');
    assert.equal((await scim('GET', '/Users')).status, 200);
    // The identity provider deprovisions an employee who left: it must work, or they keep access after the downgrade.
    plan('enterprise'); assert.equal((await scim('POST', '/Users', {schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'bob@acme.example', active: true})).status, 201); plan('pro');
    assert.equal((await memberRow(live, owner.tenant, member.tenant)).active, true);
    // Nothing is created off-plan, whatever `active` says: no member, no inactive record, no account.
    for (const active of [undefined, true, false]) assert.equal((await scim('POST', '/Users', {schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'eve' + String(active) + '@acme.example', ...(active === undefined ? {} : {active})})).status, 403, 'POST active=' + active);
    assert.equal((await live.store.getTenant('sso-' + digest('evefalse@acme.example'))) ?? null, null, 'no account was made');
    assert.equal((await scim('PATCH', '/Users/' + member.tenant, {Operations: [{op: 'replace', path: 'active', value: false}]})).status, 200);
    assert.equal((await memberRow(live, owner.tenant, member.tenant)).active, false, 'the departed employee is no longer a member');
    // Reactivating the deactivated user is provisioning: refused by PUT and by PATCH, and the membership stays inactive.
    assert.equal((await scim('PUT', '/Users/' + member.tenant, {active: true})).status, 403);
    assert.equal((await scim('PATCH', '/Users/' + member.tenant, {Operations: [{op: 'replace', path: 'active', value: true}]})).status, 403);
    assert.equal((await scim('PATCH', '/Users/' + member.tenant, {Operations: [{op: 'replace', value: {active: 'True'}}]})).status, 403);
    assert.equal((await memberRow(live, owner.tenant, member.tenant)).active, false);
    assert.equal((await scim('DELETE', '/Users/' + member.tenant)).status, 204);
    // "Require SSO" is not applied off-plan, so an existing member is not locked out of the data by a rule they can no longer satisfy.
    let cookie = ''; await live.signIn({addCookies: async value => { cookie = value.map(c => c.name + '=' + c.value).join('; '); }}, 5252);
    const invited = {tenant: 'github-5252', cookie}; const invite = await ok(await post(live, owner, 'workspaces/invite', {recipient_id: invited.tenant, role: 'admin'}), 201); await ok(await post(live, invited, 'workspaces/accept', {workspace_id: owner.tenant, token: invite.token}));
    assert.equal((await get(live, invited, 'runs?workspace=' + owner.tenant)).status, 200);
    // Settings can be read and the rule cleared, nothing else.
    assert.equal((await get(live, owner, 'orgs/sso')).status, 200);
    await refused(await post(live, owner, 'orgs/sso/verify', {organization_id: owner.tenant, domain: 'acme.example'}), 402, 'plan_upgrade_required');
    // Back on Enterprise everything works again with the stored settings, and the rule applies again.
    plan('enterprise');
    assert.equal((await begin(live, 'carol@acme.example')).response.status, 200); assert.equal((await scim('GET', '/Users')).status, 200);
    await refused(await get(live, invited, 'runs?workspace=' + owner.tenant), 403, 'sso_required');
    assert.equal((await get(live, member, 'runs?workspace=' + owner.tenant)).status, 403, 'the deprovisioned member stays out');
  } finally { await live.close(); }
});

test('deleting an organization with SSO releases its verified domain, kills its SCIM token and ends its SSO sign-in; an in-flight provision joins nobody', async () => {
  const {live, dns} = await world(); try {
    const owner = await account(live, 4242), org = (await ok(await post(live, owner, 'orgs', {name: 'Acme Org'}), 201)).id;
    await configured(live, dns, owner, org); const token = await (async () => { const value = 'stscim_' + randomBytes(32).toString('base64url'); await ok(await post(live, owner, 'orgs/sso/scim-token', {organization_id: org, token_hash: digest(value)}), 201); return value; })(), scim = scimCall(live, token);
    assert.equal((await scim('GET', '/Users')).status, 200); assert.equal((await begin(live, 'bob@acme.example')).response.status, 200);
    assert.equal((await live.store._get({pk: 'SSODOMAIN#acme.example', sk: 'ORG'})).org, org);
    // A sign-in that started before the deletion and finishes after it.
    const flow = await begin(live, 'late@acme.example');
    assert.deepEqual(await ok(await post(live, owner, 'orgs/delete', {organization_id: org, confirm: 'Acme Org'})), {deleted: true, id: org});
    assert.equal(await live.store._get({pk: 'SSODOMAIN#acme.example', sk: 'ORG'}) ?? null, null, 'the domain claim is released');
    assert.equal(await live.store._get({pk: 'SCIM#' + digest(token), sk: 'TOKEN'}) ?? null, null, 'the SCIM token index is gone');
    assert.equal((await scim('GET', '/Users')).status, 401);
    assert.equal((await scim('POST', '/Users', {schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'new@acme.example', active: true})).status, 401);
    assert.notEqual((await begin(live, 'bob@acme.example')).response.status, 200, 'SSO sign-in is no longer offered for the domain');
    const done = await finish(live, flow, assertion(flow, 'late@acme.example')); assert.notEqual(done.status, 302, 'the sign-in in flight does not complete');
    assert.equal(await memberRow(live, org, 'sso-' + digest('late@acme.example')) ?? null, null, 'and joins nobody');
    // Another organization can now claim and verify the same domain.
    const next = (await ok(await post(live, owner, 'orgs', {name: 'Acme Two'}), 201)).id; const again = await configured(live, dns, owner, next);
    assert.equal(again.domains[0].verified, true); assert.equal((await live.store._get({pk: 'SSODOMAIN#acme.example', sk: 'ORG'})).org, next);
  } finally { await live.close(); }
});
