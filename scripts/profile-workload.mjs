// Offline operation/byte profiler. Only injected in-memory AWS clients are used.
// Input is an explicit JSON array of reviewed batches; output never contains payloads.
import {readFileSync,writeFileSync,statSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {performance} from 'node:perf_hooks';
import {MemoryDynamo,commandClasses} from '../tests/memory-dynamo.mjs';
import {DynamoMetadataStore,digest} from '../src/dynamodb-store.mjs';
import {S3Objects} from '../src/s3-objects.mjs';
import {handle} from '../src/aws-api.mjs';
import {parseBatch} from '../src/trace.mjs';
import {alphaProject} from '../src/alpha-projects.mjs';
import {saveAccountArchive} from '../public/app/account-export.js';

const bytes=value=>Buffer.byteLength(JSON.stringify(value));
const rounds=(size,unit)=>Math.max(1,Math.ceil(size/unit));
const inc=(map,key,n=1)=>{map[key]=(map[key]||0)+n;};
const empty=()=>({http_requests:0,http_statuses:{},request_body_bytes:0,response_body_bytes:0,dynamo_commands:{},dynamo_failures:{},dynamo_item_actions:{},estimated_rrus:0,estimated_wrus:0,s3_commands:{},s3_failures:{},s3_read_bytes:0,s3_write_bytes:0});
const bounded=(n,max,label)=>{if(!Number.isSafeInteger(n)||n<0||n>max)throw Error(label);return n;};

export function validateWorkload(input){
 if(!Array.isArray(input)||!input.length||input.length>1000||bytes(input)>16*1024*1024)throw Error('workload_bounds');
 const seen=new Set();let events=0;
 for(const batch of input){parseBatch(JSON.stringify(batch));if(seen.has(batch.batch_id))throw Error('duplicate_input_batch');seen.add(batch.batch_id);events+=batch.events.length;}
 if(events>100000)throw Error('workload_bounds');
 return structuredClone(input);
}

export async function profileWorkload(input,{copies=1,spacingSeconds=3,exerciseRecovery=true}={}){
 const source=validateWorkload(input);bounded(copies,10,'copies');if(copies<1)throw Error('copies');bounded(spacingSeconds,60,'spacing');
 if(source.length*copies>2000)throw Error('workload_bounds');
 let clock=2000000000,phase='setup';const phases={},metric=()=>phases[phase]||(phases[phase]=empty());
 const memory=new MemoryDynamo();
 const beforeItem=op=>(op.Key||op.Item)?memory._get(op.Key||op.Item):null;
 const size=item=>item?bytes(item):0;
 const client={async send(command){
  const m=metric(),{name,input:op}=command;inc(m.dynamo_commands,name);
  const actions=name==='TransactWriteCommand'?op.TransactItems.map(item=>Object.entries(item)[0]):[[name.replace('Command',''),op]];
  const before=actions.map(([,item])=>size(beforeItem(item)));
  let result,error;
  try{result=await memory.send(command);return result;}catch(e){error=e;inc(m.dynamo_failures,name);throw e;}
  finally{
   if(name==='GetCommand'){m.estimated_rrus+=rounds(size(result?.Item),4096);inc(m.dynamo_item_actions,'strong_get');}
   else if(name==='QueryCommand'){
    // This exact helper query has no filter and Limit<=100. No production latency
    // or real consumed capacity is measured. Empty queries still cost a read.
    m.estimated_rrus+=rounds((result?.Items||[]).reduce((n,item)=>n+size(item),0),4096);inc(m.dynamo_item_actions,'strong_query');
   }else actions.forEach(([kind,item],index)=>{
    inc(m.dynamo_item_actions,(name==='TransactWriteCommand'?'transaction_':'ordinary_')+kind.toLowerCase());
    const after=size(beforeItem(item));
    // JSON bytes are a sizing proxy, not AWS's type-specific size.
    // Canceled transactions conservatively charge all submitted actions.
    // ConditionCheck uses the general transaction-write rule, not a read.
    const transactional=name==='TransactWriteCommand';
    const billable=error&&!transactional?before[index]:Math.max(before[index],after,size(item.Item));
    m.estimated_wrus+=(transactional?2:1)*rounds(billable,1024);
   });
  }
 }};
 const store=new DynamoMetadataStore({client,commands:commandClasses(),tableName:'offline-only',accountCeilingBytes:10485760,now:()=>clock});
 const objectsMap=new Map();let failNextPut=false;
 const s3={async send(command){
  const m=metric(),{name,input}=command;inc(m.s3_commands,name);
  if(name==='PutObjectCommand'){
   if(failNextPut){failNextPut=false;inc(m.s3_failures,name);throw Error('synthetic_disk_or_object_failure');}
   if(objectsMap.has(input.Key)){inc(m.s3_failures,name);throw Object.assign(Error('exists'),{name:'PreconditionFailed'});}
   const raw=Buffer.from(input.Body);objectsMap.set(input.Key,raw);m.s3_write_bytes+=raw.length;return{};
  }
  if(name==='GetObjectCommand'){
   const raw=objectsMap.get(input.Key);if(!raw){inc(m.s3_failures,name);throw Error('missing_synthetic_object');}m.s3_read_bytes+=raw.length;
   return{ContentLength:raw.length,Body:(async function*(){yield raw;})()};
  }
  throw Error('unexpected_object_operation');
 }};
 const commands=Object.fromEntries(['PutObjectCommand','GetObjectCommand'].map(name=>[name,class{constructor(input){this.name=name;this.input=input;}}]));
 const objects=new S3Objects({client:s3,commands,bucket:'offline-only'});
 const tenant='github-1',project=alphaProject(tenant).id,key='k'.repeat(43),session='s'.repeat(43);
 await store.getOrCreateTenant(1);await store.createSession(digest(session),tenant);
 const setup=await store.createSetup(digest(key),project);await store.approveSetup(tenant,setup.user_code);await store.pollSetup(setup.device_secret);
 const env={ENABLED:true,APP_ORIGIN:'https://supatrace.dev',GITHUB_CLIENT_ID:'synthetic',GITHUB_CLIENT_SECRET:'synthetic',sourceIp:'192.0.2.1',store,objects,fetcher:async()=>{throw Error('network_forbidden');}};
 async function call(path,{body=null,hash=null,spacing=spacingSeconds}={}){
  clock+=spacing;const m=metric();m.http_requests++;
  const headers=body===null?{cookie:'__Host-supatrace='+session}:{'content-type':'application/json','x-supatrace-key':key,'x-amz-content-sha256':hash||digest(body)};
  if(body!==null)m.request_body_bytes+=Buffer.byteLength(body);
  const response=await handle(new Request('https://supatrace.dev'+path,{method:body===null?'GET':'POST',headers,body:body??undefined}),env);
  const text=await response.text();m.response_body_bytes+=Buffer.byteLength(text);inc(m.http_statuses,String(response.status));
  return{status:response.status,body:JSON.parse(text)};
 }
 const batches=[];
 for(let copy=0;copy<copies;copy++)for(const batch of source)batches.push({...batch,batch_id:'profile-'+digest(copy+':'+batch.batch_id),run_id:'profile-'+digest(copy+':'+batch.run_id)});
 const rawBatches=batches.map(batch=>JSON.stringify(batch));const accepted=[],rejections={};
 let recoveryUpload=exerciseRecovery?'no_accepted_batch':'disabled';
 const started=performance.now();phase='ingest';
 for(const raw of rawBatches){const response=await call('/api/batches?project='+project,{body:raw});if(response.status===201)accepted.push(raw);else if(response.status===429)inc(rejections,['storage_capacity_or_unknown_tenant','stored_bytes_allowance_exceeded'].includes(response.body.error)?'storage_capacity':'rate_limit');else throw Error('unexpected_ingest_outcome');}
 const ingestElapsedMs=performance.now()-started;
 const reservedBytes=()=>memory._get({pk:'TENANT#'+tenant,sk:'META'}).used_bytes;
 const usedBeforeRecovery=reservedBytes();
 // Recovery probes are separate from the ingestion workload and are never priced
 // as costless: exact replay, conflicting replay, wrong hash and retained reserve.
 if(exerciseRecovery&&accepted.length){
  clock+=60;phase='duplicate';const duplicate=await call('/api/batches?project='+project,{body:accepted[0],spacing:3});if(duplicate.status!==201)throw Error('duplicate_probe_failed');
  phase='conflict';const conflicting=JSON.parse(accepted[0]);conflicting.events[0].name=conflicting.events[0].name==='Synthetic conflicting event'?'Other conflicting event':'Synthetic conflicting event';const conflict=await call('/api/batches?project='+project,{body:JSON.stringify(conflicting),spacing:3});if(conflict.status!==409)throw Error('conflict_probe_failed');
  phase='hash_rejection';const hash=await call('/api/batches?project='+project,{body:accepted[0],hash:'0'.repeat(64),spacing:3});if(hash.status!==400)throw Error('hash_probe_failed');
  phase='failed_upload';const pending=JSON.parse(accepted[0]);pending.batch_id='profile-recovery-'+digest(pending.batch_id);pending.run_id='profile-recovery-'+digest(pending.run_id);const pendingRaw=JSON.stringify(pending);failNextPut=true;
  const failed=await call('/api/batches?project='+project,{body:pendingRaw,spacing:3});
  if(failed.status===429&&['storage_capacity_or_unknown_tenant','stored_bytes_allowance_exceeded'].includes(failed.body.error)){
   recoveryUpload='not_exercised_storage_capacity';failNextPut=false;
  }else{
  if(failed.status!==503)throw Error('failure_probe_failed');
  const reserved=reservedBytes();
  phase='recovery_retry';const retried=await call('/api/batches?project='+project,{body:pendingRaw,spacing:3});if(retried.status!==201)throw Error('retry_probe_failed');
  const recovered=reservedBytes();
  if(reserved!==recovered||reserved!==usedBeforeRecovery+Buffer.byteLength(pendingRaw))throw Error('reservation_accounting_failed');
  recoveryUpload='failed_then_accepted_without_double_reservation';
  }
 }
 clock+=60;phase='export';let archiveBytes=0;const archiveHash=createHash('sha256');
 const loadCatalog=async()=>{
  const runs=[];let after=null;
  do{const page=await call('/api/runs/page?project='+project+(after?'&after='+encodeURIComponent(after):''),{spacing:3});if(page.status!==200)throw Error('catalog_profile_failed');runs.push(...page.body.runs);after=page.body.next;}while(after);
  return runs;
 };
 const archive=await saveAccountArchive({projectId:project,signal:new AbortController().signal,now:()=>new Date(clock*1000).toISOString(),loadCatalog,
  pick:async()=>({createWritable:async()=>({write:async text=>{archiveBytes+=Buffer.byteLength(text);archiveHash.update(text);},close:async()=>{},abort:async()=>{throw Error('archive_profile_aborted');}})}),
  writeRun:async(run,signal,sink)=>{let after=null,events=0,pages=0,batches=0;do{const page=await call('/api/events?project='+project+'&run='+run+(after?'&after='+encodeURIComponent(after):''),{spacing:3});if(page.status!==200)throw Error('event_profile_failed');await sink(page.body.events);events+=page.body.events.length;pages++;if(page.body.events.length)batches++;after=page.body.next;}while(after);return{events,pages,batches};}
 });
 const accountUsedBytes=reservedBytes();
 const stored=[...objectsMap.values()],metadata=[...memory.items.values()];
 return{version:1,mode:'offline_handler_and_adapter_simulation',network_calls:0,measured_aws_billed_duration:false,representative_customer_day:false,
  implementation:{node:process.version,files:Object.fromEntries(['scripts/profile-workload.mjs','tests/memory-dynamo.mjs','src/aws-api.mjs','src/dynamodb-store.mjs','src/s3-objects.mjs','src/trace.mjs','src/alpha-projects.mjs','public/app/account-export.js'].map(path=>[path,digest(readFileSync(new URL('../'+path,import.meta.url)))]))},
  input:{batches:source.length,events:source.reduce((n,b)=>n+b.events.length,0),traces:new Set(source.map(b=>b.run_id)).size,sha256:digest(JSON.stringify(source))},
  scenario:{copies,spacing_seconds:spacingSeconds,attempted_batches:rawBatches.length,accepted_batches:accepted.length,rejected_batches:rawBatches.length-accepted.length,recovery_probes:exerciseRecovery,recovery_upload:recoveryUpload,ingest_rejections:rejections,arrival_model:'simulated clock; not measured throughput'},
  measured:{ingest_local_elapsed_ms:ingestElapsedMs,payload_bytes:stored.reduce((n,b)=>n+b.length,0),gzip_bytes_hypothetical:stored.reduce((n,b)=>n+gzipSync(b).length,0),objects:stored.length,
   metadata_items:metadata.length,metadata_json_bytes:metadata.reduce((n,row)=>n+bytes(row),0),metadata_storage_proxy_bytes:metadata.reduce((n,row)=>n+bytes(row)+100,0),reserved_bytes:accountUsedBytes,
   archive_bytes:archiveBytes,archive_sha256:archiveHash.digest('hex'),archive_runs:archive.runs,archive_events:archive.events},phases,
  limitations:['Existing memory adapter is not DynamoDB, S3 or production latency acceptance.','Capacity estimates use JSON item-size proxies; no AWS ConsumedCapacity receipt. Canceled transactions conservatively count every submitted action; ConditionCheck follows the general transaction-write rule including a minimum for absent items.','Metadata includes live rate/setup/session rows; TTL removal is not simulated.','Response/body bytes exclude HTTP headers, TLS, CDN functions, static assets and network retries.','Gzip is a measured hypothetical alternative; current S3 objects remain raw JSON.','Successful recovery adds one accepted batch beyond the workload; a capacity-blocked probe is reported as not exercised and never claimed successful.','Alpha 10 MiB cumulative quota and request limits remain active; this does not approve commercial limits.']};
}

async function main(){
 const args=process.argv.slice(2);if(args.length<2||args.length>4)throw Error('usage');
 const [inputPath,outputPath,copies='1',spacing='3']=args;
 if(statSync(inputPath).size>16*1024*1024)throw Error('workload_bounds');
 const result=await profileWorkload(JSON.parse(readFileSync(inputPath,'utf8')),{copies:Number(copies),spacingSeconds:Number(spacing)});
 writeFileSync(outputPath,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
 console.log('Offline aggregate measurements saved. No payloads or network calls.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('Profiling failed. Check explicit input, bounds and output path; no result was claimed.');process.exitCode=1;});
