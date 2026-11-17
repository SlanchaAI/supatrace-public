import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DynamoMetadataStore} from '../src/dynamodb-store.mjs';
import {MemoryDynamo,commandClasses} from './memory-dynamo.mjs';
import {prepareOverage,reportOverage,settleOverage,acceptedOverage,OVERAGE_QUEUE,OVERAGE_LOOKUP,OVERAGE_EVENT} from '../src/plan-overage.mjs';
import {planLimits} from '../src/plan-limits.mjs';
import {handle} from '../src/aws-api.mjs';
import {createFixtureSession} from './fixture-session.mjs';

const owner='github-7',cap=planLimits('pro').spans_per_month,ORIGIN='https://supatrace.dev';
const hash=x=>createHash('sha256').update(x).digest('hex');
async function fixture(mode='test'){
 const livemode=mode==='live';
 let now=Date.UTC(2026,10,15,20)/1000;
 const client=new MemoryDynamo(),store=new DynamoMetadataStore({client,commands:commandClasses(),tableName:'synthetic',now:()=>now});
 store.planBillingMode=mode;
 await store.getOrCreateTenant(7);
 const meta=client.items.get('TENANT#'+owner+'\0META');Object.assign(meta,{plan_id:'pro',plan_source:'stripe_'+mode,...(mode==='live'?{stripe_mode:mode}:{}),stripe_customer_id:'cus_synthetic',stripe_subscription_id:'sub_synthetic',plan_period_end:now+86400});
 const fixed={id:'price_pro',livemode,lookup_key:'supatrace_pro_monthly',currency:'usd',unit_amount:2599,recurring:{interval:'month',interval_count:1,usage_type:'licensed'}};
 const price={id:'price_overage',livemode,lookup_key:OVERAGE_LOOKUP,currency:'usd',billing_scheme:'per_unit',unit_amount_decimal:'0.0005',recurring:{interval:'month',interval_count:1,usage_type:'metered',meter:'mtr_test_synthetic'}};
 const meter={id:'mtr_test_synthetic',livemode,status:'active',event_name:OVERAGE_EVENT,event_time_window:null,default_aggregation:{formula:'sum'},customer_mapping:{type:'by_id',event_payload_key:'stripe_customer_id'},value_settings:{event_payload_key:'value'}};
 const subscription={id:meta.stripe_subscription_id,livemode,customer:meta.stripe_customer_id,metadata:{supatrace_org:owner},status:'active',items:{data:[{id:'si_fixed',price:fixed}]}};
 const events=[],updates=[],dedup=new Set();let summaries=null;
 const stripe={prices:{list:async()=>({data:[price,fixed]}),retrieve:async()=>price},subscriptions:{retrieve:async()=>subscription,update:async(id,data,opts)=>{updates.push({id,data,opts});subscription.items.data.push({id:'si_meter',price});return subscription;}},billing:{meters:{retrieve:async()=>meter,listEventSummaries:async()=>({data:[{livemode,aggregated_value:summaries??events.reduce((n,e)=>n+Number(e.payload.value),0)}],has_more:false})},meterEvents:{create:async(data,opts)=>{events.push({...data,opts});dedup.add(data.identifier);return {livemode,identifier:data.identifier};}}}};
 const env={ENABLED:true,APP_ORIGIN:ORIGIN,GITHUB_CLIENT_ID:'synthetic',GITHUB_CLIENT_SECRET:'synthetic',store,objects:{},planBilling:{mode,stripe}};
 const usageKey='USAGE#'+(mode==='live'?'live#':'')+'2026-11';
 const used=(accepted=cap-2)=>client.items.set('TENANT#'+owner+'\0'+usageKey,{pk:'TENANT#'+owner,sk:usageKey,spans:accepted,accepted_spans:accepted});used();
 const reserve=async(id,n=1)=>store.reserveBatch(owner,{batch_id:id,run_id:'run',request_hash:hash(id),byte_count:10,event_count:n});
 const accept=id=>store.acceptReservedBatch(owner,id,hash(id));
 const upload=async(id,n)=>{await reserve(id,n);await accept(id);};
 const bind=async()=>store.setSpendCap(owner,false,await prepareOverage(env,store,owner));
 const ledgers=()=>[...client.items.values()].filter(r=>r.pk==='TENANT#'+owner&&r.sk.startsWith('PLAN_OVERAGE#'));
 const jobs=()=>[...client.items.values()].filter(r=>r.pk===OVERAGE_QUEUE);
 return {store,client,get meta(){return client.items.get('TENANT#'+owner+'\0META');},price,fixed,meter,subscription,stripe,env,events,updates,dedup,used,reserve,accept,upload,bind,ledgers,jobs,at:n=>now=n,now:()=>now,summaries:n=>summaries=n};
}

test('cap-off binds the approved TEST meter before changing state; retries attach only once',async()=>{
 const f=await fixture();await f.bind();await f.bind();assert.equal(f.meta.spend_cap,false);assert.equal(f.meta.overage_price_id,f.price.id);assert.equal(f.updates.length,1);assert.equal(f.updates[0].data.proration_behavior,'none');
 const pending=await f.reserve('pending',5);assert.equal(pending.status,'pending');assert.equal(f.ledgers().length,0);
 await f.accept('pending');assert.equal(f.ledgers()[0].billable_spans,3);assert.equal(f.jobs().length,1);
 await f.accept('pending');assert.equal(f.ledgers()[0].billable_spans,3);
 await reportOverage(f.env);assert.equal(f.events[0].payload.value,'3');assert.equal(f.events[0].event_name,OVERAGE_EVENT);assert.equal(f.events[0].payload.stripe_customer_id,f.meta.stripe_customer_id);assert.equal(f.ledgers()[0].reported_spans,3);assert.equal(f.jobs().length,0);
 await reportOverage(f.env);assert.equal(f.events.length,1);
});

test('accepted uploads across environments share one allowance and an aggregate, not one Stripe request per batch',async()=>{
 const f=await fixture();await f.bind();f.used(cap);await f.upload('a',10);await f.upload('b',20);
 assert.equal(f.ledgers()[0].billable_spans,30);assert.equal(f.jobs().length,1);await reportOverage(f.env);assert.equal(f.events[0].payload.value,'30');
 await f.upload('c',4);await reportOverage(f.env);assert.deepEqual(f.events.map(e=>e.payload.value),['30','4']);
});

test('cap-on never queues usage; stale or foreign Stripe binding refuses new uploads',async()=>{
 const f=await fixture();await f.upload('included',1);assert.equal(f.ledgers().length,0);await f.bind();f.meta.overage_customer_id='cus_foreign';await assert.rejects(f.reserve('foreign'),e=>e.code==='overage_binding_required');
 f.meta.overage_customer_id=f.meta.stripe_customer_id;f.at(f.meta.plan_period_end);await assert.rejects(f.reserve('expired'),e=>e.code==='overage_billing_period_refresh_required');
});

test('plan or cap change racing acceptance retries using the new plan and cannot queue an unapproved charge',async()=>{
 const f=await fixture();await f.bind();f.used(cap);await f.reserve('race',4);const tx=f.store._tx.bind(f.store);let changed=false;
 f.store._tx=async items=>{if(!changed&&items.some(i=>i.Update?.Key.sk==='BATCH#race')){changed=true;f.meta.spend_cap=true;}return tx(items);};
 await f.accept('race');assert.equal(f.ledgers().length,0);assert.equal(f.jobs().length,0);
});

test('Stripe response loss reuses the persisted identifier; old ambiguous intents hold without duplicate charge',async()=>{
 const f=await fixture();await f.bind();f.used(cap);await f.upload('retry',7);const create=f.stripe.billing.meterEvents.create;let lost=true;
 f.stripe.billing.meterEvents.create=async(...args)=>{const r=await create(...args);if(lost){lost=false;throw Error('response lost');}return r;};
 await assert.rejects(reportOverage(f.env));const id=f.ledgers()[0].pending.identifier;assert.equal(f.ledgers()[0].reported_spans,undefined);f.at(f.now()+601);await reportOverage(f.env);assert.equal(f.events[1].identifier,id);assert.equal(f.dedup.size,1);assert.equal(f.jobs().length,0);
 await f.upload('held',1);f.stripe.billing.meterEvents.create=async()=>{throw Error('outage');};await assert.rejects(reportOverage(f.env));f.at(f.now()+43200);await assert.rejects(reportOverage(f.env));assert.equal(f.ledgers()[0].held,true);assert.equal(f.events.length,2);
});

test('accepting while an old intent is in flight keeps the new delta queued',async()=>{
 const f=await fixture();await f.bind();f.used(cap);await f.upload('before',2);const create=f.stripe.billing.meterEvents.create;let once=true;
 f.stripe.billing.meterEvents.create=async(...args)=>{if(once){once=false;await f.upload('during',3);}return create(...args);};
 await reportOverage(f.env);assert.equal(f.jobs().length,1);await reportOverage(f.env);assert.deepEqual(f.events.map(e=>e.payload.value),['2','3']);assert.equal(f.jobs().length,0);
});

test('a queued pending intent plus a newer upload cannot be deleted after acknowledging only the old total',async()=>{
 const f=await fixture();await f.bind();f.used(cap);await f.upload('old',2);const create=f.stripe.billing.meterEvents.create;f.stripe.billing.meterEvents.create=async()=>{throw Error('outage');};await assert.rejects(reportOverage(f.env));await f.upload('new',3);f.stripe.billing.meterEvents.create=create;
 await reportOverage(f.env);assert.equal(f.jobs().length,1);await reportOverage(f.env);assert.deepEqual(f.events.map(e=>e.payload.value),['2','3']);
});

test('LIVE, wrong price, wrong meter, foreign customer and unpaid subscriptions never uncap',async()=>{
 for(const mutate of [f=>f.price.livemode=true,f=>f.price.unit_amount_decimal='0.001',f=>f.meter.default_aggregation.formula='count',f=>f.subscription.customer='cus_foreign',f=>f.subscription.status='unpaid',f=>f.subscription.pending_update={},f=>f.subscription.cancel_at_period_end=true]){
  const f=await fixture();mutate(f);await assert.rejects(f.bind());assert.notEqual(f.meta.spend_cap,false);assert.equal(f.updates.length,0);
 }
});

test('account erasure waits for aggregation and never discards a queued or held charge',async()=>{
 const f=await fixture();await f.bind();f.used(cap);await f.upload('settle',10);f.summaries(0);await assert.rejects(settleOverage(f.env,owner,f.price.id,Date.now()+9000),/settlement_pending/);f.summaries(10);assert.equal(await settleOverage(f.env,owner,f.price.id,Date.now()+9000),true);
});

test('scheduled reporter refuses a foreign or canceled subscription instead of marking it billed',async()=>{
 const f=await fixture();await f.bind();f.used(cap);await f.upload('cancel',5);f.subscription.status='canceled';await assert.rejects(reportOverage(f.env));assert.equal(f.events.length,0);assert.equal(f.ledgers()[0].reported_spans,undefined);
});

test('actual authenticated API uncap requires paid TEST binding; cap-on remains available during Stripe outage',async()=>{
 const f=await fixture();const session=await createFixtureSession(f.store,owner);f.store.consumeRate=async()=>({allowed:true});
 const post=enabled=>handle(new Request(ORIGIN+'/api/billing/spend-cap',{method:'POST',headers:{origin:ORIGIN,cookie:'__Host-supatrace='+session,'content-type':'application/json'},body:JSON.stringify({enabled})}),f.env);
 assert.equal((await post(false)).status,200);assert.equal(f.meta.spend_cap,false);f.env.planBilling=null;assert.equal((await post(true)).status,200);assert.equal(f.meta.spend_cap,true);assert.equal((await post(false)).status,503);assert.equal(f.meta.spend_cap,true);
});

test('live cap-off binds, accepts, reports and settles only live overage',async()=>{
 const f=await fixture('live');await f.bind();await f.upload('live',5);
 assert.equal(f.ledgers()[0].stripe_mode,'live');assert.match(f.ledgers()[0].sk,/^PLAN_OVERAGE#live#/);
 await reportOverage(f.env);assert.equal(f.events[0].payload.value,'3');
 assert.equal(await settleOverage(f.env,owner,f.price.id,Date.now()+5000),true);
});
for(const mode of ['test','live'])for(const kind of ['price','fixed','meter','subscription'])test(`${mode} overage refuses opposite-mode ${kind}`,async()=>{
 const f=await fixture(mode);f[kind].livemode=mode!=='live';await assert.rejects(f.bind(),e=>e.code==='overage_live_mode_refused');assert.equal(f.meta.spend_cap,undefined);
});
test('switching modes leaves old overage queued and cannot report or block settlement in the new mode',async()=>{
 const f=await fixture();await f.bind();await f.upload('test',5);const before=structuredClone(f.ledgers());
 f.env.planBilling.mode='live';f.store.planBillingMode='live';
 await reportOverage(f.env);assert.equal(f.events.length,0);assert.deepEqual(f.ledgers(),before);assert.equal(f.jobs().length,1);
 assert.equal(await settleOverage(f.env,owner,f.price.id,Date.now()+5000),false);
 await assert.rejects(f.bind(),e=>e.code==='overage_paid_pro_required');
});

test('an unset runtime mode cannot produce a test ledger from a live binding',async()=>{
 const f=await fixture('live');await f.bind();f.store.planBillingMode=undefined;
 assert.deepEqual(await acceptedOverage(f.store,owner,f.meta,{event_count:5},f.now()),[]);
});

for(const mode of ['test','live'])test(`${mode} allowance and overage never count the other mode's uploads`,async()=>{
 const f=await fixture(mode),other=mode==='live'?'test':'live',prefix=m=>'USAGE#'+(m==='live'?'live#':'')+'2026-11';
 f.client.items.delete('TENANT#'+owner+'\0'+prefix(mode));
 f.client.items.set('TENANT#'+owner+'\0'+prefix(other),{pk:'TENANT#'+owner,sk:prefix(other),spans:cap+100,accepted_spans:cap+100});
 assert.equal((await f.store.getPlanUsage(owner)).spans_used,0);await f.bind();await f.upload('new-mode',1);
 assert.equal(f.ledgers().length,0);assert.equal((await f.store.getPlanUsage(owner)).accepted_spans,1);
 assert.equal((await f.store.getUsageMeters(owner)).current.accepted_spans,1);
 assert.equal(f.client.items.get('TENANT#'+owner+'\0'+prefix(other)).accepted_spans,cap+100);
});
test('a pending test reservation accepted after the flip stays in test usage and cannot bill live',async()=>{
 const f=await fixture('live');await f.bind();f.used(cap);
 await f.reserve('pending-test',1);f.client.items.get('TENANT#'+owner+'\0BATCH#pending-test').usage_mode='test';
 await f.accept('pending-test');assert.equal(f.ledgers().length,0);assert.equal((await f.store.getPlanUsage(owner)).accepted_spans,cap);
 assert.equal(f.client.items.get('TENANT#'+owner+'\0USAGE#2026-11').accepted_spans,1);
});

for(const mode of ['test','live'])test(`${mode} usage notices ignore the other mode`,async()=>{
 const f=await fixture(mode),alert={level:80,period:'2026-11',plan:'pro',limit:cap,used:cap*0.8,spend_cap:true};
 await f.store.recordUsageAlert(owner,alert,{email_status:'pending'});
 f.store.planBillingMode=mode==='live'?'test':'live';assert.deepEqual(await f.store.listUsageAlerts(owner,alert.period),[]);
 assert.equal((await f.store.recordUsageAlert(owner,alert,{email_status:'pending'})).created,true);
 await f.store.setUsageAlertEmail(owner,alert.period,80,'sent');
 f.store.planBillingMode=mode;assert.equal((await f.store.listUsageAlerts(owner,alert.period))[0].email_status,'pending');
});
