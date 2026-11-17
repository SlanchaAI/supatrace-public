// Synthetic local development fixture, never imported by AWS or public bundles.
import Stripe from 'stripe';
import {createHash,createHmac} from 'node:crypto';
import {composeStripeEntitlementSandbox} from '../src/stripe-entitlement-runtime.mjs';
import {commercialPolicyHash} from '../src/commercial-policy.mjs';
import {stripeTestCatalogHash} from '../src/stripe-test-checkout.mjs';
import {createStripeEntitlementWorkerHandler} from '../aws/stripe-entitlement-worker.mjs';
import {createUsageMeterWorker} from '../src/stripe-usage-meter.mjs';
import {buildStripeSandboxRuntime} from '../src/stripe-runtime.mjs';
import {handle} from '../src/aws-api.mjs';
import {PLANS} from '../src/plans.mjs';
import {PLAN_LIMITS} from '../src/plan-limits.mjs';
// planLimits:true is the Stripe TEST-mode upgrade rehearsal: the policy's plans are the Free/Base/Pro
// plans, each paid plan has a synthetic test price at its monthly base, the TEST portal can change or
// cancel the subscription, and a reconciled subscription moves the account's enforced plan limits. Nothing here
// is a live key, product or price. storage_limit_bytes is only the sandbox ledger's own number in that mode.
// Free plus the plans sold through Checkout (Base, Pro). Enterprise is assigned by an operator and has no price.
const testPlans=()=>PLANS.plans.filter(p=>p.id===PLAN_LIMITS.default_plan||p.checkout===true).map((p,i)=>({id:p.id,name:p.name,price_id:p.monthly_base_usd===0?null:'price_test'+p.id,unit_amount:Math.round(p.monthly_base_usd*100),currency:'usd',interval:'month',storage_limit_bytes:1024*(i+1)}));
export function configuration(purpose='api',{planLimits=false}={}){
 if(planLimits)return testModeConfiguration(purpose);
 const policy={version:'synthetic-v1',revision:1,merchant_id:'acct_synthetic',environment_id:'synthetic-billing',livemode:false,terms_url:'https://supatrace.dev/synthetic-only',accounting:'cumulative_reserved_bytes',non_active:'block_new_uploads',risk:'block_new_uploads',invoice_policy:'full_price_paid',lease_seconds:60,free_plan_id:'synthetic-free',plans:[{id:'synthetic-free',name:'Synthetic free',price_id:null,unit_amount:0,currency:'usd',interval:'month',storage_limit_bytes:1024},{id:'synthetic-paid',name:'Synthetic paid',price_id:'price_synthetic',unit_amount:200,currency:'usd',interval:'month',storage_limit_bytes:4096}]};
 const catalog={sandbox_kind:'isolated',merchant_id:policy.merchant_id,environment_id:policy.environment_id,livemode:false,api_version:'2026-10-28.endive',revision:commercialPolicyHash(policy),prices:{price_synthetic:{plan_id:'synthetic-pro',unit_amount:200,currency:'usd',interval:'month'}}};
 const prefix='arn:aws:secretsmanager:us-east-1:123456789012:secret:supatrace-stripe-sandbox-';
 return {enabled:true,purpose,tables:{metadata:'synthetic-metadata',inbox:'synthetic-inbox',state:'synthetic-state'},operationalCeiling:10485760,entitlementActions:['sandbox.entitlement.'+(purpose==='api'?'view':'reconcile')],entitlements:{enabled:true,policy,policyHash:commercialPolicyHash(policy),catalog,catalogHash:stripeTestCatalogHash(catalog)},runtime:{enabled:true,runtimePurpose:purpose,mode:'isolated_sandbox',purchasesEnabled:false,portalEnabled:false,bootstrapCustomers:false,catalog,catalogHash:stripeTestCatalogHash(catalog),integrationIdentifier:'supatrace-checkout-abcdefgh',runtimeKeyArn:prefix+(purpose==='api'?'api-runtime-test':'worker-runtime-test'),endpointSecretArns:purpose==='api'?[prefix+'endpoint-test']:[],authorizedActions:purpose==='api'?['runtime.credentials','webhook.record']:['runtime.credentials','capture.process','checkout.reconcile','subscription.reconcile','risk.resolve'],approvalRef:'synthetic-source-only'}};
}
function testModeConfiguration(purpose){
 const base=configuration(purpose),plans=testPlans(),policy={...base.entitlements.policy,version:'stripe-test-plans-v1',invoice_policy:'paid_invoice',free_plan_id:PLAN_LIMITS.default_plan,plans};
 const catalog={...base.runtime.catalog,revision:commercialPolicyHash(policy),prices:Object.fromEntries(plans.filter(p=>p.price_id).map(p=>[p.price_id,{plan_id:'synthetic-pro',unit_amount:p.unit_amount,currency:'usd',interval:'month'}]))};
 const pins={catalog,catalogHash:stripeTestCatalogHash(catalog)};
 return {...base,entitlements:{enabled:true,policy,policyHash:commercialPolicyHash(policy),...pins,planLimits:'test_mode'},runtime:{...base.runtime,...pins,...(purpose==='api'?{portalEnabled:true,portalConfigurationId:PORTAL_CONFIGURATION}:{})}};
}
const PORTAL_CONFIGURATION='bpc_localtestmode';
export async function configureLocalBilling(env,{planLimits=false}={}){
 const completed=new Set(),sessions=new Map(),subscriptions=new Map(),invoices=new Map(),calls=[],meterEvents=new Map();
 const secret='whsec_'+ 's'.repeat(24),merchant='acct_synthetic',customer='cus_localowner',version='2026-10-28.endive';
 function Client(key,options){return new Stripe(key,{...options,httpClient:Stripe.createFetchHttpClient(async(url,request)=>{
  const u=new URL(url);if(u.origin!=='https://api.stripe.com')throw Error('Local fixture forbids network');calls.push(u.pathname);
  let object;if(u.pathname==='/v1/account')object={object:'account',id:merchant};
  else if(u.pathname==='/v1/customers/'+customer)object={object:'customer',id:customer,livemode:false};
  else if(u.pathname==='/v1/checkout/sessions'&&request.method==='POST'){
   const body=new URLSearchParams(request.body),reference=body.get('client_reference_id'),suffix=createHash('sha256').update(reference??'').digest('hex').slice(0,24),id='cs_test_'+suffix;
   if(body.get('customer')!==customer||!Object.hasOwn(prices,body.get('line_items[0][price]')??'')||body.has('payment_method_types[0]')||body.has('automatic_tax[enabled]'))throw Error('Local fixture request mismatch');
   object=sessions.get(id)??{id,object:'checkout.session',livemode:false,mode:'subscription',status:'open',payment_status:'unpaid',customer,subscription:null,client_reference_id:reference,url:'https://checkout.stripe.com/c/pay/'+id};sessions.set(id,object);sessionPrices.set(id,body.get('line_items[0][price]'));
  }else if(u.pathname==='/v1/billing/meter_events'&&request.method==='POST'){
   // Synthetic Stripe test meter: one event per identifier, like the real endpoint's identifier uniqueness.
   const body=new URLSearchParams(request.body),identifier=body.get('identifier'),value=body.get('payload[value]');
   if(body.get('payload[stripe_customer_id]')!==customer||!/^[1-9][0-9]{0,15}$/.test(value??'')||!/^supatrace-usage-[a-f0-9]{48}$/.test(identifier??''))throw Error('Local fixture request mismatch');
   if(meterEvents.has(identifier))return new Response(JSON.stringify({error:{type:'invalid_request_error',message:'An event already exists with this identifier.'}}),{status:400,headers:{'content-type':'application/json','request-id':'req_localfixture'}});
   object={object:'billing.meter_event',identifier,event_name:body.get('event_name'),livemode:false,created:Number(body.get('timestamp')),timestamp:Number(body.get('timestamp')),payload:{stripe_customer_id:customer,value}};meterEvents.set(identifier,object);
  }else if(planLimits&&u.pathname==='/v1/billing_portal/configurations/'+PORTAL_CONFIGURATION)object={object:'billing_portal.configuration',id:PORTAL_CONFIGURATION,livemode:false,active:true,features:{invoice_history:{enabled:true},subscription_update:{enabled:true},subscription_cancel:{enabled:true},payment_method_update:{enabled:false},customer_update:{enabled:false}}};
  else if(planLimits&&u.pathname==='/v1/billing_portal/sessions'&&request.method==='POST'){
   const body=new URLSearchParams(request.body);if(body.get('customer')!==customer||body.get('configuration')!==PORTAL_CONFIGURATION)throw Error('Local fixture request mismatch');
   object={object:'billing_portal.session',id:'bps_localtestmode',customer,configuration:PORTAL_CONFIGURATION,livemode:false,on_behalf_of:null,return_url:body.get('return_url'),url:'https://billing.stripe.com/p/session/test_localtestmode'};
  }else if(u.pathname.startsWith('/v1/checkout/sessions/'))object=sessions.get(u.pathname.split('/').at(-1));
  else if(u.pathname.startsWith('/v1/subscriptions/'))object=subscriptions.get(u.pathname.split('/').at(-1));
  else if(u.pathname.startsWith('/v1/invoices/'))object=invoices.get(u.pathname.split('/').at(-1));
  if(!object)throw Error('Unconfigured synthetic Stripe request; real network forbidden');
  return new Response(JSON.stringify(object),{headers:{'content-type':'application/json','stripe-version':version,'request-id':'req_localfixture'}});
 })});}
 const baseOptions={client:env.store.client,commands:env.store.commands,now:env.store.now},hooks={storeOptions:baseOptions,awsAccountId:'123456789012',awsRegion:'us-east-1',StripeClient:Client,authorize:async()=>true,loadSecret:async arn=>arn.includes('endpoint-')?secret:'rk_test_'+ 'x'.repeat(24)};
 const apiConfig=configuration('api',{planLimits}),workerConfig=configuration('worker',{planLimits}),prices=apiConfig.runtime.catalog.prices,sessionPrices=new Map();apiConfig.tables.metadata=workerConfig.tables.metadata=env.store.table;apiConfig.operationalCeiling=workerConfig.operationalCeiling=env.store.limits.tenantBytes;
 apiConfig.runtime.authorizedActions.push('checkout.create',...(planLimits?['portal.create']:[]));
 const previousRate=env.store.consumeRate.bind(env.store);const api=await composeStripeEntitlementSandbox(apiConfig,hooks),workerEnv=await composeStripeEntitlementSandbox(workerConfig,hooks);Object.assign(env,api);env.store.consumeRate=previousRate;
 env.commercial={enabled:true,policy:apiConfig.entitlements.policy,policyHash:apiConfig.entitlements.policyHash,enableFulfillment:false,authorize:async action=>['commercial.view','commercial.checkout'].includes(action.action)};
 await env.store.getOrCreateTenant(4242);await env.store.bindStripeTestCustomer('github-4242',{merchant_id:merchant,customer_id:customer});
 const stripeEnvironment=apiConfig.entitlements.policy.environment_id,streamArn='arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-inbox/stream/2026-11-06T00:00:00.000',scope='STRIPETEST#'+createHash('sha256').update(JSON.stringify([merchant,stripeEnvironment])).digest('hex');
 const worker=createStripeEntitlementWorkerHandler({enabled:true,streamArn,merchantId:merchant,environmentId:stripeEnvironment,approvalRef:workerConfig.runtime.approvalRef,authorizedActions:['worker.invoke'],composition:workerConfig},{...hooks,protectedTableNames:['supatrace-alpha-metadata']});
 const replayCaptured=id=>worker({Records:[{eventName:'INSERT',eventSource:'aws:dynamodb',eventSourceARN:streamArn,dynamodb:{StreamViewType:'KEYS_ONLY',SequenceNumber:'1',Keys:{pk:{S:scope},sk:{S:'CAPTURE#'+id}}}}]});
 // Reconciliation watermarks are whole seconds and must strictly advance. The worker stamps its watermark while it
 // reconciles, which can be a second later than the moment the step was emitted, so a step waits for a second after
 // the one in which the previous step finished reconciling (not the one in which it started).
 let lastReconciled=0;
 async function emit(id,type,object){if(planLimits)while(Math.floor(Date.now()/1000)<=lastReconciled)await new Promise(resolve=>setTimeout(resolve,50));
  try{await deliver(id,type,object);}finally{if(planLimits)lastReconciled=Math.floor(Date.now()/1000);}
 }
 async function deliver(id,type,object){
  const time=Math.floor(Date.now()/1000),raw=JSON.stringify({id,object:'event',type,api_version:version,created:time,livemode:false,data:{object}}),signature=createHmac('sha256',secret).update(time+'.'+raw).digest('hex');
  const captured=await handle(new Request('https://supatrace.dev/api/billing/webhook',{method:'POST',headers:{'content-type':'application/json','stripe-signature':'t='+time+',v1='+signature},body:raw}),env);if(captured.status!==202)throw Error('Synthetic capture failed: '+await captured.text());
  const result=await replayCaptured(id);if(result.batchItemFailures.length)throw Error('Synthetic stream reconciliation failed');
 }
 // Usage meter worker, driven the way a KEYS_ONLY stream on the metadata table would drive it. It gets its own
 // worker runtime whose only Stripe permission is usage.report.
 const meterStream='arn:aws:dynamodb:us-east-1:123456789012:table/'+env.store.table+'/stream/2026-11-14T00:00:00.000',meterEvent='supatrace_spans';
 const meterRuntime=await buildStripeSandboxRuntime({...workerConfig.runtime,authorizedActions:['runtime.credentials','usage.report']},{...hooks,expectedPurpose:'worker'});
 const meterWorker=createUsageMeterWorker({enabled:true,streamArn:meterStream,merchantId:merchant,environmentId:stripeEnvironment,eventName:meterEvent,authorize:async action=>action.action==='worker.invoke',loadEnvironment:async()=>({stripeBilling:meterRuntime,store:workerEnv.store})});
 let meterSequence=0,current=null,portalSteps=0;
 const priceObject=id=>({id,object:'price',active:true,livemode:false,type:'recurring',currency:'usd',unit_amount:prices[id].unit_amount,recurring:{interval:'month',interval_count:1}});
 async function reportUsage(tenantId,period){const result=await meterWorker({Records:[{eventName:'MODIFY',eventSource:'aws:dynamodb',eventSourceARN:meterStream,dynamodb:{StreamViewType:'KEYS_ONLY',SequenceNumber:String(++meterSequence),Keys:{pk:{S:'TENANT#'+tenantId},sk:{S:'USAGE#'+period}}}}]});if(result.batchItemFailures.length)throw Error('Synthetic usage meter report failed');return {meter_total:[...meterEvents.values()].reduce((sum,e)=>sum+Number(e.payload.value),0),events:meterEvents.size};}
 return {calls,emit,replayCaptured,reportUsage,meterEvents,meterWorker,workerEnvironment:workerEnv,session:id=>sessions.has(id),async complete(id,actor){
  if(actor!=='github-4242'||!sessions.has(id))throw Error('Synthetic Checkout unavailable to this account');
  if(completed.has(id))return {synthetic:true,paid_access:false,quota_changed:false,replayed:true};
  if(planLimits&&current)throw Error('Synthetic account already has a subscription; change it in the portal');
  const session=sessions.get(id),suffix=id.slice(8),now=Math.floor(Date.now()/1000),sub='sub_'+suffix,invoice='in_'+suffix;
  session.status='complete';session.payment_status='paid';session.subscription=sub;
  const price=sessionPrices.get(id),amount=prices[price].unit_amount;
  subscriptions.set(sub,{id:sub,object:'subscription',customer,livemode:false,status:'active',latest_invoice:invoice,items:{has_more:false,data:[{subscription:sub,quantity:1,current_period_start:now-1,current_period_end:now+3600,price:priceObject(price)}]}});
  invoices.set(invoice,{id:invoice,object:'invoice',customer,livemode:false,status:'paid',currency:'usd',amount_due:amount,amount_paid:amount,amount_remaining:0,parent:{type:'subscription_details',subscription_details:{subscription:sub}}});
  await emit('evt_checkout'+suffix,'checkout.session.completed',session);completed.add(id);if(planLimits)current=sub;
  return {synthetic:true,paid_access:false,quota_changed:planLimits};
 },
 // What the TEST portal does to the one synthetic subscription: switch its price, or cancel it. Each emits the
 // signed subscription event Stripe would send; the worker then reads the subscription back and reconciles.
 planLimits,plans:()=>apiConfig.entitlements.policy.plans.filter(p=>p.price_id!==null).map(p=>({id:p.id,name:p.name})),subscribed:()=>current!==null&&subscriptions.get(current).status==='active',
 async changePlan(actor,planId){
  const plan=apiConfig.entitlements.policy.plans.find(p=>p.id===planId&&p.price_id!==null),sub=subscriptions.get(current);
  if(!planLimits||actor!=='github-4242'||!plan||sub?.status!=='active')throw Error('Synthetic portal change unavailable to this account');
  const now=Math.floor(Date.now()/1000),step=++portalSteps,invoice='in_'+current.slice(4)+'p'+step;
  // A plan switch bills a proration, not the full price; the paid_invoice policy accepts any fully paid invoice.
  invoices.set(invoice,{id:invoice,object:'invoice',customer,livemode:false,status:'paid',currency:'usd',amount_due:100,amount_paid:100,amount_remaining:0,parent:{type:'subscription_details',subscription_details:{subscription:current}}});
  sub.latest_invoice=invoice;sub.items.data[0]={...sub.items.data[0],current_period_start:now-1,current_period_end:now+3600,price:priceObject(plan.price_id)};
  await emit('evt_portal'+current.slice(4)+'p'+step,'customer.subscription.updated',sub);return {synthetic:true,plan_id:plan.id};
 },
 async cancel(actor){
  const sub=subscriptions.get(current);if(!planLimits||actor!=='github-4242'||sub?.status!=='active')throw Error('Synthetic portal cancel unavailable to this account');
  sub.status='canceled';await emit('evt_portal'+current.slice(4)+'p'+(++portalSteps),'customer.subscription.deleted',sub);return {synthetic:true,plan_id:PLAN_LIMITS.default_plan};
 }};
}
