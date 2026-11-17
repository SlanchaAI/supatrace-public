import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, chmodSync, symlinkSync, linkSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createPrivateBraintrustJobs} from '../src/importers/private-braintrust-jobs.mjs';
import {runPrivateBraintrustImport} from '../src/importers/private-braintrust-runtime.mjs';
import {alphaProject} from '../src/alpha-projects.mjs';
import {BRAINTRUST_TRANSPORT_BOUNDS} from '../src/importers/braintrust-transport.mjs';
import {spec, row, key, marker, fakeOptions} from './braintrust-fixtures.mjs';
const owner = {tenantId: 'github-4242', projectId: alphaProject('github-4242').id};
const scope = {...spec, destinationProject: owner.projectId};
const request = 'synthetic_request_1234';
function fixture(pages = [], options = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'private-import-job-')), directory = join(parent, 'jobs');
  const fake = fakeOptions(pages);
  const config = {...fake.options, directory, ...options};
  return {parent, directory, fake, config, jobs: createPrivateBraintrustJobs(config), close() {rmSync(parent, {recursive: true, force: true});}};
}
function disk(directory) { return readdirSync(directory, {withFileTypes: true}).map(e => e.isDirectory() ? disk(join(directory, e.name)) : readFileSync(join(directory, e.name), 'utf8')).join('\n'); }

test('finite job uses actual capture/stage, exposes progress, persists no secret/content and replay sends nothing', async () => {
  const f = fixture([{data: {data: [row()], cursor: 'next'}}, {data: {data: [row('child')]}}]);
  try {
    const created = await f.jobs.create(owner, scope, request);
    assert.equal(created.status, 'queued'); assert.equal(f.fake.requests.length, 0);
    assert.deepEqual(await f.jobs.create(owner, scope, request), created);
    await assert.rejects(f.jobs.create(owner, {...scope, namespace: 'changed'}, request), /request_conflict/);
    const result = await f.jobs.execute(owner, created.jobId);
    assert.equal(result.status, 'staged'); assert.equal(result.batches, 2); assert.deepEqual(result.progress, {pages: 2, rows: 2, requests: 4});
    const artifact = await f.jobs.stagedArtifact(owner, result.jobId);
    assert.equal(artifact.receipt.fingerprint.length, 64); assert.equal(artifact.receipt.uploaded, false);
    const reopened = createPrivateBraintrustJobs({...f.config, credentialProvider: async () => {throw Error(key);}, fetchImpl: async () => {throw Error('must not fetch');}});
    assert.equal((await reopened.execute(owner, result.jobId)).status, 'staged');
    assert.equal(f.fake.requests.length, 4); assert.equal(statSync(join(f.directory, result.jobId, 'job.json')).mode & 0o777, 0o600);
    assert.doesNotMatch(disk(f.directory), new RegExp(key + '|' + marker));
    assert.ok(f.fake.permissions.every(p => p.owner.tenantId === owner.tenantId && p.owner.projectId === owner.projectId && (p.action === 'create-job' || p.fingerprint === artifact.receipt.fingerprint)));
    assert.doesNotMatch(JSON.stringify(result), /sourceProject|rootSpanIds|directory|apiKey/);
  } finally {f.close();}
});

test('known read interruption resumes saved cursor after worker recreation and preserves execution bounds', async () => {
  const f = fixture([{data: {data: [row()], cursor: 'next'}}, Error(key)]);
  try {
    const {jobId} = await f.jobs.create(owner, scope, request);
    const paused = await f.jobs.execute(owner, jobId); assert.equal(paused.status, 'paused'); assert.equal(paused.progress.pages, 1);
    const second = fakeOptions([{data: {data: [row('child')]}}]);
    const restarted = createPrivateBraintrustJobs({...f.config, ...second.options});
    const result = await restarted.execute(owner, jobId); assert.equal(result.status, 'staged'); assert.equal(result.attempts, 2);
    assert.match(second.requests.at(-1).init.body, /cursor: 'next'/); assert.equal(result.progress.requests, 6);
    const altered = createPrivateBraintrustJobs({...f.config, maxAttempts: 1});
    await assert.rejects(altered.execute(owner, jobId), /execution_binding_changed/);
    assert.doesNotMatch(disk(f.directory), new RegExp(key + '|' + marker));
  } finally {f.close();}
});

test('queued cancellation is durable across restart and never requests a source lease', async () => {
  const f = fixture();
  try {
    const {jobId} = await f.jobs.create(owner, scope, request);
    assert.equal((await f.jobs.cancel(owner, jobId)).status, 'cancellation_requested');
    const reopened = createPrivateBraintrustJobs(f.config);
    assert.equal((await reopened.execute(owner, jobId)).status, 'cancelled');
    assert.equal((await reopened.cancel(owner, jobId)).status, 'cancelled'); assert.equal(f.fake.requests.length, 0);
    assert.equal(statSync(join(f.directory, jobId, 'cancel.json')).mode & 0o777, 0o600);
  } finally {f.close();}
});

test('cancellation aborts an in-flight source request and commits no stage receipt', async () => {
  let ready, wireSignal; const entered = new Promise(r => ready = r);
  const f = fixture([], {fetchImpl: async (_, init) => {wireSignal = init.signal; ready(); return new Promise(() => {});}});
  try {
    const {jobId} = await f.jobs.create(owner, scope, request), running = f.jobs.execute(owner, jobId);
    await entered; assert.equal((await f.jobs.status(owner, jobId)).status, 'running');
    await f.jobs.cancel(owner, jobId); const result = await running;
    assert.equal(result.status, 'cancelled'); assert.equal(wireSignal.aborted, true);
    assert.throws(() => readFileSync(join(f.directory, jobId, 'workspace', 'stage-receipt.json')));
  } finally {f.close();}
});

test('cross-process cancellation marker stops a different runner without taking over its lock', async () => {
  let ready; const entered = new Promise(r => ready = r);
  const f = fixture([], {fetchImpl: async () => {ready(); return new Promise(() => {});}});
  try {
    const {jobId} = await f.jobs.create(owner, scope, request), pending = f.jobs.execute(owner, jobId); await entered;
    await createPrivateBraintrustJobs(f.config).cancel(owner, jobId);
    assert.equal((await pending).status, 'cancelled');
  } finally {f.close();}
});

test('cancel during stage authorization records cancelled, while failure after authorization needs reconciliation', async () => {
  for (const afterAuthorization of [false, true]) {
    let jobs, id;
    const fake = fakeOptions([{data: {data: [row()]}}]);
    const f = fixture([], {...fake.options, authorize: async descriptor => {
      if (descriptor.action === 'stage-destination') {
        if (!afterAuthorization) await jobs.cancel(owner, id);
      }
      return true;
    }});
    jobs = f.jobs;
    try {
      ({jobId: id} = await jobs.create(owner, scope, request));
      if (afterAuthorization) {
        // The retained stager must not overwrite an existing unknown artifact.
        const original = f.config.authorize;
        jobs = createPrivateBraintrustJobs({...f.config, authorize: async descriptor => {
          const allowed = await original(descriptor);
          if (descriptor.action === 'stage-destination') {
            const workspace = join(f.directory, id, 'workspace');
            writeFileSync(join(workspace, 'binding.json.tmp'), '{}', {mode: 0o600});
          }
          return allowed;
        }});
      }
      const result = await jobs.execute(owner, id);
      assert.equal(result.status, afterAuthorization ? 'reconciliation_required' : 'cancelled');
      assert.equal(result.uploaded, false);
      const restart = await jobs.execute(owner, id); assert.equal(restart.status, result.status);
    } finally {f.close();}
  }
});

test('foreign tenant/project, traversal and unknown jobs fail before source or control authorization', async () => {
  let controls = 0; const f = fixture([], {authorize: async () => {controls++; return true;}});
  try {
    const {jobId} = await f.jobs.create(owner, scope, request); controls = 0;
    const foreign = {tenantId: 'github-4243', projectId: alphaProject('github-4243').id};
    for (const method of ['status', 'cancel', 'execute', 'stagedArtifact']) {
      await assert.rejects(f.jobs[method](foreign, jobId), /not_found/);
      await assert.rejects(f.jobs[method]({...owner, projectId: foreign.projectId}, jobId), /project_unavailable/);
      await assert.rejects(f.jobs[method](owner, '../job.json'), /not_found/);
    }
    assert.equal(controls, 0); assert.equal(f.fake.requests.length, 0);
    await assert.rejects(f.jobs.create(owner, {...scope, content: 'include'}, request), /scope_invalid/);
    await assert.rejects(f.jobs.create(owner, {...scope, apiKey: key}, request));
  } finally {f.close();}
});

for (const damage of ['checksum', 'duplicate-key', 'oversize', 'permissions', 'symlink', 'stale-temp', 'hardlink']) test('damaged ' + damage + ' journal fails closed before broker access', async () => {
  const f = fixture();
  try {
    const {jobId} = await f.jobs.create(owner, scope, request), directory = join(f.directory, jobId), path = join(directory, 'job.json');
    if (damage === 'checksum') { const value = JSON.parse(readFileSync(path)); value.attempts = 2; writeFileSync(path, JSON.stringify(value)); }
    if (damage === 'duplicate-key') {const value = readFileSync(path, 'utf8'); writeFileSync(path, value.replace('{', '{"version":1,'));}
    if (damage === 'oversize') writeFileSync(path, 'x'.repeat(65537));
    if (damage === 'permissions') chmodSync(path, 0o644);
    if (damage === 'symlink') {rmSync(path); symlinkSync('/does-not-exist', path);}
    if (damage === 'stale-temp') symlinkSync('/does-not-exist', path + '.tmp');
    if (damage === 'hardlink') linkSync(path, join(directory, 'linked.json'));
    await assert.rejects(f.jobs.execute(owner, jobId)); assert.equal(f.fake.requests.length, 0);
  } finally {f.close();}
});

test('explicit bounds, no-default hooks, finite capacity and total attempts fail closed', async () => {
  for (const options of [{}, {directory: '/tmp/no-write', fetchImpl: async () => {}, credentialProvider: async () => {}, authorize: async () => true}]) assert.throws(() => createPrivateBraintrustJobs(options), /explicit_runtime/);
  const f = fixture([Error(key)], {maxJobs: 1, maxAttempts: 1});
  try {
    const {jobId} = await f.jobs.create(owner, scope, request);
    await assert.rejects(f.jobs.create(owner, scope, request + '2'), /capacity/);
    assert.equal((await f.jobs.execute(owner, jobId)).status, 'paused');
    assert.equal((await f.jobs.execute(owner, jobId)).status, 'exhausted');
    assert.equal(f.fake.requests.length, 2);
  } finally {f.close();}
});

test('source authorization denial and invalid/expired/coerced broker leases never expose keys or stage', async () => {
  const leases = [key, {origin: scope.origin, projectId: spec.sourceProject, apiKey: key, expiresAt: Infinity},
    {origin: scope.origin, projectId: spec.sourceProject, apiKey: key, expiresAt: String(Date.now() + 60000)},
    {origin: scope.origin, projectId: spec.sourceProject, apiKey: key, expiresAt: Date.now() - 1},
    {origin: scope.origin, projectId: spec.sourceProject, apiKey: key, expiresAt: Date.now() + 600000}];
  for (const lease of leases) {
    const f = fixture([], {credentialProvider: async () => lease});
    try {const {jobId} = await f.jobs.create(owner, scope, request); assert.equal((await f.jobs.execute(owner, jobId)).status, 'paused'); assert.equal(f.fake.requests.length, 0); assert.doesNotMatch(disk(f.directory), new RegExp(key));}
    finally {f.close();}
  }
  const f = fixture([], {authorize: async d => d.action !== 'verify-source-project'});
  try {const {jobId} = await f.jobs.create(owner, scope, request); assert.equal((await f.jobs.execute(owner, jobId)).status, 'paused'); assert.equal(f.fake.requests.length, 0);}
  finally {f.close();}
});

test('job lifetime aborts stalled network; expired queued jobs do not retrieve credentials', async t => {
  const f = fixture([], {totalTimeoutMs: 100, fetchImpl: async () => new Promise(() => {})});
  try {const {jobId} = await f.jobs.create(owner, scope, request); const result = await f.jobs.execute(owner, jobId); assert.equal(result.status, 'expired');}
  finally {f.close();}
  const g = fixture();
  try {const {jobId} = await g.jobs.create(owner, scope, request); const time = Date.now();t.mock.method(Date, 'now', () => time + 400000);assert.equal((await g.jobs.execute(owner, jobId)).status, 'expired');assert.equal(g.fake.requests.length, 0);}
  finally {g.close();}
});

test('a run that uses up the job lifetime is expired whichever timer fires first, and a request timeout inside the lifetime is paused', async t => {
  // #198: the wall clock is held at creation time, so it never reaches expiresAt and cannot rescue the outcome. The
  // run's total budget is the job's remaining lifetime; running out of it is expiry, whether the run's own timer or
  // the job's lifetime timer notices first.
  const f = fixture([], {totalTimeoutMs: 100, fetchImpl: async () => new Promise(() => {})});
  try {const {jobId} = await f.jobs.create(owner, scope, request); const time = Date.now(); const clock = t.mock.method(Date, 'now', () => time); const result = await f.jobs.execute(owner, jobId); clock.mock.restore(); assert.equal(result.status, 'expired'); assert.equal(result.resumeAvailable, false);}
  finally {f.close();}
  const g = fixture([], {bounds: {...BRAINTRUST_TRANSPORT_BOUNDS, requestTimeoutMs: 20}, fetchImpl: async () => new Promise(() => {})});
  try {const {jobId} = await g.jobs.create(owner, scope, request); const result = await g.jobs.execute(owner, jobId); assert.equal(result.status, 'paused'); assert.equal(result.resumeAvailable, true);}
  finally {g.close();}
});

test('control authorization is bounded and a late allow cannot create a job', async () => {
  let release;
  const f = fixture([], {bounds: {...BRAINTRUST_TRANSPORT_BOUNDS, requestTimeoutMs: 10}, authorize: async () => new Promise(r => release = r)});
  try {await assert.rejects(f.jobs.create(owner, scope, request), /authorization_unavailable/);release(true);await new Promise(r => setImmediate(r));assert.throws(() => readdirSync(f.directory));}
  finally {f.close();}
});

test('hard worker death preserves checkpoint/progress and stale locks forbid automatic resume', async () => {
  const f = fixture(); let child;
  try {
    const {jobId} = await f.jobs.create(owner, scope, request);
    child = spawn(process.execPath, [new URL('private-braintrust-job-crash.mjs', import.meta.url).pathname, f.directory, jobId], {stdio: ['ignore', 'pipe', 'pipe']});
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('child did not reach checkpoint')), 10000);
      child.stdout.once('data', () => {clearTimeout(timer);resolve();}); child.once('error', reject);child.once('exit', code => {if (code !== null && code !== 0) reject(Error('child failed'));});
    });
    await new Promise(resolve => {child.once('exit', resolve);child.kill('SIGKILL');}); child = null;
    const reopened = createPrivateBraintrustJobs(f.config), status = await reopened.status(owner, jobId);
    assert.equal(status.status, 'running');assert.equal(status.progress.pages, 1);assert.equal(status.exclusion, 'active_or_interrupted_no_automatic_takeover');
    await assert.rejects(reopened.execute(owner, jobId), /locked_reconciliation_required/);
    assert.equal(f.fake.requests.length, 0);assert.equal(JSON.parse(readFileSync(join(f.directory, jobId, 'workspace', 'checkpoint.json'))).pages.length, 1);
    assert.equal((await reopened.cancel(owner, jobId)).status, 'cancellation_requested');
  } finally {child?.kill('SIGKILL');f.close();}
});

for (const cancel of [false, true]) test('stalled runtime progress observer is bounded by ' + (cancel ? 'cancellation' : 'deadline'), async () => {
  const f = fixture(), fake = fakeOptions([{data: {data: [row()]}}]);
  let ready, observedSignal; const entered = new Promise(r => ready = r), controller = new AbortController();
  try {
    const pending = runPrivateBraintrustImport(scope, {...fake.options, directory: join(f.parent, 'observer'), signal: controller.signal,
      bounds: {...BRAINTRUST_TRANSPORT_BOUNDS, requestTimeoutMs: 40},
      onProgress: async (_, control) => {observedSignal = control.signal;ready();return new Promise(() => {});},
    });
    const rejected = assert.rejects(pending, cancel ? /cancelled/ : /operation_timeout/);
    await entered; if (cancel) controller.abort(); await rejected;
    assert.equal(observedSignal.aborted, true);assert.equal(fake.requests.length, 2);
    assert.throws(() => readFileSync(join(f.parent, 'observer', 'stage-receipt.json')));
    assert.equal(JSON.parse(readFileSync(join(f.parent, 'observer', 'checkpoint.json'))).complete, true);
  } finally {f.close();}
});

test('cancelled stalled broker cannot use a later delivered lease', async () => {
  let release, ready;const entered = new Promise(r => ready = r);
  const f = fixture([], {credentialProvider: async () => {ready();return new Promise(r => release = r);}});
  try {
    const {jobId} = await f.jobs.create(owner, scope, request), pending = f.jobs.execute(owner, jobId);await entered;
    await f.jobs.cancel(owner, jobId);assert.equal((await pending).status, 'cancelled');
    release({origin: scope.origin, projectId: scope.sourceProject, apiKey: key, expiresAt: Date.now() + 60000});
    await new Promise(r => setImmediate(r));assert.equal(f.fake.requests.length, 0);assert.doesNotMatch(disk(f.directory), new RegExp(key));
  } finally {f.close();}
});

test('denied create/execute cannot start a workspace or retrieve credentials', async () => {
  const f = fixture([], {authorize: async () => false});
  try {await assert.rejects(f.jobs.create(owner, scope, request), /action_not_authorized/);assert.throws(() => readdirSync(f.directory));}
  finally {f.close();}
  const g = fixture([], {authorize: async action => action.action !== 'execute-job'});
  try {const {jobId} = await g.jobs.create(owner, scope, request);await assert.rejects(g.jobs.execute(owner, jobId), /action_not_authorized/);assert.equal((await g.jobs.status(owner, jobId)).attempts, 0);assert.equal(g.fake.requests.length, 0);}
  finally {g.close();}
});

test('worker restart and per-wire guard preserve global-fetch TLS validation despite wrapper', async () => {
  const f = fixture([{data: {data: [row()]}}]);
  const originalFetch = globalThis.fetch, originalTLS = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  let wire = 0;
  try {
    const {jobId} = await f.jobs.create(owner, scope, request);
    // Negative configuration fixture only: the global fetch here is a local mock.
    globalThis.fetch = async (...args) => {wire++;return f.config.fetchImpl(...args);};
    const restarted = createPrivateBraintrustJobs({...f.config, fetchImpl: globalThis.fetch});
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    await assert.rejects(restarted.execute(owner, jobId), /tls_validation_disabled/);assert.equal(wire, 0);
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';
    const changedDuringRun = createPrivateBraintrustJobs({...f.config, fetchImpl: globalThis.fetch, authorize: async action => {
      if (action.action === 'verify-source-project') process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      return true;
    }});
    assert.equal((await changedDuringRun.execute(owner, jobId)).status, 'paused');assert.equal(wire, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTLS === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalTLS;
    f.close();
  }
});
