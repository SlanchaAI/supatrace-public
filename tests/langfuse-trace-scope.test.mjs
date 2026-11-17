import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {planCapture,captureLangfuse,approveCapturedStage} from '../src/importers/langfuse-capture.mjs';
import {createLangfuseTransport,captureLangfuseWithTransport,TRANSPORT_CREDENTIAL_SENTINEL} from '../src/importers/langfuse-transport.mjs';
import {planCustomerImport} from '../src/import-planning.mjs';
import {ImportJobLedger} from '../src/import-job-ledger.mjs';
import {createPrivateImportHost} from '../src/private-import-host.mjs';
import {alphaProject} from '../src/alpha-projects.mjs';
import {loadImportDispatch,reserveImportDispatch} from '../src/private-import-dispatch.mjs';
import {privateHostFixture} from './private-host-fixture.mjs';
const legacy=JSON.parse(readFileSync(new URL('./fixtures/langfuse-plan-before-trace-scope.json',import.meta.url)));
const base=legacy.spec,spec={...base,traceId:'trace/selected?x=1&filter=ignored+Ω'};
const bounds={requestTimeoutMs:1000,totalTimeoutMs:10000,maxRequests:10,maxResponseBytes:100000,maxTotalBytes:300000};
const row=(id='root',traceId=spec.traceId)=>({id,traceId,projectId:spec.sourceProject,environment:spec.environment,startTime:'2026-10-01T12:00:00Z',parentObservationId:id==='root'?null:'root',input:'SYNTHETIC_INPUT',prompt:'SYNTHETIC_PROMPT'});
const response=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
const lease=(scope=spec)=>({origin:scope.origin,projectId:scope.sourceProject,...(scope.traceId!==undefined?{traceId:scope.traceId}:{}),publicKey:'synthetic-public-key',secretKey:'synthetic-secret-key',expiresAt:Date.now()+60000});
function options(fetchImpl,extra={}){return{bounds,fetchImpl,authorize:async()=>true,credentialProvider:async()=>lease(),...extra};}
function target(scope=spec){const plan=planCapture(scope),url=new URL('/api/public/v2/observations',scope.origin);url.search=new URLSearchParams({fromStartTime:scope.from,toStartTime:scope.to,fields:plan.fields,limit:'5',environment:scope.environment,...(scope.traceId!==undefined?{traceId:scope.traceId}:{})});return{method:'GET',url:url.href,redirect:'error',headers:{Authorization:TRANSPORT_CREDENTIAL_SENTINEL}};}

test('absence preserves exact legacy plan and optional trace IDs are opaque, validated and fingerprint-bound',()=>{
 assert.deepEqual(planCapture(base),legacy.plan);assert.equal(JSON.stringify(planCapture(base)),JSON.stringify(legacy.plan));
 assert.notEqual(planCapture(spec).fingerprint,planCapture(base).fingerprint);
 assert.notEqual(planCapture(spec).fingerprint,planCapture({...spec,traceId:'another'}).fingerprint);
 for(const traceId of [undefined,null,'',' leading','trailing ',7,false,{},[], 'x\nother','x'.repeat(201),'\ud800','\udfff'])assert.throws(()=>planCapture({...base,traceId}),/explicit_trace/);
 assert.throws(()=>planCapture(Object.assign(Object.create({traceId:'inherited'}),base)),/explicit_trace/);
 const hidden={...base};Object.defineProperty(hidden,'traceId',{value:spec.traceId});assert.equal(planCapture(hidden).scope.traceId,spec.traceId);
 let reads=0;const changing={...base};Object.defineProperty(changing,'traceId',{enumerable:true,get:()=>++reads===1?spec.traceId:'other'});assert.equal(planCapture(changing).scope.traceId,spec.traceId);
 const {destinationProject,...source}=spec;const planned=planCustomerImport({provider:'langfuse',...source},destinationProject);assert.equal(planned.plan.scope.traceId,spec.traceId);assert.equal(planned.capabilities.execution_available,false);assert.equal(planned.status,'planned_not_authorized_not_started');
});
test('every page, source approval and runtime lease request retains exact trace selection',async()=>{
 const urls=[],permissions=[],bindings=[];let page=0;
 const result=await captureLangfuseWithTransport(spec,options(async url=>{urls.push(url);if(url.endsWith('/projects'))return response({data:[{id:spec.sourceProject}]});const u=new URL(url);assert.equal(u.searchParams.get('traceId'),spec.traceId);assert.equal(u.searchParams.get('filter'),null);return response({data:[row(page++?'child':'root')],meta:{cursor:page===1?'synthetic-cursor':null}});},{authorize:async d=>{permissions.push(d);return true;},credentialProvider:async d=>{bindings.push(d);return lease();}}));
 assert.equal(result.outcome,'captured');assert.equal(result.state.pages.length,2);assert.equal(result.conversion.report.acceptedTraces,1);assert.equal(result.conversion.report.acceptedRows,2);
 assert.ok(permissions.every(d=>d.traceId===spec.traceId));assert.ok(bindings.every(d=>d.traceId===spec.traceId));assert.equal(urls.length,4);
 assert.equal(result.conversion.batches.flatMap(b=>b.events).find(e=>e.data.observation.id==='child').data.observation.parentObservationId,'root');
 let stage;await approveCapturedStage(result,async d=>{stage=d;return true;});assert.equal(stage.traceId,spec.traceId);
});
test('removed, changed, repeated or advanced-filter overrides fail before any credential or wire hook',async()=>{
 for(const edit of [u=>u.searchParams.delete('traceId'),u=>u.searchParams.set('traceId','other'),u=>u.searchParams.append('traceId',spec.traceId),u=>u.searchParams.set('filter',JSON.stringify([{type:'string',column:'traceId',operator:'=',value:'other'}]))]){
  let hooks=0;const transport=createLangfuseTransport(spec,options(async()=>{hooks++;assert.fail('wire');},{authorize:async()=>{hooks++;return true;},credentialProvider:async()=>{hooks++;return lease();}}));
  try{const request=target(),u=new URL(request.url);edit(u);request.url=u.href;await assert.rejects(transport.request(request),/trace_scope|query_refused/);assert.equal(hooks,0);}finally{transport.close();}
 }
 const transport=createLangfuseTransport(base,options(async()=>assert.fail('wire')));try{await assert.rejects(transport.request(target()),/trace_scope/);}finally{transport.close();}
});
test('missing/wrong trace lease, or narrowing a lease under a broad plan, fails before project discovery',async()=>{
 for(const binding of [{...lease(),traceId:'other'},Object.fromEntries(Object.entries(lease()).filter(([k])=>k!=='traceId'))]){
  let wires=0;await assert.rejects(captureLangfuseWithTransport(spec,options(async()=>{wires++;assert.fail('wire');},{credentialProvider:async()=>binding})),/credential_trace_binding/);assert.equal(wires,0);
 }
 let wires=0;await assert.rejects(captureLangfuseWithTransport(base,options(async()=>{wires++;assert.fail('wire');})),/credential_trace_binding/);assert.equal(wires,0);
});
test('foreign/missing trace responses never checkpoint or stage; cached pages are revalidated',async()=>{
 for(const traceId of ['foreign',null,undefined]){
  const observation=row();if(traceId===undefined)delete observation.traceId;else observation.traceId=traceId;
  let saved=0;await assert.rejects(captureLangfuseWithTransport(spec,options(async url=>response(url.endsWith('/projects')?{data:[{id:spec.sourceProject}]}:{data:[observation],meta:{cursor:null}}),{saveCheckpoint:async()=>{saved++;}})),/observation_scope/);assert.equal(saved,0);
 }
 const low={credential:'synthetic-bounded-credential',approve:async()=>true,transport:async()=>({status:200,body:JSON.stringify({data:[row()],meta:{cursor:null}})})};
 const captured=await captureLangfuse(spec,low);
 await assert.rejects(captureLangfuse({...spec,traceId:'other'},{...low,checkpoint:captured.state,transport:async()=>assert.fail('wire')}),/checkpoint_scope/);
 captured.state.pages[0].data[0].traceId='foreign';let calls=0;
 await assert.rejects(captureLangfuse(spec,{...low,checkpoint:captured.state,transport:async()=>{calls++;assert.fail('wire');}}),/source_trace/);assert.equal(calls,0);
 await assert.rejects(approveCapturedStage(captured,async()=>assert.fail('destination approval')),/source_trace/);
});
test('read denial and late lease mutation cannot broaden the selected trace',async()=>{
 let creds=0,wires=0;await assert.rejects(captureLangfuseWithTransport(spec,options(async()=>{wires++;assert.fail('wire');},{authorize:async d=>d.traceId==='different-approved-trace',credentialProvider:async()=>{creds++;return lease();}})),/not_authorized/);assert.equal(creds,0);assert.equal(wires,0);
 const mutable=lease();const result=await captureLangfuseWithTransport(spec,options(async url=>{if(url.endsWith('/projects')){mutable.traceId='different';return response({data:[{id:spec.sourceProject}]});}assert.equal(new URL(url).searchParams.get('traceId'),spec.traceId);return response({data:[row()],meta:{cursor:null}});},{credentialProvider:async()=>mutable}));assert.equal(result.outcome,'captured');
});
test('one scoped private job reaches actual Node/Python/API storage/readback and saved parent/child export',async()=>{
 const f=await privateHostFixture();
 try{
  f.plan.traceId='synthetic-selected';f.submit.fingerprint=planCustomerImport(f.plan,alphaProject(f.submit.tenant).id).plan.fingerprint;
  const selected=[row('root',f.plan.traceId),row('child',f.plan.traceId)].map(r=>({...r,projectId:f.plan.sourceProject,environment:f.plan.environment})),database=[...selected,{...selected[0],id:'unselected',traceId:'another-trace'}];
  const prior=f.options.sourceBroker;f.options.sourceBroker=async d=>{assert.equal(d.request.traceId,f.plan.traceId);return{...await prior(d),traceId:f.plan.traceId};};
  const reads=[];f.options.sourceFetch=async url=>{if(url.endsWith('/projects'))return response({data:[{id:f.plan.sourceProject}]});const u=new URL(url);reads.push(u);assert.equal(u.searchParams.get('traceId'),f.plan.traceId);return response({data:database.filter(r=>r.traceId===u.searchParams.get('traceId')),meta:{cursor:null}});};
  const host=createPrivateImportHost(f.options),job=await host.submit(f.submit),result=await host.runOne(f.submit.tenant,job.job_id);assert.equal(result.receipt.export_verified,true);assert.equal(result.receipt.matched_events,2);const archive=JSON.parse(readFileSync(result.exportPath)),observations=archive.runs.flatMap(r=>r.events.map(e=>e.data.observation));assert.equal(observations.length,2);assert.ok(observations.every(r=>r.traceId===f.plan.traceId));assert.equal(observations.find(r=>r.id==='child').parentObservationId,'root');assert.equal(f.saved.size,2);assert.equal(reads.length,1);
  const dispatch=await host.status(f.submit.tenant,job.job_id);assert.equal(dispatch.dispatch.export_verified,true);
 }finally{f.close();}
});
test('trace selection does not repurpose an existing window job or relax legacy/overlap fences',async()=>{
 const f=await privateHostFixture();try{const ledger=new ImportJobLedger(f.store,{objects:f.objects,parentSession:f.parentSession}),first=await ledger.create(f.submit.tenant,f.plan,f.submit.fingerprint),scope={...f.plan,traceId:'selected'};const next=planCustomerImport(scope,alphaProject(f.submit.tenant).id).plan;await assert.rejects(ledger.create(f.submit.tenant,scope,next.fingerprint),e=>e.code==='import_job_scope_conflict');assert.equal((await ledger.load(f.submit.tenant,first.job_id)).fingerprint,f.submit.fingerprint);}finally{f.close();}
});

test('different pinned traces in overlapping windows share the existing conservative registry hold',async()=>{
 const f=await privateHostFixture();try{
  const ledger=new ImportJobLedger(f.store,{objects:f.objects,parentSession:f.parentSession}),first={...f.plan,traceId:'first'},second={...first,traceId:'second',from:'2026-10-01T01:00:00Z',namespace:'different'};
  const create=async scope=>ledger.create(f.submit.tenant,scope,planCustomerImport(scope,alphaProject(f.submit.tenant).id).plan.fingerprint,f.descriptor);
  const reserve=async(job,id)=>reserveImportDispatch(ledger,await loadImportDispatch(ledger,f.submit.tenant,job.job_id),{legacyProvider:async()=>f.baseline,authorize:async()=>true,onBeforeWrite:async()=>true,execution_id:id.repeat(64)});
  await reserve(await create(first),'1');await assert.rejects(reserve(await create(second),'2'),e=>e.code==='private_registry_overlap_or_legacy_hold');
  assert.deepEqual(f.counts(),{sourceRequests:0,destinationRequests:0,leases:0});
 }finally{f.close();}
});

test('a provider ignoring the trace selector cannot reach API storage or a saved export',async()=>{
 const f=await privateHostFixture();try{
  f.plan.traceId='selected';f.submit.fingerprint=planCustomerImport(f.plan,alphaProject(f.submit.tenant).id).plan.fingerprint;f.sourceRows[0].traceId='foreign';const prior=f.options.sourceBroker;f.options.sourceBroker=async d=>({...await prior(d),traceId:f.plan.traceId});
  const host=createPrivateImportHost(f.options),job=await host.submit(f.submit);await assert.rejects(host.runOne(f.submit.tenant,job.job_id));
  assert.equal(f.saved.size,0);assert.equal(f.counts().destinationRequests,0);assert.equal(f.counts().leases,0);assert.equal(existsSync(f.directory+'/'+job.job_id+'/import-export.json'),false);assert.equal(existsSync(f.directory+'/.private-host.lock'),true);
 }finally{f.close();}
});
test('a foreign later page retains only the earlier validated checkpoint',async()=>{
 let page=0;const saved=[];await assert.rejects(captureLangfuseWithTransport(spec,options(async url=>response(url.endsWith('/projects')?{data:[{id:spec.sourceProject}]}:{data:[row(page++?'child':'root',page===1?spec.traceId:'foreign')],meta:{cursor:page===1?'cursor':null}}),{saveCheckpoint:async state=>saved.push(structuredClone(state))})),/observation_scope/);
 assert.equal(saved.length,1);assert.equal(saved[0].pages.length,1);assert.equal(saved[0].complete,false);assert.ok(saved[0].pages[0].data.every(r=>r.traceId===spec.traceId));
});
