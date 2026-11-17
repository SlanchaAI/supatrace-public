import test from 'node:test';
import assert from 'node:assert/strict';
import {handle} from '../src/aws-api.mjs';
import {DynamoMetadataStore,digest} from '../src/dynamodb-store.mjs';
import {eraseAccounts,ERASURE_QUEUE,ownedRow} from '../src/account-deletion.mjs';
import {MemoryDynamo,commandClasses} from './memory-dynamo.mjs';
import {createFixtureSession} from './fixture-session.mjs';
import {stampPlan} from './harness.mjs';
const origin='https://supatrace.dev';
async function fixture(){
 let now=1700000000;
 const store=new DynamoMetadataStore({client:new MemoryDynamo(),commands:commandClasses(),tableName:'test',now:()=>now});
 store.consumeRate=async()=>({allowed:true});stampPlan(store,'pro');
 const tokens={};for(const n of [1,2]){await store.getOrCreateTenant(n);tokens['github-'+n]=await createFixtureSession(store,'github-'+n);}
 const versions=[],removed=[];
 class ListObjectVersionsCommand{constructor(input){this.input=input;}}
 class DeleteObjectCommand{constructor(input){this.input=input;}}
 const objects={bucket:'synthetic',commands:{ListObjectVersionsCommand,DeleteObjectCommand},client:{send:async cmd=>{
  if(cmd instanceof ListObjectVersionsCommand)return {Versions:versions.filter(v=>v.Key.startsWith(cmd.input.Prefix)).slice(0,50)};
  const i=versions.findIndex(v=>v.Key===cmd.input.Key&&v.VersionId===cmd.input.VersionId);assert.ok(i>=0);removed.push(versions.splice(i,1)[0]);return {};
 }}};
 const env={ENABLED:true,APP_ORIGIN:origin,GITHUB_CLIENT_ID:'test',GITHUB_CLIENT_SECRET:'test',store,objects};
 const api=(path,body,actor='github-1',extra={})=>handle(new Request(origin+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{cookie:'__Host-supatrace='+tokens[actor],origin,'content-type':'application/json',...extra},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);
 const put=Item=>store._send('PutCommand',{Item});
 return {store,env,tokens,versions,removed,api,put,advance:n=>{now+=n;}};
}
test('actual account closure ends sessions, PATs and ingest authorization and prevents identity reopening',async()=>{
 const f=await fixture(),pat=digest('synthetic-pat');
 await f.store.createAccessToken('github-1',{token_hash:pat,name:'test',expires_at:f.store.now()+3600});
 const key=await f.store.createSetup(digest('synthetic-write'));await f.store.approveSetup('github-1',key.user_code);
 const r=await f.api('account/delete',{confirm:'DELETE'});assert.equal(r.status,202,await r.clone().text());assert.match(r.headers.get('set-cookie'),/Max-Age=0/);
 assert.equal((await f.api('me')).status,401);assert.equal(await f.store.lookupAccessToken(pat),null);
 const {authorizeIssuedKey}=await import('../src/workspaces.mjs');await assert.rejects(authorizeIssuedKey(f.store,{tenant_id:'github-1'}),/invalid_write_key/);
 await assert.rejects(f.store.getOrCreateTenant(1),/account_closed/);
 await assert.rejects(f.store.createSession(digest('new-session'),'github-1'),/session_collision_or_unknown_tenant/);
 assert.equal((await f.api('me',undefined,'github-2')).status,200);
 assert.equal((await eraseAccounts(f.env)).processed,0);
});
test('closure requires exact confirmation, same origin and recent sign-in and fences owned organization creation',async()=>{
 const f=await fixture();
 for(const data of [{confirm:'delete'},{confirm:'DELETE',other:true},[],null])assert.equal((await f.api('account/delete',data)).status,400);
 assert.equal((await f.api('account/delete',{confirm:'DELETE'},'github-1',{origin:'https://other.invalid'})).status,403);
 f.advance(601);assert.equal((await f.api('account/delete',{confirm:'DELETE'})).status,403);
 f.tokens['github-1']=await createFixtureSession(f.store,'github-1');
 const original=f.store._tx.bind(f.store);let raced=false;
 f.store._tx=async items=>{if(!raced&&items.some(x=>x.Put?.Item?.pk===ERASURE_QUEUE)){raced=true;await f.put({pk:'TENANT#github-1',sk:'ORGANIZATION#CAPACITY',count:1});}return original(items);};
 assert.equal((await f.api('account/delete',{confirm:'DELETE'})).status,409);assert.equal((await f.store.getTenant('github-1')).deleted_at,undefined);
});
test('scheduled erasure removes all object versions and owned metadata, including retired environments, without touching neighbors',async()=>{
 const f=await fixture();
 await f.put({pk:'TENANT#github-1',sk:'ENVIRONMENT_RETIRED#old',id:'old'});
 await f.put({pk:'TENANT#github-1',sk:'ENVIRONMENT#staging',id:'staging'});
 for(let n=0;n<65;n++)await f.put({pk:'TENANT#github-1#RUN#'+n,sk:'BATCH',private:'content'});
 await f.put({pk:'EMAILINDEX#hashed',sk:'OWNER',tenant_id:'github-1'});
 await f.put({pk:'IDENTITY#native',sk:'LINK',target_tenant:'github-1'});
 await f.put({pk:'TENANT#github-2',sk:'MEMBER#github-1',user_id:'github-1',active:true});
 await f.put({pk:'TENANT#github-2',sk:'IDENTITY#github-1',native_id:'github-1',verified_email:'synthetic@example.invalid'});
 await f.put({pk:'TENANT#github-2',sk:'WORKSPACE#JOIN#github-1',owner:'github-1'});
 const foreign={pk:'TENANT#github-2',sk:'RUN#kept',data:{text:'github-1'}};await f.put(foreign);
 assert.equal((await f.api('account/delete',{confirm:'DELETE'})).status,202);
 const job=await f.store._get({pk:ERASURE_QUEUE,sk:'github-1'});assert.equal(job.prefixes.length,3);
 for(const Prefix of job.prefixes)for(let n=0;n<55;n++)f.versions.push({Key:Prefix+'payload.json',VersionId:String(n)});
 f.versions.push({Key:'v1/foreign/payload.json',VersionId:'1'});
 f.advance(601);assert.deepEqual(await eraseAccounts(f.env),{processed:1,phase:'complete'});
 assert.equal(f.removed.length,165);assert.equal(f.versions.length,1);
 const rows=[...f.store.client.items.values()];assert.deepEqual(rows.filter(r=>ownedRow(r,'github-1')).map(r=>r.sk),['META']);
 const tombstone=await f.store.getTenant('github-1');assert.ok(tombstone.erased_at);assert.equal(tombstone.provider,undefined);
 assert.deepEqual(await f.store._get(foreign),foreign);assert.equal((await f.store._get({pk:'SYS',sk:'CAPACITY'})).accounts,1);
 assert.equal((await eraseAccounts(f.env)).processed,0);
});
test('TEST customer cancellation retries safely and rejects every live customer before erasure',async()=>{
 const f=await fixture();let deleted=0,live=true;
 await f.store._send('UpdateCommand',{Key:{pk:'TENANT#github-1',sk:'META'},UpdateExpression:'SET stripe_customer_id = :id',ExpressionAttributeValues:{':id':'cus_synthetic'}});
 f.env.planBilling={mode:'test',stripe:{customers:{retrieve:async id=>({id,livemode:live}),del:async()=>{deleted++;}}}};
 assert.equal((await f.api('account/delete',{confirm:'DELETE'})).status,202);f.advance(601);
 await assert.rejects(eraseAccounts(f.env),/erasure_live_billing_refused/);assert.equal(deleted,0);
 live=false;f.advance(601);assert.equal((await eraseAccounts(f.env)).phase,'complete');assert.equal(deleted,1);
});
test('organization closure atomically queues physical erasure and cannot be reopened',async()=>{
 const f=await fixture(),made=await f.api('orgs',{name:'Erase test'});assert.equal(made.status,201);const org=await made.json();
 const r=await f.api('orgs/delete',{organization_id:org.id,confirm:'Erase test'});assert.equal(r.status,200,await r.clone().text());
 assert.ok(await f.store._get({pk:ERASURE_QUEUE,sk:org.id}));assert.equal((await f.api('runs?workspace='+org.id)).status,403);
 f.advance(601);assert.equal((await eraseAccounts(f.env)).phase,'complete');assert.ok((await f.store.getTenant(org.id)).erased_at);
});
test('the actual Lambda accepts only its configured schedule and runs the erasure worker',async t=>{
 const f=await fixture();assert.equal((await f.api('account/delete',{confirm:'DELETE'})).status,202);
 const {SecretsManagerClient}=await import('@aws-sdk/client-secrets-manager');
 const {DynamoDBDocumentClient}=await import('@aws-sdk/lib-dynamodb');
 const {S3Client}=await import('@aws-sdk/client-s3');
 t.mock.method(SecretsManagerClient.prototype,'send',async()=>({SecretString:'synthetic-oauth'}));
 t.mock.method(DynamoDBDocumentClient,'from',()=>({send:command=>f.store.client.send({name:command.constructor.name,input:command.input})}));
 t.mock.method(S3Client.prototype,'send',async()=>({Versions:[]}));
 t.mock.method(console,'info',()=>{});
 const settings={SUPATRACE_ENABLED:'true',TABLE_NAME:'synthetic',PAYLOAD_BUCKET:'synthetic',GITHUB_SECRET_ARN:'synthetic',GITHUB_CLIENT_ID:'synthetic',PLAN_BILLING_SECRET_ARN:'',ACCOUNT_ERASURE_RULE_ARN:'arn:aws:events:us-east-1:123456789012:rule/supatrace-account-erasure'};
 const previous=Object.fromEntries(Object.keys(settings).map(k=>[k,process.env[k]]));Object.assign(process.env,settings);
 try{
  const {handler}=await import('../aws/handler.mjs?account-erasure-test');
  const event={source:'aws.events','detail-type':'Scheduled Event',resources:[settings.ACCOUNT_ERASURE_RULE_ARN]};
  await assert.rejects(handler({...event,resources:['foreign']}),/invalid_erasure_schedule/);
  assert.deepEqual(await handler(event),{processed:1,phase:'complete'});
  assert.ok((await f.store.getTenant('github-1')).erased_at);
 }finally{for(const[k,v]of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
});

test('a refused billing job backs off and cannot starve the next ready account',async()=>{
 const f=await fixture();
 await f.store._send('UpdateCommand',{Key:{pk:'TENANT#github-1',sk:'META'},UpdateExpression:'SET stripe_customer_id = :id',ExpressionAttributeValues:{':id':'cus_synthetic'}});
 f.env.planBilling={mode:'test',stripe:{customers:{retrieve:async()=>({livemode:true}),del:async()=>assert.fail('live customer deletion')}}};
 for(const actor of ['github-1','github-2'])assert.equal((await f.api('account/delete',{confirm:'DELETE'},actor)).status,202);
 f.advance(601);await assert.rejects(eraseAccounts(f.env),/erasure_live_billing_refused/);
 assert.ok((await f.store.getTenant('github-2')).erased_at,'next account progresses before failure alerts');
 assert.equal((await f.store.getTenant('github-1')).erased_at,undefined);
 assert.equal((await eraseAccounts(f.env)).processed,0,'refused job backs off');
});

// AWS rejects an empty String for the sort-key expression value, including begins_with.
test('erasure queue pagination uses a partition-only query and rejects a foreign cursor',async()=>{
 const f=await fixture();
 for(let i=0;i<27;i++)await f.put({pk:ERASURE_QUEUE,sk:'github-'+(100+i),ready_at:f.store.now()+600});
 const first=await f.store._page(ERASURE_QUEUE,'',{limit:25});assert.equal(first.items.length,25);assert.ok(first.next);
 const second=await f.store._page(ERASURE_QUEUE,'',{limit:25,cursor:first.next});assert.equal(second.items.length,2);assert.equal(second.next,null);
 const foreign=Buffer.from(JSON.stringify({pk:'TENANT#github-1',sk:'META'})).toString('base64url');
 await assert.rejects(f.store._page(ERASURE_QUEUE,'',{cursor:foreign}),/invalid_cursor/);
 assert.equal((await eraseAccounts(f.env)).processed,0);
});

for(const mode of ['test','live'])test(`${mode} erasure protects live bindings and ignores test bindings without provider calls`,async()=>{
 const f=await fixture(),other=mode==='live'?'test':'live';
 const meta=f.store.client.items.get('TENANT#github-1\0META');Object.assign(meta,{plan_source:'stripe_'+other,stripe_customer_id:'cus_othermode',stripe_subscription_id:'sub_othermode',...(other==='live'?{stripe_mode:other}:{})});
 f.env.planBilling={mode,stripe:new Proxy({},{get(){throw Error('opposite-mode provider call');}})};
 const response=await f.api('account/delete',{confirm:'DELETE'});
 if(mode==='test'){assert.equal(response.status,409);assert.equal((await response.json()).error,'live_billing_requires_operator_closure');}
 else{assert.equal(response.status,202);f.advance(601);assert.equal((await eraseAccounts(f.env)).phase,'complete');}
});
test('live organization closure ignores test customer and subscription bindings',async()=>{
 const f=await fixture();f.env.planBilling={mode:'live',stripe:{}};
 const made=await f.api('orgs',{name:'Old billing'}),org=await made.json();assert.equal(made.status,201);
 Object.assign(f.store.client.items.get('TENANT#'+org.id+'\0META'),{plan_id:'pro',plan_source:'stripe_test',stripe_customer_id:'cus_testonly',stripe_subscription_id:'sub_testonly'});
 const response=await f.api('orgs/delete',{organization_id:org.id,confirm:'Old billing'});assert.equal(response.status,200,await response.clone().text());
});

for(const unavailable of [false,true])test(`live customer erasure fails closed with ${unavailable?'unavailable billing':'a test customer'}`,async()=>{
 const f=await fixture();let deleted=0;
 await f.store._send('UpdateCommand',{Key:{pk:'TENANT#github-1',sk:'META'},UpdateExpression:'SET stripe_customer_id = :id, stripe_mode = :mode, plan_source = :source',ExpressionAttributeValues:{':id':'cus_synthetic',':mode':'live',':source':'stripe_live'}});
 f.env.planBilling={mode:'live',stripe:{customers:{retrieve:async id=>({id,livemode:false}),del:async()=>{deleted++;}}}};
 assert.equal((await f.api('account/delete',{confirm:'DELETE'})).status,202);f.advance(601);
 if(unavailable)f.env.planBilling=null;
 await assert.rejects(eraseAccounts(f.env),unavailable?/erasure_live_billing_requires_operator_closure/:/erasure_live_billing_refused/);assert.equal(deleted,0);
 assert.equal((await f.store.getTenant('github-1')).erased_at,undefined);
});

for(const archived of [false,true])test(`rollback preserves ${archived?'archived':'current'} live bindings on account and organization deletion`,async()=>{
 const f=await fixture();f.env.planBilling={mode:'test',stripe:new Proxy({},{get(){throw Error('live call with test key');}})};
 const binding={stripe_mode:'live',plan_source:'stripe_live',stripe_customer_id:'cus_livebinding',stripe_subscription_id:'sub_livebinding'};
 const state=archived?{stripe_previous_live:binding}:binding;
 Object.assign(f.store.client.items.get('TENANT#github-1\0META'),state);
 const response=await f.api('account/delete',{confirm:'DELETE'});assert.equal(response.status,409);assert.equal((await response.json()).error,'live_billing_requires_operator_closure');
 const made=await f.api('orgs',{name:'Live binding'},'github-2'),org=await made.json();assert.equal(made.status,201);
 Object.assign(f.store.client.items.get('TENANT#'+org.id+'\0META'),state);
 assert.equal((await f.api('orgs/delete',{organization_id:org.id,confirm:'Live binding'},'github-2')).status,409);
 // A closure already queued under live credentials must also hold after rollback.
 await f.put({pk:ERASURE_QUEUE,sk:'github-1',owner:'github-1',ready_at:f.store.now(),phase:'billing',prefixes:[]});
 f.store.client.items.get('TENANT#github-1\0META').deleted_at=f.store.now();
 await assert.rejects(eraseAccounts(f.env),/erasure_live_billing_requires_operator_closure/);assert.equal((await f.store.getTenant('github-1')).erased_at,undefined);
});

test('live erasure cannot skip outstanding settlement when the optional price binding is missing',async()=>{
 const f=await fixture(),owner='github-1';let deleted=0;
 Object.assign(f.store.client.items.get('TENANT#'+owner+'\0META'),{stripe_mode:'live',plan_source:'stripe_live',stripe_customer_id:'cus_synthetic'});
 f.env.planBilling={mode:'live',stripe:{customers:{retrieve:async id=>({id,livemode:true}),del:async()=>{deleted++;}}}};
 await f.put({pk:'TENANT#'+owner,sk:'PLAN_OVERAGE#live#synthetic',stripe_mode:'live',tenant_id:owner,customer_id:'cus_synthetic',billable_spans:1,reported_spans:1,first_timestamp:f.store.now(),last_timestamp:f.store.now()});
 assert.equal((await f.api('account/delete',{confirm:'DELETE'})).status,202);f.advance(601);
 await assert.rejects(eraseAccounts(f.env),/overage_settlement_pending/);assert.equal(deleted,0);assert.equal((await f.store.getTenant(owner)).erased_at,undefined);
});
