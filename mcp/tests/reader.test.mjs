import test from 'node:test';
import assert from 'node:assert/strict';
import {createTraceReader, validateScope} from '../reader.mjs';
import {fixture} from './fixture.mjs';
const scope = {origin: 'https://supatrace.dev', tenantId: 'github-1', projectId: 'proj_' + '1'.repeat(32), content: 'metadata'};
const lease = () => ({origin: scope.origin, tenantId: scope.tenantId, projectId: scope.projectId, sessionToken: 't'.repeat(43), expiresAt: Date.now() + 60000});
const json = value => new Response(JSON.stringify(value), {headers: {'content-type': 'application/json'}});
const base = overrides => ({credentialProvider: async () => lease(), authorize: async () => true, fetchImpl: async () => json({tenant_id: scope.tenantId, project_id: scope.projectId}), ...overrides});

test('rejects extra scope fields, custom origins and malformed project/trace allowlists', () => {
  for (const change of [{origin: 'http://127.0.0.1'}, {origin: 'https://evil.example'}, {token: 'secret'}, {projectId: 'bad'}, {content: undefined}, {runIds: []}, {runIds: ['same', 'same']}, {runIds: ['../bad']}]) assert.throws(() => validateScope({...scope, ...change}), /invalid_scope/);
});
test('invalid tool arguments and content escalations produce zero source requests', async () => {
  let calls = 0; const reader = createTraceReader(scope, base({fetchImpl: async () => {calls++; throw Error('unexpected');}}));
  for (const [tool, args] of [['delete', {}], ['supatrace_list_traces', {projectId: scope.projectId}], ['supatrace_list_traces', {query: '*'}], ['supatrace_list_traces', {limit: 101}], ['supatrace_inspect_trace', {runId: '../bad'}], ['supatrace_export_trace', {runId: 'valid', includeContent: true}]]) await assert.rejects(reader.execute(tool, args));
  assert.equal(calls, 0);
});
for (const change of [{origin: 'https://supatrace.tech'}, {tenantId: 'github-2'}, {projectId: 'proj_' + '2'.repeat(32)}, {expiresAt: 0}, {expiresAt: Date.now() + 3600000}, {sessionToken: 't; other=bad'}, {extra: true}]) test('refuses mismatched/expired lease ' + Object.keys(change)[0] + JSON.stringify(change).length, async () => {
  let calls = 0; const reader = createTraceReader(scope, base({credentialProvider: async () => ({...lease(), ...change}), fetchImpl: async () => {calls++;}}));
  await assert.rejects(reader.execute('supatrace_list_traces'), /read_access_unavailable/); assert.equal(calls, 0);
});
test('denied authorization and mismatched current tenant fail before trace access', async () => {
  const denied = createTraceReader(scope, base({authorize: async () => false})); await assert.rejects(denied.execute('supatrace_list_traces'), /read_access_unavailable/);
  const mismatch = createTraceReader(scope, base({fetchImpl: async () => json({tenant_id: 'foreign', project_id: scope.projectId})})); await assert.rejects(mismatch.execute('supatrace_list_traces'), /scope_mismatch/);
});
test('a real foreign session cannot read the scoped tenant, even with a matching lease descriptor', async () => {
  const env = await fixture({foreignLease: true}); try {await assert.rejects(env.reader.execute('supatrace_list_traces'), /read_access_unavailable/); assert.equal(env.requests.length, 1);} finally {await env.close();}
});
for (const response of [() => new Response('PRIVATE_ERROR', {status: 429}), () => new Response('PRIVATE_ERROR', {status: 500}), () => new Response('bad', {headers: {'content-type': 'text/html'}}), () => new Response('x'.repeat(1048577), {headers: {'content-type': 'application/json'}}), () => json({token: 't'.repeat(43)}), () => new Response(new Uint8Array([255]), {headers: {'content-type': 'application/json'}})]) test('bounds/validates wire responses and hides source errors ' + response.toString().slice(0,65), async () => {
  const reader = createTraceReader(scope, base({fetchImpl: async () => response()}));
  await assert.rejects(reader.execute('supatrace_list_traces'), error => !/PRIVATE_ERROR|tttttt/.test(error.message));
});
test('hung credentials and fetches settle on deadline; close cancels pending reads', async () => {
  for (const dependency of ['credentialProvider', 'authorize', 'fetchImpl']) {
    const reader = createTraceReader(scope, base({[dependency]: () => new Promise(() => {}), timeoutMs: 15}));
    await assert.rejects(reader.execute('supatrace_list_traces'), /deadline/);
  }
  const reader = createTraceReader(scope, base({fetchImpl: () => new Promise(() => {})}));
  const pending = reader.execute('supatrace_list_traces'); await assert.rejects(reader.execute('supatrace_list_traces'), /reader_busy/);
  reader.close(); await assert.rejects(pending, /cancelled/); await assert.rejects(reader.execute('supatrace_list_traces'), /reader_closed/);
});
test('run allowlist and metadata export are enforced through actual storage', async () => {
  const env = await fixture({runIds: ['other']});
  try {assert.equal((await env.reader.execute('supatrace_list_traces')).total, 0); await assert.rejects(env.reader.execute('supatrace_inspect_trace', {runId: 'mcp-proof'}), /trace_not_available/);} finally {await env.close();}
  const allowed = await fixture();
  try {const result = await allowed.reader.execute('supatrace_export_trace', {runId: 'mcp-proof'}); assert.equal(JSON.parse(result.json).format, 'supatrace-metadata-v1'); assert.doesNotMatch(result.json, /PRIVATE_/);} finally {await allowed.close();}
});
test('search scans beyond the first 800 catalog rows and rejects foreign project pages', async () => {
  const rows = Array.from({length: 801}, (_, i) => ({id: 'trace' + String(i).padStart(3, '0'), created_at: '2026-01-01T00:00:00Z', started_at: null, ended_at: null, duration_ms: null, event_count: 0, batch_count: 0, byte_count: 0, agents: [], status: null}));
  let calls = 0;
  const reader = createTraceReader(scope, base({fetchImpl: async url => {
    calls++;
    if (url.includes('/me?')) return json({tenant_id: scope.tenantId, project_id: scope.projectId});
    const last = url.includes('after=last');
    return json({project_id: scope.projectId, runs: last ? rows.slice(800) : rows.slice(0, 800), next: last ? null : 'last', complete: last});
  }}));
  const found = await reader.execute('supatrace_search_traces', {query: 'trace800'});
  assert.equal(found.total, 1); assert.equal(found.runs[0].id, 'trace800'); assert.equal(calls, 3);
  const bad = createTraceReader(scope, base({fetchImpl: async url => url.includes('/me?') ? json({tenant_id: scope.tenantId, project_id: scope.projectId}) : json({project_id: 'proj_' + '2'.repeat(32), runs: rows.slice(0, 1), next: null, complete: true})}));
  await assert.rejects(bad.execute('supatrace_search_traces', {query: 'trace'}));
});
