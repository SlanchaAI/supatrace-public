import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {privateLauncherFixture} from './private-launcher-fixture.mjs';
import {createPrivateImportLauncher} from '../src/private-import-launcher.mjs';
import {digest} from '../src/dynamodb-store.mjs';
import {hash} from '../src/trace.mjs';

test('trusted launcher queues protected dispatch and runs actual Node/Python import through saved export', async () => {
  const f = await privateLauncherFixture();
  try {
    const launcher = f.launcher(), job = await launcher.queue(f.request, f.input), input = f.jobInput(job);
    assert.equal((await launcher.status(f.request, input)).dispatch.state, 'queued');
    const result = await launcher.runOne(f.request, input);
    assert.equal(result.outcome, 'import-export-verified');
    assert.equal(result.receipt.export_verified, true);
    assert.equal(result.receipt.matched_events, 2);
    const bytes = await launcher.download(f.request, input), archive = JSON.parse(bytes);
    assert.deepEqual(archive.runs[0].events.map(e => e.data.observation.id).sort(), ['child', 'root']);
    assert.equal(archive.runs[0].events.find(e => e.data.observation.id === 'child').data.observation.parentObservationId, 'root');
    assert.ok(archive.runs[0].events.every(e => e.data.observation.traceId === f.plan.traceId));
    assert.equal((await launcher.status(f.request, input)).dispatch.export_verified, true);
    assert.equal(result.exportPath, undefined);
    await assert.rejects(launcher.runOne(f.request, input), /private_launcher_operation_stopped/);
    const metadata = JSON.stringify([...f.client.items.values()]);
    assert.equal(metadata.includes(f.key), false);
    assert.equal(metadata.includes('synthetic-secret-key'), false);
    assert.equal(readFileSync(join(f.directory, job.job_id, 'completion.json'), 'utf8').includes(f.key), false);
    assert.deepEqual(f.counts(), {sourceRequests: 2, destinationRequests: 2, leases: 2});
  } finally { f.close(); }
});

test('composition requires every trusted adapter and has no live fallback', async () => {
  const f = await privateLauncherFixture();
  try {
    for (const key of ['authenticate', 'approvalProvider', 'authorize', 'leaseProvider']) {
      const options = {...f.options}; delete options[key];
      assert.throws(() => createPrivateImportLauncher(options), /dependencies_required/);
    }
    assert.throws(() => createPrivateImportLauncher({...f.options, live: true}), /dependencies_required/);
    assert.deepEqual(f.counts(), {sourceRequests: 0, destinationRequests: 0, leases: 0});
  } finally { f.close(); }
});

test('caller cannot supply identity, descriptor, credentials or an approval document', async () => {
  const f = await privateLauncherFixture();
  try {
    const launcher = f.launcher();
    for (const key of ['parentSession', 'tenant', 'descriptor', 'approval', 'write_key'])
      await assert.rejects(launcher.queue(f.request, {...f.input, [key]: 'forged'}), /input_invalid/);
    assert.equal(f.client.items.size > 0, true);
    assert.equal([...f.client.items.values()].some(r => r.sk.startsWith('IMPORTJOB#')), false);
  } finally { f.close(); }
});

for (const identity of ['missing', 'foreign', 'same-account-new-session']) test('authentication refuses ' + identity, async () => {
  const f = await privateLauncherFixture();
  try {
    if (identity === 'foreign') f.setIdentity({tenant_id: 'github-999', parent_session: f.parentSession});
    if (identity === 'same-account-new-session') {
      await f.store.createSession(digest('synthetic-other-session'), f.submit.tenant);
      f.setIdentity({tenant_id: f.submit.tenant, parent_session: await f.store.getImportSessionStamp(digest('synthetic-other-session'))});
    }
    await assert.rejects(f.launcher().queue(identity === 'missing' ? {} : f.request, f.input), /authentication_required|original_session_required/);
    assert.equal([...f.client.items.values()].some(r => r.sk.startsWith('IMPORTJOB#')), false);
    assert.deepEqual(f.counts(), {sourceRequests: 0, destinationRequests: 0, leases: 0});
  } finally { f.close(); }
});

for (const change of ['unknown', 'mutated', 'expired', 'unselected', 'wrong-project']) test('protected approval rejects ' + change, async () => {
  const f = await privateLauncherFixture();
  try {
    let input = f.input;
    if (change === 'unknown') f.approvals.clear();
    if (change === 'mutated') f.approvals.get(input.approval_id).plan.traceId = 'foreign';
    if (change === 'expired') { f.descriptor.expires_at = f.store.now() - 1; input = f.bind(); }
    if (change === 'unselected') { delete f.plan.traceId; input = f.bind(); }
    if (change === 'wrong-project') {
      const record = f.approvals.get(input.approval_id); record.project_id = 'proj_' + '0'.repeat(32);
      const id = hash(record); f.approvals.set(id, record); input = {...input, approval_id: id};
    }
    await assert.rejects(f.launcher().queue(f.request, input), /approval_invalid/);
    assert.equal([...f.client.items.values()].some(r => r.sk.startsWith('IMPORTJOB#')), false);
  } finally { f.close(); }
});

test('changed untrusted plan or fingerprint never reaches job creation', async () => {
  const f = await privateLauncherFixture();
  try {
    const launcher = f.launcher();
    await assert.rejects(launcher.queue(f.request, {...f.input, plan: {...f.plan, traceId: 'other'}}), /binding_mismatch/);
    await assert.rejects(launcher.queue(f.request, {...f.input, fingerprint: '0'.repeat(64)}), /binding_mismatch/);
  } finally { f.close(); }
});

for (const boundary of ['policy', 'source-lease', 'destination-lease']) test('revocation during ' + boundary + ' wait prevents subsequent wire', async () => {
  const f = await privateLauncherFixture(); let revoked = false;
  try {
    const policy = f.options.authorize, provider = f.options.leaseProvider;
    f.options.authorize = async d => {
      const result = await policy(d);
      if (boundary === 'policy' && d.descriptor.action === 'source-wire') { f.approvals.clear(); revoked = true; }
      return result;
    };
    f.options.leaseProvider = async d => {
      const result = await provider(d);
      if (boundary === d.side + '-lease') { f.approvals.clear(); revoked = true; }
      return result;
    };
    const launcher = f.launcher(), job = await launcher.queue(f.request, f.input);
    await assert.rejects(launcher.runOne(f.request, f.jobInput(job)));
    assert.equal(revoked, true);
    assert.equal(f.counts().destinationRequests, 0);
    if (boundary !== 'destination-lease') assert.equal(f.counts().sourceRequests, 0);
    assert.equal(existsSync(join(f.directory, '.private-host.lock')), true);
  } finally { f.close(); }
});

for (const mutation of ['binding', 'approval', 'trace', 'expiry', 'extra-secret']) test('broker refuses source lease ' + mutation, async () => {
  const f = await privateLauncherFixture();
  try {
    const provider = f.options.leaseProvider;
    f.options.leaseProvider = async d => {
      const e = await provider(d);
      if (mutation === 'binding') e.binding_hash = '0'.repeat(64);
      if (mutation === 'approval') e.approval_id = '0'.repeat(64);
      if (mutation === 'trace') e.lease.traceId = 'foreign-trace';
      if (mutation === 'expiry') e.lease.expiresAt = Date.now() + 3600000;
      if (mutation === 'extra-secret') e.lease.extra = 'forbidden-secret';
      return e;
    };
    const launcher = f.launcher(), job = await launcher.queue(f.request, f.input);
    await assert.rejects(launcher.runOne(f.request, f.jobInput(job)));
    assert.deepEqual(f.counts(), {sourceRequests: 0, destinationRequests: 0, leases: 0});
  } finally { f.close(); }
});

test('adapter errors are redacted before they leave the composition', async () => {
  const f = await privateLauncherFixture();
  try {
    f.options.approvalProvider = async () => { throw Error('credential-DO-NOT-EXPOSE'); };
    await assert.rejects(f.launcher().queue(f.request, f.input), error => {
      assert.equal(error.code, 'private_launcher_adapter_unavailable');
      assert.equal(String(error).includes('DO-NOT-EXPOSE'), false);
      assert.equal(error.cause, undefined); return true;
    });
  } finally { f.close(); }
});

test('cancellation and same-job retry preserve the original durable no-replay controls', async () => {
  const f = await privateLauncherFixture();
  try {
    const launcher = f.launcher(), job = await launcher.queue(f.request, f.input), input = f.jobInput(job);
    assert.equal((await launcher.cancel(f.request, input)).status, 'cancelled');
    await assert.rejects(launcher.runOne(f.request, input));
    assert.deepEqual(f.counts(), {sourceRequests: 0, destinationRequests: 0, leases: 0});
  } finally { f.close(); }
});

for (const mutation of ['binding-id', 'project', 'origin', 'expiry']) test('broker refuses destination lease ' + mutation, async () => {
  const f = await privateLauncherFixture();
  try {
    const provider = f.options.leaseProvider;
    f.options.leaseProvider = async d => {
      const e = await provider(d);
      if (d.side === 'destination') {
        if (mutation === 'binding-id') e.binding_id = '0'.repeat(64);
        if (mutation === 'project') e.lease.project_id = 'proj_' + '0'.repeat(32);
        if (mutation === 'origin') e.lease.origin = 'https://unapproved.invalid';
        if (mutation === 'expiry') e.lease.expires_at = f.store.now() + 3600;
      }
      return e;
    };
    const launcher = f.launcher(), job = await launcher.queue(f.request, f.input);
    await assert.rejects(launcher.runOne(f.request, f.jobInput(job)));
    assert.equal(f.counts().sourceRequests, 2);
    assert.equal(f.counts().destinationRequests, 0);
  } finally { f.close(); }
});

test('approval for another trace/job cannot read, run, cancel or download the original dispatch', async () => {
  const f = await privateLauncherFixture();
  try {
    const launcher = f.launcher(), job = await launcher.queue(f.request, f.input);
    f.plan.traceId = 'another-trace'; f.plan.namespace = 'another-job';
    const changed = f.bind(), input = {approval_id: changed.approval_id, job_id: job.job_id};
    for (const operation of ['runOne', 'status', 'cancel', 'download'])
      await assert.rejects(launcher[operation](f.request, input), /binding_mismatch/);
    assert.deepEqual(f.counts(), {sourceRequests: 0, destinationRequests: 0, leases: 0});
  } finally { f.close(); }
});

test('original session removed during broker wait fences the run before source transport', async () => {
  const f = await privateLauncherFixture();
  try {
    const provider = f.options.leaseProvider;
    f.options.leaseProvider = async d => { const value = await provider(d); await f.store.deleteSession(digest(f.token)); return value; };
    const launcher = f.launcher(), job = await launcher.queue(f.request, f.input);
    await assert.rejects(launcher.runOne(f.request, f.jobInput(job)));
    assert.equal(existsSync(join(f.directory, '.private-host.lock')), true);
    assert.deepEqual(f.counts(), {sourceRequests: 0, destinationRequests: 0, leases: 0});
  } finally { f.close(); }
});

test('caller mutation during authentication cannot change the queued scope', async () => {
  const f = await privateLauncherFixture();
  try {
    const authenticate = f.options.authenticate;
    f.options.authenticate = async request => { f.input.plan.traceId = 'mutated'; return authenticate(request); };
    const launcher = f.launcher(), job = await launcher.queue(f.request, f.input);
    const record = [...f.client.items.values()].find(r => r.sk === 'IMPORTDISPATCH#' + job.job_id);
    assert.equal(record.binding.source.scope.traceId, 'synthetic-trace');
  } finally { f.close(); }
});

test('lost destination acknowledgment reconciles storage without resending an accepted batch', async () => {
  const f = await privateLauncherFixture();
  try {
    // One row makes the first uncertain send the entire bounded manifest.
    f.sourceRows.pop();
    const send = f.hostOptions.destinationFetch;
    f.hostOptions.destinationFetch = async (...args) => { await send(...args); throw Error('synthetic lost ACK'); };
    const launcher = f.launcher(), job = await launcher.queue(f.request, f.input);
    const result = await launcher.runOne(f.request, f.jobInput(job));
    assert.equal(result.upload_acknowledged, false);
    assert.equal(result.receipt.export_verified, true);
    assert.equal(f.counts().destinationRequests, 1);
    await assert.rejects(launcher.runOne(f.request, f.jobInput(job)), /private_launcher_operation_stopped/);
    assert.equal(f.counts().destinationRequests, 1);
  } finally { f.close(); }
});

test('broker cannot mutate retained request/dispatch to extend the approved lease deadline', async () => {
  const f = await privateLauncherFixture();
  try {
    f.descriptor.expires_at = f.store.now() + 45;
    const input = f.bind(), provider = f.options.leaseProvider;
    f.options.leaseProvider = async d => {
      const envelope = await provider(d);
      d.binding.expires_at = f.store.now() + 300;
      d.request.expiresAt = Date.now() + 300000;
      envelope.lease.expiresAt = Date.now() + 60000;
      return envelope;
    };
    const launcher = f.launcher(), job = await launcher.queue(f.request, input);
    await assert.rejects(launcher.runOne(f.request, {approval_id: input.approval_id, job_id: job.job_id}));
    assert.deepEqual(f.counts(), {sourceRequests: 0, destinationRequests: 0, leases: 0});
  } finally { f.close(); }
});

test('approval revoked during final status store read prevents releasing metadata', async () => {
  const f = await privateLauncherFixture();
  try {
    let armed = false, revoked = false;
    const authorize = f.options.authorize, get = f.store._get.bind(f.store);
    f.options.authorize = async d => { const result = await authorize(d); if (d.descriptor.action === 'inspect-private-import') armed = true; return result; };
    f.store._get = async key => { const result = await get(key); if (armed && key.sk.startsWith('IMPORTJOB#')) { f.approvals.clear(); revoked = true; } return result; };
    const launcher = f.launcher(), job = await launcher.queue(f.request, f.input);
    await assert.rejects(launcher.status(f.request, f.jobInput(job)), /approval_invalid/);
    assert.equal(revoked, true);
  } finally { f.close(); }
});

test('revocation after cancellation commit suppresses response and retains cancelled record', async () => {
  const f = await privateLauncherFixture();
  try {
    const tx = f.store._tx.bind(f.store);
    f.store._tx = async items => { const result = await tx(items); if (items.some(i => i.Put?.Item.state === 'cancelled')) f.approvals.clear(); return result; };
    const launcher = f.launcher(), job = await launcher.queue(f.request, f.input);
    await assert.rejects(launcher.cancel(f.request, f.jobInput(job)), /approval_invalid/);
    assert.equal([...f.client.items.values()].find(r => r.sk === 'IMPORTJOB#' + job.job_id).state, 'cancelled');
    assert.deepEqual(f.counts(), {sourceRequests: 0, destinationRequests: 0, leases: 0});
  } finally { f.close(); }
});

test('revocation after completion commit suppresses response without replaying or deleting completion', async () => {
  const f = await privateLauncherFixture();
  try {
    f.sourceRows.pop();
    const tx = f.store._tx.bind(f.store);
    f.store._tx = async items => { const result = await tx(items); if (items.some(i => i.Put?.Item.state === 'complete')) f.approvals.clear(); return result; };
    const launcher = f.launcher(), job = await launcher.queue(f.request, f.input);
    await assert.rejects(launcher.runOne(f.request, f.jobInput(job)), /approval_invalid/);
    assert.equal([...f.client.items.values()].find(r => r.sk === 'IMPORTDISPATCH#' + job.job_id).state, 'complete');
    assert.equal(existsSync(join(f.directory, job.job_id, 'completion.json')), true);
    assert.equal(f.counts().destinationRequests, 1);
  } finally { f.close(); }
});

test('readiness adapter diagnostics and forged internal-looking codes cannot leave the service', async () => {
  const f = await privateLauncherFixture();
  try {
    f.hostOptions.readiness = async () => { throw Object.assign(new Error('SYNTHETIC_ADAPTER_SECRET', {cause: 'SYNTHETIC_ADAPTER_SECRET'}), {code: 'private_launcher_approval_invalid'}); };
    await assert.rejects(f.launcher().queue(f.request, f.input), error => {
      assert.equal(error.code, 'private_launcher_operation_stopped');
      assert.equal(String(error).includes('SYNTHETIC_ADAPTER_SECRET'), false);
      assert.equal(error.cause, undefined); return true;
    });
    assert.deepEqual(f.counts(), {sourceRequests: 0, destinationRequests: 0, leases: 0});
  } finally { f.close(); }
});

for (const operation of ['runOne', 'status', 'cancel', 'download']) test(operation + ' redacts unexpected host-store errors', async () => {
  const f = await privateLauncherFixture();
  try {
    const launcher = f.launcher(), job = await launcher.queue(f.request, f.input), get = f.store._get.bind(f.store);
    f.store._get = async key => { if (key.sk.startsWith('IMPORTDISPATCH#')) throw Error('SYNTHETIC_STORE_SECRET', {cause: 'SYNTHETIC_STORE_SECRET'}); return get(key); };
    await assert.rejects(launcher[operation](f.request, f.jobInput(job)), error => {
      assert.equal(error.code, 'private_launcher_operation_stopped');
      assert.equal(String(error).includes('SYNTHETIC_STORE_SECRET'), false);
      assert.equal(error.cause, undefined); return true;
    });
    assert.deepEqual(f.counts(), {sourceRequests: 0, destinationRequests: 0, leases: 0});
  } finally { f.close(); }
});
