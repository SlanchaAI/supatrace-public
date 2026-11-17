// Organizations above projects (#117), against the real handler and store logic (in-memory DynamoDB adapter).
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {start as startHarness} from './harness.mjs';
import {paidOverageFixture} from './overage-fixture.mjs';
// These tests exercise paid features, so every fixture organization is on Enterprise. tests/entitlements.test.mjs covers the gates.
const start = (options = {}) => startHarness({plan: 'enterprise', ...options});
import {digest} from '../src/aws-auth.mjs';
import {alphaProject, isOrganizationId} from '../src/alpha-projects.mjs';
import {ORGANIZATION_LIMIT, Workspaces, workspaceSession, environmentStore} from '../src/workspaces.mjs';

async function account(live, id) { let cookie = ''; const tenant = await live.signIn({addCookies: async value => { cookie = value.map(c => c.name + '=' + c.value).join('; '); }}, id); return {tenant, cookie}; }
const post = (live, who, path, data) => fetch(live.origin + '/api/' + path, {method: 'POST', headers: {cookie: who.cookie, origin: live.origin, 'content-type': 'application/json'}, body: JSON.stringify(data)});
const get = (live, who, path) => fetch(live.origin + '/api/' + path, {headers: {cookie: who.cookie}});
const ok = async (response, status = 200) => { assert.equal(response.status, status, await response.clone().text()); return response.json(); };
const refused = async (response, status, code) => { assert.equal(response.status, status, await response.clone().text()); assert.equal((await response.json()).error, code); };
const orgs = async (live, who) => (await ok(await get(live, who, 'orgs'))).organizations;
async function join(live, owner, member, org, role = 'viewer') { const invite = await ok(await post(live, owner, 'workspaces/invite?workspace=' + org, {recipient_id: member.tenant, role}), 201); await ok(await post(live, member, 'workspaces/accept', {workspace_id: org, token: invite.token})); }
async function uploadTo(live, who, org, run) {
  const key = randomBytes(32).toString('base64url'), setup = await live.store.createSetup(digest(key));
  await ok(await post(live, who, 'setup/approve?workspace=' + org, {user_code: setup.user_code}));
  const raw = JSON.stringify({version: 1, batch_id: run, run_id: run, events: [{id: 'e', time: '2026-11-05T00:00:00Z', kind: 'note', name: 'n', data: {}}]});
  const response = await fetch(live.origin + '/api/batches', {method: 'POST', headers: {'content-type': 'application/json', 'x-supatrace-key': key, 'x-amz-content-sha256': digest(raw)}, body: raw});
  assert.equal(response.status, 201, await response.clone().text());
}
const runIds = async (live, who, org) => (await ok(await get(live, who, 'runs?workspace=' + org))).runs.map(run => run.id).sort();
// Fields added by #129: no environment limit, no two-factor rule.
const OPEN = {environments: null, require_mfa: false, mfa_required: false, sso_required: false};
const snapshot = live => JSON.stringify([...live.store.client.items.entries()].filter(([key]) => !key.startsWith('RATE#')).sort());

test('migration: every existing account-owned workspace is already a personal organization, with no write and unchanged access', async () => {
  const live = await start(); try {
    const owner = await account(live, 4242), member = await account(live, 5252), solo = await account(live, 6262);
    await ok(await post(live, owner, 'workspaces', {name: 'Product team'}), 201); await join(live, owner, member, owner.tenant, 'admin');
    const seeded = (await live.seedRuns(owner.tenant, 3)).sort(), before = snapshot(live), runsBefore = await runIds(live, member, owner.tenant);
    assert.deepEqual(runsBefore, seeded);
    // Listing organizations is a read: the stored items are byte-for-byte what they were.
    assert.deepEqual(await orgs(live, owner), [{id: owner.tenant, name: 'Product team', role: 'owner', personal: true, shared: true, project_id: alphaProject(owner.tenant).id, ...OPEN}]);
    assert.deepEqual(await orgs(live, solo), [{id: solo.tenant, name: 'Personal workspace', role: 'owner', personal: true, shared: false, project_id: alphaProject(solo.tenant).id, ...OPEN}]);
    assert.deepEqual((await orgs(live, member)).map(o => [o.id, o.role, o.personal]), [[member.tenant, 'owner', true], [owner.tenant, 'admin', false]]);
    assert.equal(snapshot(live), before, 'no data moved or was rewritten');
    assert.deepEqual(await runIds(live, member, owner.tenant), runsBefore); assert.deepEqual(await runIds(live, owner, owner.tenant), seeded);
    // The older endpoints answer as before.
    const projects = (await ok(await get(live, owner, 'projects'))).projects; assert.equal(projects.length, 1); assert.equal(projects[0].id, alphaProject(owner.tenant).id); assert.equal(projects[0].workspace_id, owner.tenant);
    assert.equal((await ok(await get(live, owner, 'workspace'))).workspace_id, owner.tenant);
  } finally { await live.close(); }
});

test('an account creates a second organization with its own project, keys, traces, usage, plan and billing scope', async () => {
  const live = await start(); try {
    const owner = await account(live, 4242), outsider = await account(live, 7272);
    await live.seedRuns(owner.tenant, 2);
    const made = await ok(await post(live, owner, 'orgs', {name: 'Acme Inc'}), 201), org = made.id;
    assert.ok(isOrganizationId(org)); assert.deepEqual(made, {id: org, name: 'Acme Inc', role: 'owner', personal: false, shared: true, project_id: alphaProject(org).id});
    assert.notEqual(made.project_id, alphaProject(owner.tenant).id);
    assert.deepEqual((await orgs(live, owner)).map(o => [o.id, o.name, o.role, o.personal]), [[owner.tenant, 'Personal workspace', 'owner', true], [org, 'Acme Inc', 'owner', false]]);
    assert.deepEqual((await ok(await get(live, owner, 'workspaces'))).workspaces.map(w => w.workspace_id), [owner.tenant, org], 'the older workspace list includes it');
    // Data is separate in both directions.
    assert.deepEqual(await runIds(live, owner, org), []); await uploadTo(live, owner, org, 'acme-run');
    assert.deepEqual(await runIds(live, owner, org), ['acme-run']); assert.equal((await runIds(live, owner, owner.tenant)).includes('acme-run'), false); assert.equal((await runIds(live, owner, owner.tenant)).length, 2);
    // Usage, quota and plan are the organization's own.
    const usage = await ok(await get(live, owner, 'usage?workspace=' + org)), mine = await ok(await get(live, owner, 'usage'));
    assert.equal(usage.quota_scope.workspace_id, org); assert.equal(usage.quota_scope.project_id, made.project_id); assert.equal(usage.account_plan.scope, 'organization');
    assert.ok(usage.storage.used_bytes > 0 && usage.storage.used_bytes < mine.storage.used_bytes); assert.equal(usage.monthly.spans_used, 1);
    // Billing reads are the owner's, per organization; nobody else reaches them.
    assert.equal((await get(live, owner, 'billing/status?workspace=' + org)).status, 200); assert.equal((await get(live, owner, 'billing/plans?workspace=' + org)).status, 200);
    await refused(await get(live, outsider, 'billing/status?workspace=' + org), 403, 'workspace_unavailable');
    for (const path of ['runs', 'usage', 'keys', 'workspace', 'audit', 'workspaces/members']) await refused(await get(live, outsider, path + '?workspace=' + org), 403, 'workspace_unavailable');
    await refused(await post(live, outsider, 'orgs/rename', {organization_id: org, name: 'Mine now'}), 403, 'workspace_unavailable');
    // The organization's audit log starts with its creation and the key the owner approved.
    assert.deepEqual((await ok(await get(live, owner, 'audit?workspace=' + org))).events.map(e => [e.action, e.actor]), [['key.create', owner.tenant], ['org.create', owner.tenant]]);
    assert.deepEqual((await ok(await get(live, owner, 'workspaces/members?workspace=' + org))).members, [{user_id: owner.tenant, role: 'owner', active: true, version: 0, environments: null}]);
  } finally { await live.close(); }
});

test('rename, transfer ownership and leave; personal organizations cannot be transferred or left', async () => {
  const live = await start(); try {
    const owner = await account(live, 4242), admin = await account(live, 5252), viewer = await account(live, 6262);
    const org = (await ok(await post(live, owner, 'orgs', {name: 'Acme'}), 201)).id; await join(live, owner, admin, org, 'admin'); await join(live, owner, viewer, org, 'viewer');
    await refused(await post(live, admin, 'orgs/rename', {organization_id: org, name: 'Nope'}), 403, 'workspace_owner_required');
    assert.deepEqual(await ok(await post(live, owner, 'orgs/rename', {organization_id: org, name: 'Acme Labs'})), {id: org, name: 'Acme Labs'});
    assert.equal((await orgs(live, viewer)).find(o => o.id === org).name, 'Acme Labs');
    // Naming a personal organization for the first time is the existing enable-sharing write.
    assert.deepEqual(await ok(await post(live, admin, 'orgs/rename', {organization_id: admin.tenant, name: 'My space'})), {id: admin.tenant, name: 'My space'});
    assert.deepEqual((await orgs(live, admin))[0], {id: admin.tenant, name: 'My space', role: 'owner', personal: true, shared: true, project_id: alphaProject(admin.tenant).id, ...OPEN});
    await refused(await post(live, admin, 'orgs/transfer', {organization_id: admin.tenant, user_id: owner.tenant, version: 0}), 409, 'personal_organization_not_transferable');
    await refused(await post(live, admin, 'orgs/leave', {organization_id: admin.tenant}), 409, 'personal_organization_cannot_be_left');
    // Only the owner transfers, only to a current member, and never through the ordinary role change.
    const members = async who => (await ok(await get(live, who, 'workspaces/members?workspace=' + org))).members, row = async (who, id) => (await members(who)).find(m => m.user_id === id);
    await refused(await post(live, admin, 'orgs/transfer', {organization_id: org, user_id: viewer.tenant, version: 0}), 403, 'workspace_owner_required');
    await refused(await post(live, owner, 'orgs/transfer', {organization_id: org, user_id: 'github-999', version: 0}), 409, 'workspace_changed');
    await refused(await post(live, owner, 'orgs/transfer', {organization_id: org, user_id: admin.tenant, version: 7}), 409, 'workspace_changed');
    await refused(await post(live, owner, 'workspaces/member?workspace=' + org, {user_id: owner.tenant, role: 'viewer', version: 0}), 403, 'workspace_owner_required');
    await refused(await post(live, owner, 'orgs/leave', {organization_id: org}), 409, 'organization_owner_must_transfer');
    await uploadTo(live, owner, org, 'before-transfer');
    assert.deepEqual(await ok(await post(live, owner, 'orgs/transfer', {organization_id: org, user_id: admin.tenant, version: (await row(owner, admin.tenant)).version})), {transferred: true, owner: admin.tenant});
    assert.deepEqual((await orgs(live, admin)).find(o => o.id === org).role, 'owner'); assert.deepEqual((await orgs(live, owner)).find(o => o.id === org).role, 'admin');
    // The previous owner is now an admin: no members, billing or audit log; the new owner has them, and the data did not move.
    await refused(await get(live, owner, 'workspaces/members?workspace=' + org), 403, 'workspace_owner_required');
    await refused(await get(live, owner, 'billing/status?workspace=' + org), 403, 'workspace_owner_required');
    await refused(await get(live, owner, 'audit?workspace=' + org), 403, 'workspace_owner_required');
    assert.equal((await get(live, admin, 'billing/status?workspace=' + org)).status, 200); assert.deepEqual(await runIds(live, admin, org), ['before-transfer']);
    await refused(await post(live, admin, 'workspaces/member?workspace=' + org, {user_id: admin.tenant, role: 'viewer', version: (await row(admin, admin.tenant)).version}), 403, 'workspace_owner_required');
    // A member leaves on their own; the owner sees it, and access ends at once.
    assert.deepEqual(await ok(await post(live, viewer, 'orgs/leave', {organization_id: org})), {left: true});
    await refused(await get(live, viewer, 'runs?workspace=' + org), 403, 'workspace_unavailable'); assert.equal((await orgs(live, viewer)).some(o => o.id === org), false);
    assert.equal((await row(admin, viewer.tenant)).active, false);
    assert.deepEqual((await ok(await get(live, admin, 'audit?workspace=' + org + '&limit=4'))).events.map(e => [e.action, e.actor, e.target]).slice(0, 2), [['member.leave', viewer.tenant, viewer.tenant], ['org.transfer_ownership', owner.tenant, admin.tenant]]);
  } finally { await live.close(); }
});

test('a former owner cannot invite with a decision made before the transfer', async () => {
  const live = await start(); try {
    const owner = await account(live, 4242), admin = await account(live, 5252), friend = await account(live, 6262);
    const org = (await ok(await post(live, owner, 'orgs', {name: 'Acme'}), 201)).id; await join(live, owner, admin, org, 'admin');
    // The owner's request has passed its ownership check when the transfer commits; its write must then fail.
    const request = new Request(live.origin + '/api/workspaces/invite', {headers: {cookie: owner.cookie}}), spaces = new Workspaces(live.store, await workspaceSession(request, live.store, owner.tenant), '127.0.0.1');
    const tx = spaces.tx.bind(spaces); let transferred = false;
    spaces.tx = async (items, member) => { if (!transferred) { transferred = true; const members = (await ok(await get(live, owner, 'workspaces/members?workspace=' + org))).members; await ok(await post(live, owner, 'orgs/transfer', {organization_id: org, user_id: admin.tenant, version: members.find(m => m.user_id === admin.tenant).version})); } return tx(items, member); };
    await assert.rejects(spaces.invite(owner.tenant, org, {recipient_id: friend.tenant, role: 'admin'}), {code: 'workspace_changed'});
    assert.equal(transferred, true); assert.equal((await ok(await get(live, friend, 'workspaces/invitations'))).invitations.length, 0);
    await refused(await post(live, owner, 'workspaces/invite?workspace=' + org, {recipient_id: friend.tenant, role: 'admin'}), 403, 'workspace_owner_required');
    await ok(await post(live, admin, 'workspaces/invite?workspace=' + org, {recipient_id: friend.tenant, role: 'viewer'}), 201);
  } finally { await live.close(); }
});

test('billing writes by an organization owner are fenced on that ownership: a transfer in between refuses them', async () => {
  let env; const live = await start({configureEnvironment: value => {env=value;}}); try {
    const owner = await account(live, 4242), admin = await account(live, 5252);
    const org = (await ok(await post(live, owner, 'orgs', {name: 'Acme'}), 201)).id; await join(live, owner, admin, org, 'admin');
    // Put the organization on a plan whose spend cap can be chosen.
    await live.store._tx([{Update: {Key: {pk: 'TENANT#' + org, sk: 'META'}, UpdateExpression: 'SET plan_id = :plan', ExpressionAttributeValues: {':plan': 'pro'}}}]);
    await paidOverageFixture(live, env, org);
    assert.equal((await ok(await post(live, owner, 'billing/spend-cap?workspace=' + org, {enabled: false}))).spend_cap.enabled, false);
    await refused(await post(live, admin, 'billing/spend-cap?workspace=' + org, {enabled: true}), 403, 'workspace_owner_required');
    assert.deepEqual((await ok(await get(live, owner, 'audit?workspace=' + org + '&action=billing'))).events.map(e => [e.action, e.detail.enabled]), [['billing.spend_cap_changed', false]]);
    // The owner's request has been authorised when the transfer commits. Its store still carries the old ownership.
    const request = new Request(live.origin + '/api/billing/spend-cap', {headers: {cookie: owner.cookie}}), stamp = await workspaceSession(request, live.store, owner.tenant), access = await new Workspaces(live.store).access(owner.tenant, org);
    const stale = environmentStore(live.store, {owner: org, environment: 'default', stamp, access, issuer: owner.tenant}); stale.audit = {workspace: org, actor: owner.tenant, ip: '127.0.0.1'};
    const members = (await ok(await get(live, owner, 'workspaces/members?workspace=' + org))).members;
    await ok(await post(live, owner, 'orgs/transfer', {organization_id: org, user_id: admin.tenant, version: members.find(m => m.user_id === admin.tenant).version}));
    await assert.rejects(stale.setSpendCap(org, true), {code: 'spend_cap_conflict'});
    assert.equal((await live.store.getTenant(org)).spend_cap, false, 'the former owner changed nothing');
    assert.equal((await ok(await get(live, admin, 'audit?workspace=' + org + '&action=billing'))).events.length, 1, 'and wrote no event');
    assert.equal((await ok(await post(live, admin, 'billing/spend-cap?workspace=' + org, {enabled: true}))).spend_cap.enabled, true);
  } finally { await live.close(); }
});

test('the five-organization limit follows ownership through a transfer', async () => {
  const live = await start(); try {
    const giver = await account(live, 4242), taker = await account(live, 5252), made = [];
    for (let i = 0; i < ORGANIZATION_LIMIT; i++) made.push((await ok(await post(live, taker, 'orgs', {name: 'Taker ' + i}), 201)).id);
    const org = (await ok(await post(live, giver, 'orgs', {name: 'Gift'}), 201)).id; await join(live, giver, taker, org, 'admin');
    const version = async (who, id, member) => (await ok(await get(live, who, 'workspaces/members?workspace=' + id))).members.find(m => m.user_id === member).version;
    // The recipient already owns five: refused, nothing changes.
    await refused(await post(live, giver, 'orgs/transfer', {organization_id: org, user_id: taker.tenant, version: await version(giver, org, taker.tenant)}), 402, 'plan_limit_reached');
    assert.equal((await ok(await get(live, giver, 'orgs'))).organizations.find(o => o.id === org).role, 'owner');
    // The recipient hands one of theirs to the giver, which frees a place and uses one of the giver's.
    await join(live, taker, giver, made[0], 'viewer'); await ok(await post(live, taker, 'orgs/transfer', {organization_id: made[0], user_id: giver.tenant, version: await version(taker, made[0], giver.tenant)}));
    await ok(await post(live, giver, 'orgs/transfer', {organization_id: org, user_id: taker.tenant, version: await version(giver, org, taker.tenant)}));
    const owned = async who => (await ok(await get(live, who, 'orgs'))).organizations.filter(o => !o.personal && o.role === 'owner').length;
    assert.deepEqual([await owned(taker), await owned(giver)], [ORGANIZATION_LIMIT, 1]);
    await refused(await post(live, taker, 'orgs', {name: 'Sixth'}), 402, 'plan_limit_reached');
    for (let i = 1; i < ORGANIZATION_LIMIT; i++) await ok(await post(live, giver, 'orgs', {name: 'Giver ' + i}), 201);
    await refused(await post(live, giver, 'orgs', {name: 'Sixth'}), 402, 'plan_limit_reached');
  } finally { await live.close(); }
});

test('created organizations are capped per account, need a session and a clean name, and never become a sign-in', async () => {
  const live = await start(); try {
    const owner = await account(live, 4242);
    for (let i = 0; i < ORGANIZATION_LIMIT; i++) await ok(await post(live, owner, 'orgs', {name: 'Org ' + i}), 201);
    await refused(await post(live, owner, 'orgs', {name: 'One too many'}), 402, 'plan_limit_reached');
    assert.equal((await orgs(live, owner)).length, ORGANIZATION_LIMIT + 1);
    for (const body of [{name: ''}, {name: 'x'.repeat(61)}, {name: 'a\nb'}, {}, {name: 'ok', owner: 'github-1'}]) assert.equal((await post(live, owner, 'orgs', body)).status, 400, JSON.stringify(body));
    assert.equal((await fetch(live.origin + '/api/orgs')).status, 401);
    assert.equal((await fetch(live.origin + '/api/orgs', {method: 'POST', headers: {cookie: owner.cookie, origin: 'https://evil.example', 'content-type': 'application/json'}, body: JSON.stringify({name: 'x'})})).status, 403);
    const pat = 'stpat_' + randomBytes(32).toString('base64url'); await ok(await post(live, owner, 'tokens', {name: 'ci', token_hash: digest(pat)}), 201);
    assert.equal((await fetch(live.origin + '/api/orgs', {headers: {authorization: 'Bearer ' + pat}})).status, 401);
    // An organization id addresses a partition, not an identity: it has no provider subject and cannot name a workspace by guessing.
    const org = (await orgs(live, owner))[1].id, tenantRow = await live.store.getTenant(org);
    assert.equal(tenantRow.provider, 'organization'); assert.equal(tenantRow.owner_account, owner.tenant);
    await refused(await get(live, owner, 'runs?workspace=org-' + '0'.repeat(32)), 403, 'workspace_unavailable');
  } finally { await live.close(); }
});

test('deleting an organization closes it for everyone at once: owner, members, keys and tokens; the name must be repeated; a personal organization and a subscribed one are refused', async () => {
  const live = await start(); try {
    const owner = await account(live, 4242), member = await account(live, 5252), outsider = await account(live, 6262);
    const org = (await ok(await post(live, owner, 'orgs', {name: 'Acme Labs'}), 201)).id, other = (await ok(await post(live, owner, 'orgs', {name: 'Keep Me'}), 201)).id;
    await join(live, owner, member, org, 'admin'); await uploadTo(live, owner, org, 'run-1'); await uploadTo(live, owner, other, 'kept-run');
    // A key that uploads to the organization, to prove it stops.
    const key = randomBytes(32).toString('base64url'), setup = await live.store.createSetup(digest(key)); await ok(await post(live, member, 'setup/approve?workspace=' + org, {user_code: setup.user_code}));
    const upload = id => { const raw = JSON.stringify({version: 1, batch_id: id, run_id: id, events: [{id: 'e', time: '2026-11-05T00:00:00Z', kind: 'note', name: 'n', data: {}}]}); return fetch(live.origin + '/api/batches', {method: 'POST', headers: {'content-type': 'application/json', 'x-supatrace-key': key, 'x-amz-content-sha256': digest(raw)}, body: raw}); };
    assert.equal((await upload('before')).status, 201);
    const remove = (who, id, confirm) => post(live, who, 'orgs/delete', {organization_id: id, confirm});

    // Only the owner, only with the exact name, never the personal organization.
    await refused(await remove(member, org, 'Acme Labs'), 403, 'workspace_owner_required');
    await refused(await remove(outsider, org, 'Acme Labs'), 403, 'workspace_unavailable');
    for (const wrong of ['acme labs', 'Acme', '']) await refused(await remove(owner, org, wrong), 400, 'organization_name_mismatch');
    assert.equal((await post(live, owner, 'orgs/delete', {organization_id: org})).status, 400);
    await refused(await remove(owner, owner.tenant, 'Personal workspace'), 409, 'personal_organization_cannot_be_deleted');
    // Any billing state refuses it: a Stripe customer (an open Checkout could still be paid), a subscription, commercial enrolment.
    for (const [field, value] of [['stripe_customer_id', 'cus_startedcheckout1'], ['stripe_subscription_id', 'sub_stillpaying01'], ['commercial_managed', true]]) {
      live.store.client.items.get('TENANT#' + org + '\0META')[field] = value;
      await refused(await remove(owner, org, 'Acme Labs'), 409, 'billing_bound_organization');
      delete live.store.client.items.get('TENANT#' + org + '\0META')[field];
    }
    // So does a binding from the older billing sandbox.
    live.store.client.items.set('TENANT#' + org + '\0STRIPETEST#abc', {pk: 'TENANT#' + org, sk: 'STRIPETEST#abc', tenant_id: org, customer_id: 'cus_old'});
    await refused(await remove(owner, org, 'Acme Labs'), 409, 'billing_bound_organization');
    live.store.client.items.delete('TENANT#' + org + '\0STRIPETEST#abc');
    assert.deepEqual(await runIds(live, owner, org), ['before', 'run-1'], 'nothing changed so far');
    const pendingInvite = await ok(await post(live, owner, 'workspaces/invite?workspace=' + org, {recipient_id: outsider.tenant, role: 'admin'}), 201);
    const pat = 'stpat_' + randomBytes(32).toString('base64url'); await ok(await post(live, owner, 'tokens', {name: 'ci', token_hash: digest(pat)}), 201);
    assert.equal((await fetch(live.origin + '/api/v1/traces?workspace=' + org, {headers: {authorization: 'Bearer ' + pat}})).status, 200);

    assert.deepEqual(await ok(await remove(owner, org, 'Acme Labs')), {deleted: true, id: org});
    // Closed for the owner, the member, the key, and a second delete.
    for (const who of [owner, member]) for (const path of ['runs', 'usage', 'keys', 'entitlements', 'workspaces/members', 'environments']) await refused(await get(live, who, path + '?workspace=' + org), 403, 'workspace_unavailable');
    assert.equal((await upload('after')).status, 401, 'its key no longer uploads');
    await refused(await remove(owner, org, 'Acme Labs'), 403, 'workspace_unavailable');
    await refused(await post(live, owner, 'workspaces/invite?workspace=' + org, {recipient_id: outsider.tenant, role: 'admin'}), 403, 'workspace_unavailable');
    // Gone from both people's lists; the other organization and the personal one are untouched.
    assert.deepEqual((await orgs(live, owner)).map(o => o.name).sort(), ['Keep Me', 'Personal workspace']); assert.ok(!(await orgs(live, member)).some(o => o.id === org));
    assert.deepEqual(await runIds(live, owner, other), ['kept-run']);
    // The owner's counts are freed (created organizations, joined workspaces, the pointer), and so is the service-wide count.
    assert.equal(live.store.client.items.get('TENANT#' + owner.tenant + '\0ORGANIZATION#CAPACITY').count, 1);
    assert.equal(live.store.client.items.get('TENANT#' + owner.tenant + '\0WORKSPACE#CAPACITY').count, 1);
    assert.equal(live.store.client.items.has('TENANT#' + owner.tenant + '\0WORKSPACE#JOIN#' + org), false);
    // The member's slot is released too, so a deleted organization never counts against the workspaces they can join.
    assert.equal(live.store.client.items.has('TENANT#' + member.tenant + '\0WORKSPACE#JOIN#' + org), false); assert.equal(live.store.client.items.get('TENANT#' + member.tenant + '\0WORKSPACE#CAPACITY').count, 0);
    assert.equal([...live.store.client.items.values()].find(item => Number.isSafeInteger(item.organizations)).organizations, 1);
    // An invitation issued before the deletion is dead, and is not listed for its recipient.
    await refused(await post(live, outsider, 'workspaces/accept', {workspace_id: org, token: pendingInvite.token}), 409, 'invitation_unavailable');
    assert.deepEqual((await ok(await get(live, outsider, 'workspaces/invitations'))).invitations, []);
    assert.equal(live.store.client.items.get('TENANT#' + org + '\0MEMBER#' + outsider.tenant), undefined);
    // A personal access token of the former owner no longer reads it through the management API.
    assert.equal((await fetch(live.origin + '/api/v1/traces?workspace=' + org, {headers: {authorization: 'Bearer ' + pat}})).status, 403);
    assert.equal((await fetch(live.origin + '/api/v1/traces?workspace=' + other, {headers: {authorization: 'Bearer ' + pat}})).status, 200);
    // Even a key with no recorded issuer (none exists for a created organization; an operator script could make one) is refused at upload.
    for (const item of live.store.client.items.values()) if (item.tenant_id === org && item.token_hash && item.issued_by) delete item.issued_by;
    const orphan = await upload('orphan-key'); assert.equal(orphan.status, 401); assert.equal((await orphan.json()).error, 'invalid_write_key');
    // And an issuer-less secret key cannot read its traces through /api/v1: the organization acting as itself is closed too.
    await assert.rejects(new Workspaces(live.store).access(org, org), error => error.status === 403 && error.code === 'workspace_unavailable');
    await assert.rejects(new Workspaces(live.store).access(other, other).then(access => { if (access.role !== 'owner') throw new Error('unexpected'); throw Object.assign(new Error('still open'), {status: 200}); }), error => error.status === 200, 'an organization that was not deleted is unaffected');
    assert.ok(Number.isSafeInteger(live.store.client.items.get('TENANT#' + org + '\0WORKSPACE#META').deleted_at));
    assert.ok([...live.store.client.items.keys()].some(k => k.includes(org) && k.includes('RUN#')), 'trace rows are not erased by this request');
    const event = [...live.store.client.items.values()].find(item => item.action === 'org.delete'); assert.deepEqual([event.workspace_id, event.actor, event.detail.name], [org, owner.tenant, 'Acme Labs']);
  } finally { await live.close(); }
});

test('the sandbox-binding check asks the billing state table when one is configured, as well as the main table', async () => {
  // The older sandbox keeps its binding rows in a separate table when one is configured; the delete guard must look there.
  const {DynamoMetadataStore} = await import('../src/dynamodb-store.mjs'), {MemoryDynamo, commandClasses} = await import('./memory-dynamo.mjs');
  const client = new MemoryDynamo(), asked = [], send = client.send.bind(client); client.send = command => { if (command.input?.KeyConditionExpression) asked.push(command.input.TableName); return send(command); };
  const store = new DynamoMetadataStore({client, commands: commandClasses(), tableName: 'metadata', stripeStateTableName: 'billing-state', stripeTestInbox: true, stripeTestEnvironment: 'sandbox'});
  assert.equal(await store.hasStripeTestBinding('org-' + 'a'.repeat(32)), false); assert.deepEqual(asked, ['metadata', 'billing-state']);
  client.items.set('TENANT#org-' + 'a'.repeat(32) + '\0STRIPETEST#scope', {pk: 'TENANT#org-' + 'a'.repeat(32), sk: 'STRIPETEST#scope', customer_id: 'cus_bound'});
  assert.equal(await store.hasStripeTestBinding('org-' + 'a'.repeat(32)), true);
  const plain = new DynamoMetadataStore({client: new MemoryDynamo(), commands: commandClasses(), tableName: 'metadata'}); assert.equal(await plain.hasStripeTestBinding('github-1'), false);
});
