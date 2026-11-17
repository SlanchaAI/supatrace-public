import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {importStartFixture} from './import-start-fixture.mjs';
import {createImportConsentReviewController} from '../src/import-consent-review.mjs';
import {handle} from '../src/aws-api.mjs';
import {digest} from '../src/aws-auth.mjs';
import {hash} from '../src/trace.mjs';
import {createFixtureSession} from './fixture-session.mjs';
import {slot,token,withSessionTokens} from './session-token-fixtures.mjs';
async function fixture(){
 const f=await importStartFixture();let candidate=structuredClone(f.record),allowed=true,provider=async()=>candidate;const calls=[];
 const options={store:f.store,objects:f.objects,origin:'https://supatrace.dev',runtime:f.runtime,consents:f.consents,proposalProvider:d=>provider(d),authorize:async d=>{calls.push(d);return allowed;}};
 const controller=createImportConsentReviewController(options);f.env.importConsentReviewController=controller;
 const request=(path,data,changes={})=>new Request('https://supatrace.dev'+path,{method:'POST',headers:f.request().headers,body:JSON.stringify(data),...changes});
 const api=(path,data,changes)=>handle(request(path,data,changes),f.env),review=()=>api('/api/imports/review',{fingerprint:f.input.fingerprint});
 return {...f,options,controller,calls,request,api,review,allow:v=>{allowed=v;},candidate:v=>{candidate=v;},provider:fn=>{provider=fn;},consentRows:()=>[...f.client.items.values()].filter(r=>r.sk==='APPROVAL'),confirm:d=>api('/api/imports/consent',{fingerprint:f.input.fingerprint,review_hash:d.review_hash,accept_content:true}),revoke:()=>api('/api/imports/revoke',{fingerprint:f.input.fingerprint})};
}
const zero=f=>assert.deepEqual(f.counts(),{sourceRequests:0,destinationRequests:0,leases:0});
function secondSessionTokens(current){
 const occupied=slot(Buffer.from(current,'base64url'));let collision,available;
 for(let i=0;i<100000&&(!collision||!available);i++){
  const bytes=createHash('sha256').update('consent-slot-regression-'+i).digest();
  if(slot(bytes)===occupied&&token(bytes)!==current)collision??=bytes;
  else if(slot(bytes)!==occupied)available??=bytes;
 }
 assert.ok(collision&&available,'bounded deterministic collision/free-slot fixture');
 return [collision,available];
}
test('actual review/confirm API records exact scoped content consent; separate Start discovers worker and saves linked export',async()=>{
 const f=await fixture();try{
  assert.equal((await f.start()).status,503);const r=await f.review();assert.equal(r.status,200);const d=await r.json();assert.equal(d.status,'scope_review_required');assert.equal(d.execution_started,false);assert.deepEqual(d.disclosure.content,{input_output:true,prompts:true});assert.equal(d.disclosure.source.trace_id,f.plan.traceId);assert.equal(d.disclosure.destination.project_id,f.record.project_id);assert.equal(d.disclosure.expires_at,f.record.descriptor.expires_at);assert.equal(d.disclosure.bounds.max_rows,10);assert.ok(d.disclosure.fields.includes('io'));assert.ok(d.disclosure.fields.includes('prompt'));
  assert.doesNotMatch(JSON.stringify(d),/parent_session|token_hash|source_binding|destination_binding|artifact_hash|write_key|SYNTHETIC_EXPLICIT_CONTENT|synthetic-secret/);assert.equal(f.consentRows().length,0);assert.equal(f.jobRows().length,0);zero(f);
  assert.equal((await f.confirm(d)).status,200);assert.equal(f.consentRows().length,1);assert.equal(f.jobRows().length,0);zero(f);const start=await f.start();assert.equal(start.status,202);const job=await start.json();assert.equal(job.execution_started,false);assert.equal(job.assignment_state,'pending');zero(f);
  const result=await f.worker().runNext();assert.equal(result.receipt.matched_events,2);const saved=JSON.parse(readFileSync(join(f.directory,job.job_id,'import-export.json')));assert.equal(saved.event_count,2);assert.equal(saved.runs.flatMap(r=>r.events).find(e=>e.data.observation.id==='child').data.observation.parentObservationId,'root');
 }finally{f.close();}
});
test('default-off and forged controllers cannot expose scope or create consent',async()=>{
 const f=await fixture();try{for(const value of [undefined,{review:async()=>({status:'scope_review_required'}),confirm:async()=>({status:'consent_recorded'}),revoke:async()=>({status:'consent_revoked'})}]){f.env.importConsentReviewController=value;for(const path of ['review','consent','revoke'])assert.equal((await f.api('/api/imports/'+path,{fingerprint:f.input.fingerprint})).status,503);}assert.equal(f.consentRows().length,0);assert.equal(f.calls.length,0);zero(f);}finally{f.close();}
});
test('caller cannot supply a proposal, identity, credential, approval ID or bypass explicit content review',async()=>{
 const f=await fixture();try{const d=await(await f.review()).json();for(const extra of ['record','parent_session','write_key','approval_id'])assert.equal((await f.api('/api/imports/review',{fingerprint:f.input.fingerprint,[extra]:'not-accepted'})).status,400);
 for(const accept of [false,'true',null])assert.equal((await f.api('/api/imports/consent',{fingerprint:f.input.fingerprint,review_hash:d.review_hash,accept_content:accept})).status,400);
 assert.equal((await f.api('/api/imports/consent',{fingerprint:f.input.fingerprint,review_hash:'e'.repeat(64),accept_content:true})).status,409);assert.equal(f.consentRows().length,0);zero(f);
 }finally{f.close();}
});
test('changed expiry or connection binding invalidates the rendered review instead of silently widening or renewing consent',async()=>{
 for(const field of ['expires_at','source_binding','destination_binding']){const f=await fixture();try{const d=await(await f.review()).json(),next=structuredClone(f.record);next.descriptor[field]=field==='expires_at'?next.descriptor.expires_at+1:'e'.repeat(64);f.candidate(next);assert.equal((await f.confirm(d)).status,409);assert.equal(f.consentRows().length,0);zero(f);}finally{f.close();}}
});
test('expired, foreign trace, wrong runtime or extra-field proposals fail before disclosure or registration',async()=>{
 for(const mode of ['expiry','trace','runtime','secret']){const f=await fixture();try{const next=structuredClone(f.record);if(mode==='expiry')next.descriptor.expires_at=f.store.now()-1;if(mode==='trace')next.plan.traceId='different-trace';if(mode==='runtime')next.descriptor.artifact_hash='e'.repeat(64);if(mode==='secret')next.write_key='must-not-return';f.candidate(next);const r=await f.review();assert.equal(r.status,503);assert.doesNotMatch(await r.text(),/must-not-return|different-trace|token_hash/);assert.equal(f.consentRows().length,0);zero(f);}finally{f.close();}}
});
test('review cannot be confirmed from another physical session, foreign origin or workspace/environment',async()=>{
 const f=await fixture();try{const d=await(await f.review()).json(),data={fingerprint:f.input.fingerprint,review_hash:d.review_hash,accept_content:true};
 const [collision,available]=secondSessionTokens(f.token),held=structuredClone([...f.client.items.values()].filter(r=>r.sk==='SESSION'));
 // Direct setup reproduces the CI failure. Keep the real store's collision guard intact.
 await assert.rejects(f.store.createSession(digest(token(collision)),f.record.tenant_id),e=>e.status===409&&e.code==='session_slot_collision');
 assert.deepEqual([...f.client.items.values()].filter(r=>r.sk==='SESSION'),held);
 const other=await withSessionTokens([collision,available],()=>createFixtureSession(f.store,f.record.tenant_id));
 assert.equal(other,token(available));assert.notEqual(other,f.token);
 assert.deepEqual([...f.client.items.values()].filter(r=>r.sk==='SESSION'&&r.token_hash===f.parentSession.token_hash),held);
 assert.deepEqual(await f.store.getImportSessionStamp(digest(f.token)),f.parentSession);
 assert.equal(await f.store.getSession(digest(token(collision))),null);
 assert.equal((await f.store.getSession(digest(other))).tenant_id,f.record.tenant_id);
 assert.equal((await f.api('/api/imports/consent',data,{headers:{origin:'https://supatrace.dev',cookie:'__Host-supatrace='+other,'content-type':'application/json'}})).status,503);
 assert.equal((await f.api('/api/imports/consent',data,{headers:{origin:'https://foreign.invalid',cookie:'__Host-supatrace='+f.token,'content-type':'application/json'}})).status,403);
 assert.equal((await f.api('/api/imports/consent?workspace=github-9999',data)).status,403);assert.equal((await f.api('/api/imports/consent?environment=foreign',data)).status,403);assert.equal(f.consentRows().length,0);zero(f);
 }finally{f.close();}
});
test('policy denial and session deletion during proposal lookup stop consent before persistence',async()=>{
 for(const mode of ['policy','session']){const f=await fixture();try{if(mode==='policy')f.allow(false);else f.provider(async()=>{await f.store.deleteSession(f.parentSession.token_hash);return f.record;});assert.equal((await f.review()).status,503);assert.equal(f.consentRows().length,0);zero(f);}finally{f.close();}}
});
test('untrusted adapter diagnostics and forged public-looking errors are replaced with a constant response',async()=>{
 const f=await fixture();try{f.provider(async()=>{const e=Error('PRIVATE_PROVIDER_SECRET');e.code='invalid_import_consent';e.status=400;throw e;});const r=await f.review();assert.equal(r.status,503);assert.deepEqual(await r.json(),{error:'import_consent_unconfirmed'});zero(f);}finally{f.close();}
});
test('callback/input mutation cannot replace the captured review or recorded proposal',async()=>{
 const f=await fixture();try{const d=await(await f.review()).json(),data={fingerprint:f.input.fingerprint,review_hash:d.review_hash,accept_content:true};f.provider(async input=>{input.fingerprint='e'.repeat(64);input.identity.parent_session.session_epoch++;data.review_hash='e'.repeat(64);return f.record;});const r=await f.controller.confirm(f.request('/api/imports/consent',data),data);assert.equal(r.status,'consent_recorded');assert.equal(f.consentRows().length,1);assert.equal(hash(f.consentRows()[0].record),f.input.approval_id);zero(f);}finally{f.close();}
});
test('lost registration ACK is unconfirmed; explicit unchanged confirmation observes the same immutable approval without a job',async()=>{
 const f=await fixture();try{const d=await(await f.review()).json(),tx=f.store._tx.bind(f.store);let lost=true;f.store._tx=async ops=>{await tx(ops);if(lost&&ops.some(o=>o.Put?.Item?.sk==='APPROVAL')){lost=false;throw Error('PRIVATE_LOST_ACK');}};assert.equal((await f.confirm(d)).status,503);assert.equal(f.consentRows().length,1);assert.equal(f.jobRows().length,0);assert.equal((await f.confirm(d)).status,200);assert.equal(f.consentRows().length,1);assert.equal(f.jobRows().length,0);zero(f);}finally{f.close();}
});
test('revocation during final confirmation suppresses success and blocks Start without deleting the approval',async()=>{
 const f=await fixture();try{const d=await(await f.review()).json();let confirmations=0;f.options.authorize=async()=>true;const controller=createImportConsentReviewController({...f.options,authorize:async event=>{if(event.action==='confirm-private-import-consent'&&++confirmations===2)await f.consents.revoke(f.request('/api/imports/revoke',{}),f.input.approval_id);return true;}});await assert.rejects(controller.confirm(f.request('/api/imports/consent',{}),{fingerprint:f.input.fingerprint,review_hash:d.review_hash,accept_content:true}),/import_consent_unconfirmed/);assert.equal(f.consentRows().length,1);assert.equal(f.consentRows()[0].revoked,true);assert.equal((await f.start()).status,503);zero(f);}finally{f.close();}
});
test('original-session revoke by fingerprint works after expiry; repeated revoke retains history and never grants new consent',async()=>{
 const f=await fixture();try{const d=await(await f.review()).json();assert.equal((await f.confirm(d)).status,200);const now=f.store.now();f.store.now=()=>now+301;assert.equal((await f.start()).status,503);assert.equal((await f.revoke()).status,200);assert.equal((await f.revoke()).status,200);assert.equal(f.consentRows().length,1);assert.equal(f.consentRows()[0].revoked,true);assert.equal((await f.confirm(d)).status,503);zero(f);}finally{f.close();}
});
test('revoke of a queued operation prevents worker access while retaining the queued job/assignment for reconciliation',async()=>{
 const f=await fixture();try{const d=await(await f.review()).json();await f.confirm(d);assert.equal((await f.start()).status,202);assert.equal((await f.revoke()).status,200);await assert.rejects(f.worker().runNext());assert.equal(f.jobRows().length,1);assert.equal([...f.client.items.values()].find(r=>r.sk==='SLOT').state,'pending');assert.equal(f.consentRows().length,1);zero(f);}finally{f.close();}
});
test('previously returned mutable error cannot become a trusted adapter diagnostic',async()=>{
 const f=await fixture();try{let previous;try{await f.controller.review(f.request('/api/imports/review',{}),{fingerprint:'invalid'});}catch(e){previous=e;}assert.ok(previous);previous.code='PRIVATE_MUTATED_DIAGNOSTIC';previous.status=400;previous.message='PRIVATE_MUTATED_DIAGNOSTIC';f.provider(async()=>{throw previous;});const r=await f.review();assert.equal(r.status,503);assert.deepEqual(await r.json(),{error:'import_consent_unconfirmed'});zero(f);}finally{f.close();}
});
test('revocation during final consent/session authentication cannot return stale confirmation',async()=>{
 const f=await fixture();try{
  const d=await(await f.review()).json();let afterRead=false,revoked=false;const stamp=f.store.getImportSessionStamp.bind(f.store);
  f.store.getImportSessionStamp=async(...args)=>{const result=await stamp(...args);if(afterRead&&!revoked){revoked=true;await f.consents.revoke(f.request('/api/imports/revoke',{}),f.input.approval_id);}return result;};
  const consents={...f.consents,provide:async args=>{const result=await f.consents.provide(args);afterRead=true;return result;},verifyRecorded:async args=>{afterRead=true;return f.consents.verifyRecorded(args);}};
  const controller=createImportConsentReviewController({...f.options,consents});await assert.rejects(controller.confirm(f.request('/api/imports/consent',{}),{fingerprint:f.input.fingerprint,review_hash:d.review_hash,accept_content:true}),/import_consent_unconfirmed/);
  assert.equal(revoked,true);assert.equal(f.consentRows()[0].revoked,true);assert.equal(f.jobRows().length,0);assert.equal((await f.start()).status,503);zero(f);
 }finally{f.close();}
});
test('revocation racing final atomic confirmation guard fails before a successful response',async()=>{
 const f=await fixture();try{const d=await(await f.review()).json(),tx=f.store._tx.bind(f.store);let changed=false;
  f.store._tx=async ops=>{if(!changed&&ops.every(o=>o.ConditionCheck)&&ops.some(o=>o.ConditionCheck.Key.pk.startsWith('PRIVATEIMPORTCONSENT#'))){changed=true;await f.consents.revoke(f.request('/api/imports/revoke',{}),f.input.approval_id);}return tx(ops);};
  assert.equal((await f.confirm(d)).status,503);assert.equal(changed,true);assert.equal(f.consentRows()[0].revoked,true);assert.equal(f.jobRows().length,0);assert.equal((await f.start()).status,503);zero(f);
 }finally{f.close();}
});
