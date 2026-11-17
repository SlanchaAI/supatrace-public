import {privateHostFixture} from './private-host-fixture.mjs';
import {planCustomerImport} from '../src/import-planning.mjs';
import {alphaProject} from '../src/alpha-projects.mjs';
import {hash} from '../src/trace.mjs';
import {createPrivateImportLauncher} from '../src/private-import-launcher.mjs';

export async function privateLauncherFixture() {
  const f = await privateHostFixture();
  f.plan.traceId = 'synthetic-trace';
  f.sourceRows.push({...f.sourceRows[0], id: 'child', parentObservationId: 'root'});
  const project = alphaProject(f.submit.tenant).id;
  const {authorize, sourceBroker, destinationBroker, ...hostOptions} = f.options;
  const approvals = new Map(), request = Object.freeze({transport: 'synthetic-authenticated-request'});
  let identity = {tenant_id: f.submit.tenant, parent_session: f.parentSession};
  function bind() {
    const {approval_hash, ...descriptor} = f.descriptor;
    const record = {schema_version: 1, tenant_id: f.submit.tenant, parent_session: structuredClone(f.parentSession),
      project_id: project, environment_id: 'default', plan: structuredClone(f.plan),
      fingerprint: planCustomerImport(f.plan, project).plan.fingerprint, descriptor: structuredClone(descriptor)};
    const id = hash(record); approvals.set(id, record);
    return {approval_id: id, plan: structuredClone(f.plan), fingerprint: record.fingerprint};
  }
  const input = bind(), calls = [];
  const options = {hostOptions, authenticate: async incoming => incoming === request ? structuredClone(identity) : null,
    approvalProvider: async ({approval_id}) => structuredClone(approvals.get(approval_id) ?? null),
    authorize: async ({approval_id, descriptor}) => {
      calls.push({approval_id, descriptor});
      return descriptor.action === 'download-private-import' || await authorize(descriptor);
    },
    leaseProvider: async d => ({approval_id: d.approval_id, binding_id: d.binding_id, binding_hash: d.binding_hash,
      lease: d.side === 'source' ? {...await sourceBroker(d), traceId: f.plan.traceId} : await destinationBroker(d)})};
  return {...f, options, hostOptions, input, approvals, request, calls, bind,
    setIdentity: value => { identity = value; },
    launcher: () => createPrivateImportLauncher(options),
    jobInput: job => ({approval_id: input.approval_id, job_id: job.job_id})};
}
