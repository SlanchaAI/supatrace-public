// Usage metering to Stripe Billing Meters, TEST mode only. Default off: nothing here runs
// unless a caller supplies an isolated sandbox runtime built from a restricted test key
// (src/stripe-runtime.mjs refuses every other key shape, including sk_live and rk_live).
// A "span" is one trace event. The reported count is accepted spans: the accept transaction
// adds a batch's events to the monthly usage row exactly once, so a replayed batch is never
// counted twice and a reservation whose upload never finished is never reported.
// https://docs.stripe.com/api/billing/meter-event/create
const fail=code=>{throw Object.assign(new Error(code),{code});};
// Half of Stripe's documented minimum identifier-uniqueness window (24 hours).
export const RESEND_WINDOW_SECONDS=12*3600;
const EVENT_NAME=/^[a-z][a-z0-9_]{2,99}$/,PERIOD=/^[0-9]{4}-(0[1-9]|1[0-2])$/,TENANT=/^(?:github-[1-9][0-9]{0,15}|(?:google|email|chatgpt|sso)-[a-f0-9]{64}|org-[a-f0-9]{32})$/;
function runtime(env){
 const c=env?.stripeBilling;
 if(c?.enabled!==true||c.mode!=='isolated_sandbox'||c.purchasesEnabled!==false||c.catalog?.livemode!==false||!/^acct_[A-Za-z0-9]{1,180}$/.test(c.catalog?.merchant_id||'')||typeof c.authorize!=='function'||typeof c.client?.billing?.meterEvents?.create!=='function'||typeof env.store?.beginUsageMeterReport!=='function')fail('usage_meter_disabled');
 return c;
}
/**
 * Report the unreported spans of one account for one UTC calendar month as a single meter event.
 * Two-phase: the intent (identifier, value) is stored before Stripe is called and cleared after,
 * so a crash in between resends the same identifier instead of minting a second event.
 */
export async function reportUsagePeriod(env,tenantId,periodId,{eventName}={}){
 const c=runtime(env);
 if(!EVENT_NAME.test(eventName||'')||!TENANT.test(tenantId||'')||!PERIOD.test(periodId||''))fail('usage_meter_request_invalid');
 const merchant=c.catalog.merchant_id;
 if(await c.authorize(Object.freeze({action:'usage.report',tenant_id:tenantId,merchant_id:merchant,environment_id:c.catalog.environment_id,livemode:false}))!==true)fail('usage_meter_authorization_required');
 let binding;try{binding=await env.store.getStripeTestBinding(tenantId,merchant);}catch(error){if(error?.code==='billing_customer_unbound')return {status:'no_customer'};throw error;}
 if(binding.livemode!==false)fail('usage_meter_binding_invalid');
 const intent=await env.store.beginUsageMeterReport(tenantId,periodId,{merchant_id:merchant,customer_id:binding.customer_id});
 if(!intent)return {status:'up_to_date'};
 // Stripe keeps an identifier unique for a rolling window of at least 24 hours. A stored intent older than
 // RESEND_WINDOW_SECONDS may already be counted and no longer deduplicated, so it is held, never resent.
 if(intent.resumed&&!(Number.isSafeInteger(intent.created_at)&&env.store.now()-intent.created_at<RESEND_WINDOW_SECONDS&&env.store.now()>=intent.created_at)){await env.store.finishUsageMeterReport(tenantId,periodId,intent,{hold:true});return {status:'held'};}
 let event;
 try{event=await c.client.billing.meterEvents.create({event_name:eventName,payload:{stripe_customer_id:intent.customer_id,value:String(intent.value)},identifier:intent.identifier,timestamp:intent.timestamp},{apiVersion:c.catalog.api_version,maxNetworkRetries:0,timeout:10000});}
 catch(error){
  // A resent identifier that Stripe refuses may already be recorded there. Never guess: hold the
  // period for reconciliation instead of sending a new identifier that could bill the spans twice.
  if(intent.resumed&&Number.isInteger(error?.statusCode)&&error.statusCode>=400&&error.statusCode<500&&error.statusCode!==429){await env.store.finishUsageMeterReport(tenantId,periodId,intent,{hold:true});return {status:'held'};}
  fail('usage_meter_unavailable');
 }
 if(event?.object!=='billing.meter_event'||event.livemode!==false||event.identifier!==intent.identifier||event.event_name!==eventName){await env.store.finishUsageMeterReport(tenantId,periodId,intent,{hold:true});fail('usage_meter_response_mismatch');}
 await env.store.finishUsageMeterReport(tenantId,periodId,intent);
 return {status:'reported',period:periodId,value:intent.value,identifier:intent.identifier};
}
/**
 * DynamoDB Streams adapter in the same shape as src/stripe-worker.mjs: one KEYS_ONLY record per
 * invocation, partial-batch failure response. It listens to the metadata table and acts only on
 * monthly usage rows (TENANT#<id> / USAGE#YYYY-MM); every other key is acknowledged and ignored.
 */
export function createUsageMeterWorker({enabled=false,streamArn,merchantId,environmentId,eventName,authorize,loadEnvironment,report=reportUsagePeriod}={}){
 if(enabled!==true)return async()=>{throw Error('usage_meter_worker_disabled');};
 if(typeof streamArn!=='string'||!/^arn:aws:dynamodb:[a-z0-9-]+:\d{12}:table\/[A-Za-z0-9_.-]+\/stream\/[0-9T:.\-]+$/.test(streamArn)||!/^acct_[A-Za-z0-9]{1,180}$/.test(merchantId||'')||typeof environmentId!=='string'||!/^[-A-Za-z0-9_]{1,80}$/.test(environmentId)||!EVENT_NAME.test(eventName||'')||typeof authorize!=='function'||typeof loadEnvironment!=='function'||typeof report!=='function')throw Error('invalid_usage_meter_worker_configuration');
 return async function worker(event){
  if(!Array.isArray(event?.Records)||event.Records.length!==1)throw Error('invalid_usage_meter_worker_batch');
  const record=event.Records[0],d=record?.dynamodb,sequence=d?.SequenceNumber;
  if(record.eventSource!=='aws:dynamodb'||record.eventSourceARN!==streamArn||!['INSERT','MODIFY','REMOVE'].includes(record.eventName)||typeof sequence!=='string'||!/^\d{1,129}$/.test(sequence)||d?.StreamViewType!=='KEYS_ONLY'||d.NewImage||d.OldImage)throw Error('invalid_usage_meter_worker_source');
  const pk=d.Keys?.pk?.S,sk=d.Keys?.sk?.S;
  if(record.eventName==='REMOVE'||typeof pk!=='string'||typeof sk!=='string'||!pk.startsWith('TENANT#')||!TENANT.test(pk.slice(7))||!sk.startsWith('USAGE#')||!PERIOD.test(sk.slice(6)))return {batchItemFailures:[]};
  const tenantId=pk.slice(7),periodId=sk.slice(6);
  try{
   if(await authorize(Object.freeze({action:'worker.invoke',merchant_id:merchantId,environment_id:environmentId,stream_arn:streamArn,tenant_id:tenantId,period:periodId,livemode:false}))!==true)throw Error('worker_authorization_required');
   const env=await loadEnvironment();
   if(env?.stripeBilling?.catalog?.merchant_id!==merchantId||env.stripeBilling.catalog.environment_id!==environmentId||env.stripeBilling.purchasesEnabled!==false)throw Error('worker_environment_mismatch');
   await report(env,tenantId,periodId,{eventName});
   return {batchItemFailures:[]};
  }catch{return {batchItemFailures:[{itemIdentifier:sequence}]};}
 };
}
