// Explicit protected-record policy adapter. No policy writes, credential resolver, routes or installation.
// Hashes pin reviewed bytes; authority comes from the protected store and its approved provisioning owner.
import {ImportJobLedger} from './import-job-ledger.mjs';
import {validatePrivateImportApproval,approvalFields as fields,approvalHex as hex} from './private-import-approval.mjs';
import {verifyDispatchSession,validateImportLegacyProof,LANGFUSE_HOST_FIELDS} from './private-import-dispatch.mjs';
import {hash} from './trace.mjs';
import {HttpError} from './http.mjs';

export const PRIVATE_IMPORT_POLICY_ACTIONS=Object.freeze([
 'review-private-import-consent','confirm-private-import-consent','record-reviewed-private-import-consent','revoke-private-import-consent',
 'queue-private-import','reserve-private-import','inspect-private-import','cancel-private-import','download-private-import',
 'claim-source-stage','runtime-action','source-lease','source-wire','consume-once-upload','upload-approved-batch','upload-approved-batch-wire',
 'destination-write-lease','reconcile-import-batch','export-import-batch','save-imported-export','verify-saved-import-export',
 'consume-private-import-assignment','complete-private-import-assignment','release-private-import-assignment'
]);
const consentActions=new Set(PRIVATE_IMPORT_POLICY_ACTIONS.slice(0,4));
const fail=()=>{throw new HttpError(503,'private_import_policy_unconfirmed');};
const same=(a,b)=>hash(a)===hash(b);
const copy=value=>{const result=structuredClone(value);if(Buffer.byteLength(JSON.stringify(result))>65536)fail();return result;};
const safe=fn=>async(...args)=>{try{return await fn(...args);}catch{fail();}};
const scopeOf=record=>({tenant_id:record.tenant_id,project_id:record.project_id,origin:record.plan.origin,sourceProject:record.plan.sourceProject,environment:record.plan.environment});

export function createPrivateImportPolicy(options){
 if(!fields(options,['store','objects','runtime','policy_id','policy_hash'])||!hex(options.policy_id)||!hex(options.policy_hash))fail();
 const {store,objects,policy_id,policy_hash}=options,runtime=copy(options.runtime),key={pk:'PRIVATEIMPORTPOLICY#'+policy_id,sk:'POLICY'},ledger=new ImportJobLedger(store,{objects});
 function checked(value,{revoking=false}={}){
  const row=copy(value);
  if(!fields(row,['pk','sk','schema_version','policy_hash','payload','state','version','created_at'])||row.pk!==key.pk||row.sk!==key.sk||row.schema_version!==1||row.policy_hash!==policy_hash||hash(row.payload)!==policy_hash||
   !['hold','active','revoked'].includes(row.state)||!Number.isSafeInteger(row.version)||row.version<0||!Number.isSafeInteger(row.created_at)||row.created_at<0||row.created_at>store.now()||!revoking&&row.state!=='active')fail();
  const p=row.payload;
  if(!fields(p,['schema_version','approval','actions','legacy','evidence','inventory_complete'])||p.schema_version!==1||p.inventory_complete!==true||
   !Array.isArray(p.actions)||!p.actions.length||p.actions.length>PRIVATE_IMPORT_POLICY_ACTIONS.length||new Set(p.actions).size!==p.actions.length||p.actions.some(a=>!PRIVATE_IMPORT_POLICY_ACTIONS.includes(a))||
   !fields(p.evidence,['source','destination','host','legacy'])||Object.values(p.evidence).some(v=>!hex(v)))fail();
  const approval=validatePrivateImportApproval(p.approval,hash(p.approval),{runtime,now:revoking?row.created_at:store.now()});
  validateImportLegacyProof(scopeOf(p.approval),p.approval.descriptor.legacy_snapshot_hash,p.legacy);
  return {row,...approval};
 }
 async function current({revoking=false}={}){
  const result=checked(await ledger.bounded(()=>store._get(key)),{revoking});
  await verifyDispatchSession(ledger,{binding:{tenant_id:result.record.tenant_id,parent_session:result.record.parent_session}});
  return result;
 }
 async function finish(value,{revoking=false}={}){
  const {row,record}=value,scoped=new ImportJobLedger(store,{objects,parentSession:record.parent_session});
  // The final awaited boundary checks policy bytes/state/version, account epoch and original physical session together.
  // Uncertain outcomes deny; this adapter never retries, writes policy, or clears a hold.
  await ledger.bounded(()=>store._tx([...scoped.parentChecks(),scoped.checkTenant(record.tenant_id,record.parent_session.session_epoch),{ConditionCheck:{Key:key,ConditionExpression:'#v = :v AND #s = :s AND policy_hash = :h AND payload = :p AND created_at = :c',ExpressionAttributeNames:{'#v':'version','#s':'state'},ExpressionAttributeValues:{':v':row.version,':s':row.state,':h':policy_hash,':p':row.payload,':c':row.created_at}}}]));
  checked(row,{revoking});
 }
 function matches(descriptor,approval){
  const {record:r,plan,descriptor:d}=approval;
  if(descriptor.action==='queue-private-import')return descriptor.tenant_id===r.tenant_id&&same(descriptor.parent_session,r.parent_session)&&same(descriptor.plan,r.plan)&&descriptor.fingerprint===r.fingerprint&&same(descriptor.descriptor,d)&&descriptor.fields===LANGFUSE_HOST_FIELDS;
  const b=descriptor.binding??(descriptor.action==='reserve-private-import'?descriptor:null);
  return !!b&&b.schema_version===1&&b.tenant_id===r.tenant_id&&b.project_id===r.project_id&&b.environment_id===r.environment_id&&b.fingerprint===r.fingerprint&&same(b.source,plan)&&same(b.parent_session,r.parent_session)&&Object.keys(d).every(k=>b[k]===d[k]);
 }
 return Object.freeze({
  proposalProvider:safe(async input=>{
   const d=copy(input);if(!fields(d,['identity','fingerprint']))fail();const value=await current();
   if(!fields(d.identity,['tenant_id','parent_session'])||d.identity.tenant_id!==value.record.tenant_id||!same(d.identity.parent_session,value.record.parent_session)||d.fingerprint!==value.record.fingerprint||!value.row.payload.actions.includes('review-private-import-consent'))fail();
   await finish(value);return copy(value.record);
  }),
  authorize:async input=>{
   try{
    const d=copy(input),consent=fields(d,['action','approval_id','record']),worker=fields(d,['approval_id','descriptor']);if(!consent&&!worker)return false;
    const action=consent?d.action:d.descriptor?.action,revoking=action==='revoke-private-import-consent';
    if(consent!==consentActions.has(action)||!PRIVATE_IMPORT_POLICY_ACTIONS.includes(action))return false;
    const value=await current({revoking});
    if(d.approval_id!==hash(value.record)||!value.row.payload.actions.includes(action)||!(consent?same(d.record,value.record):matches(d.descriptor,value)))return false;
    await finish(value,{revoking});return true;
   }catch{return false;}
  },
  legacyProvider:safe(async input=>{
   const d=copy(input);if(!fields(d,['scope','expected_hash']))fail();const value=await current();
   if(!same(d.scope,scopeOf(value.record))||d.expected_hash!==value.record.descriptor.legacy_snapshot_hash)fail();
   await finish(value);return copy(value.row.payload.legacy);
  })
 });
}
