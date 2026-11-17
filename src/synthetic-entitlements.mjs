// Replacement contract: prior payment-contract-20261029 source unavailable.
// Synthetic fixture offers only; NOT commercial pricing, Stripe events or purchases.
export const SYNTHETIC_PLANS=Object.freeze({'synthetic-free':1024,'synthetic-pro':4096});
export function syntheticEntitlement(row){
 if(typeof row?.synthetic_plan!=='string'||!Object.hasOwn(SYNTHETIC_PLANS,row.synthetic_plan))throw Object.assign(Error('synthetic_entitlement_unavailable'),{status:503,code:'synthetic_entitlement_unavailable'});
 const limit=SYNTHETIC_PLANS[row.synthetic_plan];
 if(!Number.isSafeInteger(limit)||row.byte_limit!==limit||!Number.isSafeInteger(row.entitlement_revision)||row.entitlement_revision<1||typeof row.entitlement_active!=='boolean')throw Object.assign(Error('synthetic_entitlement_unavailable'),{status:503,code:'synthetic_entitlement_unavailable'});
 return {plan_id:row.synthetic_plan,byte_limit:limit,revision:row.entitlement_revision,status:row.entitlement_active?'active':'suspended',purchases_enabled:false,synthetic:true,accounting:'cumulative_reserved_bytes_not_monthly'};
}
