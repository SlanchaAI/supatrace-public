import {stripePlanMatches, stripeStateMatches, isStripePlan, stripeObject, planUsagePrefix} from './stripe-plan-state.mjs';
import {planBillingAvailable} from './plan-billing.mjs';
// Hosted Pro overage. Accepted uploads produce a durable aggregate; the scheduled Lambda reports it.
// Stripe deduplicates identifiers for at least 24h. An ambiguous intent older than 12h is held for
// reconciliation rather than risk billing it twice. No Stripe response or credential is logged.
import {createHash} from 'node:crypto';
import {HttpError} from './http.mjs';
import {planLimits,usagePeriod} from './plan-limits.mjs';

export const OVERAGE_EVENT = 'supatrace_pro_overage', OVERAGE_LOOKUP = 'supatrace_pro_overage_monthly';
export const OVERAGE_QUEUE = 'PLAN_OVERAGE#JOBS';
const fail = (status, code) => {throw new HttpError(status, code);};
const inMode = (env, value) => stripeObject(value, env.planBilling?.mode, () => fail(503, 'overage_live_mode_refused'));
const conditional = e => ['ConditionalCheckFailedException', 'TransactionCanceledException'].includes(e?.name);
const root = tenant => ({pk:'TENANT#'+tenant, sk:'META'});

export function overageBound(row, mode = 'test') {
  return stripePlanMatches(row, mode) && row.plan_id === 'pro' &&
    typeof row.overage_price_id === 'string' && row.overage_price_id.length > 0 &&
    typeof row.stripe_customer_id === 'string' && row.stripe_customer_id.length > 0 &&
    typeof row.stripe_subscription_id === 'string' && row.stripe_subscription_id.length > 0 && row.overage_customer_id === row.stripe_customer_id &&
    row.overage_subscription_id === row.stripe_subscription_id;
}

export function planFence(account) {
  const names = ['plan_id','spend_cap', ...(isStripePlan(account) ? ['plan_source','stripe_mode','stripe_customer_id','stripe_subscription_id','plan_period_end','overage_price_id','overage_customer_id','overage_subscription_id'] : [])];
  return {condition:names.map(n => account?.[n] === undefined ? 'attribute_not_exists('+n+')' : n+' = :f_'+n).join(' AND '), values:Object.fromEntries(names.filter(n => account?.[n] !== undefined).map(n => [':f_'+n,account[n]]))};
}

export function requireOverageBinding(account, now, mode = 'test') {
  if (!stripePlanMatches(account, mode) || account.plan_id !== 'pro' || account.spend_cap !== false) return;
  if (!overageBound(account, mode)) fail(409, 'overage_binding_required');
  if (!Number.isSafeInteger(account.plan_period_end) || account.plan_period_end <= now) fail(409, 'overage_billing_period_refresh_required');
}

/** Prepare the metered item before allowing cap-off. The final store write fences the subscription. */
export async function prepareOverage(env, store, tenant) {
  if (!planBillingAvailable(env)) fail(503, 'overage_test_billing_unavailable');
  const row = await store.getTenant(tenant);
  if (row?.plan_id !== 'pro' || !stripePlanMatches(row, env.planBilling.mode)) fail(409, 'overage_paid_pro_required');
  const stripe = env.planBilling.stripe;
  try {
    const subscription = inMode(env, await stripe.subscriptions.retrieve(row.stripe_subscription_id));
    if (subscription.customer !== row.stripe_customer_id || subscription.metadata?.supatrace_org !== tenant || subscription.status !== 'active' || subscription.cancel_at_period_end || subscription.pending_update) fail(409, 'overage_subscription_not_active');
    const prices = await stripe.prices.list({lookup_keys:[OVERAGE_LOOKUP, 'supatrace_pro_monthly'], active:true, limit:10});
    const price = inMode(env, prices.data.find(p => p.lookup_key === OVERAGE_LOOKUP));
    const fixed = inMode(env, prices.data.find(p => p.lookup_key === 'supatrace_pro_monthly'));
    if (price.currency !== 'usd' || price.billing_scheme !== 'per_unit' || String(price.unit_amount_decimal) !== '0.0005' || price.transform_quantity || price.recurring?.interval !== 'month' || price.recurring.interval_count !== 1 || price.recurring.usage_type !== 'metered' || !price.recurring.meter || fixed.currency !== 'usd' || fixed.unit_amount !== 2599 || fixed.recurring?.interval !== 'month' || fixed.recurring.interval_count !== 1 || fixed.recurring.usage_type !== 'licensed') fail(503, 'overage_price_mismatch');
    for (const item of subscription.items?.data ?? []) inMode(env, item.price);
    if (subscription.items?.data?.filter(i => i.price?.id === fixed.id).length !== 1) fail(409, 'overage_subscription_not_active');
    const meter = inMode(env, await stripe.billing.meters.retrieve(price.recurring.meter));
    if (meter.status !== 'active' || meter.event_name !== OVERAGE_EVENT || meter.event_time_window || meter.default_aggregation?.formula !== 'sum' || meter.customer_mapping?.type !== 'by_id' || meter.customer_mapping.event_payload_key !== 'stripe_customer_id' || meter.value_settings?.event_payload_key !== 'value') fail(503, 'overage_meter_mismatch');
    if (!subscription.items.data.some(i => i.price?.id === price.id)) {
      const updated = inMode(env, await stripe.subscriptions.update(subscription.id, {items:[{price:price.id}], proration_behavior:'none'}, {idempotencyKey:'supatrace-overage-'+subscription.id}));
      for (const item of updated.items?.data ?? []) inMode(env, item.price);
      if (updated.customer !== row.stripe_customer_id || !updated.items?.data?.some(i => i.price?.id === price.id)) fail(502, 'overage_binding_failed');
    }
    return {customer:row.stripe_customer_id, subscription:row.stripe_subscription_id, price:price.id};
  } catch (error) {if (error instanceof HttpError) throw error; fail(502, 'overage_provider_unavailable');}
}

/** Called inside acceptance's upload_seq compare-and-swap, sharing its transaction and root usage counters. */
export async function acceptedOverage(store, tenant, account, batch, now) {
  if ((batch.usage_mode ?? 'test') !== (store.planBillingMode ?? 'test') || !overageBound(account, store.planBillingMode) || account.spend_cap !== false) return [];
  if (!Number.isSafeInteger(account.plan_period_end) || account.plan_period_end <= now) fail(409, 'overage_billing_period_refresh_required');
  const period = typeof batch.usage_period === 'string' && /^[0-9]{4}-(0[1-9]|1[0-2])$/.test(batch.usage_period) ? batch.usage_period : usagePeriod(Number.isSafeInteger(batch.created_at) && batch.created_at >= 0 ? batch.created_at : now).id;
  const month = await store._get({pk:root(tenant).pk, sk:planUsagePrefix(store.planBillingMode)+period});
  const before = month?.accepted_spans ?? 0, cap = planLimits('pro').spans_per_month;
  const delta = Math.max(0, before + batch.event_count - cap) - Math.max(0, before - cap);
  if (!delta) return [];
  const mode = store.planBillingMode ?? 'test';
  const sk = 'PLAN_OVERAGE#'+(mode === 'live' ? 'live#' : '')+account.plan_period_end+'#'+period+'#'+account.stripe_subscription_id;
  const generation = (account.upload_seq ?? 0) + 1;
  return [
    {Update:{Key:{pk:root(tenant).pk,sk}, UpdateExpression:'SET stripe_mode = :mode, tenant_id = :tenant, customer_id = :customer, subscription_id = :subscription, period_end = :end, first_timestamp = if_not_exists(first_timestamp, :now), last_timestamp = :now ADD billable_spans :delta', ExpressionAttributeValues:{':mode':mode, ':tenant':tenant, ':customer':account.stripe_customer_id, ':subscription':account.stripe_subscription_id, ':end':account.plan_period_end, ':now':now, ':delta':delta}}},
    {Put:{Item:{pk:OVERAGE_QUEUE, sk:tenant+'#'+sk, owner:tenant, ledger_sk:sk, generation}}}
  ];
}

async function reportJob(env, job) {
  const {store} = env, key = {pk:root(job.owner).pk, sk:job.ledger_sk};
  let ledger = await store._get(key);
  if (!ledger || ledger.tenant_id !== job.owner || !Number.isSafeInteger(ledger.billable_spans)) throw Error('overage_invalid_ledger');
  if (!stripeStateMatches(ledger, env.planBilling?.mode)) return;
  if (ledger.held === true) throw Error('overage_reconciliation_required');
  const reported = ledger.reported_spans ?? 0;
  if (!ledger.pending && ledger.billable_spans > reported) {
    const id = createHash('sha256').update(JSON.stringify([key, reported, ledger.billable_spans])).digest('hex');
    const pending = {identifier:id, upto:ledger.billable_spans, delta:ledger.billable_spans-reported, timestamp:ledger.last_timestamp, created_at:store.now()};
    try {await store._tx([{Update:{Key:key, UpdateExpression:'SET pending = :pending', ConditionExpression:'billable_spans = :total AND attribute_not_exists(pending) AND '+(ledger.reported_spans === undefined ? 'attribute_not_exists(reported_spans)' : 'reported_spans = :reported'), ExpressionAttributeValues:{':pending':pending, ':total':ledger.billable_spans, ...(ledger.reported_spans === undefined ? {} : {':reported':reported})}}}]);}
    catch (error) {if (!conditional(error)) throw error; return;}
    ledger = {...ledger, pending};
  }
  if (ledger.pending) {
    const p = ledger.pending;
    if (store.now()-p.created_at >= 12*3600 || store.now()-p.timestamp >= 35*86400) {
      await store._tx([{Update:{Key:key, UpdateExpression:'SET held = :held', ExpressionAttributeValues:{':held':true}}}]);
      throw Error('overage_reconciliation_required');
    }
    if (!planBillingAvailable(env)) throw Error('overage_test_billing_unavailable');
    const subscription = inMode(env, await env.planBilling.stripe.subscriptions.retrieve(ledger.subscription_id));
    if (subscription.customer !== ledger.customer_id || subscription.metadata?.supatrace_org !== job.owner || !['active','trialing','past_due'].includes(subscription.status)) throw Error('overage_subscription_reconciliation_required');
    const result = inMode(env, await env.planBilling.stripe.billing.meterEvents.create({event_name:OVERAGE_EVENT, payload:{stripe_customer_id:ledger.customer_id, value:String(p.delta)}, identifier:p.identifier, timestamp:p.timestamp}, {idempotencyKey:p.identifier}));
    if (result.identifier !== p.identifier) throw Error('overage_response_mismatch');
    try {await store._tx([{Update:{Key:key, UpdateExpression:'SET reported_spans = :upto, last_reported_at = :now REMOVE pending', ConditionExpression:'pending = :pending', ExpressionAttributeValues:{':upto':p.upto, ':pending':p, ':now':store.now()}}}]);}
    catch (error) {if (!conditional(error)) throw error; return;}
  }
  const current = await store._get(key);
  if ((current?.reported_spans ?? 0) < current?.billable_spans || current?.pending) return;
  // Only remove the job observed before reporting. A concurrent accepted upload leaves its new generation queued.
  try {await store._tx([{Delete:{Key:{pk:job.pk,sk:job.sk}, ConditionExpression:'generation = :generation', ExpressionAttributeValues:{':generation':job.generation}}}]);}
  catch (error) {if (!conditional(error)) throw error;}
}

/** Producer: acceptReservedBatch. Caller: the dedicated EventBridge rule in aws/template.yaml. */
export async function reportOverage(env, {deadline=Date.now()+9000, owner=null}={}) {
  const {store} = env; let cursor=null, processed=0, failed=false;
  do {
    const page=await store._page(OVERAGE_QUEUE, owner ? owner+'#' : '', {limit:25,cursor});
    for (const job of page.items) {
      if (Date.now()>=deadline) {if (failed) throw Error('overage_reporting_failed'); return {processed};}
      if (job.retry_at>store.now()) continue;
      try {await reportJob(env,job); processed++;}
      catch {
        failed=true;
        try {await store._tx([{Update:{Key:{pk:job.pk,sk:job.sk}, UpdateExpression:'SET retry_at = :retry', ConditionExpression:'generation = :generation', ExpressionAttributeValues:{':retry':store.now()+600, ':generation':job.generation}}}]);} catch (e) {if (!conditional(e)) throw e;}
      }
    }
    cursor=page.next;
  } while(cursor && Date.now()<deadline);
  if (failed) throw Error('overage_reporting_failed');
  return {processed};
}

/** Account erasure cannot discard a queued charge or cancel before Stripe has aggregated accepted usage. */
export async function settleOverage(env, owner, priceId, deadline) {
  await reportOverage(env,{owner,deadline});
  const {store}=env;
  let queuedCursor=null;
  do {
    if(Date.now()>=deadline)throw Error('overage_settlement_pending');
    const queued=await store._page(OVERAGE_QUEUE,owner+'#',{limit:100,cursor:queuedCursor});
    for(const job of queued.items){
      const ledger=await store._get({pk:root(owner).pk,sk:job.ledger_sk});
      if(!ledger||stripeStateMatches(ledger,env.planBilling?.mode))throw Error('overage_settlement_pending');
    }
    queuedCursor=queued.next;
  }while(queuedCursor);
  let cursor=null, total=0, first=Infinity, last=0, customer=null;
  do {
    if(Date.now()>=deadline)throw Error('overage_settlement_pending');
    const page=await store._page(root(owner).pk,'PLAN_OVERAGE#',{limit:100,cursor});
    for(const row of page.items){
      if(!stripeStateMatches(row,env.planBilling?.mode))continue;
      if(row.pending||row.held||row.reported_spans!==row.billable_spans||row.tenant_id!==owner||(customer&&customer!==row.customer_id))throw Error('overage_settlement_pending');
      total+=row.billable_spans;first=Math.min(first,row.first_timestamp);last=Math.max(last,row.last_timestamp);customer=row.customer_id;
    }
    cursor=page.next;
  }while(cursor);
  if(!total)return false;
  if(!planBillingAvailable(env))throw Error('overage_test_billing_unavailable');
  if(typeof priceId !== 'string' || !priceId)throw Error('overage_settlement_pending');
  const stripe=env.planBilling.stripe,price=inMode(env, await stripe.prices.retrieve(priceId));
  const summaries=await stripe.billing.meters.listEventSummaries(price.recurring.meter,{customer,start_time:Math.floor(first/60)*60,end_time:Math.ceil((last+1)/60)*60,limit:100});
  if(summaries.has_more||summaries.data.reduce((sum,row)=>sum+inMode(env, row).aggregated_value,0)!==total)throw Error('overage_settlement_pending');
  return true;
}
