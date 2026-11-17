// Entire journey is local: actual Stripe SDK, in-process HTTP fixtures, MemoryDynamo.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,createHash} from 'node:crypto';
import Stripe from 'stripe';
import {handle} from '../src/aws-api.mjs';
import {DynamoMetadataStore} from '../src/dynamodb-store.mjs';
import {MemoryDynamo,commandClasses} from './memory-dynamo.mjs';
import {commercialPolicyHash} from '../src/commercial-policy.mjs';
import {stripeTestCatalogHash} from '../src/stripe-test-checkout.mjs';
import {createStripeSandboxClient,processStoredStripeBillingEvent} from '../src/stripe-billing.mjs';
import {createStripeStreamWorker} from '../src/stripe-worker.mjs';
import {alphaProject} from '../src/alpha-projects.mjs';
import {sandboxEntitlementDecision,validateSandboxEntitlementConfiguration} from '../src/stripe-sandbox-entitlements.mjs';

const merchant='acct_fixture',environment='fixture-dev',version='2026-10-28.endive';
const requestId='checkout_test_1234567890abcdef',cookie='__Host-supatrace='+ 'a'.repeat(43);
const secret='whsec_synthetic_local_fixture_only';
const streamArn='arn:aws:dynamodb:us-east-1:123456789012:table/fixture-inbox/stream/2026-11-05T00:00:00.000';
async function fixture(t,{enabled=true}={}) {
  let time=2000000000,sessionTenant='github-1';t.mock.method(Date,'now',()=>time*1000);
  const policy={version:'fixture-v1',revision:1,merchant_id:merchant,environment_id:environment,livemode:false,
    terms_url:'https://supatrace.dev/fixture-terms',accounting:'cumulative_reserved_bytes',non_active:'block_new_uploads',
    risk:'block_new_uploads',invoice_policy:'full_price_paid',lease_seconds:60,free_plan_id:'fixture-free',plans:[
      {id:'fixture-free',name:'Fixture free',price_id:null,unit_amount:0,currency:'usd',interval:'month',storage_limit_bytes:1024},
      {id:'fixture-paid',name:'Fixture paid',price_id:'price_fixture',unit_amount:200,currency:'usd',interval:'month',storage_limit_bytes:4096}]};
  const catalog={sandbox_kind:'isolated',environment_id:environment,merchant_id:merchant,livemode:false,api_version:version,
    revision:commercialPolicyHash(policy),prices:{price_fixture:{plan_id:'synthetic-pro',currency:'usd',unit_amount:200,interval:'month'}}};
  const config={enabled:true,policy,policyHash:commercialPolicyHash(policy),catalog,catalogHash:stripeTestCatalogHash(catalog)};
  const memory=new MemoryDynamo(),options={client:memory,commands:commandClasses(),tableName:'fixture-metadata',
    stripeStateTableName:'fixture-state',stripeInboxTableName:'fixture-inbox',stripeTestInbox:true,
    stripeTestEnvironment:environment,now:()=>time,...(enabled?{stripeSandboxEntitlements:config}:{})};
  const store=new DynamoMetadataStore(options);await store.getOrCreateTenant(1);await store.getOrCreateTenant(2);await store.createSession(createHash('sha256').update('a'.repeat(43)).digest('hex'),'github-1');
  await store.bindStripeTestCustomer('github-1',{merchant_id:merchant,customer_id:'cus_fixture'});
  store.consumeRate=async()=>({allowed:true});store.getSession=async()=>({tenant_id:sessionTenant});
  const before=await store.getTenant('github-1'),calls=[],actions=[];
  const objects={
    '/v1/account':{object:'account',id:merchant},
    '/v1/customers/cus_fixture':{object:'customer',id:'cus_fixture',livemode:false},
    '/v1/checkout/sessions/cs_test_fixture':{object:'checkout.session',id:'cs_test_fixture',livemode:false,mode:'subscription',status:'complete',payment_status:'paid',customer:'cus_fixture',subscription:'sub_fixture',client_reference_id:requestId},
    '/v1/subscriptions/sub_fixture':{object:'subscription',id:'sub_fixture',livemode:false,customer:'cus_fixture',status:'active',latest_invoice:'in_fixture',items:{has_more:false,data:[{subscription:'sub_fixture',quantity:1,current_period_start:time-100,current_period_end:time+3600,price:{object:'price',id:'price_fixture',active:true,livemode:false,type:'recurring',currency:'usd',unit_amount:200,recurring:{interval:'month',interval_count:1}}}]}},
    '/v1/invoices/in_fixture':{object:'invoice',id:'in_fixture',livemode:false,customer:'cus_fixture',status:'paid',currency:'usd',amount_remaining:0,amount_due:200,amount_paid:200,parent:{type:'subscription_details',subscription_details:{subscription:'sub_fixture'}}}
  };
  let responseVersion=version;
  function Client(key,opts){return new Stripe(key,{...opts,httpClient:Stripe.createFetchHttpClient(async(url,request)=>{
    const u=new URL(url);assert.equal(u.origin,'https://api.stripe.com');assert.equal(u.search,'');
    assert.equal(new Headers(request.headers).get('stripe-version'),version);calls.push(u.pathname);
    let object=objects[u.pathname];
    if(u.pathname==='/v1/checkout/sessions'){
      assert.equal(request.method,'POST');const body=new URLSearchParams(request.body);
      assert.equal(body.get('customer'),'cus_fixture');assert.equal(body.get('line_items[0][price]'),'price_fixture');
      assert.equal(body.has('payment_method_types[0]'),false);
      object={...objects['/v1/checkout/sessions/cs_test_fixture'],status:'open',url:'https://checkout.stripe.com/c/pay/cs_test_fixture'};
    }
    if(!object)throw Error('unexpected_fixture_route_network_forbidden');
    return new Response(JSON.stringify(object),{headers:{'content-type':'application/json','stripe-version':responseVersion,'request-id':'req_fixture'}});
  })});}
  const env={ENABLED:true,APP_ORIGIN:'https://supatrace.dev',GITHUB_CLIENT_ID:'fixture',GITHUB_CLIENT_SECRET:'fixture',objects:{},store,
    ...(enabled?{stripeSandboxEntitlements:config}:{}),stripeBilling:{enabled:true,mode:'isolated_sandbox',captureOnly:true,purchasesEnabled:false,
      catalog,catalogHash:config.catalogHash,integrationIdentifier:'supatrace-checkout-abcdefgh',endpointSecrets:[secret],
      client:createStripeSandboxClient(Client,'rk_test_'+ 'x'.repeat(24)),authorize:async action=>{actions.push(action);return true;}}};
  const scope='STRIPETEST#'+createHash('sha256').update(JSON.stringify([merchant,environment])).digest('hex');
  const event=(id='evt_checkout',type='checkout.session.completed')=>({id,object:'event',type,livemode:false,api_version:version,created:time,
    data:{object:type.startsWith('checkout.')?objects['/v1/checkout/sessions/cs_test_fixture']:{object:'subscription',id:'sub_fixture',customer:'cus_fixture',livemode:false}}});
  const capture=async(e,signingSecret=secret,timestamp=time)=>{
    const raw=JSON.stringify(e),signature=createHmac('sha256',signingSecret).update(timestamp+'.'+raw).digest('hex');
    return handle(new Request('https://supatrace.dev/api/billing/webhook',{method:'POST',headers:{'content-type':'application/json','stripe-signature':'t='+timestamp+',v1='+signature},body:raw}),env);
  };
  const checkout=()=>handle(new Request('https://supatrace.dev/api/billing/checkout?project='+alphaProject('github-1').id,{method:'POST',headers:{cookie,origin:env.APP_ORIGIN,'content-type':'application/json'},body:JSON.stringify({price_id:'price_fixture',request_id:requestId})}),env);
  const read=(project=alphaProject('github-1').id,authenticated=true)=>handle(new Request('https://supatrace.dev/api/billing/sandbox-entitlement?project='+project,{headers:authenticated?{cookie}:{}}),env);
  const worker=createStripeStreamWorker({enabled:true,streamArn,merchantId:merchant,environmentId:environment,authorize:async()=>true,loadEnvironment:async()=>env});
  const work=id=>worker({Records:[{eventName:'INSERT',eventSource:'aws:dynamodb',eventSourceARN:streamArn,dynamodb:{StreamViewType:'KEYS_ONLY',SequenceNumber:'1',Keys:{pk:{S:scope},sk:{S:'CAPTURE#'+id}}}}]});
  return {env,store,options,memory,config,objects,calls,actions,before,event,capture,checkout,read,work,scope,
    advance:n=>time+=n,switchAccount:()=>sessionTenant='github-2',wrongVersion:()=>responseVersion='wrong',
    ledger:()=>[...memory.items.values()].find(r=>r.sk===scope+'#RECONCILIATION'),
    process:id=>processStoredStripeBillingEvent(env,id)};
}
async function complete(f){assert.equal((await f.checkout()).status,201);assert.equal((await f.capture(f.event())).status,202);assert.deepEqual(await f.work('evt_checkout'),{batchItemFailures:[]});}

test('signed Checkout -> stored worker -> atomic sandbox entitlement -> authenticated project view, actual SDK locally',async t=>{
  const f=await fixture(t);await complete(f);
  const result=await (await f.read()).json();assert.equal(result.status,'active');assert.equal(result.plan_id,'fixture-paid');
  assert.equal(result.storage_limit_bytes,4096);assert.equal(result.paid_access,false);assert.equal(result.quota_enforced,false);
  assert.deepEqual(await f.store.getTenant('github-1'),f.before);
  const reopened=new DynamoMetadataStore(f.options);assert.equal((await reopened.getStripeSandboxEntitlement('github-1')).status,'active');
  const receipt=await reopened.getStripeTestReconciliationReceipt('github-1',{merchant_id:merchant,event_id:'evt_checkout'});
  assert.equal(receipt.sandbox_entitlement_recorded,true);assert.equal(receipt.entitlements_applied,false);
  assert.equal(await f.store.resolveCommercialQuota('github-1'),null);
  assert.ok(f.actions.some(a=>a.action==='sandbox.entitlement.reconcile'&&a.tenant_id==='github-1'));
});

test('duplicates do not reread provider or extend lease; changed signed body conflicts',async t=>{
  const f=await fixture(t);await complete(f);const ledger=structuredClone(f.ledger()),count=f.calls.length;
  assert.deepEqual(await f.work('evt_checkout'),{batchItemFailures:[]});assert.equal(f.calls.length,count);
  assert.equal((await f.capture({...f.event(),created:1999999999})).status,409);
  f.advance(61);assert.deepEqual(await f.work('evt_checkout'),{batchItemFailures:[]});assert.deepEqual(f.ledger(),ledger);
  assert.equal((await (await f.read()).json()).status,'blocked');
});

test('missing, invalid and stale signature, live mode and foreign context cannot reach fulfillment',async t=>{
  const f=await fixture(t);await f.checkout();
  for(const [e,key,time] of [[f.event(),'wrong',undefined],[f.event(),secret,1999999600],[{...f.event(),livemode:true},secret,undefined],[{...f.event(),account:'acct_foreign'},secret,undefined]]){
    assert.equal((await f.capture(e,key,time)).status,400);
  }
  assert.equal((await handle(new Request('https://supatrace.dev/api/billing/webhook',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(f.event())}),f.env)).status,400);
  assert.equal(f.ledger(),undefined);assert.equal([...f.memory.items.values()].some(r=>r.sk.startsWith('CAPTURE#')),false);
});

test('account/project and session guards protect sandbox read and billing writes',async t=>{
  const f=await fixture(t);await complete(f);const count=f.calls.length;
  assert.equal((await f.read(undefined,false)).status,401);
  assert.equal((await f.read(alphaProject('github-2').id)).status,403);
  f.switchAccount();assert.equal((await f.read()).status,403);assert.equal((await f.checkout()).status,403);
  assert.equal((await f.read(alphaProject('github-2').id)).status,409);assert.equal(f.calls.length,count);
});

test('unpaid completed event does not bind; async success can fulfill, failed async cannot',async t=>{
  const f=await fixture(t);await f.checkout();const session=f.objects['/v1/checkout/sessions/cs_test_fixture'];
  session.payment_status='unpaid';assert.equal((await f.capture(f.event())).status,202);await f.work('evt_checkout');
  assert.equal((await f.store.getStripeTestBinding('github-1',merchant)).subscription_id,undefined);assert.equal(f.ledger(),undefined);
  session.payment_status='paid';assert.equal((await f.capture(f.event('evt_failed','checkout.session.async_payment_failed'))).status,202);await f.work('evt_failed');assert.equal(f.ledger(),undefined);
  assert.equal((await f.capture(f.event('evt_success','checkout.session.async_payment_succeeded'))).status,202);
  assert.deepEqual(await f.work('evt_success'),{batchItemFailures:[]});assert.equal((await (await f.read()).json()).status,'active');
});

test('wrong session customer/reference, current invoice subscription, live price and API version fail closed',async t=>{
  for(const mutate of [
    f=>f.objects['/v1/checkout/sessions/cs_test_fixture'].client_reference_id='checkout_test_foreign0000000000',
    f=>f.objects['/v1/checkout/sessions/cs_test_fixture'].customer='cus_foreign',
    f=>f.objects['/v1/invoices/in_fixture'].parent.subscription_details.subscription='sub_foreign',
    f=>f.objects['/v1/subscriptions/sub_fixture'].items.data[0].price.livemode=true,
    f=>f.wrongVersion()
  ]){
    const f=await fixture(t);await f.checkout();const event=structuredClone(f.event());mutate(f);
    assert.equal((await f.capture(event)).status,202);assert.deepEqual(await f.work('evt_checkout'),{batchItemFailures:[{itemIdentifier:'1'}]});
    assert.equal(f.ledger(),undefined);assert.deepEqual(await f.store.getTenant('github-1'),f.before);
  }
});

test('fulfillment write failure stays retryable; lost acknowledgment recovers exactly once',async t=>{
  for(const lostAck of [false,true]){
    const f=await fixture(t);await f.checkout();await f.capture(f.event());const send=f.memory.send.bind(f.memory);let failOnce=true;
    f.memory.send=async command=>{
      if(failOnce&&command.name==='TransactWriteCommand'&&command.input.TransactItems.some(op=>op.Put?.Item?.sandbox_entitlement)){
        failOnce=false;if(lostAck)await send(command);throw Error('fixture transaction unavailable');
      }return send(command);
    };
    const first=await f.work('evt_checkout');
    assert.deepEqual(first,{batchItemFailures:lostAck?[]:[{itemIdentifier:'1'}]});
    if(!lostAck){assert.equal(f.ledger(),undefined);assert.equal([...f.memory.items.values()].find(r=>r.sk==='EVENT#evt_checkout').status,'reconciliation_required');}
    assert.deepEqual(await f.work('evt_checkout'),{batchItemFailures:[]});assert.equal(f.ledger().sandbox_entitlement.status,'active');
    assert.deepEqual(await f.store.getTenant('github-1'),f.before);
  }
});

test('cancellation and invoice underpayment record blocked state, never a quota change',async t=>{
  for(const mutate of [f=>f.objects['/v1/subscriptions/sub_fixture'].status='canceled',f=>f.objects['/v1/invoices/in_fixture'].amount_paid=199]){
    const f=await fixture(t);await complete(f);f.advance(1);mutate(f);await f.capture(f.event('evt_changed','customer.subscription.updated'));
    assert.deepEqual(await f.work('evt_changed'),{batchItemFailures:[]});assert.equal((await (await f.read()).json()).status,'blocked');
    assert.deepEqual(await f.store.getTenant('github-1'),f.before);
  }
});

test('unresolved signed risk immediately blocks projection and racing activation, including provider failure',async t=>{
  const f=await fixture(t);await complete(f);
  const risk={...f.event('evt_risk'),type:'charge.dispute.created',data:{object:{object:'dispute',id:'du_fixture',livemode:false,charge:'ch_fixture'}}};
  assert.equal((await f.capture(risk)).status,202);assert.equal((await (await f.read()).json()).reason,'sandbox_risk_review_required');
  assert.deepEqual(await f.work('evt_risk'),{batchItemFailures:[{itemIdentifier:'1'}]});
  f.advance(1);await f.capture(f.event('evt_new','customer.subscription.updated'));
  assert.deepEqual(await f.work('evt_new'),{batchItemFailures:[{itemIdentifier:'1'}]});
  assert.equal(f.ledger().event_id,'evt_checkout');
});

test('disabled default and historical receipts never become sandbox or live grants',async t=>{
  const f=await fixture(t,{enabled:false});await complete(f);assert.equal(f.ledger().sandbox_entitlement,undefined);
  assert.equal((await f.read()).status,503);
  f.env.store=new DynamoMetadataStore({...f.options,stripeSandboxEntitlements:f.config});f.env.stripeSandboxEntitlements=f.config;
  await assert.rejects(f.process('evt_checkout'),/new_event_required/);
  assert.equal((await f.env.store.getStripeSandboxEntitlement('github-1')).status,'pending');
  assert.throws(()=>sandboxEntitlementDecision({}, {},f.env.store.sandboxEntitlementPolicy),/verified_sandbox/);
});

test('policy/catalog/mode mismatches and missing dedicated stores cannot enable projection',async t=>{
  const f=await fixture(t);
  for(const mutate of [c=>c.policy.livemode=true,c=>c.policy.plans[1].storage_limit_bytes=99999999,c=>c.catalog.prices.price_fixture.unit_amount=1,c=>c.policyHash='wrong']){
    const config=structuredClone(f.config);mutate(config);assert.throws(()=>validateSandboxEntitlementConfiguration(config,10*1024*1024));
  }
  assert.throws(()=>new DynamoMetadataStore({...f.options,stripeStateTableName:null}),/isolated sandbox/);
  delete f.env.stripeSandboxEntitlements;await assert.rejects(f.process('evt_missing'),/captured_event_not_found/);
  assert.equal((await f.read()).status,409);
});

test('concurrent events share one atomic watermark and stale events cannot restore cancellation',async t=>{
  const f=await fixture(t);await complete(f);f.advance(1);
  await f.capture(f.event('evt_a','customer.subscription.updated'));await f.capture(f.event('evt_b','customer.subscription.updated'));
  const outcomes=await Promise.allSettled([f.process('evt_a'),f.process('evt_b')]);
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
  f.advance(1);f.objects['/v1/subscriptions/sub_fixture'].status='canceled';
  await f.capture({...f.event('evt_old','customer.subscription.updated'),created:1999999990});
  await f.process('evt_old');assert.equal(f.ledger().sandbox_entitlement.status,'blocked');
  await f.process('evt_checkout');assert.equal(f.ledger().event_id,'evt_old');
});

test('binding and risk races abort the transaction without marking the event fulfilled',async t=>{
  for(const riskRace of [false,true]){
    const f=await fixture(t);await f.checkout();await f.capture(f.event());const send=f.memory.send.bind(f.memory);let once=true;
    f.memory.send=async command=>{
      if(once&&command.name==='TransactWriteCommand'&&command.input.TransactItems.some(op=>op.Put?.Item?.sandbox_entitlement)){
        once=false;
        if(riskRace){
          const row={pk:f.scope,sk:'SANDBOX_RISK_HOLD',livemode:false};f.memory.items.set(row.pk+'\0'+row.sk,row);
        }else{
          for(const row of f.memory.items.values())if(row.subscription_id==='sub_fixture'&&row.binding_revision)row.binding_revision++;
        }
      }return send(command);
    };
    assert.deepEqual(await f.work('evt_checkout'),{batchItemFailures:[{itemIdentifier:'1'}]});assert.equal(f.ledger(),undefined);
    assert.equal([...f.memory.items.values()].find(r=>r.sk==='EVENT#evt_checkout').status,'reconciliation_required');
  }
});

test('fulfillment performs no Metadata reads/writes beyond tenant-existence check; view needs separate authorization',async t=>{
  const f=await fixture(t);await f.checkout();await f.capture(f.event());const send=f.memory.send.bind(f.memory);
  f.memory.send=async command=>{
    if(command.name==='TransactWriteCommand')for(const operation of command.input.TransactItems){
      const [kind,input]=Object.entries(operation)[0];
      if(input.TableName==='fixture-metadata'){assert.equal(kind,'ConditionCheck');assert.equal(input.ConditionExpression,'attribute_exists(pk)');}
      else assert.ok(['fixture-state','fixture-inbox'].includes(input.TableName));
    }else assert.notEqual(command.input.TableName,'fixture-metadata');
    return send(command);
  };
  assert.deepEqual(await f.work('evt_checkout'),{batchItemFailures:[]});
  f.memory.send=send; // Worker isolation check ends here; authenticated views resolve workspace metadata.
  f.env.stripeBilling.authorize=async action=>action.action!=='sandbox.entitlement.view';
  assert.equal((await f.read()).status,403);
});

test('risk marker failure cannot acknowledge a signed event',async t=>{
  const f=await fixture(t),send=f.memory.send.bind(f.memory);
  f.memory.send=async command=>{
    if(command.name==='TransactWriteCommand'&&command.input.TransactItems.some(op=>op.Put?.Item?.sk==='SANDBOX_RISK_HOLD'))throw Error('fixture-store-failure');
    return send(command);
  };
  const risk={...f.event('evt_risk'),type:'charge.refunded',data:{object:{object:'charge',id:'ch_fixture',livemode:false,payment_intent:'pi_fixture'}}};
  assert.notEqual((await f.capture(risk)).status,202);
  assert.equal([...f.memory.items.values()].some(r=>r.event_id==='evt_risk'),false);
});


test('disabled worker cannot erase a previous sandbox policy watermark',async t=>{
  const f=await fixture(t);await complete(f);const previous=structuredClone(f.ledger());f.advance(1);
  await f.capture(f.event('evt_disabled','customer.subscription.updated'));
  f.env.store=new DynamoMetadataStore({...f.options,stripeSandboxEntitlements:null});delete f.env.stripeSandboxEntitlements;
  await assert.rejects(f.process('evt_disabled'),/sandbox_entitlement_composition_required/);
  assert.deepEqual(f.ledger(),previous);
});

test('sandbox reconciliation authorization fails before current provider reads',async t=>{
  const f=await fixture(t);await complete(f);f.advance(1);await f.capture(f.event('evt_denied','customer.subscription.updated'));
  const count=f.calls.length;f.env.stripeBilling.authorize=async action=>action.action!=='sandbox.entitlement.reconcile';
  await assert.rejects(f.process('evt_denied'),/billing_action_not_authorized/);assert.equal(f.calls.length,count);
  assert.equal(f.ledger().event_id,'evt_checkout');
});

test('PR36 MCP-only cookie cannot authenticate sandbox billing reads or Checkout',async t=>{
  const f=await fixture(t);await complete(f);const before=structuredClone(f.ledger()),count=f.calls.length;
  const project=alphaProject('github-1').id,headers={cookie:'__Host-supatrace-mcp='+'m'.repeat(43),origin:f.env.APP_ORIGIN,'content-type':'application/json'};
  for(const [method,path,body] of [
    ['GET','/api/billing/sandbox-entitlement',undefined],
    ['POST','/api/billing/checkout',JSON.stringify({price_id:'price_fixture',request_id:requestId})]
  ]){
    const response=await handle(new Request(f.env.APP_ORIGIN+path+'?project='+project,{method,headers,...(body?{body}:{})}),f.env);
    assert.equal(response.status,401);assert.equal((await response.json()).error,'sign_in_required');
  }
  assert.equal(f.calls.length,count);assert.deepEqual(f.ledger(),before);
});

test('PR36 real session epoch revocation also closes the sandbox entitlement read',async t=>{
  const f=await fixture(t);await complete(f);const before=structuredClone(f.ledger()),count=f.calls.length;
  delete f.store.getSession; // Use the merged store's real epoch-stamped session path.
  // The fixture already established the physical epoch-stamped session.
  assert.equal((await f.read()).status,200);
  await f.store.endTenantSessions('github-1');
  for(const response of [await f.read(),await f.checkout()]){
    assert.equal(response.status,401);assert.equal((await response.json()).error,'sign_in_required');
  }
  const nextToken=createHash('sha256').update('b'.repeat(43)).digest('hex');
  await assert.rejects(f.store.createSession(nextToken,'github-1',f.options.now()+1200,0),/session_changed/);
  assert.equal(f.calls.length,count);assert.deepEqual(f.ledger(),before);
});
