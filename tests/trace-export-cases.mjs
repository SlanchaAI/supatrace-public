import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {getEventListeners} from 'node:events';
import {runInNewContext} from 'node:vm';
import {saveTraceFile, TRACE_FILE_TIMEOUT_MS} from '../public/app/trace-export.js';
import {integrateTraceWriter} from './trace-export-integration.mjs';
const project = 'proj_' + 'a'.repeat(32);
const deferred = () => { let resolve, reject; const promise = new Promise((yes,no) => { resolve=yes; reject=no; }); return {promise,resolve,reject}; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const within = work => new Promise((resolve,reject) => {
  const timer=setTimeout(() => reject(Error('trace export stayed pending')),1500);
  Promise.resolve(work).then(value => {clearTimeout(timer);resolve(value);},error => {clearTimeout(timer);reject(error);});
});
const originals = Array.from({length:201},(_,i) => ({id:'event-'+i,time:'2026-11-05T00:00:00Z',kind:'note',name:'Synthetic original',
  extra:{untouched:true},data:{parent_id:i?'event-'+(i-1):null,nested:[0,false,null,'café'],api_key:'synthetic-only-preserve-original'}}));
function fixture(events=originals) {
  const state={chunks:[],aborts:0,closes:0,reads:0,picks:0,commits:0};
  const stream={write:async text=>state.chunks.push(text),abort:async()=>{state.aborts++;},close:async()=>{state.closes++;}};
  const options={runId:'trace-original',projectId:project,signal:new AbortController().signal,pick:()=>{state.picks++;return {createWritable:()=>stream};},
    readEvents:async(id,signal,sink,boundProject)=>{state.reads++;assert.equal(id,'trace-original');assert.equal(boundProject,project);for(let i=0;i<events.length;i+=100)await sink(events.slice(i,i+100));return {events:events.length};},
    onCommit:()=>{state.commits++;}};
  return {state,stream,options};
}

test('standalone trace writer preserves exact version-1 bytes, tied order and parent fields on repeated exports',async()=>{
  const snapshot=structuredClone(originals);
  for(let attempt=0;attempt<3;attempt++){
    const f=fixture();assert.equal(await saveTraceFile(f.options),201);
    assert.equal(f.state.chunks.join(''),JSON.stringify({version:1,run_id:'trace-original',events:originals}));
    assert.equal(f.state.closes,1);assert.equal(f.state.commits,1);assert.equal(f.state.aborts,0);
  }
  assert.deepEqual(originals,snapshot);
  const empty=fixture([]);assert.equal(await saveTraceFile(empty.options),0);assert.deepEqual(JSON.parse(empty.state.chunks.join('')).events,[]);
});

test('standalone trace streaming still exceeds 20 MiB with bounded individual writes',async()=>{
  const event={...originals[0],data:{text:'x'.repeat(32700)}};
  const f=fixture(Array.from({length:700},(_,i)=>({...event,id:'large-'+i})));
  assert.equal(await saveTraceFile(f.options),700);
  assert.ok(f.state.chunks.reduce((sum,text)=>sum+Buffer.byteLength(text),0)>20*1024*1024);
  assert.ok(Math.max(...f.state.chunks.map(text=>Buffer.byteLength(text)))<40000);
  assert.equal(JSON.parse(f.state.chunks.join('')).events.length,700);
});

test('trace creation and header/event/footer writes settle on cancel or deadline without late continuation',async()=>{
  for(const phase of ['create','header','event','footer'])for(const cancel of [false,true])for(const rejectLate of [false,true]){
    const f=fixture([originals[0]]),controller=new AbortController(),pending=deferred(),reached=deferred();
    const write=f.stream.write;
    f.stream.write=async text=>{await write(text);if(phase==='header'&&f.state.chunks.length===1||phase==='event'&&text.startsWith('{"id":')||phase==='footer'&&text===']}'){reached.resolve();await pending.promise;}};
    const work=saveTraceFile({...f.options,signal:controller.signal,fileTimeoutMs:20,pick:()=>({createWritable:()=>{if(phase==='create'){reached.resolve();return pending.promise;}return f.stream;}})});
    const rejected=assert.rejects(within(work),{message:cancel?'export_file_cancelled':'export_file_unconfirmed'});
    await reached.promise;if(cancel)controller.abort();await rejected;
    const writes=f.state.chunks.length,reads=f.state.reads;assert.equal(f.state.closes,0);assert.equal(f.state.commits,0);
    if(rejectLate)pending.reject(Error('private-late-native-error'));else pending.resolve(f.stream);
    await tick();await tick();assert.equal(f.state.chunks.length,writes);assert.equal(f.state.reads,reads);assert.equal(f.state.closes,0);
    assert.equal(f.state.aborts,phase==='create'?(rejectLate?0:1):1);
    assert.equal(await saveTraceFile(fixture([originals[0]]).options),1,'explicit new export succeeds');
  }
});

test('trace picker keeps the click gesture and selection time but cancellation discards late handles',async()=>{
  const f=fixture(),controller=new AbortController(),pending=deferred();let opened=0;
  const work=saveTraceFile({...f.options,signal:controller.signal,fileTimeoutMs:1,pick:()=>{f.state.picks++;return pending.promise;}});
  assert.equal(f.state.picks,1,'picker invoked synchronously');let settled=false;work.then(()=>settled=true,()=>settled=true);
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(settled,false,'no forced file-selection deadline');
  controller.abort();await assert.rejects(within(work),{message:'export_file_cancelled'});
  pending.resolve({createWritable:()=>{opened++;return f.stream;}});await tick();assert.equal(opened,0);assert.equal(f.state.reads,0);
});

test('trace abort failure or stall wins over cancellation and never reports rollback',async()=>{
  for(const hangs of [false,true]){
    const f=fixture(),controller=new AbortController(),pending=deferred();
    f.stream.write=async()=>controller.abort();f.stream.abort=()=>{f.state.aborts++;if(hangs)return pending.promise;throw Error('private abort error');};
    await assert.rejects(within(saveTraceFile({...f.options,signal:controller.signal,fileTimeoutMs:20})),{message:'export_file_unconfirmed'});
    assert.equal(f.state.aborts,1);assert.equal(f.state.closes,0);
    if(hangs){pending.reject(Error('private late abort'));await tick();}
  }
});

test('trace close timeout is uncertain even after cancellation and late success or failure cannot change it',async()=>{
  for(const rejectLate of [false,true]){
    const f=fixture(),controller=new AbortController(),pending=deferred(),closing=deferred();
    f.stream.close=()=>{f.state.closes++;closing.resolve();return pending.promise;};
    const work=saveTraceFile({...f.options,signal:controller.signal,fileTimeoutMs:20});
    const rejected=assert.rejects(within(work),{message:'export_file_unconfirmed'});
    await closing.promise;controller.abort();await rejected;
    assert.equal(f.state.aborts,0);assert.equal(f.state.closes,1);assert.equal(f.state.commits,1);
    if(rejectLate)pending.reject(Error('private late close'));else pending.resolve();await tick();
    assert.equal(f.state.aborts,0);assert.equal(f.state.closes,1);
  }
});

test('trace picker denial and pre-abort cannot open a stream or read events',async()=>{
  for(const denied of [false,true]){
    const f=fixture(),controller=new AbortController();if(!denied)controller.abort();
    await assert.rejects(saveTraceFile({...f.options,signal:controller.signal,pick:()=>{f.state.picks++;throw Object.assign(Error('private picker denial'),{name:'AbortError'});}}),{message:'export_file_cancelled'});
    assert.equal(f.state.picks,denied?1:0);assert.equal(f.state.reads,0);assert.equal(f.state.closes,0);
  }
});

test('trace writer aborts incomplete traversal, count mismatch and invalid JSON instead of committing partial output',async()=>{
  for(const readEvents of [async()=>{throw Error('private transport error');},async(_id,_signal,sink)=>{await sink(originals.slice(0,1));return {events:2};},async(_id,_signal,sink)=>{await sink([undefined]);return {events:1};},async(_id,_signal,sink)=>{await sink(null);return {events:0};}]){
    const f=fixture();await assert.rejects(saveTraceFile({...f.options,readEvents}),{message:'export_file_unconfirmed'});assert.equal(f.state.aborts,1);assert.equal(f.state.closes,0);assert.equal(f.state.commits,0);
  }
});

test('trace cancellation during commit preparation still aborts; confirmed close is not retroactively cancelled',async()=>{
  const before=fixture(),controller=new AbortController();await assert.rejects(saveTraceFile({...before.options,signal:controller.signal,onCommit:()=>controller.abort()}),{message:'export_file_cancelled'});assert.equal(before.state.closes,0);assert.equal(before.state.aborts,1);
  const closing=fixture(),late=new AbortController();closing.stream.close=async()=>{closing.state.closes++;late.abort();};assert.equal(await saveTraceFile({...closing.options,signal:late.signal}),201);assert.equal(closing.state.aborts,0);
});

test('trace writer validates bounds and scope before file access and cleans listeners and retained sinks',async()=>{
  for(const change of [{fileTimeoutMs:0},{fileTimeoutMs:TRACE_FILE_TIMEOUT_MS+1},{fileTimeoutMs:1.5},{projectId:null},{projectId:'other'},{runId:'../bad'}]){
    const f=fixture();await assert.rejects(saveTraceFile({...f.options,...change}),{message:'export_file_unconfirmed'});assert.equal(f.state.picks,0);
  }
  const controller=new AbortController();
  for(let i=0;i<3;i++){
    const f=fixture();let retained;
    await saveTraceFile({...f.options,signal:controller.signal,readEvents:async(...args)=>{retained=args[2];return f.options.readEvents(...args);}});
    assert.equal(getEventListeners(controller.signal,'abort').length,0);
    const writes=f.state.chunks.length;await assert.rejects(retained([originals[0]]),{message:'export_file_unconfirmed'});assert.equal(f.state.chunks.length,writes);
  }
});

test('staged app adapter pins the project before the picker and preserves its return/control contract',async()=>{
  const source=integrateTraceWriter(readFileSync(new URL('../public/app/app.js',import.meta.url),'utf8'));
  const start=source.indexOf('async function saveRunFile('),end=source.indexOf('\nfunction cancelDetailLoad',start);
  const f=fixture(),nodes=new Map(),context={activeProject:project,activeEnvironment:'default',activeWorkspace:'github-4242',saveTraceFile,allEvents:(...args)=>{assert.equal(args[4].environmentId,'default');assert.equal(args[4].workspaceId,'github-4242');return f.options.readEvents(...args);},$:id=>{if(!nodes.has(id))nodes.set(id,{});return nodes.get(id);}};
  const save=runInNewContext(source.slice(start,end)+';saveRunFile',context);
  assert.equal(await save('trace-original',f.options.signal,options=>{assert.equal(context.$('status').textContent,'Exporting original trace… Choose a file if prompted.');context.activeProject='proj_'+'b'.repeat(32);context.activeEnvironment='other';context.activeWorkspace='github-9999';assert.equal(options.suggestedName,'supatrace-run.json');return f.options.pick(options);}),201);
  assert.equal(nodes.get('cancel-export').disabled,true);assert.equal(nodes.get('status').textContent,'Saving completed export…');assert.equal(f.state.closes,1);
  assert.equal(integrateTraceWriter(source),source);
  assert.throws(()=>integrateTraceWriter(source.slice(0,start)+source.slice(start,end).replace('workspace=activeWorkspace','workspace=unreviewedChange')+source.slice(end)),/target_changed/);
});
