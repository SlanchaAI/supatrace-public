// Roles, environment limits and the organization two-factor rule (#129), against the real handler.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {start as startHarness} from './harness.mjs';
// These tests exercise paid features, so every fixture organization is on Enterprise. tests/entitlements.test.mjs covers the gates.
const start = (options = {}) => startHarness({plan: 'enterprise', ...options});
import {digest} from '../src/aws-auth.mjs';
import {totp} from '../src/dashboard-auth.mjs';
import {ROUTES, routeRule, can, authorizeRoute, MEMBER_ROLES} from '../src/roles.mjs';

async function account(live, id) { let cookie = ''; const tenant = await live.signIn({addCookies: async value => { cookie = value.map(c => c.name + '=' + c.value).join('; '); }}, id); return {tenant, cookie}; }
const call = (live, who, method, path, data) => fetch(live.origin + path, {method, headers: {cookie: who.cookie, origin: live.origin, ...(method === 'POST' ? {'content-type': 'application/json'} : {})}, ...(method === 'POST' ? {body: JSON.stringify(data ?? {})} : {})});
const post = (live, who, path, data) => call(live, who, 'POST', '/api/' + path, data), get = (live, who, path) => call(live, who, 'GET', '/api/' + path);
const ok = async (response, status = 200) => { assert.equal(response.status, status, await response.clone().text()); return response.json(); };
const refused = async (response, status, code) => { assert.equal(response.status, status, await response.clone().text()); assert.equal((await response.json()).error, code); };
async function join(live, owner, member, org, role, environments) { const invite = await ok(await post(live, owner, 'workspaces/invite?workspace=' + org, {recipient_id: member.tenant, role, ...(environments ? {environments} : {})}), 201); await ok(await post(live, member, 'workspaces/accept', {workspace_id: org, token: invite.token})); return invite; }
const version = async (live, owner, org, id) => (await ok(await get(live, owner, 'workspaces/members?workspace=' + org))).members.find(m => m.user_id === id).version;
async function team(live) {
  const owner = await account(live, 4242), people = {owner, admin: await account(live, 5252), developer: await account(live, 6262), viewer: await account(live, 7272), outsider: await account(live, 8282)};
  await ok(await post(live, owner, 'workspaces', {name: 'Team'}), 201);
  for (const role of MEMBER_ROLES) await join(live, owner, people[role], owner.tenant, role);
  return people;
}

// One probe per route in the table: a request that reaches the handler when the role is allowed.
const PROBES = {
  'GET /api/support': {}, 'POST /api/support': {body: {}},
  'POST /api/projects': {body: {name: ''}}, 'POST /api/projects/rename': {body: {id: 'invalid', name: ''}}, 'POST /api/projects/delete': {body: {id: 'invalid', confirm: 'wrong'}},
  'GET /api/workspace': {}, 'GET /api/entitlements': {}, 'GET /api/usage': {}, 'GET /api/imports/capabilities': {}, 'GET /api/integrations': {}, 'GET /api/runs': {}, 'GET /api/runs/page': {}, 'GET /api/events': {query: '&run=r1'}, 'GET /api/logs': {},
  'POST /api/audit/events': {body: {action: 'export.started', kind: 'account'}}, 'GET /api/keys': {}, 'POST /api/setup/approve': {body: {user_code: 'AAAAAAAAAAAA'}},
  'POST /api/keys/create': {body: {key_hash: 'not-a-hash', key_type: 'publishable'}}, 'POST /api/keys/rotate': {body: {id: 'a'.repeat(64), key_hash: 'b'.repeat(64)}}, 'POST /api/keys/revoke': {body: {id: 'a'.repeat(64)}},
  'GET /api/environments': {}, 'POST /api/environments': {body: {id: 'default', name: 'x'}}, 'POST /api/environments/rename': {body: {id: 'default', name: 'x'}}, 'POST /api/environments/delete': {body: {id: 'default', confirm: 'default'}},
  'GET /api/drains*': {path: '/api/drains'}, 'POST /api/drains*': {path: '/api/drains', body: {}},
  'GET /api/workspaces/members': {}, 'POST /api/workspaces/invite': {body: {recipient_id: 'github-999999', role: 'viewer'}}, 'POST /api/workspaces/member': {body: {user_id: 'github-999999', role: 'viewer', version: 0}},
  'GET /api/audit': {}, 'GET /api/audit/export': {}, 'GET /api/billing/*': {path: '/api/billing/status'}, 'POST /api/billing/*': {path: '/api/billing/spend-cap', body: {enabled: 'no'}},
  'GET /api/imports/*': {path: '/api/imports/jobs'}, 'POST /api/imports/*': {path: '/api/imports/plan', body: {}},
  'GET /api/orgs/sso/*': {path: '/api/orgs/sso'}, 'POST /api/orgs/sso/*': {path: '/api/orgs/sso/enforce', body: {enforce: 'yes'}, org: true},
  'GET /api/orgs/roles/*': {path: '/api/orgs/roles'}, 'POST /api/orgs/roles/*': {path: '/api/orgs/roles', body: {name: '', base: 'x', environments: null}, org: true},
  'POST /api/orgs/delete': {body: {confirm: 7}, org: true}, 'POST /api/orgs/rename': {body: {name: ''}, org: true}, 'POST /api/orgs/transfer': {body: {user_id: 'github-999999', version: 0}, org: true}, 'POST /api/orgs/security': {body: {require_mfa: 'yes'}, org: true},
};

test('authorization matrix: every role against every route in the table', async () => {
  const live = await start(); try {
    const people = await team(live), org = people.owner.tenant, seen = [];
    assert.deepEqual(Object.keys(PROBES).sort(), ROUTES.map(([method, path]) => method + ' ' + path).sort(), 'one probe per table row');
    for (const [method, pattern, capability] of ROUTES) {
      const probe = PROBES[method + ' ' + pattern], path = probe.path ?? pattern;
      for (const role of ['owner', 'admin', 'developer', 'viewer', 'outsider']) {
        const body = probe.org ? {organization_id: org, ...probe.body} : probe.body, response = await call(live, people[role], method, path + '?workspace=' + org + (probe.query ?? ''), body), allowed = role !== 'outsider' && can(role, capability);
        const error = response.status >= 400 ? (await response.clone().json().catch(() => ({}))).error : null; seen.push([method, pattern, role, response.status, error]);
        const label = `${method} ${path} as ${role}: ${response.status} ${error}`;
        if (role === 'outsider') { assert.equal(response.status, 403, label); assert.equal(error, 'workspace_unavailable', label); }
        else if (allowed) assert.ok(response.status !== 401 && !['workspace_owner_required', 'workspace_admin_required', 'workspace_unavailable', 'environment_unavailable'].includes(error), label);
        else { assert.equal(response.status, 403, label); assert.equal(error, capability === 'owner' ? 'workspace_owner_required' : 'workspace_admin_required', label); }
      }
    }
    // What the table means per role, spelled out so a change to it is visible in review.
    const reach = role => ROUTES.filter(([, , capability]) => can(role, capability)).length;
    assert.deepEqual([reach('owner'), reach('admin'), reach('developer'), reach('viewer')], [43, 26, 18, 13]);
    assert.equal(seen.length, ROUTES.length * 5);
  } finally { await live.close(); }
});

test('every route the handler serves after sign-in is in the role table or is an account route', () => {
  const api = readFileSync(new URL('../src/aws-api.mjs', import.meta.url), 'utf8'), spaces = readFileSync(new URL('../src/workspaces.mjs', import.meta.url), 'utf8');
  const signedIn = api.slice(api.indexOf('const actor=token?')), routed = spaces.slice(spaces.indexOf('export async function workspaceApi'));
  // Routes that act on the caller's own account or list/create what the caller owns: no organization role applies.
  const account = new Set(['/api/account/delete', '/api/auth', '/api/me', '/api/tokens', '/api/tokens/revoke', '/api/projects', '/api/workspaces', '/api/workspaces/invitations', '/api/workspaces/accept', '/api/orgs', '/api/orgs/leave', '/api/auth/logout', '/api/auth/mfa/enroll', '/api/auth/mfa/confirm', '/api/auth/mfa/disable']);
  const literals = new Set([...signedIn.matchAll(/'(\/api\/[a-z0-9/-]+)'/g), ...routed.matchAll(/'(\/api\/[a-z0-9/-]+)'/g)].map(match => match[1].replace(/\/$/, '')));
  assert.ok(literals.size > 30, 'the scan found the handler routes');
  for (const path of literals) {
    // The handler treats /api/me and everything under /api/auth/ as the caller's own account (its `security` paths): no organization role applies.
    if (account.has(path) || path.startsWith('/api/auth/')) continue;
    const listed = ['GET', 'POST'].some(method => ROUTES.some(([verb, pattern]) => verb === method && (pattern.endsWith('*') ? path === pattern.slice(0, -2) || path.startsWith(pattern.slice(0, -1)) || pattern.startsWith(path) : pattern === path)));
    assert.ok(listed, path + ' is served after sign-in but has no row in src/roles.mjs');
  }
  // An unlisted route is the owner's.
  assert.deepEqual(routeRule('POST', '/api/something-new'), {capability: 'owner', scoped: false, whole: false});
  assert.throws(() => authorizeRoute({role: 'admin', environments: null}, 'POST', '/api/something-new'), {code: 'workspace_owner_required'});
});

test('developer: keys and traces, nothing else; a key a developer issues works and dies with the role', async () => {
  const live = await start(); try {
    const people = await team(live), org = people.owner.tenant, dev = people.developer, scope = '?workspace=' + org;
    const key = randomBytes(32).toString('base64url'), setup = await live.store.createSetup(digest(key));
    await ok(await post(live, dev, 'setup/approve' + scope, {user_code: setup.user_code}));
    const upload = async () => { const raw = JSON.stringify({version: 1, batch_id: 'b' + randomBytes(4).toString('hex'), run_id: 'dev-run', events: [{id: 'e', time: '2026-11-05T00:00:00Z', kind: 'note', name: 'n', data: {}}]}); return (await fetch(live.origin + '/api/batches', {method: 'POST', headers: {'content-type': 'application/json', 'x-supatrace-key': key, 'x-amz-content-sha256': digest(raw)}, body: raw})).status; };
    assert.equal(await upload(), 201); assert.equal((await ok(await get(live, dev, 'runs' + scope))).runs.length, 1); assert.equal((await ok(await get(live, dev, 'keys' + scope))).keys.length, 1);
    await refused(await post(live, dev, 'environments' + scope, {id: 'dev', name: 'Dev'}), 403, 'workspace_admin_required');
    await refused(await get(live, dev, 'drains' + scope), 403, 'workspace_admin_required');
    await refused(await get(live, dev, 'workspaces/members' + scope), 403, 'workspace_owner_required');
    await refused(await get(live, dev, 'billing/status' + scope), 403, 'workspace_owner_required');
    await refused(await get(live, dev, 'audit' + scope), 403, 'workspace_owner_required');
    // Read-only: the same reads, no key routes at all.
    assert.equal((await ok(await get(live, people.viewer, 'runs' + scope))).runs.length, 1);
    await refused(await get(live, people.viewer, 'keys' + scope), 403, 'workspace_admin_required');
    await refused(await post(live, people.viewer, 'keys/create' + scope, {key_hash: 'a'.repeat(64), key_type: 'publishable'}), 403, 'workspace_admin_required');
    // Demoting the developer to read-only ends the key they issued.
    await ok(await post(live, people.owner, 'workspaces/member', {user_id: dev.tenant, role: 'viewer', version: await version(live, people.owner, org, dev.tenant)}));
    assert.equal(await upload(), 401);
    for (const role of ['owner', 'removed-ish', 'superadmin']) assert.equal((await post(live, people.owner, 'workspaces/invite', {recipient_id: people.outsider.tenant, role})).status, 400, role);
  } finally { await live.close(); }
});

test('a member limited to listed environments reads and writes only there', async () => {
  const live = await start(); try {
    const owner = await account(live, 4242), member = await account(live, 5252), org = owner.tenant, scope = '?workspace=' + org;
    await ok(await post(live, owner, 'workspaces', {name: 'Team'}), 201);
    for (const id of ['dev', 'staging']) await ok(await post(live, owner, 'environments', {id, name: id}), 201);
    for (const bad of [['nope'], [], ['dev', 'dev'], 'dev', [42]]) assert.equal((await post(live, owner, 'workspaces/invite', {recipient_id: member.tenant, role: 'admin', environments: bad})).status, 400, JSON.stringify(bad));
    const invite = await join(live, owner, member, org, 'admin', ['dev']); assert.deepEqual(invite.environments, ['dev']);
    assert.deepEqual((await ok(await get(live, owner, 'workspaces/members'))).members.find(m => m.user_id === member.tenant).environments, ['dev']);
    assert.deepEqual((await ok(await get(live, member, 'orgs'))).organizations.find(o => o.id === org).environments, ['dev']);
    // Reads and key work: dev only.
    assert.deepEqual((await ok(await get(live, member, 'environments' + scope))).environments.map(e => e.id), ['dev']);
    assert.equal((await get(live, member, 'runs' + scope + '&environment=dev')).status, 200);
    for (const environment of ['default', 'staging']) for (const path of ['runs', 'runs/page', 'keys', 'events']) await refused(await get(live, member, path + scope + '&environment=' + environment + (path === 'events' ? '&run=r' : '')), 403, 'environment_unavailable');
    const key = randomBytes(32).toString('base64url'), blocked = await live.store.createSetup(digest(key)), setup = await live.store.createSetup(digest(key), null, 'dev');
    await refused(await post(live, member, 'setup/approve' + scope, {user_code: blocked.user_code}), 403, 'environment_unavailable');
    await ok(await post(live, member, 'setup/approve' + scope + '&environment=dev', {user_code: setup.user_code}));
    const upload = async () => { const raw = JSON.stringify({version: 1, batch_id: 'b' + randomBytes(4).toString('hex'), run_id: 'scoped', events: [{id: 'e', time: '2026-11-05T00:00:00Z', kind: 'note', name: 'n', data: {}}]}); return (await fetch(live.origin + '/api/batches?environment=dev', {method: 'POST', headers: {'content-type': 'application/json', 'x-supatrace-key': key, 'x-amz-content-sha256': digest(raw)}, body: raw})).status; };
    assert.equal(await upload(), 201);
    // Organization-wide actions are refused even for an admin when the admin is limited.
    await refused(await post(live, member, 'environments' + scope, {id: 'mine', name: 'Mine'}), 403, 'workspace_admin_required');
    await refused(await get(live, member, 'drains' + scope), 403, 'workspace_admin_required');
    assert.equal((await get(live, member, 'usage' + scope)).status, 200, 'organization usage stays readable');
    // The owner moves the limit: the old environment closes, the key issued there stops, and the change is in the audit log once.
    await ok(await post(live, owner, 'workspaces/member', {user_id: member.tenant, role: 'admin', version: await version(live, owner, org, member.tenant), environments: ['staging']}));
    await refused(await get(live, member, 'runs' + scope + '&environment=dev'), 403, 'environment_unavailable'); assert.equal((await get(live, member, 'runs' + scope + '&environment=staging')).status, 200); assert.equal(await upload(), 401);
    await refused(await post(live, owner, 'workspaces/member', {user_id: member.tenant, role: 'admin', version: await version(live, owner, org, member.tenant), environments: ['staging']}), 409, 'workspace_changed');
    await ok(await post(live, owner, 'workspaces/member', {user_id: member.tenant, role: 'admin', version: await version(live, owner, org, member.tenant), environments: null}));
    assert.equal((await get(live, member, 'runs' + scope)).status, 200); assert.equal((await get(live, member, 'drains' + scope)).status, 200);
    const changes = (await ok(await get(live, owner, 'audit?action=member.scope_change'))).events.map(e => [e.target, e.detail.from, e.detail.to]);
    assert.deepEqual(changes, [[member.tenant, 'staging', 'all'], [member.tenant, 'dev', 'staging']]);
  } finally { await live.close(); }
});

test('require two-factor authentication: enforced on every use of the organization, only while the deployment has it enabled', async () => {
  const live = await start({mfa: true}); try {
    const owner = await account(live, 4242), member = await account(live, 5252), org = owner.tenant, scope = '?workspace=' + org;
    await ok(await post(live, owner, 'workspaces', {name: 'Team'}), 201); await join(live, owner, member, org, 'admin');
    const enroll = async who => { const secret = (await ok(await post(live, who, 'auth/mfa/enroll', {}))).secret; await ok(await post(live, who, 'auth/mfa/confirm', {code: totp(secret)})); return secret; };
    // Only the owner sets it, and only once the owner has two-factor authentication.
    await refused(await post(live, member, 'orgs/security', {organization_id: org, require_mfa: true}), 403, 'workspace_owner_required');
    await refused(await post(live, owner, 'orgs/security', {organization_id: org, require_mfa: true}), 409, 'mfa_enrollment_required');
    assert.equal((await post(live, owner, 'orgs/security', {organization_id: org, require_mfa: 'true'})).status, 400);
    const secret = await enroll(owner);
    assert.deepEqual(await ok(await post(live, owner, 'orgs/security', {organization_id: org, require_mfa: true})), {organization_id: org, require_mfa: true});
    assert.deepEqual(await ok(await post(live, owner, 'orgs/security', {organization_id: org, require_mfa: true})), {organization_id: org, require_mfa: true});
    // The member without it is refused on every organization route, and told so in the organization list.
    for (const path of ['runs', 'usage', 'workspace', 'keys', 'environments', 'drains']) await refused(await get(live, member, path + scope), 403, 'mfa_enrollment_required');
    await refused(await post(live, member, 'environments' + scope, {id: 'dev', name: 'Dev'}), 403, 'mfa_enrollment_required');
    await refused(await post(live, member, 'audit/events' + scope, {action: 'export.started', kind: 'account'}), 403, 'mfa_enrollment_required');
    const listed = (await ok(await get(live, member, 'orgs'))).organizations.find(o => o.id === org); assert.deepEqual([listed.require_mfa, listed.mfa_required], [true, true]);
    assert.equal((await ok(await get(live, member, 'projects'))).projects.find(p => p.workspace_id === org).mfa_required, true);
    // Their own account and personal organization stay open, so they can enroll.
    assert.equal((await get(live, member, 'me')).status, 200); assert.equal((await get(live, member, 'runs')).status, 200);
    assert.equal((await get(live, owner, 'runs')).status, 200, 'the enrolled owner is not affected');
    await enroll(member);
    for (const path of ['runs', 'usage', 'keys', 'environments']) assert.equal((await get(live, member, path + scope)).status, 200, path);
    assert.equal((await ok(await get(live, member, 'orgs'))).organizations.find(o => o.id === org).mfa_required, false);
    // The owner cannot turn their own two-factor authentication off while their organization requires it: lift the rule first.
    await refused(await post(live, owner, 'auth/mfa/disable', {code: totp(secret)}), 409, 'mfa_required_by_organization'); assert.equal((await get(live, owner, 'runs')).status, 200);
    // If an owner's account loses it anyway, the rule holds for them too, and they cannot lift it until they meet it.
    await live.store.setTenantFields(owner.tenant, 'SET mfa_secret = :empty', {':empty': ''});
    await refused(await get(live, owner, 'runs'), 403, 'mfa_enrollment_required'); await refused(await post(live, owner, 'orgs/security', {organization_id: org, require_mfa: false}), 403, 'mfa_enrollment_required');
    assert.equal((await get(live, owner, 'me')).status, 200); await enroll(owner); assert.equal((await get(live, owner, 'runs')).status, 200);
    assert.deepEqual(await ok(await post(live, owner, 'orgs/security', {organization_id: org, require_mfa: false})), {organization_id: org, require_mfa: false});
    assert.deepEqual((await ok(await get(live, owner, 'audit?action=settings.require_mfa_changed'))).events.map(e => e.detail.enabled), [false, true]);
  } finally { await live.close(); }
});

test('the two-factor rule cannot be turned on, and is not applied, where the deployment has two-factor authentication off', async () => {
  const live = await start(); try {
    const owner = await account(live, 4242), member = await account(live, 5252), org = owner.tenant;
    await ok(await post(live, owner, 'workspaces', {name: 'Team'}), 201); await join(live, owner, member, org, 'viewer');
    await refused(await post(live, owner, 'orgs/security', {organization_id: org, require_mfa: true}), 409, 'mfa_unavailable');
    // A rule saved while it was on stays stored but cannot be met by anyone, so it is not applied.
    const key = {pk: 'TENANT#' + org, sk: 'WORKSPACE#META'}; await live.store._tx([{Update: {Key: key, UpdateExpression: 'SET require_mfa = :on', ExpressionAttributeValues: {':on': true}}}]);
    assert.equal((await get(live, member, 'runs?workspace=' + org)).status, 200);
    const listed = (await ok(await get(live, member, 'orgs'))).organizations.find(o => o.id === org); assert.deepEqual([listed.require_mfa, listed.mfa_required], [true, false]);
    const solo = await account(live, 6262); await refused(await post(live, solo, 'orgs/security', {organization_id: solo.tenant, require_mfa: false}), 409, 'workspace_not_shared');
  } finally { await live.close(); }
});
