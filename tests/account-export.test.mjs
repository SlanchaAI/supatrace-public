import test from 'node:test';import assert from 'node:assert/strict';import {saveAccountArchive} from '../public/app/account-export.js';
const project='proj_'+ 'a'.repeat(32),run=(id,count=1,batches=1)=>({id,event_count:count,batch_count:batches,created_at:'2026-11-03T00:00:00Z',unknown:{preserved:true}});
function fixture({before=[run('one'),run('two')],after=before,events=id=>[{id,data:{source:id,parent:null,untouched:[0,false,'café']}}],result,writeFailure=false,closeFailure=false}={}){const chunks=[];let closed=0,aborted=0,loads=0,reads=0;return {chunks,get closed(){return closed;},get aborted(){return aborted;},get reads(){return reads;},spec:{projectId:project,signal:new AbortController().signal,pick:async()=>({createWritable:async()=>({write:async text=>{if(writeFailure)throw Error('disk');chunks.push(text);},close:async()=>{if(closeFailure)throw Error('disk');closed++;},abort:async()=>{aborted++;}})}),loadCatalog:async()=>++loads===1?before:after,writeRun:async(id,signal,sink)=>{reads++;const rows=events(id);await sink(rows);return result??{events:rows.length,pages:1,batches:rows.length?1:0};}}};}
test('complete observed account archive preserves every run/event and explicit non-snapshot semantics',async()=>{const f=fixture(),r=await saveAccountArchive(f.spec),archive=JSON.parse(f.chunks.join(''));assert.deepEqual(r,{runs:2,events:2,consistency:'observed_stable_before_after_not_a_snapshot'});assert.equal(archive.project_id,project);assert.equal(archive.complete,true);assert.equal(archive.runs.length,2);assert.deepEqual(archive.runs[1].metadata,run('two'));assert.deepEqual(archive.runs[1].events[0].data.untouched,[0,false,'café']);assert.equal(f.closed,1);assert.equal(f.aborted,0);});
test('account membership or metadata drift aborts the entire archive',async()=>{for(const after of [[run('one')],[run('one'),run('two',2)],[run('one'),run('two'),run('new')]]){const f=fixture({after});await assert.rejects(saveAccountArchive(f.spec),/account_export_changed/);assert.equal(f.closed,0);assert.equal(f.aborted,1);}});
test('incomplete counts, duplicate IDs and event/batch mismatches cannot commit',async()=>{for(const before of [[run('one',null)],[run('one'),run('one')]]){const f=fixture({before});await assert.rejects(saveAccountArchive(f.spec),/account_export_incomplete/);assert.equal(f.reads,0);assert.equal(f.closed,0);}for(const result of [{events:0,pages:1,batches:1},{events:1,pages:2,batches:2}]){const f=fixture({result});await assert.rejects(saveAccountArchive(f.spec),/account_export_changed/);assert.equal(f.closed,0);}});
test('empty stable account is explicit and cancellation/disk errors never report completion',async()=>{const empty=fixture({before:[]});assert.equal((await saveAccountArchive(empty.spec)).runs,0);assert.equal(JSON.parse(empty.chunks.join('')).complete,true);for(const options of [{writeFailure:true},{closeFailure:true}]){const f=fixture(options);await assert.rejects(saveAccountArchive(f.spec),/export_file_unconfirmed/);assert.equal(f.closed,0);}const f=fixture(),controller=new AbortController();f.spec.signal=controller.signal;f.spec.onProgress=()=>controller.abort();await assert.rejects(saveAccountArchive(f.spec),/export_file_cancelled/);assert.equal(f.closed,0);assert.equal(f.aborted,1);});
test('final close uncertainty wins over navigation cancellation',async()=>{const f=fixture(),controller=new AbortController();f.spec.signal=controller.signal;f.spec.pick=async()=>({createWritable:async()=>({write:async()=>{},abort:async()=>{throw Error('must not rollback committed phase');},close:async()=>{controller.abort();throw Object.assign(Error('disk'),{name:'AbortError'});}})});await assert.rejects(saveAccountArchive(f.spec),/export_file_unconfirmed/);});
test('catalog order changes do not fabricate drift, while caller input mutation is isolated',async()=>{const before=[run('one'),run('two')],f=fixture({before,after:[run('two'),run('one')]});const original=f.spec.writeRun;f.spec.writeRun=async(...args)=>{before[0].event_count=999;return original(...args);};assert.equal((await saveAccountArchive(f.spec)).runs,2);assert.equal(JSON.parse(f.chunks.join('')).runs[0].metadata.event_count,1);});

test('initial/event/final read failures retain only fixed classifications after safe abort',async()=>{
 for(const phase of ['initial','events','final'])for(const [code,expected] of [['run_load_rate_limited','account_export_rate_limited'],['export_rate_limited','account_export_rate_limited'],['run_load_deadline','account_export_read_deadline'],['export_read_deadline','account_export_read_deadline'],['invalid_run_page','account_export_read_failed'],['PRIVATE_DEPENDENCY_DETAIL','account_export_read_failed']]){
  const f=fixture();let scans=0;
  f.spec.loadCatalog=async()=>{scans++;if(phase==='initial'||phase==='final'&&scans===2)throw Error(code);return [run('one')];};
  if(phase==='events')f.spec.writeRun=async()=>{throw Error(code);};
  await assert.rejects(saveAccountArchive(f.spec),error=>error.message===expected);
  assert.equal(f.closed,0);assert.equal(f.aborted,phase==='initial'?0:1);
 }
});
test('failed abort, sink write and close retain file uncertainty over read-looking failures',async()=>{
 for(const phase of ['abort','write','close']){
  let writes=0,closes=0,aborts=0;const f=fixture({before:[run('one')]});
  f.spec.pick=()=>({createWritable:()=>({write:()=>{if(++writes===3&&phase==='write')throw Error('export_rate_limited');},abort:()=>{aborts++;if(phase==='abort')throw Error('PRIVATE_ABORT_DETAIL');},close:()=>{closes++;if(phase==='close')throw Error('export_read_deadline');}})});
  if(phase==='abort')f.spec.writeRun=async()=>{throw Error('export_rate_limited');};
  await assert.rejects(saveAccountArchive(f.spec),error=>error.message==='export_file_unconfirmed');
  assert.equal(closes,phase==='close'?1:0);assert.equal(aborts,phase==='close'?0:1);
 }
});

// The standard download buffers only a fully reconciled, bounded archive.
import {prepareAccountArchive,ACCOUNT_DOWNLOAD_LIMITS} from '../public/app/account-export.js';
test('standard archive preserves streaming bytes, original objects and explicit empty accounts',async()=>{
 for(const before of [[run('one'),run('two')],[]]){
  const f=fixture({before}),snapshot=structuredClone(before),now=()=> '2026-11-04T00:00:00Z';
  await saveAccountArchive({...f.spec,now});const prepared=await prepareAccountArchive({...fixture({before}).spec,now});
  assert.equal(await prepared.blob.text(),f.chunks.join(''));assert.equal(prepared.bytes,Buffer.byteLength(f.chunks.join('')));assert.equal(prepared.blob.type,'application/json');assert.equal(prepared.runs,before.length);assert.deepEqual(before,snapshot);
 }
});
test('original account archives preserve captured secret-like fields without redaction in both save paths',async()=>{
 const before=[{...run('one'),captured_note:'synthetic-metadata-secret'}],event={id:'one',data:{api_key:'synthetic-not-a-real-key',nested:{authorization:'Bearer synthetic-only',password:'synthetic-only-password'}}},snapshot=structuredClone({before,event}),now=()=> '2026-11-04T00:00:00Z';
 const streaming=fixture({before,events:()=>[event]});await saveAccountArchive({...streaming.spec,now});
 const downloaded=await prepareAccountArchive({...fixture({before,events:()=>[event]}).spec,now});
 const saved=streaming.chunks.join('');assert.equal(await downloaded.blob.text(),saved);
 for(const text of [saved,await downloaded.blob.text()]){const archive=JSON.parse(text);assert.deepEqual(archive.runs[0].metadata,before[0]);assert.deepEqual(archive.runs[0].events,[event]);assert.equal(archive.complete,true);assert.equal(archive.version,2);}
 assert.deepEqual({before,event},snapshot,'neither export path changes stored originals or silently masks captured values');
});
test('standard archive enforces aggregate UTF-8 bytes including metadata and final envelope',async()=>{
 const before=[run('one'),run('two')],events=id=>[{id,data:{text:'é'.repeat(30)}}],now=()=> '2026-11-04T00:00:00Z';
 const complete=await prepareAccountArchive({...fixture({before,events}).spec,now});
 assert.ok(complete.bytes>(await complete.blob.text()).length,'UTF-8 byte count, not characters');
 assert.equal((await prepareAccountArchive({...fixture({before,events}).spec,now,maxBytes:complete.bytes})).bytes,complete.bytes);
 await assert.rejects(prepareAccountArchive({...fixture({before,events}).spec,now,maxBytes:complete.bytes-1}),/account_export_too_large/);
 const each=await prepareAccountArchive({...fixture({before:[run('one')],events}).spec,now});
 assert.ok(each.bytes<complete.bytes);await assert.rejects(prepareAccountArchive({...fixture({before,events}).spec,now,maxBytes:each.bytes}),/account_export_too_large/);
 await assert.rejects(prepareAccountArchive({...fixture({before:[]}).spec,maxBytes:20}),/account_export_too_large/);
});
test('standard archive enforces one event budget across all runs and bounded caller limits',async()=>{
 const f=fixture();assert.equal((await prepareAccountArchive({...f.spec,maxEvents:2})).events,2);
 await assert.rejects(prepareAccountArchive({...fixture().spec,maxEvents:1}),/account_export_too_large/);
 for(const limits of [{maxBytes:ACCOUNT_DOWNLOAD_LIMITS.bytes+1},{maxEvents:ACCOUNT_DOWNLOAD_LIMITS.events+1},{maxBytes:0},{maxEvents:0},{maxBytes:1.5}])await assert.rejects(prepareAccountArchive({...fixture().spec,...limits}),/account_export_unavailable/);
});
test('standard archive cannot expose bytes after catalog drift, count mismatch or cancellation',async()=>{
 for(const options of [{after:[run('one')]},{result:{events:1,batches:2}}])await assert.rejects(prepareAccountArchive(fixture(options).spec),/account_export_changed/);
 const controller=new AbortController();await assert.rejects(prepareAccountArchive({...fixture().spec,signal:controller.signal,onProgress:()=>controller.abort()}),/export_cancelled/);
 const final=new AbortController();await assert.rejects(prepareAccountArchive({...fixture().spec,signal:final.signal,onCommit:()=>final.abort()}),/export_cancelled/);
 assert.equal((await prepareAccountArchive(fixture().spec)).events,2,'explicit retry starts fresh');
});
test('standard archive allocation failure does not return a partial download',async()=>{
 const OriginalBlob=globalThis.Blob;try{globalThis.Blob=class {constructor(){throw Error('synthetic allocation failure');}};await assert.rejects(prepareAccountArchive(fixture().spec),/account_download_failed/);}finally{globalThis.Blob=OriginalBlob;}
});


test('production download cap rejects many individually small runs once aggregate output exceeds 20 MiB',async()=>{
 const rows=Array.from({length:70},(_,i)=>run('r'+i,10)),events=id=>Array.from({length:10},(_,i)=>({id:id+'-'+i,data:{text:'x'.repeat(32700)}}));
 await assert.rejects(prepareAccountArchive(fixture({before:rows,events}).spec),/account_export_too_large/);
});

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function within(work){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('account export remained pending')),1000);Promise.resolve(work).then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});}

test('native account file creation and writes settle on cancel or deadline and fence late results',async()=>{
 for(const phase of ['create','header','event','footer'])for(const cancel of [false,true])for(const lateReject of [false,true]){
  const pending=deferred(),reached=deferred(),controller=new AbortController(),f=fixture({before:[run('one')]}),chunks=[];
  let writes=0,aborts=0,closes=0;
  const stream={write:async text=>{writes++;chunks.push(text);if((phase==='header'&&writes===1)||(phase==='event'&&text.startsWith('{"id":'))||(phase==='footer'&&text.includes('"completed_at"'))){reached.resolve();await pending.promise;}},abort:async()=>{aborts++;},close:async()=>{closes++;}};
  const work=saveAccountArchive({...f.spec,signal:controller.signal,fileTimeoutMs:20,pick:()=>({createWritable:()=>{if(phase==='create'){reached.resolve();return pending.promise;}return stream;}})});
  const checked=assert.rejects(within(work),cancel?/export_file_cancelled/:/export_file_unconfirmed/);
  await reached.promise;if(cancel)controller.abort();await checked;
  assert.equal(closes,0);assert.equal(aborts,phase==='create'?0:1);const stoppedWrites=writes;
  if(lateReject)pending.reject(Error('late native failure'));else pending.resolve(stream);await tick();await tick();
  assert.equal(writes,stoppedWrites,'late operation must not resume the archive');assert.equal(closes,0);
  assert.equal(aborts,phase==='create'?(lateReject?0:1):1,'late-created writable is aborted, never written');
  const fresh=fixture();assert.equal((await saveAccountArchive(fresh.spec)).events,2,'fresh export still works');
 }
});

test('native account abort failure or hang reports uncertainty even after cancellation',async()=>{
 for(const hang of [false,true]){
  const pending=deferred(),reached=deferred(),controller=new AbortController();let closes=0;
  const work=saveAccountArchive({...fixture().spec,fileTimeoutMs:20,signal:controller.signal,pick:()=>({createWritable:()=>({write:()=>{controller.abort();},abort:()=>{reached.resolve();if(hang)return pending.promise;throw Error('abort failed');},close:()=>{closes++;}})})});
  const checked=assert.rejects(within(work),/export_file_unconfirmed/);await reached.promise;await checked;
  pending.reject(Error('late abort failure'));if(!hang)pending.promise.catch(()=>{});await tick();assert.equal(closes,0);
 }
});

test('native account close deadline cannot claim cancellation or rollback and ignores late completion',async()=>{
 for(const lateReject of [false,true]){
  const closing=deferred(),pending=deferred(),controller=new AbortController();let aborts=0,closeCalls=0;
  const work=saveAccountArchive({...fixture({before:[]}).spec,fileTimeoutMs:20,signal:controller.signal,pick:()=>({createWritable:()=>({write:()=>{},abort:()=>{aborts++;},close:()=>{closeCalls++;closing.resolve();return pending.promise;}})})});
  const checked=assert.rejects(within(work),/export_file_unconfirmed/);await closing.promise;controller.abort();await checked;
  assert.equal(aborts,0,'never claim rollback after final close starts');assert.equal(closeCalls,1);
  if(lateReject)pending.reject(Error('late close failure'));else pending.resolve();await tick();assert.equal(aborts,0);assert.equal(closeCalls,1);
 }
});

test('account picker stays in the user gesture, has no selection deadline, and stops after cancellation',async()=>{
 const pending=deferred(),controller=new AbortController();let picks=0,opens=0,scans=0;
 const work=saveAccountArchive({...fixture().spec,fileTimeoutMs:1,signal:controller.signal,pick:()=>{picks++;return pending.promise;},loadCatalog:()=>{scans++;return [];}});
 assert.equal(picks,1,'picker runs before the click stack yields');let settled=false;work.then(()=>settled=true,()=>settled=true);
 await new Promise(resolve=>setTimeout(resolve,10));assert.equal(settled,false,'user selection is not timed out');controller.abort();await assert.rejects(within(work),/export_file_cancelled/);
 pending.resolve({createWritable:()=>{opens++;}});await tick();assert.equal(scans,0);assert.equal(opens,0);
});

test('account file wait validates bounds and removes cancellation listeners after repeated exports',async()=>{
 for(const fileTimeoutMs of [0,-1,1.5,120001,Infinity])await assert.rejects(saveAccountArchive({...fixture().spec,fileTimeoutMs}),/account_export_unavailable/);
 const controller=new AbortController(),signal=controller.signal,add=signal.addEventListener.bind(signal),remove=signal.removeEventListener.bind(signal);let listeners=0;
 signal.addEventListener=(...args)=>{listeners++;return add(...args);};signal.removeEventListener=(...args)=>{listeners--;return remove(...args);};
 for(let i=0;i<4;i++){const f=fixture();await saveAccountArchive({...f.spec,signal});assert.equal(listeners,0);assert.equal(f.closed,1);}
});

test('account export preserves over 100 tied-time events, parent links and run metadata across pages',async()=>{
 const rows=Array.from({length:805},(_,i)=>run('run-'+i,i===804?201:0,i===804?3:0));
 const events=Array.from({length:201},(_,i)=>({id:'span-'+i,time:'2026-11-05T00:00:00Z',kind:'note',name:'Synthetic original',data:{parent_id:i?'span-'+(i-1):null,nested:[false,0,null,'café']}}));
 const now=()=> '2026-11-05T00:00:00Z',snapshot=structuredClone({rows,events}),f=fixture({before:rows});
 const options={...f.spec,now,writeRun:async(id,signal,sink)=>{if(id!=='run-804')return {events:0,batches:0};for(let i=0;i<events.length;i+=100)await sink(events.slice(i,i+100));return {events:201,batches:3};}};
 await saveAccountArchive(options);const downloaded=await prepareAccountArchive(options),archive=JSON.parse(await downloaded.blob.text());
 assert.equal(await downloaded.blob.text(),f.chunks.join(''));assert.equal(archive.run_count,805);assert.equal(archive.event_count,201);assert.equal(archive.complete,true);
 assert.deepEqual(archive.runs.map(row=>row.metadata),rows);assert.deepEqual(archive.runs[804].events,events);assert.deepEqual({rows,events},snapshot);
});
