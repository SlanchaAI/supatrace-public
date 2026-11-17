// Explicit isolated composition only. Production JSON loaders do not import this module.
import {HttpError} from './http.mjs';
import {buildStripeSandboxRuntime} from './stripe-runtime.mjs';
import {validateSandboxEntitlementConfiguration} from './stripe-sandbox-entitlements.mjs';
import {DynamoMetadataStore} from './dynamodb-store.mjs';
const fail=code=>{throw new HttpError(503,code);};
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join()===keys.sort().join();
export async function composeStripeEntitlementSandbox(input,hooks={}){
 if(input?.enabled!==true)return null;
 let c;try{c=structuredClone(input);}catch{fail('sandbox_composition_invalid');}
 if(!exact(c,['enabled','purpose','runtime','entitlements','tables','operationalCeiling','entitlementActions'])||!['api','worker'].includes(c.purpose)||!exact(c.tables,['metadata','inbox','state'])||Object.values(c.tables).some(t=>typeof t!=='string'||!/^[-A-Za-z0-9_.]{3,255}$/.test(t))||new Set(Object.values(c.tables)).size!==3||!Number.isSafeInteger(c.operationalCeiling)||c.operationalCeiling<1||!Array.isArray(c.entitlementActions)||c.entitlementActions.length!==1||c.entitlementActions[0]!==('sandbox.entitlement.'+(c.purpose==='api'?'view':'reconcile'))||hooks.storeOptions?.commercialControls||typeof hooks.authorize!=='function')fail('sandbox_composition_invalid');
 // Policy, catalog, revision, merchant/environment and ceiling are pinned BEFORE vault access.
 const view=validateSandboxEntitlementConfiguration(c.entitlements,c.operationalCeiling);
 if(!view||c.runtime?.enabled!==true||c.runtime.runtimePurpose!==c.purpose||c.runtime.mode!=='isolated_sandbox'||c.runtime.purchasesEnabled!==false||c.runtime.catalogHash!==view.catalogHash||JSON.stringify(c.runtime.catalog)!==JSON.stringify(c.entitlements.catalog))fail('sandbox_composition_mismatch');
 if(c.purpose==='api'&&c.runtime.authorizedActions?.some(a=>['checkout.reconcile','risk.resolve','subscription.reconcile','capture.process'].includes(a)))fail('sandbox_composition_purpose_mismatch');
 const store=new DynamoMetadataStore({...hooks.storeOptions,tableName:c.tables.metadata,stripeInboxTableName:c.tables.inbox,stripeStateTableName:c.tables.state,tenantBytes:c.operationalCeiling,stripeTestInbox:true,stripeTestEnvironment:view.policy.environment_id,stripeSandboxEntitlements:c.entitlements});
 const runtime=await buildStripeSandboxRuntime(c.runtime,{...hooks,expectedPurpose:c.purpose});
 if(!runtime)fail('sandbox_composition_mismatch');
 const allowed=new Set(c.entitlementActions),authorize=hooks.authorize;
 const stripeBilling={...runtime,captureOnly:true,authorize:async action=>{
  if(action.action.startsWith('sandbox.entitlement.')){if(action.merchant_id!==view.policy.merchant_id||action.environment_id!==view.policy.environment_id||action.livemode!==false)return false;return allowed.has(action.action)&&await authorize(Object.freeze({...action,runtime_purpose:c.purpose,approval_ref:c.runtime.approvalRef,policy_hash:view.hash,catalog_hash:view.catalogHash}))===true;}
  return runtime.authorize(action);
 }};
 return {store,stripeBilling,stripeSandboxEntitlements:structuredClone(c.entitlements),sandboxComposition:Object.freeze({purpose:c.purpose,merchant_id:view.policy.merchant_id,stripe_environment_id:view.policy.environment_id,policy_hash:view.hash,catalog_hash:view.catalogHash,paid_access:false,quota_enforced:false})};
}
