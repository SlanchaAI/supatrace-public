// Trusted private-host composition only. No HTTP route, default credentials or discovery.
import {spawn} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {realpathSync,statSync,accessSync,constants} from 'node:fs';
import {isAbsolute,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {hash} from './importers/langfuse.mjs';
import {readHostedStage} from './hosted-langfuse-stage.mjs';
import {acquireWorkspaceLock} from './importers/private-workspace-lock.mjs';
import {parseBatch} from './trace.mjs';
import {HttpError} from './http.mjs';

const WORKER=fileURLToPath(new URL('../scripts/hosted_upload_worker.py',import.meta.url));
const ORIGINS=new Set(['https://supatrace.dev','https://supatrace.tech']);
const FRAME=750000;
const fail=code=>{throw new HttpError(409,code);};
const fields=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join()===keys.slice().sort().join();
const sha=v=>createHash('sha256').update(v).digest('hex');
const stable=v=>JSON.stringify(v&&typeof v==='object'?Array.isArray(v)?v.map(x=>JSON.parse(stable(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(stable(v[k]))])):v);
function frame(raw){
 const value=JSON.parse(raw),stack=[[value,0]];let nodes=0;
 while(stack.length){const[v,d]=stack.pop();if(d>12||++nodes>2048)fail('import_upload_protocol_bound');if(v&&typeof v==='object')for(const child of Object.values(v))stack.push([child,d+1]);}
 if(stable(value)!==raw)fail('import_upload_protocol_ambiguous');return value;
}
function containsSecret(raw,secret){
 const text=raw.toString('utf8');if(text.includes(secret))return true;
 for(const m of text.matchAll(/"(?:\\.|[^"\\])*"/g)){try{if(JSON.parse(m[0]).includes(secret))return true;}catch{return true;}}
 return false;
}
function receipt(raw){
 const text=raw.toString('utf8'),value=JSON.parse(text),tokens=text.match(/"(?:\\.|[^"\\])*"|true|false|null|[{}\[\]:,]/g)??[];
 // The owned Default receipt is flat: four unique keys and primitive values.
 // Inspect original tokens so duplicate/escaped keys cannot disappear in JSON.parse.
 if(tokens.length!==17||tokens[0]!=='{'||tokens[16]!=='}'||[2,6,10,14].some(i=>tokens[i]!==':')||[4,8,12].some(i=>tokens[i]!==',')||new Set([1,5,9,13].map(i=>JSON.parse(tokens[i]))).size!==4)fail('import_upload_ack_ambiguous');
 return value;
}

export async function runHostedLangfuseUpload(options){
 const names=['ledger','tenant','claim','directory','destinationOrigin','pythonExecutable','authorize','credentialProvider','fetchImpl','requestTimeoutMs'];
 if(!fields(options,names)||['authorize','credentialProvider','fetchImpl'].some(k=>typeof options[k]!=='function')||!ORIGINS.has(options.destinationOrigin)||typeof options.pythonExecutable!=='string'||!isAbsolute(options.pythonExecutable)||typeof options.directory!=='string'||options.directory!==resolve(options.directory)||!Number.isInteger(options.requestTimeoutMs)||options.requestTimeoutMs<1||options.requestTimeoutMs>30000)fail('import_upload_dependencies_required');
 try{if(realpathSync(options.directory)!==options.directory)fail('import_upload_directory_invalid');}catch{fail('import_upload_directory_invalid');}
 const {ledger,tenant,authorize,credentialProvider,fetchImpl,directory,pythonExecutable,requestTimeoutMs}=options,claim=structuredClone(options.claim),origin=options.destinationOrigin;
 try{if(!statSync(pythonExecutable).isFile())fail('import_upload_interpreter_invalid');accessSync(pythonExecutable,constants.X_OK);}catch{fail('import_upload_interpreter_invalid');}
 if(!ledger?.parentSession||typeof ledger.store?.getImportSessionStamp!=='function')fail('import_upload_parent_session_required');
 const parent=structuredClone(ledger.parentSession),globalFetch=fetchImpl===globalThis.fetch;let closed=false;
 const tls=()=>{if(globalFetch&&process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0')fail('import_upload_tls_validation_disabled');};tls();
 async function active(phases){
  if(closed)fail('import_upload_closed');
  const row=await ledger.active(tenant,claim,phases),observed=await ledger.bounded(()=>ledger.store.getImportSessionStamp(parent.token_hash));
  if(closed||!observed||hash(observed)!==hash(parent))fail('import_upload_parent_session_inactive');return row;
 }
 let row;try{row=await active(['staged']);}catch{fail('import_upload_claim_inactive');}
 // No new project/environment authority: this ledger and bridge are owned Default only.
 let lock;
 try{lock=acquireWorkspaceLock(directory,'upload');const proof=readHostedStage(directory,{destinationProject:row.project_id,fingerprint:row.fingerprint,conversionHash:row.stage.conversion_hash,batches:row.stage.batches.length,manifestHash:row.stage.manifest_hash,persistence:'local-files-verified-no-fsync-guarantee',uploaded:false});
  if(hash(proof.batches)!==hash(row.stage.batches)||hash(proof.manifest)!==row.stage.manifest_hash)fail('import_upload_stage_mismatch');
 }catch{fail('import_upload_stage_unavailable');}finally{try{lock?.release();}catch{fail('import_upload_stage_unavailable');}}
 let permit;try{permit=await ledger.consumeUpload(tenant,claim,{authorize});if(permit.created!==true||!await ledger.verifyUpload(tenant,claim,permit.receipt))fail('import_upload_consumption_unverified');await active(['upload_consumed']);}catch{fail('import_upload_consumption_unverified');}
 const expires=row.claim.expires_at*1000,deadline=Math.min(expires,Date.now()+300000),remaining=()=>{const ms=deadline-Date.now();if(ms<=0)fail('import_upload_deadline');return ms;};
 const scope={origin,project_id:row.project_id,fingerprint:row.fingerprint,conversion_hash:row.stage.conversion_hash,manifest_hash:row.stage.manifest_hash,max_batches:row.stage.batches.length,max_total_bytes:row.stage.bytes,max_requests:row.stage.batches.length,total_timeout_ms:remaining()};
 const surrogate=randomBytes(32).toString('base64url'),sent=new Set(),acknowledged=new Set();let lastWire=0,current=null,childResult=null,stopped=false,wires=0;
 const abort=new AbortController();let child;
 const result=await new Promise(resolveResult=>{
  let buffer='',sequence=0,busy=false,stderrBytes=0,finished=false,timer,killTimer,exitTimer;
  function finish(exitConfirmed){if(finished)return;closed=true;abort.abort();finished=true;clearTimeout(timer);clearTimeout(killTimer);clearTimeout(exitTimer);resolveResult({exitConfirmed});}
  function stop(){if(stopped||finished)return;closed=true;stopped=true;abort.abort();child?.stdin.destroy();child?.kill('SIGTERM');killTimer=setTimeout(()=>child?.kill('SIGKILL'),500);exitTimer=setTimeout(()=>finish(false),1500);}
  function send(id,value){if(stopped||closed)return;const raw=stable({id,value})+'\n';if(Buffer.byteLength(raw)>FRAME){stop();return;}child.stdin.write(raw,error=>{if(error)stop();});}
  async function message(m){
   if(closed)fail('import_upload_closed');
   if(childResult)fail('import_upload_protocol_invalid');
   if(fields(m,['type','result'])&&m.type==='result'){if(childResult||busy)fail('import_upload_protocol_invalid');childResult=m.result;return;}
   if(!Number.isSafeInteger(m.id)||m.id!==++sequence||sequence>row.stage.batches.length*3||busy)fail('import_upload_protocol_invalid');busy=true;
   try{
    await active(['upload_consumed']);remaining();
    const batch=row.stage.batches[sent.size];
    if(m.type==='authorize'&&fields(m,['id','type','descriptor'])){
     const d=m.descriptor,keys=['action','origin','project_id','fingerprint','conversion_hash','manifest_hash','batch_id','request_hash','bytes','remaining_ms'];
     if(current||!batch||!fields(d,keys)||d.action!=='upload-approved-batch'||d.origin!==origin||d.project_id!==row.project_id||d.fingerprint!==row.fingerprint||d.conversion_hash!==row.stage.conversion_hash||d.manifest_hash!==row.stage.manifest_hash||d.batch_id!==batch.batch_id||d.request_hash!==batch.request_hash||d.bytes!==batch.byte_count||!Number.isInteger(d.remaining_ms)||d.remaining_ms<1||d.remaining_ms>scope.total_timeout_ms)fail('import_upload_batch_scope_mismatch');
     const allowed=await ledger.bounded(()=>authorize({action:'upload-approved-batch',operation_id:row.job_id,tenant_id:tenant,claim_hash:claim.claim_hash,revision:row.claim.revision,...structuredClone(d)}));await active(['upload_consumed']);remaining();
     if(allowed!==true){current={phase:'denied'};send(m.id,false);return;}current={batch,phase:'authorized'};send(m.id,true);return;
    }
    if(m.type==='lease'&&fields(m,['id','type','binding'])){
     const b=m.binding;if(!current||current.phase!=='authorized'||!fields(b,['origin','project_id','remaining_ms'])||b.origin!==origin||b.project_id!==row.project_id||!Number.isInteger(b.remaining_ms)||b.remaining_ms<1||b.remaining_ms>scope.total_timeout_ms)fail('import_upload_lease_scope_mismatch');
     current.phase='leased';send(m.id,{origin,project_id:row.project_id,write_key:surrogate,expires_at:Math.floor(deadline/1000)});return;
    }
    if(m.type!=='post'||!fields(m,['id','type','url','method','body'])||!current||current.phase!=='leased'||!batch||m.url!==origin+'/api/batches?project='+row.project_id||m.method!=='POST'||typeof m.body!=='string')fail('import_upload_wire_scope_mismatch');
    const bytes=Buffer.from(m.body,'base64'),value=parseBatch(bytes.toString('utf8')).batch;
    if(bytes.toString('base64')!==m.body||bytes.length!==batch.byte_count||sha(bytes)!==batch.request_hash||value.batch_id!==batch.batch_id||value.run_id!==batch.run_id||value.events.length!==batch.event_count||sent.has(batch.request_hash))fail('import_upload_body_mismatch');
    current.phase='sending';sent.add(batch.request_hash);
    if(lastWire){const delay=Math.max(0,lastWire+2500-Date.now());if(delay){await new Promise(r=>setTimeout(r,Math.min(delay,remaining())));remaining();}}
    const descriptor={action:'upload-approved-batch-wire',operation_id:row.job_id,tenant_id:tenant,project_id:row.project_id,origin,fingerprint:row.fingerprint,claim_hash:claim.claim_hash,revision:row.claim.revision,manifest_hash:row.stage.manifest_hash,batch:structuredClone(batch)};
    if(await ledger.bounded(()=>authorize(structuredClone(descriptor)))!==true)fail('import_upload_not_authorized');await active(['upload_consumed']);remaining();tls();
    let lease;
    try{
     lease=structuredClone(await ledger.bounded(()=>credentialProvider({...descriptor,action:'destination-write-lease',expires_at:Math.floor(deadline/1000)})));
     if(!fields(lease,['origin','project_id','write_key','expires_at'])||lease.origin!==origin||lease.project_id!==row.project_id||!/^[-A-Za-z0-9_]{43}$/.test(lease.write_key??'')||!Number.isFinite(lease.expires_at)||lease.expires_at*1000<=Date.now()||lease.expires_at*1000>deadline||lease.expires_at*1000>Date.now()+300000||containsSecret(bytes,lease.write_key))fail('import_upload_credential_invalid');
     await active(['upload_consumed']);remaining();tls();if(stopped||lease.expires_at*1000<=Date.now())fail('import_upload_expired');
     const timeout=Math.min(remaining(),requestTimeoutMs,lease.expires_at*1000-Date.now()),wireAbort=new AbortController(),propagate=()=>wireAbort.abort();abort.signal.addEventListener('abort',propagate,{once:true});const requestTimer=setTimeout(()=>{wireAbort.abort();stop();},timeout);
     try{
      wires++;lastWire=Date.now();
      const response=await fetchImpl(m.url,{method:'POST',body:bytes,headers:{'content-type':'application/json','x-supatrace-key':lease.write_key,'authorization':'Bearer '+lease.write_key,'x-amz-content-sha256':batch.request_hash},redirect:'error',signal:wireAbort.signal});
      if(response.url!==m.url)fail('import_upload_response_target_invalid');
      if(![200,201].includes(response.status)){await response.body?.cancel();send(m.id,{status:response.status,body:Buffer.from('{}').toString('base64')});return;}
      const reader=response.body.getReader(),chunks=[];let size=0;
      try{while(true){remaining();if(stopped||Date.now()>=lease.expires_at*1000||wireAbort.signal.aborted)fail('import_upload_response_expired');const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>8192)fail('import_upload_ack_bound');chunks.push(Buffer.from(part.value));}}finally{try{await reader.cancel();}catch{}}
      const raw=Buffer.concat(chunks);if(containsSecret(raw,lease.write_key))fail('import_upload_ack_unsafe');const ack=receipt(raw);
      if(!fields(ack,['accepted','batch_id','request_hash','project_id'])||ack.accepted!==true||ack.batch_id!==batch.batch_id||ack.request_hash!==batch.request_hash||ack.project_id!==row.project_id)fail('import_upload_ack_invalid');
      await active(['upload_consumed']);remaining();if(stopped||wireAbort.signal.aborted||Date.now()>=lease.expires_at*1000)fail('import_upload_response_expired');
      // Preserve original bytes: Python still rejects duplicate JSON keys and invalid numbers.
      acknowledged.add(batch.request_hash);current=null;send(m.id,{status:response.status,body:raw.toString('base64')});
     }finally{clearTimeout(requestTimer);abort.signal.removeEventListener('abort',propagate);}
    }finally{lease=null;}
   }finally{busy=false;}
  }
  try{
   child=spawn(pythonExecutable,['-I','-B','-u','-X','utf8',WORKER],{cwd:directory,env:{LANG:'C.UTF-8',LC_ALL:'C.UTF-8'},stdio:['pipe','pipe','pipe']});
   timer=setTimeout(stop,remaining());child.on('error',stop);child.stdin.on('error',stop);
   child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;if(stderrBytes>4096)stop();});
   child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{if(stopped)return;buffer+=chunk;if(Buffer.byteLength(buffer)>FRAME){stop();return;}let at;while((at=buffer.indexOf('\n'))>=0){const raw=buffer.slice(0,at);buffer=buffer.slice(at+1);try{const m=frame(raw);void message(m).catch(stop);}catch{stop();}}});
   child.on('close',code=>{if(code!==0||buffer||stderrBytes||busy)stopped=true;finish(true);});
   child.stdin.write(stable({directory,scope})+'\n');
  }catch{stop();if(!child)finish(true);}
 });
 const complete=!stopped&&result.exitConfirmed&&childResult?.outcome==='all-uploader-acknowledgments-verified'&&childResult.all_batches_acknowledged===true&&acknowledged.size===row.stage.batches.length&&wires===row.stage.batches.length;
 let job;try{if(!complete)await ledger.stop(tenant,claim);job=await ledger.status(tenant,row.job_id);}catch{job=null;}
 return {outcome:complete?'all-uploader-acknowledgments-verified':'reconciliation-required',job,transport_requests_attempted:wires,acknowledged_batches:acknowledged.size,child_exit_confirmed:result.exitConfirmed,all_batches_acknowledged:complete,stored_bytes_verified:false,export_verified:false};
}
