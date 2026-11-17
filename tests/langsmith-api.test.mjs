import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {planLangsmithCapture, captureLangsmith} from '../src/importers/langsmith-capture.mjs';
import {createLangsmithTransport, LANGSMITH_TRANSPORT_BOUNDS} from '../src/importers/langsmith-transport.mjs';
import {runPrivateLangsmithImport} from '../src/importers/private-langsmith-runtime.mjs';
import {langsmithQuery} from '../src/importers/vendor/kitaru/langsmith-query.mjs';
import {langsmithImportMain} from '../agent/import_langsmith.mjs';
import {sourceProject, sourceWorkspace, spec, key, marker, row, json, fakeOptions, root, child, third, lease} from './langsmith-fixtures.mjs';
function temp() { return mkdtempSync(join(tmpdir(), 'langsmith-api-')); }
function readTree(dir) { return readdirSync(dir, {withFileTypes: true}).map(e => e.isDirectory() ? readTree(join(dir, e.name)) : readFileSync(join(dir, e.name), 'utf8')).join('\n'); }
async function run(pages, change = {}, extra = {}) { const directory = temp(), fake = fakeOptions(pages, extra); try { const result = await runPrivateLangsmithImport({...spec, ...change}, {...fake.options, directory}); return {result, disk: readTree(directory), fake}; } finally {rmSync(directory, {recursive: true, force: true});} }

test('v2 query selects explicit project/trace/time scope and own-run usage', () => {
  const {scope} = planLangsmithCapture(spec), body = langsmithQuery(scope, root, 'opaque-cursor');
  assert.deepEqual(body.project_ids, [sourceProject]); assert.equal(body.trace_id, root);
  assert.equal(body.min_start_time, spec.minStartTime); assert.equal(body.max_start_time, spec.maxStartTime);
  assert.equal(body.cursor, 'opaque-cursor'); assert.equal(body.include_subtree_usage, false);
  assert.ok(body.selects.includes('PARENT_RUN_IDS')); assert.ok(!body.selects.includes('INPUTS'));
  assert.ok(langsmithQuery({...scope, content: 'include'}, root).selects.includes('INPUTS'));
  for (const change of [{origin: 'https://evil.example'}, {sourceProject: 'x'}, {sourceWorkspace: null}, {traceIds: []}, {traceIds: [root, root]}, {traceIds: ['unsafe-id']}, {content: 'yes'}, {maxRows: 1001}, {maxPages: 0}, {unknown: true}, {minStartTime: undefined}, {minStartTime: '2026-02-30T00:00:00Z'}, {maxStartTime: spec.minStartTime}, {minStartTime: '2020-01-01T00:00:00Z'}]) assert.throws(() => planLangsmithCapture({...spec, ...change}));
});
test('child-first v2 pages -> private stage strip content while preserving parent, status, tokens and nanoseconds', async () => {
  const {result, disk, fake} = await run([{items: [row(child, {status: 'ERROR'})], next_cursor: 'next'}, {items: [row()], next_cursor: ''}]);
  assert.equal(result.stageReceipt.batches, 2); assert.equal(result.transport.requests, 4); assert.equal(result.uploaded, false);
  assert.doesNotMatch(disk, new RegExp(marker + '|' + key)); assert.match(disk, /parentSpanId/); assert.match(disk, /1793750401000000123/); assert.match(disk, /"status":"error"/);
  assert.equal(fake.permissions.filter(p => p.action === 'stage-destination').length, 1);
  assert.equal(JSON.parse(fake.requests.at(-1).init.body).cursor, 'next');
  assert.ok(fake.permissions.every(p => p.sourceWorkspace === sourceWorkspace));
});
test('content opt-in preserves returned rows, including array order and fields, without fetching attachments', async () => {
  const {disk, fake, result} = await run([{items: [row()]}], {content: 'include'});
  assert.match(disk, new RegExp(marker)); assert.equal(result.report.content, 'include');
  assert.ok(fake.permissions.every(p => p.content === 'include'));
  assert.ok(!JSON.parse(fake.requests.at(-1).init.body).selects.includes('ATTACHMENTS'));
});
test('multiple selected traces have separate cursors and stable explicit scope', async () => {
  const {result, fake} = await run([{items: [row()]}, {items: [row(third, {trace_id: third, is_root: true, parent_run_ids: []})]}], {traceIds: [third, root]});
  assert.equal(result.report.acceptedTraces, 2);
  assert.deepEqual(fake.requests.filter(r => r.init.method === 'POST').map(r => JSON.parse(r.init.body).trace_id), [root, third]);
});
test('optional empty v2 token detail wrappers are accepted; malformed present raw is refused', async () => {
  for (const content of ['metadata', 'include']) {
    const {result, disk} = await run([{items: [row(root, {prompt_token_details: {}, completion_token_details: {}})]}], {content});
    assert.equal(result.stageReceipt.batches, 1);
    if (content === 'include') assert.match(disk, /"prompt_token_details":\{\}/);
  }
  for (const raw of [null, [], 'bad', 4]) await assert.rejects(run([{items: [row(root, {prompt_token_details: {raw}})]}]), /invalid_usage_details/);
});
test('finished pagination explicitly does not attest to omitted out-of-window descendants', async () => {
  const source = [row(), row(child, {start_time: '2026-11-06T00:00:01Z', end_time: '2026-11-06T00:00:02Z'})];
  const {result} = await run([(_, init) => {
    const body = JSON.parse(init.body);
    return json({items: source.filter(r => Date.parse(r.start_time) >= Date.parse(body.min_start_time) && Date.parse(r.start_time) < Date.parse(body.max_start_time)), next_cursor: ''});
  }]);
  assert.equal(result.stageReceipt.batches, 1);
  assert.equal(result.traceMembershipVerified, false);
  assert.deepEqual(result.report.sourceCoverage, {paginationComplete: true, traceMembershipVerified: false});
  assert.equal(result.coverage, 'returned-completed-runs-in-selected-traces-and-window');
  assert.match(result.report.losses.join(' '), /Descendants outside.*may be omitted/);
});
test('interrupted read resumes cursor; complete checkpoint requires no provider calls and remains scope-bound', async () => {
  const directory = temp();
  try {
    const first = fakeOptions([{items: [row()], next_cursor: 'next'}, Error(key)]);
    await assert.rejects(runPrivateLangsmithImport(spec, {...first.options, directory}), /langsmith_transport_failed/);
    assert.equal(JSON.parse(readFileSync(join(directory, 'checkpoint.json'))).pages.length, 1);
    assert.equal(statSync(join(directory, 'checkpoint.json')).mode & 0o777, 0o600);
    const second = fakeOptions([{items: [row(child)]}]);
    const result = await runPrivateLangsmithImport(spec, {...second.options, directory}); assert.equal(result.stageReceipt.batches, 2);
    assert.equal(JSON.parse(second.requests.at(-1).init.body).cursor, 'next');
    const restart = fakeOptions([]); assert.equal((await runPrivateLangsmithImport(spec, {...restart.options, directory})).transport.requests, 0);
    await assert.rejects(runPrivateLangsmithImport({...spec, content: 'include'}, {...restart.options, directory}), /scope_mismatch/);
    assert.doesNotMatch(readTree(directory), new RegExp(marker + '|' + key));
  } finally {rmSync(directory, {recursive: true, force: true});}
});
for (const [label, pages, change, expected] of [
  ['cursor type', [{items: [row()], next_cursor: {secret: 'x'}}], {}, /cursor_invalid/],
  ['cursor cycle', [{items: [row()], next_cursor: 'a'}, {items: [row()], next_cursor: 'a'}], {}, /cursor_cycle/],
  ['empty continuation', [{items: [], next_cursor: 'a'}], {}, /cursor_cycle/],
  ['legacy response', [{runs: [row()], cursors: {next: 'a'}}], {}, /page_invalid/],
  ['page overflow', [{items: [row(), row(child), row(third)]}], {}, /page_invalid/],
  ['row cap', [{items: [row()], next_cursor: 'a'}], {maxRows: 1}, /bound_incomplete/],
  ['page cap', [{items: [row()], next_cursor: 'a'}], {maxPages: 1}, /bound_incomplete/],
  ['wrong project', [{items: [row(root, {project_id: third})]}], {}, /scope_mismatch/],
  ['wrong trace', [{items: [row(root, {trace_id: third})]}], {}, /scope_mismatch/],
  ['missing root', [{items: [row(child)]}], {}, /requested_root_missing/],
  ['missing ancestor', [{items: [row(), row(child, {parent_run_ids: [root, third]})]}], {}, /ancestor_missing/],
  ['ancestor cycle', [{items: [row(), row(child, {parent_run_ids: [root, child]})]}], {}, /invalid_ancestors/],
  ['unfinished run', [{items: [row(root, {end_time: null})]}], {}, /unfinished_run/],
  ['pending status', [{items: [row(root, {status: 'PENDING'})]}], {}, /unfinished_run/],
  ['changed duplicate', [{items: [row(), row(root, {status: 'ERROR'})]}], {}, /changed_duplicate/],
  ['credential echo', [{items: [row(root, {outputs: {key}})]}], {}, /credential_echo/],
  ['bad timestamp', [{items: [row(root, {start_time: '2026-02-30T00:00:00Z'})]}], {}, /invalid_timestamp/],
  ['too narrow window', [{items: [row()]}], {maxStartTime: '2026-11-04T00:00:02Z'}, /outside_window/],
  ['child outside root', [{items: [row(), row(child, {end_time: '2026-11-04T00:00:03Z'})]}], {}, /outside_root/],
  ['unsafe usage', [{items: [row(child, {prompt_tokens: Number.MAX_SAFE_INTEGER + 1})]}], {}, /invalid_usage/],
  ['legacy nested rows', [{items: [row(root, {child_runs: []})]}], {}, /legacy_structure/],
  ['oversized content event', [{items: [row(root, {inputs: {text: 'x'.repeat(40000)}})]}], {content: 'include'}, /conversion_rejected/],
]) test('refuses ' + label, async () => {await assert.rejects(run(pages, change), expected);});
test('identical duplicates deduplicate across pages; complete ancestor chains are retained', async () => {
  const {result} = await run([{items: [row(third, {parent_run_ids: [root, child]})], next_cursor: 'a'}, {items: [row(), row(child)], next_cursor: 'b'}, {items: [row()]}]);
  assert.equal(result.stageReceipt.batches, 3); assert.equal(result.report.duplicateRows, 1); assert.deepEqual(result.report.warnings, []);
});
for (const [label, extra, expected] of [
  ['denied source', {authorize: async () => false}, /action_not_authorized/],
  ['throwing credentials', {credentialProvider: async () => {throw Error(key);}}, /credential_unavailable/],
  ['wrong project lease', {credentialProvider: async () => ({...lease(), projectId: third})}, /binding_or_lease/],
  ['wrong workspace lease', {credentialProvider: async () => ({...lease(), workspaceId: third})}, /binding_or_lease/],
  ['expired lease', {credentialProvider: async () => ({...lease(), expiresAt: Date.now() - 1})}, /binding_or_lease/],
  ['wrong verified workspace', {fetchImpl: async () => json({id: sourceProject, tenant_id: third})}, /verified_project_mismatch/],
  ['redirect', {fetchImpl: async () => new Response('', {status: 302, headers: {location: 'https://evil.example'}})}, /redirect_refused/],
  ['oversized declared response', {fetchImpl: async () => json({}, {'content-length': '999999999'})}, /response_bound/],
  ['wrong content type', {fetchImpl: async () => new Response(key)}, /json_required/],
  ['invalid UTF8', {fetchImpl: async () => new Response(Uint8Array.from([255]), {headers: {'content-type': 'application/json'}})}, /invalid_utf8/],
  ['request timeout', {fetchImpl: async () => new Promise(() => {}), bounds: {...LANGSMITH_TRANSPORT_BOUNDS, requestTimeoutMs: 10}}, /operation_timeout/],
]) test('secure transport rejects ' + label, async () => {await assert.rejects(run([], {}, extra), expected);});
test('429/5xx retries are bounded and error bodies never reach disk', async () => {
  const rate = () => new Response(key, {status: 429, headers: {'retry-after': '0'}});
  const {result, disk} = await run([rate, {items: [row()]}]); assert.equal(result.transport.requests, 4); assert.ok(!disk.includes(key));
  await assert.rejects(run([rate, rate, rate]), /source_request_failed/);
  await assert.rejects(run([() => new Response('', {status: 503, headers: {'retry-after': '999999'}})]), /retry_after_exceeds_budget/);
});
test('failed checkpoint cannot fetch a subsequent page', async () => {
  let requests = 0;
  await assert.rejects(captureLangsmith(spec, {transport: {checkpoint: (state, save) => save(state), request: async () => {requests++; return {status: 200, data: {items: [row()], next_cursor: 'a'}};}}, saveCheckpoint: async () => {throw Error('disk full');}}), /disk full/);
  assert.equal(requests, 1);
});
test('close and cancellation interrupt a stalled wire or authorization and cannot stage', async () => {
  let entered; const ready = new Promise(resolve => entered = resolve);
  const fake = fakeOptions([], {authorize: async () => {entered(); return new Promise(() => {});}}), transport = createLangsmithTransport(spec, fake.options);
  const pending = assert.rejects(transport.request(root, null), /cancelled/); await ready; transport.close(); await pending; assert.equal(fake.requests.length, 0);
  const controller = new AbortController(); let signal;
  await assert.rejects(run([], {}, {fetchImpl: async (_, init) => {signal = init.signal; controller.abort(); return new Promise(() => {});}, signal: controller.signal}), /cancelled/);
  assert.equal(signal.aborted, true);
});
test('malformed/tampered checkpoints and interrupted atomic writes fail closed', async () => {
  for (const file of ['checkpoint.json', 'checkpoint.json.tmp', '.live-import.lock']) {
    const directory = temp(), fake = fakeOptions([{items: [row()]}]);
    try {writeFileSync(join(directory, file), '{}', {mode: 0o600}); await assert.rejects(runPrivateLangsmithImport(spec, {...fake.options, directory})); assert.ok(!readdirSync(directory).includes('stage-receipt.json'));}
    finally {rmSync(directory, {recursive: true, force: true});}
  }
});
test('denied destination leaves only a private checkpoint', async () => {
  const directory = temp(), fake = fakeOptions([{items: [row()]}], {authorize: async d => d.action !== 'stage-destination'});
  try {await assert.rejects(runPrivateLangsmithImport(spec, {...fake.options, directory}), /action_not_authorized/); assert.deepEqual(readdirSync(directory), ['checkpoint.json']);}
  finally {rmSync(directory, {recursive: true, force: true});}
});
test('wire count, streamed bytes and checkpoint bounds stop before staging', async () => {
  await assert.rejects(run([{items: [row()]}], {}, {bounds: {...LANGSMITH_TRANSPORT_BOUNDS, maxRequests: 1}}), /transport_budget/);
  await assert.rejects(run([{items: [row()]}], {}, {bounds: {...LANGSMITH_TRANSPORT_BOUNDS, maxResponseBytes: 80}}), /response_bound/);
  await assert.rejects(run([{items: [row()]}], {maxBytes: 10}), /checkpoint_bounds/);
});
test('credential bridge receives workspace binding; expiry during verification cannot fetch rows', async () => {
  let now = 1000000, reads = 0;
  const fake = fakeOptions([], {now: () => now,
    credentialProvider: async binding => {assert.deepEqual(binding, {origin: spec.origin, workspaceId: sourceWorkspace, projectId: sourceProject}); return {...lease(), expiresAt: now + 100};},
    fetchImpl: async () => {reads++; now += 101; return json({id: sourceProject, tenant_id: sourceWorkspace});},
  });
  const transport = createLangsmithTransport(spec, fake.options);
  try {await assert.rejects(transport.request(root, null), /credential_expired/); assert.equal(reads, 1);}
  finally {transport.close();}
});
test('body timeout and checkpoint timeout stop independently of dependencies honoring abort', async () => {
  await assert.rejects(run([], {}, {fetchImpl: async () => new Response(new ReadableStream({pull: () => new Promise(() => {})}), {headers: {'content-type': 'application/json'}}), bounds: {...LANGSMITH_TRANSPORT_BOUNDS, requestTimeoutMs: 15}}), /operation_timeout/);
  const fake = fakeOptions([{items: [row()], next_cursor: 'next'}], {bounds: {...LANGSMITH_TRANSPORT_BOUNDS, requestTimeoutMs: 15}}), transport = createLangsmithTransport(spec, fake.options);
  try {await assert.rejects(captureLangsmith(spec, {transport, saveCheckpoint: async () => new Promise(() => {})}), /operation_timeout/); assert.equal(fake.requests.length, 2);}
  finally {transport.close();}
});
test('CLI binds flags, nonsecret spec and a bounded piped workspace/project lease', async () => {
  const directory = temp(), path = join(directory, 'spec.json'), workspace = join(directory, 'workspace'), fake = fakeOptions([{items: [row()]}]);
  writeFileSync(path, JSON.stringify(spec)); const input = () => Readable.from([Buffer.from(JSON.stringify(lease()))]);
  try {
    for (const flags of [[], ['--fetch'], ['--fetch', '--stage', '--include-content'], ['--fetch', '--stage', '--token=' + key]]) await assert.rejects(langsmithImportMain([path, workspace, ...flags], {stdin: input(), fetchImpl: fake.options.fetchImpl}));
    assert.equal(fake.requests.length, 0);
    assert.equal((await langsmithImportMain([path, workspace, '--fetch', '--stage'], {stdin: input(), fetchImpl: fake.options.fetchImpl})).stageReceipt.batches, 1);
    assert.doesNotMatch(readTree(workspace), new RegExp(key));
    await assert.rejects(langsmithImportMain([path, workspace, '--fetch', '--stage'], {stdin: Readable.from([Buffer.from('x'.repeat(4097))]), fetchImpl: fake.options.fetchImpl}), /credential_pipe_failed/);
  } finally {rmSync(directory, {recursive: true, force: true});}
});
