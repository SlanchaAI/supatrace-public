// In-app, request-driven import. No worker, provider credential store or private-host claims.
import {randomUUID} from 'node:crypto';
import {HttpError} from './http.mjs';
import {hash,parseBatch} from './trace.mjs';
import {digest} from './aws-auth.mjs';
import {alphaProject} from './alpha-projects.mjs';
import {planCustomerImport} from './import-planning.mjs';
import {createPrivateImportAuthenticator} from './private-import-auth.mjs';
import {ImportJobLedger} from './import-job-ledger.mjs';
import {captureLangfuse,createCaptureCheckpoint,validateCaptureCheckpoint} from './importers/langfuse-capture.mjs';
import {convert} from './importers/langfuse.mjs';
import {pseudonymizeLangfuseId} from './importers/langfuse-sanitization.mjs';
import {createLangfuseTransport,TRANSPORT_CREDENTIAL_SENTINEL} from './importers/langfuse-transport.mjs';
const controllers=new WeakSet(),safeErrors=new WeakSet();
const fields=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join()===keys.slice().sort().join();
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const clone=structuredClone;
function fail(status,code){const e=new HttpError(status,code);safeErrors.add(e);throw e;}
const phases=new Set(['reviewed','consented','capturing','ready','reserve_consumed','object_ready','object_consumed','ack_ready','ack_consumed','verifying','complete','empty','bounded_incomplete','conversion_rejected','revoked']);
export const serverPullAvailable=value=>controllers.has(value);
export const SERVER_PULL_LIMITS=Object.freeze({maxRows:100,maxPages:10,pageSize:50,maxBytes:131072,maxRetries:0,requestMs:9000,leaseSeconds:30});
export function createServerPullController({store,objects,origin,fetchImpl=globalThis.fetch,now=Date.now}={}){
 if(typeof fetchImpl!=='function'||typeof objects?.get!=='function'||typeof objects?.putImmutable!=='function'||typeof store?.importSessionCheck!=='function'||typeof store?.reserveBatch!=='function'||typeof store?.acceptReservedBatch!=='function')fail(503,'server_pull_unavailable');
 const authenticate=createPrivateImportAuthenticator({store,origin}),ledger=new ImportJobLedger(store,{objects,timeoutMs:500});
 const key=(identity,fingerprint)=>({pk:'TENANT#'+identity.tenant_id,sk:'SERVERPULL#'+fingerprint});
 const identityHash=identity=>hash(identity.parent_session);
 const rowView=row=>({job_id:'sp_'+row.fingerprint,run_id:row.phase==='empty'?null:'lf.'+hash([row.plan.scope.namespace,pseudonymizeLangfuseId(row.plan.scope.traceId,'trace',row.plan.scope)]),fingerprint:row.fingerprint,project_id:row.plan.scope.destinationProject,status:row.phase,version:row.version,progress:{pages:row.checkpoint.pages.length,rows:row.checkpoint.pages.reduce((n,p)=>n+p.data.length,0),verified_batches:row.index},execution_started:!['reviewed','consented','revoked'].includes(row.phase),stored_bytes_verified:row.phase==='complete'&&row.index>0,export_verified:false,expires_at:row.expires_at,needs_credentials:row.phase==='capturing'});
 function plan(identity,input){const p=planCustomerImport(input,alphaProject(identity.tenant_id).id,{serverPull:true}).plan;if(!p.scope.traceId)fail(400,'exact_trace_required');for(const k of ['maxRows','maxPages','pageSize','maxBytes','maxRetries'])if(p.scope[k]>SERVER_PULL_LIMITS[k])fail(400,'server_pull_bounds_exceeded');return p;}
 function disclosure(row){const s=row.plan.scope;return {source:{provider:'langfuse',origin:s.origin,project_id:s.sourceProject,trace_id:s.traceId,environment:s.environment,from:s.from,to:s.to,namespace:s.namespace},destination:{origin,project_id:s.destinationProject,environment_id:'default'},fields:row.plan.fields.split(','),sanitization:clone(row.plan.sanitization),content:{input_output:true,prompts:true},bounds:{max_rows:s.maxRows,max_pages:s.maxPages,page_size:s.pageSize,max_bytes:s.maxBytes,max_retries:s.maxRetries},expires_at:row.expires_at};}
 const reviewHash=row=>hash({mode:'server-pull-sanitized-v2',fingerprint:row.fingerprint,disclosure:disclosure(row),session:row.session_hash});
 async function load(identity,fingerprint){
  const row=await ledger.bounded(()=>store._get(key(identity,fingerprint)));if(!row)fail(404,'server_pull_not_found');
  if(row.schema_version!==2||row.fingerprint!==fingerprint||row.tenant_id!==identity.tenant_id||row.session_hash!==identityHash(identity)||!phases.has(row.phase)||!Number.isSafeInteger(row.version)||row.version<0||!Number.isSafeInteger(row.index)||row.index<0||row.index>100||!Number.isSafeInteger(row.expires_at)||row.plan?.fingerprint!==fingerprint||row.checkpoint?.fingerprint!==fingerprint||row.checkpoint_hash!==hash(row.checkpoint)||!Array.isArray(row.checkpoint.pages)||row.pk!==key(identity,fingerprint).pk||row.sk!==key(identity,fingerprint).sk)fail(409,'server_pull_binding_changed');
  const {destinationProject,...spec}=row.plan.scope;const checked=plan(identity,{provider:'langfuse',...spec});if(hash(checked)!==hash(row.plan)||destinationProject!==alphaProject(identity.tenant_id).id)fail(409,'server_pull_binding_changed');try{validateCaptureCheckpoint(row.checkpoint,row.plan.scope);}catch{fail(409,'server_pull_binding_changed');}return row;
 }
 async function write(identity,old,next){
  validateCaptureCheckpoint(next.checkpoint,next.plan.scope);
  if(Buffer.byteLength(JSON.stringify(next))>196608)fail(400,'server_pull_checkpoint_bound');
  const item={...next,checkpoint_hash:hash(next.checkpoint),version:old?old.version+1:0};
  await ledger.bounded(()=>store._tx([store.importSessionCheck(identity.parent_session),ledger.checkTenant(identity.tenant_id,identity.parent_session.session_epoch),{Put:{Item:item,ConditionExpression:old?'#v = :v':'attribute_not_exists(pk)',...(old?{ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':v':old.version}}:{})}},...(!old?[{Update:{Key:{pk:item.pk,sk:'SERVERPULL_CAPACITY'},UpdateExpression:'ADD #n :one',ConditionExpression:'attribute_not_exists(#n) OR #n < :cap',ExpressionAttributeNames:{'#n':'count'},ExpressionAttributeValues:{':one':1,':cap':32}}}]:[])]));return item;
 }
 const operation=fn=>async(request,input)=>{let d;try{d=clone(input);}catch{fail(400,'invalid_server_pull_request');}try{return await fn(request,d);}catch(e){if(safeErrors.has(e))throw e;throw new HttpError(503,'server_pull_unconfirmed');}finally{if(d?.credentials){d.credentials.publicKey='';d.credentials.secretKey='';}}};
 const exact=d=>{if(!fields(d,['fingerprint'])||!hex(d.fingerprint))fail(400,'invalid_server_pull_request');};
 const controller={
  review:operation(async(request,d)=>{
   if(!fields(d,['fingerprint','plan'])||!hex(d.fingerprint))fail(400,'invalid_server_pull_request');const identity=await authenticate(request),p=plan(identity,d.plan);if(p.fingerprint!==d.fingerprint)fail(400,'server_pull_scope_mismatch');
   let row=await ledger.bounded(()=>store._get(key(identity,d.fingerprint)));
   if(!row){row={...key(identity,d.fingerprint),schema_version:2,tenant_id:identity.tenant_id,session_hash:identityHash(identity),fingerprint:p.fingerprint,plan:p,phase:'reviewed',version:0,expires_at:store.now()+3600,index:0,lease:null,checkpoint:createCaptureCheckpoint(p.scope)};try{row=await write(identity,null,row);}catch{row=await load(identity,d.fingerprint);}}
   else row=await load(identity,d.fingerprint);
   if(row.expires_at<=store.now()||row.phase==='revoked')fail(409,'server_pull_consent_expired_or_revoked');
   return {status:'scope_review_required',fingerprint:row.fingerprint,review_hash:reviewHash(row),disclosure:disclosure(row),execution_started:false};
  }),
  confirm:operation(async(request,d)=>{
   if(!fields(d,['fingerprint','review_hash','accept_content'])||!hex(d.fingerprint)||!hex(d.review_hash)||d.accept_content!==true)fail(400,'explicit_import_content_consent_required');
   const identity=await authenticate(request);let row=await load(identity,d.fingerprint);if(row.expires_at<=store.now()||row.phase==='revoked'||reviewHash(row)!==d.review_hash)fail(409,'server_pull_review_changed');
   if(row.phase==='reviewed')row=await write(identity,row,{...row,phase:'consented'});
   return {status:'consent_recorded',fingerprint:row.fingerprint,review_hash:d.review_hash,execution_started:false};
  }),
  revoke:operation(async(request,d)=>{exact(d);const identity=await authenticate(request);const row=await load(identity,d.fingerprint);if(row.phase!=='revoked')await write(identity,row,{...row,phase:'revoked',lease:null});return {status:'consent_revoked',fingerprint:d.fingerprint,execution_started:false};}),
  status:operation(async(request,d)=>{exact(d);return rowView(await load(await authenticate(request),d.fingerprint));}),
  start:operation(async(request,d)=>{
   exact(d);const identity=await authenticate(request);let row=await load(identity,d.fingerprint);if(row.expires_at<=store.now()||['reviewed','revoked'].includes(row.phase))fail(409,'server_pull_consent_required');
   if(row.phase==='consented'){try{row=await write(identity,row,{...row,phase:'capturing'});}catch{row=await load(identity,d.fingerprint);if(row.phase==='consented')throw Error();}}
   return rowView(row);
  }),
  advance:operation(async(request,d)=>{
   if(!fields(d,['fingerprint','credentials'])||!hex(d.fingerprint)||d.credentials!==null&&(!fields(d.credentials,['publicKey','secretKey'])||!/^[-A-Za-z0-9_]{8,256}$/.test(d.credentials.publicKey??'')||!/^[-A-Za-z0-9_]{8,512}$/.test(d.credentials.secretKey??'')))fail(400,'invalid_server_pull_request');
   const born=now(),identity=await authenticate(request);let row=await load(identity,d.fingerprint);
   const live=()=>{if(request.signal.aborted||now()-born>=SERVER_PULL_LIMITS.requestMs)fail(503,'server_pull_interrupted');if(row.expires_at<=store.now()||['reviewed','consented','revoked'].includes(row.phase))fail(409,'server_pull_consent_required');};live();
   if(['complete','empty','bounded_incomplete','conversion_rejected'].includes(row.phase))return rowView(row);
   if(row.lease&&row.lease.until>store.now())fail(409,'server_pull_busy');
   const lease={id:randomUUID(),until:store.now()+SERVER_PULL_LIMITS.leaseSeconds};row=await write(identity,row,{...row,lease});
   const update=async patch=>{live();row=await write(identity,row,{...row,...patch});};
   const guard=async()=>{live();if(hash(await authenticate(request))!==hash(identity))throw Error();const current=await load(identity,row.fingerprint);if(current.version!==row.version||current.lease?.id!==lease.id||current.phase==='revoked'||current.expires_at<=store.now())fail(409,'server_pull_changed');live();return true;};
   try{
    if(row.phase==='capturing'){
     if(!d.credentials)fail(400,'server_pull_credentials_required');
     const credentials=d.credentials,s=row.plan.scope;
     const transport=createLangfuseTransport(s,{fetchImpl,now,credentialProvider:async()=>({...credentials,origin:s.origin,projectId:s.sourceProject,traceId:s.traceId,expiresAt:now()+5000}),authorize:guard,bounds:{requestTimeoutMs:1000,totalTimeoutMs:3500,maxRequests:2,maxResponseBytes:s.maxBytes,maxTotalBytes:s.maxBytes+4096}});
     try{const result=await captureLangfuse(s,{credential:TRANSPORT_CREDENTIAL_SENTINEL,transport:transport.request,approve:guard,checkpoint:row.checkpoint,maxPagesPerCall:1});await guard();await update({checkpoint:result.state,phase:result.outcome==='captured'?(result.conversion.batches.length?'ready':'empty'):result.outcome==='bounded-incomplete'?'bounded_incomplete':result.outcome==='conversion-rejected'?'conversion_rejected':'capturing'});}finally{transport.close();}
    }else{
     // Rebuild deterministic batches from the bounded, validated sanitized checkpoint, never re-fetch.
     if(!row.checkpoint.complete)throw Error();const conversion=convert(JSON.stringify({pages:row.checkpoint.pages}),{namespace:row.plan.scope.namespace});if(conversion.report.rejected.length)throw Error();
     const batch=conversion.batches[row.index];
     if(!batch){if(row.index!==conversion.batches.length)throw Error();await update({phase:row.index?'complete':'empty'});}
     else{
      const raw=JSON.stringify(batch),requestHash=digest(raw),parsed=parseBatch(raw).batch;
      const expected={batch_id:batch.batch_id,run_id:batch.run_id,request_hash:requestHash,byte_count:Buffer.byteLength(raw),event_count:batch.events.length};
      const batchKey={pk:'TENANT#'+identity.tenant_id,sk:'BATCH#'+batch.batch_id},objectKey='v1/'+digest(identity.tenant_id)+'/'+requestHash+'.json';
      const observed=async()=>{const value=await ledger.bounded(()=>store._get(batchKey));if(!value||Object.entries(expected).some(([k,v])=>value[k]!==v)||value.tenant_id!==identity.tenant_id||value.object_key!==objectKey||!['pending','accepted'].includes(value.status))fail(409,'server_pull_reconciliation_required');return value;};
      // All destination metadata writes are atomically tied to this lease, consent and session.
      const guarded=new Proxy(store,{get(target,prop,receiver){if(prop==='_tx')return items=>{
       // DynamoDB forbids two actions on META. Merge global-session revocation into
       // the destination's existing quota/sequence update, not a second check.
       let tenantUpdates=0;const epoch=identity.parent_session.session_epoch;
       const checked=items.map(item=>{const u=item.Update;if(u?.Key?.pk!=='TENANT#'+identity.tenant_id||u.Key.sk!=='META')return item;
        tenantUpdates++;if(Object.hasOwn(u.ExpressionAttributeValues??{},':pull_epoch')||Object.hasOwn(u.ExpressionAttributeNames??{},'#pull_epoch'))throw Error();
        return {Update:{...u,ConditionExpression:'('+u.ConditionExpression+') AND '+(epoch===0?'(attribute_not_exists(#pull_epoch) OR #pull_epoch = :pull_epoch)':'#pull_epoch = :pull_epoch'),ExpressionAttributeNames:{...u.ExpressionAttributeNames,'#pull_epoch':'session_epoch'},ExpressionAttributeValues:{...u.ExpressionAttributeValues,':pull_epoch':epoch}}};});
       if(tenantUpdates!==1)throw Error();
       return target._tx([target.importSessionCheck(identity.parent_session),{ConditionCheck:{Key:key(identity,row.fingerprint),ConditionExpression:'#v = :v AND expires_at > :now',ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':v':row.version,':now':store.now()}}},...checked]);
      };const value=Reflect.get(target,prop,receiver);return typeof value==='function'?value.bind(receiver):value;}});
      if(row.phase==='ready'){
       await guard();await update({phase:'reserve_consumed'});await guard();await ledger.bounded(()=>guarded.reserveBatch(identity.tenant_id,expected));await update({phase:'object_ready'});
      }else if(row.phase==='reserve_consumed'){
       const value=await observed();await update({phase:value.status==='accepted'?'verifying':'object_ready'});
      }else if(row.phase==='object_ready'){
       await observed();await guard();await update({phase:'object_consumed'});await guard();await ledger.bounded(()=>objects.putImmutable(objectKey,raw,requestHash));await update({phase:'ack_ready'});
      }else if(row.phase==='object_consumed'){
       await observed();if(await ledger.bounded(()=>objects.get(objectKey))!==raw)fail(409,'server_pull_reconciliation_required');await update({phase:'ack_ready'});
      }else if(row.phase==='ack_ready'){
       await observed();if(await ledger.bounded(()=>objects.get(objectKey))!==raw)fail(409,'server_pull_reconciliation_required');await guard();await update({phase:'ack_consumed'});await guard();
       const times=parsed.events.map(e=>Date.parse(e.time));await ledger.bounded(()=>guarded.acceptReservedBatch(identity.tenant_id,batch.batch_id,requestHash,{writer:digest('server-pull:'+identity.tenant_id),started_at:Math.min(...times),ended_at:Math.max(...times),has_error:parsed.events.some(e=>e.kind==='error')}));await update({phase:'verifying'});
      }else if(['ack_consumed','verifying'].includes(row.phase)){
       if((await observed()).status!=='accepted'||await ledger.bounded(()=>objects.get(objectKey))!==raw)fail(409,'server_pull_reconciliation_required');await update({index:row.index+1,phase:row.index+1===conversion.batches.length?'complete':'ready'});
      }else throw Error();
     }
    }
    await guard();await update({lease:null});return rowView(row);
   }catch(e){
    // Do not release a lease on uncertainty: an outstanding timed-out operation may still finish.
    // After 30 seconds resume reads its consumed phase and reconciles, never replays that mutation.
    throw e;
   }
  })
 };
 controllers.add(controller);return Object.freeze(controller);
}
