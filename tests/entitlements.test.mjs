// Plan entitlements: the one table (src/plans.mjs), the helpers that read it (src/entitlements.mjs), and every
// server-side gate, against the real handler. Each feature flag has its own test: refused below its plan with a 402
// that names the plan that unlocks it, allowed on that plan, and locked again after a downgrade with nothing deleted.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {start} from './harness.mjs';
import {paidOverageFixture} from './overage-fixture.mjs';
import {PLANS, FEATURES} from '../src/plans.mjs';
import {PLAN_LIMITS, planLimits} from '../src/plan-limits.mjs';
import {entitlementsFor, hasFeature, requireFeature, requireCount, countLimit, minimumPlan, planOf, entitlementDetails, COUNT_LIMITS, UPGRADE_PATH, DEFAULT_PLAN} from '../src/entitlements.mjs';
import {recordUsageAlert} from '../src/usage-alerts.mjs';
import {joinBySso} from '../src/org-sso.mjs';
import {GATES, GATED_ROLES, upgradeText, entitlementMessage} from '../public/app/entitlements.js';

const ids = PLANS.plans.map(plan => plan.id), rank = id => ids.indexOf(id);
async function account(live, id) { let cookie = ''; const tenant = await live.signIn({addCookies: async value => { cookie = value.map(c => c.name + '=' + c.value).join('; '); }}, id); return {tenant, cookie}; }
const call = (live, who, method, path, data) => fetch(live.origin + path, {method, headers: {cookie: who.cookie, origin: live.origin, ...(method === 'POST' ? {'content-type': 'application/json'} : {})}, ...(method === 'POST' ? {body: JSON.stringify(data ?? {})} : {})});
const post = (live, who, path, data) => call(live, who, 'POST', '/api/' + path, data), get = (live, who, path) => call(live, who, 'GET', '/api/' + path);
const ok = async (response, status = 200) => { assert.equal(response.status, status, await response.clone().text()); return response.json(); };
/** The plan of an account or organization, changed the way a reconciled subscription or an operator changes it. */
function setPlan(live, tenant, plan) { const row = live.store.client.items.get('TENANT#' + tenant + '\0META'); assert.ok(row, 'account row for ' + tenant); if (plan === null) delete row.plan_id; else row.plan_id = plan; }
/** Asserts the 402 a gate answers with, and that it names the feature and the cheapest plan that has it. */
async function locked(response, feature, plan) {
  assert.equal(response.status, 402, await response.clone().text()); const body = await response.json();
  assert.deepEqual({error: body.error, feature: body.feature, plan: body.plan, required_plan: body.required_plan, upgrade_url: body.upgrade_url}, {error: 'plan_upgrade_required', feature, plan, required_plan: minimumPlan(feature).id, upgrade_url: UPGRADE_PATH});
  assert.equal(body.message, `${FEATURES[feature].label} needs the ${minimumPlan(feature).name} plan. This organization is on ${planOf(plan).name}.`);
  return body;
}
async function full(response, limit_name, plan, used) {
  assert.equal(response.status, 402, await response.clone().text()); const body = await response.json(), limit = planOf(plan)[limit_name];
  assert.deepEqual({error: body.error, limit_name: body.limit_name, plan: body.plan, limit: body.limit, used: body.used, upgrade_url: body.upgrade_url}, {error: 'plan_limit_reached', limit_name, plan, limit, used, upgrade_url: UPGRADE_PATH});
  return body;
}
/** An owner with a shared personal organization, on `plan`. */
async function world(plan = null, options = {}) {
  const live = await start(options), owner = await account(live, 4242);
  await ok(await post(live, owner, 'workspaces', {name: 'Acme'}), 201); setPlan(live, owner.tenant, plan);
  return {live, owner, org: owner.tenant, plan: value => setPlan(live, owner.tenant, value)};
}
const below = feature => ids[rank(minimumPlan(feature).id) - 1], at = feature => minimumPlan(feature).id;

// ---- The table and its helpers ------------------------------------------------------------------------------------
test('every feature flag is on for exactly the plans that list it, and anything unknown is Free', () => {
  for (const feature of Object.keys(FEATURES)) {
    const first = minimumPlan(feature); assert.ok(first, feature + ' is sold by some plan');
    for (const plan of PLANS.plans) {
      assert.equal(hasFeature(plan.id, feature), plan.features.includes(feature), plan.id + ' ' + feature);
      // Plans are cumulative: a feature is on from its first plan upward.
      assert.equal(hasFeature(plan.id, feature), rank(plan.id) >= rank(first.id), plan.id + ' ' + feature + ' is cumulative');
      if (hasFeature(plan.id, feature)) assert.doesNotThrow(() => requireFeature(plan.id, feature));
      else assert.throws(() => requireFeature(plan.id, feature), error => error.status === 402 && error.code === 'plan_upgrade_required' && error.details.feature === feature && error.details.plan === plan.id && error.details.required_plan === first.id && error.details.upgrade_url === UPGRADE_PATH);
    }
    for (const bad of [undefined, null, '', 'PRO', 'team', '__proto__', 'constructor', 7, {}]) assert.equal(hasFeature(bad, feature), hasFeature(DEFAULT_PLAN, feature), String(bad));
  }
  assert.equal(hasFeature('enterprise', 'not_a_feature'), false); assert.equal(hasFeature('enterprise', 'constructor'), false);
  assert.throws(() => requireFeature('enterprise', 'not_a_feature'), TypeError);
  assert.deepEqual(PLANS.plans.find(plan => plan.id === DEFAULT_PLAN).features, [], 'Free has no paid feature');
});

test('where each flag starts: Base, Pro and Enterprise', () => {
  const starts = Object.fromEntries(Object.keys(FEATURES).map(feature => [feature, minimumPlan(feature).id]));
  assert.deepEqual(starts, {email_support: 'base', usage_alerts: 'base', spend_cap: 'pro', trace_drains: 'pro', audit_log: 'pro', rbac_roles: 'pro', priority_support: 'pro',
    sso_saml: 'enterprise', scim: 'enterprise', audit_log_export: 'enterprise', custom_roles: 'enterprise', enforce_mfa: 'enterprise', custom_retention: 'enterprise', sla: 'enterprise'});
});

test('count limits: under the limit passes, at the limit is refused with the next plan that has room', () => {
  for (const plan of PLANS.plans) for (const name of COUNT_LIMITS) {
    const limit = countLimit(plan.id, name); assert.equal(limit, plan[name]);
    if (limit === null) { assert.doesNotThrow(() => requireCount(plan.id, name, 1e9)); continue; }
    assert.doesNotThrow(() => requireCount(plan.id, name, limit - 1));
    const next = PLANS.plans.slice(rank(plan.id) + 1).find(candidate => candidate[name] === null || candidate[name] > limit);
    for (const used of [limit, limit + 3]) assert.throws(() => requireCount(plan.id, name, used), error => error.status === 402 && error.code === 'plan_limit_reached' && error.details.limit === limit && error.details.used === used && error.details.plan === plan.id && error.details.required_plan === next?.id && error.details.upgrade_url === UPGRADE_PATH);
  }
  assert.throws(() => countLimit('free', 'spans'), TypeError);
  // The limits never shrink as the plan grows.
  for (const name of COUNT_LIMITS) for (let index = 1; index < ids.length; index++) assert.ok((PLANS.plans[index][name] ?? Infinity) >= (PLANS.plans[index - 1][name] ?? Infinity), name + ' ' + ids[index]);
});

test('entitlementsFor is the whole answer for a plan and agrees with the enforced allowance table', () => {
  for (const plan of PLANS.plans) {
    const answer = entitlementsFor(plan.id), enforced = planLimits(plan.id);
    assert.deepEqual([answer.plan_id, answer.plan_name, answer.catalog_version, answer.upgrade_url], [plan.id, plan.name, PLANS.version, UPGRADE_PATH]);
    assert.deepEqual(answer.limits, {spans_per_month: enforced.spans_per_month, stored_bytes: enforced.stored_bytes, retention_days: enforced.retention_days, workspaces: plan.workspaces, projects: plan.projects, environments: enforced.environments, seats: enforced.seats, api_keys: enforced.api_keys});
    assert.deepEqual(Object.keys(answer.features), Object.keys(FEATURES));
    for (const [feature, flag] of Object.entries(answer.features)) assert.deepEqual(flag, {enabled: plan.features.includes(feature), label: FEATURES[feature].label, required_plan: minimumPlan(feature).id, required_plan_name: minimumPlan(feature).name});
  }
  assert.equal(entitlementsFor('free').limits.projects, 2);
  assert.equal(entitlementsFor('nonsense').plan_id, 'free'); assert.deepEqual(Object.keys(PLAN_LIMITS.plans), ids);
  // Only the two entitlement errors carry details, and only whitelisted fields.
  const error = (() => { try { requireFeature('free', 'sso_saml'); } catch (e) { return e; } })(); error.details.secret = 'x';
  assert.deepEqual(Object.keys(entitlementDetails(error)).sort(), ['feature', 'message', 'plan', 'required_plan', 'upgrade_url']);
  assert.deepEqual(entitlementDetails({code: 'workspace_changed', details: {message: 'x'}}), {});
});

// ---- GET /api/entitlements ----------------------------------------------------------------------------------------
test('GET /api/entitlements: any member reads the plan, limits, usage and flags of the organization; outsiders do not', async () => {
  const {live, owner, org, plan} = await world('pro'); try {
    const member = await account(live, 5252), outsider = await account(live, 6262);
    const invite = await ok(await post(live, owner, 'workspaces/invite', {recipient_id: member.tenant, role: 'viewer'}), 201); await ok(await post(live, member, 'workspaces/accept', {workspace_id: org, token: invite.token}));
    await ok(await post(live, owner, 'environments', {id: 'staging', name: 'Staging'}), 201);
    await ok(await post(live, owner, 'keys/create', {key_hash: createHash('sha256').update(randomBytes(8)).digest('hex'), key_type: 'publishable'}), 201);
    const mine = await ok(await get(live, owner, 'entitlements'));
    const strip = answer => ({...answer, workspace_id: undefined, usage: undefined, role: undefined, billing_owner: undefined});
    assert.deepEqual(strip(mine), strip(entitlementsFor('pro')));
    assert.deepEqual([mine.workspace_id, mine.usage, mine.role, mine.billing_owner], [org, {seats: 2, environments: 2, api_keys: 1, projects: 1}, 'owner', true]);
    // A read-only member sees the same plan answer, and is told they do not manage billing; neither does the owner outside Default.
    const theirs = await ok(await get(live, member, 'entitlements?workspace=' + org)); assert.deepEqual(strip(theirs), strip(mine)); assert.deepEqual([theirs.role, theirs.billing_owner, theirs.usage], ['viewer', false, mine.usage]);
    assert.equal((await ok(await get(live, owner, 'entitlements?environment=staging'))).billing_owner, false);
    assert.equal((await get(live, outsider, 'entitlements?workspace=' + org)).status, 403);
    // The member's own personal organization is on its own plan.
    assert.equal((await ok(await get(live, member, 'entitlements'))).plan_id, 'free');
    plan('nonsense'); assert.equal((await ok(await get(live, owner, 'entitlements'))).plan_id, 'free', 'an unknown plan id never grants more than Free');
    assert.equal((await fetch(live.origin + '/api/entitlements')).status, 401);
  } finally { await live.close(); }
});

// ---- One test per gated feature -------------------------------------------------------------------------------------
test('trace_drains: creating, testing and flushing a drain needs Pro; a downgrade keeps the drain, stops deliveries and still allows delete', async () => {
  const {live, owner, plan} = await world(below('trace_drains')); try {
    await locked(await post(live, owner, 'drains', {url: 'https://hooks.example.com/t'}), 'trace_drains', below('trace_drains'));
    plan(at('trace_drains')); const drain = await ok(await post(live, owner, 'drains', {url: 'https://hooks.example.com/t'}), 201);
    plan('free');
    assert.equal((await ok(await get(live, owner, 'drains'))).drains.length, 1, 'the drain is still listed');
    await locked(await post(live, owner, 'drains', {url: 'https://hooks.example.com/u'}), 'trace_drains', 'free');
    await locked(await post(live, owner, 'drains/test', {id: drain.id}), 'trace_drains', 'free');
    await locked(await post(live, owner, 'drains/flush', {}), 'trace_drains', 'free');
    // An upload on the lower plan queues nothing for the drain.
    const key = 'st_pub_' + randomBytes(32).toString('base64url'); await ok(await post(live, owner, 'keys/create', {key_hash: createHash('sha256').update(key).digest('hex'), key_type: 'publishable'}), 201);
    const raw = JSON.stringify({version: 1, batch_id: 'b1', run_id: 'r1', events: [{id: 'e1', time: '2026-11-15T00:00:00.000Z', kind: 'note', name: 'x', data: {}}]});
    const upload = await fetch(live.origin + '/api/batches', {method: 'POST', headers: {'content-type': 'application/json', 'x-supatrace-key': key, 'x-amz-content-sha256': createHash('sha256').update(raw).digest('hex')}, body: raw});
    assert.equal(upload.status, 201, await upload.clone().text());
    assert.equal((await ok(await get(live, owner, 'drains'))).drains[0].queued, 0, 'nothing queued while the plan lacks drains');
    assert.deepEqual(await ok(await post(live, owner, 'drains/delete', {id: drain.id})), {deleted: true});
  } finally { await live.close(); }
});

test('audit_log and audit_log_export: events are recorded on every plan, read from Pro, exported on Enterprise', async () => {
  const {live, owner, plan} = await world(below('audit_log')); try {
    await ok(await post(live, owner, 'environments', {id: 'staging', name: 'Staging'}), 201);
    await locked(await get(live, owner, 'audit'), 'audit_log', below('audit_log'));
    await locked(await get(live, owner, 'audit/export'), 'audit_log_export', below('audit_log'));
    plan(at('audit_log')); const log = await ok(await get(live, owner, 'audit'));
    assert.ok(log.events.some(event => event.action === 'environment.create'), 'the event from before the upgrade is there');
    await locked(await get(live, owner, 'audit/export?format=csv'), 'audit_log_export', at('audit_log'));
    plan(at('audit_log_export')); const exported = await get(live, owner, 'audit/export?format=json'); assert.equal(exported.status, 200); assert.ok((await exported.json()).events.length >= 1);
    plan('free'); await locked(await get(live, owner, 'audit'), 'audit_log', 'free');
  } finally { await live.close(); }
});

test('rbac_roles: Admin is on every plan; Developer, Read-only and environment limits need Pro; a downgrade keeps existing members', async () => {
  const {live, owner, org, plan} = await world('base'); try {
    const people = [await account(live, 5252), await account(live, 6262), await account(live, 7272)];
    await ok(await post(live, owner, 'environments', {id: 'staging', name: 'Staging'}), 201);
    for (const role of GATED_ROLES) await locked(await post(live, owner, 'workspaces/invite', {recipient_id: people[0].tenant, role}), 'rbac_roles', 'base');
    await locked(await post(live, owner, 'workspaces/invite', {recipient_id: people[0].tenant, role: 'admin', environments: ['staging']}), 'rbac_roles', 'base');
    const admin = await ok(await post(live, owner, 'workspaces/invite', {recipient_id: people[0].tenant, role: 'admin'}), 201); await ok(await post(live, people[0], 'workspaces/accept', {workspace_id: org, token: admin.token}));
    const version = async id => (await ok(await get(live, owner, 'workspaces/members'))).members.find(m => m.user_id === id).version;
    await locked(await post(live, owner, 'workspaces/member', {user_id: people[0].tenant, role: 'viewer', version: await version(people[0].tenant)}), 'rbac_roles', 'base');
    plan('pro');
    await ok(await post(live, owner, 'workspaces/member', {user_id: people[0].tenant, role: 'developer', version: await version(people[0].tenant)}));
    const viewer = await ok(await post(live, owner, 'workspaces/invite', {recipient_id: people[1].tenant, role: 'viewer', environments: ['staging']}), 201); await ok(await post(live, people[1], 'workspaces/accept', {workspace_id: org, token: viewer.token}));
    // An invitation issued on Pro does not carry its role past a downgrade.
    const late = await ok(await post(live, owner, 'workspaces/invite', {recipient_id: people[2].tenant, role: 'developer'}), 201);
    plan('base'); await locked(await post(live, people[2], 'workspaces/accept', {workspace_id: org, token: late.token}), 'rbac_roles', 'base');
    const members = (await ok(await get(live, owner, 'workspaces/members'))).members;
    assert.deepEqual(members.filter(m => m.user_id !== org).map(m => [m.role, m.active]).sort(), [['developer', true], ['viewer', true]], 'nobody is removed or changed by the downgrade');
    await locked(await post(live, owner, 'workspaces/invite', {recipient_id: people[2].tenant, role: 'developer'}), 'rbac_roles', 'base');
    // Removing a member and moving one to Admin are always allowed.
    await ok(await post(live, owner, 'workspaces/member', {user_id: people[0].tenant, role: 'admin', version: await version(people[0].tenant)}));
    await ok(await post(live, owner, 'workspaces/member', {user_id: people[1].tenant, role: 'removed', version: await version(people[1].tenant)}));
  } finally { await live.close(); }
});

test('spend_cap: only a plan with the feature may turn the cap off', async () => {
  let env;
  const {live, owner, plan} = await world(below('spend_cap'), {configureEnvironment: value => {env=value;}}); try {
    await locked(await post(live, owner, 'billing/spend-cap', {enabled: false}), 'spend_cap', below('spend_cap'));
    plan(at('spend_cap')); await paidOverageFixture(live, env, owner.tenant); assert.deepEqual((await ok(await post(live, owner, 'billing/spend-cap', {enabled: false}))).spend_cap.enabled, false);
    plan('free'); await locked(await post(live, owner, 'billing/spend-cap', {enabled: true}), 'spend_cap', 'free');
    assert.equal((await ok(await get(live, owner, 'usage'))).spend_cap.enabled, true, 'back on Free the cap is on again: uploads stop at the allowance');
  } finally { await live.close(); }
});

test('sso_saml and scim: SSO settings and a SCIM token need Enterprise; turning "require SSO" off is always allowed', async () => {
  const {live, owner, org, plan} = await world(below('sso_saml')); try {
    const settings = {organization_id: org, idp_sso_url: 'https://idp.example.com/sso', idp_issuer: 'https://idp.example.com', idp_cert: 'not a certificate', default_role: 'viewer', domains: []};
    await locked(await post(live, owner, 'orgs/sso', settings), 'sso_saml', below('sso_saml'));
    await locked(await post(live, owner, 'orgs/sso/verify', {organization_id: org, domain: 'acme.example'}), 'sso_saml', below('sso_saml'));
    await locked(await post(live, owner, 'orgs/sso/enforce', {organization_id: org, enforce: true}), 'sso_saml', below('sso_saml'));
    await locked(await post(live, owner, 'orgs/sso/scim-token', {organization_id: org, token_hash: 'a'.repeat(64)}), 'scim', below('scim'));
    // Reading the settings and clearing the rule pass the gate (and then meet the ordinary checks).
    assert.equal((await get(live, owner, 'orgs/sso')).status, 200);
    const off = await post(live, owner, 'orgs/sso/enforce', {organization_id: org, enforce: false}); assert.equal(off.status, 409); assert.equal((await off.json()).error, 'sso_not_configured');
    plan(at('sso_saml'));
    const saved = await post(live, owner, 'orgs/sso', settings); assert.equal(saved.status, 400); assert.equal((await saved.json()).error, 'invalid_sso_certificate', 'on Enterprise the request reaches validation');
    const token = await post(live, owner, 'orgs/sso/scim-token', {organization_id: org, token_hash: 'a'.repeat(64)}); assert.equal((await token.json()).error, 'sso_not_configured');
  } finally { await live.close(); }
});

test('enforce_mfa: requiring two-factor authentication for an organization needs Enterprise, and a downgrade stops applying the rule', async () => {
  const {live, owner, org, plan} = await world(below('enforce_mfa'), {mfa: true}); try {
    await locked(await post(live, owner, 'orgs/security', {organization_id: org, require_mfa: true}), 'enforce_mfa', below('enforce_mfa'));
    assert.equal((await post(live, owner, 'orgs/security', {organization_id: org, require_mfa: false})).status, 200, 'clearing the rule is always allowed');
    plan(at('enforce_mfa'));
    const on = await post(live, owner, 'orgs/security', {organization_id: org, require_mfa: true}); assert.equal(on.status, 409); assert.equal((await on.json()).error, 'mfa_enrollment_required', 'on Enterprise the request reaches the ordinary checks');
    // A rule that is set stops being applied when the plan no longer has the feature: members are not locked out.
    const member = await account(live, 5252), invite = await ok(await post(live, owner, 'workspaces/invite', {recipient_id: member.tenant, role: 'admin'}), 201); await ok(await post(live, member, 'workspaces/accept', {workspace_id: org, token: invite.token}));
    live.store.client.items.get('TENANT#' + org + '\0WORKSPACE#META').require_mfa = true;
    const refusedNow = await get(live, member, 'runs?workspace=' + org); assert.equal(refusedNow.status, 403); assert.equal((await refusedNow.json()).error, 'mfa_enrollment_required');
    plan('pro'); assert.equal((await get(live, member, 'runs?workspace=' + org)).status, 200);
  } finally { await live.close(); }
});

test('usage_alerts: the alert is recorded on every plan; the email is for plans with the feature', async () => {
  const sent = [], env = {EMAIL_FROM: 'member@example.com', APP_ORIGIN: 'https://supatrace.dev', sendEmail: async message => { sent.push(message); }};
  const alert = {level: 80, period: '2026-11', used: 80, limit: 100, resets_at: 1796083200, spend_cap: true};
  for (const plan of PLANS.plans) {
    const rows = [], store = {getTenant: async () => ({provider: 'email', email: 'owner@example.com', plan_id: plan.id}), recordUsageAlert: async (tenant, value, extra) => { rows.push(extra.email_status); return {created: true}; }, setUsageAlertEmail: async () => {}};
    const result = await recordUsageAlert(env, store, 'email-1', alert); if (result.deliver) await result.deliver();
    assert.equal(result.recorded, true, plan.id + ' records the alert');
    assert.deepEqual(rows, [hasFeature(plan.id, 'usage_alerts') ? 'pending' : 'not_in_plan'], plan.id);
  }
  assert.equal(sent.length, PLANS.plans.filter(plan => plan.features.includes('usage_alerts')).length);
});

test('flags without a switch of their own (support tiers, SLA, custom roles, custom retention) are reported by /api/entitlements', async () => {
  const {live, owner, plan} = await world('free'); try {
    for (const id of ids) {
      plan(id); const answer = await ok(await get(live, owner, 'entitlements'));
      for (const feature of ['email_support', 'priority_support', 'sla', 'custom_roles', 'custom_retention']) assert.equal(answer.features[feature].enabled, rank(id) >= rank(at(feature)), id + ' ' + feature);
    }
  } finally { await live.close(); }
});

// ---- Count limits -------------------------------------------------------------------------------------------------
test('seats: invitations and acceptances stop at the plan seat count, a removal frees a seat, an upgrade adds seats', async () => {
  const {live, owner, org, plan} = await world('free'); try {
    const people = []; for (let id = 5001; id <= 5006; id++) people.push(await account(live, id));
    const invite = async who => post(live, owner, 'workspaces/invite', {recipient_id: who.tenant, role: 'admin'}), accept = (who, token) => post(live, who, 'workspaces/accept', {workspace_id: org, token});
    const first = await ok(await invite(people[0]), 201); await ok(await accept(people[0], first.token));
    // Free is two seats: the owner and one member.
    const body = await full(await invite(people[1]), 'seats', 'free', 2); assert.equal(body.required_plan, 'base'); assert.match(body.message, /^The Free plan allows 2 members\. Base allows 5\.$/);
    // A removal frees the seat at once.
    const row = (await ok(await get(live, owner, 'workspaces/members'))).members.find(m => m.user_id === people[0].tenant);
    await ok(await post(live, owner, 'workspaces/member', {user_id: people[0].tenant, role: 'removed', version: row.version}));
    const second = await ok(await invite(people[1]), 201);
    // An invitation issued while there was room cannot be accepted once the organization is full again.
    plan('base'); const third = await ok(await invite(people[2]), 201); plan('free'); await ok(await accept(people[1], second.token));
    await full(await accept(people[2], third.token), 'seats', 'free', 2);
    plan('base'); await ok(await accept(people[2], third.token));
    for (const who of people.slice(3, 5)) { const made = await ok(await invite(who), 201); await ok(await accept(who, made.token)); }
    await full(await invite(people[5]), 'seats', 'base', planOf('base').seats);
    assert.equal((await ok(await get(live, owner, 'entitlements'))).usage.seats, planOf('base').seats);
  } finally { await live.close(); }
});

test('seats: racing invitation acceptances cannot spend the same last seat; the loser can retry after removal', async () => {
  const {live, owner, org} = await world('free'); try {
    const people = [await account(live, 5101), await account(live, 5102)];
    const invites = [];
    for (const who of people) invites.push(await ok(await post(live, owner, 'workspaces/invite', {recipient_id: who.tenant, role: 'admin'}), 201));
    // Hold both authoritative counts after they have observed one free seat and the same legacy revision.
    const page = live.store._page.bind(live.store); let arrived = 0, release;
    const both = new Promise(resolve => { release = resolve; });
    live.store._page = async (...args) => {
      const result = await page(...args);
      if (args[0] === 'TENANT#' + org && args[1] === 'MEMBER#') { if (++arrived === 2) release(); await both; }
      return result;
    };
    const accept = index => post(live, people[index], 'workspaces/accept', {workspace_id: org, token: invites[index].token});
    const results = await Promise.all([accept(0), accept(1)]); live.store._page = page;
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    assert.equal((await ok(await get(live, owner, 'entitlements'))).usage.seats, 2);
    const winner = results.findIndex(r => r.status === 200), loser = 1 - winner;
    await full(await accept(loser), 'seats', 'free', 2);
    const member = (await ok(await get(live, owner, 'workspaces/members'))).members.find(m => m.user_id === people[winner].tenant);
    await ok(await post(live, owner, 'workspaces/member', {user_id: member.user_id, role: 'removed', version: member.version}));
    await ok(await accept(loser));
    assert.equal((await ok(await get(live, owner, 'entitlements'))).usage.seats, 2);
  } finally { await live.close(); }
});

test('seats: SSO provisioning and invitation acceptance share the admission fence', async () => {
  const {live, owner, org} = await world('enterprise'); try {
    const invited = await account(live, 5201), ssoUser = await account(live, 5202);
    const cap = planOf('enterprise').seats, memory = live.store.client.items;
    for (let i = 0; i < cap - 2; i++) memory.set('TENANT#' + org + '\0MEMBER#github-' + (9000 + i), {pk: 'TENANT#' + org, sk: 'MEMBER#github-' + (9000 + i), user_id: 'github-' + (9000 + i), active: true, role: 'admin', version: 0});
    memory.get('TENANT#' + org + '\0WORKSPACE#META').members = cap - 1;
    memory.set('TENANT#' + org + '\0SSO#CONFIG', {pk: 'TENANT#' + org, sk: 'SSO#CONFIG', updated_at: 11});
    const invitation = await ok(await post(live, owner, 'workspaces/invite', {recipient_id: invited.tenant, role: 'admin'}), 201);
    const page = live.store._page.bind(live.store); let arrived = 0, release;
    const both = new Promise(resolve => { release = resolve; });
    live.store._page = async (...args) => { const result = await page(...args); if (args[0] === 'TENANT#' + org && args[1] === 'MEMBER#') { if (++arrived === 2) release(); await both; } return result; };
    const [accepted, provisioned] = await Promise.all([
      post(live, invited, 'workspaces/accept', {workspace_id: org, token: invitation.token}),
      joinBySso({store: live.store}, {org, config_version: 11, default_role: 'developer'}, ssoUser.tenant),
    ]); live.store._page = page;
    assert.equal(Number(accepted.status === 200) + Number(provisioned.created), 1);
    assert.ok([200, 409].includes(accepted.status));
    assert.equal((await ok(await get(live, owner, 'entitlements'))).usage.seats, cap);
  } finally { await live.close(); }
});

test('environments: Default counts toward the plan, a create over the limit is refused, existing environments survive a downgrade', async () => {
  const {live, owner, plan} = await world('free'); try {
    const create = id => post(live, owner, 'environments', {id, name: id});
    await ok(await create('staging'), 201);
    const body = await full(await create('dev'), 'environments', 'free', 2); assert.equal(body.required_plan, 'base');
    plan('base'); await ok(await create('dev'), 201); await full(await create('qa'), 'environments', 'base', 3);
    plan('free');
    assert.deepEqual((await ok(await get(live, owner, 'environments'))).environments.map(e => e.id), ['default', 'dev', 'staging'], 'nothing is deleted by the downgrade');
    assert.equal((await get(live, owner, 'runs?environment=dev')).status, 200, 'and the extra environment still reads');
    await full(await create('qa'), 'environments', 'free', 3);
  } finally { await live.close(); }
});

test('api_keys: the active-key count follows the plan and the refusal names the next plan', async () => {
  const {live, owner, plan} = await world('free'); try {
    const create = () => post(live, owner, 'keys/create', {key_hash: createHash('sha256').update(randomBytes(16)).digest('hex'), key_type: 'publishable'});
    for (let made = 0; made < planOf('free').api_keys; made++) await ok(await create(), 201);
    const body = await full(await create(), 'api_keys', 'free', planOf('free').api_keys); assert.equal(body.required_plan, 'base');
    assert.match(body.message, /^Revoke an unused key in API keys \(\/app\/#keys\) before creating another\./);
    assert.match(entitlementMessage(body), /Revoke an unused key.*Upgrade in Billing/);
    plan('base'); await ok(await create(), 201);
    plan('free'); await full(await create(), 'api_keys', 'free', planOf('free').api_keys + 1);
    assert.equal((await ok(await get(live, owner, 'keys'))).keys.filter(key => !key.revoked).length, planOf('free').api_keys + 1, 'keys made on the higher plan keep working');
  } finally { await live.close(); }
});

// ---- The dashboard reads the same table ---------------------------------------------------------------------------
test('the dashboard gates name real feature flags and its texts come from the server answer', () => {
  for (const [id, feature] of Object.entries(GATES)) assert.ok(Object.hasOwn(FEATURES, feature), id + ' -> ' + feature);
  assert.deepEqual([...GATED_ROLES].sort(), ['developer', 'viewer']);
  assert.equal(upgradeText(entitlementsFor('base'), 'audit_log'), 'Audit log needs the Pro plan. This organization is on Base.');
  assert.equal(upgradeText(entitlementsFor('pro'), 'sso_saml'), 'SAML single sign-on needs the Enterprise plan. This organization is on Pro.');
  assert.equal(entitlementMessage({error: 'plan_limit_reached', message: 'The Free plan allows 2 members. Base allows 5.'}), 'The Free plan allows 2 members. Base allows 5. Upgrade in Billing.');
  assert.equal(entitlementMessage({error: 'workspace_changed', message: 'x'}), null);
});

// ---- Environments: rename and delete --------------------------------------------------------------------------------
test('environments: owners and admins rename and delete; a deleted environment and its keys stop working, its id is retired and its seat in the plan count is freed', async () => {
  const {live, owner, org, plan} = await world('base'); try {
    const admin = await account(live, 5252), dev = await account(live, 6262); plan('pro');
    for (const [who, role] of [[admin, 'admin'], [dev, 'developer']]) { const invite = await ok(await post(live, owner, 'workspaces/invite', {recipient_id: who.tenant, role}), 201); await ok(await post(live, who, 'workspaces/accept', {workspace_id: org, token: invite.token})); }
    plan('base');
    await ok(await post(live, owner, 'environments', {id: 'staging', name: 'Staging'}), 201); await ok(await post(live, owner, 'environments', {id: 'dev', name: 'Dev'}), 201);
    // A key and a trace that live in staging.
    const key = 'st_pub_' + randomBytes(32).toString('base64url'); await ok(await post(live, owner, 'keys/create?environment=staging', {key_hash: createHash('sha256').update(key).digest('hex'), key_type: 'publishable'}), 201);
    const upload = id => { const raw = JSON.stringify({version: 1, batch_id: id, run_id: id, events: [{id: 'e1', time: '2026-11-15T00:00:00.000Z', kind: 'note', name: 'x', data: {}}]}); return fetch(live.origin + '/api/batches?environment=staging', {method: 'POST', headers: {'content-type': 'application/json', 'x-supatrace-key': key, 'x-amz-content-sha256': createHash('sha256').update(raw).digest('hex')}, body: raw}); };
    assert.equal((await upload('b1')).status, 201); assert.equal((await ok(await get(live, owner, 'runs?environment=staging'))).runs.length, 1);
    assert.equal((await ok(await get(live, owner, 'runs'))).runs.length, 0, 'Default does not see the staging trace');

    // Rename: admin may, developer may not; Default and unknown environments are refused; the id never changes.
    assert.deepEqual(await ok(await post(live, admin, 'environments/rename?workspace=' + org, {id: 'staging', name: 'Pre-production'})), {id: 'staging', name: 'Pre-production'});
    assert.equal((await post(live, dev, 'environments/rename?workspace=' + org, {id: 'staging', name: 'x'})).status, 403);
    for (const bad of [{id: 'default', name: 'x'}, {id: 'staging', name: ''}, {id: 'staging'}]) assert.equal((await post(live, owner, 'environments/rename', bad)).status, 400);
    assert.equal((await post(live, owner, 'environments/rename', {id: 'nope', name: 'x'})).status, 403);
    assert.deepEqual((await ok(await get(live, owner, 'environments'))).environments.map(e => [e.id, e.name]), [['default', 'Default'], ['dev', 'Dev'], ['staging', 'Pre-production']]);
    assert.equal((await ok(await get(live, owner, 'runs?environment=staging'))).runs.length, 1, 'renaming keeps the data and the key');

    // Delete needs the id repeated, never Default, and owner or admin.
    for (const bad of [{id: 'staging'}, {id: 'staging', confirm: 'dev'}, {id: 'default', confirm: 'default'}]) assert.equal((await post(live, owner, 'environments/delete', bad)).status, 400);
    assert.equal((await post(live, dev, 'environments/delete?workspace=' + org, {id: 'staging', confirm: 'staging'})).status, 403);
    await full(await post(live, owner, 'environments', {id: 'qa', name: 'QA'}), 'environments', 'base', 3);
    assert.deepEqual(await ok(await post(live, owner, 'environments/delete', {id: 'staging', confirm: 'staging'})), {deleted: true, id: 'staging', keys_revoked: 1});
    // Gone everywhere: list, reads, uploads with its key, and the key itself.
    assert.deepEqual((await ok(await get(live, owner, 'environments'))).environments.map(e => e.id), ['default', 'dev']);
    assert.equal((await get(live, owner, 'runs?environment=staging')).status, 403);
    assert.notEqual((await upload('b2')).status, 201);
    assert.equal((await ok(await get(live, owner, 'entitlements'))).usage.api_keys, 0, 'its key no longer holds a slot');
    assert.equal((await ok(await get(live, owner, 'runs'))).runs.length, 0); assert.equal((await ok(await get(live, owner, 'runs?environment=dev'))).runs.length, 0);
    // The plan count has room again, but the retired id cannot come back with its old traces.
    const retired = await post(live, owner, 'environments', {id: 'staging', name: 'Staging'}); assert.equal(retired.status, 409); assert.equal((await retired.json()).error, 'environment_id_retired');
    await ok(await post(live, owner, 'environments', {id: 'qa', name: 'QA'}), 201);
    assert.deepEqual(await ok(await post(live, owner, 'environments/delete', {id: 'staging', confirm: 'staging'})), {deleted:true,id:'staging',keys_revoked:1}, 'repeat deletion is idempotent');
    plan('pro'); const actions = (await ok(await get(live, owner, 'audit'))).events.map(event => event.action);
    for (const action of ['environment.create', 'environment.rename', 'environment.delete']) assert.ok(actions.includes(action), action);
  } finally { await live.close(); }
});

// ---- Enterprise features with their own switch ----------------------------------------------------------------------
test('custom_retention: an Enterprise owner sets retention for new traces; other plans are refused and a downgrade returns to the plan days', async () => {
  const {live, owner, plan} = await world(below('custom_retention')); try {
    await locked(await post(live, owner, 'billing/retention', {days: 400}), 'custom_retention', below('custom_retention'));
    plan('enterprise');
    for (const bad of [{days: 0}, {days: 3651}, {days: 1.5}, {days: '30'}, {}, {days: 30, extra: 1}]) assert.equal((await post(live, owner, 'billing/retention', bad)).status, 400, JSON.stringify(bad));
    assert.deepEqual(await ok(await post(live, owner, 'billing/retention', {days: 400})), {retention_days: 400, plan_default_days: planOf('enterprise').retention_days, custom: true});
    assert.equal((await ok(await get(live, owner, 'entitlements'))).limits.retention_days, 400);
    const usage = await ok(await get(live, owner, 'usage')); assert.deepEqual([usage.plan_limits.retention_days, usage.retention.days], [400, 400]);
    // A trace accepted now carries the chosen retention.
    const key = 'st_pub_' + randomBytes(32).toString('base64url'); await ok(await post(live, owner, 'keys/create', {key_hash: createHash('sha256').update(key).digest('hex'), key_type: 'publishable'}), 201);
    const upload = async id => { const raw = JSON.stringify({version: 1, batch_id: id, run_id: id, events: [{id: 'e1', time: '2026-11-15T00:00:00.000Z', kind: 'note', name: 'x', data: {}}]}); assert.equal((await fetch(live.origin + '/api/batches', {method: 'POST', headers: {'content-type': 'application/json', 'x-supatrace-key': key, 'x-amz-content-sha256': createHash('sha256').update(raw).digest('hex')}, body: raw})).status, 201); };
    const days = async id => { const run = (await ok(await get(live, owner, 'runs'))).runs.find(item => item.id === id); return Math.round((Date.parse(run.expires_at) - Date.parse(run.created_at)) / 86400000); };
    await upload('long'); assert.equal(await days('long'), 400);
    // Clearing the choice, and a downgrade, both return new traces to the plan's days; stored traces keep their stamp.
    assert.deepEqual(await ok(await post(live, owner, 'billing/retention', {days: null})), {retention_days: 365, plan_default_days: 365, custom: false});
    await ok(await post(live, owner, 'billing/retention', {days: 400})); plan('pro');
    assert.equal((await ok(await get(live, owner, 'entitlements'))).limits.retention_days, planOf('pro').retention_days);
    await upload('short'); assert.equal(await days('short'), planOf('pro').retention_days); assert.equal(await days('long'), 400);
    const events = (await ok(await get(live, owner, 'audit'))).events.filter(event => event.action === 'settings.retention_changed').map(event => [event.detail.from, event.detail.to]).reverse();
    assert.deepEqual(events, [[365, 400], [400, 365], [365, 400]]);
  } finally { await live.close(); }
});

test('custom_roles: an Enterprise owner defines a named role with a permission level and an environment limit; members act with exactly that; a downgrade leaves them read-only', async () => {
  const {live, owner, org, plan} = await world(below('custom_roles')); try {
    const member = await account(live, 5252), other = await account(live, 6262), q = '?workspace=' + org;
    await ok(await post(live, owner, 'environments', {id: 'staging', name: 'Staging'}), 201);
    const define = (body) => post(live, owner, 'orgs/roles', {organization_id: org, ...body});
    await locked(await define({name: 'Auditor', base: 'viewer', environments: ['staging']}), 'custom_roles', below('custom_roles'));
    plan('enterprise');
    for (const bad of [{name: 'x', base: 'owner', environments: null}, {name: '', base: 'viewer', environments: null}, {name: 'x', base: 'viewer', environments: ['nope']}, {name: 'x', base: 'viewer'}, {id: 'custom:zz', name: 'x', base: 'viewer', environments: null}]) assert.equal((await define(bad)).status, 400, JSON.stringify(bad));
    const role = await ok(await define({name: 'Auditor', base: 'viewer', environments: ['staging']}), 201);
    assert.match(role.id, /^custom:[a-f0-9]{12}$/); assert.deepEqual([role.name, role.base, role.environments], ['Auditor', 'viewer', ['staging']]);
    assert.equal((await define({name: 'auditor', base: 'admin', environments: null})).status, 409, 'role names are unique in an organization');
    assert.deepEqual(await ok(await get(live, owner, 'orgs/roles')), {roles: [role], limit: 10});
    // Only the owner defines or lists roles; a role id that does not exist cannot be given to anyone.
    await refusedInvite(await post(live, owner, 'workspaces/invite', {recipient_id: member.tenant, role: 'custom:0123456789ab'}), 400, 'invalid_member_role');

    // A member with the role: reads staging, nothing else.
    const invite = await ok(await post(live, owner, 'workspaces/invite', {recipient_id: member.tenant, role: role.id}), 201); await ok(await post(live, member, 'workspaces/accept', {workspace_id: org, token: invite.token}));
    const mine = (await ok(await get(live, member, 'workspaces'))).workspaces.find(w => w.workspace_id === org);
    assert.deepEqual([mine.role, mine.role_name, mine.environments], ['viewer', 'Auditor', ['staging']]);
    assert.equal((await get(live, member, 'runs' + q + '&environment=staging')).status, 200);
    await refusedInvite(await get(live, member, 'runs' + q), 403, 'environment_unavailable');
    const newKey = environment => post(live, member, 'keys/create' + q + '&environment=' + environment, {key_hash: createHash('sha256').update(randomBytes(16)).digest('hex'), key_type: 'publishable'});
    await refusedInvite(await newKey('staging'), 403, 'workspace_admin_required');
    await refusedInvite(await get(live, member, 'orgs/roles' + q), 403, 'workspace_owner_required');
    assert.equal((await ok(await get(live, owner, 'workspaces/members'))).members.find(m => m.user_id === member.tenant).role, role.id);

    // Changing the role changes what its members may do at once: Developer level, every environment.
    assert.deepEqual(await ok(await define({id: role.id, name: 'Auditor', base: 'developer', environments: null})), {id: role.id, name: 'Auditor', base: 'developer', environments: null});
    const key = 'st_pub_' + randomBytes(32).toString('base64url');
    await ok(await post(live, member, 'keys/create' + q, {key_hash: createHash('sha256').update(key).digest('hex'), key_type: 'publishable'}), 201);
    const upload = id => { const raw = JSON.stringify({version: 1, batch_id: id, run_id: id, events: [{id: 'e1', time: '2026-11-15T00:00:00.000Z', kind: 'note', name: 'x', data: {}}]}); return fetch(live.origin + '/api/batches', {method: 'POST', headers: {'content-type': 'application/json', 'x-supatrace-key': key, 'x-amz-content-sha256': createHash('sha256').update(raw).digest('hex')}, body: raw}); };
    assert.equal((await upload('by-custom-role')).status, 201, 'a key issued under a custom role uploads');
    await refusedInvite(await post(live, member, 'environments' + q, {id: 'dev', name: 'Dev'}), 403, 'workspace_admin_required');

    // A write the member started under the old definition does not commit after the role changes underneath it.
    {
      const original = live.store._tx.bind(live.store); let raced = false;
      live.store._tx = async items => { if (!raced && items.some(item => item.Put?.Item?.sk?.startsWith?.('KEY#'))) { raced = true; await ok(await define({id: role.id, name: 'Auditor', base: 'viewer', environments: null})); } return original(items); };
      const stale = await post(live, member, 'keys/create' + q, {key_hash: createHash('sha256').update(randomBytes(16)).digest('hex'), key_type: 'publishable'});
      live.store._tx = original; assert.equal(raced, true); assert.equal(stale.status, 409, await stale.clone().text());
      await refusedInvite(await newKey('default'), 403, 'workspace_admin_required');
      await ok(await define({id: role.id, name: 'Auditor', base: 'developer', environments: null}));
    }
    // A role limit and a member's own limit both apply: the member reaches only what both allow.
    {
      const narrow = await ok(await define({name: 'Staging only', base: 'developer', environments: ['staging']}), 201);
      const both = await ok(await post(live, owner, 'workspaces/invite', {recipient_id: other.tenant, role: narrow.id, environments: ['default', 'staging']}), 201); await ok(await post(live, other, 'workspaces/accept', {workspace_id: org, token: both.token}));
      assert.deepEqual((await ok(await get(live, other, 'workspaces'))).workspaces.find(w => w.workspace_id === org).environments, ['staging']);
      assert.equal((await get(live, other, 'runs' + q + '&environment=staging')).status, 200); await refusedInvite(await get(live, other, 'runs' + q), 403, 'environment_unavailable');
      // Limits that share nothing leave no environment at all.
      const row = (await ok(await get(live, owner, 'workspaces/members'))).members.find(m => m.user_id === other.tenant);
      await ok(await post(live, owner, 'workspaces/member', {user_id: other.tenant, role: narrow.id, version: row.version, environments: ['default']}));
      await refusedInvite(await get(live, other, 'runs' + q), 403, 'environment_unavailable'); await refusedInvite(await get(live, other, 'runs' + q + '&environment=staging'), 403, 'environment_unavailable');
      const again = (await ok(await get(live, owner, 'workspaces/members'))).members.find(m => m.user_id === other.tenant);
      await ok(await post(live, owner, 'workspaces/member', {user_id: other.tenant, role: 'removed', version: again.version}));
      assert.deepEqual(await ok(await post(live, owner, 'orgs/roles/delete', {organization_id: org, id: narrow.id})), {deleted: true});
    }
    // A role in use cannot be deleted; an unused one can, and its id then cannot be assigned.
    await refusedInvite(await post(live, owner, 'orgs/roles/delete', {organization_id: org, id: role.id}), 409, 'role_in_use');
    const spare = await ok(await define({name: 'Spare', base: 'admin', environments: null}), 201);
    assert.deepEqual(await ok(await post(live, owner, 'orgs/roles/delete', {organization_id: org, id: spare.id})), {deleted: true});
    await refusedInvite(await post(live, owner, 'workspaces/invite', {recipient_id: other.tenant, role: spare.id}), 400, 'invalid_member_role');

    // Downgrade: the member keeps membership but only reads, and the key they issued stops. New assignments are refused.
    plan('pro');
    assert.equal((await get(live, member, 'runs' + q)).status, 200);
    await refusedInvite(await newKey('default'), 403, 'workspace_admin_required');
    assert.notEqual((await upload('after-downgrade')).status, 201);
    await locked(await post(live, owner, 'workspaces/invite', {recipient_id: other.tenant, role: role.id}), 'custom_roles', 'pro');
    await locked(await define({name: 'Another', base: 'viewer', environments: null}), 'custom_roles', 'pro');
    // The owner can still move the member to a built-in role and then remove the definition.
    const version = (await ok(await get(live, owner, 'workspaces/members'))).members.find(m => m.user_id === member.tenant).version;
    await ok(await post(live, owner, 'workspaces/member', {user_id: member.tenant, role: 'developer', version}));
    assert.deepEqual(await ok(await post(live, owner, 'orgs/roles/delete', {organization_id: org, id: role.id})), {deleted: true});
    const actions = (await ok(await get(live, owner, 'audit'))).events.map(event => event.action);
    for (const action of ['role.create', 'role.update', 'role.delete']) assert.ok(actions.includes(action), action);
  } finally { await live.close(); }
});
async function refusedInvite(response, status, code) { assert.equal(response.status, status, await response.clone().text()); assert.equal((await response.json()).error, code); }

test('the service-wide caps leave room for what a self-serve plan promises one organization', async () => {
  const {SERVICE_CAPS} = await import('../aws/handler.mjs');
  for (const plan of PLANS.plans.filter(item => item.checkout)) assert.ok(SERVICE_CAPS.globalBytes >= planLimits(plan.id).stored_bytes, plan.id + ' stored data fits under the service cap');
  assert.ok(SERVICE_CAPS.accounts >= 1000);
});

test('a drain delivery queued for an environment that is then deleted is dropped, never sent', async () => {
  const sent = [], {live, owner, plan} = await world('pro', {configureEnvironment: env => { env.drainTransport = async request => { sent.push(JSON.parse(request.body)); return {ok: sent.length > 1, status: sent.length > 1 ? 204 : 500}; }; }}); try {
    await ok(await post(live, owner, 'environments', {id: 'staging', name: 'Staging'}), 201); await ok(await post(live, owner, 'drains', {url: 'https://hooks.example.com/t'}), 201);
    const key = 'st_pub_' + randomBytes(32).toString('base64url'); await ok(await post(live, owner, 'keys/create?environment=staging', {key_hash: createHash('sha256').update(key).digest('hex'), key_type: 'publishable'}), 201);
    const raw = JSON.stringify({version: 1, batch_id: 'b1', run_id: 'r1', events: [{id: 'e1', time: '2026-11-15T00:00:00.000Z', kind: 'note', name: 'secret staging trace', data: {}}]});
    assert.equal((await fetch(live.origin + '/api/batches?environment=staging', {method: 'POST', headers: {'content-type': 'application/json', 'x-supatrace-key': key, 'x-amz-content-sha256': createHash('sha256').update(raw).digest('hex')}, body: raw})).status, 201);
    // The endpoint failed once, so the delivery is still queued when the environment is deleted.
    assert.equal(sent.length, 1); assert.equal((await ok(await get(live, owner, 'drains'))).drains[0].queued, 1);
    await ok(await post(live, owner, 'environments/delete', {id: 'staging', confirm: 'staging'}));
    assert.deepEqual(await ok(await post(live, owner, 'drains/flush', {})), {attempted: 0, delivered: 0, failed: 1});
    assert.equal(sent.length, 1, 'nothing more was sent'); const drain = (await ok(await get(live, owner, 'drains'))).drains[0]; assert.equal(drain.queued, 0);
  } finally { await live.close(); }
});


test('environment deletion exposes interrupted key cleanup and retries without releasing capacity twice', async () => {
 const {live,owner}=await world('base');try{
  await ok(await post(live,owner,'environments',{id:'staging',name:'Staging'}),201);
  const keyHash=createHash('sha256').update(randomBytes(32)).digest('hex');
  await ok(await post(live,owner,'keys/create?environment=staging',{key_hash:keyHash,key_type:'publishable'}),201);
  const revoke=live.store.revokeWriteKey;let fail=true;
  live.store.revokeWriteKey=async function(...args){if(fail)throw Error('synthetic temporary failure');return revoke.apply(this,args);};
  const interrupted=await post(live,owner,'environments/delete',{id:'staging',confirm:'staging'});
  assert.equal(interrupted.status,503);assert.equal((await interrupted.json()).error,'environment_key_cleanup_pending');
  assert.equal((await get(live,owner,'runs?environment=staging')).status,403);
  let list=await ok(await get(live,owner,'environments'));assert.deepEqual(list.pending_deletions,[{id:'staging',name:'Staging'}]);assert.deepEqual(list.environments.map(e=>e.id),['default']);
  fail=false;assert.deepEqual(await ok(await post(live,owner,'environments/delete',{id:'staging',confirm:'staging'})),{deleted:true,id:'staging',keys_revoked:1});
  assert.deepEqual((await ok(await get(live,owner,'environments'))).pending_deletions,[]);
  assert.equal((await ok(await get(live,owner,'entitlements'))).usage.api_keys,0);
  for(const id of ['dev','qa'])await ok(await post(live,owner,'environments',{id,name:id}),201);
  await full(await post(live,owner,'environments',{id:'extra',name:'Extra'}),'environments','base',3);
 }finally{await live.close();}
});
