// Dedicated server-side DynamoDB Streams adapter. No credentials or network defaults.
import {createHash} from 'node:crypto';
import {processStoredStripeBillingEvent} from './stripe-billing.mjs';
export function createStripeStreamWorker({enabled=false,streamArn,merchantId,environmentId,authorize,loadEnvironment,processEvent=processStoredStripeBillingEvent}={}) {
 if(enabled!==true)return async()=>{throw Error('stripe_worker_disabled');};
 if(typeof streamArn!=='string'||!/^arn:aws:dynamodb:[a-z0-9-]+:\d{12}:table\/[A-Za-z0-9_.-]+\/stream\/[0-9T:.\-]+$/.test(streamArn)||!/^acct_[A-Za-z0-9]{1,180}$/.test(merchantId||'')||typeof environmentId!=='string'||!/^[-A-Za-z0-9_]{1,80}$/.test(environmentId)||typeof authorize!=='function'||typeof loadEnvironment!=='function'||typeof processEvent!=='function')throw Error('invalid_stripe_worker_configuration');
 const pk='STRIPETEST#'+createHash('sha256').update(JSON.stringify([merchantId,environmentId])).digest('hex');
 return async function worker(event) {
  if(!Array.isArray(event?.Records)||event.Records.length!==1)throw Error('invalid_stripe_worker_batch');
  const record=event.Records[0],d=record?.dynamodb,sequence=d?.SequenceNumber;
  if(record.eventSource!=='aws:dynamodb'||record.eventSourceARN!==streamArn||record.eventName!=='INSERT'||typeof sequence!=='string'||!/^\d{1,129}$/.test(sequence)||d?.StreamViewType!=='KEYS_ONLY'||d.NewImage||d.OldImage)throw Error('invalid_stripe_worker_source');
  const keys=d.Keys;if(!keys||keys.pk?.S!==pk||Object.keys(keys).some(k=>!['pk','sk'].includes(k))||typeof keys.sk?.S!=='string'||! /^CAPTURE#evt_[A-Za-z0-9]{1,180}$/.test(keys.sk.S))throw Error('invalid_stripe_worker_scope');
  const eventId=keys.sk.S.slice(keys.sk.S.indexOf('#')+1);
  try {
   if(await authorize(Object.freeze({action:'worker.invoke',merchant_id:merchantId,environment_id:environmentId,stream_arn:streamArn,event_id:eventId,livemode:false}))!==true)throw Error('worker_authorization_required');
   const env=await loadEnvironment();
   if(env?.stripeBilling?.catalog?.merchant_id!==merchantId||env?.stripeBilling?.catalog?.environment_id!==environmentId||env.stripeBilling.purchasesEnabled!==false)throw Error('worker_environment_mismatch');
   await processEvent(env,eventId);
   return {batchItemFailures:[]};
  }catch{return {batchItemFailures:[{itemIdentifier:sequence}]};}
 };
}
