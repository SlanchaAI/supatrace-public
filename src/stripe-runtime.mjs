// Server-only default-off runtime composition. No default credentials, network or grants.
import {HttpError} from './http.mjs';import {stripeTestCatalogHash} from './stripe-test-checkout.mjs';import {createStripeSandboxClient} from './stripe-billing.mjs';
const workerActions=new Set(['runtime.credentials','checkout.reconcile','risk.resolve','subscription.reconcile','capture.process','usage.report']);
const actions=new Set(['runtime.credentials','customer.create','checkout.create','portal.create','webhook.record','checkout.reconcile','risk.resolve','subscription.reconcile','capture.process','usage.report']);
const fail=(status,code)=>{throw new HttpError(status,code);};
async function secret(load,arn,deadline){let timer;if(deadline<=Date.now())fail(503,'stripe_runtime_credentials_unavailable');try{const value=await Promise.race([Promise.resolve().then(()=>load(arn)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),Math.min(2000,deadline-Date.now()));})]);if(typeof value!=='string'||value.length>256||/[\s]/.test(value))fail(503,'stripe_runtime_credentials_unavailable');return value;}catch{fail(503,'stripe_runtime_credentials_unavailable');}finally{clearTimeout(timer);}}
export async function buildStripeSandboxRuntime(input,{loadSecret,authorize,StripeClient,awsAccountId,awsRegion,expectedPurpose='api'}={}){
 if(input?.enabled!==true)return null;let c;try{c=structuredClone(input);}catch{fail(503,'invalid_stripe_runtime_configuration');}
 const fields=['enabled','mode','runtimePurpose','purchasesEnabled','catalog','catalogHash','integrationIdentifier','portalEnabled','portalConfigurationId','bootstrapCustomers','runtimeKeyArn','endpointSecretArns','authorizedActions','approvalRef'];
 if(Object.keys(c).some(k=>!fields.includes(k))||c.mode!=='isolated_sandbox'||c.purchasesEnabled!==false||typeof c.approvalRef!=='string'||!/^[-A-Za-z0-9_:]{8,120}$/.test(c.approvalRef)||!Array.isArray(c.authorizedActions)||!c.authorizedActions.includes('runtime.credentials')||c.authorizedActions.length>10||c.authorizedActions.some(a=>!actions.has(a))||typeof loadSecret!=='function'||typeof authorize!=='function'||typeof StripeClient!=='function'||!/^\d{12}$/.test(awsAccountId||'')||!/^[-a-z0-9]+$/.test(awsRegion||''))fail(503,'invalid_stripe_runtime_configuration');
 const purpose=c.runtimePurpose??'api';if(!['api','worker'].includes(purpose)||purpose!==expectedPurpose||purpose==='worker'&&(c.bootstrapCustomers===true||c.portalEnabled!==false||c.authorizedActions.some(a=>!workerActions.has(a))))fail(503,'invalid_stripe_runtime_purpose');
 const deadline=Date.now()+5000;
 if(c.bootstrapCustomers!==undefined&&typeof c.bootstrapCustomers!=='boolean')fail(503,'invalid_stripe_runtime_configuration');
 if(typeof c.portalEnabled!=='boolean'||c.portalEnabled&&(!/^bpc_[A-Za-z0-9]+$/.test(c.portalConfigurationId||'')))fail(503,'invalid_stripe_runtime_configuration');
 if(c.catalogHash!==stripeTestCatalogHash(c.catalog)||!/^supatrace-checkout-[a-z]{8}$/.test(c.integrationIdentifier||''))fail(503,'invalid_stripe_runtime_configuration');
 const prefix='arn:aws:secretsmanager:'+awsRegion+':'+awsAccountId+':secret:supatrace-stripe-sandbox-';const validArn=a=>typeof a==='string'&&a.startsWith(prefix)&&/^[-A-Za-z0-9_]+$/.test(a.slice(prefix.length));
 if(!validArn(c.runtimeKeyArn)||!Array.isArray(c.endpointSecretArns)||(purpose==='worker'?(c.endpointSecretArns.length!==0||!c.runtimeKeyArn.startsWith(prefix+'worker-runtime-')):(!c.endpointSecretArns.length||c.endpointSecretArns.length>2||c.runtimeKeyArn.startsWith(prefix+'worker-runtime-')))||c.endpointSecretArns.some(a=>!validArn(a))||new Set([c.runtimeKeyArn,...c.endpointSecretArns]).size!==c.endpointSecretArns.length+1)fail(503,'invalid_stripe_runtime_secret_binding');
 const metadata=Object.freeze({action:'runtime.credentials',runtime_purpose:purpose,merchant_id:c.catalog.merchant_id,environment_id:c.catalog.environment_id,secret_arns:Object.freeze([c.runtimeKeyArn,...c.endpointSecretArns]),approval_ref:c.approvalRef,livemode:false});
 let allowed,timer;try{allowed=await Promise.race([Promise.resolve().then(()=>authorize(metadata)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),1000);})]);}catch{fail(403,'stripe_runtime_authorization_required');}finally{clearTimeout(timer);}if(allowed!==true)fail(403,'stripe_runtime_authorization_required');
 const key=await secret(loadSecret,c.runtimeKeyArn,deadline);if(!/^rk_test_[A-Za-z0-9]{16,256}$/.test(key))fail(503,'stripe_runtime_credentials_unavailable');const endpointSecrets=[];for(const arn of c.endpointSecretArns){const value=await secret(loadSecret,arn,deadline);if(!/^whsec_[A-Za-z0-9]{16,240}$/.test(value))fail(503,'stripe_runtime_credentials_unavailable');endpointSecrets.push(value);}
 let client;try{client=createStripeSandboxClient(StripeClient,key);}catch{fail(503,'stripe_runtime_sdk_unavailable');}
 const permitted=new Set(c.authorizedActions),policy=authorize;return {enabled:true,runtimePurpose:purpose,mode:c.mode,purchasesEnabled:false,bootstrapCustomers:c.bootstrapCustomers===true,catalog:c.catalog,catalogHash:c.catalogHash,integrationIdentifier:c.integrationIdentifier,portalEnabled:c.portalEnabled===true,portalConfigurationId:c.portalConfigurationId,endpointSecrets,client,authorize:async action=>permitted.has(action.action)&&await policy(Object.freeze({...action,approval_ref:c.approvalRef}))===true};
}

// Process-local cache; caller supplies server-owned configuration and secret hooks.
export function createStripeRuntimeLoader({build=buildStripeSandboxRuntime,now=Date.now}={}) {
 let cache={key:'',until:0,value:null};
 return async function load(text,hooks) {
  if(!text){cache={key:'',until:0,value:null};return {stripeBilling:undefined,stripeBillingUnavailable:false};}
  try {
   if(typeof text!=='string'||text.length>16384)throw Error('configuration_limit');
   const settings=JSON.parse(text),key=JSON.stringify([text,hooks.awsAccountId,hooks.awsRegion,hooks.expectedPurpose??'api']);
   let value;
   if(cache.key===key&&cache.until>now())value=cache.value;
   else {value=await build(settings,hooks);cache={key,until:now()+300000,value};}
   return {stripeBilling:value||undefined,stripeBillingUnavailable:false};
  }catch{cache={key:'',until:0,value:null};return {stripeBilling:undefined,stripeBillingUnavailable:true};}
 };
}
