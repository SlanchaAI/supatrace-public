// Actual auth/session/workspace/store/handler; all provider methods are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {handle} from '../src/aws-api.mjs';
import {DynamoMetadataStore} from '../src/dynamodb-store.mjs';
import {MemoryDynamo,commandClasses} from './memory-dynamo.mjs';
import {digest} from '../src/aws-auth.mjs';
import {alphaProject} from '../src/alpha-projects.mjs';
import {Workspaces,workspaceSession} from '../src/workspaces.mjs';
import {stripeTestCatalogHash} from '../src/stripe-test-checkout.mjs';
import {checkoutScope} from '../src/billing-principal.mjs';
const token='a'.repeat(43),other='b'.repeat(43),origin='https://supatrace.dev',merchant='acct_principalfixture',requestId='checkout_test_1234567890abcdef';
const request=({who=token,query='',body={price_id:'price_fixture',request_id:requestId},signal,path='checkout',requestOrigin=origin}={})=>new Request(origin+'/api/billing/'+path+query,{method:'POST',headers:{cookie:'__Host-supatrace='+who,origin:requestOrigin,'content-type':'application/json'},body:JSON.stringify(body),signal});
async function fixture(){
 let now=1700000000;const client=new MemoryDynamo(),store=new DynamoMetadataStore({client,commands:commandClasses(),tableName:'metadata',stripeStateTableName:'billing-state',stripeTestInbox:true,stripeTestEnvironment:'principal-sandbox',now:()=>now});
 await store.getOrCreateTenant(1);await store.getOrCreateTenant(2);
 // The fixture invites a read-only member, which is the roles feature: both accounts are on Pro.
 for(const id of [1,2])client.items.get('TENANT#github-'+id+'\0META').plan_id='pro';
 await store.createSession(digest(token),'github-1');await store.createSession(digest(other),'github-2');store.consumeRate=async()=>({allowed:true});
 await store.bindStripeTestCustomer('github-1',{merchant_id:merchant,customer_id:'cus_fixture'});
 const calls=[],sessions=new Map(),catalog={sandbox_kind:'isolated',environment_id:'principal-sandbox',merchant_id:merchant,livemode:false,api_version:'2026-10-28.endive',revision:'fixture-only',prices:{price_fixture:{plan_id:'synthetic-pro',currency:'usd',unit_amount:200,interval:'month'}}};
 const sdk={accounts:{retrieve:async()=>{calls.push('account');return {object:'account',id:merchant};}},customers:{retrieve:async id=>{calls.push('customer');return {object:'customer',id,livemode:false};}},checkout:{sessions:{create:async(p,o)=>{calls.push({params:structuredClone(p),key:o.idempotencyKey});if(!sessions.has(o.idempotencyKey))sessions.set(o.idempotencyKey,{object:'checkout.session',id:'cs_test_fixture',mode:'subscription',status:'open',customer:p.customer,client_reference_id:p.client_reference_id,livemode:false,url:'https://checkout.stripe.com/c/pay/cs_test_fixture'});return sessions.get(o.idempotencyKey);}}}};
 const env={ENABLED:true,APP_ORIGIN:origin,GITHUB_CLIENT_ID:'synthetic',GITHUB_CLIENT_SECRET:'synthetic',store,objects:{},stripeBilling:{enabled:true,mode:'isolated_sandbox',purchasesEnabled:false,catalog,catalogHash:stripeTestCatalogHash(catalog),client:sdk,integrationIdentifier:'supatrace-checkout-abcdefgh',authorize:async()=>true}};
 const lock=()=>[...client.items.values()].find(r=>r.sk.endsWith('#CHECKOUTLOCK'));
 const spaces=async(actor,who)=>new Workspaces(store,await workspaceSession(request({who}),store,actor));
 return {store,client,sdk,env,calls,sessions,lock,spaces,advance:s=>now+=s};
}
test('own personal and shared workspace use the same server-owned principal and immutable descriptor',async()=>{
 for(const shared of [false,true]){
  const f=await fixture();if(shared)await(await f.spaces('github-1',token)).create('github-1','Shared fixture');
  const response=await handle(request({query:'?workspace=github-1&project='+alphaProject('github-1').id}),f.env);
  assert.equal(response.status,201,await response.clone().text());assert.equal((await response.json()).purchases_enabled,false);
  const row=f.lock();assert.deepEqual(row.checkout_scope,{version:1,workspace_id:'github-1',project_id:alphaProject('github-1').id,environment_id:'default',origin});
  assert.equal(row.checkout_scope_hash,digest(JSON.stringify(row.checkout_scope)));assert.equal((await f.store.getStripeTestBinding('github-1',merchant)).environment_id,'principal-sandbox');
  assert.equal(row.checkout_scope.environment_id,'default','Stripe sandbox ID is separate from app environment');
  assert.equal((await handle(request(),f.env)).status,200);assert.equal(f.calls.filter(c=>typeof c==='object').length,1);
  assert.equal(JSON.stringify(row).includes(digest(token)),false,'physical session stamp is not copied into billing records');
 }
});
for(const role of ['admin','viewer'])test(`an account in multiple workspaces cannot bill a foreign ${role} workspace`,async()=>{
 const f=await fixture(),owner=await f.spaces('github-2',other),member=await f.spaces('github-1',token);
 await owner.create('github-2','Other workspace');const invitation=await owner.invite('github-2','github-2',{recipient_id:'github-1',role});await member.accept('github-1','github-2',invitation.token);
 const response=await handle(request({query:'?workspace=github-2&project='+alphaProject('github-2').id}),f.env);assert.equal(response.status,403);assert.deepEqual(f.calls,[]);assert.equal(f.lock(),undefined);
 await owner.changeMember('github-2','github-2',{user_id:'github-1',role:'removed',version:0});assert.equal((await handle(request({query:'?workspace=github-2'}),f.env)).status,403);
 assert.equal((await handle(request(),f.env)).status,201,'membership does not rebind personal workspace billing');
});
test('foreign project/environment, duplicate scope and caller principal overrides fail before provider access',async()=>{
 for(const options of [{query:'?project='+alphaProject('github-2').id},{query:'?environment=dev'},{query:'?workspace=github-2'}, {query:'?project='+alphaProject('github-1').id+'&project='+alphaProject('github-2').id},...['workspace_id','principal_id','checkout_scope','customer_id'].map(k=>({body:{price_id:'price_fixture',request_id:requestId,[k]:'github-2'}}))]){
  const f=await fixture(),r=await handle(request(options),f.env);assert.ok([400,403].includes(r.status),await r.clone().text());assert.deepEqual(f.calls,[]);assert.equal(f.lock(),undefined);
 }
});
test('missing or incoherent runtime stays unavailable without provider or intent writes',async()=>{
 for(const change of [f=>delete f.env.stripeBilling,f=>f.env.stripeBilling.purchasesEnabled=true,f=>f.env.stripeBilling.catalogHash='0'.repeat(64),f=>f.env.stripeBilling.mode='live']){
  const f=await fixture();change(f);assert.equal((await handle(request(),f.env)).status,503);assert.deepEqual(f.calls,[]);assert.equal(f.lock(),undefined);
 }
});
test('missing, replaced, expired or revoked physical session cannot use caller-attested ownership',async()=>{
 for(const fault of ['missing','replaced','expired','epoch']){
  const f=await fixture(),key={pk:'SESSION#'+Number(BigInt('0x'+digest(token))%1000n),sk:'SESSION'};
  if(fault==='expired')f.advance(86401);
  if(fault==='missing')f.client.items.delete(key.pk+'\0'+key.sk);
  if(fault==='replaced')f.client.items.get(key.pk+'\0'+key.sk).token_hash=digest(other);
  if(fault==='epoch')await f.store._tx([{Update:{Key:{pk:'TENANT#github-1',sk:'META'},UpdateExpression:'SET session_epoch = :epoch',ExpressionAttributeValues:{':epoch':1}}}]);
  assert.equal((await handle(request(),f.env)).status,401);assert.deepEqual(f.calls,[]);assert.equal(f.lock(),undefined);
 }
});
test('session revocation during provider read stops before Checkout creation',async()=>{
 const f=await fixture(),read=f.sdk.customers.retrieve;
 f.sdk.customers.retrieve=async(...args)=>{const r=await read(...args);await f.store._tx([{Update:{Key:{pk:'TENANT#github-1',sk:'META'},UpdateExpression:'SET session_epoch = :epoch',ExpressionAttributeValues:{':epoch':1}}}]);return r;};
 const r=await handle(request(),f.env);assert.equal(r.status,503);assert.equal(f.calls.filter(c=>typeof c==='object').length,0);assert.equal(f.lock(),undefined);
});
test('atomic session fence rejects intent creation if epoch changes after the last read',async()=>{
 const f=await fixture(),tx=f.store._tx.bind(f.store);let fenced=false;
 f.store._tx=async items=>{if(!fenced&&items.some(i=>i.Put?.Item?.sk.endsWith('#CHECKOUTLOCK'))){fenced=true;await tx([{Update:{Key:{pk:'TENANT#github-1',sk:'META'},UpdateExpression:'SET session_epoch = :epoch',ExpressionAttributeValues:{':epoch':1}}}]);}return tx(items);};
 const r=await handle(request(),f.env);assert.equal(r.status,409);assert.equal(fenced,true);assert.equal(f.lock(),undefined);assert.equal(f.calls.filter(c=>typeof c==='object').length,0);
});
test('navigation cancellation after provider acceptance retains scope and exact idempotency for explicit retry',async()=>{
 const f=await fixture(),controller=new AbortController(),create=f.sdk.checkout.sessions.create;
 f.sdk.checkout.sessions.create=async(...args)=>{const result=await create(...args);controller.abort();return result;};
 assert.equal((await handle(request({signal:controller.signal}),f.env)).status,503);const before=structuredClone(f.lock());assert.ok(before);assert.equal(before.session_receipt,undefined);
 f.sdk.checkout.sessions.create=create;
 assert.equal((await handle(request({query:'?project='+alphaProject('github-2').id}),f.env)).status,403);
 assert.equal((await handle(request(),f.env)).status,201);assert.equal(f.sessions.size,1);assert.equal(f.calls.filter(c=>typeof c==='object')[0].key,f.calls.filter(c=>typeof c==='object')[1].key);assert.deepEqual(f.lock().checkout_scope,before.checkout_scope);
 assert.equal((await handle(request({body:{price_id:'price_fixture',request_id:'checkout_test_abcdef1234567890'}}),f.env)).status,409,'new request cannot silently unlock an old intent');
});
test('pre-aborted request sends nothing; later independent retry can begin normally',async()=>{
 const f=await fixture(),controller=new AbortController();controller.abort();assert.equal((await handle(request({signal:controller.signal}),f.env)).status,409);assert.deepEqual(f.calls,[]);assert.equal(f.lock(),undefined);assert.equal((await handle(request(),f.env)).status,201);
});
test('tampered, origin-switched and legacy-unscoped intents cannot replay a stored Checkout URL',async()=>{
 for(const fault of ['project','hash','origin','legacy']){
  const f=await fixture();assert.equal((await handle(request(),f.env)).status,201);const row=f.lock(),key=row.pk+'\0'+row.sk;
  if(fault==='project')row.checkout_scope.project_id=alphaProject('github-2').id;
  if(fault==='hash')row.checkout_scope_hash='0'.repeat(64);
  if(fault==='legacy'){delete row.checkout_scope;delete row.checkout_scope_hash;}
  f.client.items.set(key,row);const sends=f.calls.filter(c=>typeof c==='object').length;
  const req=fault==='origin'?new Request('https://supatrace.tech/api/billing/checkout',{method:'POST',headers:{origin:'https://supatrace.tech',cookie:'__Host-supatrace='+token,'content-type':'application/json'},body:JSON.stringify({price_id:'price_fixture',request_id:requestId})}):request();
  if(fault==='origin')f.env.APP_ORIGINS=[origin,'https://supatrace.tech'];
  assert.equal((await handle(req,f.env)).status,409);assert.equal(f.calls.filter(c=>typeof c==='object').length,sends);
 }
});
test('pure persisted scope validator cannot turn an arbitrary principal into workspace authority',()=>{
 const scope={version:1,workspace_id:'github-1',project_id:alphaProject('github-1').id,environment_id:'default',origin};
 assert.deepEqual(checkoutScope(scope,'github-1',origin),scope);
 for(const change of [{workspace_id:'github-2'},{project_id:alphaProject('github-2').id},{environment_id:'prod'},{origin:'https://evil.invalid'},{principal_id:'forged'}])assert.throws(()=>checkoutScope({...scope,...change},'github-1',origin));
});
test('receipt commit cannot cross a concurrent durable-scope change after provider acceptance',async()=>{
 const f=await fixture(),tx=f.store._tx.bind(f.store);let changed=false;
 f.store._tx=async items=>{if(!changed&&items.some(i=>i.Update?.UpdateExpression==='SET session_receipt = :receipt')){changed=true;const row=f.lock();row.checkout_scope_hash='f'.repeat(64);f.client.items.set(row.pk+'\0'+row.sk,row);}return tx(items);};
 const response=await handle(request(),f.env);assert.equal(response.status,409);assert.equal(changed,true);assert.equal(f.sessions.size,1);assert.equal(f.lock().session_receipt,undefined,'no confirmed URL is returned or stored for the changed scope');
});
test('corrupt shared ownership cannot authorize provider access, and removal of owner account stops in flight',async()=>{
 const f=await fixture();await(await f.spaces('github-1',token)).create('github-1','Shared fixture');
 const key='TENANT#github-1\0WORKSPACE#META';f.client.items.get(key).owner='github-2';assert.equal((await handle(request(),f.env)).status,409);assert.deepEqual(f.calls,[]);
 const g=await fixture(),read=g.sdk.accounts.retrieve;g.sdk.accounts.retrieve=async(...args)=>{const r=await read(...args);g.client.items.delete('TENANT#github-1\0META');return r;};assert.equal((await handle(request(),g.env)).status,503);assert.equal(g.lock(),undefined);assert.deepEqual(g.calls,['account']);
});
test('reordered stored map properties retain the same canonical Checkout scope',async()=>{
 const f=await fixture();assert.equal((await handle(request(),f.env)).status,201);
 const row=f.lock();row.checkout_scope=Object.fromEntries(Object.entries(row.checkout_scope).reverse());f.client.items.set(row.pk+'\0'+row.sk,row);
 const response=await handle(request(),f.env);assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).replayed,true);assert.equal(f.calls.filter(c=>typeof c==='object').length,1);
});
