// Trusted worker entrypoint; not registered with an HTTP route, queue or scheduler.
import {constants,openSync,closeSync,fstatSync,readSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createLangfuseTransport} from './importers/langfuse-transport.mjs';
import {runPrivateLangfuseWorkflow} from './importers/private-langfuse-runtime.mjs';
import {acquireWorkspaceLock} from './importers/private-workspace-lock.mjs';
import {parseBatch} from './trace.mjs';
import {HttpError} from './http.mjs';
const fail=code=>{throw new HttpError(409,code);};
function readPrivate(path,max=65536){let fd;try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const s=fstatSync(fd);if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid()||s.mode&0o077||s.size>max)fail('import_stage_file_unsafe');const bytes=Buffer.alloc(max+1);let size=0,n;while(size<bytes.length&&(n=readSync(fd,bytes,size,bytes.length-size,null)))size+=n;if(size!==s.size||fstatSync(fd).mtimeMs!==s.mtimeMs)fail('import_stage_file_changed');return bytes.subarray(0,size);}finally{if(fd!==undefined)closeSync(fd);}}
export function readHostedStage(directory,receipt){
  const manifest=JSON.parse(readPrivate(join(directory,'pending','import-manifest.json')).toString('utf8'));
  if(!Array.isArray(manifest.batches)||manifest.batches.length<1||manifest.batches.length>100)fail('import_stage_bound');
  const batches=manifest.batches.map(item=>{
    if(!/^[a-f0-9]{64}\.json$/.test(item.pending_file??'')||item.pending_file!==item.request_hash+'.json')fail('import_stage_path_invalid');
    const raw=readPrivate(join(directory,'pending',item.pending_file),524288),value=parseBatch(raw.toString('utf8')).batch;
    if(value.batch_id!==item.batch_id||createHash('sha256').update(raw).digest('hex')!==item.request_hash)fail('import_stage_hash_mismatch');
    return {batch_id:value.batch_id,request_hash:item.request_hash,run_id:value.run_id,byte_count:raw.length,event_count:value.events.length};
  });
  return {receipt,manifest,batches};
}

export async function runHostedLangfuseStage(options){
  const allowed=['ledger','tenant','job','authority','directory','checkExistingOperation','authorize','credentialProvider','fetchImpl','bounds','pythonExecutable'];
  if(!options||Object.keys(options).some(k=>!allowed.includes(k))||['checkExistingOperation','authorize','credentialProvider','fetchImpl'].some(k=>typeof options[k]!=='function')||typeof options.directory!=='string'||!options.directory||!options.ledger)fail('import_worker_dependencies_required');
  const {ledger,tenant,job,directory,checkExistingOperation,authorize,credentialProvider,fetchImpl}=options;
  const authority=structuredClone(options.authority),bounds=structuredClone(options.bounds),row=await ledger.load(tenant,job);
  const globalFetch=fetchImpl===globalThis.fetch;
  const tls=()=>{if(globalFetch&&process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0')fail('import_worker_tls_validation_disabled');};tls();
  const validation=createLangfuseTransport(row.plan.scope,{fetchImpl,credentialProvider,authorize,bounds});validation.close();
  if(bounds.maxRequests>30||bounds.maxResponseBytes>2097152||bounds.maxTotalBytes>4194304)fail('import_worker_bounds_exceeded');
  const claim=await ledger.claim(tenant,job,authority,{authorize,checkExistingOperation});
  const active=()=>ledger.active(tenant,claim.receipt,['claimed']);
  try{
    const remaining=Math.min(bounds.totalTimeoutMs,authority.expires_at*1000-Date.now());if(!(remaining>0))fail('import_worker_expired');
    const result=await runPrivateLangfuseWorkflow(row.plan.scope,{
      directory,...(options.pythonExecutable!==undefined?{pythonExecutable:options.pythonExecutable}:{}),bounds:{...bounds,totalTimeoutMs:remaining,requestTimeoutMs:Math.min(bounds.requestTimeoutMs,remaining)},
      authorize:async descriptor=>{await active();const ok=await ledger.bounded(()=>authorize({action:'runtime-action',job_id:job,tenant_id:tenant,claim_hash:claim.receipt.claim_hash,descriptor:structuredClone(descriptor)}));await active();return ok===true;},
      credentialProvider:async binding=>{tls();await active();const value=await ledger.bounded(()=>credentialProvider({...binding,job_id:job,tenant_id:tenant,fingerprint:row.fingerprint,expiresAt:authority.expires_at*1000}));await active();if(!value||!Number.isFinite(value.expiresAt)||value.expiresAt<=Date.now()||value.expiresAt>Date.now()+300000)fail('import_worker_lease_invalid');return {origin:value.origin,projectId:value.projectId,publicKey:value.publicKey,secretKey:value.secretKey,...(Object.hasOwn(value,'traceId')?{traceId:value.traceId}:{}),expiresAt:Math.min(value.expiresAt,authority.expires_at*1000)};},
      fetchImpl:async(...args)=>{tls();await active();tls();let response;try{response=await fetchImpl(...args);await active();return response;}catch{try{void response?.body?.cancel()?.catch(()=>{});}catch{}throw Error('import_worker_read_stopped');}},
      onProgress:progress=>ledger.progress(tenant,claim.receipt,progress),
    });
    await active();if(result.outcome!=='locally-staged'||!result.localFilesVerified)fail('import_worker_stage_unverified');
    // Return the committed view; a later status read failing must not downgrade a durable stage.
    let view;const lock=acquireWorkspaceLock(directory);try{view=await ledger.staged(tenant,claim.receipt,readHostedStage(directory,result.stageReceipt));}finally{lock.release();}
    return {outcome:'staged',claim:claim.receipt,job:view,uploaded:false,export_verified:false};
  }catch{
    return {outcome:'stopped-reconciliation-required',job:await ledger.stop(tenant,claim.receipt),uploaded:false,export_verified:false};
  }
}
