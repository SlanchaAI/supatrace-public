// Explicit application composition only. No proposal discovery, custody or production installation.
import {createPrivateImportAuthenticator} from './private-import-auth.mjs';
import {validatePrivateImportApproval,approvalFields as fields,approvalHex as hex} from './private-import-approval.mjs';
import {ImportJobLedger} from './import-job-ledger.mjs';
import {LANGFUSE_HOST_FIELDS} from './private-import-dispatch.mjs';
import {hash} from './trace.mjs';
import {HttpError} from './http.mjs';
const controllers=new WeakSet(),safeErrors=new WeakMap();
function fail(status,code){const e=new HttpError(status,code);safeErrors.set(e,Object.freeze({status,code}));throw e;}
const operation=callback=>async(...args)=>{try{return await callback(...args);}catch(e){const category=safeErrors.get(e);throw new HttpError(category?.status??503,category?.code??'import_consent_unconfirmed');}};
export const importConsentReviewAvailable=value=>controllers.has(value);
export function createImportConsentReviewController(options){
 if(!fields(options,['store','objects','origin','runtime','consents','proposalProvider','authorize'])||typeof options.proposalProvider!=='function'||typeof options.authorize!=='function'||!['registerReviewedApproval','verifyRecorded','revokeByFingerprint'].every(k=>typeof options.consents?.[k]==='function'))fail(503,'import_consent_unavailable');
 const {store,objects,origin,consents,proposalProvider,authorize}=options,runtime=structuredClone(options.runtime),authenticate=createPrivateImportAuthenticator({store,origin}),ledger=new ImportJobLedger(store,{objects});
 const validate=(record,id)=>validatePrivateImportApproval(record,id,{runtime,now:store.now()});
 const input=(data,keys)=>{let d;try{d=structuredClone(data);}catch{fail(400,'invalid_import_consent');}if(!fields(d,keys)||!hex(d.fingerprint))fail(400,'invalid_import_consent');return d;};
 async function current(request,identity){if(hash(await authenticate(request))!==hash(identity))throw Error();}
 async function permit(request,identity,action,record,id){
  if(await ledger.bounded(()=>authorize({action,approval_id:id,record:structuredClone(record)}))!==true)throw Error();
  validate(record,id);await current(request,identity);validate(record,id);
 }
 async function proposed(request,fingerprint){
  const identity=await authenticate(request),record=structuredClone(await ledger.bounded(()=>proposalProvider({identity:structuredClone(identity),fingerprint}))),id=hash(record);
  validate(record,id);await current(request,identity);
  if(record.tenant_id!==identity.tenant_id||hash(record.parent_session)!==hash(identity.parent_session)||record.fingerprint!==fingerprint)throw Error();
  await permit(request,identity,'review-private-import-consent',record,id);
  const p=record.plan,d=record.descriptor;
  const disclosure={source:{provider:p.provider,origin:p.origin,project_id:p.sourceProject,trace_id:p.traceId,environment:p.environment,from:p.from,to:p.to,namespace:p.namespace},destination:{origin:d.destination_origin,project_id:record.project_id,environment_id:record.environment_id},fields:LANGFUSE_HOST_FIELDS.split(','),content:{input_output:true,prompts:true},bounds:{max_rows:p.maxRows,max_pages:p.maxPages,page_size:p.pageSize,max_bytes:p.maxBytes,max_retries:p.maxRetries},expires_at:d.expires_at};
  const reviewHash=hash({schema_version:1,approval_id:id,disclosure});
  return {identity,record,id,disclosure,reviewHash};
 }
 const controller=Object.freeze({
  review:operation(async(request,data)=>{
   const d=input(data,['fingerprint']),p=await proposed(request,d.fingerprint);
   return {status:'scope_review_required',fingerprint:d.fingerprint,review_hash:p.reviewHash,disclosure:p.disclosure,execution_started:false};
  }),
  confirm:operation(async(request,data)=>{
   const d=input(data,['fingerprint','review_hash','accept_content']);if(!hex(d.review_hash)||d.accept_content!==true)fail(400,'explicit_import_content_consent_required');
   const p=await proposed(request,d.fingerprint);
   if(d.review_hash!==p.reviewHash)fail(409,'import_consent_review_changed');
   await permit(request,p.identity,'confirm-private-import-consent',p.record,p.id);
   const registered=await ledger.bounded(()=>consents.registerReviewedApproval(request,structuredClone(p.record)));if(registered?.approval_id!==p.id)throw Error();
   await permit(request,p.identity,'confirm-private-import-consent',p.record,p.id);
   await current(request,p.identity);
   // Last awaited boundary atomically checks active consent and its original physical session.
   const saved=structuredClone(await ledger.bounded(()=>consents.verifyRecorded({approval_id:p.id})));validate(saved,p.id);if(hash(saved)!==hash(p.record))throw Error();
   return {status:'consent_recorded',fingerprint:d.fingerprint,review_hash:p.reviewHash,execution_started:false};
  }),
  revoke:operation(async(request,data)=>{
   const d=input(data,['fingerprint']),identity=await authenticate(request),revoked=await ledger.bounded(()=>consents.revokeByFingerprint(request,d.fingerprint));
   if(!hex(revoked?.approval_id)||revoked.revoked!==true)throw Error();await current(request,identity);
   return {status:'consent_revoked',fingerprint:d.fingerprint,execution_started:false};
  })
 });controllers.add(controller);return controller;
}
