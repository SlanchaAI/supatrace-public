import test from 'node:test';
import assert from 'node:assert/strict';
import {saveWorkspaceArchive,prepareWorkspaceArchive} from '../public/app/workspace-export.js';
const project='proj_'+'a'.repeat(32),envs=[{id:'default',name:'Default',legacy:true},{id:'dev',name:'Development',legacy:false}];
const row=()=>({id:'same-run',event_count:2,batch_count:1,created_at:'2026-11-06T00:00:00Z'});
function fixture(){
 const chunks=[],reads=[],events=environment=>[0,1].map(i=>({id:'span-'+i,time:'2026-11-06T00:00:00Z',kind:'note',name:'Original',data:{environment,parent_id:i?'span-0':null,original:[0,false,null,'café']}}));
 let closes=0,aborts=0,picks=0;
 const options={workspaceId:'github-1',projectId:project,environmentIds:['default','dev'],signal:new AbortController().signal,now:()=> '2026-11-06T00:00:00Z',
  pick:()=>{picks++;return {createWritable:async()=>({write:async text=>chunks.push(text),close:async()=>{closes++;},abort:async()=>{aborts++;}})};},
  loadEnvironments:async()=>structuredClone(envs),loadCatalog:async environment=>{reads.push(environment);return [row()];},
  writeRun:async(environment,id,signal,sink)=>{assert.equal(id,'same-run');await sink(events(environment));return {events:2,batches:1};}};
 return {options,chunks,reads,events,counts:()=>({closes,aborts,picks})};
}
test('full workspace streaming and standard archives preserve identical IDs/parents separately per environment',async()=>{
 const f=fixture(),result=await saveWorkspaceArchive(f.options),archive=JSON.parse(f.chunks.join(''));
 assert.deepEqual(result,{environments:2,runs:2,events:4,consistency:'observed_stable_before_after_all_environments_not_a_snapshot'});
 assert.equal(archive.version,3);assert.equal(archive.complete,true);assert.equal(archive.workspace_id,'github-1');assert.equal(archive.project_id,project);
 assert.deepEqual(archive.environments.map(e=>e.metadata.id),['default','dev']);
 for(const environment of archive.environments){assert.deepEqual(environment.archive.runs[0].events,f.events(environment.metadata.id));assert.equal(environment.archive.runs[0].metadata.id,'same-run');}
 assert.deepEqual(f.reads,['default','default','dev','dev','default','dev']);
 const standard=await prepareWorkspaceArchive(fixture().options);assert.equal(await standard.blob.text(),f.chunks.join(''));assert.equal(standard.bytes,Buffer.byteLength(f.chunks.join('')));
 assert.deepEqual(f.counts(),{closes:1,aborts:0,picks:1});
});
test('scope must match the reviewed environment IDs before any trace is read',async()=>{
 for(const ids of [['default'],['default','dev','prod']]){
  const f=fixture();await assert.rejects(saveWorkspaceArchive({...f.options,environmentIds:ids}),/account_export_changed/);
  assert.deepEqual(f.reads,[]);assert.equal(f.counts().closes,0);
 }
 for(const inventory of [[],[{id:'dev',name:'Dev',legacy:false}], [...envs,envs[1]], [{...envs[0],name:'bad\nname'}], [{...envs[0],id:'../bad'}]]){
  const f=fixture();await assert.rejects(saveWorkspaceArchive({...f.options,loadEnvironments:async()=>inventory}),/account_export_incomplete/);assert.deepEqual(f.reads,[]);
 }
});
test('added/removed/renamed environments abort the whole temporary archive rather than silently changing scope',async()=>{
 for(const after of [[envs[0]], [...envs,{id:'prod',name:'Prod',legacy:false}], [envs[0],{...envs[1],name:'Renamed'}]]){
  const f=fixture();let calls=0;await assert.rejects(saveWorkspaceArchive({...f.options,loadEnvironments:async()=>++calls===1?envs:after}),/account_export_changed/);
  assert.deepEqual(f.counts(),{closes:0,aborts:1,picks:1});
 }
});
test('final sweep detects mutation in an earlier environment while a later environment was exported',async()=>{
 const f=fixture();let reads=0;
 await assert.rejects(saveWorkspaceArchive({...f.options,loadCatalog:async environment=>{if(environment==='default'&&++reads===3)return [{...row(),event_count:3}];return [row()];}}),/account_export_changed/);
 assert.equal(f.counts().closes,0);assert.equal(f.counts().aborts,1);
});
test('one inaccessible scope or event/count mismatch fails the full archive; no partial success',async()=>{
 for(const type of ['access','count']){
  const f=fixture(),original=f.options.writeRun;
  await assert.rejects(saveWorkspaceArchive({...f.options,writeRun:async(environment,...args)=>{
   if(environment==='dev'){if(type==='access')throw Error('private forbidden detail');return {events:0,batches:0};}return original(environment,...args);
  }}),type==='access'?/account_export_read_failed/:/account_export_changed/);
  assert.equal(f.counts().closes,0);assert.equal(f.counts().aborts,1);
 }
});
test('standard download limits apply across all environments including the outer envelope',async()=>{
 const complete=await prepareWorkspaceArchive(fixture().options);
 for(const maxBytes of [100,complete.bytes-1])await assert.rejects(prepareWorkspaceArchive({...fixture().options,maxBytes}),/account_export_too_large/);
 await assert.rejects(prepareWorkspaceArchive({...fixture().options,maxEvents:3}),/account_export_too_large/);
 assert.equal((await prepareWorkspaceArchive({...fixture().options,maxBytes:complete.bytes,maxEvents:4})).bytes,complete.bytes);
});
test('aggregate catalog metadata is bounded across environments',async()=>{
 const f=fixture(),large={...row(),padding:'x'.repeat(11*1024*1024)};
 await assert.rejects(saveWorkspaceArchive({...f.options,loadCatalog:async()=>[large]}),/account_export_too_large/);
 assert.equal(f.counts().closes,0);assert.equal(f.counts().aborts,1);
});
test('empty environments are explicit, and scope order alone does not create drift',async()=>{
 const f=fixture();let calls=0;const result=await saveWorkspaceArchive({...f.options,loadEnvironments:async()=>++calls===1?envs:[...envs].reverse(),loadCatalog:async()=>[]});
 assert.equal(result.events,0);assert.equal(result.runs,0);assert.equal(result.environments,2);
 assert.ok(JSON.parse(f.chunks.join('')).environments.every(e=>e.archive.complete&&e.archive.run_count===0));
});
test('cancel and write failures abort; uncertain close is never called rolled back',async()=>{
 const f=fixture(),controller=new AbortController();
 await assert.rejects(saveWorkspaceArchive({...f.options,signal:controller.signal,onProgress:()=>controller.abort()}),/export_file_cancelled/);
 assert.equal(f.counts().aborts,1);assert.equal(f.counts().closes,0);
 for(const phase of ['write','close']){
  let aborted=0;const g=fixture();await assert.rejects(saveWorkspaceArchive({...g.options,pick:()=>({createWritable:async()=>({
   write:async()=>{if(phase==='write')throw Error('private-disk-detail');},close:async()=>{throw Error('private-close-detail');},abort:async()=>{aborted++;}
  })})}),/export_file_unconfirmed/);assert.equal(aborted,phase==='write'?1:0);
 }
});
test('fast picker denial allows fallback without discovery, and late selection is never opened',async()=>{
 const f=fixture();await assert.rejects(saveWorkspaceArchive({...f.options,pick:()=>{throw Object.assign(Error(),{name:'AbortError'});}}),/export_picker_unavailable/);
 assert.deepEqual(f.reads,[]);
 let release,opened=0;const controller=new AbortController(),g=fixture(),work=saveWorkspaceArchive({...g.options,signal:controller.signal,pick:()=>new Promise(resolve=>release=resolve)});
 controller.abort();await assert.rejects(work,/export_file_cancelled/);release({createWritable:async()=>{opened++;}});await new Promise(r=>setImmediate(r));assert.equal(opened,0);assert.deepEqual(g.reads,[]);
});

for(const code of ['export_rate_limited','export_read_deadline'])for(const cleanup of ['success','reject','hang'])test(`workspace child ${code} with ${cleanup} outer abort preserves cleanup precedence`,async()=>{
 const f=fixture();let aborts=0,closes=0,reads=0;
 const work=saveWorkspaceArchive({...f.options,fileTimeoutMs:20,
  pick:()=>({createWritable:()=>({write:async()=>{},close:async()=>{closes++;},abort:()=>{
   aborts++;if(cleanup==='reject')throw Error('PRIVATE_ABORT_DETAIL');if(cleanup==='hang')return new Promise(()=>{});
  }})}),
  writeRun:async()=>{reads++;throw Error(code);}});
 await assert.rejects(work,error=>error.message===(cleanup==='success'?(code==='export_rate_limited'?'account_export_rate_limited':'account_export_read_deadline'):'export_file_unconfirmed'));
 assert.equal(reads,1);assert.equal(aborts,1);assert.equal(closes,0);
});
