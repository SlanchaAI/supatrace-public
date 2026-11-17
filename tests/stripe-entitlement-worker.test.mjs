import test from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import {createHash} from 'node:crypto';
import {createStripeEntitlementWorkerHandler,handler} from '../aws/stripe-entitlement-worker.mjs';
import {configuration} from '../scripts/local-billing.mjs';
import {MemoryDynamo,commandClasses} from './memory-dynamo.mjs';
function fixture(){
 const composition=configuration('worker'),streamArn='arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-inbox/stream/2026-11-06T00:00:00.000',merchantId='acct_synthetic',environmentId='synthetic-billing';
 const config={enabled:true,streamArn,merchantId,environmentId,approvalRef:composition.runtime.approvalRef,authorizedActions:['worker.invoke'],composition},secrets=[],actions=[],requests=[];
 function Client(key,options){return new Stripe(key,{...options,httpClient:Stripe.createFetchHttpClient(async url=>{requests.push(url);assert.equal(url,'https://api.stripe.com/v1/account');return new Response(JSON.stringify({object:'account',id:merchantId}),{headers:{'content-type':'application/json'}});})});}
 const hooks={awsAccountId:'123456789012',awsRegion:'us-east-1',protectedTableNames:['supatrace-alpha-metadata'],storeOptions:{client:new MemoryDynamo(),commands:commandClasses()},StripeClient:Client,loadSecret:async arn=>{secrets.push(arn);return 'rk_test_'+'x'.repeat(24);},authorize:async d=>{actions.push(d);return true;}};
 const pk='STRIPETEST#'+createHash('sha256').update(JSON.stringify([merchantId,environmentId])).digest('hex'),event={Records:[{eventName:'INSERT',eventSource:'aws:dynamodb',eventSourceARN:streamArn,dynamodb:{StreamViewType:'KEYS_ONLY',SequenceNumber:'123',Keys:{pk:{S:pk},sk:{S:'CAPTURE#evt_one'}}}}]};
 return {config,hooks,event,secrets,actions,requests};
}
test('separate AWS entitlement entry is default off without any environment or network dependency',async()=>{
 const old=process.env.BILLING_ENTITLEMENT_WORKER_CONFIG;delete process.env.BILLING_ENTITLEMENT_WORKER_CONFIG;
 try{await assert.rejects(handler({}),/worker_disabled/);const f=fixture();await assert.rejects(createStripeEntitlementWorkerHandler({},f.hooks)(f.event),/disabled/);assert.equal(f.secrets.length,0);}finally{if(old!==undefined)process.env.BILLING_ENTITLEMENT_WORKER_CONFIG=old;}
});
test('namespace, policy, ceiling, protected tables and worker action bindings reject before vault access',()=>{
 for(const mutate of [f=>f.config.streamArn=f.config.streamArn.replace('123456789012','000000000001'),f=>f.hooks.awsRegion='eu-west-1',f=>f.config.streamArn=f.config.streamArn.replace('synthetic-inbox','other-inbox'),f=>f.config.merchantId='acct_foreign',f=>f.config.environmentId='foreign',f=>f.config.composition.entitlements.policyHash='0'.repeat(64),f=>f.config.composition.entitlements.catalogHash='0'.repeat(64),f=>f.config.composition.runtime.catalogHash='0'.repeat(64),f=>f.config.composition.operationalCeiling=100,f=>f.hooks.protectedTableNames.push('synthetic-metadata'),f=>{f.hooks.protectedTableNames=['another-table'];f.config.composition.tables.metadata='supatrace-alpha-metadata';},f=>f.hooks.protectedTableNames=[],f=>f.config.composition.tables.state=f.config.composition.tables.inbox,f=>f.config.composition.purpose='api',f=>f.config.composition.runtime.runtimePurpose='api',f=>f.config.composition.runtime.endpointSecretArns=['arn:signing'],f=>f.config.composition.runtime.purchasesEnabled=true,f=>f.config.composition.runtime.approvalRef='another-review',f=>f.config.composition.entitlementActions=['sandbox.entitlement.view'],f=>f.config.composition.runtime.authorizedActions.push('checkout.create'),f=>f.config.composition.runtime.authorizedActions=null,f=>f.config.authorizedActions.push('checkout.create')]){
  const f=fixture();mutate(f);assert.throws(()=>createStripeEntitlementWorkerHandler(f.config,f.hooks),/scope_mismatch/);assert.equal(f.secrets.length,0);assert.equal(f.actions.length,0);assert.equal(f.requests.length,0);
 }
});
test('event cannot choose scope or supply images; authorization denial never loads worker credentials',async()=>{
 for(const mutate of [f=>f.event.Records[0].eventSourceARN+='wrong',f=>f.event.Records[0].dynamodb.NewImage={},f=>f.event.Records[0].dynamodb.Keys.pk.S='foreign']){const f=fixture();mutate(f);await assert.rejects(createStripeEntitlementWorkerHandler(f.config,f.hooks)(f.event));assert.equal(f.secrets.length,0);assert.equal(f.actions.length,0);}
 for(const action of ['worker.invoke','runtime.credentials']){const f=fixture();f.hooks.authorize=async d=>d.action!==action;assert.deepEqual(await createStripeEntitlementWorkerHandler(f.config,f.hooks)(f.event),{batchItemFailures:[{itemIdentifier:'123'}]});assert.equal(f.secrets.length,0);}
});
test('missing durable capture stays retryable, uses only worker key, and pins policy in every authorization',async()=>{
 const f=fixture(),worker=createStripeEntitlementWorkerHandler(f.config,f.hooks);f.config.composition.runtime.authorizedActions.push('checkout.create');f.config.merchantId='acct_changed_after_factory';
 assert.deepEqual(await worker(f.event),{batchItemFailures:[{itemIdentifier:'123'}]});assert.equal(f.secrets.length,1);assert.match(f.secrets[0],/worker-runtime-/);assert.equal(f.requests.length,0);
 assert.ok(f.actions.some(a=>a.action==='capture.process'));for(const d of f.actions){assert.equal(d.merchant_id,'acct_synthetic');assert.equal(d.livemode,false);assert.equal(d.approval_ref,'synthetic-source-only');assert.equal(d.policy_hash,fixture().config.composition.entitlements.policyHash);assert.equal(d.catalog_hash,fixture().config.composition.entitlements.catalogHash);assert.ok(!['checkout.create','portal.create','customer.create','sandbox.entitlement.view'].includes(d.action));}
});
