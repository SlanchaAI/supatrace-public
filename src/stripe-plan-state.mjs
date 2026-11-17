// Legacy unmarked customers belong to test mode. Live customers always require an explicit marker.
export const stripePlanSource = mode => 'stripe_' + mode;
export const isStripePlan = row => ['stripe_test', 'stripe_live'].includes(row?.plan_source);
export const stripeStateMatches = (row, mode = 'test') => !!row &&
  (!isStripePlan(row) || row.plan_source === stripePlanSource(mode)) &&
  (row.stripe_mode === mode || (mode === 'test' && row.stripe_mode === undefined && row.plan_source !== 'stripe_live'));
export const stripePlanMatches = (row, mode = 'test') => row?.plan_source === stripePlanSource(mode) && stripeStateMatches(row, mode);
export const effectivePlanId = (row, mode = 'test') => isStripePlan(row) && !stripePlanMatches(row, mode) ? null : row?.plan_id;
export const stripeObject = (object, mode, refuse) => object?.livemode === (mode === 'live') ? object : refuse();
// Fence the raw state even when its plan is inactive in this runtime.
export function stripeStateFence(row) {
  const fields = ['stripe_mode', 'stripe_customer_id', 'stripe_subscription_id', 'plan_source', 'stripe_previous_test', 'stripe_previous_live'];
  return {condition: fields.map(n => row?.[n] === undefined ? 'attribute_not_exists('+n+')' : n+' = :b_'+n).join(' AND '),
    values: Object.fromEntries(fields.filter(n => row?.[n] !== undefined).map(n => [':b_'+n, row[n]]))};
}

const billingBinding = row => typeof row?.stripe_customer_id === 'string' || typeof row?.stripe_subscription_id === 'string';
export const hasLiveBilling = row => ((row?.stripe_mode === 'live' || row?.plan_source === 'stripe_live') && billingBinding(row)) || billingBinding(row?.stripe_previous_live);
// Test state can be discarded in live mode. Real subscriptions need closure with live credentials.
export const inactiveLiveBilling = (row, mode) => billingBinding(row?.stripe_previous_live) || (hasLiveBilling(row) && (mode !== 'live' || !stripeStateMatches(row, 'live')));

// Existing monthly rows belong to test mode, including unmarked reservations.
export const planUsagePrefix = (mode = 'test') => mode === 'live' ? 'USAGE#live#' : 'USAGE#';
