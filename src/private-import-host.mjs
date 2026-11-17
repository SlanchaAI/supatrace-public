// Source-only private composition. Production loaders and routes do not install it.
import {constants,lstatSync,fstatSync,readSync,realpathSync,openSync,closeSync,writeSync,fsyncSync,unlinkSync,mkdirSync,existsSync,statfsSync} from 'node:fs';
import {join,resolve,isAbsolute} from 'node:path';
import {execFileSync} from 'node:child_process';
import {ImportJobLedger} from './import-job-ledger.mjs';
import {loadImportDispatch,reserveImportDispatch,verifyImportReservation,verifyDispatchSession,settleImportDispatch,LANGFUSE_HOST_FIELDS} from './private-import-dispatch.mjs';
import {runHostedLangfuseStage} from './hosted-langfuse-stage.mjs';
import {runHostedLangfuseUpload} from './hosted-langfuse-upload.mjs';
import {verifyHostedImportSavedExport} from './hosted-import-export.mjs';
import {hash,parseBatch} from './trace.mjs';
import {createHash,randomBytes} from 'node:crypto';
import {HttpError} from './http.mjs';
const fail=code=>{throw new HttpError(409,code);};
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const fields=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join()===keys.slice().sort().join();
const sha=v=>createHash('sha256').update(v).digest('hex');
// Observation only: a separate in-process launcher can see a currently executing host.
// This is never dispatch authority or restart/liveness evidence for another process.
const activeExecutions=new Map();
function syncDirectory(path){const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}}
function saveExclusive(path,value){let fd;try{fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);const raw=Buffer.from(JSON.stringify(value));let n=0;while(n<raw.length)n+=writeSync(fd,raw,n);fsyncSync(fd);}finally{if(fd!==undefined)closeSync(fd);}syncDirectory(resolve(path,'..'));}
function lockRoot(root,identity){const path=join(root,'.private-host.lock');let fd;try{fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);writeSync(fd,JSON.stringify(identity));fsyncSync(fd);syncDirectory(root);}catch{if(fd!==undefined)closeSync(fd);fail('private_host_paused_or_locked');}const original=lstatSync(path);let closed=false;return remove=>{if(closed)return;try{if(remove){const current=lstatSync(path);if(current.ino!==original.ino||current.dev!==original.dev||current.nlink!==1||!current.isFile())fail('private_host_lock_changed');unlinkSync(path);syncDirectory(root);}}finally{closed=true;closeSync(fd);}};}
export function createPrivateImportHost(options){
 const names=['store','objects','directory','runtime','authorize','legacyProvider','sourceBroker','destinationBroker','sourceFetch','destinationFetch','readiness'];
 if(!fields(options,names)||names.slice(4).some(k=>typeof options[k]!=='function'))fail('private_host_explicit_dependencies_required');
 const {store,objects,directory,authorize,legacyProvider,sourceBroker,destinationBroker,sourceFetch,destinationFetch,readiness}=options,runtime=structuredClone(options.runtime);
 if(!fields(runtime,['worker_id','revision','artifact_hash','pythonExecutable','pythonVersion','uid','device'])||!hex(runtime.worker_id)||!hex(runtime.artifact_hash)||!/^[a-f0-9]{40}$/.test(runtime.revision??'')||runtime.pythonVersion!=='3.12'||typeof runtime.pythonExecutable!=='string'||!isAbsolute(runtime.pythonExecutable)||!Number.isSafeInteger(runtime.uid)||!Number.isSafeInteger(runtime.device)||typeof directory!=='string'||!isAbsolute(directory)||resolve(directory)!==directory)fail('private_host_runtime_invalid');
 let paused=false;
 function physical(){const s=lstatSync(directory),space=statfsSync(directory);if(realpathSync(directory)!==directory||!s.isDirectory()||s.uid!==runtime.uid||s.uid!==process.getuid()||s.dev!==runtime.device||s.mode&0o077||Number(process.versions.node.split('.')[0])!==22||process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0'||space.bavail*space.bsize<64*1024*1024)fail('private_host_mount_or_runtime_mismatch');}
 physical();
 const base=new ImportJobLedger(store,{objects});
 async function ready(){if(paused||existsSync(join(directory,'.private-host.lock')))fail('private_host_paused_or_locked');physical();let version;try{version=execFileSync(runtime.pythonExecutable,['-I','-B','-c','import sys; print(str(sys.version_info.major)+"."+str(sys.version_info.minor))'],{encoding:'utf8',timeout:2000,env:{LANG:'C.UTF-8',LC_ALL:'C.UTF-8'}}).trim();}catch{fail('private_host_python_unavailable');}if(version!==runtime.pythonVersion)fail('private_host_python_mismatch');if(await base.bounded(()=>readiness(Object.freeze({directory,...runtime,nodeMajor:22})))!==true)fail('private_host_readiness_unverified');physical();}
 async function original(tenant,job){const d=await loadImportDispatch(base,tenant,job),b=d.binding;if(b.worker_id!==runtime.worker_id||b.revision!==runtime.revision||b.artifact_hash!==runtime.artifact_hash||b.source.fields!==LANGFUSE_HOST_FIELDS)fail('private_host_assignment_mismatch');const ledger=new ImportJobLedger(store,{objects,parentSession:b.parent_session});await verifyDispatchSession(ledger,d);return {dispatch:d,ledger};}
 async function authorizeQueue(ledger,descriptor){if(await ledger.bounded(()=>authorize(structuredClone(descriptor)))!==true)fail('private_host_not_authorized');}
 return Object.freeze({
  // No job/dispatch mutation: callers can verify the physical runtime before consuming work.
  async preflight(){await ready();return {ready:true};},
  async submit(input){
   if(!fields(input,['tenant','parentSession','plan','fingerprint','descriptor']))fail('private_host_submission_invalid');
   let copy;try{copy=structuredClone(input);}catch{fail('private_host_submission_invalid');}
   const {tenant,parentSession,plan,fingerprint,descriptor}=copy;
   await ready();const ledger=new ImportJobLedger(store,{objects,parentSession});if(parentSession?.tenant_id!==tenant)fail('private_host_session_required');
   const current=await ledger.bounded(()=>store.getImportSessionStamp(parentSession.token_hash));if(!current||hash(current)!==hash(parentSession))fail('private_host_session_required');
   if(descriptor?.worker_id!==runtime.worker_id||descriptor.revision!==runtime.revision||descriptor.artifact_hash!==runtime.artifact_hash)fail('private_host_assignment_mismatch');
   if(descriptor.expires_at<=store.now())fail('private_host_approval_expired');
   await authorizeQueue(ledger,{action:'queue-private-import',tenant_id:tenant,parent_session:structuredClone(parentSession),plan:structuredClone(plan),fingerprint,descriptor:structuredClone(descriptor),fields:LANGFUSE_HOST_FIELDS});
   const sessionBinding={binding:{tenant_id:tenant,parent_session:parentSession}};await verifyDispatchSession(ledger,sessionBinding);if(descriptor.expires_at<=store.now())fail('private_host_approval_expired');const result=await ledger.create(tenant,plan,fingerprint,descriptor);await verifyDispatchSession(ledger,sessionBinding);return result;
  },
  async status(tenant,job){const {ledger,dispatch}=await original(tenant,job);await authorizeQueue(ledger,{action:'inspect-private-import',binding:dispatch.binding,binding_hash:dispatch.binding_hash});await verifyDispatchSession(ledger,dispatch);const status=await ledger.status(tenant,job);await verifyDispatchSession(ledger,dispatch);const active=activeExecutions.get(directory),busy=!!active&&active.job_id===job&&active.worker_id===runtime.worker_id&&active.revision===runtime.revision&&active.artifact_hash===runtime.artifact_hash&&['queued','running'].includes(dispatch.state)&&(dispatch.state!=='running'||dispatch.execution_id===active.execution_id);return {job:status,dispatch:{state:dispatch.state,version:dispatch.version,export_verified:dispatch.state==='complete',receipt:dispatch.receipt},paused:paused||!busy&&existsSync(join(directory,'.private-host.lock')),worker_busy:busy,hosted:false};},
  async cancel(tenant,job){const {ledger,dispatch}=await original(tenant,job);await authorizeQueue(ledger,{action:'cancel-private-import',binding:dispatch.binding,binding_hash:dispatch.binding_hash});await verifyDispatchSession(ledger,dispatch);const result=await ledger.cancel(tenant,job);await verifyDispatchSession(ledger,dispatch);return result;},
  async download(tenant,job){
   const {ledger,dispatch}=await original(tenant,job);if(dispatch.state!=='complete')fail('private_host_export_unavailable');
   await authorizeQueue(ledger,{action:'download-private-import',binding:dispatch.binding,binding_hash:dispatch.binding_hash});await verifyDispatchSession(ledger,dispatch);
   const path=join(directory,job,'import-export.json');let fd;try{if(realpathSync(resolve(path,'..'))!==resolve(path,'..'))fail('private_host_export_unavailable');fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const s=fstatSync(fd);if(!s.isFile()||s.nlink!==1||s.uid!==runtime.uid||s.mode&0o022||s.size!==dispatch.receipt.export_bytes||s.size>20*1024*1024)fail('private_host_export_unavailable');const bytes=Buffer.alloc(s.size+1);let n=0,v;while(n<bytes.length&&(v=readSync(fd,bytes,n,bytes.length-n,null)))n+=v;if(n!==s.size||sha(bytes.subarray(0,n))!==dispatch.receipt.export_sha256)fail('private_host_export_unavailable');await verifyDispatchSession(ledger,dispatch);return bytes.subarray(0,n);}catch{fail('private_host_export_unavailable');}finally{if(fd!==undefined)closeSync(fd);}
  },
  async runOne(tenant,job){
   await ready();let {ledger,dispatch}=await original(tenant,job);if(dispatch.state!=='queued')fail('private_host_no_replay');
   const executionId=randomBytes(32).toString('hex'),closeLock=lockRoot(directory,{job_id:job,binding_hash:dispatch.binding_hash,worker_id:runtime.worker_id,execution_id:executionId,pid:process.pid});const executionMarker={job_id:job,worker_id:runtime.worker_id,revision:runtime.revision,artifact_hash:runtime.artifact_hash,execution_id:executionId};activeExecutions.set(directory,executionMarker);let phase='checking';
   const jobDirectory=join(directory,job),workspace=join(jobDirectory,'workspace');
   try{
    mkdirSync(jobDirectory,{mode:0o700});syncDirectory(directory);
    dispatch=await reserveImportDispatch(ledger,dispatch,{legacyProvider,authorize,execution_id:executionId,onBeforeWrite:async proof=>{phase='reservation_started';saveExclusive(join(jobDirectory,'dispatch-attempt.json'),proof);return true;}});
    const b=dispatch.binding;
    async function active(){physical();return verifyImportReservation(ledger,dispatch);}
    async function permission(request){await active();const ok=await ledger.bounded(()=>authorize({action:request.action,binding_hash:dispatch.binding_hash,execution_id:dispatch.execution_id,reservation_hash:dispatch.reservation_hash,binding:structuredClone(b),request:structuredClone(request),fields:LANGFUSE_HOST_FIELDS}));await active();return ok===true;}
    async function requireAction(action,request={}){if(await permission({action,...request})!==true)fail('private_host_not_authorized');}
    const expires=Math.min(b.expires_at,store.now()+300),authority={worker_id:b.worker_id,revision:b.revision,source_binding:b.source_binding,destination_binding:b.destination_binding,approval_hash:b.approval_hash,expires_at:expires};
    const staged=await runHostedLangfuseStage({ledger,tenant,job,authority,directory:workspace,pythonExecutable:runtime.pythonExecutable,checkExistingOperation:async()=>{await active();return true;},authorize:permission,credentialProvider:async request=>{await requireAction('source-lease',request);const lease=structuredClone(await ledger.bounded(()=>sourceBroker({binding:structuredClone(b),request})));await active();return lease;},fetchImpl:async(url,init)=>{await requireAction('source-wire',{url});const result=await sourceFetch(url,init);await active();return result;},bounds:{requestTimeoutMs:2000,totalTimeoutMs:Math.max(1,Math.min(300000,(expires-store.now())*1000)),maxRequests:30,maxResponseBytes:2097152,maxTotalBytes:4194304}});
    if(staged.outcome!=='staged')fail('private_host_stage_reconciliation_required');
    const uploaded=await runHostedLangfuseUpload({ledger,tenant,claim:staged.claim,directory:workspace,destinationOrigin:b.destination_origin,pythonExecutable:runtime.pythonExecutable,requestTimeoutMs:2000,authorize:permission,credentialProvider:async request=>{await requireAction('destination-write-lease',request);const lease=structuredClone(await ledger.bounded(()=>destinationBroker({binding:structuredClone(b),request})));await active();return lease;},fetchImpl:async(url,init)=>{await active();const result=await destinationFetch(url,init);await active();return result;}});
    if(!uploaded.child_exit_confirmed)fail('private_host_child_exit_uncertain');
    let row=await ledger.load(tenant,job);for(let i=0;i<row.stage.batches.length&&row.state!=='readback_verified';i++){await requireAction('reconcile-import-batch',{batch:row.stage.batches[row.verified_batches]});await ledger.reconcileNext(tenant,job);row=await ledger.load(tenant,job);}
    if(row.state!=='readback_verified')fail('private_host_readback_required');
    const started=new Date().toISOString(),runs=new Map();
    for(const batch of row.stage.batches){await requireAction('export-import-batch',{batch});const raw=await ledger.bounded(()=>objects.get('v1/'+sha(tenant)+'/'+batch.request_hash+'.json'));await active();if(typeof raw!=='string'||sha(raw)!==batch.request_hash||Buffer.byteLength(raw)!==batch.byte_count)fail('private_host_export_content_changed');const parsed=parseBatch(raw).batch;if(parsed.batch_id!==batch.batch_id||parsed.run_id!==batch.run_id)fail('private_host_export_content_changed');if(!runs.has(parsed.run_id))runs.set(parsed.run_id,{metadata:{id:parsed.run_id,event_count:0,batch_count:0},events:[]});const run=runs.get(parsed.run_id);run.events.push(...parsed.events);run.metadata.event_count+=parsed.events.length;run.metadata.batch_count++;}
    const exportPath=join(jobDirectory,'import-export.json');await requireAction('save-imported-export',{export_path:exportPath});
    saveExclusive(exportPath,{version:2,type:'supatrace_import_observed_export',project_id:b.project_id,job_id:job,fingerprint:b.fingerprint,manifest_hash:row.stage.manifest_hash,started_at:started,consistency:'verified_import_batches_not_an_account_snapshot',runs:[...runs.values()],completed_at:new Date().toISOString(),run_count:runs.size,event_count:[...runs.values()].reduce((n,r)=>n+r.events.length,0),complete:true});
    const receipt=await verifyHostedImportSavedExport({ledger,tenant,job,exportPath,authorize:permission});await active();
    saveExclusive(join(jobDirectory,'completion.json'),receipt);await settleImportDispatch(ledger,dispatch,receipt);closeLock(true);if(activeExecutions.get(directory)===executionMarker)activeExecutions.delete(directory);return {outcome:'import-export-verified',receipt,upload_acknowledged:uploaded.all_batches_acknowledged,exportPath,hosted:false};
   }catch(error){
    let releaseKnownHold=false;
    try{const current=await loadImportDispatch(ledger,tenant,job);if(current.state==='running'&&current.execution_id===executionId||current.state==='queued'&&phase==='checking'){await settleImportDispatch(ledger,current);releaseKnownHold=phase==='checking';}}catch{/* Unknown durable outcome: retain root lock and attempt journal. */}
    paused=!releaseKnownHold;if(activeExecutions.get(directory)===executionMarker)activeExecutions.delete(directory);closeLock(releaseKnownHold);if(error instanceof HttpError&&/^(private_|import_)/.test(error.code??''))throw error;fail('private_host_stopped_reconciliation_required');
   }
  }
 });
}
