// Deny-only live risk capture. No endpoint, secret loader, clear operation or activation.
// https://docs.stripe.com/billing/subscriptions/webhooks#refund-events
// https://docs.stripe.com/webhooks#verify-events
import Stripe from 'stripe';import {createHash} from 'node:crypto';import {HttpError} from './http.mjs';import {STRIPE_REVIEWED_API_VERSION} from './stripe-test-policy.mjs';
const verified=new WeakMap(),types=new Map([['charge.refunded',['charge','ch']],['charge.dispute.created',['dispute','du']],['radar.early_fraud_warning.created',['radar.early_fraud_warning','issfr']]]);
const fail=()=>{throw new HttpError(400,'commercial_risk_signature_or_scope_invalid');};
export function verifyCommercialRiskSnapshot(raw,signature,{enabled=false,endpointSecret,merchantId,environmentId,now=Math.floor(Date.now()/1000)}={}){
 if(enabled!==true||!Buffer.isBuffer(raw)||raw.length<1||raw.length>262144||typeof signature!=='string'||signature.length>8192||/[\r\n]/.test(signature)||typeof endpointSecret!=='string'||!/^whsec_[A-Za-z0-9]{16,240}$/.test(endpointSecret)||!/^acct_[A-Za-z0-9]{1,180}$/.test(merchantId||'')||!/^[-A-Za-z0-9_]{1,100}$/.test(environmentId||'')||!Number.isSafeInteger(now))fail();
 let e;try{e=Stripe.webhooks.constructEvent(raw,signature,endpointSecret,300,undefined,now*1000);}catch{fail();}
 const spec=types.get(e.type),o=e.data?.object;
 if(e.object!=='event'||!/^evt_[A-Za-z0-9]{1,180}$/.test(e.id||'')||e.livemode!==true||e.account!=null||e.context!=null||e.api_version!==STRIPE_REVIEWED_API_VERSION||!Number.isSafeInteger(e.created)||e.created<0||e.created>now+300||!spec||o?.object!==spec[0]||!new RegExp('^'+spec[1]+'_[A-Za-z0-9]{1,180}$').test(o?.id||'')||o.livemode!==true)fail();
 const value=Object.freeze({event_id:e.id,event_type:e.type,object_id:o.id,merchant_id:merchantId,environment_id:environmentId,livemode:true,api_version:STRIPE_REVIEWED_API_VERSION,created:e.created,payload_hash:createHash('sha256').update(raw).digest('hex'),status:'unresolved_hold'}),token=Object.freeze({});verified.set(token,value);return token;
}
export function commercialRiskIntent(token){const value=verified.get(token);if(!value)fail();return {...value};}
