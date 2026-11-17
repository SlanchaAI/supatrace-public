import {pickExportFile} from './export-picker.js';
// Bounded observed-read archive, not a transactional snapshot or raw-batch backup.
const fail=code=>{throw new Error(code);};
const check=signal=>{if(signal?.aborted)fail('export_file_cancelled');};
const catalogKey=runs=>JSON.stringify([...runs].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0));
export const ACCOUNT_FILE_TIMEOUT_MS=120000;
// File APIs do not take AbortSignal. Stop this traversal even if a browser call
// stays pending; observe late rejection and never continue writing or commit it.
function fileStep(work,{signal,timeoutMs,onLate}={}) {
 check(signal);
 return new Promise((resolve,reject)=>{
  let settled=false,timer;
  const finish=(callback,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);callback(value);};
  const abort=()=>finish(reject,new Error('export_file_cancelled'));
  signal?.addEventListener('abort',abort,{once:true});
  if(timeoutMs)timer=setTimeout(()=>finish(reject,new Error('export_file_unconfirmed')),timeoutMs);
  let result;try{result=work();}catch(error){finish(reject,error);return;}
  Promise.resolve(result).then(value=>{
   if(settled){if(onLate)Promise.resolve().then(()=>onLate(value)).catch(()=>{});return;}
   finish(resolve,value);
  },error=>finish(reject,error));
 });
}
function validate(runs){if(!Array.isArray(runs)||runs.length>100000)fail('account_export_incomplete');const ids=new Set();for(const r of runs){if(!r||typeof r.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(r.id)||ids.has(r.id)||!Number.isSafeInteger(r.event_count)||r.event_count<0||!Number.isSafeInteger(r.batch_count)||r.batch_count<0)fail('account_export_incomplete');ids.add(r.id);}return structuredClone(runs);}
export async function saveAccountArchive({projectId,environmentId='default',signal,pick,loadCatalog,writeRun,onProgress=()=>{},onCommit=()=>{},now=()=>new Date().toISOString(),fileTimeoutMs=ACCOUNT_FILE_TIMEOUT_MS}={}){
 if(!/^[a-z][a-z0-9-]{0,31}$/.test(environmentId)||!/^proj_[a-f0-9]{32}$/.test(projectId||'')||![pick,loadCatalog,writeRun,onProgress,onCommit,now].every(x=>typeof x==='function')||!Number.isSafeInteger(fileTimeoutMs)||fileTimeoutMs<1||fileTimeoutMs>ACCOUNT_FILE_TIMEOUT_MS)fail('account_export_unavailable');
 let writable,committing=false,writeFailed=false;
 const abortFile=stream=>fileStep(()=>stream.abort(),{timeoutMs:fileTimeoutMs});
 const write=text=>fileStep(()=>writable.write(text),{signal,timeoutMs:fileTimeoutMs}).catch(error=>{writeFailed=true;throw error;});
 const read=async work=>{
  try{return await work();}catch(error){
   // A sink write happens inside writeRun. Never mislabel its failure as a read
   // failure, and never let classification override cancellation or integrity.
   if(writeFailed||signal?.aborted||error?.name==='AbortError'||['export_file_cancelled','account_export_changed','account_export_incomplete','account_export_too_large'].includes(error?.message))throw error;
   if(['export_rate_limited','run_load_rate_limited'].includes(error?.message))fail('account_export_rate_limited');
   if(['export_read_deadline','run_load_deadline'].includes(error?.message))fail('account_export_read_deadline');
   fail('account_export_read_failed');
  }
 };
 try{
  // Invoke the picker synchronously within the click, with no selection deadline.
  const handle=await fileStep(()=>pickExportFile(pick,{suggestedName:'supatrace-account.json',types:[{description:'SupaTrace observed account archive',accept:{'application/json':['.json']}}]}),{signal});check(signal);
  const started=now(),runs=validate(await read(()=>loadCatalog(signal)));check(signal);const before=catalogKey(runs);
  writable=await fileStep(()=>handle.createWritable({keepExistingData:false}),{signal,timeoutMs:fileTimeoutMs,onLate:abortFile});check(signal);
  await write(JSON.stringify({version:2,type:'supatrace_account_observed_export',project_id:projectId,...(environmentId!=='default'?{environment_id:environmentId}:{}),started_at:started,consistency:'observed_stable_before_after_not_a_snapshot'}).slice(0,-1)+',"runs":[');
  let firstRun=true,total=0,completed=0;
  for(const run of runs){check(signal);await write((firstRun?'':',')+'{"metadata":'+JSON.stringify(run)+',"events":[');firstRun=false;let first=true,count=0;
   const result=await read(()=>writeRun(run.id,signal,async events=>{if(!Array.isArray(events))fail('account_export_incomplete');for(const event of events){check(signal);await write((first?'':',')+JSON.stringify(event));first=false;count++;}}));check(signal);
   if(count!==run.event_count||result?.events!==count||result?.batches!==run.batch_count)fail('account_export_changed');
   total+=count;if(!Number.isSafeInteger(total))fail('account_export_incomplete');await write(']}');onProgress({runs_completed:++completed,runs_total:runs.length,events:total});
  }
  const after=validate(await read(()=>loadCatalog(signal)));check(signal);if(catalogKey(after)!==before)fail('account_export_changed');
  await write('],"completed_at":'+JSON.stringify(now())+',"run_count":'+runs.length+',"event_count":'+total+',"complete":true}');check(signal);
  onCommit();check(signal);committing=true;await fileStep(()=>writable.close(),{timeoutMs:fileTimeoutMs});return {runs:runs.length,events:total,consistency:'observed_stable_before_after_not_a_snapshot'};
 }catch(error){if(committing)fail('export_file_unconfirmed');if(writable){try{await abortFile(writable);}catch{fail('export_file_unconfirmed');}}
  if(signal?.aborted||error?.message==='export_file_cancelled')fail('export_file_cancelled');
  if(['account_export_changed','account_export_incomplete','account_export_too_large','account_export_rate_limited','account_export_read_deadline','account_export_read_failed'].includes(error?.message)||error?.message==='export_picker_unavailable')throw error;fail('export_file_unconfirmed');
 }
}

// Standard-download preparation shares the streaming archive's reconciliation.
// Buffer only bounded UTF-8 chunks; no URL, download or persistent handle is created.
export const ACCOUNT_DOWNLOAD_LIMITS=Object.freeze({bytes:20*1024*1024,events:100000});
export async function prepareAccountArchive({maxBytes=ACCOUNT_DOWNLOAD_LIMITS.bytes,maxEvents=ACCOUNT_DOWNLOAD_LIMITS.events,...options}={}){
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>ACCOUNT_DOWNLOAD_LIMITS.bytes||!Number.isSafeInteger(maxEvents)||maxEvents<1||maxEvents>ACCOUNT_DOWNLOAD_LIMITS.events||typeof options.writeRun!=='function')fail('account_export_unavailable');
 const chunks=[];let bytes=0,events=0,blob=null;
 const release=()=>{chunks.length=0;blob=null;};
 try{
  const result=await saveAccountArchive({...options,pick:async()=>({createWritable:async()=>({
   write:async text=>{check(options.signal);const chunk=new TextEncoder().encode(text);if(bytes+chunk.byteLength>maxBytes)fail('account_export_too_large');bytes+=chunk.byteLength;chunks.push(chunk);},
   close:async()=>{check(options.signal);blob=new Blob(chunks,{type:'application/json'});chunks.length=0;},
   abort:async()=>release()
  })}),writeRun:(id,signal,sink)=>options.writeRun(id,signal,async rows=>{if(!Array.isArray(rows))fail('account_export_incomplete');if(events+rows.length>maxEvents)fail('account_export_too_large');events+=rows.length;await sink(rows);})});
  check(options.signal);return {...result,blob,bytes};
 }catch(error){release();if(options.signal?.aborted||error?.message==='export_file_cancelled')fail('export_cancelled');if(error?.message==='export_file_unconfirmed')fail('account_download_failed');throw error;}
}
// Shared by the explicit workspace archive; existing version-2 writers remain unchanged.
export {fileStep as accountFileStep,validate as validateAccountCatalog,catalogKey as accountCatalogKey};
