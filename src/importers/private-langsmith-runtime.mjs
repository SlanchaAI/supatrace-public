import {constants, openSync, closeSync, fstatSync, readFileSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {planLangsmithCapture, captureLangsmith} from './langsmith-capture.mjs';
import {createLangsmithTransport} from './langsmith-transport.mjs';
import {openPrivateImportWorkspace} from './private-import-workspace.mjs';
import {acquireWorkspaceLock} from './private-workspace-lock.mjs';
import {hash} from './langfuse.mjs';

function binding(directory) {
  let fd;
  try {
    fd = openSync(join(directory, 'binding.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > 65536) throw Error();
    return JSON.parse(readFileSync(fd, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw Error('langsmith_workspace_binding_unsafe');
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** Explicit authenticated historical read -> private checkpoints -> existing stage
 * and uploader contract. No automatic upload, credentials, live listener or discovery.
 */
export async function runPrivateLangsmithImport(spec, options = {}) {
  const allowed = ['directory', 'fetchImpl', 'credentialProvider', 'authorize', 'bounds', 'signal'];
  if (!options || Object.keys(options).some(k => !allowed.includes(k)) || typeof options.directory !== 'string' || !options.directory) throw Error('langsmith_explicit_runtime_required');
  const {scope, fingerprint} = planLangsmithCapture(spec);
  const transport = createLangsmithTransport(scope, options);
  const directory = resolve(options.directory);
  let lock;
  try {
    if (options.signal?.aborted) throw Error('langsmith_cancelled');
    const workspace = openPrivateImportWorkspace(directory);
    lock = acquireWorkspaceLock(directory);
    for (const old of [binding(directory), workspace.status().stageReceipt]) if (old && (old.fingerprint !== fingerprint || old.destinationProject !== scope.destinationProject)) throw Error('langsmith_workspace_scope_mismatch');
    const result = await captureLangsmith(scope, {transport, checkpoint: workspace.loadCheckpoint(), saveCheckpoint: workspace.saveCheckpoint, signal: options.signal});
    const conversionHash = hash(result.converted);
    await transport.authorizeStage(conversionHash, options.signal);
    const receipt = await workspace.stage({...result.converted, fingerprint, destinationProject: scope.destinationProject, conversionHash}, {signal: options.signal});
    const saved = workspace.status().stageReceipt;
    if (hash(saved) !== hash(receipt) || receipt.fingerprint !== fingerprint || receipt.conversionHash !== conversionHash || receipt.uploaded !== false || receipt.batches !== result.converted.batches.length) throw Error('langsmith_stage_receipt_mismatch');
    return {outcome: 'locally-staged', stageReceipt: receipt, report: result.converted.report, coverage: result.coverage, traceMembershipVerified: false, transport: transport.status(), uploaded: false, hostedReadbackVerified: false, crashDurabilityVerified: false};
  } finally { transport.close(); lock?.release(); }
}
