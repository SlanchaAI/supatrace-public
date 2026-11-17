// Stripe TEST-mode self-serve upgrade (#114), end to end in the local harness: Free -> Base (Checkout) -> Pro
// (portal change) -> cancel, with the enforced plan limits following each signed, worker-reconciled event.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {start} from './harness.mjs';
import {configureLocalBilling, configuration} from '../scripts/local-billing.mjs';
import {seedLocalWorkspace} from '../scripts/dev.mjs';
import {DynamoMetadataStore} from '../src/dynamodb-store.mjs';
import {validateSandboxEntitlementConfiguration, TEST_PLAN_LIMITS} from '../src/stripe-sandbox-entitlements.mjs';
import {buildStripeSandboxRuntime} from '../src/stripe-runtime.mjs';
import {commercialPolicyHash} from '../src/commercial-policy.mjs';
import {stripeTestCatalogHash} from '../src/stripe-test-checkout.mjs';
import {PLAN_LIMITS} from '../src/plan-limits.mjs';
import {PLANS} from '../src/plans.mjs';

const owner = 'github-4242', sha = value => createHash('sha256').update(value).digest('hex');
async function harness(options = {planLimits: true}) {
  let billing; const live = await start({localDev: true, configureEnvironment: async env => { billing = env.localBilling = await configureLocalBilling(env, options); }});
  await seedLocalWorkspace(live); let cookie;
  await live.signIn({addCookies: async v => { cookie = v.map(c => c.name + '=' + c.value).join('; '); }}, 4242);
  const get = async path => { const r = await fetch(live.origin + path, {headers: {cookie}}); assert.equal(r.status, 200, path + ' ' + await r.clone().text()); return r.json(); };
  const post = (path, body) => fetch(live.origin + path, {method: 'POST', headers: {cookie, origin: live.origin, 'content-type': 'application/json'}, body: JSON.stringify(body)});
  const row = () => live.store._get({pk: 'TENANT#' + owner, sk: 'META'});
  const reserve = id => live.store.reserveBatch(owner, {batch_id: id, run_id: 'run-upgrade', request_hash: sha(id), byte_count: 100, event_count: 1});
  return {live, billing, get, post, row, reserve};
}
const checkout = (h, plan, request = 'checkout_test_1234567890abcdef') => h.post('/api/billing/checkout', {plan_id: plan, policy_version: 'stripe-test-plans-v1', request_id: request});

test('Free -> Base -> Pro -> cancel in Stripe test mode: the enforced limits follow every step', {timeout: 60000}, async () => {
  const h = await harness();
  try {
    const period = (await h.live.store.getPlanUsage(owner)).period, free = PLAN_LIMITS.plans.free, base = PLAN_LIMITS.plans.base, pro = PLAN_LIMITS.plans.pro;
    const limits = async () => { const u = await h.get('/api/usage'); return [u.plan_limits.plan_id, u.plan_limits.spans_per_month, u.plan_limits.stored_bytes, u.plan_limits.retention_days]; };
    assert.deepEqual(await limits(), ['free', free.spans_per_month, free.stored_bytes, free.retention_days]);
    // The server offers the Checkout plans, Base and Pro, with the limits each would give, at the approved monthly
    // price in cents, in test mode. Enterprise is assigned by an operator and is not offered.
    const usage = await h.get('/api/usage');
    assert.equal(usage.billing.test_plan_limits, true); assert.equal(usage.billing.purchases_enabled, false); assert.equal(usage.commercial.test_plan_limits, true);
    assert.deepEqual(usage.commercial.plans.map(p => [p.id, p.unit_amount, p.limits.spans_per_month]), [['base', 999, base.spans_per_month], ['pro', 2599, pro.spans_per_month]]);
    // Free is at its allowance: the next span is refused.
    await h.live.store._send('UpdateCommand', {Key: {pk: 'TENANT#' + owner, sk: 'USAGE#' + period.id}, UpdateExpression: 'SET spans = :spans', ExpressionAttributeValues: {':spans': free.spans_per_month}});
    await assert.rejects(h.reserve('on-free'), error => error.status === 429 && error.code === 'monthly_span_allowance_exceeded');
    // Upgrade: Checkout -> signed checkout.session.completed -> capture -> stream worker -> reconciliation.
    const opened = await checkout(h, 'base'); assert.equal(opened.status, 201, await opened.clone().text());
    const session = await opened.json(); assert.equal(session.livemode, false); assert.equal(session.purchases_enabled, false);
    assert.deepEqual(await h.billing.complete(session.session_id, owner), {synthetic: true, paid_access: false, quota_changed: true});
    assert.deepEqual(await limits(), ['base', base.spans_per_month, base.stored_bytes, base.retention_days]);
    const account = await h.row(); assert.equal(account.plan_id, 'base'); assert.equal(account.plan_source, 'stripe_test');
    const preview = await h.get('/api/billing/sandbox-entitlement');
    assert.equal(preview.status, 'active'); assert.equal(preview.plan_id, 'base'); assert.equal(preview.quota_enforced, true); assert.equal(preview.plan_limits, 'stripe_test_mode');
    assert.equal(preview.paid_access, false); assert.equal(preview.livemode, false); assert.equal(preview.storage_limit_bytes, undefined);
    await h.reserve('on-base');   // the same upload that Free refused is accepted
    // Base stops at its allowance and has no spend cap to switch: the owner is told which plan has it.
    const capOnBase = await h.post('/api/billing/spend-cap', {enabled: false}); assert.equal(capOnBase.status, 402);
    assert.deepEqual((({error, feature, plan, required_plan}) => ({error, feature, plan, required_plan}))(await capOnBase.json()), {error: 'plan_upgrade_required', feature: 'spend_cap', plan: 'base', required_plan: 'pro'}); assert.equal((await h.row()).spend_cap, undefined);
    // Replaying the captured event neither calls Stripe again nor changes the account.
    const calls = h.billing.calls.length, before = await h.row();
    assert.deepEqual(await h.billing.replayCaptured('evt_checkout' + session.session_id.slice(8)), {batchItemFailures: []});
    assert.equal(h.billing.calls.length, calls); assert.deepEqual(await h.row(), before);
    // The portal session is a TEST one that can change or cancel the subscription.
    const portal = await h.post('/api/billing/portal', {}); assert.equal(portal.status, 201, await portal.clone().text());
    const opening = await portal.json(); assert.equal(opening.sandbox, true); assert.equal(opening.read_only, false); assert.equal(opening.purchases_enabled, false);
    // Base -> Pro is a subscription update; the proration invoice is paid in full.
    assert.deepEqual(await h.billing.changePlan(owner, 'pro'), {synthetic: true, plan_id: 'pro'});
    assert.deepEqual(await limits(), ['pro', pro.spans_per_month, pro.stored_bytes, pro.retention_days]);
    assert.equal((await h.row()).plan_source, 'stripe_test'); assert.equal((await h.get('/api/billing/sandbox-entitlement')).plan_id, 'pro');
    // Enterprise and Free are not portal targets.
    for (const plan of ['enterprise', 'free', 'team']) await assert.rejects(h.billing.changePlan(owner, plan), /Synthetic portal change unavailable/);
    assert.equal((await h.row()).plan_id, 'pro');
    // This local legacy simulator has no real TEST meter: it cannot authorize cap-off. A stale choice is
    // still removed on cancellation; the hosted meter's happy path is exercised in plan-overage.test.mjs.
    assert.equal((await h.post('/api/billing/spend-cap', {enabled: false})).status, 503);
    await h.live.store._send('UpdateCommand', {Key:{pk:'TENANT#'+owner,sk:'META'},UpdateExpression:'SET spend_cap = :off',ExpressionAttributeValues:{':off':false}});
    assert.deepEqual(await h.billing.cancel(owner), {synthetic: true, plan_id: 'free'});
    assert.deepEqual(await limits(), ['free', free.spans_per_month, free.stored_bytes, free.retention_days]);
    const ended = await h.row(); assert.equal(ended.plan_id, undefined); assert.equal(ended.plan_source, undefined); assert.equal(ended.spend_cap, undefined);
    assert.equal((await h.get('/api/billing/sandbox-entitlement')).status, 'blocked');
    await assert.rejects(h.reserve('free-again'), error => error.status === 429 && error.code === 'monthly_span_allowance_exceeded');
    // Every Stripe call went to the in-process fixture.
    assert.ok(h.billing.calls.length > 0); assert.ok(h.billing.calls.every(path => path.startsWith('/v1/')));
  } finally { await h.live.close(); }
});

test('test-mode steps stay ordered when a reconciliation is stamped a second after its step began', {timeout: 30000}, async t => {
  // #184: the worker reads the watermark and then stamps the reconciliation with the wall clock. Here the clock moves
  // one second forward at that point of the first step, which is what a second boundary on a slow runner does. The
  // next step must still reconcile; it used to start in the stamped second and be refused as a watermark conflict.
  let offset = 0, armed = false, jumps = 0; const real = Date.now.bind(Date), read = DynamoMetadataStore.prototype.getStripeTestReconciliationWatermark;
  t.mock.method(Date, 'now', () => real() + offset);
  t.mock.method(DynamoMetadataStore.prototype, 'getStripeTestReconciliationWatermark', async function (...args) { const value = await read.apply(this, args); if (armed) { armed = false; jumps++; offset += 1000; } return value; });
  const h = await harness();
  try {
    const opened = await checkout(h, 'base'); assert.equal(opened.status, 201, await opened.clone().text());
    armed = true; await h.billing.complete((await opened.json()).session_id, owner); assert.equal(jumps, 1);
    assert.equal((await h.row()).plan_id, 'base');
    assert.deepEqual(await h.billing.changePlan(owner, 'pro'), {synthetic: true, plan_id: 'pro'});
    assert.equal((await h.row()).plan_id, 'pro');
    assert.deepEqual(await h.billing.cancel(owner), {synthetic: true, plan_id: 'free'});
  } finally { await h.live.close(); }
});

test('a plan some other source assigned is never overwritten by a test-mode reconciliation', {timeout: 30000}, async () => {
  const h = await harness();
  try {
    await h.live.store._send('UpdateCommand', {Key: {pk: 'TENANT#' + owner, sk: 'META'}, UpdateExpression: 'SET plan_id = :plan', ExpressionAttributeValues: {':plan': 'enterprise'}});   // as an operator assigns Enterprise
    const session = await (await checkout(h, 'pro')).json();
    await assert.rejects(h.billing.complete(session.session_id, owner), /Synthetic stream reconciliation failed/);
    const account = await h.row(); assert.equal(account.plan_id, 'enterprise'); assert.equal(account.plan_source, undefined);
    assert.equal((await h.get('/api/usage')).plan_limits.spans_per_month, PLAN_LIMITS.plans.enterprise.spans_per_month);
  } finally { await h.live.close(); }
});

test('without the opt-in the same path never touches the account plan', {timeout: 30000}, async () => {
  const h = await harness({});
  try {
    const before = await h.row(), opened = await h.post('/api/billing/checkout', {plan_id: 'synthetic-paid', policy_version: 'synthetic-v1', request_id: 'checkout_test_1234567890abcdef'});
    assert.equal(opened.status, 201); assert.deepEqual(await h.billing.complete((await opened.json()).session_id, owner), {synthetic: true, paid_access: false, quota_changed: false});
    assert.deepEqual(await h.row(), before);
    const usage = await h.get('/api/usage'); assert.equal(usage.plan_limits.plan_id, 'free'); assert.equal(usage.billing.test_plan_limits, undefined); assert.equal(usage.commercial.test_plan_limits, undefined);
    const preview = await h.get('/api/billing/sandbox-entitlement'); assert.equal(preview.quota_enforced, false); assert.equal(preview.plan_limits, undefined);
    assert.equal((await h.post('/api/billing/portal', {})).status, 503);   // portal stays off
  } finally { await h.live.close(); }
});

test('the opt-in is test mode only and only for plans the limits table enforces', async () => {
  const good = configuration('api', {planLimits: true}).entitlements, ceiling = 10485760;
  assert.equal(validateSandboxEntitlementConfiguration(good, ceiling).planLimits, true);
  assert.equal(validateSandboxEntitlementConfiguration(configuration().entitlements, ceiling).planLimits, false);
  const variant = edit => { const c = structuredClone(good); edit(c); c.policyHash = commercialPolicyHash(c.policy); c.catalog.revision = c.policyHash; c.catalogHash = stripeTestCatalogHash(c.catalog); return c; };
  const refused = (c, code) => assert.throws(() => validateSandboxEntitlementConfiguration(c, ceiling), error => error.code === code, code);
  refused({...good, planLimits: true}, 'sandbox_entitlement_policy_mismatch');
  refused({...good, planLimits: 'live'}, 'sandbox_entitlement_policy_mismatch');
  refused(variant(c => { c.policy.livemode = true; }), 'sandbox_entitlement_policy_mismatch');
  // The synthetic fixture plans are not plans the limits table knows, so they cannot assign limits.
  refused({...configuration().entitlements, planLimits: TEST_PLAN_LIMITS}, 'sandbox_entitlement_plan_limits_mismatch');
  // Nor is a plan the table no longer has.
  refused(variant(c => { c.policy.plans[1].id = 'team'; }), 'sandbox_entitlement_plan_limits_mismatch');
  // The rehearsal offers Free plus exactly the plans sold through Checkout, at the plan table's monthly price in
  // cents, so it cannot drift from the table. The literal cents are stated here once: a silent price change fails.
  assert.deepEqual(good.policy.plans.map(p => p.id), ['free', ...PLANS.plans.filter(p => p.checkout === true).map(p => p.id)]);
  for (const plan of good.policy.plans) assert.equal(plan.unit_amount, Math.round(PLANS.plans.find(p => p.id === plan.id).monthly_base_usd * 100));
  assert.deepEqual(good.policy.plans.map(p => [p.id, p.price_id, p.unit_amount]), [['free', null, 0], ['base', 'price_testbase', 999], ['pro', 'price_testpro', 2599]]);
  assert.deepEqual(Object.entries(good.catalog.prices).map(([id, price]) => [id, price.unit_amount, price.currency, price.interval]), [['price_testbase', 999, 'usd', 'month'], ['price_testpro', 2599, 'usd', 'month']]);
});

test('Enterprise is assigned by an operator: a test-mode policy that sells it through Checkout is refused', () => {
  // The plan table marks Enterprise checkout:false with no price. A reconciled test subscription must not be able to
  // put an account on it, so a policy that prices it is not a valid plan-limits policy.
  assert.equal(PLANS.plans.find(p => p.id === 'enterprise').checkout, false); assert.equal(PLANS.plans.find(p => p.id === 'enterprise').monthly_base_usd, null);
  const c = structuredClone(configuration('api', {planLimits: true}).entitlements); c.policy.plans[1].id = 'enterprise';
  c.policyHash = commercialPolicyHash(c.policy); c.catalog.revision = c.policyHash; c.catalogHash = stripeTestCatalogHash(c.catalog);
  assert.throws(() => validateSandboxEntitlementConfiguration(c, 10485760), error => error.code === 'sandbox_entitlement_plan_limits_mismatch');
});

test('live Stripe credentials and live objects are refused on this path', async () => {
  const hooks = key => ({awsAccountId: '123456789012', awsRegion: 'us-east-1', StripeClient: function () {}, authorize: async () => true, loadSecret: async arn => arn.includes('endpoint-') ? 'whsec_' + 's'.repeat(24) : key});
  const runtime = configuration('api', {planLimits: true}).runtime;
  for (const key of ['sk_live_' + 'x'.repeat(24), 'rk_live_' + 'x'.repeat(24), 'sk_test_' + 'x'.repeat(24)])
    await assert.rejects(buildStripeSandboxRuntime(runtime, hooks(key)), error => error.status === 503 && error.code === 'stripe_runtime_credentials_unavailable', key.slice(0, 8));
  assert.equal((await buildStripeSandboxRuntime(runtime, hooks('rk_test_' + 'x'.repeat(24)))).purchasesEnabled, false);
  await assert.rejects(buildStripeSandboxRuntime({...runtime, purchasesEnabled: true}, hooks('rk_test_' + 'x'.repeat(24))), error => error.code === 'invalid_stripe_runtime_configuration');
  const livemode = structuredClone(runtime); livemode.catalog.livemode = true;
  await assert.rejects(buildStripeSandboxRuntime(livemode, hooks('rk_test_' + 'x'.repeat(24))), error => error.code === 'explicit_test_catalog_required');
});

test('Billing has the upgrade control and the pricing link, and the portal manage path is test-mode gated', () => {
  const html = readFileSync(new URL('../public/app/index.html', import.meta.url), 'utf8'), app = readFileSync(new URL('../public/app/app.js', import.meta.url), 'utf8');
  assert.equal(html.split('<a href="/pricing">Compare the plans</a>').length, 3);
  assert.match(app, /'Upgrade with test Checkout'/); assert.match(app, /billingTestPlans\?typeof result\.read_only!=='boolean':result\.read_only!==true/);
});
