#!/usr/bin/env node
// Explicit operator action only: scoped API read + private local stage; no upload.
import {openSync, fstatSync, readSync, closeSync, constants} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {planBraintrustCapture} from '../src/importers/braintrust-capture.mjs';
import {BRAINTRUST_TRANSPORT_BOUNDS} from '../src/importers/braintrust-transport.mjs';
import {runPrivateBraintrustImport} from '../src/importers/private-braintrust-runtime.mjs';

function readSpec(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536) throw Error('bounded_spec_required');
    // Bounded read even if another process grows the file after fstat.
    const bytes = new Uint8Array(65537);
    let size = 0, count;
    while (size < bytes.length && (count = readSync(fd, bytes, size, bytes.length - size, null))) size += count;
    if (size !== stat.size || fstatSync(fd).mtimeMs !== stat.mtimeMs) throw Error('spec_changed');
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(0, size)));
  } finally { if (fd !== undefined) closeSync(fd); }
}
// The credential bridge writes one small JSON lease to stdin, never argv or disk.
async function readLease(stream, signal) {
  if (stream.isTTY) throw Error('explicit_credential_pipe_required');
  return new Promise((resolve, reject) => {
    let bytes = 0, chunks = [];
    const finish = (error, value) => {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      stream.removeListener('data', data); stream.removeListener('end', end); stream.removeListener('error', errorHandler);
      stream.pause(); chunks = [];
      error ? reject(Error('credential_pipe_failed')) : resolve(value);
    };
    const abort = () => finish(true);
    const timer = setTimeout(abort, 30000);
    const errorHandler = () => finish(true);
    const data = chunk => { bytes += chunk.length; if (bytes > 4096) finish(true); else chunks.push(chunk); };
    const end = () => { try { finish(false, JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks)))); } catch { finish(true); } };
    signal.addEventListener('abort', abort, {once: true});
    stream.on('data', data); stream.once('end', end); stream.once('error', errorHandler);
    if (signal.aborted) abort();
  });
}
export async function braintrustImportMain(args, {stdin = process.stdin, fetchImpl = globalThis.fetch, signal = new AbortController().signal} = {}) {
  const [path, directory, ...flags] = args;
  if (!path || !directory || new Set(flags).size !== flags.length || !flags.includes('--fetch') || !flags.includes('--stage') || flags.some(f => !['--fetch', '--stage', '--include-content'].includes(f))) throw Error('explicit_fetch_and_stage_required');
  const {scope, fingerprint} = planBraintrustCapture(readSpec(path));
  if ((scope.content === 'include') !== flags.includes('--include-content')) throw Error('content_opt_in_mismatch');
  let lease = await readLease(stdin, signal);
  try {
    return await runPrivateBraintrustImport(scope, {directory, fetchImpl, signal, bounds: BRAINTRUST_TRANSPORT_BOUNDS,
      credentialProvider: async () => lease,
      authorize: async action => action.fingerprint === fingerprint && action.origin === scope.origin && action.sourceProject === scope.sourceProject && action.destinationProject === scope.destinationProject && action.content === scope.content && ['verify-source-project', 'read-trace-page', 'stage-destination'].includes(action.action),
    });
  } finally { lease = undefined; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController(), abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    const result = await braintrustImportMain(process.argv.slice(2), {signal: controller.signal});
    console.log(JSON.stringify({outcome: result.outcome, batches: result.stageReceipt.batches, traces: result.report.acceptedTraces, content: result.report.content, uploaded: false, persistence: result.stageReceipt.persistence}));
  } catch {
    console.error('Braintrust import stopped. Review the scoped spec and private workspace before retrying. No upload was attempted.');
    console.error('Usage: node agent/import_braintrust.mjs SPEC.json PRIVATE_WORKSPACE --fetch --stage [--include-content] < EPHEMERAL_CREDENTIAL_PIPE');
    process.exitCode = 1;
  } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
}
