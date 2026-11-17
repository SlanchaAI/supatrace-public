// Protected durable approval custody, not a consent UI or credential vault.
// No public registration route. A genuine reviewed-consent controller/policy must authorize writes.
import {ImportJobLedger} from './import-job-ledger.mjs';
import {verifyDispatchSession} from './private-import-dispatch.mjs';
import {createPrivateImportAuthenticator} from './private-import-auth.mjs';
import {validatePrivateImportApproval,approvalFields as fields,approvalHex as hex} from './private-import-approval.mjs';
import {hash} from './trace.mjs';
import {HttpError} from './http.mjs';
const fail=code=>{throw new HttpError(409,'private_consent_'+code);};
const key=id=>({pk:'PRIVATEIMPORTCONSENT#'+id,sk:'APPROVAL'});
const pointerKey=(identity,fingerprint)=>({pk:'PRIVATEIMPORTCONSENTSESSION#'+hash({identity,fingerprint}),sk:'CONSENT'});
const equivalent=(a,b)=>hash(a)===hash(b);
export const activePrivateImportConsentCondition=id=>{if(!hex(id))fail('unavailable');return {ConditionCheck:{Key:key(id),ConditionExpression:'approval_id = :id AND #v = :v AND revoked = :no',ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':id':id,':v':0,':no':false}}};};
export function createPrivateImportConsentStore({store,objects,origin,runtime,authorize}={}){
 if(typeof authorize!=='function')fail('policy_required');
 runtime=structuredClone(runtime);const ledger=new ImportJobLedger(store,{objects}),authenticate=createPrivateImportAuthenticator({store,origin});
 const checked=(record,id)=>validatePrivateImportApproval(record,id,{runtime,now:store.now()});
 async function session(record){try{await verifyDispatchSession(ledger,{binding:{tenant_id:record.tenant_id,parent_session:record.parent_session}});}catch{fail('session_unavailable');}}
 async function row(id,{inactive=false}={}){
  if(!hex(id))fail('unavailable');
  let value;try{value=await ledger.bounded(()=>store._get(key(id)));}catch{fail('unavailable');}
  if(!fields(value,['pk','sk','schema_version','approval_id','record','version','revoked','created_at'])||value.pk!==key(id).pk||value.sk!=='APPROVAL'||value.schema_version!==1||value.approval_id!==id||
   !Number.isSafeInteger(value.created_at)||![0,1].includes(value.version)||typeof value.revoked!=='boolean'||value.revoked!==(value.version===1)||hash(value.record)!==id)fail('unavailable');
  // Revocation may be inspected after expiry, but never used as worker authority.
  if(inactive)validatePrivateImportApproval(value.record,id,{runtime,now:value.created_at});
  else{checked(value.record,id);if(value.revoked)fail('revoked');}
  await session(value.record);return structuredClone(value);
 }
 async function permitted(action,record,id){
  let allowed;try{allowed=await ledger.bounded(()=>authorize({action,approval_id:id,record:structuredClone(record)}));}catch{fail('policy_unavailable');}
  await session(record);if(allowed!==true)fail('not_authorized');
 }
 async function provide({approval_id}){const first=await row(approval_id),last=await row(approval_id);if(!equivalent(first,last))fail('changed');return last.record;}
 async function pointer(identity,fingerprint){
  if(!hex(fingerprint)||!fields(identity,['tenant_id','parent_session']))fail('unavailable');
  let p;try{p=await ledger.bounded(()=>store._get(pointerKey(identity,fingerprint)));}catch{fail('unavailable');}
  if(!fields(p,['pk','sk','schema_version','approval_id','identity','fingerprint'])||p.pk!==pointerKey(identity,fingerprint).pk||p.sk!=='CONSENT'||p.schema_version!==1||!hex(p.approval_id)||!equivalent(p.identity,identity)||p.fingerprint!==fingerprint)fail('unavailable');
  return p;
 }
 async function lookup(identity,fingerprint){
  const p=await pointer(identity,fingerprint);
  const record=await provide({approval_id:p.approval_id});
  if(record.tenant_id!==identity.tenant_id||!equivalent(record.parent_session,identity.parent_session)||record.fingerprint!==fingerprint)fail('binding_mismatch');
  return {approval_id:p.approval_id,record};
 }
 // Add the same active approval condition to the existing atomic job+dispatch transaction.
 // A concurrent revoke cannot authorize a newly created queue record.
 function guardedStore(approval_id){
  if(!hex(approval_id))fail('unavailable');
  return {now:store.now.bind(store),_get:store._get.bind(store),getTenant:store.getTenant.bind(store),
   getImportSessionStamp:store.getImportSessionStamp.bind(store),importSessionCheck:store.importSessionCheck.bind(store),
   _tx:ops=>store._tx([activePrivateImportConsentCondition(approval_id),...ops])};
 }
 async function revoke(request,approval_id){
  const value=await row(approval_id,{inactive:true}),identity=await authenticate(request),record=value.record;
  if(record.tenant_id!==identity.tenant_id||!equivalent(record.parent_session,identity.parent_session))fail('original_session_required');
  await permitted('revoke-private-import-consent',record,approval_id);
  if(!value.revoked){const scoped=new ImportJobLedger(store,{objects,parentSession:identity.parent_session});try{await ledger.bounded(()=>store._tx([...scoped.parentChecks(),scoped.checkTenant(identity.tenant_id,identity.parent_session.session_epoch),{Put:{Item:{...value,version:1,revoked:true},ConditionExpression:'#v = :v AND approval_id = :id',ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':v':0,':id':approval_id}}}]));}catch{fail('revocation_uncertain');}}
  const observed=await row(approval_id,{inactive:true});if(!observed.revoked)fail('revocation_unverified');return {approval_id,revoked:true};
 }
 return Object.freeze({provide,lookup,guardedStore,revoke,
  async verifyRecorded({approval_id}){
   const record=await provide({approval_id}),scoped=new ImportJobLedger(store,{objects,parentSession:record.parent_session});
   try{await ledger.bounded(()=>store._tx([...scoped.parentChecks(),scoped.checkTenant(record.tenant_id,record.parent_session.session_epoch),activePrivateImportConsentCondition(approval_id)]));}catch{fail('confirmation_unverified');}
   checked(record,approval_id);return structuredClone(record);
  },
  async revokeByFingerprint(request,fingerprint){const identity=await authenticate(request),p=await pointer(identity,fingerprint);return revoke(request,p.approval_id);},
  async registerReviewedApproval(request,input){
   let record;try{record=structuredClone(input);}catch{fail('invalid');}
   let approval_id;try{approval_id=hash(record);}catch{fail('invalid');}checked(record,approval_id);const identity=await authenticate(request);
   if(record.tenant_id!==identity.tenant_id||!equivalent(record.parent_session,identity.parent_session))fail('original_session_required');
   await permitted('record-reviewed-private-import-consent',record,approval_id);checked(record,approval_id);
   const scoped=new ImportJobLedger(store,{objects,parentSession:identity.parent_session});let epoch;try{({epoch}=await scoped.account(identity.tenant_id));}catch{fail('registration_uncertain');}
   const approval={...key(approval_id),schema_version:1,approval_id,record,version:0,revoked:false,created_at:store.now()},pointer={...pointerKey(identity,record.fingerprint),schema_version:1,approval_id,identity,fingerprint:record.fingerprint};
   let old;try{old=await ledger.bounded(()=>store._get(pointerKey(identity,record.fingerprint)));}catch{fail('registration_uncertain');}
   if(old){if(old.approval_id!==approval_id)fail('scope_already_bound');await lookup(identity,record.fingerprint);return {approval_id};}
   try{await ledger.bounded(()=>store._tx([...scoped.parentChecks(),scoped.checkTenant(identity.tenant_id,epoch),{Put:{Item:approval,ConditionExpression:'attribute_not_exists(pk)'}},{Put:{Item:pointer,ConditionExpression:'attribute_not_exists(pk)'}}]));}catch{fail('registration_uncertain');}
   const observed=await lookup(identity,record.fingerprint);if(observed.approval_id!==approval_id)fail('registration_unverified');
   return {approval_id};
  }
 });
}
