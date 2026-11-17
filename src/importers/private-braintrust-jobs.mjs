// Trusted worker composition only: no HTTP route, daemon, credential discovery or upload.
import {constants, openSync, closeSync, fstatSync, lstatSync, mkdirSync, readdirSync,
  readSync, writeFileSync, renameSync, fsyncSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {requireAlphaProject} from '../alpha-projects.mjs';
import {canonical, hash} from './langfuse.mjs';
import {planBraintrustCapture} from './braintrust-capture.mjs';
import {createBraintrustTransport} from './braintrust-transport.mjs';
import {runPrivateBraintrustImport} from './private-braintrust-runtime.mjs';
import {acquireWorkspaceLock, WORKSPACE_LOCK} from './private-workspace-lock.mjs';

const fail = code => { throw Error(code); };
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const encode = value => JSON.stringify(canonical(value));
const JOB = /^job_[a-f0-9]{64}$/;
function pathExists(path) { try { lstatSync(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; fail('private_job_state_unavailable'); } }
const terminal = new Set(['staged', 'cancelled', 'expired', 'exhausted', 'reconciliation_required']);
const keys = ['version', 'jobId', 'owner', 'requestId', 'plan', 'createdAt', 'expiresAt',
  'state', 'phase', 'attempts', 'progress', 'receipt', 'execution', 'checksum'].sort().join();

function ownerBinding(owner) {
  if (!plain(owner) || Object.keys(owner).sort().join() !== 'projectId,tenantId' || typeof owner.projectId !== 'string') fail('private_job_owner_required');
  requireAlphaProject(owner.tenantId, owner.projectId);
  return {tenantId: owner.tenantId, projectId: owner.projectId};
}
function directorySafe(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077) fail('private_job_directory_unsafe');
}
function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function readPrivate(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > 65536) fail('private_job_file_unsafe');
    const bytes = Buffer.alloc(65537); let size = 0, count;
    while (size < bytes.length && (count = readSync(fd, bytes, size, bytes.length - size, null))) size += count;
    if (size !== stat.size || fstatSync(fd).mtimeMs !== stat.mtimeMs) fail('private_job_file_changed');
    const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(0, size));
    const value = JSON.parse(text);
    // Reject duplicate keys, alternate encodings and noncanonical damaged journals.
    if (encode(value) !== text) fail('private_job_journal_invalid');
    return value;
  } catch { fail('private_job_state_unavailable'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
function writePrivate(directory, name, value, exclusive = false) {
  directorySafe(directory);
  const body = encode(value);
  if (Buffer.byteLength(body) > 65536) fail('private_job_journal_bound');
  const path = join(directory, name), temp = exclusive ? path : path + '.tmp';
  if (!exclusive && pathExists(path)) readPrivate(path);
  let fd;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, body); fsyncSync(fd);
  } catch { fail('private_job_state_unavailable'); }
  finally { if (fd !== undefined) closeSync(fd); }
  if (!exclusive) renameSync(temp, path);
  syncDirectory(directory);
}
function jobId(owner, requestId) { return 'job_' + hash({owner, requestId}); }
function validate(row, owner, id) {
  if (!plain(row) || Object.keys(row).sort().join() !== keys || row.version !== 1 || row.jobId !== id ||
      hash(row.owner) !== hash(owner) || jobId(owner, row.requestId) !== id) fail('private_job_not_found');
  const {checksum, ...body} = row;
  const plan = planBraintrustCapture(row.plan.scope);
  if (checksum !== hash(body) || hash(plan) !== hash(row.plan) || plan.scope.destinationProject !== owner.projectId || plan.scope.content !== 'metadata' ||
      !Number.isSafeInteger(row.createdAt) || !Number.isSafeInteger(row.expiresAt) || row.expiresAt <= row.createdAt || row.expiresAt - row.createdAt > 300000 ||
      !['queued', 'running', 'paused', ...terminal].includes(row.state) || !['waiting', 'capture', 'staging', 'staged'].includes(row.phase) ||
      !Number.isInteger(row.attempts) || row.attempts < 0 || row.attempts > 3 ||
      !plain(row.progress) || Object.keys(row.progress).sort().join() !== 'pages,requests,rows' ||
      Object.values(row.progress).some(n => !Number.isSafeInteger(n) || n < 0) || row.progress.pages > plan.scope.maxPages || row.progress.rows > plan.scope.maxRows || row.progress.requests > 300 ||
      (row.state === 'staged') !== (row.receipt !== null) || row.receipt && (row.receipt.fingerprint !== plan.fingerprint || row.receipt.destinationProject !== owner.projectId || row.receipt.uploaded !== false)) fail('private_job_journal_invalid');
  return row;
}

/** A finite, explicit worker API. The host must supply authenticated owner context,
 * genuine authorization and an approved source lease provider. These hooks confer no
 * permission themselves. The broker returns only a copied, job-limited in-memory
 * lease to the existing transport; it never creates/revokes a provider key.
 */
export function createPrivateBraintrustJobs(options = {}) {
  const allowed = ['directory', 'fetchImpl', 'credentialProvider', 'authorize', 'bounds', 'maxJobs', 'maxAttempts', 'totalTimeoutMs'];
  if (!plain(options) || Object.keys(options).some(k => !allowed.includes(k)) || typeof options.directory !== 'string' || !options.directory ||
      ['fetchImpl', 'credentialProvider', 'authorize'].some(k => typeof options[k] !== 'function') || !plain(options.bounds)) fail('private_job_explicit_runtime_required');
  const {fetchImpl, credentialProvider, authorize} = options;
  const usesGlobalFetch = fetchImpl === globalThis.fetch;
  function requireTLS() {
    if (usesGlobalFetch && process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') fail('private_job_tls_validation_disabled');
  }
  const bounds = structuredClone(options.bounds);
  // Validate the retained transport contract without starting a request or reading a lease.
  const limits = {maxJobs: options.maxJobs ?? 32, maxAttempts: options.maxAttempts ?? 3, totalTimeoutMs: options.totalTimeoutMs ?? 300000};
  for (const [key, max] of Object.entries({maxJobs: 64, maxAttempts: 3, totalTimeoutMs: 300000})) if (!Number.isInteger(limits[key]) || limits[key] < 1 || limits[key] > max) fail('private_job_bounds_required');
  const root = resolve(options.directory), active = new Map();
  const execution = {bounds, maxAttempts: limits.maxAttempts, totalTimeoutMs: limits.totalTimeoutMs};
  const now = () => Date.now();
  function rootSafe(create = false) {
    if (create && !pathExists(root)) { mkdirSync(root, {mode: 0o700}); syncDirectory(resolve(root, '..')); }
    directorySafe(root);
  }
  function load(owner, id) {
    if (!JOB.test(id)) fail('private_job_not_found');
    rootSafe(); const directory = join(root, id);
    try { directorySafe(directory); } catch { fail('private_job_not_found'); }
    if (pathExists(join(directory, 'job.json.tmp'))) fail('private_job_reconciliation_required');
    const row = validate(readPrivate(join(directory, 'job.json')), owner, id);
    if (hash(row.execution) !== hash(execution)) fail('private_job_execution_binding_changed');
    return row;
  }
  function save(row) {
    const {checksum: ignored, ...body} = row;
    writePrivate(join(root, row.jobId), 'job.json', {...body, checksum: hash(body)});
  }
  function cancelled(row) {
    const directory = join(root, row.jobId), path = join(directory, 'cancel.json');
    if (!pathExists(path)) return false;
    const marker = readPrivate(path);
    if (encode(marker) !== encode({jobId: row.jobId, fingerprint: row.plan.fingerprint, owner: row.owner})) fail('private_job_cancel_scope_invalid');
    return true;
  }
  function view(row) {
    const cancelling = !terminal.has(row.state) && cancelled(row);
    return {jobId: row.jobId, status: cancelling ? 'cancellation_requested' : row.state, phase: row.phase,
      attempts: row.attempts, progress: {...row.progress}, batches: row.receipt?.batches ?? 0,
      expiresAt: row.expiresAt, uploaded: false, hostedReadbackVerified: false,
      resumeAvailable: row.state === 'paused' && !cancelling && row.attempts < limits.maxAttempts && now() < row.expiresAt,
      exclusion: row.state === 'running' ? 'active_or_interrupted_no_automatic_takeover' : 'cooperating_private_workspace',
      persistence: 'fsynced-job-journal; retained-stage-durability-unchanged'};
  }
  async function permission(row, action, extra = {}) {
    let timer, result; const controller = new AbortController();
    const timeoutMs = Math.min(bounds.requestTimeoutMs, 30000);
    try {
      result = await Promise.race([
        Promise.resolve().then(() => authorize(structuredClone({jobId: row.jobId, owner: row.owner, action, fingerprint: row.plan.fingerprint, scope: row.plan.scope, expiresAt: row.expiresAt, ...extra}), {signal: controller.signal, timeoutMs})),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error()); }, timeoutMs); }),
      ]);
    } catch { fail('private_job_authorization_unavailable'); }
    finally { clearTimeout(timer); controller.abort(); }
    if (result !== true) fail('private_job_action_not_authorized');
  }
  return Object.freeze({
    async create(context, spec, requestId) {
      const owner = ownerBinding(context), plan = planBraintrustCapture(spec); requireTLS();
      if (plan.scope.destinationProject !== owner.projectId || plan.scope.content !== 'metadata' || typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(requestId)) fail('private_job_scope_invalid');
      const validation = createBraintrustTransport(plan.scope, {fetchImpl, credentialProvider, authorize, bounds}); validation.close();
      const time = now(), id = jobId(owner, requestId);
      const row = {version: 1, jobId: id, owner, requestId, plan, createdAt: time, expiresAt: time + limits.totalTimeoutMs,
        state: 'queued', phase: 'waiting', attempts: 0, progress: {pages: 0, rows: 0, requests: 0}, receipt: null, execution};
      await permission(row, 'create-job'); rootSafe(true);
      const creationLock = acquireWorkspaceLock(root);
      try {
        const directory = join(root, id);
        if (pathExists(directory)) { const old = load(owner, id); if (hash(old.plan) !== hash(plan)) fail('private_job_request_conflict'); return view(old); }
        const entries = readdirSync(root).filter(n => n !== WORKSPACE_LOCK);
        if (entries.length >= limits.maxJobs || entries.some(n => !JOB.test(n))) fail('private_job_capacity_or_reconciliation_required');
        try { mkdirSync(directory, {mode: 0o700}); } catch { fail('private_job_state_unavailable'); }
        save(row); syncDirectory(root); return view(load(owner, id));
      } finally { creationLock.release(); }
    },
    async status(context, id) {
      const row = load(ownerBinding(context), id); await permission(row, 'view-job'); return view(row);
    },
    async cancel(context, id) {
      const row = load(ownerBinding(context), id); await permission(row, 'cancel-job');
      if (terminal.has(row.state)) return view(row);
      try {
        if (!cancelled(row)) {
          try { writePrivate(join(root, id), 'cancel.json', {jobId: id, fingerprint: row.plan.fingerprint, owner: row.owner}, true); }
          catch (error) { if (!cancelled(row)) throw error; }
        }
      } finally { active.get(id)?.abort(); }
      return view(load(row.owner, id));
    },
    async execute(context, id) {
      const owner = ownerBinding(context); let row = load(owner, id); requireTLS();
      await permission(row, 'execute-job');
      const directory = join(root, id), lock = acquireWorkspaceLock(directory);
      let timer, poll, controller, lifetimeIsBudget = false;
      try {
        row = load(owner, id);
        if (terminal.has(row.state)) return view(row);
        if (row.state === 'running') fail('private_job_reconciliation_required');
        if (cancelled(row) || now() >= row.expiresAt || row.attempts >= limits.maxAttempts) {
          row.state = cancelled(row) ? 'cancelled' : now() >= row.expiresAt ? 'expired' : 'exhausted'; save(row); return view(row);
        }
        controller = new AbortController(); active.set(id, controller);
        row.state = 'running'; row.phase = 'capture'; row.attempts++; save(row);
        const check = () => { if (controller.signal.aborted || cancelled(row) || now() >= row.expiresAt) { controller.abort(); fail('private_job_stopped'); } };
        timer = setTimeout(() => controller.abort(), Math.max(1, row.expiresAt - now()));
        poll = setInterval(() => { try { check(); } catch { controller.abort(); } }, 100);
        try {
          // When the job's remaining lifetime is the run's total budget, the run exhausting that budget is the job
          // expiring. The run's own timer can fire a few milliseconds before the lifetime timer above and before the
          // wall clock reaches expiresAt, so the outcome is decided by the reason, not by which timer won.
          const lifetime = row.expiresAt - now(), remaining = Math.max(1, Math.min(bounds.totalTimeoutMs, lifetime));
          lifetimeIsBudget = lifetime <= bounds.totalTimeoutMs;
          const result = await runPrivateBraintrustImport(row.plan.scope, {
            directory: join(directory, 'workspace'), signal: controller.signal,
            bounds: {...bounds, totalTimeoutMs: remaining, requestTimeoutMs: Math.min(bounds.requestTimeoutMs, remaining)},
            fetchImpl: async (...args) => {
              check(); requireTLS(); if (row.progress.requests >= bounds.maxRequests) fail('private_job_request_bound');
              row.progress.requests++; save(row); return fetchImpl(...args);
            },
            credentialProvider: async binding => {
              check(); let lease;
              try { lease = await credentialProvider(structuredClone({jobId: id, owner, fingerprint: row.plan.fingerprint, ...binding, expiresAt: row.expiresAt}), {signal: controller.signal, timeoutMs: Math.min(bounds.requestTimeoutMs, Math.max(1, row.expiresAt - now()))}); }
              catch { fail('private_job_credential_unavailable'); }
              check();
              if (!plain(lease) || Object.keys(lease).sort().join() !== 'apiKey,expiresAt,origin,projectId' || !Number.isFinite(lease.expiresAt) || lease.expiresAt <= now() || lease.expiresAt > now() + 300000) fail('private_job_credential_invalid');
              return {origin: lease.origin, projectId: lease.projectId, apiKey: lease.apiKey, expiresAt: Math.min(lease.expiresAt, row.expiresAt)};
            },
            authorize: async descriptor => {
              check(); await permission(row, descriptor.action, {transport: descriptor}); check();
              if (descriptor.action === 'stage-destination') { row.phase = 'staging'; save(row); }
              return true;
            },
            onProgress: async progress => {
              check(); row.progress.pages = progress.pages; row.progress.rows = progress.rows; save(row);
            },
          });
          check(); row.state = 'staged'; row.phase = 'staged'; row.receipt = result.stageReceipt; save(row);
        } catch (error) {
          if (row.receipt) row.receipt = null;
          const lifetimeSpent = lifetimeIsBudget && error?.message === 'braintrust_total_deadline_exceeded';
          row.state = ['staging', 'staged'].includes(row.phase) ? 'reconciliation_required' : cancelled(row) ? 'cancelled' : controller.signal.aborted || lifetimeSpent || now() >= row.expiresAt ? 'expired' : 'paused';
          save(row);
        }
        return view(load(owner, id));
      } finally {
        clearTimeout(timer); clearInterval(poll); controller?.abort(); active.delete(id); lock.release();
      }
    },
    async stagedArtifact(context, id) {
      const row = load(ownerBinding(context), id); await permission(row, 'read-staged-artifact');
      if (row.state !== 'staged') fail('private_job_not_staged');
      return {directory: join(root, id, 'workspace'), receipt: structuredClone(row.receipt), uploaded: false};
    },
  });
}
