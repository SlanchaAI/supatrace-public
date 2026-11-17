import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {planBraintrustCapture, captureBraintrust} from '../src/importers/braintrust-capture.mjs';
import {createBraintrustTransport, BRAINTRUST_TRANSPORT_BOUNDS} from '../src/importers/braintrust-transport.mjs';
import {runPrivateBraintrustImport} from '../src/importers/private-braintrust-runtime.mjs';
import {braintrustQuery} from '../src/importers/vendor/kitaru/braintrust-query.mjs';
import {braintrustImportMain} from '../agent/import_braintrust.mjs';
import {Readable} from 'node:stream';

import {sourceProject, spec, key, marker, row, json, fakeOptions} from './braintrust-fixtures.mjs';
function temp() { return mkdtempSync(join(tmpdir(), 'braintrust-api-')); }
function readTree(dir) { return readdirSync(dir, {withFileTypes: true}).map(e => e.isDirectory() ? readTree(join(dir, e.name)) : readFileSync(join(dir, e.name), 'utf8')).join('\n'); }
async function run(pages, change = {}, extra = {}) { const directory = temp(), fake = fakeOptions(pages, extra); try { const result = await runPrivateBraintrustImport({...spec, ...change}, {...fake.options, directory}); return {result, disk: readTree(directory), fake}; } finally { rmSync(directory, {recursive: true, force: true}); } }

test('Kitaru query reuse binds selected roots, explicit project, metadata projection and escaped cursor', () => {
  const plan = planBraintrustCapture(spec), body = braintrustQuery(plan.scope, "cursor'quoted");
  assert.match(body.query, /project_logs\('12345678/); assert.match(body.query, /_pagination_key asc/); assert.match(body.query, /cursor: 'cursor''quoted'/);
  assert.doesNotMatch(body.query, /select: \*|input|output|metadata/);
  assert.match(braintrustQuery({...plan.scope, content: 'include'}).query, /select: \*/);
  for (const change of [{origin: 'https://evil.example'}, {sourceProject: "x')"}, {rootSpanIds: []}, {rootSpanIds: ['root', 'root']}, {rootSpanIds: ["root' OR true"]}, {rootSpanIds: Array.from({length: 26}, (_, i) => 'root' + i)}, {content: 'yes'}, {maxRows: 1001}, {maxPages: 0}, {unknown: true}]) assert.throws(() => planBraintrustCapture({...spec, ...change}));
});
test('real private staging consumes header/body paginated responses and strips content before disk', async () => {
  const {result, disk, fake} = await run([{data: {data: [row()]}, headers: {'x-bt-cursor': 'next'}}, {data: {data: [row('child')]}}]);
  assert.equal(result.stageReceipt.batches, 2); assert.equal(result.transport.requests, 4); assert.equal(result.uploaded, false);
  assert.equal(fake.permissions.filter(p => p.action === 'stage-destination').length, 1);
  assert.doesNotMatch(disk, new RegExp(marker + '|' + key)); assert.match(disk, /parentSpanId/);
  assert.match(fake.requests.at(-1).init.body, /cursor: 'next'/);
  assert.equal(result.report.content, 'metadata');
});
test('content opt-in is bound to authorization and retains original records', async () => {
  const {disk, fake, result} = await run([{data: {data: [row()]}}], {content: 'include'});
  assert.match(disk, new RegExp(marker)); assert.equal(result.report.content, 'include');
  assert.ok(fake.permissions.every(p => p.content === 'include'));
});
test('interrupted fetch resumes after saved cursor; completed capture restarts with no source request', async () => {
  const directory = temp();
  try {
    let first = fakeOptions([{data: {data: [row()], cursor: 'next'}}, Error(key)]);
    await assert.rejects(runPrivateBraintrustImport(spec, {...first.options, directory}), /braintrust_transport_failed/);
    let saved = JSON.parse(readFileSync(join(directory, 'checkpoint.json'))); assert.equal(saved.pages.length, 1); assert.equal(saved.complete, false);
    assert.equal(statSync(join(directory, 'checkpoint.json')).mode & 0o777, 0o600);
    const second = fakeOptions([{data: {data: [row('child')]}}]);
    const result = await runPrivateBraintrustImport(spec, {...second.options, directory}); assert.equal(result.stageReceipt.batches, 2); assert.match(second.requests.at(-1).init.body, /cursor: 'next'/);
    const restart = fakeOptions([]);
    assert.equal((await runPrivateBraintrustImport(spec, {...restart.options, directory})).transport.requests, 0);
    await assert.rejects(runPrivateBraintrustImport({...spec, content: 'include'}, {...restart.options, directory}), /scope_mismatch/);
    assert.doesNotMatch(readTree(directory), new RegExp(marker + '|' + key));
  } finally { rmSync(directory, {recursive: true, force: true}); }
});
for (const [label, pages, change, expected] of [
  ['conflicting cursor', [{data: {data: [row()], cursor: 'a'}, headers: {'x-bt-cursor': 'b'}}], {}, /cursor_invalid/],
  ['cursor cycle', [{data: {data: [row()], cursor: 'a'}}, {data: {data: [row()], cursor: 'a'}}], {}, /cursor_cycle/],
  ['empty continuation', [{data: {data: [], cursor: 'a'}}], {}, /cursor_cycle/],
  ['page overflow', [{data: {data: [row(), row('child'), row('third')]}}], {}, /page_invalid/],
  ['row cap', [{data: {data: [row()], cursor: 'next'}}, {data: {data: [row('child')]}}], {maxRows: 1}, /bound_incomplete/],
  ['page cap', [{data: {data: [row()], cursor: 'next'}}], {maxPages: 1}, /bound_incomplete/],
  ['wrong project', [{data: {data: [row('root', {project_id: 'foreign'})]}}], {}, /scope_mismatch/],
  ['wrong root', [{data: {data: [row('root', {root_span_id: 'foreign'})]}}], {}, /scope_mismatch/],
  ['missing root', [{data: {data: [row('child')]}}], {}, /requested_root_missing/],
  ['missing parent', [{data: {data: [row(), row('child', {span_parents: ['absent']})]}}], {}, /parent_missing/],
  ['unfinished span', [{data: {data: [row('root', {metrics: {start: 1}})]}}], {}, /unfinished_span/],
  ['changed duplicate', [{data: {data: [row(), row('root', {metrics: {start: 1, end: 2}})]}}], {}, /conversion_rejected/],
  ['credential echo', [{data: {data: [row('root', {output: key})]}}], {}, /credential_echo/],
]) test('refuses ' + label + ' without a stage receipt', async () => {
  await assert.rejects(run(pages, change), expected);
});
test('identical duplicate spans are deduplicated across source pages', async () => {
  const {result} = await run([{data: {data: [row()], cursor: 'a'}}, {data: {data: [row(), row('child')]}}]);
  assert.equal(result.stageReceipt.batches, 2); assert.equal(result.report.duplicateRows, 1);
});
for (const [label, extra, expected] of [
  ['denied source', {authorize: async () => false}, /action_not_authorized/],
  ['throwing credentials', {credentialProvider: async () => { throw Error(key); }}, /credential_unavailable/],
  ['wrong credential binding', {credentialProvider: async () => ({apiKey: key, origin: spec.origin, projectId: 'foreign', expiresAt: Date.now() + 1000})}, /binding_or_lease/],
  ['expired credential', {credentialProvider: async () => ({apiKey: key, origin: spec.origin, projectId: sourceProject, expiresAt: Date.now() - 1})}, /binding_or_lease/],
  ['wrong verified project', {fetchImpl: async () => json({id: 'foreign'})}, /verified_project_mismatch/],
  ['redirect', {fetchImpl: async () => new Response('', {status: 302, headers: {location: 'https://evil.example'}})}, /redirect_refused/],
  ['oversized response', {fetchImpl: async () => json({id: sourceProject}, {'content-length': '999999999'})}, /response_bound/],
  ['wrong content type', {fetchImpl: async () => new Response(key)}, /json_required/],
  ['invalid UTF8', {fetchImpl: async () => new Response(Uint8Array.from([0xff]), {headers: {'content-type': 'application/json'}})}, /invalid_utf8/],
  ['request timeout', {fetchImpl: async () => new Promise(() => {}), bounds: {...BRAINTRUST_TRANSPORT_BOUNDS, requestTimeoutMs: 10}}, /operation_timeout/],
  ['total deadline inside a request', {fetchImpl: async () => new Promise(() => {}), bounds: {...BRAINTRUST_TRANSPORT_BOUNDS, requestTimeoutMs: 20, totalTimeoutMs: 20}}, /total_deadline_exceeded/],
]) test('secure transport rejects ' + label, async () => { await assert.rejects(run([], {}, extra), expected); });
test('429 retries are bounded, source error bodies never enter checkpoint, invalid retry delay fails closed', async () => {
  const rate = () => new Response(key, {status: 429, headers: {'retry-after': '0'}});
  const {result} = await run([rate, {data: {data: [row()]}}]); assert.equal(result.transport.requests, 4);
  await assert.rejects(run([rate, rate, rate]), /source_request_failed/);
  await assert.rejects(run([() => new Response('', {status: 429, headers: {'retry-after': '999999'}})]), /retry_after_exceeds_budget/);
});
test('failed checkpoint stops pagination before next request', async () => {
  let requests = 0;
  await assert.rejects(captureBraintrust(spec, {transport: {checkpoint: (state, save) => save(state), request: async () => {requests++; return {status: 200, data: {data: [row()], cursor: 'next'}};}}, saveCheckpoint: async () => {throw Error('disk full');}}), /disk full/);
  assert.equal(requests, 1);
});
test('cancelled requests abort the wire and cannot stage', async () => {
  const controller = new AbortController(); let signal;
  const directory = temp(), fake = fakeOptions([], {fetchImpl: async (_, init) => {signal = init.signal; controller.abort(); return new Promise(() => {});}});
  try {
    await assert.rejects(runPrivateBraintrustImport(spec, {...fake.options, directory, signal: controller.signal}), /cancelled/);
    assert.equal(signal.aborted, true); assert.ok(!readdirSync(directory).includes('stage-receipt.json'));
  } finally { rmSync(directory, {recursive: true, force: true}); }
});
test('malformed checkpoint, leftover atomic write and stale lock fail closed without source calls', async () => {
  for (const file of ['checkpoint.json', 'checkpoint.json.tmp', '.live-import.lock']) {
    const directory = temp(), fake = fakeOptions([{data: {data: [row()]}}]);
    try {
      writeFileSync(join(directory, file), '{}', {mode: 0o600});
      await assert.rejects(runPrivateBraintrustImport(spec, {...fake.options, directory}));
      assert.ok(!readdirSync(directory).includes('stage-receipt.json'));
      if (file !== 'checkpoint.json.tmp') assert.equal(fake.requests.length, 0);
    } finally { rmSync(directory, {recursive: true, force: true}); }
  }
});

for (const content of ['metadata', 'include']) test('metricless standalone logs survive source paging with ' + content + ' policy', async () => {
  const log = {id: 'log1', project_id: sourceProject, root_span_id: 'root', span_id: 'root', span_attributes: {type: 'log'}, created: '2026-11-04T00:00:00Z', output: marker};
  const {result, disk} = await run([{data: {data: [row()], cursor: 'next'}}, {data: {data: [log]}}], {content});
  assert.equal(result.stageReceipt.batches, 1);
  if (content === 'include') assert.match(disk, /attachedEvents/); else assert.doesNotMatch(disk, new RegExp(marker));
});
test('checkpoint timeout and cancellation cannot request another page', async () => {
  const fake = fakeOptions([{data: {data: [row()], cursor: 'next'}}], {bounds: {...BRAINTRUST_TRANSPORT_BOUNDS, requestTimeoutMs: 20}});
  const transport = createBraintrustTransport(spec, fake.options);
  try { await assert.rejects(captureBraintrust(spec, {transport, saveCheckpoint: async () => new Promise(() => {})}), /operation_timeout/); assert.equal(fake.requests.length, 2); }
  finally { transport.close(); }
});
test('CLI requires explicit flags and receives a scoped lease only through a bounded pipe', async () => {
  const directory = temp(), path = join(directory, 'spec.json'), workspace = join(directory, 'workspace');
  writeFileSync(path, JSON.stringify(spec));
  const lease = {origin: spec.origin, projectId: sourceProject, apiKey: key, expiresAt: Date.now() + 60000};
  const fake = fakeOptions([{data: {data: [row()]}}]);
  try {
    for (const flags of [[], ['--fetch'], ['--fetch', '--stage', '--include-content'], ['--fetch', '--stage', '--token=' + key]]) await assert.rejects(braintrustImportMain([path, workspace, ...flags], {stdin: Readable.from([Buffer.from(JSON.stringify(lease))]), fetchImpl: fake.options.fetchImpl}));
    assert.equal(fake.requests.length, 0);
    const result = await braintrustImportMain([path, workspace, '--fetch', '--stage'], {stdin: Readable.from([Buffer.from(JSON.stringify(lease))]), fetchImpl: fake.options.fetchImpl});
    assert.equal(result.stageReceipt.batches, 1); assert.doesNotMatch(readTree(workspace), new RegExp(key));
    await assert.rejects(braintrustImportMain([path, workspace, '--fetch', '--stage'], {stdin: Readable.from([Buffer.from('x'.repeat(4097))]), fetchImpl: fake.options.fetchImpl}), /credential_pipe_failed/);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});
test('close cancels a stalled permission hook immediately', async () => {
  let entered;
  const ready = new Promise(resolve => entered = resolve), fake = fakeOptions([], {authorize: async () => {entered(); return new Promise(() => {});}});
  const transport = createBraintrustTransport(spec, fake.options), pending = transport.request(null);
  const rejected = assert.rejects(pending, /cancelled/);
  await ready; transport.close(); await rejected; assert.equal(fake.requests.length, 0);
});
test('denied destination stage retains private checkpoint without producing upload files', async () => {
  const directory = temp(), fake = fakeOptions([{data: {data: [row()]}}], {authorize: async d => d.action !== 'stage-destination'});
  try {
    await assert.rejects(runPrivateBraintrustImport(spec, {...fake.options, directory}), /action_not_authorized/);
    assert.deepEqual(readdirSync(directory), ['checkpoint.json']);
  } finally {rmSync(directory, {recursive: true, force: true});}
});
test('wire request and streamed-byte limits stop before staging', async () => {
  await assert.rejects(run([{data: {data: [row()]}}], {}, {bounds: {...BRAINTRUST_TRANSPORT_BOUNDS, maxRequests: 1}}), /transport_budget/);
  await assert.rejects(run([{data: {data: [row()]}}], {}, {bounds: {...BRAINTRUST_TRANSPORT_BOUNDS, maxResponseBytes: 80}}), /response_bound/);
  await assert.rejects(run([{data: {data: [row()]}}], {maxBytes: 10}), /checkpoint_bounds/);
});
test('child-first pagination preserves identity and parent relationships', async () => {
  const {result} = await run([{data: {data: [row('child')], cursor: 'a'}}, {data: {data: [row()]}}]);
  assert.equal(result.stageReceipt.batches, 2); assert.deepEqual(result.report.warnings, []);
});
