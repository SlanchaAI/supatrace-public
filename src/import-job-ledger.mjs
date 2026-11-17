// Durable control-plane records only. No queue poller, credentials or provider I/O.
import {HttpError} from './http.mjs';
import {alphaProject} from './alpha-projects.mjs';
import {planCustomerImport} from './import-planning.mjs';
import {hash} from './importers/langfuse.mjs';
import {parseBatch} from './trace.mjs';
import {normalizeTimestamp} from './importers/timestamps.mjs';
import {createHash} from 'node:crypto';
import {makeImportDispatch,loadImportDispatch} from './private-import-dispatch.mjs';
const fail = (status, code) => {throw new HttpError(status, code);};
const plain = v => v && Object.getPrototypeOf(v) === Object.prototype;
const hex = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const id = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const fields = (v, keys) => plain(v) && Object.keys(v).sort().join() === [...keys].sort().join();
const clone = v => structuredClone(v);
const pk = tenant => 'TENANT#' + (alphaProject(tenant), tenant);
const key = (tenant, job) => ({pk: pk(tenant), sk: 'IMPORTJOB#' + job});
const states = new Set(['awaiting_bindings','claimed','staged','upload_consumed','cancellation_requested','cancelled','reconciliation_required','readback_verified']);
const conditional = e => e?.name === 'ConditionalCheckFailedException' || e?.name === 'TransactionCanceledException' && e.CancellationReasons?.some(r => r.Code === 'ConditionalCheckFailed');
function instant(value) {
  if(normalizeTimestamp(value)===null)fail(400,'invalid_import_window');
  const fraction=(/\.(\d+)(?=Z|[+-]\d{2}:\d{2}$)/.exec(value)?.[1]??'').replace(/0+$/,'');
  return {wholeSecond:Date.parse(value.replace(/\.\d+(?=Z|[+-]\d{2}:\d{2}$)/,'')),fraction};
}
function operation(tenant, plan) {
  const s = plan.scope;
  // Deliberately excludes request IDs, namespace, limits, code revision and recaptured manifest.
  return 'ij_' + hash({tenant, destination: s.destinationProject, provider: 'langfuse', origin: s.origin,
    sourceProject: s.sourceProject, environment: s.environment, from: instant(s.from), to: instant(s.to)});
}
function planOf(tenant, input) {
  const plan = planCustomerImport(input, alphaProject(tenant).id).plan;
  if (plan.scope.maxRows > 100 || plan.scope.maxPages > 10 || plan.scope.pageSize > 50 || plan.scope.maxBytes > 2097152 || plan.scope.maxRetries > 1) fail(400,'import_job_bounds_exceeded');
  return plan;
}
function validateStage(row, input) {
  if (!fields(input, ['receipt','manifest','batches'])) fail(400,'import_stage_invalid');
  const r = input.receipt, m = input.manifest;
  if (!fields(r,['destinationProject','fingerprint','conversionHash','batches','manifestHash','persistence','uploaded']) ||
      r.destinationProject !== row.project_id || r.fingerprint !== row.fingerprint || !hex(r.conversionHash) || !hex(r.manifestHash) ||
      r.uploaded !== false || r.persistence !== 'local-files-verified-no-fsync-guarantee' ||
      !fields(m,['version','mode','batches','count','notes']) || m.version !== 1 || m.mode !== 'stage-only-no-network' ||
      !Array.isArray(m.batches) || !Number.isInteger(m.count) || m.count < 1 || m.count > row.plan.scope.maxRows || m.count !== m.batches.length || r.batches !== m.count || hash(m) !== r.manifestHash ||
      !Array.isArray(input.batches) || input.batches.length !== m.count) fail(400,'import_stage_invalid');
  const seen = new Set(); let bytes = 0;
  for (let i=0;i<input.batches.length;i++) {
    const b = input.batches[i], p = m.batches[i];
    if (!fields(b,['batch_id','request_hash','run_id','byte_count','event_count']) || !id(b.batch_id) || !id(b.run_id) || !hex(b.request_hash) ||
        !Number.isInteger(b.byte_count) || b.byte_count < 1 || b.byte_count > 524288 || b.event_count !== 1 || seen.has(b.batch_id) ||
        !fields(p,['batch_id','request_hash','pending_file']) || p.batch_id !== b.batch_id || p.request_hash !== b.request_hash || p.pending_file !== b.request_hash+'.json') fail(400,'import_stage_invalid');
    seen.add(b.batch_id); bytes += b.byte_count;
  }
  if (bytes > 2097152 || Buffer.byteLength(JSON.stringify(input)) > 131072) fail(400,'import_stage_bound');
  // Never persist source rows, arbitrary notes or filesystem paths.
  return {conversion_hash:r.conversionHash,manifest_hash:r.manifestHash,batches:clone(input.batches),bytes};
}

export class ImportJobLedger {
  constructor(metadata, {objects, timeoutMs=2000, parentSession=null}={}) {
    if (['_get','_tx','getTenant'].some(k=>typeof metadata?.[k] !== 'function') || typeof metadata.now !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2000) fail(503,'import_job_store_unavailable');
    if(parentSession!==null&&(!fields(parentSession,['token_hash','tenant_id','session_epoch'])||!hex(parentSession.token_hash)||!Number.isSafeInteger(parentSession.session_epoch)||parentSession.session_epoch<0||typeof metadata.importSessionCheck!=='function'))fail(401,'sign_in_required');
    this.store=metadata;this.objects=objects;this.timeoutMs=timeoutMs;this.parentSession=clone(parentSession);
  }
  async bounded(fn) {let timer;try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new HttpError(503,'import_job_outcome_uncertain')),this.timeoutMs);})]);}finally{clearTimeout(timer);}}
  async account(tenant) {
    const a=await this.bounded(()=>this.store.getTenant(tenant));const epoch=a?.session_epoch??0;
    if (!a || a.tenant_id!==tenant || !Number.isSafeInteger(epoch) || epoch<0||this.parentSession&&(this.parentSession.tenant_id!==tenant||this.parentSession.session_epoch!==epoch)) fail(409,'import_job_account_changed');return {row:a,epoch};
  }
  checkTenant(tenant, epoch) {return {ConditionCheck:{Key:{pk:pk(tenant),sk:'META'},ConditionExpression:'attribute_exists(pk) AND '+(epoch===0?'(attribute_not_exists(session_epoch) OR session_epoch = :epoch)':'session_epoch = :epoch'),ExpressionAttributeValues:{':epoch':epoch}}};}
  async load(tenant, job) {
    if(typeof job!=='string'||!/^ij_[a-f0-9]{64}$/.test(job))fail(404,'import_job_not_found');
    const row=await this.bounded(()=>this.store._get(key(tenant,job)));if(!row)fail(404,'import_job_not_found');
    let plan;try{const {destinationProject,...scope}=row.plan.scope;plan=planOf(tenant,{provider:'langfuse',...scope});}catch{fail(503,'import_job_record_invalid');}
    if(!fields(row,['pk','sk','schema_version','job_id','tenant_id','project_id','plan','fingerprint','session_epoch','version','state','created_at','cancel_requested','pages','rows','claim','stage','upload','verified_batches','readback_hash'])||row.schema_version!==1||row.pk!==pk(tenant)||row.sk!=='IMPORTJOB#'+job||row.tenant_id!==tenant||row.project_id!==alphaProject(tenant).id||row.job_id!==job||operation(tenant,plan)!==job||hash(row.plan)!==hash(plan)||row.fingerprint!==plan.fingerprint||!states.has(row.state)||!Number.isSafeInteger(row.version)||row.version<0||!Number.isSafeInteger(row.session_epoch)||row.session_epoch<0)fail(503,'import_job_record_invalid');
    if(typeof row.cancel_requested!=='boolean'||![row.created_at,row.pages,row.rows,row.verified_batches].every(n=>Number.isSafeInteger(n)&&n>=0)||row.pages>plan.scope.maxPages||row.rows>plan.scope.maxRows||!hex(row.readback_hash))fail(503,'import_job_record_invalid');
    if(row.claim!==null&&(!fields(row.claim,['worker_id','revision','source_binding','destination_binding','approval_hash','expires_at'])||['worker_id','source_binding','destination_binding','approval_hash'].some(k=>!hex(row.claim[k]))||!/^[a-f0-9]{40}$/.test(row.claim.revision??'')||!Number.isSafeInteger(row.claim.expires_at)))fail(503,'import_job_record_invalid');
    if(row.stage!==null){const a=row.stage;if(!fields(a,['conversion_hash','manifest_hash','batches','bytes'])||!hex(a.conversion_hash)||!hex(a.manifest_hash)||!Array.isArray(a.batches)||a.batches.length<1||a.batches.length>plan.scope.maxRows||!Number.isInteger(a.bytes)||a.bytes>2097152||a.bytes<1||a.batches.some(b=>!fields(b,['batch_id','request_hash','run_id','byte_count','event_count'])||!id(b.batch_id)||!id(b.run_id)||!hex(b.request_hash)||!Number.isInteger(b.byte_count)||b.byte_count<1||b.byte_count>524288||b.event_count!==1)||new Set(a.batches.map(b=>b.batch_id)).size!==a.batches.length||a.batches.reduce((n,b)=>n+b.byte_count,0)!==a.bytes)fail(503,'import_job_record_invalid');}
    if(row.upload!==null&&(!row.stage||!row.claim||!fields(row.upload,['version','operation_id','descriptor_hash','state','claim_hash'])||row.upload.version!==1||row.upload.operation_id!==job||row.upload.state!=='consumed'||!hex(row.upload.descriptor_hash)||row.upload.claim_hash!==hash(row.claim)))fail(503,'import_job_record_invalid');
    if(row.verified_batches>(row.stage?.batches.length??0)||row.verified_batches>0&&!row.upload||row.state==='readback_verified'&&(!row.upload||row.verified_batches!==row.stage?.batches.length)||['claimed','staged','upload_consumed','cancellation_requested','readback_verified'].includes(row.state)&&!row.claim||row.state==='staged'&&!row.stage||row.state==='upload_consumed'&&!row.upload)fail(503,'import_job_record_invalid');
    return row;
  }
  view(row) {return {job_id:row.job_id,project_id:row.project_id,fingerprint:row.fingerprint,status:row.state,version:row.version,cancel_requested:row.cancel_requested,
    progress:{pages:row.pages,rows:row.rows,staged_batches:row.stage?.batches.length??0,readback_batches:row.verified_batches},
    execution_available:false,source_access_authorized:false,upload_authorized:false,stored_bytes_verified:row.state==='readback_verified',export_verified:false};}
  parentChecks(){return this.parentSession?[this.store.importSessionCheck(this.parentSession)]:[];}
  async replace(row, next, epoch=row.session_epoch) {
    next={...next,version:row.version+1};
    try{await this.bounded(()=>this.store._tx([...this.parentChecks(),this.checkTenant(row.tenant_id,epoch),{Put:{Item:next,ConditionExpression:'#v = :version AND fingerprint = :fingerprint',ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':version':row.version,':fingerprint':row.fingerprint}}}])) ;}
    catch(e){if(conditional(e))fail(409,'import_job_changed');fail(503,'import_job_outcome_uncertain');}
    return next;
  }
  async create(tenant, input, fingerprint, dispatchDescriptor=null) {
    if(dispatchDescriptor!==null){try{dispatchDescriptor=clone(dispatchDescriptor);}catch{fail(400,'private_dispatch_binding_invalid');}}
    const plan=planOf(tenant,input);if(!hex(fingerprint)||fingerprint!==plan.fingerprint)fail(400,'import_job_fingerprint_mismatch');
    const job=operation(tenant,plan),existing=await this.bounded(()=>this.store._get(key(tenant,job)));
    if(existing){const row=await this.load(tenant,job);if(row.fingerprint!==fingerprint)fail(409,'import_job_scope_conflict');if(dispatchDescriptor!==null){const expected=makeImportDispatch(row,this.parentSession,dispatchDescriptor),actual=await loadImportDispatch(this,tenant,job);if(expected.binding_hash!==actual.binding_hash)fail(409,'private_dispatch_original_binding_required');}return this.view(row);}
    const {epoch}=await this.account(tenant),row={...key(tenant,job),schema_version:1,job_id:job,tenant_id:tenant,project_id:alphaProject(tenant).id,plan,fingerprint,session_epoch:epoch,version:0,state:'awaiting_bindings',created_at:this.store.now(),cancel_requested:false,pages:0,rows:0,claim:null,stage:null,upload:null,verified_batches:0,readback_hash:hash([])};
    const dispatch=dispatchDescriptor===null?null:makeImportDispatch(row,this.parentSession,dispatchDescriptor);
    try {await this.bounded(()=>this.store._tx([...this.parentChecks(),this.checkTenant(tenant,epoch),{Put:{Item:row,ConditionExpression:'attribute_not_exists(pk)'}},...(dispatch?[{Put:{Item:dispatch,ConditionExpression:'attribute_not_exists(pk)'}}]:[]),{Update:{Key:{pk:pk(tenant),sk:'IMPORTJOB_CAPACITY'},UpdateExpression:'ADD #n :one',ConditionExpression:'attribute_not_exists(#n) OR #n < :cap',ExpressionAttributeNames:{'#n':'count'},ExpressionAttributeValues:{':one':1,':cap':32}}}])) ;}
    catch(e){if(conditional(e)){const old=await this.bounded(()=>this.store._get(key(tenant,job)));if(old){const value=await this.load(tenant,job);if(value.fingerprint!==fingerprint)fail(409,'import_job_scope_conflict');if(dispatch){const observed=await loadImportDispatch(this,tenant,job);if(observed.binding_hash!==dispatch.binding_hash)fail(409,'private_dispatch_original_binding_required');}return this.view(value);}fail(409,'import_job_capacity_or_account_changed');}fail(503,'import_job_outcome_uncertain');}
    if(dispatch){const observed=await loadImportDispatch(this,tenant,job);if(observed.binding_hash!==dispatch.binding_hash)fail(503,'private_dispatch_creation_unverified');}
    return this.view(row);
  }
  async status(tenant,job) {return this.view(await this.load(tenant,job));}
  async cancel(tenant,job) {
    const row=await this.load(tenant,job);if(['cancelled','readback_verified'].includes(row.state))return this.view(row);
    // A repeated cancel cannot settle a live claim the worker still holds; only stop() or claim expiry may.
    if(row.state==='cancellation_requested'&&row.claim.expires_at>this.store.now())return this.view(row);
    const {epoch}=await this.account(tenant);
    const state=row.upload?'reconciliation_required':row.state==='claimed'?'cancellation_requested':'cancelled';
    return this.view(await this.replace(row,{...row,cancel_requested:true,state},epoch));
  }
  async claim(tenant,job,authority,{authorize,checkExistingOperation}={}) {
    const row=await this.load(tenant,job);
    if(!fields(authority,['worker_id','revision','source_binding','destination_binding','approval_hash','expires_at'])||!hex(authority.worker_id)||!/^[a-f0-9]{40}$/.test(authority.revision??'')||!hex(authority.source_binding)||!hex(authority.destination_binding)||!hex(authority.approval_hash)||!Number.isSafeInteger(authority.expires_at)||authority.expires_at<=this.store.now()||authority.expires_at>this.store.now()+300||typeof authorize!=='function'||typeof checkExistingOperation!=='function')fail(403,'import_job_authority_required');
    authority=clone(authority);
    const d={operation_id:job,tenant_id:tenant,project_id:row.project_id,plan:clone(row.plan),authority};
    if(await this.bounded(()=>checkExistingOperation(clone(d)))!==true)fail(409,'import_job_existing_operation_unverified');
    if(await this.bounded(()=>authorize({...clone(d),action:'claim-source-stage'}))!==true)fail(403,'import_job_not_authorized');
    if(authority.expires_at<=this.store.now())fail(403,'import_job_authorization_expired');
    if(row.state!=='awaiting_bindings'||row.claim||row.cancel_requested)fail(409,'import_job_already_claimed');
    const next=await this.replace(row,{...row,state:'claimed',claim:authority});
    const receipt={job_id:job,fingerprint:row.fingerprint,claim_hash:hash(authority)};
    if(!await this.verifyClaim(tenant,receipt))fail(503,'import_job_claim_unverified');
    return {created:true,receipt,scope:clone(next.plan.scope)};
  }
  async active(tenant,receipt,phases=['claimed','staged','upload_consumed']) {
    if(!fields(receipt,['job_id','fingerprint','claim_hash'])||!hex(receipt.fingerprint)||!hex(receipt.claim_hash))fail(409,'import_job_claim_inactive');
    const row=await this.load(tenant,receipt.job_id),account=await this.account(tenant);
    if(row.fingerprint!==receipt.fingerprint||!row.claim||hash(row.claim)!==receipt.claim_hash||row.claim.expires_at<=this.store.now()||row.session_epoch!==account.epoch||row.cancel_requested||!phases.includes(row.state))fail(409,'import_job_claim_inactive');
    return row;
  }
  async verifyClaim(tenant,receipt,phases) {
    try{await this.active(tenant,receipt,phases);return true;}catch(e){if(e.status===409||e.status===404)return false;throw e;}
  }
  async progress(tenant,receipt,{pages,rows}) {
    const row=await this.active(tenant,receipt,['claimed']);
    if(!Number.isInteger(pages)||!Number.isInteger(rows)||pages<row.pages||rows<row.rows||pages>row.plan.scope.maxPages||rows>row.plan.scope.maxRows)fail(400,'import_job_progress_invalid');
    await this.replace(row,{...row,pages,rows});
  }
  async staged(tenant,receipt,input) {
    const row=await this.active(tenant,receipt,['claimed']),stage=validateStage(row,input);
    const next=await this.replace(row,{...row,state:'staged',stage});return this.view(next);
  }
  async consumeUpload(tenant,receipt,{authorize}={}) {
    const row=await this.active(tenant,receipt,['staged']);if(typeof authorize!=='function')fail(403,'import_job_upload_authority_required');
    const descriptor={operation_id:row.job_id,tenant_id:tenant,project_id:row.project_id,fingerprint:row.fingerprint,claim_hash:receipt.claim_hash,conversion_hash:row.stage.conversion_hash,manifest_hash:row.stage.manifest_hash,batches:clone(row.stage.batches),expires_at:row.claim.expires_at,revision:row.claim.revision};
    if(await this.bounded(()=>authorize({action:'consume-once-upload',...clone(descriptor)}))!==true)fail(403,'import_job_not_authorized');
    if(!await this.verifyClaim(tenant,receipt,['staged']))fail(409,'import_job_claim_inactive');
    const upload={version:1,operation_id:row.job_id,descriptor_hash:hash(descriptor),state:'consumed',claim_hash:receipt.claim_hash};
    await this.replace(row,{...row,state:'upload_consumed',upload});
    if(!await this.verifyUpload(tenant,receipt,upload))fail(503,'import_job_consumption_unverified');
    return {created:true,receipt:upload,descriptor};
  }
  async verifyUpload(tenant,claim,upload) {
    let row;try{row=await this.active(tenant,claim,['upload_consumed']);}catch(e){if(e.status===409||e.status===404)return false;throw e;}
    return fields(upload,['version','operation_id','descriptor_hash','state','claim_hash'])&&hash(row.upload)===hash(upload);
  }
  async stop(tenant,receipt) {
    const row=await this.load(tenant,receipt.job_id);
    if(row.fingerprint!==receipt.fingerprint||!row.claim||hash(row.claim)!==receipt.claim_hash||['cancelled','readback_verified'].includes(row.state))return this.view(row);
    const {epoch}=await this.account(tenant);return this.view(await this.replace(row,{...row,state:row.cancel_requested&&!row.upload?'cancelled':'reconciliation_required'},epoch));
  }
  async reconcileNext(tenant,job) {
    const row=await this.load(tenant,job);if(row.state==='readback_verified')return this.view(row);
    if(!row.upload||!row.stage||!['upload_consumed','reconciliation_required'].includes(row.state))fail(409,'import_job_not_consumed');
    const b=row.stage.batches[row.verified_batches];if(!b||typeof this.objects?.get!=='function')fail(503,'import_job_readback_unavailable');
    const actual=await this.bounded(()=>this.store._get({pk:pk(tenant),sk:'BATCH#'+b.batch_id}));
    if(!actual||actual.status!=='accepted')fail(409,'import_job_readback_pending');
    if(actual.tenant_id!==tenant||actual.batch_id!==b.batch_id||actual.object_key!=='v1/'+createHash('sha256').update(tenant).digest('hex')+'/'+b.request_hash+'.json'||actual.request_hash!==b.request_hash||actual.run_id!==b.run_id||actual.event_count!==b.event_count||actual.byte_count!==b.byte_count||typeof actual.object_key!=='string')fail(409,'import_job_readback_mismatch');
    const raw=await this.bounded(()=>this.objects.get(actual.object_key));
    if(typeof raw!=='string'||Buffer.byteLength(raw)!==b.byte_count||createHash('sha256').update(raw).digest('hex')!==b.request_hash)fail(409,'import_job_readback_mismatch');
    let batch;try{batch=parseBatch(raw).batch;}catch{fail(409,'import_job_readback_mismatch');}
    if(batch.batch_id!==b.batch_id||batch.run_id!==b.run_id||batch.events.length!==b.event_count)fail(409,'import_job_readback_mismatch');
    const {epoch}=await this.account(tenant),verified=row.verified_batches+1;
    return this.view(await this.replace(row,{...row,verified_batches:verified,readback_hash:hash({prior:row.readback_hash,batch_id:b.batch_id,request_hash:b.request_hash}),state:verified===row.stage.batches.length?'readback_verified':row.state},epoch));
  }
}
