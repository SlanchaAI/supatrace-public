#!/usr/bin/env node
// Explicit local files only. No discovery, credentials, provider calls or uploads.
import {openSync, closeSync, fstatSync, readSync, constants} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {convertConnectorFile, CONNECTOR_LIMITS, FILE_FORMATS} from '../src/importers/connector-files.mjs';
import {openPrivateImportWorkspace} from '../src/importers/private-import-workspace.mjs';
import {acquireWorkspaceLock} from '../src/importers/private-workspace-lock.mjs';
import {hash} from '../src/importers/langfuse.mjs';

export async function stageConnectorFile(input, {format, namespace, destinationProject, directory, content = 'metadata', encoding = 'json', signal} = {}) {
  if (!/^proj_[a-f0-9]{32}$/.test(destinationProject ?? '')) throw Error('explicit_destination_project_required');
  let fd, raw;
  try {
    fd = openSync(input, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > CONNECTOR_LIMITS.inputBytes) throw Error('bounded_regular_input_required');
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0, chunk;
    while (count < bytes.length && (chunk = readSync(fd, bytes, count, bytes.length - count, null)) > 0) count += chunk;
    const after = fstatSync(fd);
    if (count !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw Error('input_changed');
    raw = new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(0, count));
  } finally { if (fd !== undefined) closeSync(fd); }
  const converted = convertConnectorFile(raw, {format, namespace, content, encoding});
  if (converted.report.rejected.length) throw Error('conversion_rejected_no_staging');
  if (signal?.aborted) throw Error('cancelled');
  const fingerprint = hash({format, namespace, content, encoding, destinationProject, inputHash: hash(raw), version: 1});
  const workspace = openPrivateImportWorkspace(directory);
  const conversionHash = hash(converted);
  const lock = acquireWorkspaceLock(directory);
  let receipt;
  try { receipt = await workspace.stage({...converted, destinationProject, fingerprint, conversionHash}, {signal}); }
  finally { lock.release(); }
  return {receipt, report: converted.report};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, format, namespace, destinationProject, directory, ...flags] = process.argv.slice(2);
  if (!input || !FILE_FORMATS.includes(format) || !namespace || !destinationProject || !directory || new Set(flags).size !== flags.length || flags.some(f => !['--include-content', '--jsonl'].includes(f))) {
    console.error('Usage: node agent/import_traces.mjs INPUT FORMAT NAMESPACE DESTINATION_PROJECT PRIVATE_WORKSPACE [--include-content] [--jsonl]');
    console.error('File formats: ' + FILE_FORMATS.join(', ')); process.exitCode = 2;
  } else {
    try {
      const result = await stageConnectorFile(input, {format, namespace, destinationProject, directory, content: flags.includes('--include-content') ? 'include' : 'metadata', encoding: flags.includes('--jsonl') ? 'jsonl' : 'json'});
      console.log(JSON.stringify({staged: result.receipt.batches, traces: result.report.acceptedTraces, content: result.report.content, uploaded: false, persistence: result.receipt.persistence}));
    } catch { console.error('Import not staged or interrupted. Review the explicit input and private workspace; do not upload without a verified stage receipt. No upload was attempted.'); process.exitCode = 1; }
  }
}
