import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runPrivateLangfuseWorkflow} from '../src/importers/private-langfuse-runtime.mjs';
import {planCapture,captureLangfuse,approveCapturedStage} from '../src/importers/langfuse-capture.mjs';
import {createLangfuseTransport,captureLangfuseWithTransport,TRANSPORT_CREDENTIAL_SENTINEL} from '../src/importers/langfuse-transport.mjs';
const base={origin:'https://us.cloud.langfuse.com',sourceProject:'synthetic-source',destinationProject:'synthetic-target',namespace:'synthetic-environment',from:'2026-10-01T00:00:00Z',to:'2026-10-02T00:00:00Z',maxRows:2,maxPages:2,pageSize:2,maxBytes:100000,maxRetries:0};
const spec={...base,environment:'sdk-experiment'};
const bounds={requestTimeoutMs:1000,totalTimeoutMs:10000,maxRequests:4,maxResponseBytes:100000,maxTotalBytes:200000};
const row={id:'synthetic-observation',traceId:'synthetic-trace',projectId:spec.sourceProject,environment:spec.environment,startTime:'2026-10-01T12:00:00Z',input:{synthetic:true}};
const response=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
const page=(value=row)=>({data:[value],meta:{cursor:null}});
const options=(fetchImpl,extra={})=>({bounds,fetchImpl,authorize:async()=>true,credentialProvider:async()=>({origin:spec.origin,projectId:spec.sourceProject,publicKey:'synthetic-public',secretKey:'synthetic-secret',expiresAt:Date.now()+60000}),...extra});
const target=(scope=spec)=>{const plan=planCapture(scope),url=new URL('/api/public/v2/observations',scope.origin);url.search=new URLSearchParams({fromStartTime:scope.from,toStartTime:scope.to,fields:plan.fields,limit:'2',...(scope.environment!==undefined?{environment:scope.environment}:{})});return {method:'GET',url:url.href,redirect:'error',headers:{Authorization:TRANSPORT_CREDENTIAL_SENTINEL}};};
test('environment is explicit, fingerprint-bound and absence preserves old scope',()=>{
 assert.equal(planCapture(spec).scope.environment,'sdk-experiment');
 assert.notEqual(planCapture(spec).fingerprint,planCapture(base).fingerprint);
 assert.notEqual(planCapture(spec).fingerprint,planCapture({...spec,environment:'other'}).fingerprint);
 for(const environment of [undefined,null,'',' space','space ',['sdk-experiment'],'x\nother','x'.repeat(201)])assert.throws(()=>planCapture({...base,environment}),/explicit_environment/);
 assert.equal(Object.hasOwn(planCapture(base).scope,'environment'),false);
});
test('exact environment reaches query and every authorization descriptor without stage or provider access',async()=>{
 const urls=[],permissions=[];
 const result=await captureLangfuseWithTransport(spec,options(async url=>{urls.push(url);return response(url.endsWith('/projects')?{data:[{id:spec.sourceProject}]}:page());},{authorize:async descriptor=>{permissions.push(descriptor);return true;}}));
 assert.equal(result.outcome,'captured');assert.equal(urls.length,2);
 assert.equal(new URL(urls[1]).searchParams.get('environment'),spec.environment);
 assert.ok(permissions.every(value=>value.environment===spec.environment));
 assert.deepEqual(result.conversion.batches[0].events[0].data.observation,row);
});
test('missing changed duplicate or unauthorized environment query fails before hooks',async()=>{
 for(const edit of [url=>url.searchParams.delete('environment'),url=>url.searchParams.set('environment','other'),url=>url.searchParams.append('environment','other')]) {
  let calls=0;const transport=createLangfuseTransport(spec,options(async()=>{calls++;throw Error('no_wire');},{authorize:async()=>{calls++;return true;},credentialProvider:async()=>{calls++;}}));
  const request=target(),url=new URL(request.url);edit(url);request.url=url.href;
  await assert.rejects(transport.request(request),/environment_scope|query_refused/);assert.equal(calls,0);transport.close();
 }
 const unscoped=createLangfuseTransport(base,options(async()=>assert.fail('wire')));
 await assert.rejects(unscoped.request(target()),/environment_scope/);unscoped.close();
});
test('foreign or absent row environment never saves a checkpoint or stages',async()=>{
 for(const environment of ['foreign',undefined]) {
  let saved=0;await assert.rejects(captureLangfuseWithTransport(spec,{...options(async url=>response(url.endsWith('/projects')?{data:[{id:spec.sourceProject}]}:page({...row,environment}))),saveCheckpoint:async()=>{saved++;}}),/observation_scope/);assert.equal(saved,0);
 }
});
test('generic capture, checkpoint replay and destination approval revalidate environment',async()=>{
 const low={credential:'synthetic-ephemeral',approve:async()=>true,transport:async req=>{assert.equal(new URL(req.url).searchParams.get('environment'),spec.environment);return {status:200,body:JSON.stringify(page())};}};
 const captured=await captureLangfuse(spec,low);
 await assert.rejects(captureLangfuse({...spec,environment:'other'},{...low,checkpoint:captured.state,transport:async()=>assert.fail('wire')}),/checkpoint_scope/);
 let calls=0;const replay=await captureLangfuse(spec,{...low,checkpoint:captured.state,transport:async()=>{calls++;assert.fail('wire');}});assert.equal(calls,0);assert.equal(replay.outcome,'captured');
 captured.state.pages[0].data[0].environment='foreign';
 await assert.rejects(approveCapturedStage(captured,async()=>true),/source_environment/);
});
test('environment-scoped private runtime reaches actual retained local stager',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'supatrace-env-stage-'));
 try {
  const result=await runPrivateLangfuseWorkflow(spec,{directory,...options(async url=>response(url.endsWith('/projects')?{data:[{id:spec.sourceProject}]}:page()))});
  assert.equal(result.outcome,'locally-staged');assert.equal(result.uploaded,false);
  assert.equal(result.stageReceipt.fingerprint,planCapture(spec).fingerprint);
  assert.equal(result.workflow.capture.manifest.scope.environment,spec.environment);
 } finally {rmSync(directory,{recursive:true,force:true});}
});
test('environment-aware source denial stops before credential lookup or fake wire',async()=>{
 let calls=0;
 await assert.rejects(captureLangfuseWithTransport(spec,options(async()=>{calls++;assert.fail('wire');},
  {authorize:async descriptor=>descriptor.environment==='different-approved-environment',credentialProvider:async()=>{calls++;assert.fail('credential');}})),/not_authorized/);
 assert.equal(calls,0);
});
