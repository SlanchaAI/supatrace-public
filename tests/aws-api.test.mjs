import test from 'node:test';import assert from 'node:assert/strict';import {handle} from '../src/aws-api.mjs';import {digest} from '../src/aws-auth.mjs';import {alphaProject} from '../src/alpha-projects.mjs';
const token='a'.repeat(43),raw=JSON.stringify({version:1,batch_id:'batch1',run_id:'run1',events:[{id:'event1',time:'2026-10-21T00:00:00Z',kind:'note',name:'synthetic',data:{safe:true}}]});
function fixture(){const rows=new Map(),objects=new Map();let writes=0,acceptFails=false;
 const store={getTenant:async()=>({tenant_id:'github-1'}),consumeRate:async()=>({allowed:true}),lookupWriteKey:async h=>h===digest(token)?{tenant_id:'github-1'}:null,getSession:async h=>h===digest(token)?{tenant_id:'github-1'}:null,
 reserveBatch:async(t,b)=>{const k=t+b.batch_id,old=rows.get(k);if(old&&old.request_hash!==b.request_hash)throw {status:409,code:'idempotency_conflict'};if(old)return old;const row={...b,status:'pending',object_key:`${t}/${b.request_hash}`};rows.set(k,row);return row;},
 acceptReservedBatch:async(t,id)=>{if(acceptFails){acceptFails=false;throw Error('transient');}rows.get(t+id).status='accepted';},listRuns:async()=>({items:[],next:null}),listAcceptedBatchIndexes:async()=>({items:[],next:null})};
 return {env:{ENABLED:true,APP_ORIGIN:'https://supatrace.dev',GITHUB_CLIENT_ID:'synthetic',GITHUB_CLIENT_SECRET:'synthetic-not-secret',store,objects:{putImmutable:async(k,v)=>{writes++;objects.set(k,v)},get:async k=>objects.get(k)}},rows,objects,writes:()=>writes,failAccept:()=>{acceptFails=true}};}
function upload(body=raw,key=token){return new Request('https://supatrace.dev/api/batches',{method:'POST',headers:{'content-type':'application/json','x-supatrace-key':key,'x-amz-content-sha256':digest(body)},body});}
test('unconfigured preview fails closed',async()=>assert.equal((await handle(upload(),{})).status,503));
test('accepted receipt only follows durable object and metadata',async()=>{const f=fixture(),r=await handle(upload(),f.env);assert.equal(r.status,201);assert.deepEqual(await r.json(),{accepted:true,batch_id:'batch1',request_hash:digest(raw),project_id:alphaProject('github-1').id});assert.equal(f.rows.get('github-1batch1').status,'accepted');assert.equal(f.objects.size,1)});
test('accepted duplicate does not repeat object write',async()=>{const f=fixture();await handle(upload(),f.env);await handle(upload(),f.env);assert.equal(f.writes(),1)});
test('metadata failure after object put is retryable, never premature ack',async()=>{const f=fixture();f.failAccept();assert.equal((await handle(upload(),f.env)).status,503);assert.equal(f.rows.get('github-1batch1').status,'pending');assert.equal((await handle(upload(),f.env)).status,201);assert.equal(f.objects.size,1)});
test('conflicting batch content returns conflict',async()=>{const f=fixture();await handle(upload(),f.env);assert.equal((await handle(upload(raw.replace('synthetic','different')),f.env)).status,409)});
test('write key cannot retrieve private runs',async()=>{const f=fixture();const r=await handle(new Request('https://supatrace.dev/api/runs',{headers:{'x-supatrace-key':token}}),f.env);assert.equal(r.status,401)});
test('invalid key cannot reserve or store',async()=>{const f=fixture();assert.equal((await handle(upload(raw,'b'.repeat(43)),f.env)).status,401);assert.equal(f.objects.size,0);assert.equal(f.rows.size,0)});
test('missing body hash rejected',async()=>{const f=fixture(),r=upload();r.headers.delete('x-amz-content-sha256');assert.equal((await handle(r,f.env)).status,400)});


test('general request budget permits dashboard setup and still rejects a sustained flood',async()=>{
 const {DynamoMetadataStore}=await import('../src/dynamodb-store.mjs');
 const {MemoryDynamo,commandClasses}=await import('./memory-dynamo.mjs');
 const store=new DynamoMetadataStore({client:new MemoryDynamo(),commands:commandClasses(),tableName:'synthetic-rate-test',now:()=>1800000000});
 const f=fixture();f.env.store=store;f.env.sourceIp='192.0.2.222';
 const health=()=>handle(new Request('https://supatrace.dev/api/public/health'),f.env);
 for(let i=0;i<300;i++)assert.equal((await health()).status,200,'ordinary dashboard request '+(i+1));
 const blocked=await health();assert.equal(blocked.status,429);assert.equal(blocked.headers.get('Retry-After'),'60');assert.deepEqual(await blocked.json(),{error:'rate_limit'});
});

// Event timestamps may describe delivery while explicit spans describe the work itself.
test('ingest summary uses root span boundaries rather than event arrival timestamps',async()=>{
 const f=fixture();let summary;
 f.env.store.acceptReservedBatch=async(_tenant,_id,_hash,trace)=>{summary=trace;};
 const body=JSON.stringify({version:1,batch_id:'timing',run_id:'timing',events:[
  {id:'root',time:'2026-10-21T00:00:00.000Z',kind:'note',name:'Root',data:{span_id:'root',startTime:'2026-10-21T00:00:00.000Z',endTime:'2026-10-21T00:00:00.080Z'}},
  {id:'child',time:'2026-10-21T00:00:00.025Z',kind:'note',name:'Child',data:{span_id:'child',parent_span_id:'root',duration_ms:10}}
 ]});
 assert.equal((await handle(upload(body),f.env)).status,201);
 assert.equal(summary.ended_at-summary.started_at,80);
});

// These use HTTP -> real ingest conversion -> real metadata store -> list handler.
import {start as startDurationHarness} from './harness.mjs';
import {buildSpans as durationView} from '../public/app/span-data.js';
const durationAt=ms=>new Date(Date.parse('2026-11-17T00:00:00Z')+ms).toISOString();
async function durationSession(live){let cookie='';const tenant=await live.signIn({addCookies:async values=>{cookie=values.map(c=>c.name+'='+c.value).join('; ');}});return {tenant,cookie,key:await live.writeKey(tenant)};}
async function durationList(live,cookie,query=''){const response=await fetch(live.origin+'/api/runs'+query,{headers:{cookie}});assert.equal(response.status,200);return (await response.json()).runs;}
async function durationEvents(live,cookie,run){const events=[];let after='';do{const response=await fetch(live.origin+'/api/events?run='+run+(after?'&after='+after:''),{headers:{cookie}});assert.equal(response.status,200);const page=await response.json();events.push(...page.events);after=page.next;}while(after);return events;}
const durationSpan=(spanId,parent,start,end)=>({traceId:'0123456789abcdef0123456789abcdef',spanId,...(parent?{parentSpanId:parent}:{}),name:spanId,startTimeUnixNano:String(BigInt(Date.parse(durationAt(start)))*1000000n),endTimeUnixNano:String(BigInt(Date.parse(durationAt(end)))*1000000n),attributes:[],status:{code:1}});
test('OTLP ingest lists a 1000 ms root with a child ending at 2500 ms, with matching sorting and detail',async()=>{
 const live=await startDurationHarness();try{
  const {cookie,key}=await durationSession(live);
  const response=await fetch(live.origin+'/v1/traces',{method:'POST',headers:{'content-type':'application/json','x-supatrace-key':key},body:JSON.stringify({resourceSpans:[{scopeSpans:[{spans:[durationSpan('1111111111111111',null,0,1000),durationSpan('2222222222222222','1111111111111111',100,2500)]}]}]})});
  assert.equal(response.status,200);
  await live.upload(key,{version:1,batch_id:'comparison',run_id:'comparison',events:[{id:'comparison',time:durationAt(0),kind:'note',name:'comparison',data:{span_id:'comparison',startTime:durationAt(0),endTime:durationAt(1500)}}]});
  const run='otlp.0123456789abcdef0123456789abcdef';
  const asc=await durationList(live,cookie,'?sort=duration&dir=asc');assert.deepEqual(asc.map(row=>[row.id,row.duration_ms]),[[run,1000],['comparison',1500]]);
  assert.equal(Date.parse(asc[0].ended_at)-Date.parse(asc[0].started_at),2500);
  assert.deepEqual((await durationList(live,cookie,'?sort=duration&dir=desc')).map(row=>row.id),['comparison',run]);
  assert.equal(durationView(await durationEvents(live,cookie,run)).duration_ms,1000);
  const catalog=await (await fetch(live.origin+'/api/runs/page',{headers:{cookie}})).json();assert.equal(catalog.runs.find(row=>row.id===run).duration_ms,1000);
 }finally{await live.close();}
});
test('batch roots and parent links join across accepted uploads; oldest roots and unfinished fallback persist',async()=>{
 const live=await startDurationHarness();try{
  const {cookie,key}=await durationSession(live);
  const upload=async(id,data,time=0)=>live.upload(key,{version:1,batch_id:id,run_id:'split',events:[{id,time:durationAt(time),kind:'note',name:id,data}]});
  await upload('child',{span_id:'child',parent_span_id:'root',start_time:durationAt(100),end_time:durationAt(2500)});
  assert.equal((await durationList(live,cookie))[0].duration_ms,2400);
  await upload('later',{span_id:'later',start_time:durationAt(500),end_time:durationAt(2000)});
  assert.equal((await durationList(live,cookie))[0].duration_ms,1500);
  await upload('root-start',{span_id:'root',start_time:durationAt(0)});
  assert.equal((await durationList(live,cookie))[0].duration_ms,2500);
  await upload('root-end',{span_id:'root',end_time:durationAt(1000)},4000);
  assert.equal((await durationList(live,cookie))[0].duration_ms,1000);
  assert.equal(durationView(await durationEvents(live,cookie,'split')).duration_ms,1000);
 }finally{await live.close();}
});
for(const alias of ['parent_span_id','parentSpanId'])test(`batch ingest preserves unsupported ${alias} across stored updates`,async()=>{
 const live=await startDurationHarness();try{
  const {cookie,key}=await durationSession(live);
  for(const nested of [false,true]){
   const run='unsupported-'+nested,other=alias==='parent_span_id'?'parentSpanId':'parent_span_id';
   const child={spanId:'child',[alias]:'x'.repeat(129),[other]:'',startTime:durationAt(-100),endTime:durationAt(2500)};
   const events=[{id:'root',time:durationAt(0),kind:'note',name:'root',data:{spanId:'root',startTime:durationAt(0),endTime:durationAt(1000)}},
    {id:'child',time:durationAt(-100),kind:'note',name:'child',data:nested?{span:child}:child}];
   await live.upload(key,{version:1,batch_id:run,run_id:run,events});
   assert.equal((await durationList(live,cookie)).find(row=>row.id===run).duration_ms,1000);
   assert.equal(durationView(await durationEvents(live,cookie,run)).duration_ms,1000);
   await live.upload(key,{version:1,batch_id:run+'-update',run_id:run,events:[{id:'update',time:durationAt(4000),kind:'note',name:'child',data:{spanId:'child',endTime:durationAt(3000)}}]});
   assert.equal((await durationList(live,cookie)).find(row=>row.id===run).duration_ms,1000);
   assert.equal(durationView(await durationEvents(live,cookie,run)).duration_ms,1000);
  }
 }finally{await live.close();}
});
test('Langfuse nonempty parents survive conversion limits and stored updates for root selection',async()=>{
 const live=await startDurationHarness();try{
  const {cookie,key}=await durationSession(live);
  const parents=['x'.repeat(129),'x'.repeat(200),'x'.repeat(201),42,0,false,true,[],{}];
  const send=async batch=>{const response=await fetch(live.origin+'/api/public/ingestion',{method:'POST',headers:{'content-type':'application/json','x-supatrace-key':key},body:JSON.stringify({batch})});assert.equal(response.status,207);const result=await response.json();assert.deepEqual(result.errors,[]);assert.equal(result.successes.length,batch.length);};
  await send(parents.flatMap((parentObservationId,index)=>[
   {id:'root-'+index,type:'span-create',timestamp:durationAt(0),body:{id:'root',traceId:'unsupported-'+index,startTime:durationAt(0),endTime:durationAt(1000)}},
   {id:'child-'+index,type:'span-create',timestamp:durationAt(-100),body:{id:'child',traceId:'unsupported-'+index,parentObservationId,startTime:durationAt(-100),endTime:durationAt(2500)}}
  ]));
  const check=async()=>{const rows=await durationList(live,cookie);for(const index of parents.keys()){
   const run='lf.unsupported-'+index;
   assert.equal(rows.find(row=>row.id===run).duration_ms,1000,run+' list');
   assert.equal(durationView(await durationEvents(live,cookie,run)).duration_ms,1000,run+' detail');
  }};
  await check();
  await send(parents.map((_,index)=>({id:'update-'+index,type:'span-update',timestamp:durationAt(4000),body:{id:'child',traceId:'unsupported-'+index,endTime:durationAt(3000)}})));
  await check();
 }finally{await live.close();}
});
test('Langfuse accepted long root IDs retain timing through ingestion, split updates, list and detail',async()=>{
 const live=await startDurationHarness();try{
  const {cookie,key}=await durationSession(live);
  const send=async batch=>{const response=await fetch(live.origin+'/api/public/ingestion',{method:'POST',headers:{'content-type':'application/json','x-supatrace-key':key},body:JSON.stringify({batch})});assert.equal(response.status,207);const result=await response.json();assert.deepEqual(result.errors,[]);assert.equal(result.successes.length,batch.length);};
  for(const length of [128,129,200])for(const mode of ['complete','start-first','end-first']){
   const traceId='long-'+length+'-'+mode,id='r'.repeat(length);
   const root=(suffix,type,timing)=>({id:traceId+'-'+suffix,type,timestamp:durationAt(4000),body:{id,traceId,...timing}});
   const start=root('start','span-create',{startTime:durationAt(0)}),end=root('end','span-update',{endTime:durationAt(1000)});
   const child={id:traceId+'-child',type:'span-create',timestamp:durationAt(100),body:{id:'child',traceId,parentObservationId:id,startTime:durationAt(100),endTime:durationAt(2500)}};
   if(mode==='complete')await send([root('full','span-create',{startTime:durationAt(0),endTime:durationAt(1000)}),child]);
   else{const ordered=mode==='start-first'?[start,end]:[end,start];await send([ordered[0],child]);await send([ordered[1]]);}
   const run='lf.'+traceId;
   assert.equal((await durationList(live,cookie)).find(row=>row.id===run).duration_ms,1000,run+' list');
   assert.equal(durationView(await durationEvents(live,cookie,run)).duration_ms,1000,run+' detail');
  }
 }finally{await live.close();}
});
test('Langfuse updates join root times across requests without promoting parentless child updates',async()=>{
 const live=await startDurationHarness();try{
  const {cookie,key}=await durationSession(live);
  const send=async batch=>{const response=await fetch(live.origin+'/api/public/ingestion',{method:'POST',headers:{'content-type':'application/json','x-supatrace-key':key},body:JSON.stringify({batch})});assert.equal(response.status,207);const result=await response.json();assert.deepEqual(result.errors,[]);};
  // End before start also works: all facts remain on immutable batch indexes.
  await send([{id:'end',type:'span-update',timestamp:durationAt(4000),body:{id:'root',traceId:'split',endTime:durationAt(1000)}}]);
  await send([{id:'start',type:'span-create',timestamp:durationAt(0),body:{id:'root',traceId:'split',startTime:durationAt(0)}},{id:'child',type:'span-create',timestamp:durationAt(0),body:{id:'child',traceId:'split',parentObservationId:'root',startTime:durationAt(-100),endTime:durationAt(2500)}}]);
  await send([{id:'child-update',type:'span-update',timestamp:durationAt(5000),body:{id:'child',traceId:'split',endTime:durationAt(3000)}}]);
  const row=(await durationList(live,cookie))[0];assert.equal(row.duration_ms,1000);
  assert.equal(durationView(await durationEvents(live,cookie,'lf.split')).duration_ms,1000);
 }finally{await live.close();}
});
test('legacy summaries without root facts keep their stored range after another upload',async()=>{
 const live=await startDurationHarness();try{
  const {cookie,key,tenant}=await durationSession(live);
  await live.store.reserveBatch(tenant,{batch_id:'old',run_id:'legacy',request_hash:'f'.repeat(64),byte_count:1,event_count:1});
  await live.store.acceptReservedBatch(tenant,'old','f'.repeat(64),{started_at:Date.parse(durationAt(0)),ended_at:Date.parse(durationAt(2500)),has_error:false});
  assert.equal((await durationList(live,cookie))[0].duration_ms,2500);
  await live.upload(key,{version:1,batch_id:'new',run_id:'legacy',events:[{id:'new',time:durationAt(0),kind:'note',name:'root',data:{span_id:'root',startTime:durationAt(0),endTime:durationAt(1000)}}]});
  assert.equal((await durationList(live,cookie))[0].duration_ms,2500);
 }finally{await live.close();}
});

// DynamoDB counts UTF-8 attribute names/values plus map/list/element overhead.
const dynamoSize=value=>typeof value==='string'?Buffer.byteLength(value):typeof value==='number'?21:
 value===null||typeof value==='boolean'?1:Array.isArray(value)?3+value.reduce((n,v)=>n+1+dynamoSize(v),0):
 3+Object.entries(value).reduce((n,[k,v])=>n+Buffer.byteLength(k)+1+dynamoSize(v),0);
test('accepted batch timing IDs fit DynamoDB items and join without prefix or encoding collisions',async()=>{
 const live=await startDurationHarness();try{
  const {cookie,key}=await durationSession(live),tx=live.store._tx.bind(live.store),indexes=[];
  live.store._tx=async items=>{
   for(const {Put} of items)if(Put){assert.ok(dynamoSize(Put.Item)<400*1024,'DynamoDB item exceeds 400 KiB');if(Put.Item.span_timings)indexes.push(Put.Item);}
   return tx(items);
  };
  for(const alias of ['span_id','spanId'])for(const nested of [false,true]){
   const run=alias+'-'+nested,ids=Array.from({length:16},(_,i)=>'r'.repeat(29998)+String(i).padStart(2,'0'));
   const data=(id,timing)=>{const span={[alias]:id,...timing};return nested?{span}:span;};
   const events=ids.map((id,i)=>({id:'e'+i,time:durationAt(i?100:0),kind:'note',name:'root',data:data(id,{startTime:durationAt(i?100:0),...(i?{endTime:durationAt(5000)}:{})})}));
   const batch={version:1,batch_id:run,run_id:run,events};
   assert.ok(Buffer.byteLength(JSON.stringify(batch))>480000);
   await live.upload(key,batch);
   // Unfinished root retains today's display-span/event range fallback.
   assert.equal((await durationList(live,cookie)).find(row=>row.id===run).duration_ms,100);
   const index=indexes.at(-1);assert.equal(index.span_timings.length,16);
   assert.equal(new Set(index.span_timings.map(f=>f.id)).size,16);
   assert.ok(index.span_timings.every(f=>Buffer.byteLength(f.id)<=64));
   await live.upload(key,{version:1,batch_id:run+'-end',run_id:run,events:[{id:'end',time:durationAt(4000),kind:'note',name:'root',data:data(ids[0],{endTime:durationAt(1000)})}]});
   assert.equal((await durationList(live,cookie)).find(row=>row.id===run).duration_ms,1000);
   assert.equal(durationView(await durationEvents(live,cookie,run)).duration_ms,1000);
  }
  // UTF-8 replacement would collapse these distinct JavaScript string identities.
  await live.upload(key,{version:1,batch_id:'unicode',run_id:'unicode',events:[
   {id:'start',time:durationAt(0),kind:'note',name:'root',data:{span_id:'\ud800',startTime:durationAt(0)}},
   {id:'other',time:durationAt(100),kind:'note',name:'other',data:{span_id:'\ud801',endTime:durationAt(5000)}}]});
  await live.upload(key,{version:1,batch_id:'unicode-end',run_id:'unicode',events:[{id:'end',time:durationAt(4000),kind:'note',name:'root',data:{span_id:'\ud800',endTime:durationAt(1000)}}]});
  assert.equal((await durationList(live,cookie)).find(row=>row.id==='unicode').duration_ms,1000);
 }finally{await live.close();}
});

test('raw older timing facts join hashed updates and equal-start roots agree with detail',async()=>{
 const live=await startDurationHarness();try{
  const {cookie,key}=await durationSession(live),id='r'.repeat(200);
  await live.upload(key,{version:1,batch_id:'old-raw',run_id:'old-raw',events:[{id:'start',time:durationAt(0),kind:'note',name:'root',data:{spanId:id,startTime:durationAt(0)}}]});
  // Model the index format written before identity hashing, without migration.
  const index=[...live.store.client.items.values()].find(row=>row.span_timings&&row.batch_id==='old-raw');
  delete index.span_timing_ids;index.span_timings[0].id=id;
  await live.upload(key,{version:1,batch_id:'new-hash',run_id:'old-raw',events:[{id:'end',time:durationAt(4000),kind:'note',name:'root',data:{spanId:id,endTime:durationAt(1000)}}]});
  assert.equal((await durationList(live,cookie)).find(row=>row.id==='old-raw').duration_ms,1000);
  assert.equal(durationView(await durationEvents(live,cookie,'old-raw')).duration_ms,1000);
  for(const ids of [['a','b'],['b','a']]){
   const run='tie-'+ids.join('');
   await live.upload(key,{version:1,batch_id:run,run_id:run,events:ids.map((spanId,i)=>({id:'e'+i,time:durationAt(0),kind:'note',name:'root',data:{spanId,startTime:durationAt(0),endTime:durationAt(i?1000:2500)}}))});
   assert.equal((await durationList(live,cookie)).find(row=>row.id===run).duration_ms,1000);
   assert.equal(durationView(await durationEvents(live,cookie,run)).duration_ms,1000);
  }
 }finally{await live.close();}
});
