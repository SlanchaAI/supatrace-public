// Langfuse-compatible ingest: real handler and store logic (in-memory adapter) with request
// bodies captured from stock Langfuse SDKs (tests/fixtures/langfuse).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {start} from './harness.mjs';
import {handle} from '../src/aws-api.mjs';
import {digest} from '../src/aws-auth.mjs';
import {decodeTraceRequest} from '../src/otlp-protobuf.mjs';
import {planLangfuseBatches, langfuseRunId, LANGFUSE_LIMITS, LANGFUSE_STORED_TYPES} from '../src/langfuse-ingest.mjs';

const fixture = name => readFileSync(new URL('./fixtures/langfuse/' + name, import.meta.url));
const jsBatch = fixture('js-3.39.2-ingestion.json'), pythonOtel = fixture('python-5.2.0-otel-protobuf.bin.gz');
const basic = (secret, user = 'pk-supatrace') => 'Basic ' + Buffer.from(user + ':' + secret).toString('base64');
async function session(live, id) { let cookie = ''; const tenant = await live.signIn({addCookies: async value => { cookie = value.map(c => c.name + '=' + c.value).join('; '); }}, id); return {tenant, cookie, key: await live.writeKey(tenant)}; }
async function events(live, cookie, run) {
  const out = []; let after = '';
  for (let page = 0; page < 20; page++) {
    const r = await fetch(live.origin + '/api/events?run=' + encodeURIComponent(run) + (after ? '&after=' + encodeURIComponent(after) : ''), {headers: {cookie}});
    assert.equal(r.status, 200); const body = await r.json(); out.push(...body.events); if (!body.next) return out; after = body.next;
  }
  throw Error('too many pages');
}
const ingest = (live, body, authorization, headers = {}) => fetch(live.origin + '/api/public/ingestion', {method: 'POST', headers: {'content-type': 'application/json', ...(authorization ? {authorization} : {}), ...headers}, body});
const event = (type, body, id = type + '-1') => ({id, type, timestamp: '2026-11-14T20:00:00.000Z', body});

test('stock Langfuse JS SDK batch is stored as one run and answered 207 with every event id', async () => {
  const live = await start(); try {
    const {cookie, key} = await session(live), sent = JSON.parse(jsBatch);
    const r = await ingest(live, jsBatch, basic(key));
    assert.equal(r.status, 207); const body = await r.json();
    assert.deepEqual(body.errors, []); assert.deepEqual(body.successes.map(s => s.id).sort(), sent.batch.map(e => e.id).sort()); assert.ok(body.successes.every(s => s.status === 201));
    const traceId = sent.batch.find(e => e.type === 'trace-create').body.id, run = 'lf.' + traceId;
    const row = (await (await fetch(live.origin + '/api/runs', {headers: {cookie}})).json()).runs.find(item => item.id === run);
    assert.equal(row.event_count, sent.batch.length); assert.equal(row.status, 'error'); assert.equal(row.batch_count, 1);
    const stored = await events(live, cookie, run);
    const generation = stored.find(e => e.data.type === 'generation-create');
    assert.equal(generation.kind, 'response'); assert.equal(generation.name, 'chat'); assert.equal(generation.data.source, 'langfuse'); assert.equal(generation.data.span.kind, 'llm'); assert.equal(generation.data.span.model, 'gpt-synthetic');
    assert.deepEqual(generation.data.langfuse.input, [{role: 'user', content: 'synthetic'}]);
    const update = stored.find(e => e.data.type === 'generation-update');
    assert.equal(update.data.span.update, true); assert.equal(update.data.span.spanId, generation.data.span.spanId); assert.deepEqual(update.data.span.usage, {input: 12, output: 7, total: 19}); assert.equal(update.data.langfuse.output, 'synthetic answer');
    const failed = stored.find(e => e.data.type === 'event-create'); assert.equal(failed.kind, 'error'); assert.equal(failed.data.span.status, 'error');
    const score = stored.find(e => e.data.type === 'score-create'); assert.deepEqual(score.data.span.score, {name: 'quality', value: 0.9});
    assert.equal(stored.filter(e => e.data.type === 'trace-create').length, 2);
    // The SDK retries a batch it believes failed; nothing is stored twice.
    const again = await ingest(live, jsBatch, basic(key)); assert.equal(again.status, 207); assert.equal((await again.json()).successes.length, sent.batch.length);
    assert.equal((await (await fetch(live.origin + '/api/runs', {headers: {cookie}})).json()).runs.find(item => item.id === run).event_count, sent.batch.length);
  } finally { await live.close(); }
});

test('stock Langfuse Python SDK OTLP export lands through /api/public/otel/v1/traces with Basic auth', async () => {
  const live = await start(); try {
    const {cookie, key} = await session(live);
    const send = authorization => fetch(live.origin + '/api/public/otel/v1/traces', {method: 'POST', headers: {'content-type': 'application/x-protobuf', 'content-encoding': 'gzip', authorization}, body: pythonOtel});
    const r = await send(basic(key, 'pk-lf-anything')); assert.equal(r.status, 200); assert.equal((await r.arrayBuffer()).byteLength, 0);
    const trace = decodeTraceRequest(gunzipSync(pythonOtel)).resourceSpans[0].scopeSpans[0].spans[0].traceId, stored = await events(live, cookie, 'otlp.' + trace);
    assert.equal(stored.length, 2); const generation = stored.find(e => e.name === 'chat');
    assert.equal(generation.kind, 'response'); assert.deepEqual({kind: generation.data.span.kind, model: generation.data.span.model, usage: generation.data.span.usage}, {kind: 'llm', model: 'gpt-synthetic', usage: {input: 12, output: 7, total: 19}});
    // A legacy score-create for an OpenTelemetry trace id joins the same run.
    const score = await ingest(live, JSON.stringify({batch: [event('score-create', {id: 's1', traceId: trace, name: 'quality', value: 1})]}), basic(key)); assert.equal(score.status, 207);
    assert.equal((await events(live, cookie, 'otlp.' + trace)).length, 3);
    assert.equal((await send(basic('b'.repeat(43)))).status, 401); assert.equal((await send('Basic !!!')).status, 401);
    // Basic auth is only honoured on the Langfuse-compatible routes.
    const plain = await fetch(live.origin + '/v1/traces', {method: 'POST', headers: {'content-type': 'application/x-protobuf', 'content-encoding': 'gzip', authorization: basic(key)}, body: pythonOtel}); assert.equal(plain.status, 401);
  } finally { await live.close(); }
});

test('connection checks, credentials and unsupported endpoints answer in the Langfuse error shape', async () => {
  const live = await start(); try {
    const {key} = await session(live);
    const projects = await fetch(live.origin + '/api/public/projects', {headers: {authorization: basic(key)}}); assert.equal(projects.status, 200);
    const data = (await projects.json()).data; assert.equal(data.length, 1); assert.match(data[0].id, /^proj_[a-f0-9]{32}$/); assert.equal(typeof data[0].organization.id, 'string'); assert.deepEqual(data[0].metadata, {});
    assert.equal((await fetch(live.origin + '/api/public/projects', {headers: {authorization: basic('b'.repeat(43))}})).status, 401);
    assert.equal((await (await fetch(live.origin + '/api/public/health')).json()).status, 'OK');
    const missing = await ingest(live, jsBatch, null); assert.equal(missing.status, 401); const m = await missing.json(); assert.equal(m.error, 'UnauthorizedError'); assert.match(m.message, /Basic auth/);
    const wrong = await ingest(live, jsBatch, basic('b'.repeat(43))); assert.equal(wrong.status, 401); assert.equal((await wrong.json()).code, 'invalid_write_key');
    assert.equal((await ingest(live, jsBatch, basic(''))).status, 401); assert.equal((await ingest(live, jsBatch, 'Basic ' + Buffer.from('no-colon').toString('base64'))).status, 401);
    // The write key also works as a bearer credential or x-supatrace-key, as on the other ingest routes.
    assert.equal((await ingest(live, jsBatch, 'Bearer ' + key)).status, 207); assert.equal((await ingest(live, jsBatch, null, {'x-supatrace-key': key})).status, 207);
    const scores = await fetch(live.origin + '/api/public/scores', {method: 'POST', headers: {'content-type': 'application/json', authorization: basic(key)}, body: '[]'});
    assert.equal(scores.status, 404); const s = await scores.json(); assert.equal(s.error, 'NotFoundError'); assert.match(s.message, /serves only/);
    assert.equal((await ingest(live, '{"batch":[]}', basic(key))).status, 400); assert.equal((await ingest(live, 'nope', basic(key))).status, 400); assert.equal((await ingest(live, '[]', basic(key))).status, 400);
    assert.equal((await fetch(live.origin + '/api/public/ingestion', {method: 'POST', headers: {'content-type': 'text/plain', authorization: basic(key)}, body: jsBatch})).status, 415);
    assert.equal((await ingest(live, Buffer.alloc(600000, 0x20), basic(key))).status, 413);
    assert.equal((await ingest(live, JSON.stringify({batch: Array.from({length: LANGFUSE_LIMITS.events + 1}, (_, i) => event('trace-create', {id: 't'}, 'e' + i))}), basic(key))).status, 413);
  } finally { await live.close(); }
});

test('per-event errors: unknown types, missing ids and oversized bodies are reported while the rest is stored', async () => {
  const live = await start(); try {
    const {cookie, key} = await session(live);
    const batch = [event('trace-create', {id: 'trace-a', name: 'kept'}, 'ok-1'), event('dataset-run-item-create', {id: 'x'}, 'bad-type'), event('span-create', {id: 'obs'}, 'no-trace'), event('span-create', {traceId: 'trace-a'}, 'no-id'),
      {id: 'bad-time', type: 'span-create', timestamp: 'yesterday', body: {id: 'o', traceId: 'trace-a'}}, {id: 'local-time', type: 'span-create', timestamp: '2026-11-14T20:00:00', body: {id: 'o2', traceId: 'trace-a'}}, event('span-create', {id: 'big', traceId: 'trace-a', metadata: Object.fromEntries(Array.from({length: 4000}, (_, i) => ['k' + i, 'v']))}, 'too-big'),
      event('generation-create', {id: 'long', traceId: 'trace-a', model: 'm', input: 'p'.repeat(60000)}, 'truncated'), event('sdk-log', {log: 'x'}, 'log-1'), event('trace-create', {id: 'trace-a'}, 'ok-1'), {type: 'trace-create', body: {id: 'trace-a'}}, 'not an object',
      event('span-create', {id: 'unsafe', traceId: 'trace-a', metadata: {n: 1e300}}, 'unsafe')];
    const r = await ingest(live, JSON.stringify({batch}), basic(key)); assert.equal(r.status, 207); const body = await r.json();
    assert.deepEqual(body.successes.map(s => s.id).sort(), ['log-1', 'ok-1', 'ok-1', 'truncated']);
    const errors = Object.fromEntries(body.errors.map(e => [e.id, e])); assert.equal(body.errors.length, 9); assert.match(errors['local-time'].message, /timezone/);
    assert.match(errors['bad-type'].message, /is not accepted. Accepted: trace-create/); assert.match(errors['no-trace'].message, /body\.traceId/); assert.match(errors['no-id'].message, /body\.id/); assert.match(errors['bad-time'].message, /timestamp/);
    assert.match(errors['too-big'].message, /32 KiB/); assert.match(errors.unsafe.message, /2\^53/); assert.equal(body.errors.filter(e => e.id === 'unknown').length, 2); assert.ok(body.errors.every(e => e.status === 400 && e.error === 'BadRequestError'));
    const stored = await events(live, cookie, 'lf.trace-a'); assert.equal(stored.length, 2);
    const long = stored.find(e => e.data.type === 'generation-create'); assert.equal(long.data.truncated, true); assert.equal(long.data.span.model, 'm'); assert.ok(long.data.langfuse.input.length < 300);
  } finally { await live.close(); }
});

test('workspace isolation and quota: events land only in the key\'s workspace; a reached quota is a per-event 403', async () => {
  const live = await start(); try {
    const first = await session(live), second = await session(live, 5252);
    assert.equal((await ingest(live, JSON.stringify({batch: [event('trace-create', {id: 'private-trace', name: 'mine'})]}), basic(first.key))).status, 207);
    assert.equal((await events(live, first.cookie, 'lf.private-trace')).length, 1); assert.equal((await events(live, second.cookie, 'lf.private-trace')).length, 0);
  } finally { await live.close(); }
  const token = 'a'.repeat(43); let reserved = 0; const rows = new Map();
  const store = {getTenant: async tenant_id => ({tenant_id}), now: () => 0, consumeRate: async ({scope}) => scope === 'upload' && reserved < 0 ? {allowed: false, retry_after: 9} : {allowed: true}, lookupWriteKey: async h => h === digest(token) ? {tenant_id: 'github-1', token_hash: h} : null, _get: async () => null,
    reserveBatch: async (t, b) => { if (++reserved > 1) throw Object.assign(Error('storage_capacity'), {status: 429, code: 'storage_capacity'}); const row = {...b, status: 'pending', object_key: 'k'}; rows.set(b.batch_id, row); return row; }, acceptReservedBatch: async (t, id) => { rows.get(id).status = 'accepted'; }};
  const env = {ENABLED: true, APP_ORIGIN: 'https://supatrace.dev', GITHUB_CLIENT_ID: 'synthetic', GITHUB_CLIENT_SECRET: 'synthetic-not-secret', store, objects: {putImmutable: async () => {}}};
  const direct = body => handle(new Request('https://supatrace.dev/api/public/ingestion', {method: 'POST', headers: {'content-type': 'application/json', authorization: basic(token)}, body: JSON.stringify(body)}), env);
  const r = await direct({batch: [event('trace-create', {id: 'a'}, 'e1'), event('trace-create', {id: 'b'}, 'e2'), event('trace-create', {id: 'c'}, 'e3')]}); assert.equal(r.status, 207); const body = await r.json();
  assert.deepEqual(body.successes, [{id: 'e1', status: 201}]); assert.deepEqual(body.errors.map(e => [e.id, e.status, e.error]), [['e2', 403, 'ForbiddenError'], ['e3', 403, 'ForbiddenError']]); assert.match(body.errors[0].message, /storage quota/);
  // A repeated event id shares the first occurrence's outcome: never a 201 for something that was not stored.
  reserved = 1; const repeated = await (await direct({batch: [event('trace-create', {id: 'q'}, 'dup'), event('trace-create', {id: 'q'}, 'dup'), event('nope', {}, 'bad'), event('nope', {}, 'bad')]})).json();
  assert.deepEqual(repeated.successes, []); assert.deepEqual(repeated.errors.map(e => [e.id, e.status]), [['bad', 400], ['dup', 403], ['dup', 403], ['bad', 400]]);
  // The same event with body keys in another order is the same batch, not a conflict.
  reserved = 0; rows.clear(); const hashes = []; store.reserveBatch = async (t, b) => { hashes.push([b.batch_id, b.request_hash]); return rows.get(b.batch_id) ?? (rows.set(b.batch_id, {...b, status: 'pending', object_key: 'k'}), rows.get(b.batch_id)); };
  await direct({batch: [event('span-create', {id: 'o', traceId: 'r', name: 'n', metadata: {a: 1, b: 2}}, 'k1')]}); await direct({batch: [event('span-create', {metadata: {b: 2, a: 1}, name: 'n', traceId: 'r', id: 'o'}, 'k1')]});
  assert.equal(hashes.length, 2); assert.deepEqual(hashes[0], hashes[1]);
  store.reserveBatch = async () => { throw Error('transient'); }; const t = await direct({batch: [event('trace-create', {id: 'z'}, 'e9')]}); assert.equal(t.status, 503); assert.equal((await t.json()).error, 'ServiceUnavailableError');
  reserved = -1; const limited = await direct({batch: [event('trace-create', {id: 'z'}, 'e9')]}); assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '9');
});

test('planner: run ids, trace cap, chunking and deterministic batch ids', () => {
  assert.equal(langfuseRunId('0AF7651916CD43DD8448EB211C80319C'), 'otlp.0af7651916cd43dd8448eb211c80319c'); assert.equal(langfuseRunId('f36f27ca-daa6-41ac-941a-dd62c59be298'), 'lf.f36f27ca-daa6-41ac-941a-dd62c59be298');
  assert.match(langfuseRunId('trace with spaces/and slashes'), /^lf\.[a-f0-9]{64}$/); assert.notEqual(langfuseRunId('a b'), langfuseRunId('a  b'));
  const many = planLangfuseBatches({batch: Array.from({length: LANGFUSE_LIMITS.traces + 3}, (_, i) => event('trace-create', {id: 't' + i}, 'e' + i))});
  assert.equal(many.batches.length, LANGFUSE_LIMITS.traces); assert.equal(many.errors.length, 3); assert.match(many.errors[0].message, /traces in one request/);
  const wide = planLangfuseBatches({batch: Array.from({length: 250}, (_, i) => event('span-create', {id: 'o' + i, traceId: 't'}, 'e' + i))});
  assert.deepEqual(wide.batches.map(b => b.batch.events.length), [100, 100, 50]); assert.ok(wide.batches.every(b => b.batch.run_id === 'lf.t' && digest(b.raw) === b.request_hash && b.ids.length === b.batch.events.length));
  const one = () => planLangfuseBatches({batch: [event('generation-create', {id: 'g', traceId: 't', startTime: '2026-11-14T20:00:01.000Z', endTime: '2026-11-14T20:00:03.500Z', usage: {promptTokens: 3, completionTokens: 4, totalCost: 0.002}})]}).batches[0].batch;
  assert.equal(one().batch_id, one().batch_id); assert.deepEqual(one().events[0].data.span.usage, {input: 3, output: 4, total: 7}); assert.equal(one().events[0].data.span.reported_cost, 0.002); assert.equal(one().events[0].data.span.duration_ms, 2500); assert.equal(one().events[0].time, '2026-11-14T20:00:01.000Z');
  assert.ok(LANGFUSE_STORED_TYPES.includes('tool-create') && !LANGFUSE_STORED_TYPES.includes('sdk-log'));
  assert.equal(planLangfuseBatches({batch: [event('tool-create', {id: 'x', traceId: 't', name: 'search'})]}).batches[0].batch.events[0].kind, 'tool_call');
});
