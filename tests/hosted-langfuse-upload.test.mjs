import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,readFileSync,readdirSync,writeFileSync,chmodSync,mkdirSync,renameSync,symlinkSync,linkSync,truncateSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {DynamoMetadataStore,digest} from '../src/dynamodb-store.mjs';
import {MemoryDynamo,commandClasses} from './memory-dynamo.mjs';
import {ImportJobLedger} from '../src/import-job-ledger.mjs';
import {runHostedLangfuseStage} from '../src/hosted-langfuse-stage.mjs';
import {verifyHostedImportSavedExport} from '../src/hosted-import-export.mjs';
// The saved-export reader refuses a file that group or others can write. The files these tests save must not inherit
// such bits from the machine: a umask of 0002 (the default for a user with a private group) would make them 0664 (#155).
process.umask(0o022);
import {runHostedLangfuseUpload} from '../src/hosted-langfuse-upload.mjs';
import {planCustomerImport} from '../src/import-planning.mjs';
import {alphaProject} from '../src/alpha-projects.mjs';
import {handle} from '../src/aws-api.mjs';
import {prepareAccountArchive} from '../public/app/account-export.js';

const tenant='github-4242',project=alphaProject(tenant).id,origin='https://supatrace.dev';
const python=execFileSync('python3',['-c','import sys; print(sys.executable)'],{encoding:'utf8'}).trim();
// Staging here is setup, not the subject: its per-request bound is generous so a loaded machine cannot stop it.
// With a one-second bound, 3 of 20 runs under heavy load ended 'stopped-reconciliation-required' before any test ran.
async function fixture({count=2,input='synthetic-content',destinationKey}={}){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'hosted-upload-')),directory=join(root,'workspace'),client=new MemoryDynamo(),store=new DynamoMetadataStore({client,commands:commandClasses(),tableName:'synthetic'}),token=randomBytes(32).toString('base64url'),key=destinationKey??randomBytes(32).toString('base64url'),saved=new Map();
 await store.getOrCreateTenant(4242);await store.createSession(digest(token),tenant);const setup=await store.createSetup(digest(key),project);await store.approveSetup(tenant,setup.user_code);
 const parentSession=await store.getImportSessionStamp(digest(token)),objects={putImmutable:async(k,v)=>{saved.set(k,v);},get:async k=>saved.get(k)},ledger=new ImportJobLedger(store,{objects,parentSession});
 const env={ENABLED:true,APP_ORIGIN:origin,GITHUB_CLIENT_ID:'synthetic',GITHUB_CLIENT_SECRET:'synthetic-only',store,objects};
 const spec={provider:'langfuse',origin:'https://cloud.langfuse.com',sourceProject:'synthetic-source',environment:'production',namespace:'synthetic-controller',from:'2026-10-01T00:00:00Z',to:'2026-10-02T00:00:00Z',maxRows:10,maxPages:2,pageSize:5,maxBytes:100000,maxRetries:0},plan=planCustomerImport(spec,project).plan;
 const job=await ledger.create(tenant,spec,plan.fingerprint),rows=Array.from({length:count},(_,i)=>({id:i?'child':'root',traceId:'synthetic-trace',parentObservationId:i?'root':null,projectId:spec.sourceProject,environment:'production',startTime:'2026-10-01T12:00:00Z',type:'SPAN',input}));
 const authority={worker_id:'1'.repeat(64),revision:'a'.repeat(40),source_binding:'2'.repeat(64),destination_binding:'3'.repeat(64),approval_hash:'4'.repeat(64),expires_at:store.now()+120};
 const staged=await runHostedLangfuseStage({ledger,tenant,job:job.job_id,authority,directory,checkExistingOperation:async()=>true,authorize:async()=>true,credentialProvider:async()=>({origin:spec.origin,projectId:spec.sourceProject,publicKey:'synthetic-source-public',secretKey:'synthetic-source-secret',expiresAt:Date.now()+60000}),fetchImpl:async url=>new Response(JSON.stringify(url.endsWith('/projects')?{data:[{id:spec.sourceProject}]}:{data:rows,meta:{cursor:null}}),{headers:{'content-type':'application/json'}}),bounds:{requestTimeoutMs:10000,totalTimeoutMs:30000,maxRequests:10,maxResponseBytes:100000,maxTotalBytes:200000}});
 assert.equal(staged.outcome,'staged');let wires=0,leases=0;const actions=[];
 const options={ledger,tenant,claim:staged.claim,directory,destinationOrigin:origin,pythonExecutable:python,requestTimeoutMs:1000,authorize:async d=>{actions.push(d);return true;},credentialProvider:async()=>{leases++;return{origin,project_id:project,write_key:key,expires_at:Math.floor(Date.now()/1000)+60};},fetchImpl:async(url,init)=>{wires++;assert.equal(init.redirect,'error');assert.equal(init.headers['x-supatrace-key'],key);const r=await handle(new Request(url,init),env);Object.defineProperty(r,'url',{value:url});return r;}};
 return{root,directory,store,client,ledger,env,job,claim:staged.claim,token,key,saved,rows,options,actions,wires:()=>wires,leases:()=>leases,close:()=>rmSync(root,{recursive:true,force:true})};
}

test('actual retained Python uploader crosses the guarded controller into storage, readback and original export',async()=>{
 const f=await fixture();try{
  const result=await runHostedLangfuseUpload(f.options);assert.equal(result.outcome,'all-uploader-acknowledgments-verified');assert.equal(result.acknowledged_batches,2);assert.equal(result.stored_bytes_verified,false);assert.equal(result.export_verified,false);assert.equal(f.wires(),2);assert.equal(f.leases(),2);assert.equal(f.saved.size,2);
  assert.equal(f.actions.filter(a=>a.action==='upload-approved-batch-wire').length,2);
  let view;for(let i=0;i<2;i++)view=await f.ledger.reconcileNext(tenant,f.job.job_id);assert.equal(view.stored_bytes_verified,true);
  const order=rows=>rows.toSorted((a,b)=>a.id.localeCompare(b.id));
  const stored=[...f.saved.values()].map(x=>JSON.parse(x).events[0].data.observation);assert.deepEqual(order(stored),order(f.rows));
  const get=async path=>{const r=await handle(new Request(origin+'/api/'+path,{headers:{cookie:'__Host-supatrace='+f.token}}),f.env);assert.equal(r.status,200);return r.json();};
  const archive=await prepareAccountArchive({projectId:project,loadCatalog:async()=>(await get('runs')).runs,writeRun:async(id,signal,sink)=>{let after=null,events=0,batches=0;do{const page=await get('events?run='+id+(after?'&after='+encodeURIComponent(after):''));await sink(page.events);events+=page.events.length;batches+=page.events.length?1:0;after=page.next;}while(after);return{events,batches};}});
  const file=join(f.root,'saved-export.json');writeFileSync(file,Buffer.from(await archive.blob.arrayBuffer()));const exported=JSON.parse(readFileSync(file));assert.equal(exported.event_count,2);assert.deepEqual(order(exported.runs.flatMap(r=>r.events.map(e=>e.data.observation))),order(f.rows));
  exported.runs[0].events.reverse();writeFileSync(file,JSON.stringify(exported));
  const verified=await verifyHostedImportSavedExport({ledger:f.ledger,tenant,job:f.job.job_id,exportPath:file,authorize:async()=>true});assert.equal(verified.export_verified,true);assert.equal(verified.matched_events,2);assert.equal(verified.matched_runs,1);assert.equal(verified.unrelated_events,0);assert.equal(verified.ledger_updated,false);assert.equal((await f.ledger.status(tenant,f.job.job_id)).export_verified,false);
  const pending=readdirSync(join(f.directory,'pending')).filter(x=>/^[a-f0-9]{64}\.json$/.test(x));assert.equal(pending.length,0);
  const journal=readFileSync(join(f.directory,'upload-receipts.json'),'utf8');assert.ok(!journal.includes(f.key));assert.ok(!JSON.stringify(result).includes(f.key));
 }finally{f.close();}
});

test('lost ACK keeps uncertainty and forbids restart; server storage can be reconciled without replay',async()=>{
 const f=await fixture({count:1});try{const send=f.options.fetchImpl;f.options.fetchImpl=async(...args)=>{await send(...args);throw Error(f.key);};const result=await runHostedLangfuseUpload(f.options);assert.equal(result.outcome,'reconciliation-required');assert.equal(result.all_batches_acknowledged,false);assert.equal(f.wires(),1);assert.equal(f.saved.size,1);assert.ok(!JSON.stringify(result).includes(f.key));await assert.rejects(runHostedLangfuseUpload(f.options),/claim_inactive/);assert.equal(f.wires(),1);assert.equal((await f.ledger.reconcileNext(tenant,f.job.job_id)).stored_bytes_verified,true);
 }finally{f.close();}
});

for(const change of ['cancel','epoch','session'])test(change+' change during lease retrieval stops before the wire',async()=>{
 const f=await fixture({count:1});try{const lease=f.options.credentialProvider;f.options.credentialProvider=async(...args)=>{if(change==='cancel')await f.ledger.cancel(tenant,f.job.job_id);if(change==='epoch')await f.store.endTenantSessions(tenant);if(change==='session')await f.store.deleteSession(digest(f.token));return lease(...args);};const result=await runHostedLangfuseUpload(f.options);assert.equal(result.all_batches_acknowledged,false);assert.equal(result.transport_requests_attempted,0);assert.equal(f.wires(),0);assert.equal(f.saved.size,0);
 }finally{f.close();}
});

test('lost durable-consumption acknowledgment never starts the child or retrieves a key',async()=>{
 const f=await fixture({count:1});try{const tx=f.store._tx.bind(f.store);f.store._tx=async items=>{const value=await tx(items);if(items.some(x=>x.Put?.Item.state==='upload_consumed'))throw Error(f.key);return value;};await assert.rejects(runHostedLangfuseUpload(f.options),/consumption_unverified/);assert.equal(f.leases(),0);assert.equal(f.wires(),0);assert.equal((await f.ledger.status(tenant,f.job.job_id)).status,'upload_consumed');await assert.rejects(runHostedLangfuseUpload(f.options),/claim_inactive/);
 }finally{f.close();}
});

for(const kind of ['duplicate','oversized','echo','wrong-project'])test('unsafe '+kind+' acknowledgment is never a completed import',async()=>{
 const f=await fixture({count:1});try{const send=f.options.fetchImpl;f.options.fetchImpl=async(...args)=>{const r=await send(...args),ack=await r.json();let body=JSON.stringify(ack);if(kind==='duplicate')body=body.replace('"accepted":true','"accepted":false,"accepted":true');if(kind==='oversized')body=' '.repeat(8193)+body;if(kind==='echo')body=body.replace('true','true,"private":"'+f.key+'"');if(kind==='wrong-project')body=body.replace(project,alphaProject('github-777').id);const response=new Response(body,{status:201});Object.defineProperty(response,'url',{value:args[0]});return response;};const result=await runHostedLangfuseUpload(f.options);assert.equal(result.all_batches_acknowledged,false);assert.equal(result.acknowledged_batches,0);assert.equal(f.wires(),1);assert.ok(!JSON.stringify(result).includes(f.key));assert.equal(f.saved.size,1);
 }finally{f.close();}
});

test('destination credential embedded in source content never reaches the wire',async()=>{
 const secret='d'.repeat(43),f=await fixture({count:1,input:secret,destinationKey:secret});try{const result=await runHostedLangfuseUpload(f.options);assert.equal(result.all_batches_acknowledged,false);assert.equal(f.wires(),0);assert.equal(f.leases(),1);assert.ok(!JSON.stringify(result).includes(secret));}finally{f.close();}
});

for(const bad of ['origin','environment','body'])test('invalid '+bad+' scope fails before durable consumption',async()=>{
 const f=await fixture({count:1});try{if(bad==='origin')f.options.destinationOrigin='https://evil.invalid';if(bad==='environment')f.options.environment_id='development';if(bad==='body'){const file=readdirSync(join(f.directory,'pending')).find(x=>/^[a-f0-9]{64}\.json$/.test(x));writeFileSync(join(f.directory,'pending',file),'{}');}await assert.rejects(runHostedLangfuseUpload(f.options),/dependencies_required|stage_unavailable/);assert.equal((await f.ledger.status(tenant,f.job.job_id)).status,'staged');assert.equal(f.leases(),0);assert.equal(f.wires(),0);}finally{f.close();}
});

test('a post ignoring AbortSignal still yields a bounded uncertain controller result without replay',async()=>{
 const f=await fixture({count:1});try{f.options.requestTimeoutMs=30;let calls=0;f.options.fetchImpl=async()=>{calls++;return new Promise(()=>{});};const start=Date.now(),result=await runHostedLangfuseUpload(f.options);assert.equal(result.all_batches_acknowledged,false);assert.equal(calls,1);assert.ok(Date.now()-start<3000);await assert.rejects(runHostedLangfuseUpload(f.options),/claim_inactive/);}finally{f.close();}
});

for(const mode of ['bad-sequence','oversized-frame','crash'])test('private child '+mode+' stops without credentials or a second process permit',async()=>{
 const f=await fixture({count:1});try{const path=join(f.root,'fake-python'),code=mode==='bad-sequence'?"print(json.dumps({'id':2,'type':'lease','binding':{}},sort_keys=True,separators=(',',':')),flush=True)":mode==='oversized-frame'?"print('x'*750001,flush=True)":"os._exit(77)";writeFileSync(path,'#!'+python+'\nimport sys,json,os\nsys.stdin.readline()\n'+code+'\n');chmodSync(path,0o700);f.options.pythonExecutable=path;const result=await runHostedLangfuseUpload(f.options);assert.equal(result.all_batches_acknowledged,false);assert.equal(f.leases(),0);assert.equal(f.wires(),0);await assert.rejects(runHostedLangfuseUpload(f.options),/claim_inactive/);}finally{f.close();}
});

for(const kind of ['origin','project','expired','long-lived'])test('invalid '+kind+' destination lease stops before transport',async()=>{
 const f=await fixture({count:1});try{const original=f.options.credentialProvider;f.options.credentialProvider=async(...a)=>{const lease=await original(...a);if(kind==='origin')lease.origin='https://supatrace.tech';if(kind==='project')lease.project_id=alphaProject('github-777').id;if(kind==='expired')lease.expires_at=0;if(kind==='long-lived')lease.expires_at=Date.now()/1000+86400;return lease;};const result=await runHostedLangfuseUpload(f.options);assert.equal(result.all_batches_acknowledged,false);assert.equal(f.wires(),0);}finally{f.close();}
});

test('denied per-batch authorization never obtains a destination credential',async()=>{
 const f=await fixture({count:1});try{f.options.authorize=async d=>d.action!=='upload-approved-batch';const result=await runHostedLangfuseUpload(f.options);assert.equal(result.all_batches_acknowledged,false);assert.equal(f.wires(),0);assert.equal(f.leases(),0);}finally{f.close();}
});

test('journal failure after a matching ACK never claims completed cleanup or permits replay',async()=>{
 const f=await fixture({count:1});try{const send=f.options.fetchImpl;f.options.fetchImpl=async(...a)=>{const response=await send(...a);renameSync(join(f.directory,'upload-receipts.json'),join(f.directory,'receipt-before-failure.json'));mkdirSync(join(f.directory,'upload-receipts.json'),{mode:0o700});return response;};const result=await runHostedLangfuseUpload(f.options);assert.equal(result.all_batches_acknowledged,false);assert.equal(result.acknowledged_batches,1);assert.equal(f.saved.size,1);await assert.rejects(runHostedLangfuseUpload(f.options),/claim_inactive/);assert.equal(f.wires(),1);assert.equal((await f.ledger.reconcileNext(tenant,f.job.job_id)).stored_bytes_verified,true);}finally{f.close();}
});

test('TLS validation is checked again after the final credential hook',async()=>{
 const f=await fixture({count:1}),before=globalThis.fetch,setting=process.env.NODE_TLS_REJECT_UNAUTHORIZED;try{globalThis.fetch=f.options.fetchImpl;f.options.fetchImpl=globalThis.fetch;const lease=f.options.credentialProvider;f.options.credentialProvider=async(...a)=>{const value=await lease(...a);process.env.NODE_TLS_REJECT_UNAUTHORIZED='0';return value;};const result=await runHostedLangfuseUpload(f.options);assert.equal(result.all_batches_acknowledged,false);assert.equal(f.wires(),0);}finally{globalThis.fetch=before;if(setting===undefined)delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;else process.env.NODE_TLS_REJECT_UNAUTHORIZED=setting;f.close();}
});

test('child closure aborts an active wire before the controller returns',async()=>{
 const f=await fixture({count:1});try{let signal;f.options.requestTimeoutMs=3000;f.options.fetchImpl=async(url,init)=>{signal=init.signal;const {pid}=JSON.parse(readFileSync(join(f.directory,'.live-import.lock'),'utf8'));process.kill(pid,'SIGTERM');return new Promise(()=>{});};const result=await runHostedLangfuseUpload(f.options);assert.equal(result.all_batches_acknowledged,false);assert.equal(signal.aborted,true);}finally{f.close();}
});

test('child closure prevents a late authorization from retrieving a credential',async()=>{
 const f=await fixture({count:1});try{f.ledger.stop=async()=>{throw Error('synthetic-store-unavailable');};f.options.authorize=async d=>{if(d.action==='upload-approved-batch-wire'){const{pid}=JSON.parse(readFileSync(join(f.directory,'.live-import.lock'),'utf8'));process.kill(pid,'SIGTERM');await new Promise(r=>setTimeout(r,50));}return true;};const result=await runHostedLangfuseUpload(f.options);assert.equal(result.all_batches_acknowledged,false);await new Promise(r=>setTimeout(r,150));assert.equal(f.leases(),0);assert.equal(f.wires(),0);}finally{f.close();}
});

test('a consumed operation cannot launch another uploader or release another lease',async()=>{
 const f=await fixture({count:1});try{
  assert.equal((await runHostedLangfuseUpload(f.options)).all_batches_acknowledged,true);
  await assert.rejects(runHostedLangfuseUpload(f.options),/claim_inactive/);assert.equal(f.wires(),1);assert.equal(f.leases(),1);
 }finally{f.close();}
});

async function savedFixture(){
 const f=await fixture({count:1});await runHostedLangfuseUpload(f.options);await f.ledger.reconcileNext(tenant,f.job.job_id);
 const batch=JSON.parse([...f.saved.values()][0]),file=join(f.root,'saved-export.json'),archive={version:2,type:'supatrace_account_observed_export',project_id:project,started_at:'2026-11-06T00:00:00Z',consistency:'observed_stable_before_after_not_a_snapshot',runs:[{metadata:{id:batch.run_id,event_count:1,batch_count:1},events:batch.events}],completed_at:'2026-11-06T00:01:00Z',run_count:1,event_count:1,complete:true};
 const save=()=>writeFileSync(file,JSON.stringify(archive));save();
 return {...f,file,archive,save,verify:()=>verifyHostedImportSavedExport({ledger:f.ledger,tenant,job:f.job.job_id,exportPath:file,authorize:async()=>true})};
}
test('saved-export completion refuses altered observations, parents, event identity, project and counts',async()=>{
 const f=await savedFixture();try{
  const original=structuredClone(f.archive);
  for(const change of [a=>a.runs[0].events[0].data.observation.parentObservationId='wrong',a=>a.runs[0].events[0].data.observation.input='changed',a=>a.runs[0].events[0].time='2026-10-01T12:00:01Z',a=>a.runs[0].events[0].id='other',a=>a.project_id=alphaProject('github-777').id,a=>a.environment_id='development',a=>a.complete=false,a=>a.event_count++,a=>a.run_count++,a=>a.runs[0].metadata.id='wrong',a=>a.runs.push(structuredClone(a.runs[0])),a=>{a.runs[0].events.push(structuredClone(a.runs[0].events[0]));a.runs[0].metadata.event_count++;a.event_count++;},a=>a.runs=[]]){
   const value=structuredClone(original);change(value);writeFileSync(f.file,JSON.stringify(value));await assert.rejects(f.verify(),/import_export_/);
  }
  assert.equal(f.wires(),1);assert.equal(f.leases(),1);assert.equal((await f.ledger.status(tenant,f.job.job_id)).status,'readback_verified');
 }finally{f.close();}
});
test('saved-export matching tolerates event/run order and explicitly counts unrelated account events',async()=>{
 const f=await savedFixture();try{const other=structuredClone(f.archive.runs[0]);other.metadata.id='unrelated';other.events.push(structuredClone(other.events[0]));other.metadata.event_count=2;other.metadata.batch_count=2;f.archive.runs.unshift(other);f.archive.run_count++;f.archive.event_count+=2;f.save();const result=await f.verify();assert.equal(result.export_verified,true);assert.equal(result.unrelated_events,2);assert.equal(result.source_completeness_verified,false);assert.equal(result.native_span_semantics_verified,false);assert.ok(!JSON.stringify(result).includes('synthetic-content'));}finally{f.close();}
});
test('original physical session and epoch remain mandatory across asynchronous export authorization and storage reads',async()=>{
 for(const mode of ['deny','session','epoch','read-session','stored-change','store-failure']){
  const f=await savedFixture();try{
   const args={ledger:f.ledger,tenant,job:f.job.job_id,exportPath:f.file,authorize:async()=>{if(mode==='session')await f.store.deleteSession(digest(f.token));if(mode==='epoch')await f.store.endTenantSessions(tenant);return mode!=='deny';}};
   const get=f.ledger.objects.get;f.ledger.objects.get=async k=>{if(mode==='read-session')await f.store.deleteSession(digest(f.token));if(mode==='stored-change')return '{}';if(mode==='store-failure')throw Error('synthetic-store-failure');return get(k);};
   await assert.rejects(verifyHostedImportSavedExport(args));assert.equal(f.wires(),1);assert.equal(f.leases(),1);
  }finally{f.close();}
 }
});
test('readback is required; a staged job never becomes complete from a supplied archive',async()=>{
 const f=await fixture({count:1});try{await assert.rejects(verifyHostedImportSavedExport({ledger:f.ledger,tenant,job:f.job.job_id,exportPath:join(f.root,'absent'),authorize:async()=>{throw Error('must-not-authorize');}}),/readback_required/);assert.equal(f.wires(),0);}finally{f.close();}
});
test('saved-file verification rejects truncation, invalid UTF8, nesting, unsafe numbers and duplicate escaped keys',async()=>{
 const f=await savedFixture();try{
  const good=JSON.stringify(f.archive);
  for(const raw of [good.slice(0,-1),Buffer.from([0xff]),good.replace('"version":2','"version":1,"version":2'),good.replace('"version":2','"version":1,"vers\\u0069on":2'),good.replace('"version":2','"version":9007199254740993'),good.replace('"version":2','"version":'+ '['.repeat(42)+'0'+']'.repeat(42))]){writeFileSync(f.file,raw);await assert.rejects(f.verify(),/import_export_/);}
 }finally{f.close();}
});
test('saved-file verification refuses symlinks, hardlinks, writeable files, directories and oversized files',async()=>{
 const f=await savedFixture();try{
  const good=JSON.stringify(f.archive),replace=()=>{rmSync(f.file,{recursive:true,force:true});writeFileSync(f.file,good);};
  symlinkSync(f.root,join(f.root,'alias'));await assert.rejects(verifyHostedImportSavedExport({ledger:f.ledger,tenant,job:f.job.job_id,exportPath:join(f.root,'alias','saved-export.json'),authorize:async()=>true}),/file_/);
  renameSync(f.file,f.file+'.target');symlinkSync(f.file+'.target',f.file);await assert.rejects(f.verify(),/file_/);replace();
  linkSync(f.file,f.file+'.link');await assert.rejects(f.verify(),/file_/);rmSync(f.file+'.link');
  chmodSync(f.file,0o666);await assert.rejects(f.verify(),/file_/);replace();
  rmSync(f.file);mkdirSync(f.file);await assert.rejects(f.verify(),/file_/);replace();
  truncateSync(f.file,20*1024*1024+1);await assert.rejects(f.verify(),/file_/);
 }finally{f.close();}
});

test('an explicit archive changed during storage verification is not a completion receipt',async()=>{
 const f=await savedFixture();try{const get=f.ledger.objects.get;f.ledger.objects.get=async k=>{writeFileSync(f.file,'{}');return get(k);};await assert.rejects(f.verify(),/file_changed/);}finally{f.close();}
});
test('a lost upload acknowledgment can finish export verification after independent storage readback without replay',async()=>{
 const f=await fixture({count:1});try{const send=f.options.fetchImpl;f.options.fetchImpl=async(...a)=>{await send(...a);throw Error('synthetic-lost-ack');};assert.equal((await runHostedLangfuseUpload(f.options)).all_batches_acknowledged,false);await f.ledger.reconcileNext(tenant,f.job.job_id);
 const batch=JSON.parse([...f.saved.values()][0]),file=join(f.root,'recovered-export.json');writeFileSync(file,JSON.stringify({version:2,type:'supatrace_account_observed_export',project_id:project,started_at:'2026-11-06T00:00:00Z',consistency:'observed_stable_before_after_not_a_snapshot',runs:[{metadata:{id:batch.run_id,event_count:1,batch_count:1},events:batch.events}],completed_at:'2026-11-06T00:01:00Z',run_count:1,event_count:1,complete:true}));
 assert.equal((await verifyHostedImportSavedExport({ledger:f.ledger,tenant,job:f.job.job_id,exportPath:file,authorize:async()=>true})).export_verified,true);assert.equal(f.wires(),1);assert.equal(f.leases(),1);
 }finally{f.close();}
});
test('verification denies foreign accounts and missing physical sessions before storage or file reads',async()=>{
 const f=await savedFixture();try{for(const actor of ['github-777',null]){const parent=f.ledger.parentSession;if(actor===null)f.ledger.parentSession=null;await assert.rejects(verifyHostedImportSavedExport({ledger:f.ledger,tenant:actor??tenant,job:f.job.job_id,exportPath:f.file,authorize:async()=>{throw Error('must-not-authorize');}}),/session_required/);f.ledger.parentSession=parent;}}finally{f.close();}
});
test('authorization and storage failures are bounded and do not echo dependency secrets',async()=>{
 const f=await savedFixture();try{
  const args={ledger:f.ledger,tenant,job:f.job.job_id,exportPath:f.file,authorize:async()=>{throw Error(f.key);}};await assert.rejects(verifyHostedImportSavedExport(args),e=>e.code==='import_export_unavailable'&&!e.message.includes(f.key));
  args.authorize=()=>new Promise(()=>{});const start=Date.now();await assert.rejects(verifyHostedImportSavedExport(args),/deadline/);assert.ok(Date.now()-start<3000);
  assert.equal(f.wires(),1);assert.equal(f.leases(),1);
 }finally{f.close();}
});

test('wide below-byte-limit JSON is rejected by the node budget without an eager child queue',async()=>{
 const f=await savedFixture();try{writeFileSync(f.file,'{"wide":['+'0,'.repeat(1000001)+'0]}');await assert.rejects(f.verify(),/structure_bound/);}finally{f.close();}
});
