// Canonical protected approval validation shared by application ingress and private worker.
import {alphaProject} from './alpha-projects.mjs';
import {planCustomerImport} from './import-planning.mjs';
import {LANGFUSE_HOST_FIELDS} from './private-import-dispatch.mjs';
import {hash} from './trace.mjs';
import {HttpError} from './http.mjs';
export const approvalFields=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join()===keys.slice().sort().join();
export const approvalHex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function validatePrivateImportApproval(value,id,{runtime,now}={}){
 try{
  const record=structuredClone(value),fields=approvalFields,hex=approvalHex;
  if(!Number.isSafeInteger(now)||Buffer.byteLength(JSON.stringify(record))>65536||!hex(id)||
   !fields(record,['schema_version','tenant_id','parent_session','project_id','environment_id','plan','fingerprint','descriptor'])||record.schema_version!==1||hash(record)!==id||
   !fields(record.parent_session,['token_hash','tenant_id','session_epoch'])||!hex(record.parent_session.token_hash)||record.parent_session.tenant_id!==record.tenant_id||!Number.isSafeInteger(record.parent_session.session_epoch)||record.parent_session.session_epoch<0||
   record.project_id!==alphaProject(record.tenant_id).id||record.environment_id!=='default'||
   !fields(record.descriptor,['worker_id','revision','artifact_hash','source_binding','destination_binding','destination_origin','legacy_snapshot_hash','expires_at']))throw Error();
  const d=record.descriptor;
  if(['worker_id','artifact_hash','source_binding','destination_binding','legacy_snapshot_hash'].some(k=>!hex(d[k]))||!/^[a-f0-9]{40}$/.test(d.revision??'')||
   d.worker_id!==runtime?.worker_id||d.revision!==runtime?.revision||d.artifact_hash!==runtime?.artifact_hash||!['https://supatrace.dev','https://supatrace.tech'].includes(d.destination_origin)||
   !Number.isSafeInteger(d.expires_at)||d.expires_at<=now||d.expires_at>now+3600)throw Error();
  const plan=planCustomerImport(record.plan,record.project_id).plan;
  if(!Object.hasOwn(plan.scope,'traceId')||plan.fields!==LANGFUSE_HOST_FIELDS||plan.fingerprint!==record.fingerprint)throw Error();
  return {record,plan,descriptor:{...d,approval_hash:id}};
 }catch{throw new HttpError(409,'private_import_approval_invalid');}
}
