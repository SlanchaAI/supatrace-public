import {readImportAssignment,matchImportAssignment,consumeImportAssignment,holdImportAssignment,completeImportAssignment,releaseImportAssignment} from './private-import-assignment.mjs';
// Private, dependency-injected service composition. No routes, discovery, credentials or defaults.
import {createPrivateImportHost} from './private-import-host.mjs';
import {ImportJobLedger} from './import-job-ledger.mjs';
import {loadImportDispatch, verifyDispatchSession, LANGFUSE_HOST_FIELDS} from './private-import-dispatch.mjs';
import {validatePrivateImportApproval} from './private-import-approval.mjs';
import {hash} from './trace.mjs';
import {HttpError} from './http.mjs';

const errors = new WeakMap();
const fail = code => {
  const error = new HttpError(409, 'private_launcher_' + code);
  errors.set(error, code);
  throw error;
};
// Preserve only categories created by this module, never an adapter's message/code/cause.
const operation = callback => async (...args) => {
  try { return await callback(...args); }
  catch (error) { fail(errors.get(error) ?? 'operation_stopped'); }
};
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fields = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).sort().join() === keys.slice().sort().join();
const same = (a, b) => hash(a) === hash(b);
function snapshot(value) {
  try {
    const copy = structuredClone(value);
    if (Buffer.byteLength(JSON.stringify(copy)) > 65536) fail('input_invalid');
    return copy;
  } catch { fail('input_invalid'); }
}
const actions = new Set(['queue-private-import', 'reserve-private-import', 'inspect-private-import',
  'cancel-private-import', 'download-private-import', 'claim-source-stage', 'runtime-action',
  'source-lease', 'source-wire', 'consume-once-upload', 'upload-approved-batch',
  'upload-approved-batch-wire', 'destination-write-lease', 'reconcile-import-batch',
  'export-import-batch', 'save-imported-export', 'verify-saved-import-export',
  'consume-private-import-assignment','complete-private-import-assignment','release-private-import-assignment']);

function services(options) {
  if (!fields(options, ['hostOptions', 'approvalProvider', 'authorize', 'leaseProvider']) ||
      ['approvalProvider', 'authorize', 'leaseProvider'].some(k => typeof options[k] !== 'function')) fail('dependencies_required');
  const {approvalProvider, authorize, leaseProvider} = options;
  const hostOptions = {...options.hostOptions, runtime: snapshot(options.hostOptions?.runtime)};
  if (!fields(hostOptions, ['store', 'objects', 'directory', 'runtime', 'legacyProvider', 'sourceFetch', 'destinationFetch', 'readiness'])) fail('dependencies_required');
  const ledger = new ImportJobLedger(hostOptions.store, {objects: hostOptions.objects});


  // Adapter errors may include credentials. Never propagate their message or cause.
  async function external(callback, input) {
    try { return await ledger.bounded(() => callback(input)); }
    catch { fail('adapter_unavailable'); }
  }
  function validate(record,id) {
    try { return validatePrivateImportApproval(record,id,{runtime:hostOptions.runtime,now:hostOptions.store.now()}); }
    catch { fail('approval_invalid'); }
  }

  async function approved(id) {
    const value = snapshot(await external(approvalProvider, {approval_id: id}));
    const result = validate(value, id);
    await verifyDispatchSession(ledger, {binding: {tenant_id: value.tenant_id, parent_session: value.parent_session}});
    return result;
  }
  function checkBinding(binding, approval) {
    const {record: r, plan, descriptor} = approval;
    if (!binding || binding.schema_version !== 1 || binding.tenant_id !== r.tenant_id ||
        binding.project_id !== r.project_id || binding.environment_id !== r.environment_id ||
        binding.fingerprint !== r.fingerprint || !same(binding.source, plan) ||
        !same(binding.parent_session, r.parent_session) ||
        Object.keys(descriptor).some(k => binding[k] !== descriptor[k])) fail('binding_mismatch');
  }
  async function permit(value) {
    const d = snapshot(value);
    if (!actions.has(d.action)) fail('action_refused');
    const binding = d.binding ?? (d.action === 'reserve-private-import' ? d : null);
    const id = d.action === 'queue-private-import' ? d.descriptor?.approval_hash : binding?.approval_hash;
    const approval = await approved(id);
    if (d.action === 'queue-private-import') {
      const r = approval.record;
      if (d.tenant_id !== r.tenant_id || !same(d.parent_session, r.parent_session) ||
          !same(d.plan, r.plan) || d.fingerprint !== r.fingerprint ||
          !same(d.descriptor, approval.descriptor) || d.fields !== LANGFUSE_HOST_FIELDS) fail('binding_mismatch');
    } else checkBinding(binding, approval);
    const allowed = await external(authorize, {approval_id: id, descriptor: d});
    await approved(id); // Revocation/session changes during the policy await fail closed.
    return allowed === true;
  }
  async function broker(side, value) {
    const {binding, request} = snapshot(value), id = binding?.approval_hash;
    const approval = await approved(id);
    checkBinding(binding, approval);
    const deadline = side === 'source' ? request?.expiresAt : request?.expires_at;
    if (!Number.isSafeInteger(deadline) || deadline <= (side === 'source' ? Date.now() : hostOptions.store.now())) fail('lease_request_invalid');
    const bindingHash = hash(binding), bindingId = binding[side === 'source' ? 'source_binding' : 'destination_binding'];
    const envelope = snapshot(await external(leaseProvider, snapshot({side, approval_id: id,
      binding_id: bindingId, binding_hash: bindingHash, binding, request})));
    await approved(id);
    if (!fields(envelope, ['approval_id', 'binding_id', 'binding_hash', 'lease']) ||
        envelope.approval_id !== id || envelope.binding_id !== bindingId || envelope.binding_hash !== bindingHash) fail('lease_binding_mismatch');
    const lease = envelope.lease, scope = approval.plan.scope, now = Date.now();
    if (side === 'source') {
      if (!fields(lease, ['origin', 'projectId', 'traceId', 'publicKey', 'secretKey', 'expiresAt']) ||
          lease.origin !== scope.origin || lease.projectId !== scope.sourceProject || lease.traceId !== scope.traceId ||
          typeof lease.publicKey !== 'string' || !/^[A-Za-z0-9_-]{8,256}$/.test(lease.publicKey) ||
          typeof lease.secretKey !== 'string' || !/^[A-Za-z0-9_-]{8,512}$/.test(lease.secretKey) ||
          !Number.isSafeInteger(lease.expiresAt) || lease.expiresAt <= now ||
          lease.expiresAt > Math.min(now + 300000, request.expiresAt, binding.expires_at * 1000)) fail('lease_invalid');
    } else if (!fields(lease, ['origin', 'project_id', 'write_key', 'expires_at']) ||
        lease.origin !== binding.destination_origin || lease.project_id !== binding.project_id ||
        typeof lease.write_key !== 'string' || !/^[-A-Za-z0-9_]{43}$/.test(lease.write_key) ||
        !Number.isSafeInteger(lease.expires_at) || lease.expires_at * 1000 <= now ||
        lease.expires_at > Math.min(Math.floor(now / 1000) + 300, request.expires_at, binding.expires_at)) fail('lease_invalid');
    return lease;
  }
  const host = createPrivateImportHost({...hostOptions, authorize: permit,
    sourceBroker: value => broker('source', value), destinationBroker: value => broker('destination', value)});

  return {host,approved,checkBinding,external,permit};
}
// Called only by the private process for an explicitly assigned durable dispatch.
// Not an HTTP endpoint, queue scanner or authentication default.
export function createPrivateImportWorker(options) {
  const {host,approved,checkBinding,permit}=services(options),runtime=snapshot(options.hostOptions.runtime);
  const ledger=new ImportJobLedger(options.hostOptions.store,{objects:options.hostOptions.objects});
  const executeAssigned=operation(async input=>{
    const d=snapshot(input);
    if(!fields(d,['tenant_id','job_id'])||typeof d.tenant_id!=='string'||!/^ij_[a-f0-9]{64}$/.test(d.job_id??''))fail('input_invalid');
    const dispatch=await loadImportDispatch(ledger,d.tenant_id,d.job_id),approval=await approved(dispatch.binding.approval_hash);
    checkBinding(dispatch.binding,approval);
    const result=await host.runOne(d.tenant_id,d.job_id);
    await approved(dispatch.binding.approval_hash);
    return {job_id:d.job_id,outcome:result.outcome,receipt:result.receipt,upload_acknowledged:result.upload_acknowledged,hosted:false};
  });
  const runAssigned=operation(async input=>{
    const d=snapshot(input);
    if(!fields(d,['tenant_id','job_id'])||typeof d.tenant_id!=='string'||!/^ij_[a-f0-9]{64}$/.test(d.job_id??''))fail('input_invalid');
    const dispatch=await loadImportDispatch(ledger,d.tenant_id,d.job_id),slot=await readImportAssignment(ledger,dispatch.binding.worker_id);
    if(slot?.assignment.job_id===d.job_id)fail('assignment_consumption_required');
    return executeAssigned(d);
  });
  async function assignment(slot,action){
    const dispatch=await matchImportAssignment(ledger,slot,runtime),approval=await approved(slot.assignment.approval_id);
    checkBinding(dispatch.binding,approval);
    if(await permit({action,binding:dispatch.binding,binding_hash:dispatch.binding_hash,assignment_hash:slot.assignment_hash,attempt_id:slot.attempt_id})!==true)fail('action_refused');
    return dispatch;
  }
  return Object.freeze({runAssigned,
    runNext:operation(async()=>{
      const slot=await readImportAssignment(ledger,runtime.worker_id);
      if(!slot||slot.state==='released')return {outcome:'idle',hosted:false};
      if(slot.state!=='pending')fail('assignment_held');
      await assignment(slot,'consume-private-import-assignment');
      await host.preflight();
      const consumed=await consumeImportAssignment(ledger,slot);
      try{
        await approved(consumed.assignment.approval_id);
        const result=await executeAssigned({tenant_id:consumed.assignment.tenant_id,job_id:consumed.assignment.job_id});
        await assignment(consumed,'complete-private-import-assignment');
        await host.preflight();
        await completeImportAssignment(ledger,consumed,result.receipt);
        await approved(consumed.assignment.approval_id);
        return {...result,assignment_state:'complete'};
      }catch(error){try{await holdImportAssignment(ledger,consumed);}catch{/* Unknown outcome/completion remains fenced; never overwrite it. */}throw error;}
    }),
    releaseCompleted:operation(async()=>{
      const slot=await readImportAssignment(ledger,runtime.worker_id);
      if(!slot||slot.state!=='complete')fail('completion_required');
      await assignment(slot,'release-private-import-assignment');
      await host.preflight();
      const released=await releaseImportAssignment(ledger,slot);
      await approved(slot.assignment.approval_id);
      return {job_id:released.assignment.job_id,assignment_state:released.state,receipt_hash:released.receipt_hash};
    })
  });
}

export function createPrivateImportLauncher(options) {
  if(!fields(options,['hostOptions','authenticate','approvalProvider','authorize','leaseProvider'])||typeof options.authenticate!=='function')fail('dependencies_required');
  const {authenticate,...dependencies}=options;
  const {host,approved,checkBinding,external}=services(dependencies);
  const ledger=new ImportJobLedger(dependencies.hostOptions.store,{objects:dependencies.hostOptions.objects});

  async function ingress(request, input, keys) {
    const data = snapshot(input);
    if (!fields(data, keys) || !hex(data.approval_id)) fail('input_invalid');
    // Identity comes exclusively from the injected trusted authenticator, never input/body fields.
    const identity = snapshot(await external(authenticate, request));
    if (!fields(identity, ['tenant_id', 'parent_session'])) fail('authentication_required');
    const approval = await approved(data.approval_id);
    if (identity.tenant_id !== approval.record.tenant_id ||
        !same(identity.parent_session, approval.record.parent_session)) fail('original_session_required');
    return {data, approval};
  }
  async function existing(request, input) {
    const context = await ingress(request, input, ['approval_id', 'job_id']);
    if (!/^ij_[a-f0-9]{64}$/.test(context.data.job_id ?? '')) fail('input_invalid');
    const dispatch = await loadImportDispatch(ledger, context.approval.record.tenant_id, context.data.job_id);
    checkBinding(dispatch.binding, context.approval);
    return context;
  }
  return Object.freeze({
    queue: operation(async (request, input) => {
      const {data, approval} = await ingress(request, input, ['approval_id', 'plan', 'fingerprint']);
      if (!same(data.plan, approval.record.plan) || data.fingerprint !== approval.record.fingerprint) fail('binding_mismatch');
      const result = await host.submit({tenant: approval.record.tenant_id, parentSession: approval.record.parent_session,
        plan: approval.record.plan, fingerprint: data.fingerprint, descriptor: approval.descriptor});
      await approved(data.approval_id);
      return result;
    }),
    runOne: operation(async (request, input) => {
      const {data, approval} = await existing(request, input);
      const slot=await readImportAssignment(ledger,approval.descriptor.worker_id);
      if(slot?.assignment.job_id===data.job_id)fail('assignment_consumption_required');
      const result = await host.runOne(approval.record.tenant_id, data.job_id);
      await approved(data.approval_id);
      return {job_id: data.job_id, outcome: result.outcome, receipt: result.receipt,
        upload_acknowledged: result.upload_acknowledged, hosted: false};
    }),
    status: operation(async (request, input) => {
      const {data, approval} = await existing(request, input);
      const result = await host.status(approval.record.tenant_id, data.job_id);
      await approved(data.approval_id);
      return result;
    }),
    cancel: operation(async (request, input) => {
      const {data, approval} = await existing(request, input);
      const result = await host.cancel(approval.record.tenant_id, data.job_id);
      await approved(data.approval_id);
      return result;
    }),
    download: operation(async (request, input) => {
      const {data, approval} = await existing(request, input);
      const result = await host.download(approval.record.tenant_id, data.job_id);
      await approved(data.approval_id);
      return result;
    })
  });
}
