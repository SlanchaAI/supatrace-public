import {STRIPE_REVIEWED_API_VERSION} from './stripe-test-policy.mjs';
// Server-only verified-live boundary. No default transport, credentials or activation.
import {randomBytes} from 'node:crypto';
import {HttpError,json} from './http.mjs';
import {commercialConfiguration,authorizeCommercial,validateCommercialPolicy} from './commercial-policy.mjs';
const verifiers=new WeakSet(),decisions=new WeakMap();
const fail=(code,status=503)=>{throw new HttpError(status,code);};
export function commercialDecision(token){const value=decisions.get(token);if(!value)fail('verified_live_commercial_decision_required',400);return structuredClone(value);}
export function createCommercialLiveVerifier({readCurrentState,readRiskState,authorize,now=Date.now}={}){
 if(typeof readCurrentState!=='function'||typeof readRiskState!=='function'||typeof authorize!=='function'||typeof now!=='function')fail('commercial_live_verifier_not_configured');
 const verify=async(binding,view,watermark)=>{
  try{binding=structuredClone(binding);view=validateCommercialPolicy(view?.policy,view?.hash);watermark=watermark==null?null:structuredClone(watermark);}catch{fail('commercial_live_binding_required',409);}
  if(!Number.isSafeInteger(binding?.revision)||binding.revision<1||watermark&&(!Number.isSafeInteger(watermark.revision)||watermark.revision<1||!Number.isSafeInteger(watermark.observed_at)))fail('commercial_live_binding_required',409);
  const p=view.policy;if(p.livemode!==true||binding?.livemode!==true||binding.merchant_id!==p.merchant_id||binding.environment_id!==p.environment_id||!/^cus_[A-Za-z0-9]{1,180}$/.test(binding.customer_id||'')||!/^sub_[A-Za-z0-9]{1,180}$/.test(binding.subscription_id||''))fail('commercial_live_binding_required',409);
  const start=now(),controller=new AbortController();let timer;
  const bounded=async fn=>{const left=start+25000-now();if(left<=0)fail('commercial_verification_timeout');let t;try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{t=setTimeout(()=>{controller.abort();reject(Error('timeout'));},left);})]);}catch{fail('commercial_verification_unavailable');}finally{clearTimeout(t);}};
  try{
   timer=setTimeout(()=>controller.abort(),25000);
   if(await bounded(()=>authorize(Object.freeze({action:'commercial.provider.read',tenant_id:binding.tenant_id,merchant_id:p.merchant_id,environment_id:p.environment_id,policy_hash:view.hash,livemode:true})))!==true)fail('commercial_action_not_authorized',403);
   const current=structuredClone(await bounded(()=>readCurrentState(structuredClone(binding),{signal:controller.signal,deadline:start+25000,apiVersion:STRIPE_REVIEWED_API_VERSION})));
   const {account,customer,subscription:sub,invoice}=current||{};
   if(current?.api_version!==STRIPE_REVIEWED_API_VERSION||account?.object!=='account'||account.id!==p.merchant_id||customer?.object!=='customer'||customer.id!==binding.customer_id||customer.livemode!==true||customer.deleted||sub?.object!=='subscription'||sub.id!==binding.subscription_id||sub.customer!==binding.customer_id||sub.livemode!==true||sub.on_behalf_of!=null||sub.application!=null||!['active','trialing','past_due','unpaid','canceled','incomplete','incomplete_expired','paused'].includes(sub.status))fail('commercial_provider_binding_mismatch',409);
   let plan=null,status='blocked',reason='not_current_paid_active_subscription',expires=Math.floor(start/1000)+p.lease_seconds;
   if(sub.status==='active'&&sub.pause_collection==null&&sub.pending_update==null){
    const items=sub.items;if(items?.has_more!==false||!Array.isArray(items.data)||items.data.length!==1)fail('commercial_complete_subscription_required',409);const item=items.data[0],price=item?.price;plan=p.plans.find(x=>x.price_id!==null&&x.price_id===price?.id);
    if(!plan||item.quantity!==1||item.subscription!==sub.id||price.object!=='price'||price.active!==true||price.livemode!==true||price.type!=='recurring'||price.currency!==plan.currency||price.unit_amount!==plan.unit_amount||price.recurring?.interval!==plan.interval||price.recurring?.interval_count!==1)fail('commercial_price_contract_mismatch',409);
    if(!Number.isSafeInteger(item.current_period_start)||!Number.isSafeInteger(item.current_period_end)||item.current_period_start>Math.floor(start/1000)||item.current_period_end<=Math.floor(start/1000))fail('commercial_subscription_period_invalid',409);
    const paid=invoice?.object==='invoice'&&invoice.id===sub.latest_invoice&&invoice.customer===binding.customer_id&&invoice.livemode===true&&invoice.status==='paid'&&invoice.currency===plan.currency&&invoice.amount_remaining===0&&Number.isSafeInteger(invoice.amount_paid)&&Number.isSafeInteger(invoice.amount_due)&&invoice.amount_due>=0&&invoice.amount_paid>=invoice.amount_due&&(p.invoice_policy==='paid_invoice'||invoice.amount_paid>=plan.unit_amount&&invoice.amount_due>=plan.unit_amount);
    if(paid){const risk=await bounded(()=>readRiskState(structuredClone(binding),{signal:controller.signal,deadline:start+25000,apiVersion:STRIPE_REVIEWED_API_VERSION}));if(risk?.livemode!==true||risk.api_version!==STRIPE_REVIEWED_API_VERSION||risk.source!=='verified_live_risk_adapter'||risk.merchant_id!==p.merchant_id||risk.customer_id!==binding.customer_id||risk.subscription_id!==binding.subscription_id||!['clear','hold'].includes(risk.state)||!Number.isSafeInteger(risk.checked_at)||risk.checked_at<start||risk.checked_at>now())fail('commercial_risk_verification_required',409);if(risk.state==='clear'){status='active';reason='verified_current_paid_live_subscription';expires=Math.min(expires,item.current_period_end);}else reason='risk_review_required';}
   }
   if(now()-start>25000||controller.signal.aborted)fail('commercial_verification_timeout');
   const value={tenant_id:binding.tenant_id,merchant_id:p.merchant_id,environment_id:p.environment_id,livemode:true,customer_id:binding.customer_id,subscription_id:binding.subscription_id,binding_revision:binding.revision,policy_hash:view.hash,policy_revision:p.revision,plan_id:status==='active'?plan.id:null,price_id:status==='active'?plan.price_id:null,status,reason,source:'verified_live_current_state',observed_at:start,expires_at:expires,previous_revision:watermark?.revision??0,previous_observed_at:watermark?.observed_at??null,observation_id:'commercial-observation-'+randomBytes(24).toString('hex')};
   const token=Object.freeze({});decisions.set(token,Object.freeze(value));return token;
  }finally{clearTimeout(timer);controller.abort();}
 };
 verifiers.add(verify);return verify;
}
export async function fulfillCommercialAccount(env,tenant,data){
 const c=commercialConfiguration(env);if(!c||c.policy.livemode!==true||c.enableFulfillment!==true||!verifiers.has(c.verifier))fail('commercial_live_fulfillment_disabled');if(!data||Object.getPrototypeOf(data)!==Object.prototype||Object.keys(data).length)fail('invalid_commercial_reconciliation_request',400);
 await authorizeCommercial(c,'commercial.reconcile',tenant);if(env.store.commercialPolicy?.hash!==c.hash)fail('commercial_store_policy_mismatch');await env.store.requireCommercialEnrollment(tenant);const binding=await env.store.getCommercialBinding(tenant),watermark=await env.store.getCommercialWatermark(tenant),decision=await c.verifier(binding,c,watermark);const receipt=await env.store.applyCommercialFulfillment(tenant,decision);return json(receipt);
}

export async function enrollCommercialAccount(env,tenant,data){const c=commercialConfiguration(env);if(!c||c.policy.livemode!==true||c.enableFulfillment!==true||!verifiers.has(c.verifier))fail('commercial_live_fulfillment_disabled');if(!data||Object.getPrototypeOf(data)!==Object.prototype||Object.keys(data).some(k=>k!=='policy_version')||data.policy_version!==c.policy.version)fail('commercial_enrollment_policy_required',400);await authorizeCommercial(c,'commercial.controls.enroll',tenant);if(env.store.commercialPolicy?.hash!==c.hash)fail('commercial_store_policy_mismatch');return json(await env.store.enrollCommercialControls(tenant));}
