// Product-local operator composition. No automatic credential discovery or default network.
import {runLangfuseWorkflow} from './langfuse-workflow.mjs';
import {openPrivateImportWorkspace} from './private-import-workspace.mjs';
import {planCapture} from './langfuse-capture.mjs';
import {createLangfuseTransport} from './langfuse-transport.mjs';
import {hash} from './langfuse.mjs';
import {constants,openSync,fstatSync,lstatSync,readFileSync,closeSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {acquireWorkspaceLock} from './private-workspace-lock.mjs';

const active = new Set();
const clone = value => JSON.parse(JSON.stringify(value));
const fail = code => { throw new Error(code); };

function readBinding(directory) {
  let fd;
  try {
    fd = openSync(join(directory, 'binding.json'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() ||
        stat.mode & 0o077 || stat.size > 65536) fail('private_runtime_binding_unsafe');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    fail('private_runtime_binding_unsafe');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function bindingMatches(value, plan) {
  return value && value.destinationProject === plan.scope.destinationProject &&
    value.fingerprint === plan.fingerprint;
}

/**
 * Compose existing bounded capture with concrete private checkpoint/stage hooks.
 * No credential discovery, global fetch default, uploader, login or hosted receipt.
 * The caller supplies genuine action authorization and a supported credential bridge.
 * Shared exclusive workspace lock coordinates callers using this runtime protocol.
 * A stale lock is never expired or taken over automatically.
 */
export async function runPrivateLangfuseWorkflow(spec, options = {}) {
  const allowed = new Set(['directory', 'fetchImpl', 'credentialProvider', 'authorize', 'bounds', 'onProgress', 'pythonExecutable']);
  if (!options || Object.keys(options).some(key => !allowed.has(key)) ||
      typeof options.directory !== 'string' || !options.directory ||
      ['fetchImpl', 'credentialProvider', 'authorize'].some(key => typeof options[key] !== 'function')) {
    fail('private_runtime_explicit_dependencies_required');
  }
  if (options.onProgress !== undefined && typeof options.onProgress !== 'function') fail('private_runtime_progress_hook_invalid');
  const {fetchImpl,credentialProvider,authorize} = options;
  // Validate before JSON snapshotting so explicit invalid/undefined fields cannot disappear.
  const plan = planCapture(clone(planCapture(spec).scope));
  const bounds = clone(options.bounds);
  // Existing transport construction validates origin/bounds without invoking any hook or I/O.
  const validation = createLangfuseTransport(plan.scope, {fetchImpl,credentialProvider,authorize,bounds});
  validation.close();
  const directory = resolve(options.directory);
  const workspace = openPrivateImportWorkspace(directory,options.pythonExecutable===undefined?{}:{pythonExecutable:options.pythonExecutable});
  const identity = lstatSync(directory);
  const workspaceKey = `${identity.dev}:${identity.ino}`;
  if (active.has(workspaceKey)) fail('private_runtime_already_active');
  active.add(workspaceKey);
  let stagingOperation = null;
  let lock = null;
  try {
    lock = acquireWorkspaceLock(directory);
    const binding = readBinding(directory);
    const checkpoint = workspace.loadCheckpoint();
    const priorStage = workspace.status().stageReceipt;
    if ((binding && !bindingMatches(binding, plan)) ||
        (checkpoint && checkpoint.fingerprint !== plan.fingerprint) ||
        (priorStage && !bindingMatches(priorStage, plan))) {
      fail('private_runtime_workspace_scope_mismatch');
    }
    let stageReceipt = null;
    let emptyCapture = false;
    let transportRequestsAttempted = 0;
    const workflow = await runLangfuseWorkflow(plan.scope, {
      fetchImpl: (...args) => { transportRequestsAttempted++; return fetchImpl(...args); },
      credentialProvider,
      authorize,
      bounds,
      checkpoint,
      saveCheckpoint: async (value, context) => {
        await workspace.saveCheckpoint(value, context);
        await options.onProgress?.({pages:value.pages.length,rows:value.pages.reduce((n,page)=>n+page.data.length,0)});
      },
      stage: async (payload, context) => {
        if (payload.batches.length === 0) { emptyCapture = true; return; }
        stagingOperation = workspace.stage(payload, context);
        stageReceipt = await stagingOperation;
      },
    });
    const common = {uploaded:false,hostedReadbackVerified:false,transportRequestsAttempted,
      workspaceExclusion:'exclusive-lock-for-cooperating-runtimes',
      crashDurabilityVerified:false,workflow};
    if (workflow.outcome !== 'stage-callback-completed') {
      return {...common,outcome:workflow.outcome,staged:false,localFilesVerified:false};
    }
    if (emptyCapture) {
      return {...common,outcome:'captured-empty',staged:false,localFilesVerified:false};
    }
    const diskReceipt = workspace.status().stageReceipt;
    if (!bindingMatches(stageReceipt, plan) || !diskReceipt ||
        hash(stageReceipt) !== hash(diskReceipt) ||
        stageReceipt.conversionHash !== workflow.receipt.conversionHash ||
        stageReceipt.batches !== workflow.receipt.batches ||
        stageReceipt.uploaded !== false ||
        stageReceipt.persistence !== 'local-files-verified-no-fsync-guarantee' ||
        !/^[a-f0-9]{64}$/.test(stageReceipt.manifestHash)) {
      fail('private_runtime_stage_outcome_unverified');
    }
    return {...common,outcome:'locally-staged',staged:true,localFilesVerified:true,
      stageReceipt:clone(diskReceipt)};
  } finally {
    // Timeout/abort can reject the workflow before the child process has closed.
    // Keep exclusion until the actual staging operation settles; do not retry it.
    if (stagingOperation) {
      try { await stagingOperation; } catch { /* Original workflow error remains authoritative. */ }
    }
    try {
      if (lock) lock.release();
    } finally {
      active.delete(workspaceKey);
    }
  }
}
