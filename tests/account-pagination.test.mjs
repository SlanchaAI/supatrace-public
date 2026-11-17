import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
import {getEventListeners} from 'node:events';
import {handle} from '../src/aws-api.mjs';
import {DynamoMetadataStore,digest} from '../src/dynamodb-store.mjs';
import {MemoryDynamo,commandClasses} from './memory-dynamo.mjs';
import {alphaProject} from '../src/alpha-projects.mjs';
import {loadAccountRuns,queryAccountRuns} from '../public/app/run-data.js';
const origin='https://supatrace.dev',session='s'.repeat(43),otherSession='o'.repeat(43);
async function fixture(count=1605) {
 const client=new MemoryDynamo(),store=new DynamoMetadataStore({client,commands:commandClasses(),tableName:'synthetic',now:()=>1800000000});
 const {tenant_id:tenant}=await store.getOrCreateGoogleTenant('synthetic-catalog-subject');
 const {tenant_id:other}=await store.getOrCreateTenant(999999);
 await store.createSession(digest(session),tenant);await store.createSession(digest(otherSession),other);
 const project=alphaProject(tenant).id;
 const add=i=>{const run_id='run-'+String(i).padStart(4,'0'),pk='TENANT#'+tenant,sk='RUN#'+run_id;
  client.items.set(pk+'\0'+sk,{pk,sk,run_id,created_at:1700000000+i,started_at:1700000000000+i*1000,
   ended_at:1700000000000+i*1010,writers:[(i%3?'a':'b').repeat(64)],event_count:i+1,batch_count:1,byte_count:100,has_error:!!(i%2)});};
 for(let i=0;i<count;i++)add(i);
 const env={ENABLED:true,APP_ORIGIN:origin,GITHUB_CLIENT_ID:'synthetic',GITHUB_CLIENT_SECRET:'synthetic-only',store,objects:{}};
 let queries=0;const list=store.listRuns.bind(store);store.listRuns=async(...args)=>{queries++;return list(...args);};
 const request=(path,token=session)=>handle(new Request(origin+path,{headers:token?{cookie:'__Host-supatrace='+token}:{}}),env);
 const fetchPage=async(path,signal)=>{if(signal?.aborted)throw Error('aborted');const response=await request('/api/'+path+(path.includes('?')?'&':'?')+'project='+project);const body=await response.json();if(!response.ok)throw Object.assign(Error(body.error),{status:response.status,retryAfter:Number(response.headers.get('retry-after'))});return body;};
 return {store,request,fetchPage,project,otherProject:alphaProject(other).id,queries:()=>queries,add};
}
test('actual API continues beyond800 and complete client query finds later IDs globally',async()=>{
 const f=await fixture();const first=await(await f.request('/api/runs/page?project='+f.project)).json();
 assert.equal(first.runs.length,800);assert.equal(first.complete,false);assert.ok(first.next);assert.equal(f.queries(),8);
 const catalog=await loadAccountRuns(f.fetchPage,{projectId:f.project});
 assert.equal(catalog.length,1605);assert.equal(new Set(catalog.map(row=>row.id)).size,1605);
 assert.deepEqual(catalog.map(row=>row.id).sort(),Array.from({length:1605},(_,i)=>'run-'+String(i).padStart(4,'0')));
 assert.equal(queryAccountRuns(catalog,'q=run-1604').runs[0].id,'run-1604');
 assert.equal(queryAccountRuns(catalog,'sort=started&dir=desc').runs[0].id,'run-1604');
 assert.equal(queryAccountRuns(catalog,'sort=events&dir=asc').runs[0].id,'run-0000');
 assert.equal(queryAccountRuns(catalog,'sort=started&dir=desc&offset=800').runs[0].id,'run-0804');
 assert.equal(queryAccountRuns(catalog,'q=run-15').total,100);
 assert.equal(queryAccountRuns(catalog,'agent='+'b'.repeat(64)).total,535);
 const bounds=new URLSearchParams({from:'2023-11-14T22:38:20Z',to:'2023-11-14T22:40:04Z'});
 assert.equal(queryAccountRuns(catalog,bounds).total,105);
 const legacy=await(await f.request('/api/runs?q=run-1604')).json();assert.equal(legacy.truncated,true);assert.equal(legacy.total,0);
});
test('actual API session, expected project and cursor tenant binding fail closed',async()=>{
 const f=await fixture();assert.equal((await f.request('/api/runs/page',null)).status,401);
 assert.equal((await f.request('/api/runs/page?project='+f.otherProject)).status,403);
 const page=await(await f.request('/api/runs/page')).json();
 assert.equal((await f.request('/api/runs/page?after='+page.next,otherSession)).status,400);
 for(const path of ['/api/runs/page?after=','/api/runs/page?after=a&after=b','/api/runs/page?sort=events'])assert.equal((await f.request(path)).status,400);
 const other=await(await f.request('/api/runs/page',otherSession)).json();assert.equal(other.project_id,f.otherProject);assert.deepEqual(other.runs,[]);assert.equal(other.complete,true);
});
test('repeated or malformed backend continuation is refused within bounded reads',async()=>{
 const f=await fixture(0);let calls=0;
 f.store.listRuns=async()=>{calls++;return{items:[],next:'same'};};
 assert.equal((await f.request('/api/runs/page')).status,503);assert.equal(calls,2);
 f.store.listRuns=async()=>({items:[],next:undefined});assert.equal((await f.request('/api/runs/page')).status,503);
});
test('client refuses wrong project, duplicates, repeated cursor and false completion',async()=>{
 const f=await fixture(1),good=await f.fetchPage('runs/page');
 for(const page of [{...good,project_id:f.otherProject},{...good,runs:[...good.runs,...good.runs]},
  {...good,next:'next',complete:true},{...good,next:null,complete:false},null,false]) {
  await assert.rejects(loadAccountRuns(async()=>page,{projectId:f.project}),/invalid_run_page/);
 }
 let calls=0;await assert.rejects(loadAccountRuns(async()=>{calls++;return{...good,runs:[],next:'same',complete:false};},{projectId:f.project}),/invalid_run_page/);assert.equal(calls,2);
});
test('interrupted and oversized scans never return partial totals or catalogs',async()=>{
 const f=await fixture(),abort=new AbortController(),progress=[];let calls=0;
 await assert.rejects(loadAccountRuns(async(path,signal)=>{const page=await f.fetchPage(path,signal);if(++calls===2)abort.abort();return page;},
  {projectId:f.project,signal:abort.signal,onProgress:value=>progress.push(value)}),/cancelled/);
 assert.equal(progress.length,1);assert.equal(progress[0].complete,false);
 await assert.rejects(loadAccountRuns(f.fetchPage,{projectId:f.project,maxRuns:1000}),/too_large/);
 await assert.rejects(loadAccountRuns(f.fetchPage,{projectId:f.project,maxBytes:100}),/too_large/);
});
test('bounded429 recovery and aborted waits retain prior catalog pages without duplicates',async()=>{
 const f=await fixture(1);let calls=0,waits=[];
 const rows=await loadAccountRuns(async(path,signal)=>{if(++calls===1)throw Object.assign(Error('rate_limit'),{status:429,retryAfter:1});return f.fetchPage(path,signal);},
  {projectId:f.project,sleep:async ms=>waits.push(ms)});
 assert.equal(rows.length,1);assert.deepEqual(waits,[1000]);
 await assert.rejects(loadAccountRuns(async()=>{throw Object.assign(Error('rate_limit'),{status:429,retryAfter:61});},{projectId:f.project}),/rate_limited/);
});

class Node {constructor(tag='div'){this.tagName=tag;this.children=[];this.dataset={};this.value='';this.hidden=false;this.disabled=false;this.attrs={};this._text='';const set=new Set();this.classList={add:x=>set.add(x),remove:x=>set.delete(x),contains:x=>set.has(x),toggle:(x,v)=>v?set.add(x):set.delete(x)};}set textContent(v){this._text=String(v);this.children=[];}get textContent(){return this._text+this.children.map(x=>typeof x==='string'?x:x.textContent).join('');}append(...v){this.children.push(...v);}replaceChildren(...v){this._text='';this.children=[...v];}setAttribute(k,v){this.attrs[k]=String(v);}getAttribute(k){return this.attrs[k]??null;}removeAttribute(k){delete this.attrs[k];}get options(){return this.children.filter(x=>x.tagName==='option');}querySelectorAll(){return [];}querySelector(){return new Node('button');}addEventListener(){}focus(){}remove(){}matches(){return false;}}
function app(f) {
 const nodes=new Map(),get=id=>{if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id);};
 const document={getElementById:get,createElement:t=>new Node(t),querySelectorAll:()=>[],querySelector:()=>null,addEventListener(){},body:new Node()};
 let source=readFileSync(new URL('../public/app/app.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/gm,'');
 source=source.slice(0,source.lastIndexOf('\nshowView();'));source+='\nactiveProject='+JSON.stringify(f.project)+';globalThis.testApp={runs,clearRunCatalog};';
 const context={document,window:{matchMedia:()=>({matches:false,addEventListener(){}})},location:{hash:'#traces'},
  fetch:async(path,options)=>f.request(path),Response,URL,URLSearchParams,TextEncoder,AbortController,crypto:webcrypto,Blob,
  loadAccountRuns,queryAccountRuns,setTimeout:()=>0,clearTimeout(){},addEventListener(){}};
 Object.assign(context,{rememberSetupCode(){},pendingSetupCode:()=>null,clearSetupCode(){},clearFirstTraceStorage(){}});runInNewContext(source,context);return{a:context.testApp,get};
}
test('actual dashboard uses all pages, global search, cache reuse and fresh refresh',async()=>{
 const f=await fixture(),ui=app(f);await ui.a.runs();
 assert.match(ui.get('page-note').textContent,/of 1605/);assert.equal(ui.get('list-limit').hidden,true);
 const reads=f.queries();ui.get('trace-search').value='run-1604';await ui.a.runs();
 assert.match(ui.get('page-note').textContent,/of 1/);assert.match(ui.get('runs').textContent,/run-1604/);assert.equal(f.queries(),reads);
 f.add(1605);ui.get('trace-search').value='';await ui.get('refresh').onclick();
 assert.match(ui.get('page-note').textContent,/of 1606/);assert.ok(f.queries()>reads);
});

const settle=work=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('operation did not settle')),2000);Promise.resolve(work).then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('catalog deadline settles a hung later read without partial completion or late progress',async()=>{
 const project='proj_'+'a'.repeat(32),parent=new AbortController(),progress=[];let reads=0,release,child;
 const work=loadAccountRuns((_path,signal)=>{child=signal;if(++reads===1)return{project_id:project,runs:[],next:'next',complete:false};return new Promise(resolve=>release=resolve);},{projectId:project,signal:parent.signal,totalTimeoutMs:20,onProgress:p=>progress.push(p)});
 await assert.rejects(settle(work),/run_load_deadline/);assert.equal(reads,2);assert.equal(child.aborted,true);assert.equal(parent.signal.aborted,false);assert.equal(getEventListeners(parent.signal,'abort').length,0);assert.equal(getEventListeners(child,'abort').length,0);assert.deepEqual(progress,[{loaded:0,complete:false}]);
 release({project_id:project,runs:[],next:'later',complete:false});await tick();assert.equal(reads,2);assert.equal(progress.length,1);
 assert.deepEqual(await loadAccountRuns(async()=>({project_id:project,runs:[],next:null,complete:true}),{projectId:project,signal:parent.signal}),[]);
});
test('catalog cancellation settles ignored abort and observes a late rejection without another request',async()=>{
 const project='proj_'+'a'.repeat(32),parent=new AbortController();let rejectRead,reads=0;
 const work=loadAccountRuns(()=>{reads++;return new Promise((_,reject)=>rejectRead=reject);},{projectId:project,signal:parent.signal});await tick();assert.equal(reads,1);parent.abort();await assert.rejects(settle(work),/run_load_cancelled/);assert.equal(getEventListeners(parent.signal,'abort').length,0);
 rejectRead(Error('late synthetic transport failure'));await tick();assert.equal(reads,1);
 await assert.rejects(loadAccountRuns(()=>{reads++;},{projectId:project,signal:parent.signal}),/run_load_cancelled/);assert.equal(reads,1);
 const synchronous=new AbortController();await assert.rejects(settle(loadAccountRuns(()=>{synchronous.abort();return new Promise(()=>{});},{projectId:project,signal:synchronous.signal})),/run_load_cancelled/);assert.equal(getEventListeners(synchronous.signal,'abort').length,0);
});
test('catalog abort and deadline settle ignored rate-limit waits without retrying after stop',async()=>{
 const project='proj_'+'a'.repeat(32);
 for(const timeout of [false,true]){let reads=0,release;const parent=new AbortController();const work=loadAccountRuns(()=>{reads++;throw Object.assign(Error('rate_limit'),{status:429,retryAfter:1});},{projectId:project,signal:parent.signal,totalTimeoutMs:timeout?20:300000,sleep:()=>new Promise(resolve=>release=resolve)});await tick();assert.equal(typeof release,'function');if(!timeout)parent.abort();await assert.rejects(settle(work),timeout?/run_load_deadline/:/run_load_cancelled/);assert.equal(parent.signal.aborted,!timeout);release();await tick();assert.equal(reads,1);}
 let reads=0,waits=0;await assert.rejects(loadAccountRuns(()=>{reads++;throw Object.assign(Error('rate_limit'),{status:429,retryAfter:1});},{projectId:project,sleep:async()=>{waits++;}}),/run_load_rate_limited/);assert.equal(reads,6);assert.equal(waits,5);
});
