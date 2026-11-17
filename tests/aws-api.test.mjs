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
