import './trace-export-cases.mjs';
import {saveTraceFile} from '../public/app/trace-export.js';
import {readEventPage} from '../public/app/event-data.js';
import {saveAccountArchive,prepareAccountArchive} from '../public/app/account-export.js';
import {loadAccountRuns} from '../public/app/run-data.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash,webcrypto} from 'node:crypto';
import {runInNewContext} from 'node:vm';
const baseline=readFileSync(new URL('./fixtures/dashboard-9342410.js',import.meta.url),'utf8');
assert.equal(createHash('sha256').update(baseline).digest('hex'),'a1796c1ae59b932b3d3621d7d67af15e12afa3f5daa5b31a8ecb7929b25b53b8');
const integrated=readFileSync(new URL('../public/app/app.js',import.meta.url),'utf8');
class Node {constructor(tag='div'){this.tagName=tag;this.children=[];this.dataset={};this.value='';this.hidden=false;this.disabled=false;this.attrs={};this._text='';const set=new Set();this.classList={add:x=>set.add(x),remove:x=>set.delete(x),contains:x=>set.has(x),toggle:(x,v)=>v?set.add(x):set.delete(x)};}set textContent(v){this._text=String(v);this.children=[];}get textContent(){return this._text+this.children.map(x=>typeof x==='string'?x:x.textContent).join('');}append(...v){this.children.push(...v);}replaceChildren(...v){this._text='';this.children=[...v];}setAttribute(k,v){this.attrs[k]=String(v);}getAttribute(k){return this.attrs[k]??null;}removeAttribute(k){delete this.attrs[k];}get options(){return this.children.filter(x=>x.tagName==='option');}querySelectorAll(){return [];}querySelector(){return new Node('button');}addEventListener(){}focus(){}remove(){}matches(){return false;}click(){}}
function app(fetcher,{patched=true,immediateTimers=false,picker,readTimeoutMs=30000,catalogTimeoutMs=300000,downloadFailure,onTimer=()=>{}}={}) {
  const nodes=new Map(),get=id=>{if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id);};
  let dispatched=0;const revoked=[];const listeners={};
  // The export-started audit report is answered here so each test's fetcher still sees only catalog and event reads.
  const auditReports=[],fetchWithAudit=(url,options)=>String(url).split('?')[0].endsWith('/api/audit/events')?(auditReports.push(JSON.parse(options.body)),Promise.resolve(new Response('{"recorded":true}',{status:201}))):fetcher(url,options);
  const document={getElementById:get,createElement:t=>{const n=new Node(t);if(t==='a')n.click=()=>{if(downloadFailure==='click')throw Error('synthetic dispatch failure');dispatched++;};return n;},querySelectorAll:()=>[],querySelector:()=>null,addEventListener(){},body:new Node()};
  let downloaded=null;
  class URLMock extends URL {static createObjectURL(blob){if(downloadFailure==='url')throw Error('synthetic URL failure');downloaded=blob;return 'blob:synthetic';}static revokeObjectURL(url){revoked.push(url);}}
  let source=(patched?integrated:baseline).replace(/^import[^\n]+\n/gm,'');
  source=source.slice(0,source.lastIndexOf('\nshowView();'));
  source+='\nglobalThis.testApp={allEvents,saveRunFile:typeof saveRunFile==="function"?saveRunFile:null,show,closeDetail,setProject:value=>activeProject=value};';
  const context={document,window:{...(picker?{showSaveFilePicker:picker}:{}),matchMedia:()=>({matches:false,addEventListener(){}})},location:{hash:'#traces'},fetch:fetchWithAudit,
    saveTraceFile,saveAccountArchive,prepareAccountArchive,loadAccountRuns:(request,options)=>loadAccountRuns(request,{...options,totalTimeoutMs:catalogTimeoutMs}),structuredClone,Response,URL:URLMock,URLSearchParams,TextEncoder,AbortController,crypto:webcrypto,Blob,readEventPage:(request,options)=>readEventPage(request,{...options,timeoutMs:readTimeoutMs}),
    setTimeout:(fn,ms)=>{onTimer(ms);if(immediateTimers)queueMicrotask(fn);return 0;},clearTimeout(){},addEventListener:(type,fn)=>(listeners[type]??=[]).push(fn)};
  Object.assign(context,{rememberSetupCode(){},pendingSetupCode:()=>null,clearSetupCode(){},clearFirstTraceStorage(){}});runInNewContext(source,context);
  context.testApp.setProject('proj_'+'a'.repeat(32));
  return {a:context.testApp,auditReports,get,download:()=>downloaded,dispatched:()=>dispatched,revoked,fire:type=>listeners[type]?.forEach(fn=>fn())};
}
const event=(id='one',data={kept:true})=>({id,time:'2026-10-01T00:00:00Z',kind:'note',name:'synthetic',data});
const page=(events,next=null)=>new Response(JSON.stringify({events,next}));

for(const outcome of ['resume','network','deadline','rate-limit','invalid-page'])test(`native 102-run archive after 33-second backoff: ${outcome} preserves bounds and truthful read/file outcome`,async()=>{
 const project='proj_'+'a'.repeat(32),rows=Array.from({length:102},(_,i)=>({id:'synthetic-'+String(i).padStart(3,'0'),created_at:'2026-11-08T00:00:00Z',started_at:null,ended_at:null,duration_ms:null,event_count:i<100?3:2,batch_count:1,byte_count:200,agents:[],status:'ok'}));
 const sink=fileSink(),timers=[];let catalogs=0,blockedCalls=0,progressAtPause,appView;
 const fetcher=async raw=>{
  const u=new URL(raw,'https://example.test');assert.equal(u.searchParams.get('project'),project);
  if(u.pathname==='/api/runs/page'){catalogs++;return new Response(JSON.stringify({project_id:project,runs:rows,next:null,complete:true}));}
  const id=u.searchParams.get('run'),index=rows.findIndex(row=>row.id===id);assert.ok(index>=0);
  if(index===16){
   blockedCalls++;
   if(blockedCalls===1){progressAtPause=appView.get('status').textContent;return new Response('{}',{status:429,headers:{'retry-after':'33'}});}
   assert.match(appView.get('status').textContent,/Retrieved 0 events; retrying in 33 seconds/);
   if(outcome==='network')throw Error('SYNTHETIC_PRIVATE_NETWORK_DETAIL');
   if(outcome==='deadline')return new Promise(()=>{});
   if(outcome==='rate-limit')return new Response('{}',{status:429,headers:{'retry-after':'33'}});
   if(outcome==='invalid-page')return new Response(JSON.stringify({events:[]}));
  }
  return page(Array.from({length:rows[index].event_count},(_,i)=>event(id+'-'+i,{parent:i?id+'-0':null,nested:[false,0,null,'synthetic']})));
 };
 appView=app(fetcher,{picker:sink.pick,immediateTimers:true,readTimeoutMs:20,onTimer:ms=>timers.push(ms)});
 await appView.get('export-account').onclick();
 assert.match(progressAtPause,/16\/102 traces, 48 events/);assert.ok(timers.includes(33000));
 assert.equal(appView.get('export-account').disabled,false);assert.equal(appView.get('cancel-account-export').hidden,true);assert.equal(appView.download(),null);
 if(outcome==='resume'){
  assert.equal(sink.closed,1);assert.equal(sink.aborted,0);assert.equal(catalogs,2);assert.equal(blockedCalls,2);
  const archive=JSON.parse(sink.chunks.join(''));assert.equal(archive.run_count,102);assert.equal(archive.event_count,304);assert.equal(archive.complete,true);
  assert.deepEqual(archive.runs.map(row=>row.metadata),rows);assert.deepEqual(archive.runs[16].events[1].data.parent,'synthetic-016-0');
 }else{
  assert.equal(sink.closed,0);assert.equal(sink.aborted,1);assert.equal(catalogs,1);assert.equal(blockedCalls,outcome==='rate-limit'?6:2);
  assert.doesNotMatch(appView.get('status').textContent,/SYNTHETIC_PRIVATE_|Export saved:|archive saved:/);
  assert.match(appView.get('status').textContent,outcome==='rate-limit'?/Archive read stopped at the request limit/:outcome==='deadline'?/An archive read took too long/:/An archive read could not finish/);
  assert.match(appView.get('status').textContent,/No complete archive was confirmed.*new file/);
 }
});
test('native account cancellation during declared backoff aborts without another read or completion',async()=>{
 const project='proj_'+'a'.repeat(32),sink=fileSink();let reads=0;
 const fixed=app(async raw=>new URL(raw,'https://example.test').pathname==='/api/runs/page'?
  new Response(JSON.stringify({project_id:project,runs:[{id:'synthetic',created_at:'2026-11-08T00:00:00Z',started_at:null,ended_at:null,duration_ms:null,event_count:1,batch_count:1,byte_count:200,agents:[],status:'ok'}],next:null,complete:true})):
  (reads++,new Response('{}',{status:429,headers:{'retry-after':'33'}})),{picker:sink.pick});
 const work=fixed.get('export-account').onclick();
 for(let ticks=0;ticks<10&&!fixed.get('status').textContent.includes('retrying in 33 seconds');ticks++)await new Promise(resolve=>setImmediate(resolve));
 assert.match(fixed.get('status').textContent,/retrying in 33 seconds/);assert.equal(fixed.get('cancel-account-export').hidden,false);
 fixed.get('cancel-account-export').onclick();await work;
 assert.equal(reads,1);assert.equal(sink.closed,0);assert.equal(sink.aborted,1);assert.match(fixed.get('status').textContent,/cancelled before completion/);
 assert.equal(fixed.get('export-account').disabled,false);assert.equal(fixed.get('cancel-account-export').hidden,true);
});
test('baseline repeated cursor consumes more requests; candidate fails before duplicate append',async()=>{
  let oldCalls=0;
  const old=app(async()=>{if(++oldCalls>4)throw Error('test_safe_stop');return page([event()], 'same');},{patched:false});
  await assert.rejects(old.a.allEvents('run',new AbortController().signal),/test_safe_stop/);
  assert.equal(oldCalls,5);
  let calls=0;const fixed=app(async()=>{calls++;return page([event()],'same');});
  await assert.rejects(fixed.a.allEvents('run',new AbortController().signal),/invalid_export_page/);
  assert.equal(calls,2);assert.equal(fixed.download(),null);
});
test('candidate rejects longer cursor cycles and malformed completion',async()=>{
  let calls=0;const fixed=app(async()=>page([event()],['A','B','A'][calls++]));
  await assert.rejects(fixed.a.allEvents('run',new AbortController().signal),/invalid_export_page/);
  assert.equal(calls,3);
  for(const value of [{events:[]},{events:[],next:''},{events:[],next:0},{events:{},next:null}]) {
    const bad=app(async()=>new Response(JSON.stringify(value)));
    await assert.rejects(bad.a.allEvents('run',new AbortController().signal),/invalid_export_page/);
  }
});
test('falsy successful JSON roots are rejected after one request rather than retried',async()=>{
  for(const value of [null,false,0,'']) {
    let calls=0;const fixed=app(async()=>{calls++;if(calls>2)throw Error('test_safe_stop');return new Response(JSON.stringify(value));});
    await assert.rejects(fixed.a.allEvents('run',new AbortController().signal),/invalid_export_page/);
    assert.equal(calls,1);assert.equal(fixed.download(),null);
  }
});
test('candidate full export retains all fields across pages and finishes controls',async()=>{
  const original=[event('a',{parent:'root',nested:[0,false,null,'café']}),event('b',{arbitrary:{untouched:true}})];
  let calls=0;const fixed=app(async url=>{calls++;return url.includes('after=next')?page([original[1]]):page([original[0]],'next');});
  await fixed.a.show('run');await fixed.get('export').onclick();
  assert.deepEqual(JSON.parse(await fixed.download().text()),{version:1,run_id:'run',events:original});
  assert.equal(calls,3);assert.equal(fixed.get('export').disabled,false);assert.equal(fixed.get('cancel-export').hidden,true);
  assert.equal(fixed.dispatched(),1);assert.match(fixed.get('status').textContent,/Export download started.*Check your browser downloads/);assert.doesNotMatch(fixed.get('status').textContent,/Export complete|Export saved/);
});
test('original trace download dispatch failure never claims a completed save',async()=>{
 for(const downloadFailure of ['url','click']){const fixed=app(async()=>page([event()]),{downloadFailure});await fixed.a.show('run');await fixed.get('export').onclick();assert.equal(fixed.dispatched(),0);assert.doesNotMatch(fixed.get('status').textContent,/Export complete|Export saved|download started/);assert.equal(fixed.get('export').disabled,false);assert.equal(fixed.get('cancel-export').hidden,true);}
});
test('invalid page exports no partial file and explains the export failure',async()=>{
  let calls=0;const fixed=app(async()=>++calls===1?page([event()]):new Response('{"events":[]}'));
  await fixed.a.show('run');await fixed.get('export').onclick();
  assert.equal(fixed.download(),null);assert.match(fixed.get('status').textContent,/No file was downloaded/);
  assert.doesNotMatch(fixed.get('status').textContent,/local upload/);
  assert.equal(fixed.get('export').disabled,false);assert.equal(fixed.get('cancel-export').hidden,true);
});
test('candidate byte cap prevents oversized export that baseline event count permits',async()=>{
  const chunk=Array.from({length:10},(_,i)=>event('event'+i,{text:'x'.repeat(32700)}));
  assert.ok(Buffer.byteLength(JSON.stringify(chunk))<524288);
  const fetcher=()=>{let calls=0;return async()=>page(chunk,++calls===70?null:'next'+calls);};
  const old=app(fetcher(),{patched:false});
  const accepted=await old.a.allEvents('run',new AbortController().signal);
  assert.equal(accepted.length,700);assert.ok(Buffer.byteLength(JSON.stringify(accepted))>20*1024*1024);
  const fixed=app(fetcher());
  await assert.rejects(fixed.a.allEvents('run',new AbortController().signal),/Export too large for this browser/);
  assert.equal(fixed.download(),null);
});
test('cancelled export and later-page failure never create a download',async()=>{
  const stopped=new AbortController();stopped.abort();let calls=0;
  const fixed=app(async()=>{calls++;return page([event()]);});
  await assert.rejects(fixed.a.allEvents('run',stopped.signal),/export_cancelled/);assert.equal(calls,0);
  let count=0;const failed=app(async()=>{if(++count===2)throw Error('synthetic_failure');return page([event()],'next');});
  await assert.rejects(failed.a.allEvents('run',new AbortController().signal),/synthetic_failure/);assert.equal(failed.download(),null);
});
test('bounded rate-limit recovery preserves pages and in-flight cancellation discards output',async()=>{
  let calls=0;const recovered=app(async()=>++calls===1?new Response('{}',{status:429,headers:{'retry-after':'1'}}):page([event()]),{immediateTimers:true});
  assert.equal((await recovered.a.allEvents('run',new AbortController().signal)).length,1);assert.equal(calls,2);
  let release;const abort=new AbortController();const pending=app(()=>new Promise(resolve=>{release=resolve;}));
  const work=pending.a.allEvents('run',abort.signal);abort.abort();release(page([event()]));
  await assert.rejects(work,/export_cancelled/);assert.equal(pending.download(),null);
});

function fileSink({writeHook=()=>{},closeFails=false}={}){const chunks=[];let closed=0,aborted=0;return {chunks,get closed(){return closed;},get aborted(){return aborted;},pick:async()=>({createWritable:async options=>{assert.equal(options.keepExistingData,false);return {write:async text=>{await writeHook(text,chunks.length);chunks.push(text);},close:async()=>{if(closeFails)throw Error('synthetic-disk-error');closed++;},abort:async()=>{aborted++;}};}})};}
test('streaming actual export UI saves over20MiB with original fields and bounded individual writes',async()=>{const chunk=Array.from({length:10},(_,i)=>event('event'+i,{text:'x'.repeat(32700),unknown:[false,null,0,'café']}));let calls=0;const sink=fileSink(),fixed=app(async()=>page(chunk,++calls%70===0?null:'next'+calls),{picker:sink.pick});await fixed.a.show('large-run');calls=0;await fixed.get('export').onclick();assert.equal(sink.closed,1);assert.equal(sink.aborted,0);assert.equal(fixed.download(),null);assert.ok(Math.max(...sink.chunks.map(x=>Buffer.byteLength(x)))<40000);const json=sink.chunks.join('');assert.ok(Buffer.byteLength(json)>20*1024*1024);const result=JSON.parse(json);assert.equal(result.run_id,'large-run');assert.equal(result.events.length,700);assert.deepEqual(result.events[699],chunk[9]);assert.match(fixed.get('status').textContent,/700 events/);assert.equal(fixed.get('export').disabled,false);});
test('streaming malformed cursor or later request failure aborts without committing',async()=>{for(const malformed of [true,false]){let calls=0;const sink=fileSink(),fixed=app(async()=>{calls++;if(calls===2){if(!malformed)throw Error('synthetic-error');return page([event()],'repeat');}return page([event()],'repeat');});await assert.rejects(fixed.a.saveRunFile('run',new AbortController().signal,sink.pick),/export_file_unconfirmed/);assert.equal(sink.closed,0);assert.equal(sink.aborted,1);}});
test('streaming cancellation before picker/open/write and disk failure never claims success',async()=>{const controller=new AbortController(),sink=fileSink({writeHook:()=>controller.abort()}),fixed=app(async()=>page([event()]));await assert.rejects(fixed.a.saveRunFile('run',controller.signal,sink.pick),/export_file_cancelled/);assert.equal(sink.closed,0);assert.equal(sink.aborted,1);const stopped=new AbortController();stopped.abort();let opened=false;await assert.rejects(fixed.a.saveRunFile('run',stopped.signal,async()=>({createWritable:async()=>{opened=true;}})),/cancelled/);assert.equal(opened,false);const bad=fileSink({closeFails:true});await assert.rejects(fixed.a.saveRunFile('run',new AbortController().signal,bad.pick),/export_file_unconfirmed/);assert.equal(bad.closed,0);});
test('picker denial does not fall back to a download or issue export requests',async()=>{let calls=0;const fixed=app(async()=>{calls++;return page([event()]);},{picker:async()=>{throw Object.assign(Error('cancelled'),{name:'AbortError'});}});await fixed.a.show('run');calls=0;await fixed.get('export').onclick();assert.equal(calls,0);assert.equal(fixed.download(),null);assert.match(fixed.get('status').textContent,/cancelled before completion/);assert.equal(fixed.get('export').disabled,false);});

test('navigation abort during final close failure reports uncertain commit, never cancellation',async()=>{let rejectClose,closing;const began=new Promise(resolve=>closing=resolve),controller=new AbortController(),fixed=app(async()=>page([event()]));const work=fixed.a.saveRunFile('run',controller.signal,async()=>({createWritable:async()=>({write:async()=>{},close:()=>{closing();return new Promise((_,reject)=>rejectClose=reject);},abort:async()=>{throw Error('must not assert rollback after committing');}})}));await began;controller.abort();rejectClose(Object.assign(Error('disk close failed'),{name:'AbortError'}));await assert.rejects(work,/export_file_unconfirmed/);});

test('actual account export UI pins project on both catalog reads and all event requests',async()=>{const project='proj_'+ 'b'.repeat(32),sink=fileSink(),calls=[],metadata=id=>({id,created_at:'2026-11-03T00:00:00Z',started_at:null,ended_at:null,duration_ms:null,event_count:1,batch_count:1,byte_count:200,agents:[],status:'ok'}),fixed=app(async url=>{const u=new URL(url,'https://supatrace.dev');calls.push(u);assert.equal(u.searchParams.get('project'),project);if(u.pathname==='/api/runs/page')return new Response(JSON.stringify({project_id:project,runs:[metadata('first'),metadata('later')],next:null,complete:true}));return page([event(u.searchParams.get('run'))]);},{picker:sink.pick});fixed.a.setProject(project);await fixed.get('export-account').onclick();assert.equal(sink.closed,1);const archive=JSON.parse(sink.chunks.join(''));assert.deepEqual(archive.runs.map(x=>x.events[0].id),['first','later']);assert.equal(calls.filter(x=>x.pathname==='/api/runs/page').length,2);assert.equal(fixed.get('export-account').disabled,false);assert.match(fixed.get('status').textContent,/2 traces, 2 events/);});

test('account export accepts an empty terminal Dynamo page without counting another batch',async()=>{const project='proj_'+ 'c'.repeat(32),sink=fileSink(),metadata={id:'one',created_at:'2026-11-03T00:00:00Z',started_at:null,ended_at:null,duration_ms:null,event_count:1,batch_count:1,byte_count:100,agents:[],status:'ok'},fixed=app(async url=>{const u=new URL(url,'https://supatrace.dev');if(u.pathname==='/api/runs/page')return new Response(JSON.stringify({project_id:project,runs:[metadata],next:null,complete:true}));return u.searchParams.get('after')?page([],null):page([event('one')],'terminal');},{picker:sink.pick});fixed.a.setProject(project);await fixed.get('export-account').onclick();assert.equal(sink.closed,1);assert.equal(JSON.parse(sink.chunks.join('')).event_count,1);});

test('hung event reads release Blob and streaming export controls without committing a partial result',async()=>{for(const streaming of [false,true]){let reads=0,release;const sink=fileSink(),fixed=app(async()=>++reads===1?page([event()]):new Promise(resolve=>release=resolve),{readTimeoutMs:10,...(streaming?{picker:sink.pick}:{})});await fixed.a.show('run');await fixed.get('export').onclick();assert.equal(fixed.get('export').disabled,false);assert.equal(fixed.get('cancel-export').hidden,true);assert.equal(fixed.download(),null);assert.equal(sink.closed,0);assert.equal(sink.aborted,streaming?1:0);assert.doesNotMatch(fixed.get('status').textContent,/Export saved:|Exported [0-9]/);release(page([event('late')]));await new Promise(resolve=>setImmediate(resolve));assert.equal(fixed.download(),null);assert.equal(sink.closed,0);}});
test('streaming run pins the original project before awaiting the native picker',async()=>{const old='proj_'+'a'.repeat(32),next='proj_'+'b'.repeat(32),sink=fileSink(),seen=[],fixed=app(async url=>{seen.push(new URL(url,'https://example.test').searchParams.get('project'));return page([event()]);});fixed.a.setProject(old);await fixed.a.saveRunFile('run',new AbortController().signal,async options=>{fixed.a.setProject(next);return sink.pick(options);});assert.deepEqual(seen,[old]);assert.equal(sink.closed,1);});

const settleExport=work=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('export did not settle')),2000);Promise.resolve(work).then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});
async function intercepted(predicate){const deadline=Date.now()+2000;while(!predicate()&&Date.now()<deadline)await new Promise(resolve=>setImmediate(resolve));assert.ok(predicate(),'expected pending catalog read');}
for(const cancel of [false,true])test(`actual account export ${cancel?'cancel':'deadline'} recovers initial/final catalog fetch and JSON hangs without committing`,async()=>{
 for(const scan of [1,2])for(const body of [false,true]){
  const project='proj_'+'d'.repeat(32),sink=fileSink(),original=event('one',{parent:'root',nested:[0,false,null,'café']}),metadata={id:'one',created_at:'2026-11-03T00:00:00Z',started_at:null,ended_at:null,duration_ms:null,event_count:1,batch_count:1,byte_count:100,agents:[],status:'ok'},catalog={project_id:project,runs:[metadata],next:null,complete:true};
  let scans=0,release,rejectPending,pendingSignal,eventReads=0,healthy=false;
  const fixed=app(async(url,options)=>{
   if(!url.includes('/runs/page')){eventReads++;return page([original]);}
   if(++scans!==scan||healthy)return new Response(JSON.stringify(catalog));
   pendingSignal=options.signal;const pending=new Promise((resolve,reject)=>{release=resolve;rejectPending=reject;});
   return body?{status:200,ok:true,json:()=>pending}:pending;
  },{picker:sink.pick,catalogTimeoutMs:cancel?300000:20});fixed.a.setProject(project);
  const work=fixed.get('export-account').onclick();await intercepted(()=>!!release);assert.equal(fixed.get('export-account').disabled,true);assert.equal(fixed.get('cancel-account-export').hidden,false);
  if(cancel)fixed.get('cancel-account-export').onclick();await settleExport(work);
  assert.equal(pendingSignal.aborted,true);assert.equal(sink.closed,0);assert.equal(sink.aborted,scan===2?1:0);assert.equal(sink.chunks.length>0,scan===2);assert.equal(eventReads,scan===2?1:0);assert.equal(fixed.download(),null);assert.equal(fixed.get('export-account').disabled,false);assert.equal(fixed.get('cancel-account-export').hidden,true);assert.doesNotMatch(fixed.get('status').textContent,/Account archive saved/);
  if(cancel)assert.match(fixed.get('status').textContent,/cancelled before completion/);
  const oldCalls=scans;if(body)rejectPending(Error('private late body failure'));else release(new Response(JSON.stringify(catalog)));await new Promise(resolve=>setImmediate(resolve));assert.equal(scans,oldCalls);assert.equal(sink.closed,0);assert.doesNotMatch(fixed.get('status').textContent,/private late body failure/);
  // An explicit new export starts from fresh catalogs and can commit original data.
  healthy=true;sink.chunks.length=0;await fixed.get('export-account').onclick();assert.equal(sink.closed,1);assert.equal(scans,oldCalls+2);const archive=JSON.parse(sink.chunks.join(''));assert.deepEqual(archive.runs[0].events,[original]);assert.equal(archive.complete,true);assert.equal(fixed.get('export-account').disabled,false);
 }
});

const downloadProject='proj_'+'e'.repeat(32);
const downloadRun=id=>({id,created_at:'2026-11-04T00:00:00Z',started_at:null,ended_at:null,duration_ms:null,event_count:1,batch_count:1,byte_count:100,agents:[],status:'ok'});
function downloadApp(options={}){const calls=[];let scans=0;const f=app(async url=>{const u=new URL(url,'https://example.test');calls.push(u);assert.equal(u.searchParams.get('project'),downloadProject);if(u.pathname==='/api/runs/page'){scans++;return new Response(JSON.stringify({project_id:downloadProject,runs:[downloadRun('first'),downloadRun('second')],complete:true,next:null}));}return page([event(u.searchParams.get('run'),{parent:'root',untouched:[0,false,null,'café']})]);},options);f.a.setProject(downloadProject);return {...f,calls,scans:()=>scans};}
test('standard account UI prepares every run and requires a separate user download click',async()=>{
 const f=downloadApp();await f.get('export-account').onclick();assert.equal(f.scans(),2);assert.equal(f.download(),null);assert.equal(f.dispatched(),0);assert.equal(f.get('download-account').hidden,false);assert.match(f.get('status').textContent,/Account archive ready: 2 traces, 2 events/);assert.doesNotMatch(f.get('status').textContent,/archive saved/);
 f.get('download-account').onclick();const archive=JSON.parse(await f.download().text());assert.equal(archive.complete,true);assert.deepEqual(archive.runs.map(r=>r.metadata.id),['first','second']);assert.deepEqual(archive.runs[1].events[0].data.untouched,[0,false,null,'café']);assert.equal(f.dispatched(),1);assert.equal(f.get('download-account').hidden,true);assert.match(f.get('status').textContent,/download started.*Check your browser downloads/);f.get('download-account').onclick();assert.equal(f.dispatched(),1);
});
test('prepared account download is discarded on cancel, navigation, pagehide and identity change',async()=>{
 for(const action of ['discard','navigate','pagehide','identity']){const f=downloadApp();await f.get('export-account').onclick();if(action==='discard')f.get('discard-account').onclick();else if(action==='navigate')f.a.closeDetail();else if(action==='pagehide')f.fire('pagehide');else f.a.setProject('proj_'+'f'.repeat(32));f.get('download-account').onclick();assert.equal(f.dispatched(),0);assert.equal(f.get('download-account').hidden,true);}
});
test('standard account download URL or dispatch failure never reports saved or started',async()=>{
 for(const downloadFailure of ['url','click']){const f=downloadApp({downloadFailure});await f.get('export-account').onclick();f.get('download-account').onclick();assert.equal(f.dispatched(),0);assert.equal(f.get('download-account').hidden,true);assert.match(f.get('status').textContent,/could not be prepared or started/);assert.doesNotMatch(f.get('status').textContent,/Account archive saved|Account download started/);assert.equal(f.revoked.length,downloadFailure==='click'?1:0);}
});
test('account picker rejection never falls back to preparing a standard download',async()=>{
 const f=downloadApp({picker:async()=>{throw Object.assign(Error('cancelled'),{name:'AbortError'});}});await f.get('export-account').onclick();assert.equal(f.calls.length,0);assert.equal(f.download(),null);assert.equal(f.get('download-account').hidden,true);assert.match(f.get('status').textContent,/cancelled before completion/);
});

for(const phase of ['initial-catalog','event-read'])for(const retryAfter of ['invalid','0','61'])test(`first 429 at ${phase} with unsupported Retry-After ${retryAfter} reports a request limit without inventing retries`,async()=>{
 const project='proj_'+'a'.repeat(32),sink=fileSink(),timers=[];
 const row={id:'synthetic',created_at:'2026-11-08T00:00:00Z',started_at:null,ended_at:null,duration_ms:null,event_count:1,batch_count:1,byte_count:200,agents:[],status:'ok'};
 let catalogs=0,events=0;
 const fixed=app(async raw=>{
  const u=new URL(raw,'https://example.test');
  if(u.pathname==='/api/runs/page'){
   catalogs++;if(phase==='event-read')return new Response(JSON.stringify({project_id:project,runs:[row],next:null,complete:true}));
  }else events++;
  return new Response('{}',{status:429,headers:{'retry-after':retryAfter}});
 },{picker:sink.pick,onTimer:ms=>timers.push(ms)});
 await fixed.get('export-account').onclick();
 assert.equal(catalogs,1);assert.equal(events,phase==='event-read'?1:0);
 assert.equal(sink.closed,0);assert.equal(sink.aborted,phase==='event-read'?1:0);
 assert.equal(fixed.download(),null);assert.deepEqual(timers.filter(ms=>ms!==4200),[],'only the status dismissal timer is allowed; no retry wait');
 assert.match(fixed.get('status').textContent,/Archive read stopped at the request limit.*No complete archive was confirmed/);
 assert.doesNotMatch(fixed.get('status').textContent,/repeated|retrying in|saved:/);
 assert.equal(fixed.get('export-account').disabled,false);assert.equal(fixed.get('cancel-account-export').hidden,true);
});

test('export notes disclose observed-read consistency, scope and browser size limits beside each control',()=>{
 const html=readFileSync(new URL('../public/app/index.html',import.meta.url),'utf8');
 const note=id=>{const text=html.match(new RegExp('<p id="'+id+'"[^>]*>([^<]*)</p>'))?.[1];assert.ok(text,id);return text;};
 for(const id of ['export-hint','account-export-note','workspace-export-note'])for(const fact of ['observed read','not a point-in-time snapshot','byte-for-byte backup','Where Save File is available'])assert.ok(note(id).includes(fact),id+': '+fact);
 for(const id of ['export-hint','account-export-note','workspace-export-note']){assert.match(note(id),/Otherwise the app attempts/i,id);assert.doesNotMatch(note(id),/other browsers/i,id+' must use capability wording, not browser claims');}
 assert.match(note('export-hint'),/Save File streaming has been checked on hosted Chrome on macOS; the standard-download fallback is covered by controlled Chromium tests; other browser engines and physical devices are unverified/);
 assert.match(note('export-hint'),/Scope: this trace in the selected workspace and environment/);
 assert.match(note('export-hint'),/20 MiB of event JSON and 100,000 events/);
 assert.match(note('export-hint'),/events uploaded during the export may or may not be included/);
 assert.match(note('account-export-note'),/Scope: only the environment selected above, in the current workspace/);
 assert.match(note('account-export-note'),/20 MiB total and 100,000 events/);
 assert.match(note('account-export-note'),/read before and after.*compared with its catalog counts\. The archive is not committed when those compared reads differ; changes that leave them equal are not detected/);
 assert.match(note('workspace-export-note'),/every listed environment in this workspace.*does not include other workspaces/);
 assert.match(note('workspace-export-note'),/20 environments, 100,000 traces and 20 MiB of catalog metadata/);
 assert.match(note('workspace-export-note'),/read again at the end and compared with the first reads.*The export is not committed when those compared reads differ; changes that leave them equal are not detected/);
 for(const id of ['account-export-note','workspace-export-note'])for(const claim of ['if traces or event counts change during export','any change stops the export'])assert.ok(!note(id).includes(claim),id+' overclaims: '+claim);
});
