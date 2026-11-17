import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {importStartFixture} from './import-start-fixture.mjs';
import {createPrivateImportPolicy,PRIVATE_IMPORT_POLICY_ACTIONS} from '../src/private-import-policy.mjs';
import {createPrivateImportConsentStore} from '../src/private-import-consent.mjs';
import {createImportConsentReviewController} from '../src/import-consent-review.mjs';
import {createImportStartController} from '../src/import-start.mjs';
import {createPrivateImportWorker} from '../src/private-import-launcher.mjs';
import {handle} from '../src/aws-api.mjs';
import {hash} from '../src/trace.mjs';
const clone=structuredClone,zero=f=>assert.deepEqual(f.counts(),{sourceRequests:0,destinationRequests:0,leases:0});
async function fixture({overlap=false,payloadChange=()=>{}}={}){
 const f=await importStartFixture(),legacy=clone(f.baseline);
 // Synthetic historical operations, not the actual 80-record import or a claim of an empty history.
 legacy.records=[{operation_id:'synthetic-accepted',from:'2026-09-01T00:00:00Z',to:'2026-09-02T00:00:00Z',receipt_hash:'6'.repeat(64)},
  {operation_id:'synthetic-uncertain',from:overlap?f.plan.from:'2026-09-02T00:00:00Z',to:overlap?f.plan.to:'2026-09-03T00:00:00Z',receipt_hash:'7'.repeat(64)}];
 const record=clone(f.record);record.descriptor.legacy_snapshot_hash=hash(legacy);
 const payload={schema_version:1,approval:record,actions:[...PRIVATE_IMPORT_POLICY_ACTIONS],legacy,inventory_complete:true,evidence:{source:'8'.repeat(64),destination:'9'.repeat(64),host:'a'.repeat(64),legacy:'b'.repeat(64)}};payloadChange(payload);
 const key={pk:'PRIVATEIMPORTPOLICY#'+'c'.repeat(64),sk:'POLICY'},row={...key,schema_version:1,policy_hash:hash(payload),payload,state:'active',version:0,created_at:f.store.now()};
 // Test-only provisioning directly into MemoryDynamo. The adapter has no policy-write API.
 f.client.items.set(key.pk+'\0'+key.sk,clone(row));
 const options={store:f.store,objects:f.objects,runtime:f.runtime,policy_id:'c'.repeat(64),policy_hash:row.policy_hash},policy=createPrivateImportPolicy(options);
 const consents=createPrivateImportConsentStore({...f.consentOptions,authorize:policy.authorize});
 const startController=createImportStartController({...f.controllerOptions,consents,authorize:policy.authorize});
 const reviewController=createImportConsentReviewController({store:f.store,objects:f.objects,origin:'https://supatrace.dev',runtime:f.runtime,consents,proposalProvider:policy.proposalProvider,authorize:policy.authorize});
 f.env.importStartController=startController;f.env.importConsentReviewController=reviewController;
 const api=(path,data)=>handle(new Request('https://supatrace.dev/api/imports/'+path,{method:'POST',headers:f.request().headers,body:JSON.stringify(data)}),f.env);
 const review=()=>api('review',{fingerprint:f.input.fingerprint}),confirm=d=>api('consent',{fingerprint:f.input.fingerprint,review_hash:d.review_hash,accept_content:true});
 const {authenticate,...workerOptions}=f.options;
 const worker=()=>createPrivateImportWorker({...workerOptions,approvalProvider:consents.provide,authorize:policy.authorize,hostOptions:{...f.hostOptions,legacyProvider:policy.legacyProvider}});
 return {...f,policy,policyOptions:options,row,record,legacy,key,api,review,confirm,consents,worker,stored:()=>f.client._get(key),alter:fn=>{const value=f.client._get(key);fn(value);},reviewAndConfirm:async()=>{const r=await review();assert.equal(r.status,200);assert.equal((await confirm(await r.json())).status,200);}};
}
test('protected policy and nonempty legacy inventory compose actual review, Start, Node/Python worker and saved linked export',async()=>{
 const f=await fixture();try{
  await f.reviewAndConfirm();zero(f);const start=await f.start();assert.equal(start.status,202);const job=await start.json();zero(f);
  const result=await f.worker().runNext();assert.equal(result.assignment_state,'complete');assert.equal(result.receipt.matched_events,2);assert.equal(result.receipt.export_verified,true);
  const saved=JSON.parse(readFileSync(join(f.directory,job.job_id,'import-export.json')));assert.equal(saved.event_count,2);assert.equal(saved.runs.flatMap(r=>r.events).find(e=>e.data.observation.id==='child').data.observation.parentObservationId,'root');
  const proof=await f.policy.legacyProvider({scope:f.legacy.scope,expected_hash:hash(f.legacy)});assert.equal(proof.records.length,2);
  assert.deepEqual(await f.worker().releaseCompleted(),{job_id:job.job_id,assignment_state:'released',receipt_hash:hash(result.receipt)});
  assert.equal((await f.worker().runNext()).outcome,'idle');assert.doesNotMatch(JSON.stringify(f.stored()),/synthetic-secret|write_key|publicKey|secretKey/);
 }finally{f.close();}
});
for(const state of ['hold','revoked','missing'])test('uninstalled or '+state+' policy cannot disclose scope, record consent, or create a job',async()=>{
 const f=await fixture();try{if(state==='missing')f.client.items.delete(f.key.pk+'\0'+f.key.sk);else f.alter(r=>r.state=state);assert.equal((await f.review()).status,503);assert.equal(f.jobRows().length,0);zero(f);}finally{f.close();}
});
for(const variant of ['incomplete','unknown-action','evidence','proof-hash','proof-scope','duplicate-operation','oversized'])test('pinned but invalid '+variant+' inventory or policy is denied',async()=>{
 const f=await fixture({payloadChange:p=>{
  if(variant==='incomplete')p.inventory_complete=false;
  if(variant==='unknown-action')p.actions.push('approve-everything');
  if(variant==='evidence')p.evidence.legacy='not-an-owner-receipt';
  if(variant==='proof-hash')p.legacy.records.length=0;
  if(variant==='proof-scope')p.legacy.scope.environment='foreign';
  if(variant==='duplicate-operation'){p.legacy.records.push(clone(p.legacy.records[0]));p.approval.descriptor.legacy_snapshot_hash=hash(p.legacy);}
  if(variant==='oversized')p.evidence.source='x'.repeat(70000);
 }});try{assert.equal((await f.review()).status,503);assert.equal(f.jobRows().length,0);zero(f);}finally{f.close();}
});
test('nonempty overlapping legacy evidence fences worker before any source/destination lease or request',async()=>{
 const f=await fixture({overlap:true});try{await f.reviewAndConfirm();assert.equal((await f.start()).status,202);await assert.rejects(f.worker().runNext());zero(f);assert.equal([...f.client.items.values()].find(r=>r.sk==='SLOT').state,'held');assert.equal(f.stored().payload.legacy.records.length,2);}finally{f.close();}
});
test('policy replacement, wrong configuration pin and lookup scope cannot substitute a new inventory or proposal',async()=>{
 const f=await fixture();try{
  const input={identity:{tenant_id:f.record.tenant_id,parent_session:f.record.parent_session},fingerprint:f.record.fingerprint};
  for(const altered of [{...input,fingerprint:'e'.repeat(64)},{...input,identity:{...input.identity,tenant_id:'github-999'}},{...input,identity:{...input.identity,parent_session:{...f.parentSession,token_hash:'e'.repeat(64)}}}])await assert.rejects(f.policy.proposalProvider(altered),/private_import_policy_unconfirmed/);
  await assert.rejects(f.policy.legacyProvider({scope:{...f.legacy.scope,environment:'foreign'},expected_hash:hash(f.legacy)}));
  await assert.rejects(createPrivateImportPolicy({...f.policyOptions,policy_hash:'e'.repeat(64)}).proposalProvider(input));
  f.alter(r=>{r.payload.actions=[];r.policy_hash=hash(r.payload);r.version++;});assert.equal((await f.review()).status,503);zero(f);
 }finally{f.close();}
});
test('action policy cannot be widened by caller descriptor, record or unknown action',async()=>{
 const f=await fixture();try{for(const input of [{action:'record-reviewed-private-import-consent',approval_id:hash(f.record),record:{...f.record,environment_id:'foreign'}},{action:'revoke-private-import-consent',approval_id:hash(f.record),record:f.record,allow:true},{approval_id:hash(f.record),descriptor:{action:'approve-everything'}},{approval_id:hash(f.record),descriptor:{action:'queue-private-import',tenant_id:f.record.tenant_id,parent_session:f.record.parent_session,plan:f.record.plan,fingerprint:f.record.fingerprint,descriptor:{...f.record.descriptor,approval_hash:hash(f.record)},fields:'core'}}])assert.equal(await f.policy.authorize(input),false);zero(f);}finally{f.close();}
});
for(const boundary of ['revocation','session','lost-ack','payload'])test('final atomic '+boundary+' race denies without retry or policy mutation',async()=>{
 const f=await fixture();try{const tx=f.store._tx.bind(f.store);let calls=0;f.store._tx=async ops=>{
  if(ops.some(o=>o.ConditionCheck?.Key.pk===f.key.pk)){
   calls++;
   if(boundary==='revocation')f.alter(r=>{r.state='revoked';r.version++;});
   if(boundary==='session')await f.store.deleteSession(f.parentSession.token_hash);
   if(boundary==='payload')f.alter(r=>r.payload.inventory_complete=false);
   if(boundary==='lost-ack'){await tx(ops);throw Error('PRIVATE_POLICY_CREDENTIAL_DIAGNOSTIC');}
  }return tx(ops);
 };const r=await f.review();assert.equal(r.status,503);assert.doesNotMatch(await r.text(),/PRIVATE_POLICY_CREDENTIAL_DIAGNOSTIC|token_hash/);assert.equal(calls,1);assert.equal(f.jobRows().length,0);zero(f);}finally{f.close();}
});
test('expired or held policy cannot Start but original-session consent revocation remains possible',async()=>{
 for(const mode of ['expiry','hold','revoked']){const f=await fixture();try{await f.reviewAndConfirm();if(mode==='expiry'){const now=f.store.now();f.store.now=()=>now+301;}else f.alter(r=>{r.state=mode;r.version++;});assert.equal((await f.start()).status,503);assert.equal((await f.api('revoke',{fingerprint:f.input.fingerprint})).status,200);assert.equal(f.jobRows().length,0);zero(f);}finally{f.close();}}
});
test('revoked policy after queue blocks fresh worker and preserves assignment for reconciliation',async()=>{
 const f=await fixture();try{await f.reviewAndConfirm();assert.equal((await f.start()).status,202);f.alter(r=>{r.state='revoked';r.version++;});await assert.rejects(f.worker().runNext());assert.equal(f.jobRows().length,1);zero(f);}finally{f.close();}
});
test('readers capture configuration and return copies without policy mutation or credential discovery',async()=>{
 const f=await fixture();try{const before=JSON.stringify(f.stored()),input={identity:{tenant_id:f.record.tenant_id,parent_session:f.record.parent_session},fingerprint:f.record.fingerprint};f.policyOptions.runtime.artifact_hash='e'.repeat(64);const record=await f.policy.proposalProvider(input);record.descriptor.source_binding='e'.repeat(64);const proof=await f.policy.legacyProvider({scope:f.legacy.scope,expected_hash:hash(f.legacy)});proof.records.length=0;assert.equal(JSON.stringify(f.stored()),before);assert.equal((await f.review()).status,200);zero(f);}finally{f.close();}
});
