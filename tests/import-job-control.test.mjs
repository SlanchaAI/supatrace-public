import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DynamoMetadataStore,digest} from '../src/dynamodb-store.mjs';
import {MemoryDynamo,commandClasses} from './memory-dynamo.mjs';
import {ImportJobLedger} from '../src/import-job-ledger.mjs';
import {runHostedLangfuseStage,readHostedStage} from '../src/hosted-langfuse-stage.mjs';
import {planCustomerImport} from '../src/import-planning.mjs';
import {alphaProject} from '../src/alpha-projects.mjs';
import {handle} from '../src/aws-api.mjs';
import {hash} from '../src/importers/langfuse.mjs';
const tenant='github-4242',project=alphaProject(tenant).id,token='j'.repeat(43);
const data=()=>({provider:'langfuse',origin:'https://cloud.langfuse.com',sourceProject:'synthetic-source',environment:'synthetic-production',namespace:'synthetic-hosted-job',from:'2026-10-01T00:00:00Z',to:'2026-10-02T00:00:00Z',maxRows:10,maxPages:2,pageSize:5,maxBytes:100000,maxRetries:0});
const bounds={requestTimeoutMs:1000,totalTimeoutMs:30000,maxRequests:10,maxResponseBytes:100000,maxTotalBytes:200000};
const secret='synthetic-source-secret',content='SYNTHETIC_CONTENT_REQUIRES_SEPARATE_APPROVAL';
const observation=(id,parent)=>({id,traceId:'synthetic-trace',parentObservationId:parent??null,projectId:'synthetic-source',environment:'synthetic-production',startTime:'2026-10-01T12:00:00Z',endTime:'2026-10-01T12:00:01Z',type:'SPAN',input:{text:content}});
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
async function fixture(){
  const client=new MemoryDynamo(),store=new DynamoMetadataStore({client,commands:commandClasses(),tableName:'synthetic'});await store.getOrCreateTenant(4242);await store.createSession(digest(token),tenant);
  const saved=new Map(),objects={get:async key=>{if(!saved.has(key))throw Error(secret);return saved.get(key);},putImmutable:async(key,raw)=>{saved.set(key,raw);}};
  const ledger=new ImportJobLedger(store,{objects}),env={ENABLED:true,GITHUB_CLIENT_ID:'synthetic',GITHUB_CLIENT_SECRET:'synthetic-only',APP_ORIGIN:'https://supatrace.dev',store,objects,importJobControl:{enabled:true,mode:'control-only'}};
  const root=mkdtempSync(join(tmpdir(),'hosted-import-control-')),actions=[];let wires=0,credentials=0;
  const body=data(),fingerprint=planCustomerImport(body,project).plan.fingerprint;
  const request=(path,body,options={})=>handle(new Request('https://supatrace.dev/api/imports/'+path+'?project='+(options.project??project),{method:body===undefined?'GET':'POST',headers:{...(options.signedOut?{}:{cookie:'__Host-supatrace='+token}),...(body===undefined?{}:{origin:options.origin??'https://supatrace.dev','content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);
  const authority=()=>({worker_id:'1'.repeat(64),revision:'a'.repeat(40),source_binding:'2'.repeat(64),destination_binding:'3'.repeat(64),approval_hash:'4'.repeat(64),expires_at:store.now()+120});
  const hooks={checkExistingOperation:async()=>true,authorize:async d=>{actions.push(d);return true;}}; // Test doubles only.
  const worker=(job,extra={})=>runHostedLangfuseStage({ledger,tenant,job,authority:authority(),directory:join(root,'workspace'),bounds,
    ...hooks,credentialProvider:async()=>{credentials++;return {origin:body.origin,projectId:body.sourceProject,publicKey:'synthetic-source-public',secretKey:secret,expiresAt:Date.now()+60000};},
    fetchImpl:async url=>{wires++;return json(url.endsWith('/projects')?{data:[{id:body.sourceProject}]}:{data:[observation('child','root'),observation('root')],meta:{cursor:null}});},...extra});
  return {client,store,saved,objects,ledger,env,root,body,fingerprint,request,authority,hooks,worker,actions,wires:()=>wires,credentials:()=>credentials,close(){rmSync(root,{recursive:true,force:true});}};
}
async function create(f){const r=await f.request('jobs',{plan:f.body,fingerprint:f.fingerprint});assert.equal(r.status,202);return r.json();}
async function staged(f){const job=await create(f),result=await f.worker(job.job_id);assert.equal(result.outcome,'staged');return {job,result};}

test('actual authenticated API control is default-disabled, origin/project-bound and cannot execute',async()=>{
 const f=await fixture();try{
  delete f.env.importJobControl;assert.equal((await f.request('jobs',{plan:f.body,fingerprint:f.fingerprint})).status,503);
  f.env.importJobControl={enabled:true,mode:'control-only'};
  for(const options of [{signedOut:true},{project:alphaProject('github-777').id},{origin:'https://evil.invalid'}])assert.ok([401,403].includes((await f.request('jobs',{plan:f.body,fingerprint:f.fingerprint},options)).status));
  for(const extra of [{secretKey:secret},{authority:f.authority()},{destinationProject:'other'}])assert.equal((await f.request('jobs',{plan:f.body,fingerprint:f.fingerprint,...extra})).status,400);
  const job=await create(f);assert.equal(job.status,'awaiting_bindings');assert.equal(job.execution_available,false);assert.equal(job.source_access_authorized,false);
  assert.equal((await f.request('start',{fingerprint:f.fingerprint})).status,503);assert.equal((await f.request('jobs/'+job.job_id+'/claim',{})).status,400);
  assert.equal(f.wires(),0);assert.equal(f.credentials(),0);assert.equal(f.actions.length,0);
 }finally{f.close();}
});

test('concurrent submissions and request/revision/namespace changes cannot create a second operation',async()=>{
 const f=await fixture();try{
  const responses=await Promise.all(Array.from({length:8},()=>f.ledger.create(tenant,f.body,f.fingerprint)));assert.equal(new Set(responses.map(r=>r.job_id)).size,1);
  assert.equal([...f.client.items.values()].filter(r=>r.sk.startsWith('IMPORTJOB#')).length,1);
  const body={...f.body,namespace:'changed-namespace'},fingerprint=planCustomerImport(body,project).plan.fingerprint;
  await assert.rejects(f.ledger.create(tenant,body,fingerprint),/scope_conflict/);
  assert.equal([...f.client.items.values()].find(r=>r.sk==='IMPORTJOB_CAPACITY').count,1);
 }finally{f.close();}
});

test('claim requires genuine hooks and legacy-operation check; one claimant only, never released',async()=>{
 const f=await fixture();try{
  const job=await create(f);await assert.rejects(f.ledger.claim(tenant,job.job_id,f.authority()),/authority_required/);
  await assert.rejects(f.ledger.claim(tenant,job.job_id,f.authority(),{...f.hooks,checkExistingOperation:async()=>false}),/existing_operation_unverified/);
  const claims=await Promise.allSettled([f.ledger.claim(tenant,job.job_id,f.authority(),f.hooks),f.ledger.claim(tenant,job.job_id,{...f.authority(),worker_id:'5'.repeat(64)},f.hooks)]);
  assert.equal(claims.filter(r=>r.status==='fulfilled').length,1);const receipt=claims.find(r=>r.status==='fulfilled').value.receipt;
  assert.equal(await f.ledger.verifyClaim(tenant,receipt),true);await f.ledger.stop(tenant,receipt);
  await assert.rejects(f.ledger.claim(tenant,job.job_id,f.authority(),f.hooks),/already_claimed/);assert.equal(f.credentials(),0);
 }finally{f.close();}
});

test('lost claim acknowledgment leaves consumed state and obtains no provider credential',async()=>{
 const f=await fixture();try{
  const job=await create(f),tx=f.store._tx.bind(f.store);let once=true;
  f.store._tx=async items=>{const value=await tx(items);if(once&&items.some(x=>x.Put?.Item.state==='claimed')){once=false;throw Error(secret);}return value;};
  await assert.rejects(f.worker(job.job_id),e=>e.code==='import_job_outcome_uncertain');assert.equal(f.credentials(),0);assert.equal(f.wires(),0);
  assert.equal((await f.ledger.status(tenant,job.job_id)).status,'claimed');await assert.rejects(f.worker(job.job_id),/already_claimed/);
 }finally{f.close();}
});

test('real Langfuse runtime stages content under explicit hooks; ledger/status retain only scope and counts',async()=>{
 const f=await fixture();try{
  const {job,result}=await staged(f),view=await(await f.request('jobs/'+job.job_id)).json();assert.equal(view.status,'staged');assert.equal(view.progress.rows,2);assert.equal(view.progress.pages,1);assert.equal(view.progress.staged_batches,2);
  assert.equal(result.uploaded,false);assert.equal(view.export_verified,false);assert.doesNotMatch(JSON.stringify([...f.client.items.values()]),new RegExp(secret+'|'+content));
  const checkpoint=readFileSync(join(f.root,'workspace','checkpoint.json'),'utf8');assert.match(checkpoint,new RegExp(content));
  assert.ok(f.actions.some(a=>a.action==='runtime-action'&&a.descriptor.fields?.includes('io')));
  await assert.rejects(f.worker(job.job_id),/already_claimed/);assert.equal(f.wires(),2);
 }finally{f.close();}
});

test('cancel before claim prevents all source/credential calls; foreign account cannot inspect or cancel',async()=>{
 const f=await fixture();try{
  const job=await create(f);await f.store.getOrCreateTenant(777);await assert.rejects(f.ledger.status('github-777',job.job_id),/not_found/);await assert.rejects(f.ledger.cancel('github-777',job.job_id),/not_found/);
  assert.equal((await(await f.request('jobs/'+job.job_id+'/cancel',{})).json()).status,'cancelled');await assert.rejects(f.worker(job.job_id),/already_claimed/);assert.equal(f.credentials(),0);
 }finally{f.close();}
});

test('cancellation during source action stops stage/upload without pretending to recall an in-flight read',async()=>{
 const f=await fixture();try{
  const job=await create(f),result=await f.worker(job.job_id,{authorize:async d=>{if(d.action==='runtime-action'&&d.descriptor.action==='read-observations')await f.ledger.cancel(tenant,job.job_id);return true;}});
  assert.equal(result.job.status,'cancelled');assert.equal(f.wires(),1);assert.equal(result.uploaded,false);
 }finally{f.close();}
});

test('session epoch changes fence worker mutations atomically; current owner may cancel stale work',async()=>{
 const f=await fixture();try{
  const job=await create(f),claim=await f.ledger.claim(tenant,job.job_id,f.authority(),f.hooks);
  const tx=f.store._tx.bind(f.store);let revoke=true;
  f.store._tx=async items=>{if(revoke&&items.some(x=>x.Put?.Item.pages===1)){revoke=false;await f.store.endTenantSessions(tenant);}return tx(items);};
  await assert.rejects(f.ledger.progress(tenant,claim.receipt,{pages:1,rows:1}),/changed/);assert.equal(await f.ledger.verifyClaim(tenant,claim.receipt),false);
  assert.equal((await f.ledger.cancel(tenant,job.job_id)).status,'cancellation_requested');assert.equal((await f.ledger.stop(tenant,claim.receipt)).status,'cancelled');
 }finally{f.close();}
});

test('permanent upload fence survives new ledger, changed worker and lost acknowledgment without any retry permit',async()=>{
 const f=await fixture();try{
  const {job,result}=await staged(f),tx=f.store._tx.bind(f.store);let lost=true;
  f.store._tx=async items=>{const r=await tx(items);if(lost&&items.some(x=>x.Put?.Item.state==='upload_consumed')){lost=false;throw Error(secret);}return r;};
  await assert.rejects(f.ledger.consumeUpload(tenant,result.claim,f.hooks),/outcome_uncertain/);
  const restarted=new ImportJobLedger(f.store,{objects:f.objects});assert.equal((await restarted.status(tenant,job.job_id)).status,'upload_consumed');
  await assert.rejects(restarted.consumeUpload(tenant,result.claim,f.hooks),/claim_inactive/);await assert.rejects(restarted.claim(tenant,job.job_id,{...f.authority(),revision:'b'.repeat(40)},f.hooks),/already_claimed/);
  assert.equal((await restarted.cancel(tenant,job.job_id)).status,'reconciliation_required');
 }finally{f.close();}
});

async function acceptStaged(f,job){
 const stored=await f.ledger.load(tenant,job),rows=stored.stage.batches;
 for(const b of rows){const raw=readFileSync(join(f.root,'workspace','pending',b.request_hash+'.json'),'utf8');const parsed=JSON.parse(raw);const batch=await f.store.reserveBatch(tenant,b);await f.objects.putImmutable(batch.object_key,raw,b.request_hash);await f.store.acceptReservedBatch(tenant,b.batch_id,b.request_hash,{writer:'9'.repeat(64),started_at:Date.parse(parsed.events[0].time),ended_at:Date.parse(parsed.events[0].time),has_error:false});}
 return rows;
}

test('one-batch authoritative reconciliation validates tenant records and exact object bytes, including after lost upload ACK',async()=>{
 const f=await fixture();try{
  const {job,result}=await staged(f),permit=await f.ledger.consumeUpload(tenant,result.claim,f.hooks);assert.equal(await f.ledger.verifyUpload(tenant,result.claim,permit.receipt),true);
  await assert.rejects(f.ledger.reconcileNext(tenant,job.job_id),/readback_pending/);
  await acceptStaged(f,job.job_id);
  let view=await(await f.request('jobs/'+job.job_id+'/reconcile',{})).json();assert.equal(view.progress.readback_batches,1);assert.equal(view.stored_bytes_verified,false);
  const restarted=new ImportJobLedger(f.store,{objects:f.objects});view=await restarted.reconcileNext(tenant,job.job_id);assert.equal(view.status,'readback_verified');assert.equal(view.export_verified,false);
  assert.deepEqual(await restarted.reconcileNext(tenant,job.job_id),view);assert.equal(f.saved.size,2);
 }finally{f.close();}
});

for(const tamper of ['hash','tenant','object_key','bytes'])test('reconciliation refuses tampered '+tamper+' without reading a foreign object',async()=>{
 const f=await fixture();try{
  const {job,result}=await staged(f);await f.ledger.consumeUpload(tenant,result.claim,f.hooks);await acceptStaged(f,job.job_id);
  const row=await f.ledger.load(tenant,job.job_id),first=row.stage.batches[0],stored=[...f.client.items.values()].find(x=>x.sk==='BATCH#'+first.batch_id);let reads=0;const get=f.objects.get;f.objects.get=async key=>{reads++;return get(key);};
  if(tamper==='hash')stored.request_hash='f'.repeat(64);if(tamper==='tenant')stored.tenant_id='github-777';if(tamper==='object_key')stored.object_key='foreign/object';if(tamper==='bytes')f.saved.set(stored.object_key,'corrupt');
  await assert.rejects(f.ledger.reconcileNext(tenant,job.job_id),/readback_mismatch/);assert.equal((await f.ledger.status(tenant,job.job_id)).progress.readback_batches,0);assert.equal(reads,tamper==='bytes'?1:0);
 }finally{f.close();}
});

test('expired/cancelled claims cannot release upload credentials; history and cap remain durable',async()=>{
 const f=await fixture();try{
  const {job,result}=await staged(f);const before=f.store.now;f.store.now=()=>before()+1000;
  assert.equal(await f.ledger.verifyClaim(tenant,result.claim),false);await assert.rejects(f.ledger.consumeUpload(tenant,result.claim,f.hooks),/claim_inactive/);
  f.store.now=before;const cap=[...f.client.items.values()].find(x=>x.sk==='IMPORTJOB_CAPACITY');cap.count=32;
  const next={...f.body,from:'2026-10-02T00:00:00Z',to:'2026-10-03T00:00:00Z'};await assert.rejects(f.ledger.create(tenant,next,planCustomerImport(next,project).plan.fingerprint),/capacity/);
  assert.equal((await f.ledger.status(tenant,job.job_id)).status,'staged');
 }finally{f.close();}
});

test('cancel racing the durable progress update cannot be overwritten by a stale worker snapshot',async()=>{
 const f=await fixture();try{
  const job=await create(f),claim=await f.ledger.claim(tenant,job.job_id,f.authority(),f.hooks),tx=f.store._tx.bind(f.store);let race=true;
  f.store._tx=async items=>{if(race&&items.some(x=>x.Put?.Item.pages===1)){race=false;await f.ledger.cancel(tenant,job.job_id);}return tx(items);};
  await assert.rejects(f.ledger.progress(tenant,claim.receipt,{pages:1,rows:1}),/changed/);assert.equal((await f.ledger.status(tenant,job.job_id)).status,'cancellation_requested');
  assert.equal(await f.ledger.verifyClaim(tenant,claim.receipt),false);
 }finally{f.close();}
});

test('stalled storage reads cannot advance readback and damaged records fail closed',async()=>{
 const f=await fixture();try{
  const {job,result}=await staged(f);await f.ledger.consumeUpload(tenant,result.claim,f.hooks);await acceptStaged(f,job.job_id);
  const slow=new ImportJobLedger(f.store,{objects:{get:async()=>new Promise(()=>{})},timeoutMs:10});await assert.rejects(slow.reconcileNext(tenant,job.job_id),/outcome_uncertain/);
  assert.equal((await f.ledger.status(tenant,job.job_id)).progress.readback_batches,0);
  const row=[...f.client.items.values()].find(x=>x.job_id===job.job_id);row.verified_batches=999;
  await assert.rejects(f.ledger.status(tenant,job.job_id),/record_invalid/);
 }finally{f.close();}
});

test('oversized scope/body and denied worker authorization cannot allocate or execute',async()=>{
 const f=await fixture();try{
  const oversized={...f.body,maxRows:101},fp=planCustomerImport(oversized,project).plan.fingerprint;
  assert.equal((await f.request('jobs',{plan:oversized,fingerprint:fp})).status,400);
  assert.equal((await f.request('jobs',{plan:{...f.body,unknown:'x'.repeat(9000)},fingerprint:f.fingerprint})).status,413);
  const job=await create(f);await assert.rejects(f.worker(job.job_id,{authorize:async()=>false}),/not_authorized/);assert.equal(f.credentials(),0);assert.equal((await f.ledger.status(tenant,job.job_id)).status,'awaiting_bindings');
 }finally{f.close();}
});

test('equivalent UTC spelling cannot mint another operation or permit; fractional precision remains distinct',async()=>{
 const f=await fixture();try{
  const job=await create(f),alias={...f.body,from:'2026-10-01T00:00:00.000Z',to:'2026-10-02T00:00:00+00:00'};
  await assert.rejects(f.ledger.create(tenant,alias,planCustomerImport(alias,project).plan.fingerprint),/scope_conflict/);
  const nanos={...f.body,from:'2026-10-01T00:00:00.000000001Z'},other=await f.ledger.create(tenant,nanos,planCustomerImport(nanos,project).plan.fingerprint);assert.notEqual(other.job_id,job.job_id);
  const sameNanos={...nanos,from:'2026-10-01T01:00:00.0000000010+01:00'};
  await assert.rejects(f.ledger.create(tenant,sameNanos,planCustomerImport(sameNanos,project).plan.fingerprint),/scope_conflict/);
 }finally{f.close();}
});

test('session revoked after generic authentication cannot allocate a job at the newer epoch',async()=>{
 const f=await fixture();try{
  const get=f.store.getSession.bind(f.store);let revoke=true;
  f.store.getSession=async tokenHash=>{const r=await get(tokenHash);if(revoke&&r){revoke=false;await f.store.endTenantSessions(tenant);}return r;};
  const r=await f.request('jobs',{plan:f.body,fingerprint:f.fingerprint});assert.ok([401,409].includes(r.status));
  assert.equal([...f.client.items.values()].filter(x=>x.sk.startsWith('IMPORTJOB#')).length,0);
 }finally{f.close();}
});

test('revocation or session deletion inside allocation transaction prevents stale browser job writes',async()=>{
 for(const revoke of ['epoch','delete']){
  const f=await fixture();try{
   const tx=f.store._tx.bind(f.store);let once=true;
   f.store._tx=async items=>{if(once&&items.some(x=>x.Put?.Item.state==='awaiting_bindings')){once=false;if(revoke==='epoch')await f.store.endTenantSessions(tenant);else await f.store.deleteSession(digest(token));}return tx(items);};
   const r=await f.request('jobs',{plan:f.body,fingerprint:f.fingerprint});assert.equal(r.status,409);
   assert.equal([...f.client.items.values()].filter(x=>x.sk.startsWith('IMPORTJOB#')).length,0);
  }finally{f.close();}
 }
});

test('stage proof count, hash and destination are checked before any ledger commit',async()=>{
 const f=await fixture();try{
  const {job}=await staged(f),stored=await f.ledger.load(tenant,job.job_id),receipt=JSON.parse(readFileSync(join(f.root,'workspace','stage-receipt.json'),'utf8')),proof=readHostedStage(join(f.root,'workspace'),receipt);
  // A separate operation has its own clean claim and cannot adopt another destination/scope.
  const body={...f.body,from:'2026-10-02T00:00:00Z',to:'2026-10-03T00:00:00Z'},fp=planCustomerImport(body,project).plan.fingerprint;
  const other=await f.ledger.create(tenant,body,fp),claim=await f.ledger.claim(tenant,other.job_id,f.authority(),f.hooks);
  await assert.rejects(f.ledger.staged(tenant,claim.receipt,proof),/stage_invalid/);
  const over=structuredClone(proof);over.receipt.fingerprint=fp;over.manifest.count=101;over.receipt.manifestHash=hash(over.manifest);
  await assert.rejects(f.ledger.staged(tenant,claim.receipt,over),/stage_invalid/);
  assert.equal((await f.ledger.status(tenant,other.job_id)).status,'claimed');assert.equal(stored.stage.batches.length,2);
 }finally{f.close();}
});

test('global-fetch TLS guard is rechecked after asynchronous claim reads at the wire boundary',async()=>{
 const f=await fixture(),originalFetch=globalThis.fetch,originalTLS=process.env.NODE_TLS_REJECT_UNAUTHORIZED;
 let wire=0,leaseReturned=false,checksAfterLease=0;
 try{
  const job=await create(f),active=f.ledger.active.bind(f.ledger);
  // Local mock only: no external request runs with this negative configuration fixture.
  globalThis.fetch=async()=>{wire++;return json({data:[{id:f.body.sourceProject}]});};
  process.env.NODE_TLS_REJECT_UNAUTHORIZED='1';
  f.ledger.active=async(...args)=>{const row=await active(...args);if(leaseReturned&&++checksAfterLease===2)process.env.NODE_TLS_REJECT_UNAUTHORIZED='0';return row;};
  const result=await f.worker(job.job_id,{fetchImpl:globalThis.fetch,credentialProvider:async()=>{leaseReturned=true;return {origin:f.body.origin,projectId:f.body.sourceProject,publicKey:'synthetic-public',secretKey:secret,expiresAt:Date.now()+60000};}});
  assert.equal(result.outcome,'stopped-reconciliation-required');assert.equal(wire,0);assert.equal(result.uploaded,false);
 }finally{
  globalThis.fetch=originalFetch;
  if(originalTLS===undefined)delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;else process.env.NODE_TLS_REJECT_UNAUTHORIZED=originalTLS;
  f.close();
 }
});

test('repeated cancel cannot settle a live claimed worker; only claim expiry or worker stop settles it',async()=>{
 const f=await fixture();try{
  const job=await create(f),claim=await f.ledger.claim(tenant,job.job_id,f.authority(),f.hooks);
  assert.equal((await f.ledger.cancel(tenant,job.job_id)).status,'cancellation_requested');
  const again=await f.ledger.cancel(tenant,job.job_id);assert.equal(again.status,'cancellation_requested');assert.equal(again.version,(await f.ledger.status(tenant,job.job_id)).version);
  const before=f.store.now;f.store.now=()=>before()+1000;
  assert.equal((await f.ledger.cancel(tenant,job.job_id)).status,'cancelled');assert.equal((await f.ledger.stop(tenant,claim.receipt)).status,'cancelled');
 }finally{f.close();}
});

test('a failing read after the durable stage commit cannot downgrade the staged job',async()=>{
 const f=await fixture();try{
  const job=await create(f);f.ledger.status=async()=>{throw Error('synthetic_status_unavailable');};
  const result=await f.worker(job.job_id);assert.equal(result.outcome,'staged');assert.equal(result.job.status,'staged');
  assert.equal((await f.ledger.load(tenant,job.job_id)).state,'staged');
 }finally{f.close();}
});
