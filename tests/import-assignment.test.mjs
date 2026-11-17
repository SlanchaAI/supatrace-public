// Actual local handler/storage/worker; synthetic accounts, leases and provider rows only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {importStartFixture} from './import-start-fixture.mjs';
import {createPrivateImportWorker,createPrivateImportLauncher} from '../src/private-import-launcher.mjs';
import {createPrivateImportAuthenticator} from '../src/private-import-auth.mjs';
import {importAssignmentKey} from '../src/private-import-assignment.mjs';
import {planCustomerImport} from '../src/import-planning.mjs';
import {handle} from '../src/aws-api.mjs';
import {hash} from '../src/trace.mjs';
const actions=new Set(['consume-private-import-assignment','complete-private-import-assignment','release-private-import-assignment']);
async function fixture(){
 const f=await importStartFixture();let allowed=true;const {authenticate,...original}=f.options;
 const options={...original,approvalProvider:f.consents.provide,authorize:async d=>actions.has(d.descriptor.action)?allowed:original.authorize(d)};
 const slot=()=>[...f.client.items.values()].find(r=>r.pk===importAssignmentKey(f.runtime.worker_id).pk&&r.sk==='SLOT');
 return {...f,options,slot,worker:()=>createPrivateImportWorker(options),allow:v=>{allowed=v;},
  queue:async()=>{await f.register();const r=await f.start();assert.equal(r.status,202,await r.clone().text());return r.json();}};
}
const zero=f=>assert.deepEqual(f.counts(),{sourceRequests:0,destinationRequests:0,leases:0});
test('unready physical host leaves pending assignment unconsumed; explicit valid retry executes once',async()=>{
 const f=await fixture();try{
  await f.queue();let ready=false;f.options.hostOptions.readiness=async()=>ready;
  await assert.rejects(f.worker().runNext());assert.equal(f.slot().state,'pending');zero(f);
  ready=true;assert.equal((await f.worker().runNext()).assignment_state,'complete');assert.equal(f.slot().state,'complete');
  ready=false;const count=f.counts();await assert.rejects(f.worker().releaseCompleted());assert.equal(f.slot().state,'complete');assert.deepEqual(f.counts(),count);
  ready=true;assert.equal((await f.worker().releaseCompleted()).assignment_state,'released');assert.deepEqual(f.counts(),count);
 }finally{f.close();}
});
test('readiness lost after export fences assignment before completion without replaying the durable import',async()=>{
 const f=await fixture();try{
  await f.queue();let ready=true;f.options.hostOptions.readiness=async()=>ready;const authorize=f.options.authorize;
  f.options.authorize=async d=>{if(d.descriptor.action==='complete-private-import-assignment')ready=false;return authorize(d);};
  await assert.rejects(f.worker().runNext());assert.equal(f.slot().state,'held');assert.equal([...f.client.items.values()].find(r=>r.sk.startsWith('IMPORTDISPATCH#')).state,'complete');
  ready=true;const count=f.counts();await assert.rejects(f.worker().runNext());await assert.rejects(f.worker().releaseCompleted());assert.deepEqual(f.counts(),count);
 }finally{f.close();}
});
test('Start creates discoverable atomic assignment; manual entrypoints cannot bypass consume; worker preserves exact saved root/child export',async()=>{
 const f=await fixture();try{
  assert.equal((await f.worker().runNext()).outcome,'idle');const job=await f.queue();assert.equal(job.assignment_state,'pending');zero(f);
  await assert.rejects(f.worker().runAssigned({tenant_id:f.record.tenant_id,job_id:job.job_id}),/assignment_consumption_required/);
  const launcher=createPrivateImportLauncher({...f.options,authenticate:createPrivateImportAuthenticator({store:f.store,origin:'https://supatrace.dev'}),approvalProvider:f.consents.provide});
  await assert.rejects(launcher.runOne(f.request(),{approval_id:f.input.approval_id,job_id:job.job_id}),/assignment_consumption_required/);zero(f);
  const result=await f.worker().runNext();assert.equal(result.job_id,job.job_id);assert.equal(result.receipt.matched_events,2);assert.equal(f.slot().state,'complete');
  const saved=JSON.parse(await launcher.download(f.request(),{approval_id:f.input.approval_id,job_id:job.job_id}));assert.deepEqual(saved.runs[0].events.map(r=>[r.data.observation.id,r.data.observation.parentObservationId]).sort(),[['child','root'],['root',null]]);
  const count=f.counts();await assert.rejects(f.worker().runNext());assert.deepEqual(f.counts(),count);
  f.allow(false);await assert.rejects(f.worker().releaseCompleted());assert.equal(f.slot().state,'complete');f.allow(true);
  assert.equal((await f.worker().releaseCompleted()).assignment_state,'released');assert.equal((await f.worker().runNext()).outcome,'idle');assert.deepEqual(f.counts(),count);
  assert.equal([...f.client.items.values()].filter(r=>r.sk.startsWith('RESULT#')).length,1);assert.equal([...f.client.items.values()].filter(r=>r.sk.startsWith('RELEASE#')).length,1);
  const stored=JSON.stringify([...f.client.items.values()]);assert.equal(stored.includes(f.token),false);assert.equal(stored.includes(f.key),false);assert.doesNotMatch(stored,/synthetic-secret-key/);
 }finally{f.close();}
});
test('occupied worker rejects another operation atomically; explicit completed release permits new approved assignment without deleting history',async()=>{
 const f=await fixture();try{
  await f.queue();const next=structuredClone(f.record);next.plan.from='2026-10-02T00:00:00Z';next.plan.to='2026-10-03T00:00:00Z';next.fingerprint=planCustomerImport(next.plan,next.project_id).plan.fingerprint;
  await f.consents.registerReviewedApproval(f.request(),next);const start=()=>handle(f.request({fingerprint:next.fingerprint}),f.env);
  assert.equal((await start()).status,503);assert.equal(f.jobRows().length,1);await f.worker().runNext();assert.equal((await start()).status,503);assert.equal(f.jobRows().length,1);
  await f.worker().releaseCompleted();const r=await start();assert.equal(r.status,202);assert.equal((await r.json()).assignment_state,'pending');assert.equal(f.jobRows().length,2);assert.equal([...f.client.items.values()].filter(r=>r.sk.startsWith('RESULT#')).length,1);
 }finally{f.close();}
});
test('competing worker instances consume once',async()=>{
 const f=await fixture();try{await f.queue();const rs=await Promise.allSettled([f.worker().runNext(),f.worker().runNext()]);assert.equal(rs.filter(r=>r.status==='fulfilled').length,1);assert.equal(rs.filter(r=>r.status==='rejected').length,1);assert.equal(f.slot().state,'complete');const count=f.counts();await assert.rejects(f.worker().runNext());assert.deepEqual(f.counts(),count);}finally{f.close();}
});
test('lost consume ACK fences restart before source access; expiry cannot reclaim consumed work',async()=>{
 const f=await fixture();try{
  await f.queue();const tx=f.store._tx.bind(f.store);let lost=true;f.store._tx=async ops=>{await tx(ops);if(lost&&ops.some(o=>o.Put?.Item?.sk==='SLOT'&&o.Put.Item.state==='consumed')){lost=false;throw Error('SYNTHETIC_PRIVATE_ACK');}};
  await assert.rejects(f.worker().runNext());assert.equal(f.slot().state,'consumed');zero(f);const now=f.store.now();f.store.now=()=>now+10000;await assert.rejects(f.worker().runNext());await assert.rejects(f.worker().releaseCompleted());assert.equal(f.slot().state,'consumed');zero(f);
 }finally{f.close();}
});
test('lost Start ACK retains job, dispatch and assignment together; manual retry observes same job',async()=>{
 const f=await fixture();try{
  await f.register();const tx=f.store._tx.bind(f.store);let lost=true;f.store._tx=async ops=>{await tx(ops);if(lost&&ops.some(o=>o.Put?.Item?.sk?.startsWith('IMPORTJOB#'))){lost=false;throw Error('SYNTHETIC_PRIVATE_ACK');}};
  assert.equal((await f.start()).status,503);assert.equal(f.slot().state,'pending');assert.equal(f.jobRows().length,1);const r=await f.start();assert.equal(r.status,202);assert.equal((await r.json()).job_id,f.slot().assignment.job_id);assert.equal(f.jobRows().length,1);zero(f);assert.equal((await f.worker().runNext()).receipt.matched_events,2);
 }finally{f.close();}
});
test('checksummed binding or runtime mismatch cannot authorize provider access',async()=>{
 for(const mode of ['binding','runtime']){const f=await fixture();try{
  await f.queue();if(mode==='binding'){const s=f.slot();s.assignment.approval_id='e'.repeat(64);s.assignment_hash=hash(s.assignment);const {checksum,...body}=s;s.checksum=hash(body);}else f.options.hostOptions.runtime.artifact_hash='e'.repeat(64);
  await assert.rejects(f.worker().runNext());assert.equal(f.slot().state,'pending');zero(f);
 }finally{f.close();}}
});
test('revocation racing consume fails the atomic guard before any source request',async()=>{
 const f=await fixture();try{
  await f.queue();const tx=f.store._tx.bind(f.store);let changed=false;f.store._tx=async ops=>{if(!changed&&ops.some(o=>o.Put?.Item?.sk==='SLOT'&&o.Put.Item.state==='consumed')){changed=true;await f.consents.revoke(f.request(),f.input.approval_id);}return tx(ops);};await assert.rejects(f.worker().runNext());assert.equal(f.slot().state,'pending');zero(f);
 }finally{f.close();}
});
test('revocation during mailbox settlement retains completed import and fences assignment',async()=>{
 const f=await fixture();try{
  await f.queue();const tx=f.store._tx.bind(f.store);let changed=false;f.store._tx=async ops=>{if(!changed&&ops.some(o=>o.Put?.Item?.sk==='SLOT'&&o.Put.Item.state==='complete')){changed=true;await f.consents.revoke(f.request(),f.input.approval_id);}return tx(ops);};await assert.rejects(f.worker().runNext());assert.equal(f.slot().state,'held');assert.equal([...f.client.items.values()].find(r=>r.sk.startsWith('IMPORTDISPATCH#')).state,'complete');const count=f.counts();await assert.rejects(f.worker().runNext());await assert.rejects(f.worker().releaseCompleted());assert.deepEqual(f.counts(),count);
 }finally{f.close();}
});
test('lost completion ACK preserves audit; explicit verified release reconciles mailbox without replay',async()=>{
 const f=await fixture();try{
  await f.queue();const tx=f.store._tx.bind(f.store);let lost=true;f.store._tx=async ops=>{await tx(ops);if(lost&&ops.some(o=>o.Put?.Item?.sk==='SLOT'&&o.Put.Item.state==='complete')){lost=false;throw Error('SYNTHETIC_PRIVATE_ACK');}};await assert.rejects(f.worker().runNext());assert.equal(f.slot().state,'complete');const count=f.counts();await assert.rejects(f.worker().runNext());assert.equal((await f.worker().releaseCompleted()).assignment_state,'released');assert.deepEqual(f.counts(),count);
 }finally{f.close();}
});
test('corrupt audit blocks release, and cancelled unclaimed jobs are never auto-consumed',async()=>{
 for(const mode of ['audit','cancel']){const f=await fixture();try{
  const job=await f.queue();if(mode==='audit'){await f.worker().runNext();const a=[...f.client.items.values()].find(r=>r.sk.startsWith('RESULT#'));a.receipt_hash='e'.repeat(64);await assert.rejects(f.worker().releaseCompleted());assert.equal(f.slot().state,'complete');}
  else{const {ImportJobLedger}=await import('../src/import-job-ledger.mjs');await new ImportJobLedger(f.store,{objects:f.objects,parentSession:f.parentSession}).cancel(f.record.tenant_id,job.job_id);await assert.rejects(f.worker().runNext());assert.equal(f.slot().state,'pending');zero(f);}
 }finally{f.close();}}
});

test('released slot reuse requires intact completion and release audit proofs',async()=>{
 for(const prefix of ['RESULT#','RELEASE#']){const f=await fixture();try{
  await f.queue();await f.worker().runNext();await f.worker().releaseCompleted();
  const audit=[...f.client.items.values()].find(r=>r.sk.startsWith(prefix));audit.attempt_id='e'.repeat(64);const {checksum,...body}=audit;audit.checksum=hash(body);
  const next=structuredClone(f.record);next.plan.from='2026-10-02T00:00:00Z';next.plan.to='2026-10-03T00:00:00Z';next.fingerprint=planCustomerImport(next.plan,next.project_id).plan.fingerprint;await f.consents.registerReviewedApproval(f.request(),next);
  const r=await handle(f.request({fingerprint:next.fingerprint}),f.env);assert.equal(r.status,503);assert.equal(f.jobRows().length,1);assert.equal(f.slot().state,'released');
 }finally{f.close();}}
});
