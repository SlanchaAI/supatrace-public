import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,lstatSync,rmSync,readFileSync,existsSync,writeFileSync,chmodSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {MemoryDynamo,commandClasses} from './memory-dynamo.mjs';
import {DynamoMetadataStore,digest} from '../src/dynamodb-store.mjs';
import {ImportJobLedger} from '../src/import-job-ledger.mjs';
import {verifyHostedImportSavedExport} from '../src/hosted-import-export.mjs';
import {createPrivateImportHost} from '../src/private-import-host.mjs';
import {dispatchKey,LANGFUSE_HOST_FIELDS} from '../src/private-import-dispatch.mjs';
import {hash} from '../src/trace.mjs';
import {planCustomerImport} from '../src/import-planning.mjs';
import {alphaProject} from '../src/alpha-projects.mjs';
import {handle} from '../src/aws-api.mjs';
const tenant='github-4242',project=alphaProject(tenant).id;
import {privateHostFixture} from './private-host-fixture.mjs';

test('one protected dispatch runs actual Node/Python/API/readback into an import-only saved export and cannot replay',async()=>{
 const f=await privateHostFixture();try{const host=createPrivateImportHost(f.options),job=await host.submit(f.submit),record=await f.store._get(dispatchKey(tenant,job.job_id));assert.deepEqual(record.binding.parent_session,f.parentSession);assert.equal(record.binding.source.fields,LANGFUSE_HOST_FIELDS);assert.ok(!JSON.stringify(record).includes(f.token));assert.ok(!JSON.stringify(record).includes(f.key));
 const result=await host.runOne(tenant,job.job_id);assert.equal(result.receipt.export_verified,true);assert.equal(result.receipt.matched_events,1);assert.equal(result.receipt.unrelated_events,0);assert.equal(result.receipt.consistency,'verified_import_batches_not_an_account_snapshot');
 const file=JSON.parse(readFileSync(result.exportPath));assert.equal(file.type,'supatrace_import_observed_export');assert.deepEqual(file.runs[0].events[0].data.observation,f.sourceRows[0]);assert.equal(file.job_id,job.job_id);assert.equal((await host.status(tenant,job.job_id)).dispatch.state,'complete');assert.equal(existsSync(join(f.directory,'.private-host.lock')),false);
 assert.deepEqual(f.counts(),{sourceRequests:2,destinationRequests:1,leases:1});await assert.rejects(createPrivateImportHost(f.options).runOne(tenant,job.job_id),/no_replay/);assert.deepEqual(f.counts(),{sourceRequests:2,destinationRequests:1,leases:1});
 }finally{f.close();}
});

test('job and protected dispatch are one transaction; new physical session cannot rebind an existing job',async()=>{
 const f=await privateHostFixture();try{const host=createPrivateImportHost(f.options),job=await host.submit(f.submit),row=await f.store._get(dispatchKey(tenant,job.job_id));assert.equal(row.state,'queued');const token=randomBytes(32).toString('base64url');await f.store.createSession(digest(token),tenant);const parentSession=await f.store.getImportSessionStamp(digest(token));await assert.rejects(host.submit({...f.submit,parentSession}),/original_binding/);assert.deepEqual((await f.store._get(dispatchKey(tenant,job.job_id))).binding.parent_session,f.parentSession);
 }finally{f.close();}
});
test('overlapping windows cannot execute under another namespace or job identity',async()=>{
 const f=await privateHostFixture();try{const host=createPrivateImportHost(f.options),first=await host.submit(f.submit);await host.runOne(tenant,first.job_id);const plan={...f.plan,namespace:'another-namespace',from:'2026-10-01T12:00:00Z',to:'2026-10-03T00:00:00Z'},fingerprint=planCustomerImport(plan,project).plan.fingerprint,second=await host.submit({...f.submit,plan,fingerprint});await assert.rejects(host.runOne(tenant,second.job_id),/overlap_or_legacy_hold/);assert.deepEqual(f.counts(),{sourceRequests:2,destinationRequests:1,leases:1});
 }finally{f.close();}
});
test('legacy accepted intervals hold before source lease, not just duplicate exact-job IDs',async()=>{
 const f=await privateHostFixture();try{f.baseline.records.push({operation_id:'reserved-pr12-recovery',from:f.plan.from,to:f.plan.to,receipt_hash:'b'.repeat(64)});f.descriptor.legacy_snapshot_hash=hash(f.baseline);const host=createPrivateImportHost(f.options),job=await host.submit(f.submit);await assert.rejects(host.runOne(tenant,job.job_id),/legacy_hold/);assert.deepEqual(f.counts(),{sourceRequests:0,destinationRequests:0,leases:0});}finally{f.close();}
});
test('missing readiness, wrong mount identity and authorization denial fail before a job or source request',async()=>{
 const f=await privateHostFixture();try{assert.throws(()=>createPrivateImportHost({...f.options,runtime:{...f.runtime,device:f.runtime.device+1}}),/mount_or_runtime/);assert.throws(()=>createPrivateImportHost({...f.options,sourceBroker:undefined}),/explicit_dependencies/);await assert.rejects(createPrivateImportHost({...f.options,readiness:async()=>false}).submit(f.submit),/readiness/);await assert.rejects(createPrivateImportHost({...f.options,authorize:async()=>false}).submit(f.submit),/not_authorized/);assert.equal([...f.client.items.values()].filter(r=>r.sk?.startsWith('IMPORTJOB#')).length,0);assert.deepEqual(f.counts(),{sourceRequests:0,destinationRequests:0,leases:0});}finally{f.close();}
});
for(const lost of ['reservation','claim','upload'])test(lost+' unknown commit preserves durable local fence and blocks reopened execution',async()=>{
 const f=await privateHostFixture();try{const host=createPrivateImportHost(f.options),job=await host.submit(f.submit),tx=f.store._tx.bind(f.store);let injected=false;f.store._tx=async items=>{const value=await tx(items);if(!injected&&items.some(i=>lost==='reservation'?i.Put?.Item.pk?.startsWith('PRIVATEIMPORTREGISTRY#'):i.Put?.Item.state===(lost==='claim'?'claimed':'upload_consumed'))){injected=true;throw Error('synthetic lost commit ACK');}return value;};await assert.rejects(host.runOne(tenant,job.job_id));assert.equal(injected,true);assert.equal(existsSync(join(f.directory,'.private-host.lock')),true);assert.equal(existsSync(join(f.directory,job.job_id,'dispatch-attempt.json')),true);await assert.rejects(createPrivateImportHost(f.options).runOne(tenant,job.job_id),/paused_or_locked/);assert.equal(f.counts().destinationRequests,0);assert.equal(f.counts().leases,0);}finally{f.close();}
});
test('independent registry readback must confirm reservation before claim or provider access',async()=>{
 const f=await privateHostFixture();try{const host=createPrivateImportHost(f.options),job=await host.submit(f.submit),get=f.store._get.bind(f.store),tx=f.store._tx.bind(f.store);let committed=false;f.store._tx=async items=>{const result=await tx(items);if(items.some(i=>i.Put?.Item.pk?.startsWith('PRIVATEIMPORTREGISTRY#')))committed=true;return result;};f.store._get=async key=>committed&&key.pk.startsWith('PRIVATEIMPORTREGISTRY#')?null:get(key);await assert.rejects(host.runOne(tenant,job.job_id),/reservation_unverified/);assert.equal(existsSync(join(f.directory,'.private-host.lock')),true);assert.equal((await new ImportJobLedger(f.store).load(tenant,job.job_id)).claim,null);assert.deepEqual(f.counts(),{sourceRequests:0,destinationRequests:0,leases:0});}finally{f.close();}
});
for(const boundary of ['source','destination'])test('physical session revoked during '+boundary+' broker wait stops before that wire',async()=>{
 const f=await privateHostFixture();try{const name=boundary==='source'?'sourceBroker':'destinationBroker',original=f.options[name];f.options[name]=async request=>{const value=await original(request);await f.store.deleteSession(digest(f.token));return value;};const host=createPrivateImportHost(f.options),job=await host.submit(f.submit);await assert.rejects(host.runOne(tenant,job.job_id));assert.equal(f.counts().destinationRequests,0);if(boundary==='source')assert.equal(f.counts().sourceRequests,0);assert.equal(existsSync(join(f.directory,'.private-host.lock')),true);}finally{f.close();}
});
test('lost upload ACK completes through authoritative readback only, without repeating a request',async()=>{
 const f=await privateHostFixture();try{const send=f.options.destinationFetch;f.options.destinationFetch=async(...args)=>{await send(...args);throw Error('synthetic lost wire ACK');};const host=createPrivateImportHost(f.options),job=await host.submit(f.submit),result=await host.runOne(tenant,job.job_id);assert.equal(result.upload_acknowledged,false);assert.equal(result.receipt.export_verified,true);assert.equal(f.counts().destinationRequests,1);await assert.rejects(host.runOne(tenant,job.job_id),/no_replay/);}finally{f.close();}
});
test('a checksummed metadata-only replacement cannot change the protected source field contract',async()=>{
 const f=await privateHostFixture();try{const host=createPrivateImportHost(f.options),job=await host.submit(f.submit),row=f.client._get(dispatchKey(tenant,job.job_id));row.binding.source.fields='core,basic';row.binding_hash=hash(row.binding);const {checksum,...body}=row;row.checksum=hash(body);await assert.rejects(host.runOne(tenant,job.job_id),/binding_invalid/);assert.deepEqual(f.counts(),{sourceRequests:0,destinationRequests:0,leases:0});}finally{f.close();}
});
test('queue authorization and durable record use one private snapshot despite caller mutation across waits',async()=>{
 const f=await privateHostFixture();try{const authorize=f.options.authorize;f.options.authorize=async d=>{if(d.action==='queue-private-import'){f.submit.descriptor.destination_binding='9'.repeat(64);f.submit.descriptor.approval_hash='8'.repeat(64);f.submit.plan.namespace='changed-after-approval';}return authorize(d);};const host=createPrivateImportHost(f.options),job=await host.submit(f.submit),record=await f.store._get(dispatchKey(tenant,job.job_id));assert.equal(record.binding.destination_binding,'3'.repeat(64));assert.equal(record.binding.approval_hash,'4'.repeat(64));assert.equal(record.binding.source.scope.namespace,'private-host-integrated');}finally{f.close();}
});
test('legacy snapshot cannot be mutated after hash validation to erase an accepted overlapping interval',async()=>{
 const f=await privateHostFixture();try{f.baseline.records.push({operation_id:'accepted-legacy',from:f.plan.from,to:f.plan.to,receipt_hash:'b'.repeat(64)});f.descriptor.legacy_snapshot_hash=hash(f.baseline);let supplied=false;f.options.legacyProvider=async()=>{supplied=true;return f.baseline;};const get=f.store.getTenant.bind(f.store);f.store.getTenant=async(...args)=>{const result=await get(...args);if(supplied)f.baseline.records.length=0;return result;};const host=createPrivateImportHost(f.options),job=await host.submit(f.submit);await assert.rejects(host.runOne(tenant,job.job_id),/legacy_hold/);assert.deepEqual(f.counts(),{sourceRequests:0,destinationRequests:0,leases:0});}finally{f.close();}
});
for(const action of ['inspect-private-import','cancel-private-import'])test('physical session rechecked after '+action+' authorization before returning metadata',async()=>{
 const f=await privateHostFixture();try{const authorize=f.options.authorize;f.options.authorize=async d=>{const allowed=await authorize(d);if(d.action===action)await f.store.deleteSession(digest(f.token));return allowed;};const host=createPrivateImportHost(f.options),job=await host.submit(f.submit);await assert.rejects(action==='inspect-private-import'?host.status(tenant,job.job_id):host.cancel(tenant,job.job_id),/session_changed/);assert.deepEqual(f.counts(),{sourceRequests:0,destinationRequests:0,leases:0});}finally{f.close();}
});

test('both staging and upload use the verified absolute Python despite a conflicting inherited PATH',async()=>{
 const f=await privateHostFixture(),before=process.env.PATH;try{const fake=join(f.directory,'fake-bin');mkdirSync(fake,{mode:0o700});const marker=join(f.directory,'wrong-python-ran');writeFileSync(join(fake,'python3'),'#!'+process.execPath+'\nrequire("node:fs").writeFileSync('+JSON.stringify(marker)+',"wrong");process.exit(88);\n');chmodSync(join(fake,'python3'),0o700);process.env.PATH=fake;const host=createPrivateImportHost(f.options),job=await host.submit(f.submit),result=await host.runOne(tenant,job.job_id);assert.equal(result.receipt.export_verified,true);assert.equal(existsSync(marker),false);}finally{process.env.PATH=before;f.close();}
});

test('actual process kill leaves original dispatch and filesystem fence; reopened host does not dispatch',{timeout:20000},async()=>{
 const f=await privateHostFixture(),childDirectory=join(f.directory,'child-host'),handoff=join(f.directory,'child-fence.json');mkdirSync(childDirectory,{mode:0o700});let child;
 try{
  const fixtureUrl=new URL('./private-host-fixture.mjs',import.meta.url).href,hostUrl=new URL('../src/private-import-host.mjs',import.meta.url).href;
  const script='import {privateHostFixture} from '+JSON.stringify(fixtureUrl)+';import {createPrivateImportHost} from '+JSON.stringify(hostUrl)+';import {openSync,writeFileSync,fsyncSync,closeSync} from "node:fs";const f=await privateHostFixture({directory:'+JSON.stringify(childDirectory)+'});f.options.sourceFetch=async()=>{const fd=openSync('+JSON.stringify(handoff)+',"wx",0o600);writeFileSync(fd,JSON.stringify({items:[...f.client.items],job_id:job.job_id}));fsyncSync(fd);closeSync(fd);return new Promise(()=>{});};const host=createPrivateImportHost(f.options),job=await host.submit(f.submit);await host.runOne("github-4242",job.job_id);';
  child=spawn(process.execPath,['--input-type=module','--eval',script],{stdio:['ignore','ignore','pipe'],env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,LANG:'C.UTF-8'}});let stderr='';child.stderr.on('data',b=>{stderr+=b;});const exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));let snapshot;const deadline=Date.now()+10000;while(Date.now()<deadline){try{snapshot=JSON.parse(readFileSync(handoff));break;}catch{}await new Promise(r=>setTimeout(r,10));}assert.ok(snapshot,stderr);assert.equal(child.kill('SIGKILL'),true);assert.equal((await exit).signal,'SIGKILL');
  const client=new MemoryDynamo();client.items=new Map(snapshot.items);const store=new DynamoMetadataStore({client,commands:commandClasses(),tableName:'synthetic'});const host=createPrivateImportHost({...f.options,store,directory:childDirectory});assert.equal((await host.status(tenant,snapshot.job_id)).paused,true);await assert.rejects(host.runOne(tenant,snapshot.job_id),/paused_or_locked/);assert.deepEqual(f.counts(),{sourceRequests:0,destinationRequests:0,leases:0});assert.equal(existsSync(join(childDirectory,snapshot.job_id,'dispatch-attempt.json')),true);
 }finally{if(child&&!child.killed)child.kill('SIGKILL');f.close();}
});
test('two private roots racing overlapping jobs share one conditional registry winner',async()=>{
 const f=await privateHostFixture();try{const otherDirectory=join(f.directory,'other-host');mkdirSync(otherDirectory,{mode:0o700});const firstHost=createPrivateImportHost(f.options),secondHost=createPrivateImportHost({...f.options,directory:otherDirectory}),first=await firstHost.submit(f.submit),plan={...f.plan,namespace:'race-overlap',from:'2026-10-01T06:00:00Z',to:'2026-10-03T00:00:00Z'},second=await secondHost.submit({...f.submit,plan,fingerprint:planCustomerImport(plan,project).plan.fingerprint});const outcomes=await Promise.allSettled([firstHost.runOne(tenant,first.job_id),secondHost.runOne(tenant,second.job_id)]);assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.deepEqual(f.counts(),{sourceRequests:2,destinationRequests:1,leases:1});}finally{f.close();}
});
test('adjacent half-open source windows reserve separately without clearing earlier receipts',async()=>{
 const f=await privateHostFixture();try{const host=createPrivateImportHost(f.options),first=await host.submit(f.submit);await host.runOne(tenant,first.job_id);f.sourceRows[0].id='new-root';f.sourceRows[0].traceId='next-trace';f.sourceRows[0].startTime='2026-10-02T12:00:00Z';const plan={...f.plan,from:f.plan.to,to:'2026-10-03T00:00:00Z'},next=await host.submit({...f.submit,plan,fingerprint:planCustomerImport(plan,project).plan.fingerprint});assert.equal((await host.runOne(tenant,next.job_id)).receipt.export_verified,true);assert.equal((await host.status(tenant,first.job_id)).dispatch.state,'complete');const rows=[...f.client.items.values()].filter(r=>r.pk.startsWith('PRIVATEIMPORTREGISTRY#'));assert.equal(rows.length,1);assert.equal(rows[0].reservations.length,2);}finally{f.close();}
});
test('known legacy denial settles a durable hold rather than remaining queued for automatic retries',async()=>{
 const f=await privateHostFixture();try{f.baseline.records.push({operation_id:'accepted',from:f.plan.from,to:f.plan.to,receipt_hash:'b'.repeat(64)});f.descriptor.legacy_snapshot_hash=hash(f.baseline);const host=createPrivateImportHost(f.options),job=await host.submit(f.submit);await assert.rejects(host.runOne(tenant,job.job_id),/legacy_hold/);assert.equal((await host.status(tenant,job.job_id)).dispatch.state,'reconciliation_required');await assert.rejects(host.runOne(tenant,job.job_id),/no_replay/);assert.deepEqual(f.counts(),{sourceRequests:0,destinationRequests:0,leases:0});}finally{f.close();}
});
test('expired queue authority fails before creating a durable job',async()=>{
 const f=await privateHostFixture();try{f.descriptor.expires_at=f.store.now()-1;await assert.rejects(createPrivateImportHost(f.options).submit(f.submit),/approval_expired/);assert.equal([...f.client.items.values()].filter(r=>r.sk?.startsWith('IMPORTJOB#')).length,0);}finally{f.close();}
});
test('a losing worker cannot settle another execution of the same dispatch',async()=>{
 const f=await privateHostFixture();try{const otherDirectory=join(f.directory,'same-job-other-root');mkdirSync(otherDirectory,{mode:0o700});const a=createPrivateImportHost(f.options),b=createPrivateImportHost({...f.options,directory:otherDirectory}),job=await a.submit(f.submit),outcomes=await Promise.allSettled([a.runOne(tenant,job.job_id),b.runOne(tenant,job.job_id)]);assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal((await a.status(tenant,job.job_id)).dispatch.state,'complete');assert.deepEqual(f.counts(),{sourceRequests:2,destinationRequests:1,leases:1});}finally{f.close();}
});

test('import-only archive refuses unrelated empty runs, extra metadata and mismatched job/count bindings',async()=>{
 const f=await privateHostFixture();try{const host=createPrivateImportHost(f.options),job=await host.submit(f.submit),result=await host.runOne(tenant,job.job_id),original=JSON.parse(readFileSync(result.exportPath)),ledger=new ImportJobLedger(f.store,{objects:f.objects,parentSession:f.parentSession});for(const mutate of [a=>{a.runs.push({metadata:{id:'unrelated',event_count:0,batch_count:0},events:[]});a.run_count++;},a=>a.runs[0].metadata.unrelated='not-in-import',a=>a.runs[0].metadata.batch_count++,a=>a.job_id='ij_'+'9'.repeat(64)]){const archive=structuredClone(original);mutate(archive);writeFileSync(result.exportPath,JSON.stringify(archive));await assert.rejects(verifyHostedImportSavedExport({ledger,tenant,job:job.job_id,exportPath:result.exportPath,authorize:async()=>true}),/import_export_/);}}finally{f.close();}
});
test('cancellation during final source-wire authorization stops before provider transport',async()=>{
 const f=await privateHostFixture();let host,job,cancelled=false;try{const authorize=f.options.authorize;f.options.authorize=async d=>{const result=await authorize(d);if(d.action==='source-wire'&&!cancelled){cancelled=true;await host.cancel(tenant,job.job_id);}return result;};host=createPrivateImportHost(f.options);job=await host.submit(f.submit);await assert.rejects(host.runOne(tenant,job.job_id));assert.equal(cancelled,true);assert.deepEqual(f.counts(),{sourceRequests:0,destinationRequests:0,leases:0});assert.equal((await host.status(tenant,job.job_id)).dispatch.state,'reconciliation_required');assert.equal(existsSync(join(f.directory,'.private-host.lock')),true);}finally{f.close();}
});
test('separate in-process observer distinguishes active worker from retained uncertain lock without granting execution authority',async()=>{
 for(const mode of ['success','failure']){const f=await privateHostFixture();let release;try{
  let enter;const entered=new Promise(done=>{enter=done;}),gate=new Promise(done=>{release=done;}),fetch=f.options.sourceFetch;
  f.options.sourceFetch=async(...args)=>{enter();await gate;if(mode==='failure')throw Error('SYNTHETIC_TRANSPORT_FAILED');return fetch(...args);};
  const worker=createPrivateImportHost(f.options),observer=createPrivateImportHost(f.options),job=await worker.submit(f.submit),work=worker.runOne(f.submit.tenant,job.job_id).then(value=>({value}),error=>({error}));
  await entered;const running=await observer.status(f.submit.tenant,job.job_id);assert.equal(running.worker_busy,true);assert.equal(running.paused,false);await assert.rejects(observer.preflight(),/paused_or_locked/);
  release();const result=await work;if(mode==='failure')assert.ok(result.error);else assert.equal(result.value.outcome,'import-export-verified');
  const finished=await observer.status(f.submit.tenant,job.job_id);assert.equal(finished.worker_busy,false);assert.equal(finished.paused,mode==='failure');
 }finally{release?.();f.close();}}
});
