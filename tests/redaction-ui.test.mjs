import {readEventPage} from '../public/app/event-data.js';
// Synthetic execution of the current UI, including its actual paginated export adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {runInNewContext} from 'node:vm';
const appSource=readFileSync(new URL('../public/app/app.js',import.meta.url),'utf8');
const redactionSource=readFileSync(new URL('../public/app/redaction.js',import.meta.url),'utf8').replace(/^export /gm,'');
class Node {
 constructor(tag='div'){this.tagName=tag;this.children=[];this.dataset={};this.value='';this.hidden=false;this.disabled=false;this.checked=false;this.attrs={};this._text='';this.listeners={};const set=new Set();this.classList={add:x=>set.add(x),remove:x=>set.delete(x),contains:x=>set.has(x),toggle:(x,v)=>v?set.add(x):set.delete(x)};}
 set textContent(v){this._text=String(v);this.children=[];}get textContent(){return this._text+this.children.map(x=>typeof x==='string'?x:x.textContent).join('');}
 append(...v){this.children.push(...v);}replaceChildren(...v){this._text='';this.children=[...v];}setAttribute(k,v){this.attrs[k]=String(v);}getAttribute(k){return this.attrs[k]??null;}removeAttribute(k){delete this.attrs[k];}get options(){return this.children.filter(x=>x.tagName==='option');}querySelectorAll(){return [];}querySelector(){return new Node('button');}addEventListener(k,fn){this.listeners[k]=fn;}focus(){}remove(){}matches(){return false;}click(){}
}
function app(fetcher,{readTimeoutMs=30000,downloadFailure=null}={}){
 let failure=downloadFailure,dispatched=0;const revoked=[],timers=[];
 const nodes=new Map(),get=id=>{if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id);};
 const document={getElementById:get,createElement:t=>{const n=new Node(t);if(t==='a')n.click=()=>{if(failure==='dispatch')throw Error('SYNTHETIC_PRIVATE_DISPATCH_ERROR');dispatched++;};return n;},querySelectorAll:()=>[],querySelector:()=>null,addEventListener(){},body:new Node()};
 const downloads=[],listeners={},calls=[];class URLMock extends URL{static createObjectURL(blob){if(failure==='url')throw Error('SYNTHETIC_PRIVATE_URL_ERROR');downloads.push(blob);return 'blob:synthetic';}static revokeObjectURL(value){revoked.push(value);}}
 class BlobMock extends Blob{constructor(...args){if(failure==='blob')throw Error('SYNTHETIC_PRIVATE_BLOB_ERROR');super(...args);}}
 let source=appSource.replace(/^import[^\n]+\n/gm,'');source=source.slice(0,source.lastIndexOf('\nshowView();'));
 // JSON.parse belongs to the browser realm, as real response.json() does.
 source=`const fetch=async(...args)=>{const r=await hostFetch(...args);return {status:r.status,ok:r.ok,headers:r.headers,json:async()=>JSON.parse(await r.text())};};\n`+redactionSource+'\n'+source;
 source+='\nglobalThis.a={show,showView,closeDetail,logout,setProject:value=>activeProject=value};';
 const context={document,window:{matchMedia:()=>({matches:false,addEventListener(){}})},location:{hash:'#traces',replace(){}},hostFetch:async(url,options)=>{calls.push({url,options});return fetcher(url,options);},Response,URL:URLMock,URLSearchParams,TextEncoder,AbortController,crypto:webcrypto,Blob:BlobMock,readEventPage:(request,options)=>readEventPage(request,{...options,timeoutMs:readTimeoutMs}),setTimeout:fn=>{timers.push(fn);return 0;},clearTimeout(){},addEventListener:(type,fn)=>{(listeners[type]??=[]).push(fn);}};
 Object.assign(context,{rememberSetupCode(){},pendingSetupCode:()=>null,clearSetupCode(){},clearFirstTraceStorage(){}});runInNewContext(source,context);context.a.setProject('proj_'+'a'.repeat(32));
 return {...context.a,get,downloads,calls,context,revoked,dispatched:()=>dispatched,failDownload:value=>failure=value,runTimers:()=>{for(const fn of timers.splice(0))fn();},fire:type=>listeners[type]?.forEach(fn=>fn()),rules:({paths='',literals=''}={})=>{get('redact-paths').value=paths;get('redact-literals').value=literals;get('redact-paths').listeners.input();},review:()=>{get('redact-reviewed').checked=true;get('redact-reviewed').onchange();},open:async(id='run')=>{await context.a.show(id);get('redact-open').onclick();}};
}
const event=(id='one',data={key:'SYNTHETIC-LOCAL-SECRET',safe:'keep'})=>({id,time:'2026-11-03T00:00:00Z',kind:'note',name:'synthetic',data});
const page=(events,next=null)=>new Response(JSON.stringify({events,next}));
const preview=async ui=>{await ui.open();ui.rules({paths:'/events/*/data/key'});await ui.get('redact-preview').onclick();assert.match(ui.get('redact-status').textContent,/Preview ready/);};
test('reviewed UI collects every page with pinned project and leaves original export intact',async()=>{
 const events=[event('first'),event('second',{key:'other',safe:[0,false,null,'café']})];
 const ui=app(async url=>url.includes('after=next')?page([events[1]]):page([events[0]],'next'));
 await preview(ui);assert.equal(ui.downloads.length,0);assert.equal(ui.get('redact-download').disabled,true);
 const copy=JSON.parse(ui.get('redact-output').textContent);assert.equal(copy.events.length,2);assert.equal(copy.events[0].data.key,'[REDACTED]');assert.deepEqual(copy.events[1].data.safe,events[1].data.safe);assert.match(copy.redaction_notice,/does not guarantee anonymity/);
 ui.get('redact-download').onclick();assert.equal(ui.downloads.length,0);ui.review();ui.get('redact-download').onclick();assert.deepEqual(JSON.parse(await ui.downloads[0].text()),copy);assert.match(ui.get('redact-status').textContent,/Download requested; check your browser’s downloads/);assert.doesNotMatch(ui.get('redact-status').textContent,/downloaded locally/);
 await ui.get('export').onclick();assert.deepEqual(JSON.parse(await ui.downloads[1].text()),{version:1,run_id:'run',events});
 for(const {url,options} of ui.calls){assert.equal(new URL(url,'https://example.test').searchParams.get('project'),'proj_'+'a'.repeat(32));assert.equal(options.method,'GET');assert.equal(options.body,undefined);assert.doesNotMatch(url,/SYNTHETIC-LOCAL-SECRET/);}
 assert.equal(ui.get('redact-paths').value,'');assert.equal(ui.get('redact-output').textContent,'');
});
test('invalid rules never fetch a preview; literal masks and unmatched paths remain explicit',async()=>{
 const ui=app(async()=>page([event()]));await ui.open();const count=ui.calls.length;
 await ui.get('redact-preview').onclick();assert.equal(ui.calls.length,count);assert.match(ui.get('redact-status').textContent,/Choose at least one/);
 ui.rules({paths:'/missing',literals:'SYNTHETIC-LOCAL-SECRET'});await ui.get('redact-preview').onclick();assert.doesNotMatch(ui.get('redact-output').textContent,/SYNTHETIC-LOCAL-SECRET/);assert.match(ui.get('redact-status').textContent,/1 paths did not match/);
});
test('edits, close, same-run reload, new run, view navigation, pagehide and logout discard reviewed copies',async()=>{
 for(const action of [ui=>ui.rules({literals:'changed'}),ui=>ui.get('redact-close').onclick(),ui=>ui.show('run'),ui=>ui.show('other'),ui=>{ui.context.location.hash='#home';ui.showView();},ui=>ui.fire('pagehide'),ui=>ui.logout()]){
  const ui=app(async()=>page([event()]));await preview(ui);ui.review();assert.equal(ui.get('redact-download').disabled,false);await action(ui);
  assert.equal(ui.get('redact-output').textContent,'');assert.equal(ui.get('redact-reviewed').checked,false);assert.equal(ui.get('redact-download').disabled,true);ui.get('redact-download').onclick();assert.equal(ui.downloads.length,0);
 }
});
test('late responses after cancellation, edits and navigation cannot restore a stale preview',async()=>{
 for(const action of [ui=>ui.get('redact-cancel').onclick(),ui=>ui.rules({literals:'new'}),ui=>ui.closeDetail()]){
  let release,delayed=false;const ui=app(async()=>delayed?new Promise(resolve=>{release=resolve;}):page([event()]));await ui.open();ui.rules({paths:'/events/*/data'});delayed=true;const work=ui.get('redact-preview').onclick();await Promise.resolve();
  assert.equal(ui.get('export').disabled,true);assert.equal(ui.get('export-account').disabled,true);const calls=ui.calls.length;await ui.get('export').onclick();await ui.get('export-account').onclick();assert.equal(ui.calls.length,calls);
  action(ui);release(page([event()]));await work;assert.equal(ui.get('redact-output').textContent,'');assert.equal(ui.get('redact-download').disabled,true);assert.equal(ui.downloads.length,0);assert.equal(ui.get('export').disabled,false);assert.equal(ui.get('export-account').disabled,false);
 }
});
test('2 MiB preview budget stops later reads before retaining oversized data and original export still works',async()=>{
 const events=Array.from({length:10},(_,i)=>event(String(i),{text:'x'.repeat(32000)}));let reads=0;
 const ui=app(async()=>page(events,++reads<9?'page'+reads:null));await ui.open();reads=0;ui.rules({paths:'/events/*/data'});await ui.get('redact-preview').onclick();assert.equal(reads,7);assert.match(ui.get('redact-status').textContent,/2 MiB/);assert.equal(ui.get('redact-output').textContent,'');assert.equal(ui.downloads.length,0);
 reads=0;await ui.get('export').onclick();assert.equal(JSON.parse(await ui.downloads[0].text()).events.length,90);
});
test('malformed/cyclic pages and cancelled rate-limit waits fail closed',async()=>{
 for(const malformed of [null,{events:[]},{events:[],next:'same'}]){
  let reads=0;const ui=app(async()=>++reads===1?page([event()]):new Response(JSON.stringify(malformed)));await ui.open();ui.rules({paths:'/events/*/data'});await ui.get('redact-preview').onclick();assert.equal(ui.downloads.length,0);assert.equal(ui.get('redact-output').textContent,'');assert.equal(ui.get('redact-download').disabled,true);assert.ok(reads<=3);
 }
 let limited=false;const ui=app(async()=>limited?new Response('{}',{status:429,headers:{'retry-after':'60'}}):page([event()]));await ui.open();ui.rules({paths:'/events/*/data'});limited=true;const work=ui.get('redact-preview').onclick();for(let i=0;i<20&&!ui.get('redact-status').textContent.startsWith('Preview paused');i++)await new Promise(resolve=>setImmediate(resolve));assert.match(ui.get('redact-status').textContent,/Preview paused/);ui.get('redact-cancel').onclick();await work;assert.match(ui.get('redact-status').textContent,/cancelled/);assert.equal(ui.downloads.length,0);
});
test('an already reviewed draft cannot download after the project changes',async()=>{const ui=app(async()=>page([event()]));await preview(ui);ui.review();ui.setProject('proj_'+'b'.repeat(32));ui.get('redact-download').onclick();assert.equal(ui.downloads.length,0);});

test('hung redacted preview settles with no draft/download and original controls recover',async()=>{let reads=0,release;const ui=app(async()=>++reads===1?page([event()]):new Promise(resolve=>release=resolve),{readTimeoutMs:10});await ui.open();ui.rules({paths:'/events/*/data'});await ui.get('redact-preview').onclick();assert.match(ui.get('redact-status').textContent,/took too long/);assert.equal(ui.get('redact-output').textContent,'');assert.equal(ui.get('redact-download').disabled,true);assert.equal(ui.get('export').disabled,false);assert.equal(ui.get('redact-preview').disabled,false);release(page([event('late')]));await new Promise(resolve=>setImmediate(resolve));assert.equal(ui.get('redact-output').textContent,'');assert.equal(ui.downloads.length,0);});

test('the actual UI reports masked identifiers, surviving references and collisions before review and in the downloaded copy',async()=>{
 const events=[event('first',{observation:{id:'original-parent',traceId:'original-trace',parentObservationId:null}}),event('second',{observation:{id:'original-child',traceId:'original-trace',parentObservationId:'original-parent'},ref:'run'})];
 const ui=app(async url=>url.includes('after=next')?page([events[1]]):page([events[0]],'next'));await ui.open();ui.rules({paths:'/run_id\n/events/*/id\n/events/*/data/observation/id'});await ui.get('redact-preview').onclick();
 const copy=JSON.parse(ui.get('redact-output').textContent);assert.equal(copy.redaction_identifiers.changed_fields,5);assert.equal(copy.redaction_identifiers.unchanged_value_occurrences,2);assert.equal(copy.redaction_identifiers.collapsed_values,5);assert.equal(copy.events[1].data.observation.parentObservationId,'original-parent');assert.match(ui.get('redact-status').textContent,/5 fields changed.*2 unchanged occurrences.*5 distinct values collapse.*Links may be broken/);
 assert.equal(ui.get('redact-download').disabled,true);ui.review();ui.get('redact-download').onclick();assert.deepEqual(JSON.parse(await ui.downloads[0].text()),copy);assert.equal(events[0].id,'first');assert.equal(events[0].data.observation.id,'original-parent');
 ui.rules({paths:'/events/*/data'});assert.equal(ui.get('redact-download').disabled,true);assert.equal(ui.get('redact-output').textContent,'');await ui.get('redact-preview').onclick();const removed=JSON.parse(ui.get('redact-output').textContent);assert.equal(removed.redaction_identifiers.omitted_fields,5);assert.match(ui.get('redact-status').textContent,/including 5 omitted/);assert.equal(ui.get('redact-download').disabled,true);
});

for(const phase of ['blob','url','dispatch'])test('redacted download failure at '+phase+' preserves reviewed bytes and permits only an explicit retry',async()=>{
 const ui=app(async()=>page([event()]),{downloadFailure:phase});await preview(ui);ui.review();
 const reviewed=ui.get('redact-output').textContent,calls=ui.calls.length;
 assert.doesNotThrow(()=>ui.get('redact-download').onclick());
 assert.match(ui.get('redact-status').textContent,/could not be confirmed/);
 assert.doesNotMatch(ui.get('redact-status').textContent,/SYNTHETIC_PRIVATE|Download requested|saved|complete/i);
 assert.equal(ui.dispatched(),0);assert.equal(ui.get('redact-output').textContent,reviewed);
 assert.equal(ui.get('redact-reviewed').checked,true);assert.equal(ui.get('redact-download').disabled,false);
 assert.equal(ui.calls.length,calls,'no automatic read, upload or retry');ui.runTimers();
 assert.deepEqual(ui.revoked,phase==='dispatch'?['blob:synthetic']:[]);
 ui.failDownload(null);ui.get('redact-download').onclick();assert.equal(ui.dispatched(),1);
 assert.equal(await ui.downloads.at(-1).text(),reviewed);assert.match(ui.get('redact-status').textContent,/Download requested/);
 ui.runTimers();assert.equal(ui.revoked.length,phase==='dispatch'?2:1);assert.equal(ui.calls.length,calls);
});
