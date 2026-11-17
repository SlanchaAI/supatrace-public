// Plan billing: Stripe mode follows the secret key.
//
// Base and Pro are bought through Stripe Checkout, changed in Billing and cancelled in the Stripe customer portal. Stripe is the
// source of truth: nothing a browser says moves a plan. `sync` reads the organization's own Stripe customer's
// subscriptions and writes the plan they pay for to `plan_id` on the organization's account row, which is the row every
// limit and feature gate already reads (src/plan-limits.mjs, src/entitlements.mjs). Sync runs when the owner returns
// from Checkout or the portal, when Billing is opened, and when Stripe sends a signed subscription event.
//
// Three guards bind billing to one mode: the key prefix, every object livemode, and the signed event livemode. Enterprise is never sold here: an operator assigns it
// (plan_source 'operator'), and a plan an operator assigned is never changed by Stripe.
//
// This runs inside the API function. It replaces, for hosted use, the older sandbox rehearsal in stripe-billing.mjs,
// which needs separate worker functions, tables and a stream; that code is untouched and still drives `npm run dev`.
import {randomUUID} from 'node:crypto';
import {HttpError, json} from './http.mjs';
import {PLANS} from './plans.mjs';
import {planOf, entitlementsFor, DEFAULT_PLAN} from './entitlements.mjs';
import {auditPut} from './audit.mjs';
import {stripePlanSource, isStripePlan, stripeStateMatches, stripePlanMatches, effectivePlanId, stripeObject, stripeStateFence} from './stripe-plan-state.mjs';

const fail = (status, code) => { throw new HttpError(status, code); };
export const STRIPE_PLAN_SOURCE = 'stripe_test', OPERATOR_PLAN_SOURCE = 'operator';
export const lookupKey = planId => `supatrace_${planId}_monthly`;
const SOLD = PLANS.plans.filter(plan => plan.checkout === true);
/** How long opening Billing waits for Stripe before showing the plan on record. */
export const CATALOG_SYNC_MS = 3000;
const cents = plan => Math.round(plan.monthly_base_usd * 100);
// A subscription in one of these states pays for its plan. past_due keeps the plan while Stripe retries the card;
// Stripe moves it to canceled or unpaid when retries run out, and the plan then drops to Free.
const PAYING = new Set(['active', 'trialing', 'past_due']);
const tenantKey = tenant => ({pk: 'TENANT#' + tenant, sk: 'META'});
const conditional = error => error?.name === 'ConditionalCheckFailedException' || error?.name === 'TransactionCanceledException';
const inMode = (billing, object) => stripeObject(object, billing.mode, () => fail(503, 'plan_billing_live_mode_refused'));

/**
 * Builds the runtime from a secret key. Stripe test and live secret or restricted keys are accepted; anything else throws and billing stays off.
 * `StripeClient` is the Stripe SDK constructor (injected so tests can supply a client with an in-process transport).
 */
export function composePlanBilling({secretKey, webhookSecret = null, StripeClient}) {
  if (typeof secretKey !== 'string' || !/^(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{16,255}$/.test(secretKey)) throw new Error('plan_billing_test_key_required');
  if (webhookSecret !== null && (typeof webhookSecret !== 'string' || !/^whsec_[A-Za-z0-9]{16,255}$/.test(webhookSecret))) throw new Error('plan_billing_webhook_secret_invalid');
  if (typeof StripeClient !== 'function') throw new Error('plan_billing_client_required');
  // Three seconds allows cold TLS connections. Independent catalog/customer reads overlap,
  // leaving at most three sequential Stripe waits (nine seconds) inside the 15-second API budget.
  return {mode: secretKey.split('_')[1], stripe: new StripeClient(secretKey, {maxNetworkRetries: 0, timeout: 3000}), webhookSecret, catalog: null};
}
export const planBillingAvailable = env => ['test', 'live'].includes(env?.planBilling?.mode) && !!env.planBilling.stripe;

// A Stripe failure (declined request, outage, misconfigured product) is reported as one plain error. Only its type and
// code are logged: a Stripe message can quote request values.
async function provider(run) {
  try { return await run(); }
  catch (error) { if (error instanceof HttpError) throw error; console.warn(JSON.stringify({event: 'plan_billing_provider_error', type: typeof error?.type === 'string' ? error.type : 'unknown', code: typeof error?.code === 'string' ? error.code : null})); return fail(502, 'plan_billing_provider_error'); }
}
/** The Stripe prices behind Base and Pro, found by lookup key and checked against the plan table. Read once per container. */
async function stripeCatalog(billing) {
  if (billing.catalog) return billing.catalog;
  const [found, configurations] = await Promise.all([
    billing.stripe.prices.list({lookup_keys: SOLD.map(plan => lookupKey(plan.id)), active: true, limit: 20}),
    billing.stripe.billingPortal.configurations.list({active: true, limit: 20}).catch(() => null)
  ]);
  const byPlan = {}, byPrice = {};
  for (const plan of SOLD) {
    const price = inMode(billing, found.data.find(item => item.lookup_key === lookupKey(plan.id)));
    // The amount Stripe charges must be the amount the plan table and the pricing page state.
    if (price.currency !== 'usd' || price.unit_amount !== cents(plan) || price.recurring?.interval !== 'month' || price.recurring.interval_count !== 1) fail(503, 'plan_billing_price_mismatch');
    byPlan[plan.id] = price.id; byPrice[price.id] = plan.id;
  }
  const portal = configurations?.data.find(item => item.livemode === (billing.mode === 'live') && item.metadata?.app === 'supatrace')?.id ?? null;
  return billing.catalog = Object.freeze({byPlan: Object.freeze(byPlan), byPrice: Object.freeze(byPrice), portal});
}

function subscriptionView(row, mode) {
  if (!stripePlanMatches(row, mode) || typeof row.stripe_subscription_id !== 'string') return null;
  return {status: row.stripe_subscription_status ?? null, cancel_at_period_end: row.stripe_cancel_at_period_end === true,
    current_period_end: Number.isSafeInteger(row.plan_period_end) ? new Date(row.plan_period_end * 1000).toISOString() : null};
}
/** GET /api/billing/catalog: every plan with its price, limits and features, the plan in force, and what the owner can do next. */
export async function planCatalog(env, store, tenant, audit = null) {
  // Opening Billing re-reads the subscription for an organization that has a Stripe customer. This is what picks up a
  // payment whose redirect was lost, and a cancellation when no webhook is configured. It never fails the catalog.
  // It is bounded three ways so that it can never cost the page or the service: at most once a minute for an organization,
  // at most CATALOG_SYNC_MS waiting for Stripe (a slow read is abandoned), and any error is ignored.
  // A DynamoDB write already submitted before the deadline may settle afterwards; revisions fence it against newer syncs.
  const before = await store.getTenant(tenant);
  if (planBillingAvailable(env) && stripeStateMatches(before, env.planBilling.mode) && typeof before?.stripe_customer_id === 'string' && before.plan_source !== OPERATOR_PLAN_SOURCE) {
    let timer; const abort = new AbortController();
    try {
      if ((await store.consumeRate({scope: 'plancheck', identity: tenant, limit: 1, windowSeconds: 60})).allowed) {
        const deadline = new Promise((resolve, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error('plan_check_deadline')); }, env.planBilling.catalogSyncMs ?? CATALOG_SYNC_MS); });
        await Promise.race([syncPlan(env, store, tenant, audit, abort.signal), deadline]);
      }
    } catch { /* the catalog below shows the plan on record, including when the optional limiter fails */ }
    finally { clearTimeout(timer); }
  }
  const row = await store.getTenant(tenant), current = planOf(effectivePlanId(row, env.planBilling?.mode)), available = planBillingAvailable(env), operator = row?.plan_source === OPERATOR_PLAN_SOURCE;
  const subscribed = stripePlanMatches(row, env.planBilling?.mode) && typeof row.stripe_subscription_id === 'string';
  return {
    workspace_id: tenant, catalog_version: PLANS.version, currency: 'USD', interval: 'month', mode: available ? stripePlanSource(env.planBilling.mode) : 'unavailable',
    checkout_available: available, test_mode: env.planBilling?.mode === 'test',
    current_plan: current.id, current_plan_name: current.name, plan_source: operator ? 'operator' : subscribed ? 'subscription' : 'default',
    subscription: subscriptionView(row, env.planBilling?.mode), portal_available: available && subscribed,
    plans: PLANS.plans.map(plan => {
      const answer = entitlementsFor(plan.id);
      return {id: plan.id, name: plan.name, price_kind: plan.price_kind, monthly_usd_cents: plan.price_kind === 'custom' ? null : cents(plan), current: plan.id === current.id,
        limits: answer.limits, features: Object.entries(answer.features).filter(([, flag]) => flag.enabled).map(([id, flag]) => ({id, label: flag.label})),
        // checkout: start a subscription. portal: change or cancel the one that exists. contact_sales: Enterprise. none: nothing to do.
        action: plan.id === current.id || operator ? 'none' : plan.price_kind === 'custom' ? 'contact_sales' : !available ? 'unavailable' : subscribed ? (plan.checkout ? 'change' : 'portal') : plan.checkout ? 'checkout' : 'none'};
    })
  };
}

async function customerFor(env, store, tenant, row) {
  const mode = env.planBilling.mode;
  if (stripeStateMatches(row, mode) && typeof row.stripe_customer_id === 'string' && /^cus_[A-Za-z0-9]{6,64}$/.test(row.stripe_customer_id)) {
    inMode(env.planBilling, await env.planBilling.stripe.customers.retrieve(row.stripe_customer_id));
    return row.stripe_customer_id;
  }
  const saved = row['stripe_previous_' + mode];
  if (saved && !stripeStateMatches(saved, mode)) fail(409, 'billing_changed');
  const customer = typeof saved?.stripe_customer_id === 'string' ? inMode(env.planBilling, await env.planBilling.stripe.customers.retrieve(saved.stripe_customer_id)) : inMode(env.planBilling, await env.planBilling.stripe.customers.create({name: 'SupaTrace organization ' + tenant, metadata: {app: 'supatrace', supatrace_org: tenant}}, {idempotencyKey: 'supatrace-customer-' + tenant}));
  const restored = Object.fromEntries(['stripe_subscription_id','overage_price_id','overage_customer_id','overage_subscription_id'].filter(n => typeof saved?.[n] === 'string').map(n => [n, saved[n]]));
  const fence = stripeStateFence(row), switching = !stripeStateMatches(row, mode);
  const fields = ['plan_id','plan_source','spend_cap','stripe_customer_id','stripe_mode','stripe_subscription_id','stripe_subscription_status','stripe_cancel_at_period_end','plan_period_end','plan_synced_at','plan_sync_revision','overage_price_id','overage_customer_id','overage_subscription_id'];
  // Preserve the old mode's billing state on an explicit purchase, never on a read.
  const previous = Object.fromEntries(fields.filter(n => row[n] !== undefined).map(n => [n, row[n]]));
  try { await store._tx([{Update: {Key: tenantKey(tenant),
    UpdateExpression: 'SET stripe_customer_id = :customer, stripe_mode = :mode' + Object.keys(restored).map(n => ', '+n+' = :restore_'+n).join('') + (switching ? ', stripe_previous_' + (row.stripe_mode ?? 'test') + ' = :previous REMOVE ' + [...fields.filter(n => !['stripe_customer_id','stripe_mode',...Object.keys(restored)].includes(n)), ...(saved ? ['stripe_previous_' + mode] : [])].join(', ') : ''),
    ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(deleted_at) AND ' + fence.condition,
    ExpressionAttributeValues: {...fence.values, ':customer': customer.id, ':mode': mode, ...Object.fromEntries(Object.entries(restored).map(([n,v]) => [':restore_'+n,v])), ...(switching ? {':previous': previous} : {})}}}]); }
  catch (error) { if (conditional(error)) fail(409, 'billing_changed'); throw error; }
  return customer.id;
}
const returnUrl = (env, tenant, state) => { const url = new URL('/app/', env.APP_ORIGIN); if (state) url.searchParams.set('checkout', state); if (tenant) url.searchParams.set('workspace', tenant); url.hash = 'billing'; return url.href; };

/** POST /api/billing/subscribe {plan}: a Stripe Checkout Session for Base or Pro. Owner only (route table). Returns the URL to open. */
export const subscribe = (env, store, tenant, actor, data) => provider(() => subscribeNow(env, store, tenant, actor, data));
async function subscribeNow(env, store, tenant, actor, data) {
  if (!planBillingAvailable(env)) fail(503, 'plan_billing_unavailable');
  if (!data || Object.getPrototypeOf(data) !== Object.prototype || Object.keys(data).join() !== 'plan' || !SOLD.some(plan => plan.id === data.plan)) fail(400, 'invalid_plan');
  const row = await store.getTenant(tenant); if (!row) fail(404, 'tenant_not_found');
  // A plan that Stripe did not assign (an operator's, or one set by hand before sources existed) is not sold over: sync would not apply the purchase.
  if (row.plan_source === OPERATOR_PLAN_SOURCE || (typeof row.plan_id === 'string' && !isStripePlan(row))) fail(409, 'plan_managed_by_operator');
  // An organization has one subscription. Changing plan with one in place is a portal action, so nobody pays twice.
  if (stripePlanMatches(row, env.planBilling.mode) && typeof row.stripe_subscription_id === 'string') fail(409, 'subscription_exists');
  const [catalog, customer] = await Promise.all([stripeCatalog(env.planBilling), customerFor(env, store, tenant, row)]);
  const existing = await env.planBilling.stripe.subscriptions.list({customer, status: 'all', limit: 20});
  if (existing.data.map(item => inMode(env.planBilling, item)).some(item => PAYING.has(item.status))) fail(409, 'subscription_exists');
  const personal = tenant === actor;
  const session = inMode(env.planBilling, await env.planBilling.stripe.checkout.sessions.create({
    mode: 'subscription', ...(env.planBilling.mode === 'live' ? {billing_address_collection: 'auto', allow_promotion_codes: false} : {}), customer, client_reference_id: tenant, line_items: [{price: catalog.byPlan[data.plan], quantity: 1}],
    success_url: returnUrl(env, personal ? null : tenant, 'success'), cancel_url: returnUrl(env, personal ? null : tenant, 'cancelled'),
    metadata: {app: 'supatrace', supatrace_org: tenant, plan: data.plan}, subscription_data: {metadata: {app: 'supatrace', supatrace_org: tenant}}
  }));
  if (typeof session.url !== 'string' || !session.url.startsWith('https://checkout.stripe.com/')) fail(502, 'plan_billing_checkout_unavailable');
  return {url: session.url, plan: data.plan, test_mode: env.planBilling?.mode === 'test'};
}

/** POST /api/billing/manage {}: a Stripe customer portal session to change plan, cancel, or see invoices. */
export const manage = (env, store, tenant, actor, data) => provider(() => manageNow(env, store, tenant, actor, data));
async function manageNow(env, store, tenant, actor, data) {
  if (!planBillingAvailable(env)) fail(503, 'plan_billing_unavailable');
  if (!data || Object.getPrototypeOf(data) !== Object.prototype || Object.keys(data).length) fail(400, 'invalid_billing_request');
  const row = await store.getTenant(tenant);
  if (!stripeStateMatches(row, env.planBilling.mode) || typeof row?.stripe_customer_id !== 'string') fail(409, 'no_subscription');
  inMode(env.planBilling, await env.planBilling.stripe.customers.retrieve(row.stripe_customer_id));
  const catalog = await stripeCatalog(env.planBilling); if (!catalog.portal) fail(503, 'billing_portal_unavailable');
  const session = inMode(env.planBilling, await env.planBilling.stripe.billingPortal.sessions.create({customer: row.stripe_customer_id, configuration: catalog.portal, return_url: returnUrl(env, tenant === actor ? null : tenant, 'portal')}));
  if (typeof session.url !== 'string' || !session.url.startsWith('https://billing.stripe.com/')) fail(502, 'plan_billing_portal_unavailable');
  return {url: session.url, test_mode: env.planBilling?.mode === 'test'};
}

/** Change the fixed-price item in place. Metered items stay attached; the portal cannot update metered subscriptions. */
export const changePlan = (env, store, tenant, actor, data) => provider(async () => {
  if (!planBillingAvailable(env)) fail(503, 'plan_billing_unavailable');
  if (!data || Object.getPrototypeOf(data) !== Object.prototype || Object.keys(data).join() !== 'plan' || !SOLD.some(plan => plan.id === data.plan)) fail(400, 'invalid_billing_request');
  const row = await store.getTenant(tenant);
  if (row?.plan_source === OPERATOR_PLAN_SOURCE) fail(409, 'plan_managed_by_operator');
  if (!stripePlanMatches(row, env.planBilling.mode) || typeof row.stripe_subscription_id !== 'string') fail(409, 'no_subscription');
  const catalog = await stripeCatalog(env.planBilling), stripe = env.planBilling.stripe;
  const subscription = inMode(env.planBilling, await stripe.subscriptions.retrieve(row.stripe_subscription_id, {expand: ['latest_invoice']}));
  if (subscription.customer !== row.stripe_customer_id || subscription.metadata?.supatrace_org !== tenant) fail(409, 'billing_changed');
  if (subscription.status !== 'active' || subscription.cancel_at_period_end) fail(409, 'subscription_not_changeable');
  for (const item of subscription.items?.data ?? []) inMode(env.planBilling, item.price);
  const fixed = subscription.items?.data?.filter(item => catalog.byPrice[item.price?.id]) ?? [];
  if (fixed.length !== 1) fail(409, 'subscription_not_changeable');
  const payment = updated => {
    const invoice = updated.latest_invoice;
    if (!invoice) fail(409, 'plan_payment_pending');
    inMode(env.planBilling, invoice);
    if (typeof invoice.hosted_invoice_url !== 'string' || !invoice.hosted_invoice_url.startsWith('https://invoice.stripe.com/')) fail(409, 'plan_payment_pending');
    return {url: invoice.hosted_invoice_url, payment_pending: true, test_mode: env.planBilling?.mode === 'test'};
  };
  if (subscription.pending_update) return payment(subscription);
  if (fixed[0].price.id !== catalog.byPlan[data.plan]) {
    const updated = inMode(env.planBilling, await stripe.subscriptions.update(subscription.id, {
      items: [{id: fixed[0].id, price: catalog.byPlan[data.plan], quantity: 1}],
      payment_behavior: 'pending_if_incomplete', proration_behavior: 'always_invoice', expand: ['latest_invoice']
    }, {idempotencyKey: 'supatrace-plan-change-' + tenant + '-' + row.plan_sync_revision + '-' + data.plan}));
    if (updated.customer !== row.stripe_customer_id) fail(409, 'billing_changed');
    if (updated.pending_update) return payment(updated);
  }
  // Payment and the price read from Stripe, never the requested plan, decide the entitlements.
  return {...await syncPlan(env, store, tenant, {workspace: tenant, actor, ip: env.sourceIp}), test_mode: env.planBilling?.mode === 'test'};
});

/** What Stripe says this customer pays for now: the plan, and the subscription that pays for it (or Free and none). */
async function paidPlan(billing, customer) {
  const catalog = await stripeCatalog(billing), list = await billing.stripe.subscriptions.list({customer, status: 'all', limit: 20});
  let best = null;
  for (const subscription of list.data) {
    inMode(billing, subscription); if (!PAYING.has(subscription.status) || subscription.customer !== customer) continue;
    for (const item of subscription.items?.data ?? []) {
      inMode(billing, item.price);
      const plan = catalog.byPrice[item.price?.id]; if (!plan) continue;
      const end = item.current_period_end ?? subscription.current_period_end ?? null;
      const candidate = {plan, subscription: subscription.id, status: subscription.status, cancel_at_period_end: subscription.cancel_at_period_end === true, period_end: Number.isSafeInteger(end) ? end : null};
      // More than one paying subscription should not happen; if it does, the higher plan wins.
      if (!best || PLANS.plans.findIndex(p => p.id === plan) > PLANS.plans.findIndex(p => p.id === best.plan)) best = candidate;
    }
  }
  return best ?? {plan: DEFAULT_PLAN, subscription: null, status: list.data[0]?.status ?? 'none', cancel_at_period_end: false, period_end: null};
}

/**
 * Reads the organization's subscription from Stripe and writes the plan it pays for. Returns the plan in force.
 * `audit` is the audit context ({workspace, actor, ip}) or null. The write is one transaction with its audit event and is
 * conditioned on the row still holding the customer and plan that were read, so a racing sync or operator change wins cleanly.
 */
export const syncPlan = (env, store, tenant, audit = null, signal = null) => provider(() => syncPlanNow(env, store, tenant, audit, signal));
async function syncPlanNow(env, store, tenant, audit = null, signal = null) {
  if (!planBillingAvailable(env)) fail(503, 'plan_billing_unavailable');
  const row = await store.getTenant(tenant); if (!row) fail(404, 'tenant_not_found');
  const before = planOf(effectivePlanId(row, env.planBilling.mode)).id;
  // A deleted organization has no plan to move: a late payment or event writes nothing onto it.
  if (Number.isSafeInteger(row.deleted_at)) return {plan: before, changed: false, deleted: true};
  if (row.plan_source === OPERATOR_PLAN_SOURCE) return {plan: before, changed: false, managed_by: 'operator'};
  if (!stripeStateMatches(row, env.planBilling.mode) || typeof row.stripe_customer_id !== 'string') return {plan: before, changed: false};
  // A plan with no source was set by hand before sources existed: Stripe does not take it over.
  if (typeof row.plan_id === 'string' && !isStripePlan(row)) return {plan: before, changed: false, managed_by: 'operator'};
  // Claim a unique revision before reading Stripe. Even a no-change sync supersedes older observations,
  // including observations in the same clock second. Abandoned Stripe reads cannot begin a plan write;
  // a transaction already submitted before abandonment may settle, subject to the revision fence.
  inMode(env.planBilling, await env.planBilling.stripe.customers.retrieve(row.stripe_customer_id));
  const modeFence = stripeStateFence(row);
  const revision = randomUUID(), synced = Number.isSafeInteger(row.plan_synced_at);
  const seen = {ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(deleted_at) AND ' + modeFence.condition + ' AND stripe_customer_id = :customer AND ' + (typeof row.plan_id === 'string' ? 'plan_id = :seen AND plan_source = :source' : 'attribute_not_exists(plan_id)') + ' AND ' + (synced ? 'plan_synced_at = :synced' : 'attribute_not_exists(plan_synced_at)'),
    ExpressionAttributeValues: {...modeFence.values, ':customer': row.stripe_customer_id, ...(typeof row.plan_id === 'string' ? {':seen': row.plan_id, ':source': stripePlanSource(env.planBilling.mode)} : {}), ...(synced ? {':synced': row.plan_synced_at} : {})}};
  const priorRevision = typeof row.plan_sync_revision === 'string';
  if (signal?.aborted) fail(409, 'billing_check_abandoned');
  try { await store._tx([{Update: {Key: tenantKey(tenant), UpdateExpression: 'SET plan_sync_revision = :revision',
    ConditionExpression: seen.ConditionExpression + ' AND ' + (priorRevision ? 'plan_sync_revision = :prior' : 'attribute_not_exists(plan_sync_revision)'),
    ExpressionAttributeValues: {...seen.ExpressionAttributeValues, ':revision': revision, ...(priorRevision ? {':prior': row.plan_sync_revision} : {})}}}]); }
  catch (error) { if (conditional(error)) fail(409, 'billing_changed'); throw error; }
  const paid = await paidPlan(env.planBilling, row.stripe_customer_id), now = store.now();
  if (signal?.aborted) fail(409, 'billing_check_abandoned');
  const same = before === paid.plan && (row.stripe_subscription_id ?? null) === paid.subscription && (row.stripe_subscription_status ?? null) === (paid.subscription ? paid.status : null) &&
    (row.stripe_cancel_at_period_end === true) === paid.cancel_at_period_end && (row.plan_period_end ?? null) === paid.period_end;
  if (same) return {plan: before, changed: false};
  seen.ConditionExpression += ' AND plan_sync_revision = :revision';
  seen.ExpressionAttributeValues[':revision'] = revision;
  const moved = before !== paid.plan;
  // The choice to run past the allowance belongs to a plan that has the spend-cap feature; it does not survive a move to one that lacks it.
  const dropCap = !planOf(paid.plan).features.includes('spend_cap'), removals = [...(paid.period_end === null ? ['plan_period_end'] : []), ...(dropCap ? ['spend_cap'] : [])];
  const update = paid.plan !== DEFAULT_PLAN
    ? {UpdateExpression: 'SET plan_id = :plan, plan_source = :set, stripe_subscription_id = :sub, stripe_subscription_status = :status, stripe_cancel_at_period_end = :cancel, plan_synced_at = :now' + (moved ? ', plan_changed_at = :now' : '') + (paid.period_end === null ? '' : ', plan_period_end = :end') + (removals.length ? ' REMOVE ' + removals.join(', ') : ''),
      ExpressionAttributeValues: {...seen.ExpressionAttributeValues, ':plan': paid.plan, ':set': stripePlanSource(env.planBilling.mode), ':sub': paid.subscription, ':status': paid.status, ':cancel': paid.cancel_at_period_end, ':now': now, ...(paid.period_end === null ? {} : {':end': paid.period_end})}}
    // Back to Free: the plan, its source and the spend-cap choice go; the customer stays so a later Checkout reuses it.
    : {UpdateExpression: 'SET plan_synced_at = :now' + (moved ? ', plan_changed_at = :now' : '') + ' REMOVE plan_id, plan_source, spend_cap, stripe_subscription_id, stripe_subscription_status, stripe_cancel_at_period_end, plan_period_end',
      ExpressionAttributeValues: {...seen.ExpressionAttributeValues, ':now': now}};
  const event = moved && audit ? [auditPut(now, audit, 'billing.plan_changed', tenant, {from: before, to: paid.plan, source: stripePlanSource(env.planBilling.mode)})] : [];
  try { await store._tx([{Update: {Key: tenantKey(tenant), ...update, ConditionExpression: seen.ConditionExpression}}, ...event]); }
  catch (error) { if (conditional(error)) fail(409, 'billing_changed'); throw error; }
  return {plan: paid.plan, changed: moved, previous_plan: before, subscription_status: paid.subscription ? paid.status : null};
}

const EVENTS = new Set(['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed']);
/**
 * POST /api/billing/webhook: a Stripe event, verified with the endpoint's signing secret. The event only says which
 * organization to look at; the plan still comes from reading the subscription back. Events for other products on the
 * same Stripe account (no supatrace_org) are acknowledged and ignored.
 */
export async function planWebhook(request, env) {
  const billing = env.planBilling; if (!planBillingAvailable(env) || !billing.webhookSecret) fail(503, 'plan_billing_webhook_unavailable');
  const signature = request.headers.get('stripe-signature'), raw = await request.text();
  if (!signature || raw.length > 262144) fail(400, 'invalid_webhook');
  let event; try { event = await billing.stripe.webhooks.constructEventAsync(raw, signature, billing.webhookSecret, 300); } catch { fail(400, 'invalid_webhook_signature'); }
  if (event.livemode !== (billing.mode === 'live')) fail(400, 'plan_billing_live_mode_refused');
  if (!EVENTS.has(event.type)) return json({received: true, handled: false});
  const object = inMode(billing, event.data?.object), org = object.metadata?.supatrace_org ?? object.subscription_details?.metadata?.supatrace_org ?? object.parent?.subscription_details?.metadata?.supatrace_org ?? (event.type === 'checkout.session.completed' ? object.client_reference_id : null);
  if (typeof org !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/.test(org)) return json({received: true, handled: false});
  const row = await env.store.getTenant(org), customer = typeof object.customer === 'string' ? object.customer : object.customer?.id;
  // The event must be about the customer this organization owns; a forged org id in metadata changes nothing.
  if (!stripeStateMatches(row, billing.mode) || typeof row.stripe_customer_id !== 'string' || row.stripe_customer_id !== customer) return json({received: true, handled: false});
  const result = await syncPlan(env, env.store, org, {workspace: org, actor: 'stripe:' + String(event.id).slice(0, 40), ip: env.sourceIp});
  return json({received: true, handled: true, plan: result.plan});
}

/** Operator action: assign a plan (normally Enterprise) to an organization, or clear it with null. Used by scripts/set-plan.mjs. */
export function operatorPlanUpdate(tenant, plan, now) {
  if (plan !== null && !PLANS.plans.some(item => item.id === plan && item.id !== DEFAULT_PLAN)) throw new Error('unknown plan ' + plan);
  return plan === null
    ? {Key: tenantKey(tenant), UpdateExpression: 'SET plan_changed_at = :now REMOVE plan_id, plan_source, spend_cap', ConditionExpression: 'attribute_exists(pk) AND plan_source = :operator', ExpressionAttributeValues: {':now': now, ':operator': OPERATOR_PLAN_SOURCE}}
    : {Key: tenantKey(tenant), UpdateExpression: 'SET plan_id = :plan, plan_source = :operator, plan_changed_at = :now', ConditionExpression: 'attribute_exists(pk)', ExpressionAttributeValues: {':plan': plan, ':operator': OPERATOR_PLAN_SOURCE, ':now': now}};
}
