import {pickExportFile} from './export-picker.js';
// Explicit export of all environments in ONE selected workspace. No account/project discovery.
import {saveAccountArchive,accountFileStep,validateAccountCatalog,accountCatalogKey,
  ACCOUNT_FILE_TIMEOUT_MS,ACCOUNT_DOWNLOAD_LIMITS} from './account-export.js';
const fail=code=>{throw new Error(code);};
const check=signal=>{if(signal?.aborted)fail('export_file_cancelled');};
export const WORKSPACE_EXPORT_LIMITS=Object.freeze({environments:20,runs:100000,catalogBytes:20*1024*1024});
function environments(value){
 if(!Array.isArray(value)||!value.length||value.length>WORKSPACE_EXPORT_LIMITS.environments)fail('account_export_incomplete');
 const ids=new Set();for(const e of value){
  if(!e||Object.getPrototypeOf(e)!==Object.prototype||Object.keys(e).sort().join()!=='id,legacy,name'||
   typeof e.id!=='string'||!/^[a-z][a-z0-9-]{0,31}$/.test(e.id)||ids.has(e.id)||
   typeof e.name!=='string'||!e.name.trim()||e.name.length>60||/[\x00-\x1f\x7f]/.test(e.name)||typeof e.legacy!=='boolean')fail('account_export_incomplete');
  ids.add(e.id);
 }
 if(!ids.has('default'))fail('account_export_incomplete');
 return structuredClone(value).sort((a,b)=>a.id==='default'?-1:b.id==='default'?1:a.id<b.id?-1:1);
}
export async function saveWorkspaceArchive({workspaceId,projectId,environmentIds,signal,pick,loadEnvironments,loadCatalog,writeRun,
 onProgress=()=>{},onCommit=()=>{},now=()=>new Date().toISOString(),fileTimeoutMs=ACCOUNT_FILE_TIMEOUT_MS}={}){
 if(typeof workspaceId!=='string'||!(/^(?:github-[1-9][0-9]{0,15}|(?:google|email|sso|chatgpt)-[a-f0-9]{64}|org-[a-f0-9]{32})$/).test(workspaceId)||
  typeof projectId!=='string'||!/^proj_[a-f0-9]{32}$/.test(projectId)||
  !Array.isArray(environmentIds)||!environmentIds.length||environmentIds.length>20||!environmentIds.includes('default')||new Set(environmentIds).size!==environmentIds.length||
  environmentIds.some(id=>typeof id!=='string'||!/^[a-z][a-z0-9-]{0,31}$/.test(id))||
  ![pick,loadEnvironments,loadCatalog,writeRun,onProgress,onCommit,now].every(v=>typeof v==='function')||
  !Number.isSafeInteger(fileTimeoutMs)||fileTimeoutMs<1||fileTimeoutMs>ACCOUNT_FILE_TIMEOUT_MS)fail('account_export_unavailable');
 environmentIds=[...environmentIds].sort();let writable,committing=false,active=true;
 const step=(fn,timeoutMs=fileTimeoutMs)=>accountFileStep(fn,{signal,timeoutMs});
 const abort=stream=>accountFileStep(()=>stream.abort(),{timeoutMs:fileTimeoutMs});
 const write=text=>{if(!active)fail('export_file_unconfirmed');return step(()=>writable.write(text));};
 const readEnvironments=async()=>environments(await step(()=>loadEnvironments(signal),30000));
 const baselines=new Map();let catalogBytes=0,totalRuns=0;
 async function catalog(environment,readSignal){
  const rows=validateAccountCatalog(await accountFileStep(()=>loadCatalog(environment,readSignal),{signal:readSignal,timeoutMs:300000}));
  check(signal);const key=accountCatalogKey(rows);
  if(baselines.has(environment)){if(baselines.get(environment)!==key)fail('account_export_changed');}
  else{
   totalRuns+=rows.length;catalogBytes+=new TextEncoder().encode(key).length;
   if(totalRuns>WORKSPACE_EXPORT_LIMITS.runs||catalogBytes>WORKSPACE_EXPORT_LIMITS.catalogBytes)fail('account_export_too_large');
   baselines.set(environment,key);
  }
  return rows;
 }
 try{
  // Preserve the user gesture; do not read any scope if the picker is declined.
  const handle=await accountFileStep(()=>pickExportFile(pick,{suggestedName:'supatrace-workspace.json',types:[{description:'SupaTrace workspace archive',accept:{'application/json':['.json']}}]}),{signal});
  check(signal);const started=now(),scope=await readEnvironments(),scopeKey=JSON.stringify(scope);
  if(JSON.stringify(scope.map(e=>e.id).sort())!==JSON.stringify(environmentIds))fail('account_export_changed');
  writable=await accountFileStep(()=>handle.createWritable({keepExistingData:false}),{signal,timeoutMs:fileTimeoutMs,onLate:abort});check(signal);
  await write(JSON.stringify({version:3,type:'supatrace_workspace_observed_export',workspace_id:workspaceId,project_id:projectId,
   started_at:started,consistency:'observed_stable_before_after_all_environments_not_a_snapshot'}).slice(0,-1)+',"environments":[');
  let first=true,runs=0,events=0,completed=0;
  for(const environment of scope){
   check(signal);await write((first?'':',')+'{"metadata":'+JSON.stringify(environment)+',"archive":');first=false;
   const result=await saveAccountArchive({projectId,environmentId:environment.id,signal,now,fileTimeoutMs,
    pick:async()=>({createWritable:async()=>({write,close:async()=>{},abort:async()=>{}})}),
    loadCatalog:readSignal=>catalog(environment.id,readSignal),writeRun:(id,readSignal,sink)=>writeRun(environment.id,id,readSignal,sink),
    onProgress:p=>onProgress({environments_completed:completed,environments_total:scope.length,runs_completed:runs+p.runs_completed,events:events+p.events})});
   runs+=result.runs;events+=result.events;if(!Number.isSafeInteger(events))fail('account_export_incomplete');
   await write('}');onProgress({environments_completed:++completed,environments_total:scope.length,runs_completed:runs,events});
  }
  // A later environment must not hide changes to one exported earlier.
  for(const environment of scope)await catalog(environment.id,signal);
  if(JSON.stringify(await readEnvironments())!==scopeKey)fail('account_export_changed');check(signal);
  await write('],"completed_at":'+JSON.stringify(now())+',"environment_count":'+scope.length+',"run_count":'+runs+',"event_count":'+events+',"complete":true}');
  check(signal);onCommit();check(signal);active=false;committing=true;
  await accountFileStep(()=>writable.close(),{timeoutMs:fileTimeoutMs});
  return {environments:scope.length,runs,events,consistency:'observed_stable_before_after_all_environments_not_a_snapshot'};
 }catch(error){
  active=false;if(committing)fail('export_file_unconfirmed');
  if(writable){try{await abort(writable);}catch{fail('export_file_unconfirmed');}}
  if(signal?.aborted||error?.message==='export_file_cancelled')fail('export_file_cancelled');
  if(['account_export_changed','account_export_incomplete','account_export_too_large','account_export_rate_limited','account_export_read_deadline','account_export_read_failed'].includes(error?.message))throw error;
  if(error?.message==='export_picker_unavailable')throw error;
  fail('export_file_unconfirmed');
 }finally{active=false;}
}
export async function prepareWorkspaceArchive({maxBytes=ACCOUNT_DOWNLOAD_LIMITS.bytes,maxEvents=ACCOUNT_DOWNLOAD_LIMITS.events,...options}={}){
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>ACCOUNT_DOWNLOAD_LIMITS.bytes||!Number.isSafeInteger(maxEvents)||maxEvents<1||maxEvents>ACCOUNT_DOWNLOAD_LIMITS.events||typeof options.writeRun!=='function')fail('account_export_unavailable');
 const chunks=[];let bytes=0,events=0,blob=null;
 const release=()=>{chunks.length=0;blob=null;};
 try{
  const result=await saveWorkspaceArchive({...options,pick:async()=>({createWritable:async()=>({
   write:async text=>{check(options.signal);const part=new TextEncoder().encode(text);if(bytes+part.byteLength>maxBytes)fail('account_export_too_large');bytes+=part.byteLength;chunks.push(part);},
   close:async()=>{check(options.signal);blob=new Blob(chunks,{type:'application/json'});chunks.length=0;},abort:async()=>release()
  })}),writeRun:(environment,id,signal,sink)=>options.writeRun(environment,id,signal,async rows=>{
   if(!Array.isArray(rows))fail('account_export_incomplete');if(events+rows.length>maxEvents)fail('account_export_too_large');events+=rows.length;await sink(rows);
  })});
  check(options.signal);return {...result,blob,bytes};
 }catch(error){release();if(options.signal?.aborted||error?.message==='export_file_cancelled')fail('export_cancelled');if(error?.message==='export_file_unconfirmed')fail('account_download_failed');throw error;}
}
