// Explicit private-host completion check. No network defaults, dispatch, credentials or writes.
import {constants,openSync,closeSync,fstatSync,lstatSync,readSync,realpathSync} from 'node:fs';
import {dirname,isAbsolute,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {TextDecoder} from 'node:util';
import {hash,parseBatch} from './trace.mjs';
import {HttpError} from './http.mjs';
const MAX_BYTES=20*1024*1024,MAX_EVENTS=100000;
const fail=code=>{throw new HttpError(409,code);};
const fields=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join()===keys.slice().sort().join();
const sha=v=>createHash('sha256').update(v).digest('hex');
const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
function parseArchive(raw){
 const tokens=s=>{let n=0;for(const _ of s.matchAll(/"(?:\\[\s\S]|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\]:,]/g)){if(++n>2000000)fail('import_export_structure_bound');}return n;};
 let text,value;try{text=new TextDecoder('utf-8',{fatal:true}).decode(raw);}catch{fail('import_export_json_invalid');}
 // Refuse overly wide input before JSON.parse allocates its complete object graph.
 const originalTokens=tokens(text);try{value=JSON.parse(text);}catch{fail('import_export_json_invalid');}
 function* ownValues(object){for(const key in object)if(Object.hasOwn(object,key))yield object[key];}
 const stack=[[[value].values(),0]];let nodes=0;
 // Keep one iterator per depth, never one queued tuple per child of a wide array.
 while(stack.length){const [iterator,d]=stack.at(-1),next=iterator.next();if(next.done){stack.pop();continue;}const v=next.value;if(d>40||++nodes>1000000||typeof v==='number'&&(!Number.isFinite(v)||Number.isInteger(v)&&!Number.isSafeInteger(v)))fail('import_export_structure_bound');if(v&&typeof v==='object')stack.push([Array.isArray(v)?v.values():ownValues(v),d+1]);}
 // On valid JSON, removing any duplicate (including escaped) object key strictly
 // removes lexical tokens. Number formatting, whitespace and key order do not.
 if(originalTokens!==tokens(JSON.stringify(value)))fail('import_export_duplicate_key');
 return value;
}
function readSaved(path){
 let fd;try{
  if(!isAbsolute(path)||resolve(path)!==path||realpathSync(dirname(path))!==dirname(path))fail('import_export_file_unsafe');
  fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const before=fstatSync(fd);
  if(!before.isFile()||before.nlink!==1||before.uid!==process.getuid()||before.mode&0o022||before.size<1||before.size>MAX_BYTES)fail('import_export_file_unsafe');
  const raw=Buffer.alloc(before.size+1);let size=0,n;while(size<raw.length&&(n=readSync(fd,raw,size,raw.length-size,null)))size+=n;
  const after=fstatSync(fd),atPath=lstatSync(path);if(size!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||atPath.dev!==before.dev||atPath.ino!==before.ino||realpathSync(dirname(path))!==dirname(path))fail('import_export_file_changed');
  return raw.subarray(0,size);
 }catch(e){if(e instanceof HttpError)throw e;fail('import_export_file_unavailable');}finally{if(fd!==undefined)closeSync(fd);}
}
export async function verifyHostedImportSavedExport(options){
 try{return await verify(options);}catch(error){if(error instanceof HttpError&&error.code?.startsWith('import_export_'))throw error;fail('import_export_unavailable');}
}
async function verify(options){
 if(!fields(options,['ledger','tenant','job','exportPath','authorize'])||typeof options.exportPath!=='string'||typeof options.authorize!=='function')fail('import_export_dependencies_required');
 const {ledger,tenant,job,exportPath,authorize}=options,parent=structuredClone(ledger?.parentSession);
 if(!parent||parent.tenant_id!==tenant||typeof ledger?.objects?.get!=='function'||typeof ledger.store?.getImportSessionStamp!=='function')fail('import_export_session_required');
 const deadline=Date.now()+30000;
 const remaining=()=>{const value=deadline-Date.now();if(value<=0)fail('import_export_deadline');return value;};
 async function bounded(work){let timer;try{return await Promise.race([Promise.resolve().then(work),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new HttpError(409,'import_export_deadline')),Math.min(2000,remaining()));})]);}finally{clearTimeout(timer);}}
 const row=await bounded(()=>ledger.load(tenant,job));
 if(row.state!=='readback_verified'||!row.stage||!row.upload)fail('import_export_readback_required');
 async function active(){
  remaining();const account=await bounded(()=>ledger.account(tenant)),current=await bounded(()=>ledger.load(tenant,job)),stamp=await bounded(()=>ledger.store.getImportSessionStamp(parent.token_hash));remaining();
  if(account.epoch!==row.session_epoch||hash(current)!==hash(row)||!stamp||hash(stamp)!==hash(parent))fail('import_export_session_or_job_changed');
 }
 const scope=Object.freeze({action:'verify-saved-import-export',tenant_id:tenant,project_id:row.project_id,environment_id:'default',job_id:job,fingerprint:row.fingerprint,manifest_hash:row.stage.manifest_hash,conversion_hash:row.stage.conversion_hash,readback_hash:row.readback_hash,export_path:exportPath,max_export_bytes:MAX_BYTES,max_batches:row.stage.batches.length});
 await active();if(await bounded(()=>authorize(scope))!==true)fail('import_export_not_authorized');await active();
 const raw=readSaved(exportPath),archive=parseArchive(raw);
 const scoped=archive?.type==='supatrace_import_observed_export',archiveFields=['version','type','project_id','started_at','consistency','runs','completed_at','run_count','event_count','complete',...(scoped?['job_id','fingerprint','manifest_hash']:[])];
 if(!fields(archive,archiveFields)||archive.version!==2||archive.type!==(scoped?'supatrace_import_observed_export':'supatrace_account_observed_export')||archive.project_id!==row.project_id||archive.complete!==true||archive.consistency!==(scoped?'verified_import_batches_not_an_account_snapshot':'observed_stable_before_after_not_a_snapshot')||scoped&&(archive.job_id!==row.job_id||archive.fingerprint!==row.fingerprint||archive.manifest_hash!==row.stage.manifest_hash)||!Array.isArray(archive.runs)||archive.runs.length>100000||archive.run_count!==archive.runs.length||!Number.isSafeInteger(archive.event_count)||archive.event_count<0||archive.event_count>MAX_EVENTS||![archive.started_at,archive.completed_at].every(t=>typeof t==='string'&&Number.isFinite(Date.parse(t)))||Date.parse(archive.completed_at)<Date.parse(archive.started_at))fail('import_export_archive_invalid');
 const expected=new Map();
 for(const b of row.stage.batches){
  await active();const key='v1/'+sha(tenant)+'/'+b.request_hash+'.json',body=await bounded(()=>ledger.objects.get(key));await active();
  if(typeof body!=='string'||Buffer.byteLength(body)!==b.byte_count||sha(body)!==b.request_hash)fail('import_export_stored_content_changed');
  let batch;try{batch=parseBatch(body).batch;}catch{fail('import_export_stored_content_changed');}
  if(batch.run_id!==b.run_id||batch.batch_id!==b.batch_id||batch.events.length!==b.event_count)fail('import_export_stored_content_changed');
  for(const event of batch.events){const k=JSON.stringify([b.run_id,event.id]);if(expected.has(k))fail('import_export_duplicate_expected_event');expected.set(k,hash(event));}
 }
 const expectedRuns=new Set(row.stage.batches.map(b=>b.run_id)),seenRuns=new Set(),matched=new Set();let events=0;
 for(const run of archive.runs){
  if(!fields(run,['metadata','events'])||!id(run.metadata?.id)||seenRuns.has(run.metadata.id)||!Array.isArray(run.events)||run.metadata.event_count!==run.events.length||!Number.isSafeInteger(run.metadata.batch_count)||run.metadata.batch_count<0)fail('import_export_archive_invalid');
  if(scoped&&(!expectedRuns.has(run.metadata.id)||!fields(run.metadata,['id','event_count','batch_count'])||run.metadata.batch_count!==row.stage.batches.filter(b=>b.run_id===run.metadata.id).length))fail('import_export_archive_invalid');
  seenRuns.add(run.metadata.id);
  for(const event of run.events){
   if(!id(event?.id)||++events>MAX_EVENTS)fail('import_export_duplicate_or_invalid_event');
   const k=JSON.stringify([run.metadata.id,event.id]);if(expected.has(k)){if(matched.has(k))fail('import_export_duplicate_or_invalid_event');if(hash(event)!==expected.get(k))fail('import_export_event_mismatch');matched.add(k);}
  }
 }
 if(events!==archive.event_count||matched.size!==expected.size||scoped&&events!==matched.size)fail('import_export_incomplete');
 await active();if(sha(readSaved(exportPath))!==sha(raw))fail('import_export_file_changed');remaining();
 return {version:1,outcome:'saved-import-export-verified',job_id:job,project_id:row.project_id,environment_id:'default',fingerprint:row.fingerprint,manifest_hash:row.stage.manifest_hash,readback_hash:row.readback_hash,export_sha256:sha(raw),export_bytes:raw.length,matched_events:matched.size,matched_runs:new Set(row.stage.batches.map(b=>b.run_id)).size,unrelated_events:events-matched.size,stored_bytes_verified:true,export_verified:true,verification_scope:'imported_events_in_explicit_saved_archive',consistency:archive.consistency,source_completeness_verified:false,native_span_semantics_verified:false,ledger_updated:false};
}
