// Entitlements: what an organization's plan allows. One table (PLANS in src/plans.mjs) decides every count limit
// and feature flag. The API calls requireFeature / requireCount on each gated route, and the dashboard reads the
// same answer from GET /api/entitlements, so the two cannot disagree. The plan itself is `plan_id` on the
// organization's account row: set by a reconciled Stripe subscription (Base, Pro) or by an operator
// (Enterprise). Anything unknown or malformed resolves to Free: a bad row never grants more.
import {HttpError} from './http.mjs';
import {PLANS, FEATURES} from './plans.mjs';

export const UPGRADE_PATH = '/app/#billing';
export const DEFAULT_PLAN = 'free';
export const COUNT_LIMITS = Object.freeze(['workspaces', 'projects', 'environments', 'seats', 'api_keys']);
const byId = Object.freeze(Object.fromEntries(PLANS.plans.map(plan => [plan.id, plan])));
const order = PLANS.plans.map(plan => plan.id);
export const planOf = planId => typeof planId === 'string' && Object.hasOwn(byId, planId) ? byId[planId] : byId[DEFAULT_PLAN];
/** The cheapest plan that has the feature, or null when no plan does. */
export const minimumPlan = feature => PLANS.plans.find(plan => plan.features.includes(feature)) ?? null;
export const hasFeature = (planId, feature) => Object.hasOwn(FEATURES, feature) && planOf(planId).features.includes(feature);

/** The full answer for one plan: used by GET /api/entitlements and by the dashboard. */
export function entitlementsFor(planId) {
  const plan = planOf(planId);
  return {
    plan_id: plan.id, plan_name: plan.name, catalog_version: PLANS.version, upgrade_url: UPGRADE_PATH,
    limits: {spans_per_month: plan.included_spans_per_month, stored_bytes: plan.storage_gb * 1000000000, retention_days: plan.retention_days, ...Object.fromEntries(COUNT_LIMITS.map(name => [name, plan[name]]))},
    features: Object.fromEntries(Object.keys(FEATURES).map(feature => {
      const needs = minimumPlan(feature);
      return [feature, {enabled: plan.features.includes(feature), label: FEATURES[feature].label, required_plan: needs?.id ?? null, required_plan_name: needs?.name ?? null}];
    }))
  };
}
function refuse(code, details) { const error = new HttpError(402, code); error.details = {...details, upgrade_url: UPGRADE_PATH}; return error; }
/** Throws 402 plan_upgrade_required unless the plan has the feature. The details name the plan that unlocks it. */
export function requireFeature(planId, feature) {
  if (!Object.hasOwn(FEATURES, feature)) throw new TypeError('unknown feature ' + feature);
  if (hasFeature(planId, feature)) return;
  const plan = planOf(planId), needs = minimumPlan(feature);
  throw refuse('plan_upgrade_required', {feature, plan: plan.id, required_plan: needs?.id ?? 'enterprise', message: FEATURES[feature].label + ' needs the ' + (needs?.name ?? 'Enterprise') + ' plan. This organization is on ' + plan.name + '.'});
}
/** The plan's limit for a counted thing; null is unlimited. */
export function countLimit(planId, name) {
  if (!COUNT_LIMITS.includes(name)) throw new TypeError('unknown limit ' + name);
  return planOf(planId)[name];
}
const NOUNS = Object.freeze({workspaces: 'created workspaces', projects: 'projects', environments: 'environments', seats: 'members', api_keys: 'active API keys'});
/** Throws 402 plan_limit_reached when `used` already meets the plan's limit. Existing items are never removed. */
export function requireCount(planId, name, used) {
  const limit = countLimit(planId, name);
  if (limit === null || used < limit) return;
  const plan = planOf(planId), next = PLANS.plans.slice(order.indexOf(plan.id) + 1).find(candidate => candidate[name] === null || candidate[name] > limit);
  throw refuse('plan_limit_reached', {limit_name: name, plan: plan.id, limit, used, ...(next ? {required_plan: next.id} : {}), message: (name === 'api_keys' ? 'Revoke an unused key in API keys (/app/#keys) before creating another. ' : '') + 'The ' + plan.name + ' plan allows ' + limit + ' ' + NOUNS[name] + '.' + (next ? ' ' + next.name + ' allows ' + (next[name] === null ? 'unlimited' : next[name]) + '.' : '')});
}
/** Body fields a 402 from this module may carry to the client. */
export const ENTITLEMENT_CODES = new Set(['plan_upgrade_required', 'plan_limit_reached']);
export function entitlementDetails(error) {
  const d = error?.details; if (!ENTITLEMENT_CODES.has(error?.code) || !d || typeof d !== 'object') return {};
  const out = {}; for (const key of ['message', 'feature', 'limit_name', 'plan', 'required_plan', 'limit', 'used', 'upgrade_url']) if (typeof d[key] === 'string' || Number.isSafeInteger(d[key])) out[key] = d[key]; return out;
}
