// Protected server records only. No provider, credential, timer, queue or default allow.
import {hash} from './trace.mjs';
import {compareTimestamps} from './importers/timestamps.mjs';
import {HttpError} from './http.mjs';
export const LANGFUSE_HOST_FIELDS='core,basic,time,io,metadata,model,usage,prompt,metrics,trace_context';
const fail=code=>{throw new HttpError(409,code);};
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const fields=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join()===keys.slice().sort().join();
export const dispatchKey=(tenant,job)=>({pk:'TENANT#'+tenant,sk:'IMPORTDISPATCH#'+job});
const seal=row=>({...row,checksum:hash(row)});
function checked(row){const {checksum,...body}=row??{};if(!hex(checksum)||hash(body)!==checksum)fail('private_dispatch_record_invalid');return row;}
export function makeImportDispatch(job,parent,descriptor){
 const keys=['worker_id','revision','artifact_hash','approval_hash','source_binding','destination_binding','destination_origin','legacy_snapshot_hash','expires_at'];
 if(!parent||parent.tenant_id!==job.tenant_id||parent.session_epoch!==job.session_epoch||!fields(parent,['token_hash','tenant_id','session_epoch'])||!hex(parent.token_hash)||!fields(descriptor,keys)||keys.filter(k=>!['revision','expires_at','destination_origin'].includes(k)).some(k=>!hex(descriptor[k]))||!['https://supatrace.dev','https://supatrace.tech'].includes(descriptor.destination_origin)||!/^[a-f0-9]{40}$/.test(descriptor.revision??'')||!Number.isSafeInteger(descriptor.expires_at)||descriptor.expires_at<=job.created_at||descriptor.expires_at>job.created_at+3600||job.plan.fields!==LANGFUSE_HOST_FIELDS)fail('private_dispatch_binding_invalid');
 const binding={schema_version:1,job_id:job.job_id,tenant_id:job.tenant_id,project_id:job.project_id,environment_id:'default',fingerprint:job.fingerprint,source:structuredClone(job.plan),parent_session:structuredClone(parent),...structuredClone(descriptor)};
 return seal({...dispatchKey(job.tenant_id,job.job_id),binding,binding_hash:hash(binding),state:'queued',version:0,reservation_hash:null,execution_id:null,receipt:null});
}
export function validateImportDispatch(row,job){
 checked(row);if(!fields(row,['pk','sk','binding','binding_hash','state','version','reservation_hash','execution_id','receipt','checksum'])||!['queued','running','reconciliation_required','cancelled','complete'].includes(row.state)||!Number.isSafeInteger(row.version)||row.version<0||row.reservation_hash!==null&&!hex(row.reservation_hash)||row.execution_id!==null&&!hex(row.execution_id)||['running','complete'].includes(row.state)&&(!hex(row.execution_id)||!hex(row.reservation_hash))||row.state==='queued'&&(row.execution_id!==null||row.reservation_hash!==null))fail('private_dispatch_record_invalid');
 const b=row.binding;if(!b)fail('private_dispatch_binding_invalid');
 const {schema_version,job_id,tenant_id,project_id,environment_id,fingerprint,source,parent_session,...descriptor}=b;
 const expected=makeImportDispatch(job,parent_session,descriptor);
 if(hash(expected.binding)!==row.binding_hash||hash(b)!==row.binding_hash||row.pk!==expected.pk||row.sk!==expected.sk)fail('private_dispatch_binding_invalid');
 if(row.state==='complete'&&(!row.receipt||row.receipt.job_id!==job.job_id||row.receipt.export_verified!==true))fail('private_dispatch_record_invalid');
 if(row.state!=='complete'&&row.receipt!==null)fail('private_dispatch_record_invalid');return row;
}
export async function loadImportDispatch(ledger,tenant,job){
 const record=await ledger.bounded(()=>ledger.store._get(dispatchKey(tenant,job)));return validateImportDispatch(record,await ledger.load(tenant,job));
}
export async function verifyDispatchSession(ledger,dispatch){
 const b=dispatch.binding,account=await ledger.account(b.tenant_id),stamp=await ledger.bounded(()=>ledger.store.getImportSessionStamp(b.parent_session.token_hash));
 if(account.epoch!==b.parent_session.session_epoch||!stamp||hash(stamp)!==hash(b.parent_session))fail('private_dispatch_session_changed');
}
const registryScope=b=>({tenant_id:b.tenant_id,project_id:b.project_id,origin:b.source.scope.origin,sourceProject:b.source.scope.sourceProject,environment:b.source.scope.environment});
export const importRegistryScope=b=>structuredClone(registryScope(b));
const registryKey=b=>({pk:'PRIVATEIMPORTREGISTRY#'+hash(registryScope(b)),sk:'REGISTRY'});
const overlaps=(a,b)=>compareTimestamps(a.from,b.to)<0&&compareTimestamps(b.from,a.to)<0;
export function validateImportLegacyProof(scope,expectedHash,proof){
 if(!fields(proof,['schema_version','scope','records'])||proof.schema_version!==1||hash(proof.scope)!==hash(scope)||!Array.isArray(proof.records)||proof.records.length>32||hash(proof)!==expectedHash)fail('private_registry_legacy_unverified');
 const ids=new Set();for(const r of proof.records){if(!fields(r,['operation_id','from','to','receipt_hash'])||typeof r.operation_id!=='string'||!/^[-A-Za-z0-9_.:]{1,128}$/.test(r.operation_id)||ids.has(r.operation_id)||!hex(r.receipt_hash)||compareTimestamps(r.from,r.to)!==-1)fail('private_registry_legacy_unverified');ids.add(r.operation_id);}
 return proof;
}
export async function reserveImportDispatch(ledger,dispatch,{legacyProvider,authorize,onBeforeWrite,execution_id}={}){
 dispatch=structuredClone(dispatch);
 const b=dispatch.binding;if(dispatch.state!=='queued'||typeof legacyProvider!=='function'||typeof authorize!=='function'||typeof onBeforeWrite!=='function'||!hex(execution_id)||ledger.store.now()>=b.expires_at)fail('private_dispatch_unavailable');
 await verifyDispatchSession(ledger,dispatch);
 const descriptor={action:'reserve-private-import',binding_hash:dispatch.binding_hash,...structuredClone(b)};
 if(await ledger.bounded(()=>authorize(descriptor))!==true)fail('private_dispatch_not_authorized');
 const proof=validateImportLegacyProof(registryScope(b),b.legacy_snapshot_hash,structuredClone(await ledger.bounded(()=>legacyProvider({scope:registryScope(b),expected_hash:b.legacy_snapshot_hash}))));await verifyDispatchSession(ledger,dispatch);
 const key=registryKey(b),old=await ledger.bounded(()=>ledger.store._get(key)),scope=registryScope(b);
 if(old){checked(old);if(!fields(old,['pk','sk','scope','baseline_hash','version','reservations','checksum'])||old.pk!==key.pk||old.sk!==key.sk||hash(old.scope)!==hash(scope)||old.baseline_hash!==b.legacy_snapshot_hash||!Number.isSafeInteger(old.version)||old.version<0||!Array.isArray(old.reservations)||old.reservations.length>32||old.reservations.some(r=>!fields(r,['job_id','binding_hash','execution_id','from','to'])||!/^ij_[a-f0-9]{64}$/.test(r.job_id??'')||!hex(r.binding_hash)||!hex(r.execution_id)||compareTimestamps(r.from,r.to)!==-1))fail('private_registry_record_invalid');}
 const window={from:b.source.scope.from,to:b.source.scope.to};
 for(const previous of [...proof.records,...(old?.reservations??[])]){
  if(compareTimestamps(previous.from,previous.to)!==-1)fail('private_registry_record_invalid');
  if(overlaps(window,previous))fail('private_registry_overlap_or_legacy_hold');
 }
 if((old?.reservations.length??0)>=32)fail('private_registry_capacity');
 const reservation={job_id:b.job_id,binding_hash:dispatch.binding_hash,execution_id,...window},reservationHash=hash(reservation),registry=seal({...key,scope,baseline_hash:b.legacy_snapshot_hash,version:(old?.version??-1)+1,reservations:[...(old?.reservations??[]),reservation]});
 const next=seal({...withoutSeal(dispatch),state:'running',version:dispatch.version+1,reservation_hash:reservationHash,execution_id});
 const job=await ledger.load(b.tenant_id,b.job_id);if(job.state!=='awaiting_bindings'||job.claim||job.cancel_requested)fail('private_dispatch_job_not_ready');
 if(await ledger.bounded(()=>onBeforeWrite({job_id:b.job_id,binding_hash:dispatch.binding_hash,reservation_hash:reservationHash,execution_id}))!==true)fail('private_dispatch_local_fence_required');
 try{await ledger.bounded(()=>ledger.store._tx([
  ...ledger.parentChecks(),ledger.checkTenant(b.tenant_id,b.parent_session.session_epoch),
  {ConditionCheck:{Key:{pk:job.pk,sk:job.sk},ConditionExpression:'#v = :v AND #s = :s',ExpressionAttributeNames:{'#v':'version','#s':'state'},ExpressionAttributeValues:{':v':job.version,':s':'awaiting_bindings'}}},
  {Put:{Item:registry,ConditionExpression:old?'#v = :v':'attribute_not_exists(pk)',...(old?{ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':v':old.version}}:{})}},
  {Put:{Item:next,ConditionExpression:'#v = :v AND #s = :s AND binding_hash = :h',ExpressionAttributeNames:{'#v':'version','#s':'state'},ExpressionAttributeValues:{':v':dispatch.version,':s':'queued',':h':dispatch.binding_hash}}}
 ]));}catch{fail('private_dispatch_reservation_uncertain');}
 // Independent reads before any claim, lease or source request. No retry after uncertainty.
 const observed=await ledger.bounded(()=>ledger.store._get(key)),record=await loadImportDispatch(ledger,b.tenant_id,b.job_id);
 if(!observed||hash(observed)!==hash(registry)||hash(record)!==hash(next))fail('private_dispatch_reservation_unverified');
 await verifyDispatchSession(ledger,record);return record;
}
function withoutSeal(row){const {checksum,...body}=row;return body;}
export async function verifyImportReservation(ledger,dispatch){
 const current=await loadImportDispatch(ledger,dispatch.binding.tenant_id,dispatch.binding.job_id);await verifyDispatchSession(ledger,current);
 if(current.binding_hash!==dispatch.binding_hash||current.state!=='running'||current.reservation_hash!==dispatch.reservation_hash||current.execution_id!==dispatch.execution_id||ledger.store.now()>=current.binding.expires_at)fail('private_dispatch_inactive');
 const job=await ledger.load(current.binding.tenant_id,current.binding.job_id);if(job.cancel_requested||job.state==='cancelled')fail('private_dispatch_inactive');
 const row=await ledger.bounded(()=>ledger.store._get(registryKey(current.binding)));checked(row);
 if(row.baseline_hash!==current.binding.legacy_snapshot_hash||!row.reservations?.some(r=>hash(r)===current.reservation_hash))fail('private_dispatch_reservation_unverified');return current;
}
export async function settleImportDispatch(ledger,dispatch,receipt=null){
 dispatch=structuredClone(dispatch);receipt=structuredClone(receipt);
 if(receipt){const job=await ledger.load(dispatch.binding.tenant_id,dispatch.binding.job_id),keys=['version','outcome','job_id','project_id','environment_id','fingerprint','manifest_hash','readback_hash','export_sha256','export_bytes','matched_events','matched_runs','unrelated_events','stored_bytes_verified','export_verified','verification_scope','consistency','source_completeness_verified','native_span_semantics_verified','ledger_updated'];if(!fields(receipt,keys)||job.state!=='readback_verified'||receipt.version!==1||receipt.outcome!=='saved-import-export-verified'||receipt.job_id!==job.job_id||receipt.project_id!==job.project_id||receipt.environment_id!=='default'||receipt.fingerprint!==job.fingerprint||receipt.manifest_hash!==job.stage.manifest_hash||receipt.readback_hash!==job.readback_hash||!hex(receipt.export_sha256)||!Number.isSafeInteger(receipt.export_bytes)||receipt.export_bytes<1||receipt.export_bytes>20*1024*1024||receipt.matched_events!==job.stage.batches.reduce((n,b)=>n+b.event_count,0)||receipt.matched_runs!==new Set(job.stage.batches.map(b=>b.run_id)).size||receipt.unrelated_events!==0||receipt.stored_bytes_verified!==true||receipt.export_verified!==true||receipt.verification_scope!=='imported_events_in_explicit_saved_archive'||receipt.consistency!=='verified_import_batches_not_an_account_snapshot'||receipt.source_completeness_verified!==false||receipt.native_span_semantics_verified!==false||receipt.ledger_updated!==false)fail('private_dispatch_receipt_invalid');}
 const next=seal({...withoutSeal(dispatch),state:receipt?'complete':'reconciliation_required',version:dispatch.version+1,receipt});
 try{await ledger.bounded(()=>ledger.store._tx([...ledger.parentChecks(),ledger.checkTenant(dispatch.binding.tenant_id,dispatch.binding.parent_session.session_epoch),{Put:{Item:next,ConditionExpression:'#v = :v AND binding_hash = :h AND execution_id = :e',ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':v':dispatch.version,':h':dispatch.binding_hash,':e':dispatch.execution_id}}}]));}catch{fail('private_dispatch_settlement_uncertain');}
 const observed=await loadImportDispatch(ledger,dispatch.binding.tenant_id,dispatch.binding.job_id);if(hash(observed)!==hash(next))fail('private_dispatch_settlement_unverified');return observed;
}
