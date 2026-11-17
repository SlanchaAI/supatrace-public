import {importStartFixture as fixture} from './import-start-fixture.mjs';
// Actual application handler, protected records, private Node/Python worker and storage/export.
// All accounts, credentials and provider responses are synthetic. No sockets or external access.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createPrivateImportConsentStore} from '../src/private-import-consent.mjs';
import {createImportStartController} from '../src/import-start.mjs';
import {createPrivateImportWorker,createPrivateImportLauncher} from '../src/private-import-launcher.mjs';
import {createPrivateImportAuthenticator} from '../src/private-import-auth.mjs';
import {handle} from '../src/aws-api.mjs';
import {hash} from '../src/trace.mjs';
import {digest} from '../src/aws-auth.mjs';
const origin='https://supatrace.dev';

test('authenticated Start queues atomically and private worker completes saved export without a browser request or cookie',async()=>{
 const f=await fixture();try{
  const {approval_id}=await f.register();assert.equal(approval_id,f.input.approval_id);
  const response=await f.start();assert.equal(response.status,202,await response.clone().text());const queued=await response.json();
  assert.equal(queued.dispatch_state,'queued');assert.equal(queued.execution_started,false);assert.equal(queued.job.project_id,f.record.project_id);assert.equal(f.jobRows().length,1);
  assert.deepEqual(f.counts(),{sourceRequests:0,destinationRequests:0,leases:0});
  const duplicate=await f.start();assert.equal(duplicate.status,202);assert.equal((await duplicate.json()).job_id,queued.job_id);assert.equal(f.jobRows().length,1);
  const fresh=createPrivateImportConsentStore(f.consentOptions);assert.deepEqual(await fresh.provide({approval_id}),f.record,'approval survives service restart');
  const result=await f.worker().runNext();assert.equal(result.outcome,'import-export-verified');assert.equal(result.receipt.matched_events,2);assert.equal(result.receipt.export_verified,true);
  const launcher=createPrivateImportLauncher({...f.options,authenticate:createPrivateImportAuthenticator({store:f.store,origin}),approvalProvider:f.consents.provide});
  const saved=JSON.parse(await launcher.download(f.request(),{approval_id,job_id:queued.job_id}));
  assert.equal(saved.event_count,2);assert.deepEqual(saved.runs[0].events.map(e=>[e.data.observation.id,e.data.observation.parentObservationId]).sort(),[['child','root'],['root',null]]);
  await assert.rejects(f.worker().runNext(),/private_launcher_(operation_stopped|assignment_held)/);
  const stored=JSON.stringify([...f.client.items.values()]);assert.equal(stored.includes(f.token),false);assert.equal(stored.includes(f.key),false);assert.doesNotMatch(stored,/synthetic-secret-key/);
 }finally{f.close();}
});
test('unconfigured and lookalike controllers preserve the deployed503 without reading approval or issuing jobs',async()=>{
 const f=await fixture();try{
  for(const value of [undefined,{start:async()=>{throw Error('must not execute');}},true]){f.env.importStartController=value;const r=await f.start();assert.equal(r.status,503);assert.deepEqual(await r.json(),{error:'import_runtime_unavailable'});}
  assert.equal(f.jobRows().length,0);assert.deepEqual(f.counts(),{sourceRequests:0,destinationRequests:0,leases:0});
 }finally{f.close();}
});
test('Start never converts a fingerprint, client confirmation or supplied identity/credentials into consent',async()=>{
 const f=await fixture();try{
  assert.equal((await f.start()).status,503);assert.equal(f.jobRows().length,0);
  for(const data of [{},{fingerprint:'bad'},{fingerprint:f.input.fingerprint,confirmed:true},{fingerprint:f.input.fingerprint,approval_id:f.input.approval_id},{fingerprint:f.input.fingerprint,tenant_id:f.record.tenant_id},{fingerprint:f.input.fingerprint,write_key:f.key}])assert.equal((await handle(f.request(data),f.env)).status,400);
  f.policy(false);await assert.rejects(f.register(),/not_authorized/);assert.equal(f.jobRows().length,0);
 }finally{f.close();}
});
test('protected registration rejects tampered scope, expiry, artifact and credential-bearing records',async()=>{
 const f=await fixture();try{
  for(const change of [r=>r.plan.traceId=undefined,r=>r.environment_id='production',r=>r.project_id='proj_'+'e'.repeat(32),r=>r.descriptor.artifact_hash='0'.repeat(64),r=>r.descriptor.expires_at=f.store.now(),r=>r.descriptor.expires_at=f.store.now()+3601,r=>r.descriptor.secret='private',r=>r.parent_session.token_hash='0'.repeat(64)]){
   const record=structuredClone(f.record);change(record);await assert.rejects(f.consents.registerReviewedApproval(f.request(),record),/approval_invalid|original_session_required/);
  }
  assert.equal([...f.client.items.values()].filter(r=>r.pk.startsWith('PRIVATEIMPORTCONSENT#')).length,0);
 }finally{f.close();}
});
test('same reviewed registration is idempotent; a changed expiry cannot replace or renew it',async()=>{
 const f=await fixture();try{
  assert.deepEqual(await f.register(),await f.register());const changed=structuredClone(f.record);changed.descriptor.expires_at++;
  await assert.rejects(f.consents.registerReviewedApproval(f.request(),changed),/scope_already_bound/);
  assert.deepEqual(await f.consents.provide({approval_id:f.input.approval_id}),f.record);
 }finally{f.close();}
});
test('removed, foreign, wrong-origin and non-Default scope cannot enqueue',async()=>{
 const f=await fixture();try{
  await f.register();
  const other='z'.repeat(43);await f.store.getOrCreateTenant(9999);await f.store.createSession(digest(other),'github-9999');
  for(const request of [f.request(undefined,{headers:{origin,cookie:'__Host-supatrace='+other,'content-type':'application/json'}}),f.request(undefined,{headers:{origin:'https://foreign.invalid',cookie:'__Host-supatrace='+f.token,'content-type':'application/json'}}),new Request(origin+'/api/imports/start?environment=production',{method:'POST',headers:{origin,cookie:'__Host-supatrace='+f.token,'content-type':'application/json'},body:JSON.stringify({fingerprint:f.input.fingerprint})})])assert.notEqual((await handle(request,f.env)).status,202);
  await f.store.deleteSession(digest(f.token));assert.equal((await f.start()).status,401);assert.equal(f.jobRows().length,0);
 }finally{f.close();}
});
test('revocation blocks lookup, repeat Start and worker execution; cannot renew expired approval',async()=>{
 const f=await fixture();try{
  await f.register();const r=await f.start(),job=await r.json();await f.consents.revoke(f.request(),f.input.approval_id);
  await assert.rejects(f.consents.provide({approval_id:f.input.approval_id}),/revoked/);assert.equal((await f.start()).status,503);
  await assert.rejects(f.worker().runNext(),/private_launcher_(operation_stopped|adapter_unavailable)/);assert.deepEqual(f.counts(),{sourceRequests:0,destinationRequests:0,leases:0});
  assert.equal((await f.consents.revoke(f.request(),f.input.approval_id)).revoked,true);await assert.rejects(f.register(),/revoked/);
 }finally{f.close();}
});
test('revocation racing the atomic dispatch write leaves no job or dispatch',async()=>{
 const f=await fixture();try{
  await f.register();const tx=f.store._tx.bind(f.store);let changed=false;
  f.store._tx=async ops=>{if(!changed&&ops.some(o=>o.Put?.Item?.sk?.startsWith('IMPORTJOB#'))){changed=true;await f.consents.revoke(f.request(),f.input.approval_id);}return tx(ops);};
  const r=await f.start();assert.equal(r.status,503);assert.equal(f.jobRows().length,0);assert.equal([...f.client.items.values()].some(r=>r.sk?.startsWith('IMPORTDISPATCH#')),false);
 }finally{f.close();}
});
test('unready host and session change during readiness stop before the atomic queue write',async()=>{
 for(const mode of ['unready','logout']){const f=await fixture();try{
  await f.register();if(mode==='unready')f.ready(false);else f.env.importStartController=createImportStartController({...f.controllerOptions,readiness:async()=>{await f.store.deleteSession(digest(f.token));return true;}});
  const r=await f.start();assert.equal(r.status,503);assert.equal(f.jobRows().length,0);assert.deepEqual(f.counts(),{sourceRequests:0,destinationRequests:0,leases:0});
 }finally{f.close();}}
});
test('lost queue acknowledgment is unconfirmed; manual retry finds the same original durable job without replay',async()=>{
 const f=await fixture();try{
  await f.register();const tx=f.store._tx.bind(f.store);let lost=true;
  f.store._tx=async ops=>{await tx(ops);if(lost&&ops.some(o=>o.Put?.Item?.sk?.startsWith('IMPORTJOB#'))){lost=false;throw Error('SYNTHETIC_PRIVATE_ERROR');}};
  const first=await f.start();assert.equal(first.status,503);assert.deepEqual(await first.json(),{error:'import_start_unconfirmed'});assert.equal(f.jobRows().length,1);
  const second=await f.start();assert.equal(second.status,202);assert.equal(f.jobRows().length,1);assert.equal((await second.json()).execution_started,false);assert.deepEqual(f.counts(),{sourceRequests:0,destinationRequests:0,leases:0});
 }finally{f.close();}
});
test('approval expiry and stored record corruption fail closed without private diagnostics',async()=>{
 for(const mode of ['expired','corrupt','policy-error']){const f=await fixture();try{
  await f.register();if(mode==='expired'){const now=f.store.now();f.store.now=()=>now+301;}else if(mode==='corrupt'){const r=[...f.client.items.values()].find(r=>r.pk==='PRIVATEIMPORTCONSENT#'+f.input.approval_id);r.record.plan.sourceProject='foreign';}else f.env.importStartController=createImportStartController({...f.controllerOptions,authorize:async()=>{throw Error('SYNTHETIC_PRIVATE_ERROR');}});
  const r=await f.start();assert.equal(r.status,503);assert.deepEqual(await r.json(),{error:'import_start_unconfirmed'});assert.equal(f.jobRows().length,0);
 }finally{f.close();}}
});

// The durable completion is retained if authority disappears at the final response boundary.
test('worker suppresses success if consent is revoked during completion without replaying accepted work',async()=>{
 const f=await fixture();try{
  await f.register();const response=await f.start(),job=await response.json(),tx=f.store._tx.bind(f.store);let revoked=false;
  f.store._tx=async ops=>{if(!revoked&&ops.some(o=>o.Put?.Item?.sk?.startsWith('IMPORTDISPATCH#')&&o.Put.Item.state==='complete')){revoked=true;await f.consents.revoke(f.request(),f.input.approval_id);}return tx(ops);};
  await assert.rejects(f.worker().runNext(),/private_launcher_(adapter_unavailable|operation_stopped)/);
  assert.equal(revoked,true);assert.equal([...f.client.items.values()].find(r=>r.sk==='IMPORTDISPATCH#'+job.job_id).state,'complete');
  const counts=f.counts();await assert.rejects(f.worker().runNext());assert.deepEqual(f.counts(),counts);
 }finally{f.close();}
});

test('revocation inside final policy suppresses queued success and preserves the durable original job',async()=>{
 const f=await fixture();try{
  await f.register();let calls=0;
  f.env.importStartController=createImportStartController({...f.controllerOptions,authorize:async()=>{if(++calls===2)await f.consents.revoke(f.request(),f.input.approval_id);return true;}});
  const response=await f.start();assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'import_start_unconfirmed'});assert.equal(f.jobRows().length,1);
  const count=f.counts();await assert.rejects(f.worker().runNext());assert.deepEqual(f.counts(),count);
 }finally{f.close();}
});
test('retained consent alias cannot switch the atomic guard from revoked A to approved B',async()=>{
 const f=await fixture();try{
  await f.register();const b=structuredClone(f.record);b.plan.traceId='different-trace';b.fingerprint=(await import('../src/import-planning.mjs')).planCustomerImport(b.plan,b.project_id).plan.fingerprint;
  const {approval_id:other}=await f.consents.registerReviewedApproval(f.request(),b);let retained,switched=false;
  const consents={...f.consents,lookup:async(...args)=>{retained=await f.consents.lookup(...args);return retained;}};
  f.env.importStartController=createImportStartController({...f.controllerOptions,consents,authorize:async()=>{if(!switched){switched=true;await f.consents.revoke(f.request(),f.input.approval_id);retained.approval_id=other;}return true;}});
  const response=await f.start();assert.equal(response.status,503);assert.equal(f.jobRows().length,0);assert.equal((await f.consents.provide({approval_id:other})).plan.traceId,'different-trace');
 }finally{f.close();}
});
test('caller mutation across readiness cannot change the captured fingerprint or create a second plan',async()=>{
 const f=await fixture();try{
  await f.register();const input={fingerprint:f.input.fingerprint};const controller=createImportStartController({...f.controllerOptions,readiness:async()=>{input.fingerprint='0'.repeat(64);return true;}});
  const result=await controller.start(f.request(),input);assert.equal(result.job.fingerprint,f.input.fingerprint);assert.equal(f.jobRows().length,1);
 }finally{f.close();}
});

test('expired consent remains revocable and cannot resume a queued operation',async()=>{
 const f=await fixture();try{
  await f.register();const now=f.store.now();f.store.now=()=>now+301;assert.equal((await f.start()).status,503);
  assert.equal((await f.consents.revoke(f.request(),f.input.approval_id)).revoked,true);assert.equal(f.jobRows().length,0);
 }finally{f.close();}
});
test('protected store adapter errors do not expose diagnostics through approval provider',async()=>{
 const f=await fixture();try{
  await f.register();f.store._get=async()=>{throw Error('SYNTHETIC_PRIVATE_STORE');};
  await assert.rejects(f.consents.provide({approval_id:f.input.approval_id}),error=>error.code==='private_consent_unavailable'&&!String(error).includes('SYNTHETIC_PRIVATE'));
 }finally{f.close();}
});

test('registration account-read failure after policy never releases storage diagnostics',async()=>{
 const f=await fixture();try{
  const get=f.store.getTenant.bind(f.store);let reads=0;
  const consents=createPrivateImportConsentStore({...f.consentOptions,authorize:async()=>{f.store.getTenant=async(...args)=>{if(++reads===3)throw Error('SYNTHETIC_PRIVATE_ACCOUNT_DIAGNOSTIC');return get(...args);};return true;}});
  await assert.rejects(consents.registerReviewedApproval(f.request(),f.record),error=>error.code==='private_consent_registration_uncertain'&&!String(error).includes('SYNTHETIC_PRIVATE'));
  assert.equal([...f.client.items.values()].filter(r=>r.pk.startsWith('PRIVATEIMPORTCONSENT#')).length,0);
 }finally{f.close();}
});
