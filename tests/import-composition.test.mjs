import test from 'node:test';
import assert from 'node:assert/strict';
import {importStartFixture} from './import-start-fixture.mjs';
import {composeImportControllers} from '../src/import-composition.mjs';
import {PRIVATE_IMPORT_POLICY_ACTIONS} from '../src/private-import-policy.mjs';
import {handle} from '../src/aws-api.mjs';
import {hash} from '../src/trace.mjs';
const clone=structuredClone,origin='https://supatrace.dev',origins=[origin,'https://supatrace.tech'],policyId='c'.repeat(64);

// Test-only provisioning of one protected policy row; production has no policy-write API.
async function fixture(){
 const f=await importStartFixture(),legacy=clone(f.baseline),record=clone(f.record);record.descriptor.legacy_snapshot_hash=hash(legacy);
 const payload={schema_version:1,approval:record,actions:[...PRIVATE_IMPORT_POLICY_ACTIONS],legacy,inventory_complete:true,evidence:{source:'8'.repeat(64),destination:'9'.repeat(64),host:'a'.repeat(64),legacy:'b'.repeat(64)}};
 const key={pk:'PRIVATEIMPORTPOLICY#'+policyId,sk:'POLICY'};
 f.client.items.set(key.pk+'\0'+key.sk,{...key,schema_version:1,policy_hash:hash(payload),payload,state:'active',version:0,created_at:f.store.now()});
 const config={policy_id:policyId,policy_hash:hash(payload),origin,runtime:clone(f.runtime)};
 const env=extra=>{const {importStartController,...base}=f.env;return {...base,...extra};};
 const api=(e,path,data)=>handle(new Request(origin+'/api/imports/'+path,{method:'POST',headers:f.request().headers,body:JSON.stringify(data)}),e);
 const alter=fn=>fn(f.client._get(key));
 return {...f,config,env,api,alter,compose:(...text)=>composeImportControllers(text.length?text[0]:JSON.stringify(config),{store:f.store,objects:f.objects,origins})};
}
const fingerprint=f=>({fingerprint:f.input.fingerprint});

test('valid protected policy configuration composes review, consent and revoke through the actual API',async()=>{
 const f=await fixture();try{
  const composed=f.compose();assert.deepEqual(Object.keys(composed),['importConsentReviewController']);
  const env=f.env(composed);
  const review=await f.api(env,'review',fingerprint(f));assert.equal(review.status,200);const body=await review.json();
  assert.equal(body.status,'scope_review_required');assert.equal(body.execution_started,false);
  const consent=await f.api(env,'consent',{...fingerprint(f),review_hash:body.review_hash,accept_content:true});assert.equal(consent.status,200);
  assert.equal((await consent.json()).status,'consent_recorded');
  const revoke=await f.api(env,'revoke',fingerprint(f));assert.equal(revoke.status,200);assert.equal((await revoke.json()).status,'consent_revoked');
  assert.equal(f.jobRows().length,0);
 }finally{f.close();}
});

test('Start stays unavailable after composition because no genuine host readiness is composed',async()=>{
 const f=await fixture();try{
  const env=f.env(f.compose()),review=await (await f.api(env,'review',fingerprint(f))).json();
  assert.equal((await f.api(env,'consent',{...fingerprint(f),review_hash:review.review_hash,accept_content:true})).status,200);
  const start=await f.api(env,'start',fingerprint(f));assert.equal(start.status,503);assert.equal((await start.json()).error,'import_runtime_unavailable');
  assert.equal(f.jobRows().length,0);
 }finally{f.close();}
});

for(const [name,text] of [['unset',undefined],['empty',''],['malformed','{'],['oversized','x'.repeat(16385)],['extra field',c=>({...c,readiness:true})],['foreign origin',c=>({...c,origin:'https://evil.example'})],['missing pin',c=>{const {policy_hash,...rest}=c;return rest;}],['bad policy id',c=>({...c,policy_id:'short'})]])
 test('invalid configuration ('+name+') composes nothing and the API keeps refusing',async()=>{
  const f=await fixture();try{
   const value=typeof text==='function'?JSON.stringify(text(f.config)):text;
   const composed=f.compose(value);assert.deepEqual(composed,{});
   const r=await f.api(f.env(composed),'review',fingerprint(f));assert.equal(r.status,503);assert.equal((await r.json()).error,'import_consent_unavailable');
  }finally{f.close();}
 });

test('a wrong pinned hash or held policy row composes but discloses no scope and records no consent',async()=>{
 for(const mode of ['wrong-pin','hold']){const f=await fixture();try{
  const composed=f.compose(JSON.stringify(mode==='wrong-pin'?{...f.config,policy_hash:'e'.repeat(64)}:f.config));
  if(mode==='hold')f.alter(r=>{r.state='hold';r.version++;});
  const r=await f.api(f.env(composed),'review',fingerprint(f));assert.equal(r.status,503);
  assert.doesNotMatch(await r.text(),/disclosure|source|token_hash/);assert.equal(f.jobRows().length,0);
 }finally{f.close();}}
});
