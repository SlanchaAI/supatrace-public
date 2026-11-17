// One durable slot per explicit worker. No scan, background poller, TTL takeover or deletion.
import {randomBytes} from 'node:crypto';
import {hash} from './trace.mjs';
import {alphaProject} from './alpha-projects.mjs';
import {HttpError} from './http.mjs';
import {ImportJobLedger} from './import-job-ledger.mjs';
import {loadImportDispatch,validateImportDispatch,verifyDispatchSession} from './private-import-dispatch.mjs';
import {activePrivateImportConsentCondition} from './private-import-consent.mjs';
import {approvalFields as fields,approvalHex as hex} from './private-import-approval.mjs';
const fail=code=>{throw new HttpError(409,'private_assignment_'+code);};
export const importAssignmentKey=worker=>{if(!hex(worker))fail('invalid');return {pk:'PRIVATEIMPORTWORKER#'+worker,sk:'SLOT'};};
const seal=value=>{if(Object.hasOwn(value,'version')&&(!Number.isSafeInteger(value.version)||value.version<0))fail('invalid');return {...value,checksum:hash(value)};};
const tenant=value=>{try{alphaProject(value);return true;}catch{return false;}};
const body=row=>{const {checksum,...value}=row;return value;};
function binding(dispatch){const b=dispatch.binding;return {worker_id:b.worker_id,revision:b.revision,artifact_hash:b.artifact_hash,tenant_id:b.tenant_id,job_id:b.job_id,approval_id:b.approval_hash,binding_hash:dispatch.binding_hash,expires_at:b.expires_at};}
function checked(value,worker){
 if(!fields(value,['pk','sk','schema_version','assignment','assignment_hash','version','state','attempt_id','receipt_hash','checksum'])||value.schema_version!==1||Buffer.byteLength(JSON.stringify(value))>8192||value.pk!==importAssignmentKey(worker).pk||value.sk!=='SLOT'||!hex(value.checksum)||hash(body(value))!==value.checksum||
  !fields(value.assignment,['worker_id','revision','artifact_hash','tenant_id','job_id','approval_id','binding_hash','expires_at'])||value.assignment.worker_id!==worker||!hex(value.assignment.artifact_hash)||!hex(value.assignment.approval_id)||!hex(value.assignment.binding_hash)||!/^[a-f0-9]{40}$/.test(value.assignment.revision??'')||!tenant(value.assignment.tenant_id)||!/^ij_[a-f0-9]{64}$/.test(value.assignment.job_id??'')||!Number.isSafeInteger(value.assignment.expires_at)||hash(value.assignment)!==value.assignment_hash||!Number.isSafeInteger(value.version)||value.version<0||
  !['pending','consumed','complete','released','held'].includes(value.state)||
  (value.state==='pending'?value.attempt_id!==null:!hex(value.attempt_id))||
  (['complete','released'].includes(value.state)?!hex(value.receipt_hash):value.receipt_hash!==null))fail('invalid');
 return structuredClone(value);
}
export async function readImportAssignment(ledger,worker){
 let value;try{value=await ledger.bounded(()=>ledger.store._get(importAssignmentKey(worker)));}catch{fail('read_unconfirmed');}
 return value?checked(value,worker):null;
}
export async function matchImportAssignment(ledger,slot,runtime){
 slot=checked(slot,runtime.worker_id);const a=slot.assignment;
 if(a.revision!==runtime.revision||a.artifact_hash!==runtime.artifact_hash)fail('runtime_mismatch');
 const dispatch=await loadImportDispatch(ledger,a.tenant_id,a.job_id);
 if(hash(binding(dispatch))!==slot.assignment_hash)fail('binding_mismatch');
 return dispatch;
}
function resultAudit(slot,audit){
 const key={pk:slot.pk,sk:'RESULT#'+slot.assignment.job_id+'#'+slot.attempt_id};
 return fields(audit,['pk','sk','schema_version','assignment','assignment_hash','attempt_id','receipt_hash','checksum'])&&audit.pk===key.pk&&audit.sk===key.sk&&audit.schema_version===1&&audit.assignment_hash===slot.assignment_hash&&audit.attempt_id===slot.attempt_id&&audit.receipt_hash===slot.receipt_hash&&hash(audit.assignment)===slot.assignment_hash&&hash(body(audit))===audit.checksum;
}
async function releasedProof(store,slot){
 const key={pk:slot.pk,sk:'RELEASE#'+slot.assignment.job_id+'#'+slot.attempt_id},audit=structuredClone(await store._get({...key})),result=structuredClone(await store._get({pk:slot.pk,sk:'RESULT#'+slot.assignment.job_id+'#'+slot.attempt_id}));
 if(!fields(audit,['pk','sk','schema_version','assignment_hash','attempt_id','receipt_hash','checksum'])||audit.pk!==key.pk||audit.sk!==key.sk||audit.schema_version!==1||audit.assignment_hash!==slot.assignment_hash||audit.attempt_id!==slot.attempt_id||audit.receipt_hash!==slot.receipt_hash||hash(body(audit))!==audit.checksum||!resultAudit(slot,result))fail('release_unverified');
 return [{ConditionCheck:{Key:key,ConditionExpression:'checksum = :h',ExpressionAttributeValues:{':h':audit.checksum}}},{ConditionCheck:{Key:{pk:result.pk,sk:result.sk},ConditionExpression:'checksum = :h',ExpressionAttributeValues:{':h':result.checksum}}}];
}
// Used only around the application's existing atomic CREATE transaction.
export function assignmentStore(store){
 const wrapped=Object.create(store);
 wrapped._tx=async input=>{
  const ops=structuredClone(input),dispatches=ops.filter(o=>o.Put?.Item?.sk?.startsWith('IMPORTDISPATCH#'));
  if(!dispatches.length)return store._tx(ops);
  if(dispatches.length!==1)fail('creation_invalid');
  const dispatch=dispatches[0].Put.Item,job=ops.find(o=>o.Put?.Item?.sk==='IMPORTJOB#'+dispatch.binding?.job_id)?.Put.Item;
  validateImportDispatch(dispatch,job);if(dispatch.state!=='queued'||dispatch.version!==0)fail('creation_invalid');
  const a=binding(dispatch),key=importAssignmentKey(a.worker_id),raw=await store._get(key),old=raw?checked(raw,a.worker_id):null;
  if(old&&checked(old,a.worker_id).state!=='released')fail('worker_occupied');
  const proof=old?await releasedProof(store,checked(old,a.worker_id)):[];
  const next=seal({...key,schema_version:1,assignment:a,assignment_hash:hash(a),version:old?old.version+1:0,state:'pending',attempt_id:null,receipt_hash:null});
  const guard=old?{ConditionExpression:'#v = :v AND #s = :s AND checksum = :h',ExpressionAttributeNames:{'#v':'version','#s':'state'},ExpressionAttributeValues:{':v':old.version,':s':'released',':h':old.checksum}}:{ConditionExpression:'attribute_not_exists(pk)'};
  return store._tx([...ops,...proof,{Put:{Item:next,...guard}}]);
 };
 return wrapped;
}
async function transition(base,slot,next,{audit=null,consent=true,checks=[]}={}){
 slot=checked(slot,slot.assignment.worker_id);const a=slot.assignment,dispatch=await loadImportDispatch(base,a.tenant_id,a.job_id),ledger=new ImportJobLedger(base.store,{objects:base.objects,parentSession:dispatch.binding.parent_session});
 if(hash(binding(dispatch))!==slot.assignment_hash)fail('binding_mismatch');
 if(consent)await verifyDispatchSession(ledger,dispatch);
 const ops=[...(consent?[activePrivateImportConsentCondition(a.approval_id),...ledger.parentChecks(),ledger.checkTenant(a.tenant_id,dispatch.binding.parent_session.session_epoch)]:[]),...checks,{Put:{Item:next,ConditionExpression:'#v = :v AND checksum = :h',ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':v':slot.version,':h':slot.checksum}}},...(audit?[{Put:{Item:audit,ConditionExpression:'attribute_not_exists(pk)'}}]:[])];
 try{await base.bounded(()=>base.store._tx(ops));}catch{fail('write_unconfirmed');}
 const observed=await readImportAssignment(base,a.worker_id);if(!observed||hash(observed)!==hash(next))fail('readback_unconfirmed');return observed;
}
export async function consumeImportAssignment(ledger,slot){
 if(slot.state!=='pending'||slot.assignment.expires_at<=ledger.store.now())fail('not_pending');
 const a=slot.assignment,dispatch=await loadImportDispatch(ledger,a.tenant_id,a.job_id),job=await ledger.load(a.tenant_id,a.job_id);
 if(dispatch.state!=='queued'||job.state!=='awaiting_bindings'||job.cancel_requested||job.claim||job.upload)fail('not_pending');
 const checks=[{ConditionCheck:{Key:{pk:dispatch.pk,sk:dispatch.sk},ConditionExpression:'checksum = :h',ExpressionAttributeValues:{':h':dispatch.checksum}}},{ConditionCheck:{Key:{pk:job.pk,sk:job.sk},ConditionExpression:'#v = :v AND #s = :s AND cancel_requested = :no',ExpressionAttributeNames:{'#v':'version','#s':'state'},ExpressionAttributeValues:{':v':job.version,':s':'awaiting_bindings',':no':false}}}];
 return transition(ledger,slot,seal({...body(slot),version:slot.version+1,state:'consumed',attempt_id:randomBytes(32).toString('hex')}),{checks});
}
export async function holdImportAssignment(ledger,slot){
 if(slot.state!=='consumed')return;
 // Can only fence this exact confirmed attempt; never clear another attempt or a completion.
 return transition(ledger,slot,seal({...body(slot),version:slot.version+1,state:'held'}),{consent:false});
}
export async function completeImportAssignment(ledger,slot,receipt){
 if(slot.state!=='consumed')fail('not_consumed');
 const dispatch=await loadImportDispatch(ledger,slot.assignment.tenant_id,slot.assignment.job_id);
 if(dispatch.state!=='complete'||hash(dispatch.receipt)!==hash(receipt)||receipt?.export_verified!==true)fail('completion_unverified');
 const receipt_hash=hash(receipt),next=seal({...body(slot),version:slot.version+1,state:'complete',receipt_hash});
 const audit=seal({pk:slot.pk,sk:'RESULT#'+slot.assignment.job_id+'#'+slot.attempt_id,schema_version:1,assignment:slot.assignment,assignment_hash:slot.assignment_hash,attempt_id:slot.attempt_id,receipt_hash});
 return transition(ledger,slot,next,{audit,checks:[{ConditionCheck:{Key:{pk:dispatch.pk,sk:dispatch.sk},ConditionExpression:'checksum = :h',ExpressionAttributeValues:{':h':dispatch.checksum}}}]});
}
export async function releaseImportAssignment(ledger,slot){
 if(slot.state!=='complete')fail('completion_required');
 const dispatch=await loadImportDispatch(ledger,slot.assignment.tenant_id,slot.assignment.job_id),auditKey={pk:slot.pk,sk:'RESULT#'+slot.assignment.job_id+'#'+slot.attempt_id};
 const audit=await ledger.bounded(()=>ledger.store._get(auditKey));
 if(dispatch.state!=='complete'||hash(dispatch.receipt)!==slot.receipt_hash||!resultAudit(slot,audit))fail('completion_unverified');
 const next=seal({...body(slot),version:slot.version+1,state:'released'});
 const record=seal({pk:slot.pk,sk:'RELEASE#'+slot.assignment.job_id+'#'+slot.attempt_id,schema_version:1,assignment_hash:slot.assignment_hash,attempt_id:slot.attempt_id,receipt_hash:slot.receipt_hash});
 return transition(ledger,slot,next,{audit:record,checks:[{ConditionCheck:{Key:{pk:dispatch.pk,sk:dispatch.sk},ConditionExpression:'checksum = :h',ExpressionAttributeValues:{':h':dispatch.checksum}}},{ConditionCheck:{Key:auditKey,ConditionExpression:'checksum = :h',ExpressionAttributeValues:{':h':audit.checksum}}}]});
}
