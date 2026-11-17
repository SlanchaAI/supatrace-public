// Sandbox rehearsal only. This ledger is never an upload quota or paid-access authority.
import {createHash} from 'node:crypto';
import {HttpError} from './http.mjs';
import {alphaProject} from './alpha-projects.mjs';
import {validateCommercialPolicy} from './commercial-policy.mjs';
import {stripeTestCatalogHash,stripeTestDecision} from './stripe-test-checkout.mjs';
import {PLAN_LIMITS} from './plan-limits.mjs';
import {PLANS} from './plans.mjs';
// Only plans sold through Checkout may be priced here. Enterprise is assigned by an operator and never bought.
const SOLD_PLANS=new Set(PLANS.plans.filter(plan=>plan.checkout===true).map(plan=>plan.id));

// Opt-in value of the `planLimits` setting. With it, a reconciled Stripe TEST-mode subscription assigns the
// account's plan (src/plan-limits.mjs) and an ended one returns it to Free. Test mode only: no live key, price
// or payment is involved, and nothing here makes a plan purchasable with real money.
export const TEST_PLAN_LIMITS='test_mode';
// plan_source written on the account row with a test-mode plan, so only this path changes or clears it.
export const TEST_PLAN_SOURCE='stripe_test';

const decisions = new WeakMap();
const fail = code => { throw new HttpError(409,code); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function validateSandboxEntitlementConfiguration(input,ceiling) {
  if(input?.enabled!==true)return null;
  const c=structuredClone(input),view=validateCommercialPolicy(c.policy,c.policyHash),p=view.policy;
  if(Object.keys(c).some(k=>!['enabled','policy','policyHash','catalog','catalogHash','planLimits'].includes(k))||
    (c.planLimits!==undefined&&c.planLimits!==TEST_PLAN_LIMITS)||
    p.livemode!==false||c.catalog?.merchant_id!==p.merchant_id||c.catalog.environment_id!==p.environment_id||
    c.catalog.revision!==view.hash||c.catalogHash!==stripeTestCatalogHash(c.catalog)||
    !Number.isSafeInteger(ceiling)||p.plans.some(plan=>plan.storage_limit_bytes>ceiling))fail('sandbox_entitlement_policy_mismatch');
  const plans=p.plans.filter(plan=>plan.price_id!==null);
  if(plans.length!==Object.keys(c.catalog.prices).length||plans.some(plan=>{
    const price=c.catalog.prices[plan.price_id];
    return !price||price.unit_amount!==plan.unit_amount||price.currency!==plan.currency||price.interval!==plan.interval;
  }))fail('sandbox_entitlement_catalog_mismatch');
  // Plan assignment needs every policy plan to be a plan the limits table enforces: the free plan is the
  // default plan and each paid plan is a different enforceable plan. Anything else is refused at composition.
  const planLimits=c.planLimits===TEST_PLAN_LIMITS;
  if(planLimits&&(p.free_plan_id!==PLAN_LIMITS.default_plan||plans.some(plan=>plan.id===PLAN_LIMITS.default_plan||!SOLD_PLANS.has(plan.id))))fail('sandbox_entitlement_plan_limits_mismatch');
  return Object.freeze({...view,catalogHash:c.catalogHash,apiVersion:c.catalog.api_version,planLimits});
}

// Store and worker must independently opt in to the same pinned policy/catalog.
// Neither AWS JSON runtime loader installs this composition.
export function sandboxEntitlementConfiguration(env) {
  const c=env.stripeSandboxEntitlements,stored=env.store.sandboxEntitlementPolicy;
  if(c?.enabled!==true&&!stored)return null;
  const view=validateSandboxEntitlementConfiguration(c,env.store.limits.tenantBytes);
  if(!view||!stored||stored.hash!==view.hash||stored.catalogHash!==view.catalogHash||stored.planLimits!==view.planLimits||
    env.stripeBilling?.catalogHash!==view.catalogHash)fail('sandbox_entitlement_composition_mismatch');
  return view;
}

export function planSandboxEntitlement(decision,view) {
  const d=stripeTestDecision(decision),p=validateCommercialPolicy(view.policy,view.hash).policy;
  if(d.catalog_hash!==view.catalogHash||d.merchant_id!==p.merchant_id||d.environment_id!==p.environment_id||p.livemode!==false)fail('sandbox_entitlement_decision_mismatch');
  let plan=null,active=d.eligible===true;
  if(active){
    plan=p.plans.find(plan=>plan.price_id===d.price_id&&plan.price_id!==null);
    if(!plan||d.price_object!=='price'||d.invoice_subscription_id!==d.subscription_id||
      d.invoice_own_account!==true)fail('sandbox_entitlement_invoice_binding_mismatch');
    active=d.invoice_amount_paid>=d.invoice_amount_due&&(p.invoice_policy==='paid_invoice'||
      d.invoice_amount_paid>=plan.unit_amount&&d.invoice_amount_due>=plan.unit_amount);
  }
  const value=Object.freeze({reconciliation_hash:hash(d),tenant_id:d.tenant_id,project_id:alphaProject(d.tenant_id).id,
    merchant_id:d.merchant_id,environment_id:d.environment_id,livemode:false,customer_id:d.customer_id,
    subscription_id:d.subscription_id,binding_revision:d.binding_revision,policy_hash:view.hash,policy_revision:p.revision,
    catalog_hash:view.catalogHash,status:active?'active':'blocked',plan_id:active?plan.id:null,
    storage_limit_bytes:active?plan.storage_limit_bytes:0,observed_at:d.observed_at,
    expires_at:active?Math.min(d.expires_at,d.observed_at+p.lease_seconds):d.observed_at,
    source:'sandbox_current_state',paid_access:false,purchases_enabled:false,quota_enforced:view.planLimits===true});
  const token=Object.freeze({});decisions.set(token,value);return token;
}

export function sandboxEntitlementDecision(token,decision,view) {
  const value=decisions.get(token);
  if(!value||value.reconciliation_hash!==hash(stripeTestDecision(decision))||value.policy_hash!==view?.hash||
    value.catalog_hash!==view?.catalogHash)fail('verified_sandbox_entitlement_required');
  return {...value};
}
