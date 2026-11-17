import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough, Writable} from 'node:stream';
import {createTraceReader} from '../reader.mjs';
import {boundedStdio} from '../bounded-stdio.mjs';
const scope = {origin: 'https://supatrace.dev', tenantId: 'github-1', projectId: 'proj_' + '1'.repeat(32), content: 'include'};
const token = 's'.repeat(43), json = value => new Response(JSON.stringify(value), {headers: {'content-type': 'application/json'}});
const event = (value = 1) => ({id: 'repeated-id', time: '2026-01-01T00:00:00Z', kind: 'note', name: 'PRIVATE_NAME', data: {value}});
const run = {id: 'trace', created_at: '2026-01-01T00:00:00Z', started_at: null, ended_at: null, duration_ms: null, event_count: 1, batch_count: 1, byte_count: 100, agents: [], status: 'ok'};
function fake({pages = [{events: [event()], next: null}], row = run, secondRow = row, pageChange, extra = {}} = {}) {
  let catalogs = 0, events = 0;
  return createTraceReader(scope, {authorize: async () => true,
    ...extra,
    // Keep the lease exactly to its explicit schema.
    credentialProvider: extra.credentialProvider ?? (async () => ({origin: scope.origin, tenantId: scope.tenantId, projectId: scope.projectId, sessionToken: token, expiresAt: Date.now() + 60000})),
    fetchImpl: async url => {
      const path = new URL(url).pathname;
      if (path.endsWith('/me')) return json({tenant_id: scope.tenantId, project_id: scope.projectId});
      if (path.endsWith('/runs/page')) return json({project_id: scope.projectId, runs: [catalogs++ ? secondRow : row], next: null, complete: true});
      const value = pages[events++]; return pageChange ? pageChange(value) : json(value);
    }});
}
test('empty terminal pages do not count as batches; metadata projects only named fields', async () => {
  const reader = fake({pages: [{events: [event()], next: 'last'}, {events: [], next: null}], row: {...run, arbitrary_content: 'PRIVATE_LEAK'}});
  const list = await reader.execute('supatrace_list_traces'); assert.doesNotMatch(JSON.stringify(list), /PRIVATE_/);
  const result = await reader.execute('supatrace_export_trace', {runId: 'trace', includeContent: true});
  assert.deepEqual(JSON.parse(result.json).events, [event()]);
});
test('original export preserves cross-batch duplicate IDs and order accepted by the existing intake', async () => {
  const reader = fake({row: {...run, event_count: 2, batch_count: 2}, pages: [{events: [event(1)], next: 'second'}, {events: [event(2)], next: null}]});
  const result = await reader.execute('supatrace_export_trace', {runId: 'trace', includeContent: true});
  assert.deepEqual(JSON.parse(result.json).events, [event(1), event(2)]);
});
test('cursor cycles, inconsistent counts and catalog changes return no partial export', async () => {
  for (const config of [{pages: [{events: [event()], next: 'again'}, {events: [], next: 'again'}]}, {row: {...run, event_count: 2}}, {secondRow: {...run, byte_count: 101}}]) {
    const reader = fake(config); await assert.rejects(reader.execute('supatrace_export_trace', {runId: 'trace'}), /invalid_source_data/);
  }
});
test('source row count and original export byte limits fail closed', async () => {
  await assert.rejects(fake({row: {...run, event_count: 1001}}).execute('supatrace_inspect_trace', {runId: 'trace'}), /limit_exceeded/);
  const events = Array.from({length: 10}, (_, i) => ({...event(), id: 'e' + i, data: {text: 'x'.repeat(30000)}}));
  await assert.rejects(fake({row: {...run, event_count: 10}, pages: [{events, next: null}]}).execute('supatrace_export_trace', {runId: 'trace', includeContent: true}), /limit_exceeded/);
});
test('lease is checked again after a response and hung stream reads are cancelled', async () => {
  const lease = {origin: scope.origin, tenantId: scope.tenantId, projectId: scope.projectId, sessionToken: token, expiresAt: Date.now() + 15};
  const reader = fake({extra: {credentialProvider: async () => lease}, pageChange: async value => {await new Promise(resolve => setTimeout(resolve, 25)); return json(value);}});
  await assert.rejects(reader.execute('supatrace_inspect_trace', {runId: 'trace'}), /read_access_unavailable/);
  let cancelled = false;
  const hung = fake({extra: {timeoutMs: 20}, pageChange: () => new Response(new ReadableStream({cancel() {cancelled = true;}}), {headers: {'content-type': 'application/json'}})});
  await assert.rejects(hung.execute('supatrace_inspect_trace', {runId: 'trace'}), /deadline/); assert.equal(cancelled, true);
});
test('caller argument mutations cannot escalate content after validation', async () => {
  const env = fake(), args = {runId: 'trace'};
  const pending = env.execute('supatrace_inspect_trace', args); args.includeContent = true;
  const result = await pending; assert.equal(result.content, 'metadata'); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_NAME/);
});
test('provider lease mutations cannot change credentials after scope verification', async () => {
  const lease = {origin: scope.origin, tenantId: scope.tenantId, projectId: scope.projectId, sessionToken: token, expiresAt: Date.now() + 60000};
  const reader = fake({extra: {credentialProvider: async () => lease}, pageChange: value => {lease.sessionToken = 'different'; lease.expiresAt = 0; return json(value);}});
  assert.equal((await reader.execute('supatrace_inspect_trace', {runId: 'trace'})).complete, true);
});
test('TLS bypass configuration is rejected before any credential operation', () => {
  const prior = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  try {process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; assert.throws(() => fake(), /read_access_unavailable/);}
  finally {if (prior === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prior;}
});
test('stdio output stalls close and abort instead of growing listeners/backlog', async () => {
  const input = new PassThrough(), output = new Writable({highWaterMark: 1, write(chunk, encoding, done) {}}); let aborted = 0;
  const transport = boundedStdio(input, output, () => aborted++, {writeTimeoutMs: 20});
  await transport.start();
  const results = await Promise.allSettled(Array.from({length: 100}, (_, id) => transport.send({jsonrpc: '2.0', id, result: {}})));
  assert.ok(results.some(r => r.status === 'rejected')); assert.equal(aborted, 1); assert.ok(output.listenerCount('drain') <= 1); assert.ok(output.writableLength < 1024);
  await transport.close(); input.destroy(); output.destroy();
});
test('a single undrained response is bounded by a write deadline', async () => {
  const input = new PassThrough(), output = new Writable({highWaterMark: 1, write() {}}); let aborted = false;
  const transport = boundedStdio(input, output, () => {aborted = true;}, {writeTimeoutMs: 15}); await transport.start();
  await assert.rejects(transport.send({jsonrpc: '2.0', id: 1, result: {}}), /stalled/); assert.equal(aborted, true);
  input.destroy(); output.destroy();
});
test('stdio oversize message and connection frame limits close the connection', async () => {
  for (const data of ['x'.repeat(16385), '{}\n'.repeat(1001)]) {
    const input = new PassThrough(), output = new PassThrough(); let aborted = false;
    const transport = boundedStdio(input, output, () => {aborted = true;}); transport.onerror = () => {};
    await transport.start(); input.write(data); await new Promise(resolve => setImmediate(resolve));
    assert.equal(aborted, true); input.destroy(); output.destroy();
  }
});
