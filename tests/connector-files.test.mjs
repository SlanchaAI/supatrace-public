import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {convertConnectorFile, FILE_FORMATS, CONNECTOR_LIMITS} from '../src/importers/connector-files.mjs';
import {stageConnectorFile} from '../agent/import_traces.mjs';
import {parseBatch} from '../src/trace.mjs';
import {fixtures, marker, otlp, child, root} from './connector-fixtures.mjs';
const project = 'proj_' + 'a'.repeat(32);
const convert = (format, value = fixtures[format](), options = {}) => convertConnectorFile(JSON.stringify(value), {format, namespace: 'synthetic-project', ...options});
const allEvents = result => result.batches.flatMap(b => b.events);
for (const format of FILE_FORMATS) {
  test(format + ': source records, parent, nanoseconds and token ownership', () => {
    const result = convert(format, undefined, {content: 'include'});
    assert.deepEqual(result.report.rejected, []); assert.equal(result.batches.length, 2);
    for (const batch of result.batches) parseBatch(JSON.stringify(batch));
    const events = allEvents(result);
    assert.equal(events.filter(e => e.data.span.parentSpanId).length, format === 'helicone' ? 0 : 1);
    assert.ok(events.every(e => e.data.original));
    assert.equal(events.filter(e => e.data.span.usage).length, format === 'helicone' ? 2 : 1, 'parent aggregate usage is not counted');
    assert.match(JSON.stringify(events), new RegExp(marker));
    assert.deepEqual(convert(format, undefined, {content: 'include'}), result);
  });
  test(format + ': metadata projection excludes content and arbitrary attributes', () => {
    const result = convert(format);
    assert.equal(result.batches.length, 2); assert.deepEqual(result.report.rejected, []);
    assert.ok(!JSON.stringify(result).includes(marker));
    assert.ok(allEvents(result).every(e => e.data.original === undefined && e.data.context === undefined));
    assert.equal(allEvents(result).filter(e => e.data.span.parentSpanId).length, format === 'helicone' ? 0 : 1);
  });
}
test('vendored code integrity and MIT notice match the pinned source manifest', () => {
  const base = new URL('../src/importers/vendor/hue/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('provenance.json', base)));
  assert.equal(manifest.revision, '4ac88431eab76b4e12737c1b279dc58dbed87bf8');
  for (const file of manifest.generated) assert.equal(createHash('sha256').update(readFileSync(new URL(file.file, base))).digest('hex'), file.sha256);
  assert.match(readFileSync(new URL('LICENSE', base), 'utf8'), /Copyright \(c\) 2026 Hue contributors/);
});
test('OTLP keeps original typed attributes, resource/scope version/schema, events and links', () => {
  const input = otlp(), result = convert('otlp', input, {content: 'include'});
  const source = input.resourceSpans[0], scope = source.scopeSpans[0];
  const {scopeSpans, ...resourceContext} = source; const {spans, ...scopeContext} = scope;
  for (const event of allEvents(result)) {
    assert.deepEqual(event.data.original, {resource: resourceContext, scope: scopeContext, span: spans.find(s => s.spanId === event.data.span.spanId)});
    assert.equal(event.data.span.startTimeUnixNano, '1767323045123456789');
  }
});
test('duplicates and input ordering are stable; conflicts and cyclic traces fail closed', () => {
  const rows = fixtures.langsmith(); const baseline = convert('langsmith', rows);
  const duplicate = convert('langsmith', [...rows, rows[0]]);
  assert.equal(duplicate.report.duplicateRows, 1); assert.deepEqual(duplicate.batches, baseline.batches);
  assert.deepEqual(convert('langsmith', [...rows].reverse()).batches, baseline.batches);
  assert.ok(convert('langsmith', [...rows, {...rows[0], outputs: {changed: true}}]).report.rejected.length);
  assert.ok(convert('langsmith', [rows[0], {...rows[1], parent_run_id: 'child'}]).report.rejected.length);
});
test('nested LangSmith child_runs flatten with complete records retained', () => {
  const [childRow, rootRow] = fixtures.langsmith();
  const result = convert('langsmith', {...rootRow, child_runs: [childRow]}, {content: 'include'});
  assert.equal(result.batches.length, 2); assert.deepEqual(result.report.rejected, []);
  assert.deepEqual(allEvents(result).find(e => e.data.span.spanId === 'child').data.original, childRow);
});
test('overlapping MLflow traces preserve repeated span events exactly once per source array', () => {
  const input = fixtures.mlflow(), event = {name: marker, time_unix_nano: '1767323045123456789', attributes: {a: 1}};
  input.data.spans[0].events = [event, event];
  const one = convert('mlflow', input, {content: 'include'}), overlap = convert('mlflow', [input, input], {content: 'include'});
  assert.deepEqual(overlap.report.rejected, []); assert.deepEqual(overlap.batches, one.batches);
  assert.equal(allEvents(overlap).find(e => e.data.span.spanId === root).data.original.events.length, 2);
});
test('Braintrust logs require stable source IDs and preserve distinct identical occurrences', () => {
  const rows = fixtures.braintrust(), log = {id: 'log1', span_id: 'child', root_span_id: 'trace', span_attributes: {type: 'log'}, output: marker};
  const input = [...rows, log, {...log, id: 'log2'}], one = convert('braintrust', input, {content: 'include'});
  assert.deepEqual(one.report.rejected, []);
  assert.deepEqual(convert('braintrust', [...input, ...input].reverse(), {content: 'include'}).batches, one.batches);
  assert.equal(allEvents(one).find(e => e.data.span.spanId === 'child').data.attachedEvents.length, 2);
  const {id, ...noId} = log; assert.ok(convert('braintrust', [...rows, noId]).report.rejected.length);
});
test('JSONL is explicit; oversized/deep/malformed files and missing scope are rejected', () => {
  const raw = fixtures.langsmith().map(JSON.stringify).join('\n');
  assert.throws(() => convertConnectorFile(raw, {format: 'langsmith', namespace: 'x'}));
  assert.equal(convertConnectorFile(raw, {format: 'langsmith', namespace: 'x', encoding: 'jsonl'}).batches.length, 2);
  for (const options of [{format: 'missing', namespace: 'x'}, {format: 'langsmith'}, {format: 'langsmith', namespace: 'x', content: 'all'}]) assert.throws(() => convertConnectorFile('{}', options));
  assert.throws(() => convertConnectorFile(' '.repeat(CONNECTOR_LIMITS.inputBytes + 1), {format: 'otlp', namespace: 'x'}), /input_too_large/);
  assert.throws(() => convert('langsmith', {...fixtures.langsmith()[0], input: JSON.parse('['.repeat(25) + '0' + ']'.repeat(25))}), /nesting/);
  assert.ok(convert('langsmith', [{id: 'bad', run_type: 'llm'}]).report.rejected.length);
  assert.ok(convert('langsmith', [{...fixtures.langsmith()[0], inputs: {big: 'x'.repeat(32768)}}], {content: 'include'}).report.rejected.length);
  assert.throws(() => convert('langsmith', Array.from({length: 1001}, (_, i) => ({id: String(i), trace_id: 'trace', run_type: 'chain', start_time: '2026-01-01T00:00:00Z'}))), /too_many_batches/);
});
for (const [label, mutate] of [
  ['zero id', s => s.spanId = '0'.repeat(16)], ['bad parent', s => s.parentSpanId = 'x'],
  ['numeric timestamp', s => s.startTimeUnixNano = 123], ['int64 range', s => s.attributes.push({key: 'bad', value: {intValue: '9223372036854775808'}})],
  ['wrong enum', s => s.kind = 'SPAN_KIND_INTERNAL'], ['end before start', s => s.endTimeUnixNano = '1'],
  ['duplicate attr', s => s.attributes.push(s.attributes[0])], ['multi AnyValue', s => s.attributes[0].value.intValue = '4'],
  ['bad base64', s => s.attributes[0].value = {bytesValue: '==='}], ['bad status', s => s.status = {code: 99}],
]) test('OTLP rejects ' + label, () => {const input = otlp(); mutate(input.resourceSpans[0].scopeSpans[0].spans[0]); assert.ok(convert('otlp', input).report.rejected.length);});
test('unsafe integer literals retain decimal digits instead of rounding', () => {
  const input = JSON.stringify(otlp()).replace('"1767323045123456789"', '1767323045123456789');
  const result = convertConnectorFile(input, {format: 'otlp', namespace: 'x', content: 'include'});
  assert.deepEqual(result.report.rejected, []); assert.ok(result.report.warnings.includes('unsafe_integer_literals_preserved_as_decimal_strings'));
  assert.ok(allEvents(result).every(e => e.data.span.startTimeUnixNano === '1767323045123456789'));
});
test('private staging resumes identical input, blocks scope drift and retains pending files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'connectors-stage-'));
  try {
    const input = join(dir, 'source.json'), workspace = join(dir, 'work'); writeFileSync(input, JSON.stringify(otlp()));
    const opts = {format: 'otlp', namespace: 'fixture', destinationProject: project, directory: workspace};
    const first = await stageConnectorFile(input, opts), second = await stageConnectorFile(input, opts);
    assert.deepEqual(first, second); assert.equal(first.receipt.batches, 2);
    assert.equal(statSync(join(workspace, 'pending')).mode & 0o077, 0);
    const manifest = JSON.parse(readFileSync(join(workspace, 'pending/import-manifest.json')));
    for (const item of manifest.batches) { const bytes = readFileSync(join(workspace, 'pending', item.pending_file)); assert.equal(createHash('sha256').update(bytes).digest('hex'), item.request_hash); assert.ok(!bytes.includes(marker)); }
    await assert.rejects(stageConnectorFile(input, {...opts, content: 'include'}), /binding_changed/);
    await assert.rejects(stageConnectorFile(input, {...opts, destinationProject: 'proj_' + 'b'.repeat(32)}), /binding_changed/);
    assert.equal(JSON.parse(readFileSync(join(workspace, 'pending/import-manifest.json'))).count, 2);
  } finally {rmSync(dir, {recursive: true, force: true});}
});
test('no staging after invalid input, symlink, cancellation, occupied lock or write failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'connectors-fail-'));
  try {
    const input = join(dir, 'source.json'), workspace = join(dir, 'work'); writeFileSync(input, '{}');
    const opts = {format: 'otlp', namespace: 'fixture', destinationProject: project, directory: workspace};
    await assert.rejects(stageConnectorFile(input, opts), /conversion_rejected/);
    assert.deepEqual(readdirSync(dir), ['source.json']);
    writeFileSync(input, Buffer.concat([Buffer.from('{"x":"'), Buffer.from([0xff]), Buffer.from('"}') ]));
    await assert.rejects(stageConnectorFile(input, opts), /encoded data/);
    assert.deepEqual(readdirSync(dir), ['source.json']);
    writeFileSync(input, JSON.stringify(otlp())); const alias = join(dir, 'alias.json'); symlinkSync(input, alias);
    await assert.rejects(stageConnectorFile(alias, opts));
    const controller = new AbortController(); controller.abort(); await assert.rejects(stageConnectorFile(input, {...opts, signal: controller.signal}), /cancelled/);
    mkdirSync(workspace, {mode: 0o700}); writeFileSync(join(workspace, '.live-import.lock'), '{}', {mode: 0o600});
    await assert.rejects(stageConnectorFile(input, opts), /locked/); assert.deepEqual(readdirSync(workspace), ['.live-import.lock']);
    const blocked = join(dir, 'not-dir'); writeFileSync(blocked, 'occupied'); await assert.rejects(stageConnectorFile(input, {...opts, directory: blocked}));
  } finally {rmSync(dir, {recursive: true, force: true});}
});
