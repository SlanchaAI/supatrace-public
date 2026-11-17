// Stripe plan billing (src/plan-billing.mjs), against the real handler and the real Stripe SDK. The SDK's
// HTTP client is an in-process stand-in for api.stripe.com that refuses any route it does not model, so no request
// leaves the machine. Webhook signatures are made and verified by the SDK's own code.
import test from 'node:test';
import './plan-billing-handler.test.mjs';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import {start} from './harness.mjs';
import {DynamoMetadataStore} from '../src/dynamodb-store.mjs';
import {PLANS} from '../src/plans.mjs';
import {composePlanBilling, lookupKey, operatorPlanUpdate, STRIPE_PLAN_SOURCE, OPERATOR_PLAN_SOURCE} from '../src/plan-billing.mjs';

const KEY = 'sk_test_' + 'k'.repeat(24), WEBHOOK = 'whsec_' + 'w'.repeat(24), PRICES = {base: 'price_testBase01', pro: 'price_testPro001'};
const amount = id => Math.round(PLANS.plans.find(plan => plan.id === id).monthly_base_usd * 100);

/** A small model of the Stripe account: prices by lookup key, customers, Checkout sessions, subscriptions, a portal. */
function fakeStripe({livemode = false, prices = null, portal = true, liveKinds = []} = {}) {
  const state = {calls: [], customers: new Map(), sessions: new Map(), subscriptions: new Map(), livemode, n: 0};
  const meter = {id:'mtr_test_overage',livemode,status:'active',event_name:'supatrace_pro_overage',default_aggregation:{formula:'sum'},customer_mapping:{type:'by_id',event_payload_key:'stripe_customer_id'},value_settings:{event_payload_key:'value'}};
  const overage = {id:'price_testOverage',object:'price',active:true,livemode,lookup_key:'supatrace_pro_overage_monthly',currency:'usd',billing_scheme:'per_unit',unit_amount_decimal:'0.0005',recurring:{interval:'month',interval_count:1,usage_type:'metered',meter:meter.id}};
  const priceList = prices ?? [...Object.entries(PRICES).map(([plan, id]) => ({id, object: 'price', active: true, livemode, lookup_key: lookupKey(plan), currency: 'usd', unit_amount: amount(plan), recurring: {interval: 'month', interval_count: 1, usage_type:'licensed'}})),overage];
  const list = data => ({object: 'list', data, has_more: false});
  const client = function (key, options) { state.options = options; return new Stripe(key, {...options, httpClient: Stripe.createFetchHttpClient(async (url, request) => {
    const u = new URL(url), body = new URLSearchParams(request.body ?? ''), route = request.method + ' ' + u.pathname; state.calls.push(route);
    if (u.origin !== 'https://api.stripe.com') throw new Error('network forbidden in tests');
    // A Stripe outage: an error answer, or no answer at all, for one route.
    if (state.broken === route) return new Response(JSON.stringify({error: {type: 'api_error', message: 'Stripe is unavailable.'}}), {status: 500, headers: {'content-type': 'application/json', 'request-id': 'req_test'}});
    if (state.hung === route) return new Promise(() => {});
    if (state.delay) await new Promise(resolve => setTimeout(resolve, state.delay));
    let object;
    if (route === 'GET /v1/prices') object = list(priceList.filter(price => u.searchParams.getAll('lookup_keys[]').concat(u.searchParams.getAll('lookup_keys[0]'), u.searchParams.getAll('lookup_keys[1]')).includes(price.lookup_key)));
    else if (route === 'GET /v1/billing/meters/' + meter.id) object = meter;
    else if (route === 'GET /v1/billing_portal/configurations') object = list(portal ? [{id: 'bpc_test1', object: 'billing_portal.configuration', active: true, livemode, metadata: {app: 'supatrace'}}] : []);
    else if (route === 'POST /v1/customers') { const org = body.get('metadata[supatrace_org]'), id = 'cus_' + Buffer.from(org).toString('hex').slice(0, 20); object = {id, object: 'customer', livemode, metadata: {supatrace_org: org}}; state.customers.set(id, object); state.idempotency = new Headers(request.headers).get('idempotency-key'); }
    else if (request.method === 'GET' && u.pathname.startsWith('/v1/customers/')) object = state.customers.get(u.pathname.split('/').at(-1)) ?? {id:u.pathname.split('/').at(-1),object:'customer',livemode};
    else if (route === 'POST /v1/checkout/sessions') {
      const id = 'cs_test_' + (++state.n);
      object = {id, object: 'checkout.session', livemode, mode: body.get('mode'), customer: body.get('customer'), client_reference_id: body.get('client_reference_id'), price: body.get('line_items[0][price]'), billing_address_collection:body.get('billing_address_collection'), allow_promotion_codes:body.get('allow_promotion_codes'), success_url: body.get('success_url'), cancel_url: body.get('cancel_url'),
        metadata: {supatrace_org: body.get('metadata[supatrace_org]'), plan: body.get('metadata[plan]')}, subscription_org: body.get('subscription_data[metadata][supatrace_org]'), url: 'https://checkout.stripe.com/c/pay/' + id};
      state.sessions.set(id, object);
    }
    else if (route === 'GET /v1/subscriptions') object = list([...state.subscriptions.values()].filter(sub => sub.customer === u.searchParams.get('customer')));
    else if (request.method === 'GET' && u.pathname.startsWith('/v1/subscriptions/')) object = state.subscriptions.get(u.pathname.split('/').at(-1));
    else if (request.method === 'POST' && u.pathname.startsWith('/v1/subscriptions/')) {
      const sub = state.subscriptions.get(u.pathname.split('/').at(-1));
      state.updateBody = Object.fromEntries(body); state.updateIdempotency = new Headers(request.headers).get('idempotency-key');
      if (state.pending) {
        sub.pending_update = {expires_at: 1800000000}; sub.latest_invoice = {livemode, hosted_invoice_url: 'https://invoice.stripe.com/i/test_pending'};
      } else if (!body.get('items[0][id]')) sub.items.data.push({id:'si_meter',price:overage});
      else sub.items.data.find(item => item.id === body.get('items[0][id]')).price.id = body.get('items[0][price]');
      object = sub;
    }
    else if (route === 'POST /v1/billing_portal/sessions') object = {id: 'bps_1', object: 'billing_portal.session', livemode, customer: body.get('customer'), configuration: body.get('configuration'), return_url: body.get('return_url'), url: 'https://billing.stripe.com/p/session/test_1'};
    if (!object) throw new Error('unmodelled Stripe route ' + route);
    // A single kind of object can be made live-mode, to prove each read refuses it.
    if (liveKinds.includes(object.object)) object = {...object, livemode: !livemode}; else if (object.object === 'list' && object.data.some(item => liveKinds.includes(item.object))) object = {...object, data: object.data.map(item => ({...item, livemode: !livemode}))};
    const snapshot = JSON.stringify(object);
    if (route === 'GET /v1/subscriptions' && state.pause) { const pause = state.pause; state.pause = null; pause.enter(); await pause.wait; }
    return new Response(snapshot, {headers: {'content-type': 'application/json', 'request-id': 'req_test'}});
  })}); };
  /** What paying at Checkout does in Stripe: an active subscription on the session's customer and price. */
  state.pay = (session, {status = 'active'} = {}) => { const id = 'sub_' + (++state.n), s = state.sessions.get(session); const sub = {id, object: 'subscription', livemode, customer: s.customer, status, cancel_at_period_end: false, metadata: {supatrace_org: s.subscription_org}, items: {data: [{id: 'si_fixed' + state.n, price: {id: s.price,livemode}, current_period_end: 1800000000}]}}; state.subscriptions.set(id, sub); return sub; };
  return {client, state};
}
async function world({mode='test',stripe = fakeStripe({livemode:mode==='live'}), webhookSecret = WEBHOOK} = {}) {
  let environment; const live = await start({configureEnvironment: env => { environment = env; env.planBilling = composePlanBilling({secretKey: 'sk_'+mode+'_'+'k'.repeat(24), webhookSecret, StripeClient: stripe.client}); }});
  let cookie = ''; const tenant = await live.signIn({addCookies: async value => { cookie = value.map(c => c.name + '=' + c.value).join('; '); }}, 4242);
  const call = (method, path, data, who = cookie) => fetch(live.origin + '/api/' + path, {method, headers: {cookie: who, origin: live.origin, ...(method === 'POST' ? {'content-type': 'application/json'} : {})}, ...(method === 'POST' ? {body: JSON.stringify(data ?? {})} : {})});
  const row = () => live.store.client.items.get('TENANT#' + tenant + '\0META');
  const hook = async (event, secret = WEBHOOK) => { const payload = JSON.stringify({id: 'evt_' + Math.random().toString(36).slice(2), object: 'event', livemode: mode==='live', ...event}), signer = new Stripe(KEY); return fetch(live.origin + '/api/billing/webhook', {method: 'POST', headers: {'content-type': 'application/json', 'stripe-signature': await signer.webhooks.generateTestHeaderStringAsync({payload, secret})}, body: payload}); };
  return {live, tenant, call, row, hook, state: stripe.state, environment};
}
const ok = async (response, status = 200) => { assert.equal(response.status, status, await response.clone().text()); return response.json(); };
const refused = async (response, status, code) => { assert.equal(response.status, status, await response.clone().text()); assert.equal((await response.json()).error, code); };

test('paid plan changes preserve usage items, wait for payment and reconcile the Stripe price', async () => {
  const w = await world(); try {
    await refused(await w.call('POST', 'billing/change', {plan: 'pro'}), 409, 'no_subscription');
    await ok(await w.call('POST', 'billing/subscribe', {plan: 'base'}));
    const sub = w.state.pay([...w.state.sessions.keys()][0]); await ok(await w.call('POST', 'billing/sync', {}));
    const usage = {id: 'si_meter', price: {id: 'price_usage',livemode:false}}; sub.items.data.push(usage);
    for (const body of [{plan: 'free'}, {plan: 'enterprise'}, {plan: 'pro', extra: true}]) await refused(await w.call('POST', 'billing/change', body), 400, 'invalid_billing_request');
    w.state.pending = true;
    const pending = await ok(await w.call('POST', 'billing/change', {plan: 'pro'}));
    assert.equal(pending.payment_pending, true); assert.match(pending.url, /^https:\/\/invoice\.stripe\.com\//);
    assert.equal(w.row().plan_id, 'base'); assert.equal((await w.call('GET', 'audit')).status, 402);
    assert.equal(w.state.updateBody.payment_behavior, 'pending_if_incomplete');
    assert.equal(w.state.updateBody.proration_behavior, 'always_invoice');
    assert.equal(w.state.updateBody['items[0][id]'], sub.items.data[0].id);
    assert.equal(Object.keys(w.state.updateBody).some(key => key.startsWith('items[1]')), false);
    const count = w.state.calls.filter(route => route === 'POST /v1/subscriptions/' + sub.id).length;
    await ok(await w.call('POST', 'billing/change', {plan: 'pro'}));
    assert.equal(w.state.calls.filter(route => route === 'POST /v1/subscriptions/' + sub.id).length, count, 'retry reopens the existing invoice');
    // Payment applies the pending update in Stripe; only then can the feature unlock.
    delete sub.pending_update; sub.items.data[0].price.id = PRICES.pro; w.state.pending = false;
    assert.equal((await ok(await w.call('POST', 'billing/change', {plan: 'pro'}))).plan, 'pro');
    assert.equal((await w.call('GET', 'audit')).status, 200);
    assert.equal((await ok(await w.call('POST', 'billing/change', {plan: 'base'}))).plan, 'base');
    assert.equal((await w.call('GET', 'audit')).status, 402); assert.deepEqual(sub.items.data[1], usage);
    sub.cancel_at_period_end = true;
    await refused(await w.call('POST', 'billing/change', {plan: 'pro'}), 409, 'subscription_not_changeable');
    sub.cancel_at_period_end = false; sub.status = 'past_due';
    await refused(await w.call('POST', 'billing/change', {plan: 'pro'}), 409, 'subscription_not_changeable');
    sub.status = 'active'; sub.customer = 'cus_foreign';
    await refused(await w.call('POST', 'billing/change', {plan: 'pro'}), 409, 'billing_changed');
    sub.customer = w.row().stripe_customer_id; sub.livemode = true;
    await refused(await w.call('POST', 'billing/change', {plan: 'pro'}), 503, 'plan_billing_live_mode_refused');
  } finally { await w.live.close(); }
});

test('secret and restricted keys compose their mode; public and malformed keys are refused', () => {
  const {client} = fakeStripe();
  for (const bad of ['pk_live_' + 'k'.repeat(24), 'pk_test_' + 'k'.repeat(24), 'sk_test_short', '', null, undefined, 'sk_test_' + 'k'.repeat(24) + ' ']) assert.throws(() => composePlanBilling({secretKey: bad, StripeClient: client}), /plan_billing_test_key_required/, String(bad));
  for (const bad of ['secret', 'whsec_short', 7]) assert.throws(() => composePlanBilling({secretKey: KEY, webhookSecret: bad, StripeClient: client}), /plan_billing_webhook_secret_invalid/);
  assert.throws(() => composePlanBilling({secretKey: KEY}), /plan_billing_client_required/);
  for(const mode of ['test','live'])for(const prefix of ['sk','rk'])assert.equal(composePlanBilling({secretKey: prefix+'_'+mode+'_'+'k'.repeat(24), StripeClient:client}).mode,mode);
});

test('without plan billing configured the catalog still lists the plans and says checkout is unavailable', async () => {
  const live = await start(); try {
    let cookie = ''; await live.signIn({addCookies: async value => { cookie = value.map(c => c.name + '=' + c.value).join('; '); }}, 4242);
    const get = path => fetch(live.origin + '/api/' + path, {headers: {cookie}}), post = (path, data) => fetch(live.origin + '/api/' + path, {method: 'POST', headers: {cookie, origin: live.origin, 'content-type': 'application/json'}, body: JSON.stringify(data)});
    const catalog = await ok(await get('billing/catalog'));
    assert.deepEqual([catalog.checkout_available, catalog.mode, catalog.current_plan, catalog.portal_available], [false, 'unavailable', 'free', false]);
    assert.deepEqual(catalog.plans.map(plan => [plan.id, plan.monthly_usd_cents, plan.action]), [['free', 0, 'none'], ['base', 999, 'unavailable'], ['pro', 2599, 'unavailable'], ['enterprise', null, 'contact_sales']]);
    await refused(await post('billing/subscribe', {plan: 'base'}), 503, 'plan_billing_unavailable');
    await refused(await post('billing/sync', {}), 503, 'plan_billing_unavailable');
  } finally { await live.close(); }
});

test('Free to Base by Checkout, Base to Pro in the portal, then cancel: each step moves the enforced plan only after Stripe says so', async () => {
  const {live, tenant, call, row, state} = await world(); try {
    let catalog = await ok(await call('GET', 'billing/catalog'));
    assert.deepEqual([catalog.checkout_available, catalog.mode, catalog.test_mode, catalog.current_plan], [true, 'stripe_test', true, 'free']);
    assert.deepEqual(catalog.plans.map(plan => [plan.id, plan.action]), [['free', 'none'], ['base', 'checkout'], ['pro', 'checkout'], ['enterprise', 'contact_sales']]);
    for (const bad of [{plan: 'enterprise'}, {plan: 'free'}, {plan: 'team'}, {}, {plan: 'base', price: 'price_x'}]) await refused(await call('POST', 'billing/subscribe', bad), 400, 'invalid_plan');

    const checkout = await ok(await call('POST', 'billing/subscribe', {plan: 'base'}));
    assert.match(checkout.url, /^https:\/\/checkout\.stripe\.com\//); assert.equal(checkout.test_mode, true);
    const session = [...state.sessions.values()][0];
    assert.deepEqual([session.mode, session.client_reference_id, session.price, session.metadata.plan, session.subscription_org], ['subscription', tenant, PRICES.base, 'base', tenant]);
    // The owner comes back to the application's own origin, never to an address taken from the request.
    assert.equal(session.success_url, 'https://supatrace.dev/app/?checkout=success#billing'); assert.equal(session.cancel_url, 'https://supatrace.dev/app/?checkout=cancelled#billing');
    assert.equal(session.customer, row().stripe_customer_id); assert.equal(state.idempotency, 'supatrace-customer-' + tenant);
    // Opening Checkout changes nothing: an unpaid session is not a plan.
    assert.deepEqual(await ok(await call('POST', 'billing/sync', {})), {plan: 'free', changed: false});
    assert.equal(row().plan_id, undefined);

    state.pay(session.id);
    assert.deepEqual(await ok(await call('POST', 'billing/sync', {})), {plan: 'base', changed: true, previous_plan: 'free', subscription_status: 'active'});
    assert.deepEqual([row().plan_id, row().plan_source, row().stripe_subscription_status, row().plan_period_end], ['base', STRIPE_PLAN_SOURCE, 'active', 1800000000]);
    assert.equal((await ok(await call('GET', 'entitlements'))).plan_id, 'base');
    assert.equal((await ok(await call('GET', 'usage'))).plan_limits.spans_per_month, 1000000, 'the upload allowance follows the plan');
    assert.deepEqual(await ok(await call('POST', 'billing/sync', {})), {plan: 'base', changed: false}, 'a repeat sync writes nothing');
    catalog = await ok(await call('GET', 'billing/catalog'));
    assert.deepEqual(catalog.plans.map(plan => [plan.id, plan.action]), [['free', 'portal'], ['base', 'none'], ['pro', 'change'], ['enterprise', 'contact_sales']]);
    assert.deepEqual([catalog.portal_available, catalog.plan_source, catalog.subscription.status, catalog.subscription.current_period_end], [true, 'subscription', 'active', '2027-01-15T08:00:00.000Z']);
    // One subscription per organization: a second Checkout is refused, the portal is the way to change.
    await refused(await call('POST', 'billing/subscribe', {plan: 'pro'}), 409, 'subscription_exists');
    const portal = await ok(await call('POST', 'billing/manage', {})); assert.match(portal.url, /^https:\/\/billing\.stripe\.com\//);

    // The portal switches the price to Pro.
    const sub = [...state.subscriptions.values()][0]; sub.items.data[0].price.id = PRICES.pro;
    assert.deepEqual(await ok(await call('POST', 'billing/sync', {})), {plan: 'pro', changed: true, previous_plan: 'base', subscription_status: 'active'});
    assert.equal((await ok(await call('GET', 'entitlements'))).features.audit_log.enabled, true);
    assert.equal((await ok(await call('POST', 'billing/spend-cap', {enabled: false}))).spend_cap.enabled, false);

    // Cancel at period end keeps the plan until Stripe ends the subscription.
    sub.cancel_at_period_end = true; assert.deepEqual(await ok(await call('POST', 'billing/sync', {})), {plan: 'pro', changed: false, previous_plan: 'pro', subscription_status: 'active'});
    assert.equal((await ok(await call('GET', 'billing/catalog'))).subscription.cancel_at_period_end, true);
    sub.status = 'canceled';
    assert.deepEqual(await ok(await call('POST', 'billing/sync', {})), {plan: 'free', changed: true, previous_plan: 'pro', subscription_status: null});
    assert.deepEqual([row().plan_id, row().plan_source, row().spend_cap, row().stripe_subscription_id], [undefined, undefined, undefined, undefined], 'back on Free the plan, its source and the spend-cap choice are gone');
    assert.equal(typeof row().stripe_customer_id, 'string', 'the customer is kept for a later Checkout');
    const locked = await call('GET', 'audit'); assert.equal(locked.status, 402, 'Pro features lock again');
    // The audit trail has each move.
    row().plan_id = 'pro'; const events = (await ok(await call('GET', 'audit'))).events.filter(event => event.action === 'billing.plan_changed').map(event => [event.detail.from, event.detail.to]).reverse();
    assert.deepEqual(events, [['free', 'base'], ['base', 'pro'], ['pro', 'free']]);
  } finally { await live.close(); }
});

test('past_due keeps the plan while Stripe retries; unpaid and incomplete do not pay for one', async () => {
  const {live, call, row, state} = await world(); try {
    await ok(await call('POST', 'billing/subscribe', {plan: 'pro'})); const sub = state.pay([...state.sessions.keys()][0]);
    assert.equal((await ok(await call('POST', 'billing/sync', {}))).plan, 'pro');
    sub.status = 'past_due'; assert.equal((await ok(await call('POST', 'billing/sync', {}))).plan, 'pro'); assert.equal(row().stripe_subscription_status, 'past_due');
    for (const status of ['unpaid', 'incomplete', 'incomplete_expired', 'paused']) { sub.status = 'active'; await call('POST', 'billing/sync', {}); sub.status = status; assert.equal((await ok(await call('POST', 'billing/sync', {}))).plan, 'free', status); }
  } finally { await live.close(); }
});

test('only the owner on Default reaches billing; a member cannot start Checkout or sync', async () => {
  const {live, tenant, call} = await world(); try {
    let member = ''; const other = await live.signIn({addCookies: async value => { member = value.map(c => c.name + '=' + c.value).join('; '); }}, 5252);
    await ok(await call('POST', 'workspaces', {name: 'Acme'}), 201);
    const invite = await ok(await call('POST', 'workspaces/invite', {recipient_id: other, role: 'admin'}), 201); await ok(await call('POST', 'workspaces/accept', {workspace_id: tenant, token: invite.token}, member));
    for (const [method, path, body] of [['GET', 'billing/catalog'], ['POST', 'billing/subscribe', {plan: 'base'}], ['POST', 'billing/change', {plan: 'pro'}], ['POST', 'billing/manage', {}], ['POST', 'billing/sync', {}]]) await refused(await call(method, path + '?workspace=' + tenant, body, member), 403, 'workspace_owner_required');
    await ok(await call('POST', 'environments', {id: 'staging', name: 'Staging'}), 201);
    await refused(await call('POST', 'billing/subscribe?environment=staging', {plan: 'base'}), 403, 'workspace_owner_required');
    assert.equal((await fetch(live.origin + '/api/billing/catalog')).status, 401);
    // A cross-site POST is refused before anything is asked of Stripe.
    const cross = await fetch(live.origin + '/api/billing/subscribe', {method: 'POST', headers: {cookie: (await (async () => { let c = ''; await live.signIn({addCookies: async v => { c = v.map(x => x.name + '=' + x.value).join('; '); }}, 4242); return c; })()), origin: 'https://evil.example', 'content-type': 'application/json'}, body: JSON.stringify({plan: 'base'})});
    await refused(cross, 403, 'origin_required');
  } finally { await live.close(); }
});

test('a signed Stripe event syncs the organization it names; forged, unsigned, live-mode and foreign events change nothing', async () => {
  const {live, tenant, call, row, hook, state} = await world(); try {
    await ok(await call('POST', 'billing/subscribe', {plan: 'base'})); const sub = state.pay([...state.sessions.keys()][0]), customer = row().stripe_customer_id;
    const event = (type, object) => ({type, data: {object}});
    // Unsigned, wrongly signed and stale signatures are refused.
    {
      const payload = JSON.stringify({id: 'evt_stale', object: 'event', livemode: false, ...event('customer.subscription.created', sub)}), old = Math.floor(Date.now() / 1000) - 3600;
      const header = await new Stripe(KEY).webhooks.generateTestHeaderStringAsync({payload, secret: WEBHOOK, timestamp: old});
      await refused(await fetch(live.origin + '/api/billing/webhook', {method: 'POST', headers: {'content-type': 'application/json', 'stripe-signature': header}, body: payload}), 400, 'invalid_webhook_signature');
    }
    await refused(await fetch(live.origin + '/api/billing/webhook', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'}), 400, 'invalid_webhook');
    await refused(await hook(event('customer.subscription.created', sub), 'whsec_' + 'x'.repeat(24)), 400, 'invalid_webhook_signature');
    assert.equal(row().plan_id, undefined);
    // A live-mode event is refused even when correctly signed.
    await refused(await hook({livemode: true, ...event('customer.subscription.created', sub)}), 400, 'plan_billing_live_mode_refused');
    // An event for another product on the same Stripe account, or naming an organization whose customer it is not, is ignored.
    assert.deepEqual(await ok(await hook(event('customer.subscription.created', {...sub, metadata: {}}))), {received: true, handled: false});
    assert.deepEqual(await ok(await hook(event('customer.subscription.created', {...sub, customer: 'cus_someoneelse'}))), {received: true, handled: false});
    assert.deepEqual(await ok(await hook(event('payment_intent.succeeded', sub))), {received: true, handled: false});
    assert.equal(row().plan_id, undefined);
    // The real event: the plan comes from reading the subscription back, not from the event body.
    assert.deepEqual(await ok(await hook(event('customer.subscription.created', {...sub, items: {data: [{price: {id: PRICES.pro}}]}}))), {received: true, handled: true, plan: 'base'});
    assert.equal(row().plan_id, 'base');
    assert.deepEqual(await ok(await hook(event('checkout.session.completed', {id: 'cs_test_1',livemode:false, customer, client_reference_id: tenant, metadata: {supatrace_org: tenant}}))), {received: true, handled: true, plan: 'base'});
    // Cancellation arrives with nobody signed in.
    sub.status = 'canceled'; assert.deepEqual(await ok(await hook(event('customer.subscription.deleted', sub))), {received: true, handled: true, plan: 'free'});
    assert.equal(row().plan_id, undefined);
  } finally { await live.close(); }
  // Without a signing secret the route does not take plan events at all.
  const quiet = await world({webhookSecret: null}); try {
    const response = await quiet.hook({type: 'customer.subscription.created', data: {object: {}}}); assert.notEqual(response.status, 200);
    assert.equal(quiet.row().plan_id, undefined);
  } finally { await quiet.live.close(); }
});

test('live-mode objects, a price that differs from the plan table, and a missing portal are refused', async () => {
  for (const [options, path, body, status, code] of [
    [{livemode: true}, 'billing/subscribe', {plan: 'base'}, 503, 'plan_billing_live_mode_refused'],
    [{prices: [{id: PRICES.base, livemode: false, active: true, lookup_key: lookupKey('base'), currency: 'usd', unit_amount: 1999, recurring: {interval: 'month', interval_count: 1}}, {id: PRICES.pro, livemode: false, active: true, lookup_key: lookupKey('pro'), currency: 'usd', unit_amount: amount('pro'), recurring: {interval: 'month', interval_count: 1}}]}, 'billing/subscribe', {plan: 'base'}, 503, 'plan_billing_price_mismatch'],
    [{prices: [{id: PRICES.base, livemode: false, active: true, lookup_key: lookupKey('base'), currency: 'usd', unit_amount: amount('base'), recurring: {interval: 'year', interval_count: 1}}]}, 'billing/subscribe', {plan: 'base'}, 503, 'plan_billing_price_mismatch']
  ]) { const w = await world({stripe: fakeStripe(options)}); try { await refused(await w.call('POST', path, body), status, code); assert.equal(w.row().plan_id, undefined); } finally { await w.live.close(); } }
  const w = await world({stripe: fakeStripe({portal: false})}); try {
    await refused(await w.call('POST', 'billing/manage', {}), 409, 'no_subscription');
    await ok(await w.call('POST', 'billing/subscribe', {plan: 'base'})); w.state.pay([...w.state.sessions.keys()][0]); await ok(await w.call('POST', 'billing/sync', {}));
    await refused(await w.call('POST', 'billing/manage', {}), 503, 'billing_portal_unavailable');
  } finally { await w.live.close(); }
});

test('an operator-assigned plan (Enterprise) is never changed by Stripe, and has no Checkout', async () => {
  const {live, tenant, call, row, state} = await world(); try {
    // What scripts/set-plan.mjs writes.
    await live.store._tx([{Update: operatorPlanUpdate(tenant, 'enterprise', live.store.now())}]);
    assert.deepEqual([row().plan_id, row().plan_source], ['enterprise', OPERATOR_PLAN_SOURCE]);
    const catalog = await ok(await call('GET', 'billing/catalog'));
    assert.deepEqual([catalog.current_plan, catalog.plan_source, catalog.portal_available], ['enterprise', 'operator', false]); assert.ok(catalog.plans.every(plan => plan.action === 'none'));
    assert.equal((await ok(await call('GET', 'entitlements'))).features.sso_saml.enabled, true);
    await refused(await call('POST', 'billing/subscribe', {plan: 'pro'}), 409, 'plan_managed_by_operator');
    row().stripe_customer_id = 'cus_operatorcase1';
    assert.deepEqual(await ok(await call('POST', 'billing/sync', {})), {plan: 'enterprise', changed: false, managed_by: 'operator'});
    assert.equal(state.calls.includes('GET /v1/subscriptions'), false, 'Stripe is not even asked');
    // Clearing it returns the organization to Free, and only an operator plan can be cleared this way.
    await live.store._tx([{Update: operatorPlanUpdate(tenant, null, live.store.now())}]); assert.equal(row().plan_id, undefined);
    await assert.rejects(live.store._tx([{Update: operatorPlanUpdate(tenant, null, live.store.now())}]));
    assert.throws(() => operatorPlanUpdate(tenant, 'free', 1)); assert.throws(() => operatorPlanUpdate(tenant, 'team', 1));
  } finally { await live.close(); }
});

test('a live-mode customer, Checkout session or subscription is refused wherever it is read', async () => {
  for (const kind of ['customer', 'checkout.session']) {
    const w = await world({stripe: fakeStripe({liveKinds: [kind]})}); try {
      await refused(await w.call('POST', 'billing/subscribe', {plan: 'base'}), 503, 'plan_billing_live_mode_refused'); assert.equal(w.row().plan_id, undefined, kind);
    } finally { await w.live.close(); }
  }
  // A subscription that turns out to be live-mode at sync time moves nothing.
  const stripe = fakeStripe(), w = await world({stripe}); try {
    await ok(await w.call('POST', 'billing/subscribe', {plan: 'pro'})); const sub = stripe.state.pay([...stripe.state.sessions.keys()][0]); sub.livemode = true;
    await refused(await w.call('POST', 'billing/sync', {}), 503, 'plan_billing_live_mode_refused'); assert.equal(w.row().plan_id, undefined);
  } finally { await w.live.close(); }
});

test('a sync that races an operator assignment loses cleanly, and a hand-set plan is neither sold over nor overwritten', async () => {
  const {live, tenant, call, row, state} = await world(); try {
    await ok(await call('POST', 'billing/subscribe', {plan: 'base'})); state.pay([...state.sessions.keys()][0]);
    // The operator assigns Enterprise between the sync's read and its write.
    const original = live.store._tx.bind(live.store); let raced = false;
    live.store._tx = async items => { if (!raced && items.some(item => item.Update?.UpdateExpression?.includes('plan_synced_at'))) { raced = true; await original([{Update: operatorPlanUpdate(tenant, 'enterprise', live.store.now())}]); } return original(items); };
    await refused(await call('POST', 'billing/sync', {}), 409, 'billing_changed'); live.store._tx = original; assert.equal(raced, true);
    assert.deepEqual([row().plan_id, row().plan_source], ['enterprise', OPERATOR_PLAN_SOURCE]);
    assert.deepEqual(await ok(await call('POST', 'billing/sync', {})), {plan: 'enterprise', changed: false, managed_by: 'operator'});
  } finally { await live.close(); }
  // Two syncs: the one that read first must not write after another sync has written.
  const two = await world(); try {
    await ok(await two.call('POST', 'billing/subscribe', {plan: 'base'})); const sub = two.state.pay([...two.state.sessions.keys()][0]);
    assert.equal((await ok(await two.call('POST', 'billing/sync', {}))).plan, 'base'); const first = two.row().plan_synced_at; assert.ok(Number.isSafeInteger(first));
    sub.items.data[0].price.id = PRICES.pro;
    const original = two.live.store._tx.bind(two.live.store); let raced = false;
    two.live.store._tx = async items => { if (!raced && items.some(item => item.Update?.UpdateExpression?.includes('plan_synced_at'))) { raced = true; two.row().plan_synced_at = first + 1; } return original(items); };
    await refused(await two.call('POST', 'billing/sync', {}), 409, 'billing_changed'); two.live.store._tx = original; assert.equal(raced, true); assert.equal(two.row().plan_id, 'base');
    assert.equal((await ok(await two.call('POST', 'billing/sync', {}))).plan, 'pro', 'the next sync applies it');
  } finally { await two.live.close(); }
  const w = await world(); try {
    w.row().plan_id = 'pro';   // set by hand, no source
    await refused(await w.call('POST', 'billing/subscribe', {plan: 'base'}), 409, 'plan_managed_by_operator');
    w.row().stripe_customer_id = 'cus_handsetplan01';
    assert.deepEqual(await ok(await w.call('POST', 'billing/sync', {})), {plan: 'pro', changed: false, managed_by: 'operator'}); assert.equal(w.row().plan_id, 'pro');
  } finally { await w.live.close(); }
});

test('the spend-cap choice does not survive a move to a plan without the feature', async () => {
  const {live, call, row, state} = await world(); try {
    await ok(await call('POST', 'billing/subscribe', {plan: 'pro'})); const sub = state.pay([...state.sessions.keys()][0]); await ok(await call('POST', 'billing/sync', {}));
    await ok(await call('POST', 'billing/spend-cap', {enabled: false})); assert.equal(row().spend_cap, false);
    sub.items.data[0].price.id = PRICES.base; assert.equal((await ok(await call('POST', 'billing/sync', {}))).plan, 'base'); assert.equal(row().spend_cap, undefined);
    sub.items.data[0].price.id = PRICES.pro; assert.equal((await ok(await call('POST', 'billing/sync', {}))).plan, 'pro');
    assert.equal((await ok(await call('GET', 'usage'))).spend_cap.enabled, true, 'back on Pro the cap is on until the owner chooses again');
  } finally { await live.close(); }
});

test('opening Billing re-reads the subscription: a payment whose redirect was lost and a cancellation with no webhook are both picked up', async () => {
  const {live, call, row, state, environment} = await world({webhookSecret: null}); try {
    await ok(await call('POST', 'billing/subscribe', {plan: 'base'})); const sub = state.pay([...state.sessions.keys()][0]);
    // The owner paid and never came back through the return URL: no sync was requested.
    assert.equal(row().plan_id, undefined);
    let catalog = await ok(await call('GET', 'billing/catalog'));
    assert.deepEqual([catalog.current_plan, catalog.portal_available, catalog.plans.find(plan => plan.id === 'pro').action], ['base', true, 'change']); assert.equal(row().plan_id, 'base');
    // Cancelled in Stripe directly; with no webhook configured nothing told the service.
    sub.status = 'canceled'; assert.equal(row().plan_id, 'base');
    catalog = await ok(await call('GET', 'billing/catalog')); assert.deepEqual([catalog.current_plan, catalog.portal_available], ['free', false]); assert.equal(row().plan_id, undefined);
    // A Stripe outage does not fail the page: the catalog shows the plan on record. First an error answer.
    sub.status = 'active'; await ok(await call('GET', 'billing/catalog')); assert.equal(row().plan_id, 'base');
    sub.status = 'canceled'; state.broken = 'GET /v1/subscriptions';
    const calls = state.calls.length; catalog = await ok(await call('GET', 'billing/catalog'));
    assert.equal(catalog.current_plan, 'base', 'the plan on record is shown; the failed check changed nothing'); assert.ok(state.calls.length > calls, 'Stripe was asked'); assert.equal(row().plan_id, 'base');
    // The explicit sync reports the failure to the owner instead.
    await refused(await call('POST', 'billing/sync', {}), 502, 'plan_billing_provider_error');
    // Then no answer at all: the page waits only for the deadline, far inside the function's time limit.
    state.broken = null; state.hung = 'GET /v1/subscriptions'; environment.planBilling.catalogSyncMs = 60;
    const started = Date.now(); catalog = await ok(await call('GET', 'billing/catalog'));
    assert.equal(catalog.current_plan, 'base'); assert.ok(Date.now() - started < 1500, 'the catalog did not wait for Stripe');
    state.hung = null; delete environment.planBilling.catalogSyncMs;
    assert.equal((await ok(await call('GET', 'billing/catalog'))).current_plan, 'free', 'once Stripe answers again the cancellation is picked up');
    // At most one check a minute for an organization: a refused limiter means no Stripe call, and still a catalog.
    const allow = live.store.consumeRate; let asked = 0; live.store.consumeRate = async request => request.scope === 'plancheck' ? (asked++, {allowed: false, retry_after: 60}) : allow(request);
    const quietCalls = state.calls.length; assert.equal((await ok(await call('GET', 'billing/catalog'))).current_plan, 'free'); assert.equal(asked, 1); assert.equal(state.calls.length, quietCalls);
    live.store.consumeRate = allow;
    // An organization with no Stripe customer costs no Stripe call.
    delete live.store.client.items.get('TENANT#github-4242\0META').stripe_customer_id; const quiet = state.calls.length;
    await ok(await call('GET', 'billing/catalog')); assert.equal(state.calls.length, quiet);
  } finally { await live.close(); }
});

test('billing never lands on a deleted organization: no customer is attached, a sync that started before the deletion cannot write, and a later event writes nothing', async () => {
  // Checkout for an organization deleted while the request was in flight: the customer write is refused, so no session is made.
  const first = await world(); try {
    const original = first.live.store._tx.bind(first.live.store); let raced = false;
    first.live.store._tx = async items => { if (!raced && items.some(item => item.Update?.UpdateExpression?.includes('stripe_customer_id'))) { raced = true; first.row().deleted_at = first.live.store.now(); } return original(items); };
    await refused(await first.call('POST', 'billing/subscribe', {plan: 'base'}), 409, 'billing_changed'); first.live.store._tx = original;
    assert.equal(raced, true); assert.equal(first.row().stripe_customer_id, undefined); assert.equal(first.state.sessions.size, 0, 'no Checkout session exists to be paid later');
  } finally { await first.live.close(); }
  const {live, call, row, hook, state} = await world(); try {
    await ok(await call('POST', 'billing/subscribe', {plan: 'base'})); const sub = state.pay([...state.sessions.keys()][0]);
    // A sync that read the row before the deletion and writes after it.
    const original = live.store._tx.bind(live.store); let raced = false;
    live.store._tx = async items => { if (!raced && items.some(item => item.Update?.UpdateExpression?.includes('plan_synced_at'))) { raced = true; row().deleted_at = live.store.now(); } return original(items); };
    await refused(await call('POST', 'billing/sync', {}), 409, 'billing_changed'); live.store._tx = original; assert.equal(raced, true);
    assert.deepEqual([row().plan_id, row().stripe_subscription_id], [undefined, undefined]);
    // An event that arrives afterwards is acknowledged and changes nothing.
    assert.deepEqual(await ok(await hook({type: 'customer.subscription.created', data: {object: sub}})), {received: true, handled: true, plan: 'free'});
    assert.deepEqual([row().plan_id, row().stripe_subscription_id], [undefined, undefined]);
  } finally { await live.close(); }
});


function pauseNextSubscription(state) {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), wait = new Promise(resolve => { release = resolve; });
  state.pause = {enter, wait};
  return {entered, release};
}

test('a newer no-change sync fences an older Stripe observation in the same second', async () => {
  const {live, call, row, state} = await world(); try {
    await ok(await call('POST', 'billing/subscribe', {plan: 'base'})); const sub = state.pay([...state.sessions.keys()][0]);
    await ok(await call('POST', 'billing/sync', {})); const second = row().plan_synced_at;
    sub.items.data[0].price.id = PRICES.pro;
    const pause = pauseNextSubscription(state), older = call('POST', 'billing/sync', {}); await pause.entered;
    sub.items.data[0].price.id = PRICES.base;
    assert.deepEqual(await ok(await call('POST', 'billing/sync', {})), {plan: 'base', changed: false});
    assert.equal(row().plan_synced_at, second, 'the clock timestamp did not change');
    pause.release(); await refused(await older, 409, 'billing_changed'); assert.equal(row().plan_id, 'base');
  } finally { await live.close(); }
});

test('a catalog timeout before Stripe answers prevents its late result from starting a plan write', async () => {
  const {live, call, row, state, environment} = await world(); try {
    await ok(await call('POST', 'billing/subscribe', {plan: 'base'})); const sub = state.pay([...state.sessions.keys()][0]);
    await ok(await call('POST', 'billing/sync', {})); sub.items.data[0].price.id = PRICES.pro;
    environment.planBilling.catalogSyncMs = 30;
    const pause = pauseNextSubscription(state), catalog = call('GET', 'billing/catalog'); await pause.entered;
    assert.equal((await ok(await catalog)).current_plan, 'base');
    let writes = 0; const tx = live.store._tx.bind(live.store); live.store._tx = async items => { writes++; return tx(items); };
    pause.release(); await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(writes, 0, 'no delayed plan write was attempted'); assert.equal(row().plan_id, 'base');
  } finally { await live.close(); }
});

test('catalog tolerates limiter outages and the real plancheck limiter waits until the next minute', async () => {
  const {live, call, row, state} = await world(); try {
    await ok(await call('POST', 'billing/subscribe', {plan: 'base'})); const sub = state.pay([...state.sessions.keys()][0]);
    const stub = live.store.consumeRate.bind(live.store), real = DynamoMetadataStore.prototype.consumeRate.bind(live.store);
    live.store.consumeRate = request => request.scope === 'plancheck' ? real(request) : stub(request);
    let now = live.store.now(); live.store.now = () => now;
    assert.equal((await ok(await call('GET', 'billing/catalog'))).current_plan, 'base');
    sub.status = 'canceled'; const calls = state.calls.length;
    assert.equal((await ok(await call('GET', 'billing/catalog'))).current_plan, 'base'); assert.equal(state.calls.length, calls);
    now += 60; assert.equal((await ok(await call('GET', 'billing/catalog'))).current_plan, 'free');
    live.store.consumeRate = request => request.scope === 'plancheck' ? Promise.reject(new Error('limiter unavailable')) : stub(request);
    assert.equal((await ok(await call('GET', 'billing/catalog'))).current_plan, 'free'); assert.equal(row().plan_id, undefined);
    assert.deepEqual(state.options, {maxNetworkRetries: 0, timeout: 3000}, 'three sequential provider waits fit inside the 15-second API budget');
  } finally { await live.close(); }
});

test('cold Checkout overlaps independent reads and tolerates provider latency above the old 1.5-second timeout', async () => {
  const {live, call, state} = await world();
  try {
    state.delay = 1700;
    const started = Date.now();
    const result = await ok(await call('POST', 'billing/subscribe', {plan: 'base'}));
    assert.ok(result.url.startsWith('https://checkout.stripe.com/'));
    assert.equal(state.calls.length, 5);
    assert.ok(Date.now() - started < 7000, 'five requests take three provider waits, with room for local scheduling');
  } finally { await live.close(); }
});

for(const mode of ['test','live']) test(`${mode} billing completes checkout, signed sync, portal and plan change`,async()=>{
 const w=await world({mode});try{
  const checkout=await ok(await w.call('POST','billing/subscribe',{plan:'base'}));assert.equal(checkout.test_mode,mode==='test');
  const session=[...w.state.sessions.values()][0];
  if(mode==='live'){assert.equal(session.billing_address_collection,'auto');assert.equal(session.allow_promotion_codes,'false');}
  const sub=w.state.pay(session.id);
  await ok(await w.hook({type:'customer.subscription.created',data:{object:sub}}));
  assert.equal(w.row().plan_source,'stripe_'+mode);assert.equal(w.row().stripe_mode,mode);
  assert.equal((await ok(await w.call('GET','entitlements'))).plan_id,'base');
  const catalog=await ok(await w.call('GET','billing/catalog'));assert.equal(catalog.mode,'stripe_'+mode);assert.equal(catalog.test_mode,mode==='test');
  assert.equal((await ok(await w.call('POST','billing/manage',{}))).test_mode,mode==='test');
  assert.equal((await ok(await w.call('POST','billing/change',{plan:'pro'}))).plan,'pro');
  assert.equal((await ok(await w.call('GET','usage'))).monthly.test_mode,mode==='test');
 }finally{await w.live.close();}
});

for(const mode of ['test','live'])for(const kind of ['price','customer','checkout.session','subscription','billing_portal.session'])test(`${mode} runtime refuses opposite-mode ${kind}`,async()=>{
 const w=await world({mode,stripe:fakeStripe({livemode:mode==='live',liveKinds:[kind]})});try{
  if(['price','customer','checkout.session'].includes(kind))await refused(await w.call('POST','billing/subscribe',{plan:'base'}),503,'plan_billing_live_mode_refused');
  else{
   await ok(await w.call('POST','billing/subscribe',{plan:'base'}));w.state.pay([...w.state.sessions.keys()][0]);
   await refused(await w.call('POST',kind==='subscription'?'billing/sync':'billing/manage',{}),503,'plan_billing_live_mode_refused');
  }
  assert.equal(w.row().plan_id,undefined);
 }finally{await w.live.close();}
});

for(const mode of ['test','live'])test(`${mode} webhook refuses opposite-mode events and objects`,async()=>{
 const w=await world({mode});try{
  await ok(await w.call('POST','billing/subscribe',{plan:'base'}));const sub=w.state.pay([...w.state.sessions.keys()][0]);
  await refused(await w.hook({livemode:mode!=='live',type:'customer.subscription.created',data:{object:sub}}),400,'plan_billing_live_mode_refused');
  await refused(await w.hook({type:'customer.subscription.created',data:{object:{...sub,livemode:mode!=='live'}}}),503,'plan_billing_live_mode_refused');
  assert.equal(w.row().plan_id,undefined);
 }finally{await w.live.close();}
});

for(const mode of ['test','live'])test(`${mode} runtime treats the other mode's stored plan as Free without mutating it`,async()=>{
 const w=await world({mode});try{
  const other=mode==='live'?'test':'live';
  Object.assign(w.row(),{plan_id:'pro',plan_source:'stripe_'+other,stripe_customer_id:'cus_oldmode',stripe_subscription_id:'sub_oldmode',spend_cap:false,...(other==='live'?{stripe_mode:'live'}:{})});
  const before=structuredClone(w.row());
  const catalog=await ok(await w.call('GET','billing/catalog'));assert.equal(catalog.current_plan,'free');assert.equal(catalog.portal_available,false);
  const entitlements=await ok(await w.call('GET','entitlements'));assert.equal(entitlements.plan_id,'free');assert.equal(entitlements.limits.retention_days,PLANS.plans.find(p=>p.id==='free').retention_days);
  assert.equal((await ok(await w.call('GET','usage'))).plan_limits.plan_id,'free');
  assert.equal((await ok(await w.call('POST','billing/sync',{}))).plan,'free');
  await refused(await w.call('POST','billing/manage',{}),409,'no_subscription');
  await refused(await w.call('POST','billing/change',{plan:'base'}),409,'no_subscription');
  assert.deepEqual(w.row(),before);assert.deepEqual(w.state.calls,[]);
  await ok(await w.call('POST','billing/subscribe',{plan:'base'}));
  assert.equal(w.row().stripe_mode,mode);assert.equal(w.row()['stripe_previous_'+other].stripe_customer_id,'cus_oldmode');
  const sub=w.state.pay([...w.state.sessions.keys()][0]);await ok(await w.hook({type:'customer.subscription.created',data:{object:sub}}));
  assert.equal(w.row().plan_source,'stripe_'+mode);assert.equal(w.row().plan_id,'base');
 }finally{await w.live.close();}
});

test('dev entry points reject live keys before constructing any provider',async()=>{
 const {requireDevTestKey,configureLocalBilling}=await import('../scripts/local-billing.mjs');
 for(const prefix of ['sk','rk']){
  const key=prefix+'_live_'+'f'.repeat(24);assert.throws(()=>requireDevTestKey(key),/dev_stripe_test_key_required/);
  const prior=process.env.SUPATRACE_DEV_STRIPE_TEST_KEY;process.env.SUPATRACE_DEV_STRIPE_TEST_KEY=key;
  try{await assert.rejects(configureLocalBilling({}),/dev_stripe_test_key_required/);}finally{if(prior===undefined)delete process.env.SUPATRACE_DEV_STRIPE_TEST_KEY;else process.env.SUPATRACE_DEV_STRIPE_TEST_KEY=prior;}
 }
 assert.equal(requireDevTestKey(KEY),KEY);
});

for(const mode of ['test','live'])test(`${mode} refuses a mixed-mode nested subscription price`,async()=>{
 const w=await world({mode});try{
  await ok(await w.call('POST','billing/subscribe',{plan:'base'}));const sub=w.state.pay([...w.state.sessions.keys()][0]);
  await ok(await w.call('POST','billing/sync',{}));sub.items.data[0].price.livemode=mode!=='live';
  await refused(await w.call('POST','billing/change',{plan:'pro'}),503,'plan_billing_live_mode_refused');
  await refused(await w.call('POST','billing/sync',{}),503,'plan_billing_live_mode_refused');
  assert.equal(w.row().plan_id,'base');
 }finally{await w.live.close();}
});

test('returning to either mode reuses its customer and refuses a second paid subscription',async()=>{
 const w=await world({mode:'live'}),liveBilling=w.environment.planBilling,testStripe=fakeStripe();try{
  await ok(await w.call('POST','billing/subscribe',{plan:'pro'}));w.state.pay([...w.state.sessions.keys()][0]);await ok(await w.call('POST','billing/sync',{}));
  const liveCustomer=w.row().stripe_customer_id;
  Object.assign(w.row(),{overage_price_id:'price_savedLive',overage_customer_id:liveCustomer,overage_subscription_id:w.row().stripe_subscription_id});
  const testBilling=composePlanBilling({secretKey:KEY,webhookSecret:WEBHOOK,StripeClient:testStripe.client});w.environment.planBilling=testBilling;
  await ok(await w.call('POST','billing/subscribe',{plan:'base'}));testStripe.state.pay([...testStripe.state.sessions.keys()][0]);await ok(await w.call('POST','billing/sync',{}));
  for(const [mode,billing,state,plan]of [['live',liveBilling,w.state,'pro'],['test',testBilling,testStripe.state,'base'],['live',liveBilling,w.state,'pro']]){
   w.environment.planBilling=billing;
   await refused(await w.call('POST','billing/subscribe',{plan}),409,'subscription_exists');
   assert.equal(state.calls.filter(c=>c==='POST /v1/customers').length,1);
   assert.equal(w.row().stripe_mode,mode);assert.equal(w.row()['stripe_previous_'+mode],undefined);
   if(mode==='live'){assert.equal(w.row().overage_price_id,'price_savedLive');assert.equal(w.row().overage_customer_id,liveCustomer);assert.equal(w.row().overage_subscription_id,w.row().stripe_subscription_id);}
   await ok(await w.call('POST','billing/sync',{}));assert.equal(w.row().plan_id,plan);
  }
  assert.equal(w.row().stripe_customer_id,liveCustomer);
 }finally{await w.live.close();}
});
