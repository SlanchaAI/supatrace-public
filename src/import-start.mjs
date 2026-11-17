import {assignmentStore,readImportAssignment,matchImportAssignment} from './private-import-assignment.mjs';
// Same-origin application ingress -> protected durable dispatch; no cookie reaches the worker.
import {createPrivateImportAuthenticator} from './private-import-auth.mjs';
import {validatePrivateImportApproval,approvalFields as fields,approvalHex as hex} from './private-import-approval.mjs';
import {ImportJobLedger} from './import-job-ledger.mjs';
import {loadImportDispatch,LANGFUSE_HOST_FIELDS} from './private-import-dispatch.mjs';
import {hash} from './trace.mjs';
import {HttpError} from './http.mjs';
const controllers=new WeakSet();
export const importStartAvailable=controller=>controllers.has(controller);
export function createImportStartController({store,objects,origin,runtime,consents,authorize,readiness}={}){
 if(!['lookup','provide','guardedStore'].every(k=>typeof consents?.[k]==='function')||typeof authorize!=='function'||typeof readiness!=='function')throw new HttpError(503,'import_runtime_unavailable');
 runtime=structuredClone(runtime);const authenticate=createPrivateImportAuthenticator({store,origin}),base=new ImportJobLedger(store,{objects});
 const validate=(value,id)=>validatePrivateImportApproval(value,id,{runtime,now:store.now()});
 async function permission(descriptor,id){let allowed;try{allowed=await base.bounded(()=>authorize({approval_id:id,descriptor:structuredClone(descriptor)}));}catch{throw Error();}if(allowed!==true)throw Error();}
 const controller=Object.freeze({async start(request,data){
  try{data=structuredClone(data);}catch{throw new HttpError(400,'invalid_import_plan');}
  if(!fields(data,['fingerprint'])||!hex(data.fingerprint))throw new HttpError(400,'invalid_import_plan');
  const fingerprint=data.fingerprint;
  try{
   const identity=await authenticate(request),consent=structuredClone(await base.bounded(()=>consents.lookup(identity,fingerprint))),approvalId=consent.approval_id;
   const {record,descriptor}=validate(consent.record,approvalId);
   if(record.tenant_id!==identity.tenant_id||hash(record.parent_session)!==hash(identity.parent_session)||record.fingerprint!==fingerprint)throw Error();
   const check={action:'queue-private-import',tenant_id:identity.tenant_id,parent_session:identity.parent_session,plan:record.plan,fingerprint,descriptor,fields:LANGFUSE_HOST_FIELDS};
   await permission(check,approvalId);
   if(await base.bounded(()=>readiness(structuredClone({approval_id:approvalId,...check})))!==true)throw Error();
   validate(await base.bounded(()=>consents.provide({approval_id:approvalId})),approvalId);
   const current=await authenticate(request);if(hash(current)!==hash(identity))throw Error();
   const ledger=new ImportJobLedger(assignmentStore(consents.guardedStore(approvalId)),{objects,parentSession:identity.parent_session});
   const job=await ledger.create(identity.tenant_id,record.plan,fingerprint,descriptor),dispatch=await loadImportDispatch(ledger,identity.tenant_id,job.job_id);
   const assignment=await readImportAssignment(ledger,runtime.worker_id);if(!assignment)throw Error();
   if((await matchImportAssignment(ledger,assignment,runtime)).binding_hash!==dispatch.binding_hash)throw Error();
   await permission(check,approvalId);if(hash(await authenticate(request))!==hash(identity))throw Error();
   validate(await base.bounded(()=>consents.provide({approval_id:approvalId})),approvalId);
   return {job_id:job.job_id,job,dispatch_state:dispatch.state,assignment_state:assignment.state,execution_started:false};
  }catch{throw new HttpError(503,'import_start_unconfirmed');}
 }});controllers.add(controller);return controller;
}
