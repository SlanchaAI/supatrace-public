import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {captureLangfuse,planCapture,createCaptureCheckpoint,validateCaptureCheckpoint,approveCapturedStage,reconcileCaptures} from '../src/importers/langfuse-capture.mjs';
import {LANGFUSE_SANITIZATION_POLICY as policy,pseudonymizeLangfuseId} from '../src/importers/langfuse-sanitization.mjs';
import {hash} from '../src/importers/langfuse.mjs';
import {planCustomerImport} from '../src/import-planning.mjs';
import {pullFixture,credentials,spec as pullSpec} from './server-pull-fixture.mjs';
const base={origin:'https://cloud.langfuse.com',sourceProject:'synthetic-source-project',destinationProject:'isolated-test',environment:'sdk-experiment',traceId:'trace-f01',namespace:'synthetic-sanitization',from:'2026-10-28T18:33:42Z',to:'2026-10-28T18:33:43Z',maxRows:10,maxPages:4,pageSize:4,maxBytes:100000,maxRetries:0};
const spec={...base,sanitizationPolicy:policy};
// Historical scrubbed synthetic data only. No raw source IDs or private mapping.
const fixture=JSON.parse(readFileSync(new URL('./fixtures/langfuse-sanitization-f01.json',import.meta.url)));
const forbiddenValues=['SYNTHETIC_USER_REDACT','SYNTHETIC_SESSION_REDACT','SYNTHETIC_RUN_REDACT','SYNTHETIC_HISTORICAL_PUBLIC_REDACT','SYNTHETIC_INSTANCE_REDACT'];
const sourceRows=()=>fixture.data.map(row=>({...structuredClone(row),projectId:spec.sourceProject,userId:forbiddenValues[0],sessionId:forbiddenValues[1],metadata:{...row.metadata,experiment_run_name:forbiddenValues[2],'scope.attributes.public_key':forbiddenValues[3],'resourceAttributes.service.instance.id':forbiddenValues[4]}}));
const page=(data,cursor=null,extra={})=>({data,meta:{cursor,...extra},extra:forbiddenValues[0]});
const options=(data=sourceRows())=>({credential:'synthetic-capture-authorization',approve:async()=>true,transport:async()=>({status:200,body:JSON.stringify(page(data))})});
const storedText=value=>JSON.stringify(value);
function assertClean(value){for(const secret of [spec.sourceProject,...forbiddenValues])assert.equal(storedText(value).includes(secret),false,secret);}
function topology(rows){assert.equal(rows.length,4);assert.equal(new Set(rows.map(r=>r.traceId)).size,1);const root=rows.filter(r=>!r.parentObservationId);assert.equal(root.length,1);const ids=new Set(rows.map(r=>r.id));assert.equal(rows.filter(r=>r.parentObservationId===root[0].id).length,2);assert.equal(rows.filter(r=>r.parentObservationId).length,3);for(const r of rows)if(r.parentObservationId)assert(ids.has(r.parentObservationId));}

test('in-app policy changes fingerprint and exact disclosure; legacy capture is unchanged',()=>{
 assert.notEqual(planCapture(spec).fingerprint,planCapture(base).fingerprint);assert.equal(planCapture(spec).sanitization.policy,policy);assert.equal(planCapture(spec).sanitization.before_checkpoint,true);
 assert.equal(planCapture(base).sanitization,undefined);assert.equal(createCaptureCheckpoint(base).schema_version,1);
 for(const value of [undefined,null,'raw','langfuse-structured-v0'])assert.throws(()=>planCapture({...base,sanitizationPolicy:value}),/invalid_sanitization/);
 const {destinationProject,...source}=spec,project='proj_'+'a'.repeat(32);
 assert.throws(()=>planCustomerImport({provider:'langfuse',...source},project),/invalid_import_plan/);
 assert.equal(planCustomerImport({provider:'langfuse',...source},project,{serverPull:true}).plan.scope.sanitizationPolicy,policy);
 assert.throws(()=>planCustomerImport({provider:'langfuse',...source,sanitizationPolicy:'raw'},project,{serverPull:true}),/invalid_import_plan/);
});
test('f01 is sanitized before checkpoint and conversion; four rows, topology and content survive',async()=>{
 const original=sourceRows(),snapshot=structuredClone(original),saves=[];
 const r=await captureLangfuse(spec,{...options(original),saveCheckpoint:async s=>{assertClean(s);saves.push(s);}});
 assert.equal(saves.length,1);assert.equal(r.state.schema_version,2);assertClean(r.state);assertClean(r.conversion);
 const rows=r.state.pages[0].data;topology(rows);topology(r.conversion.batches.map(b=>b.events[0].data.observation));
 assert.deepEqual(rows.map(r=>r.input),original.map(r=>r.input));assert.deepEqual(rows.map(r=>r.output),original.map(r=>r.output));assert.deepEqual(original,snapshot);
 assert.equal(r.conversion.batches.length,4);assert.equal(r.conversion.report.acceptedTraces,1);assert.equal(r.conversion.report.rejected.length,0);assert.equal(r.conversion.report.warnings.filter(w=>w?.reason==='parent_not_present').length,0);
 assert.deepEqual(r.state.pages[0].meta,{cursor:null});assert.deepEqual(Object.keys(r.state.pages[0]).sort(),['data','meta']);
 assert.equal((await approveCapturedStage(r,async()=>true)).approved,true);
});
test('nested, flattened and mixed dotted forms are removed; nested structured references map consistently',async()=>{
 const row=sourceRows()[0];row.metadata={...row.metadata,
  scope:{attributes:{public_key:forbiddenValues[3],keep:42}},'scope.attributes':{public_key:forbiddenValues[3]},
  resourceAttributes:{service:{'instance.id':forbiddenValues[4],name:'synthetic'}},'resourceAttributes.service':{instance:{id:forbiddenValues[4]}},
  deep:{project_id:spec.sourceProject,user_id:forbiddenValues[0],session_id:forbiddenValues[1],experiment_run_name:forbiddenValues[2]},
  'deep.projectId':spec.sourceProject,'deep.user_id':forbiddenValues[0],
  'reference.trace_id':row.traceId,observationId:row.id,dataset_id:'synthetic-dataset',dataset_item_id:'synthetic-item'};
 row.trace_context={traceId:row.traceId,spanId:row.id,parentSpanId:null};
 const result=await captureLangfuse(spec,options([row]));assertClean(result.state);assertClean(result.conversion);
 const saved=result.state.pages[0].data[0];assert.equal(saved.metadata.scope.attributes.keep,42);assert.equal(saved.metadata['reference.trace_id'],saved.traceId);assert.equal(saved.trace_context.traceId,saved.traceId);assert.equal(saved.trace_context.spanId,saved.id);assert.equal(saved.metadata.observationId,saved.id);assert.match(saved.metadata.dataset_id,/^lf_dataset_[a-f0-9]{64}$/);assert.match(saved.metadata.dataset_item_id,/^lf_item_[a-f0-9]{64}$/);
});
test('two pages interrupted after checkpoint resume with no raw ID map and stable deterministic output',async()=>{
 const original=sourceRows();let saved,calls=0;
 await assert.rejects(captureLangfuse({...spec,pageSize:2},{...options(),transport:async()=>{calls++;return {status:200,body:JSON.stringify(page(original.slice(0,2),'synthetic-cursor'))};},saveCheckpoint:async s=>{saved=s;assertClean(s);throw Error('synthetic interruption');}}),/synthetic interruption/);
 assert.equal(calls,1);const resumed=await captureLangfuse({...spec,pageSize:2},{...options(),checkpoint:saved,transport:async request=>{calls++;assert.equal(new URL(request.url).searchParams.get('cursor'),'synthetic-cursor');return {status:200,body:JSON.stringify(page(original.slice(2)))};}});
 assert.equal(calls,2);topology(resumed.state.pages.flatMap(p=>p.data));assertClean(resumed.state);assert.equal(validateCaptureCheckpoint(resumed.state,{...spec,pageSize:2}),4);
 const complete=await captureLangfuse(spec,options(original));assert.deepEqual(resumed.conversion,complete.conversion);assert.equal(reconcileCaptures(resumed,resumed).unchanged,4);assert.throws(()=>reconcileCaptures(complete,resumed),/reconciliation_scope/);
 const noFetch=await captureLangfuse({...spec,pageSize:2},{...options(),checkpoint:resumed.state,transport:async()=>assert.fail('completed checkpoint must not fetch')});assert.deepEqual(noFetch.conversion,resumed.conversion);
});
test('legacy, raw, altered policy, extra-envelope and source-changed checkpoints fail before fetch or save',async()=>{
 const result=await captureLangfuse(spec,options());
 const mutations=[s=>s.schema_version=1,s=>s.sanitizationPolicy='other',s=>s.sourceBytes=-1,s=>s.secret='unlisted',s=>s.pages[0].extra='unlisted',s=>s.pages[0].meta.debug='unlisted',s=>s.pages[0].data[0].projectId=spec.sourceProject,s=>s.pages[0].data[0].traceId='trace-f01',s=>s.pages[0].data[0].metadata.scope={attributes:{public_key:'unrelated-key'}},s=>s.pages[0].data[0].id='raw-id'];
 for(const change of mutations){const state=structuredClone(result.state);change(state);let calls=0,saves=0;await assert.rejects(captureLangfuse(spec,{...options(),checkpoint:state,transport:async()=>{calls++;},saveCheckpoint:async()=>{saves++;}}));assert.equal(calls,0);assert.equal(saves,0);}
 const legacy=await captureLangfuse(base,options());await assert.rejects(captureLangfuse(spec,{...options(),checkpoint:legacy.state,transport:async()=>assert.fail('fetch')}),/checkpoint_scope/);
 await assert.rejects(captureLangfuse({...spec,sourceProject:'another-source'},{...options(),checkpoint:result.state,transport:async()=>assert.fail('fetch')}),/checkpoint_scope/);
});
test('wrong project/environment/trace/window fails before sanitization can erase evidence',async()=>{
 for(const change of [{projectId:'foreign'},{environment:'foreign'},{traceId:'f02'},{startTime:spec.to}]){let saved=0;await assert.rejects(captureLangfuse(spec,{...options([{...sourceRows()[0],...change}]),saveCheckpoint:async()=>{saved++;}}));assert.equal(saved,0);}
});
test('raw byte totals remain bounded after redaction shrinks source pages',async()=>{
 const narrow={...spec,pageSize:1,maxBytes:10000};let count=0,saves=0;
 await assert.rejects(captureLangfuse(narrow,{...options(),transport:async()=>({status:200,body:JSON.stringify(page([{...sourceRows()[count++],userId:'X'.repeat(4800)}],count===1?'more':null))}),saveCheckpoint:async s=>{saves++;assert(s.sourceBytes>4800);}}),/capture_bound/);
 assert.equal(count,2);assert.equal(saves,1);
});
test('active credential echoes are rejected even if sanitizer would drop the echoed field',async()=>{
 let writes=0;const opts=options();await assert.rejects(captureLangfuse(spec,{...opts,transport:async()=>({status:200,body:JSON.stringify(page([{...sourceRows()[0],userId:opts.credential}]))}),saveCheckpoint:async()=>{writes++;}}),/credential_in_capture/);assert.equal(writes,0);
});
test('pseudonyms preserve raw IDs starting with pseudonym prefix without collision or trusting source labels',()=>{
 const a=pseudonymizeLangfuseId('one','observation',spec),b=pseudonymizeLangfuseId(a,'observation',spec);assert.notEqual(a,b);assert.notEqual(a,pseudonymizeLangfuseId('one','trace',spec));assert.notEqual(a,pseudonymizeLangfuseId('one','observation',{...spec,sourceProject:'different'}));
});
test('actual in-app journal and immutable output never receive prohibited row fields; reloaded run matches converted run',async()=>{
 const f=await pullFixture(),rows=sourceRows().map(r=>({...r,projectId:pullSpec.sourceProject,traceId:pullSpec.traceId,environment:pullSpec.environment,startTime:'2026-10-01T12:00:00Z'}));
 f.provider(async url=>Response.json(url.endsWith('/projects')?{data:[{id:pullSpec.sourceProject}]}:page(rows)));
 const journals=[],send=f.client.send.bind(f.client);f.client.send=async cmd=>{for(const item of cmd.input?.TransactItems??[])if(item.Put?.Item?.sk?.startsWith('SERVERPULL#'))journals.push(structuredClone(item.Put.Item));return send(cmd);};
 const review=await f.consent();assert.equal(review.disclosure.sanitization.policy,policy);await f.ok('start');await f.advance();f.env.serverPullController=f.compose().serverPullController;
 let status;for(let i=0;i<32;i++){status=await f.advance();if(status.status==='complete')break;}
 assert.equal(status.status,'complete');assert.equal(f.fetches(),2);assert.equal(f.puts(),4);
 for(const journal of journals){assertClean(journal.checkpoint);assert.equal(JSON.stringify(journal.checkpoint).includes(pullSpec.sourceProject),false);assert.equal(journal.schema_version,2);}
 const batches=[...f.saved.values()].map(JSON.parse);for(const batch of batches){assertClean(batch);assert.equal(batch.run_id,status.run_id);assert.equal(JSON.stringify(batch).includes(pullSpec.sourceProject),false);}
 topology(batches.map(b=>b.events[0].data.observation));assert.equal([...new Set(batches.map(b=>b.run_id))].length,1);
});
test('in-app validation rejects a recomputed journal hash around unsanitized checkpoint before any mutation',async()=>{
 const f=await pullFixture();await f.consent();await f.ok('start');await f.advance();
 f.stored().checkpoint.pages[0].data[0].sessionId='not-safe';f.stored().checkpoint_hash=hash(f.stored().checkpoint);
 const fetches=f.fetches(),version=f.stored().version;assert.equal((await f.api('pull/advance',{...f.fp,credentials})).status,409);assert.equal(f.fetches(),fetches);assert.equal(f.stored().version,version);assert.equal(f.puts(),0);
});

test('legacy plan endpoint retains old fingerprint while explicit pull planning binds sanitization',async()=>{
 const f=await pullFixture(),legacy=await f.api('plan',pullSpec),pull=await f.api('pull/plan',pullSpec);
 assert.equal(legacy.status,200);assert.equal(legacy.body.plan.fingerprint,planCustomerImport(pullSpec,f.input.scope.destinationProject).plan.fingerprint);assert.equal(legacy.body.plan.scope.sanitizationPolicy,undefined);
 assert.equal(pull.status,200);assert.equal(pull.body.plan.fingerprint,f.fp.fingerprint);assert.equal(pull.body.plan.scope.sanitizationPolicy,policy);
 assert.equal((await f.api('pull/review',{fingerprint:legacy.body.plan.fingerprint,plan:pullSpec})).status,400);assert.equal(f.fetches(),0);
 delete f.env.serverPullController;assert.equal((await f.api('pull/plan',pullSpec)).status,503);
});
test('full transport rejects an active public-key echo before redaction and writes no source checkpoint',async()=>{
 const f=await pullFixture();f.provider(async url=>Response.json(url.endsWith('/projects')?{data:[{id:pullSpec.sourceProject}]}:{data:[{...f.row(),metadata:{'scope.attributes.public_key':credentials.publicKey}}],meta:{cursor:null}}));
 await f.consent();await f.ok('start');assert.equal((await f.api('pull/advance',{...f.fp,credentials})).status,503);assert.equal(f.stored().checkpoint.pages.length,0);assert.equal(f.puts(),0);assert.equal(JSON.stringify([...f.client.items.values()]).includes(credentials.publicKey),false);
});
test('equivalent OTEL key/value attribute entries are removed before checkpoint',async()=>{
 const row=sourceRows()[0];row.metadata={scope:{attributes:[{key:'public_key',value:{stringValue:forbiddenValues[3]}},{key:'version',value:'synthetic'}]},resourceAttributes:[{key:'service.instance.id',value:forbiddenValues[4]},{key:'service.name',value:'synthetic'}]};
 const r=await captureLangfuse(spec,options([row]));assertClean(r.state);assert.deepEqual(r.state.pages[0].data[0].metadata.scope.attributes,[{key:'version',value:'synthetic'}]);assert.deepEqual(r.state.pages[0].data[0].metadata.resourceAttributes,[{key:'service.name',value:'synthetic'}]);
});

test('policy property is snapshotted once; hidden selection cannot silently fall back to raw capture',()=>{
 const hidden={...base};Object.defineProperty(hidden,'sanitizationPolicy',{value:policy});assert.equal(planCapture(hidden).scope.sanitizationPolicy,policy);
 assert.throws(()=>planCapture(Object.assign(Object.create({sanitizationPolicy:policy}),base)),/invalid_sanitization_policy/);
 let reads=0;const changing={...base};Object.defineProperty(changing,'sanitizationPolicy',{enumerable:true,get:()=>++reads===1?policy:'raw'});assert.equal(planCapture(changing).scope.sanitizationPolicy,policy);
});

test('conversion-incompatible nesting is rejected before checkpoint and prototype keys cannot alter objects',async()=>{
 let value='synthetic-leaf';for(let i=0;i<25;i++)value={nested:value};let saves=0;
 await assert.rejects(captureLangfuse(spec,{...options([{...sourceRows()[0],input:value}]),saveCheckpoint:async()=>{saves++;}}),/sanitization_nesting_bound/);assert.equal(saves,0);
 const row=sourceRows()[0];row.input=JSON.parse('{"__proto__":{"polluted":true,"sessionId":"SYNTHETIC_SESSION_REDACT"},"constructor":{"prototype":{"userId":"SYNTHETIC_USER_REDACT"}}}');
 const r=await captureLangfuse(spec,options([row]));assertClean(r.state);assert.equal({}.polluted,undefined);assert.equal(Object.getPrototypeOf(r.state.pages[0].data[0].input),Object.prototype);
});

test('structured identifier and null parent leaves obey the same converter depth boundary',async()=>{
 for(const leaf of [{dataset_id:'synthetic-dataset'},{parentSpanId:null}]){
  let nested=leaf;for(let i=0;i<23;i++)nested={nested};let saves=0;
  await assert.rejects(captureLangfuse(spec,{...options([{...sourceRows()[0],input:nested}]),saveCheckpoint:async()=>{saves++;}}),/sanitization_nesting_bound/);assert.equal(saves,0);
 }
});
