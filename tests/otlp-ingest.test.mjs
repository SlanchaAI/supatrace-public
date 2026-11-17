// Hosted OTLP/HTTP receiver: real handler, real DynamoDB store logic (in-memory adapter), and
// request bodies captured from stock OpenTelemetry exporters (tests/fixtures/otlp).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
import {start} from './harness.mjs';
import {handle} from '../src/aws-api.mjs';
import {digest} from '../src/aws-auth.mjs';
import {decodeTraceRequest, encodeTraceResponse, encodeStatus, ProtobufError} from '../src/otlp-protobuf.mjs';
import {planOtlpBatches, OTLP_LIMITS} from '../src/otlp-ingest.mjs';
import {OTLP_CURL} from '../scripts/otlp-snippets.mjs';
import {lambdaResult} from '../aws/handler.mjs';

const fixture = name => readFileSync(new URL('./fixtures/otlp/' + name, import.meta.url));
const pythonProto = fixture('python-1.45.2-http-protobuf.bin'), nodeProto = fixture('node-0.301.2-http-protobuf.bin'), nodeJson = fixture('node-0.301.2-http-json.json');
const span = (traceId, spanId, extra = {}) => ({traceId, spanId, name: 'synthetic span', startTimeUnixNano: '1794685870000000000', endTimeUnixNano: '1794685871500000000', ...extra});
const envelope = spans => ({resourceSpans: [{resource: {attributes: [{key: 'service.name', value: {stringValue: 'synthetic'}}]}, scopeSpans: [{scope: {name: 'synthetic'}, spans}]}]});
const T1 = '0af7651916cd43dd8448eb211c80319c', T2 = '1bf7651916cd43dd8448eb211c80319c';

// Reads back every stored event of a run through the signed-in dashboard API.
async function events(live, cookie, run) {
  const out = []; let after = '';
  for (let page = 0; page < 20; page++) {
    const r = await fetch(live.origin + '/api/events?run=' + encodeURIComponent(run) + (after ? '&after=' + encodeURIComponent(after) : ''), {headers: {cookie}});
    assert.equal(r.status, 200); const body = await r.json(); out.push(...body.events); if (!body.next) return out; after = body.next;
  }
  throw Error('too many pages');
}
async function session(live) { let cookie = ''; const tenant = await live.signIn({addCookies: async value => { cookie = value.map(c => c.name + '=' + c.value).join('; '); }}); return {tenant, cookie, key: await live.writeKey(tenant)}; }
const post = (live, body, headers, path = '/v1/traces') => fetch(live.origin + path, {method: 'POST', headers, body});
// Reads the two fields of a google.rpc.Status / ExportTracePartialSuccess message.
function readMessage(bytes) { const out = {}; let at = 0; const varint = () => { let v = 0, s = 0; for (;;) { const b = bytes[at++]; v += (b & 0x7f) * 2 ** s; s += 7; if (!(b & 0x80)) return v; } }; while (at < bytes.length) { const tag = varint(); if ((tag & 7) === 0) out[tag >> 3] = varint(); else { const n = varint(); out[tag >> 3] = bytes.subarray(at, at + n); at += n; } } return out; }

test('stock Python exporter protobuf lands as one run with model, tokens, tool and error mapped', async () => {
  const live = await start(); try {
    const {cookie, key} = await session(live);
    const r = await post(live, pythonProto, {'content-type': 'application/x-protobuf', 'x-supatrace-key': key});
    assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'application/x-protobuf'); assert.equal((await r.arrayBuffer()).byteLength, 0);
    const trace = decodeTraceRequest(pythonProto).resourceSpans[0].scopeSpans[0].spans[0].traceId, run = 'otlp.' + trace;
    const runs = await (await fetch(live.origin + '/api/runs', {headers: {cookie}})).json();
    const row = runs.runs.find(item => item.id === run); assert.ok(row); assert.equal(row.event_count, 4); assert.equal(row.status, 'error'); assert.equal(row.agents.length, 1);
    const stored = await events(live, cookie, run); assert.equal(stored.length, 4);
    const llm = stored.find(event => event.name === 'chat gpt-synthetic');
    assert.equal(llm.kind, 'response'); assert.equal(llm.data.source, 'otlp');
    assert.deepEqual({model: llm.data.span.model, provider: llm.data.span.provider, usage: llm.data.span.usage, kind: llm.data.span.kind}, {model: 'gpt-synthetic', provider: 'openai', usage: {input: 120, output: 45, total: 165}, kind: 'llm'});
    assert.ok(llm.data.span.duration_ms >= 0); assert.equal(llm.data.otlp.span.events[0].name, 'gen_ai.choice');
    assert.equal(llm.data.otlp.resource.resource.attributes.find(a => a.key === 'service.name').value.stringValue, 'stock-python');
    const tool = stored.find(event => event.name === 'execute_tool lookup'); assert.equal(tool.kind, 'tool_call'); assert.equal(tool.data.span.tool, 'lookup');
    assert.deepEqual(tool.data.otlp.span.attributes.find(a => a.key === 'retries').value, {intValue: '2'});
    assert.deepEqual(tool.data.otlp.span.attributes.find(a => a.key === 'score').value, {doubleValue: 0.5});
    assert.deepEqual(tool.data.otlp.span.attributes.find(a => a.key === 'flags').value, {arrayValue: {values: [{boolValue: true}, {boolValue: false}]}});
    const failed = stored.find(event => event.name === 'failing step'); assert.equal(failed.kind, 'error'); assert.equal(failed.data.otlp.span.status.message, 'synthetic failure');
    const root = stored.find(event => event.name === 'agent run'); assert.equal(root.data.span.parentSpanId, undefined); assert.equal(llm.data.span.parentSpanId, root.data.span.spanId);
    // An exporter retry of the same request stores nothing twice.
    assert.equal((await post(live, pythonProto, {'content-type': 'application/x-protobuf', 'x-supatrace-key': key})).status, 200);
    const again = (await (await fetch(live.origin + '/api/runs', {headers: {cookie}})).json()).runs.find(item => item.id === run);
    assert.equal(again.event_count, 4); assert.equal(again.batch_count, 1);
  } finally { await live.close(); }
});

test('stock Node exporter: JSON with a bearer key, protobuf, and gzip all store the same spans', async () => {
  const live = await start(); try {
    const {cookie, key} = await session(live);
    const json = await post(live, nodeJson, {'content-type': 'application/json', authorization: 'Bearer ' + key});
    assert.equal(json.status, 200); assert.equal(json.headers.get('content-type'), 'application/json'); assert.deepEqual(await json.json(), {});
    const proto = await post(live, gzipSync(nodeProto), {'content-type': 'application/x-protobuf', 'content-encoding': 'gzip', 'x-supatrace-key': key});
    assert.equal(proto.status, 200);
    const alias = await post(live, nodeJson, {'content-type': 'application/json; charset=utf-8', 'x-supatrace-key': key}, '/api/otlp/v1/traces');
    assert.equal(alias.status, 200);
    const runs = (await (await fetch(live.origin + '/api/runs', {headers: {cookie}})).json()).runs;
    for (const body of [JSON.parse(nodeJson), decodeTraceRequest(nodeProto)]) for (const item of body.resourceSpans[0].scopeSpans[0].spans) {
      const stored = await events(live, cookie, 'otlp.' + item.traceId); assert.equal(stored.length, 1); assert.equal(stored[0].name, item.name);
      assert.ok(runs.some(run => run.id === 'otlp.' + item.traceId));
      if (item.name === 'chat gpt-synthetic') assert.deepEqual(stored[0].data.span.usage, {input: 10, output: 5, total: 15});
    }
  } finally { await live.close(); }
});

test('partial success reports rejected spans with a reason in JSON and protobuf', async () => {
  const live = await start(); try {
    const {cookie, key} = await session(live);
    const body = envelope([span(T1, 'aaaaaaaaaaaaaaaa'), span(T1, 'bbbbbbbbbbbbbbbb', {endTimeUnixNano: '1'}), span(T1, 'aaaaaaaaaaaaaaaa')]);
    const r = await post(live, JSON.stringify(body), {'content-type': 'application/json', 'x-supatrace-key': key});
    assert.equal(r.status, 200); const partial = (await r.json()).partialSuccess;
    assert.equal(partial.rejectedSpans, '2'); assert.match(partial.errorMessage, /1 × invalid span/); assert.match(partial.errorMessage, /1 × span id repeated/);
    assert.equal((await events(live, cookie, 'otlp.' + T1)).length, 1);
    // The Python fixture plus a corrupted copy of its first span's trace id cannot be built without an encoder,
    // so the protobuf partial-success encoding is checked directly and through an all-invalid request below.
    const encoded = readMessage(readMessage(encodeTraceResponse({rejectedSpans: 300, errorMessage: 'why'}))[1]);
    assert.equal(encoded[1], 300); assert.equal(Buffer.from(encoded[2]).toString(), 'why');
    assert.equal(encodeTraceResponse().length, 0);
  } finally { await live.close(); }
});

test('bad key, missing key and unusable requests get an OTLP Status with a human reason', async () => {
  const live = await start(); try {
    const {key} = await session(live);
    const missing = await post(live, nodeJson, {'content-type': 'application/json'});
    assert.equal(missing.status, 401); const m = await missing.json(); assert.equal(m.code, 16); assert.equal(m.error, 'write_key_required'); assert.match(m.message, /Authorization: Bearer/);
    const malformed=[];
    for(const headers of [{'x-supatrace-key':'short'},{'x-supatrace-key':'wrong_'+'a'.repeat(43)},{authorization:'Bearer short'},{authorization:'Bearer st_bad_'+'a'.repeat(43)},{authorization:'Bearer st_pub_'+'b'.repeat(43)}]){
      const response=await post(live,nodeJson,{'content-type':'application/json',...headers});assert.equal(response.status,401);
      const error=await response.json();assert.equal(error.code,16);assert.equal(error.error,'invalid_write_key');assert.match(error.message,/Copy the full key that starts with st_pub_/);assert.match(error.message,/Create or copy a key under API keys in the app/);malformed.push(error);
    }
    for(const error of malformed)assert.deepEqual(error,malformed[0]);
    const wrong = await post(live, pythonProto, {'content-type': 'application/x-protobuf', authorization: 'Bearer ' + 'b'.repeat(43)});
    assert.equal(wrong.status, 401); assert.equal(wrong.headers.get('content-type'), 'application/x-protobuf');
    const status = readMessage(new Uint8Array(await wrong.arrayBuffer())); assert.equal(status[1], 16); assert.match(Buffer.from(status[2]).toString(), /not recognised/);
    assert.equal(Buffer.from(readMessage(encodeStatus(3, 'reason'))[2]).toString(), 'reason');
    const type = await post(live, 'x', {'content-type': 'text/plain', 'x-supatrace-key': key}); assert.equal(type.status, 415); assert.match((await type.json()).message, /http\/protobuf or http\/json/);
    const encoding = await post(live, nodeJson, {'content-type': 'application/json', 'content-encoding': 'br', 'x-supatrace-key': key}); assert.equal(encoding.status, 415);
    const gzip = await post(live, 'not gzip', {'content-type': 'application/json', 'content-encoding': 'gzip', 'x-supatrace-key': key}); assert.equal(gzip.status, 400); assert.equal((await gzip.json()).error, 'invalid_gzip');
    const bomb = await post(live, gzipSync(Buffer.alloc(OTLP_LIMITS.bytes + 1, 0x20)), {'content-type': 'application/json', 'content-encoding': 'gzip', 'x-supatrace-key': key}); assert.equal(bomb.status, 413);
    const large = await post(live, Buffer.alloc(OTLP_LIMITS.wireBytes + 1, 0x20), {'content-type': 'application/json', 'x-supatrace-key': key}); assert.equal(large.status, 413);
    const truncated = await post(live, pythonProto.subarray(0, pythonProto.length - 7), {'content-type': 'application/x-protobuf', 'x-supatrace-key': key}); assert.equal(truncated.status, 400);
    assert.equal(readMessage(new Uint8Array(await truncated.arrayBuffer()))[1], 3);
    const notOtlp = await post(live, '{"spans":[]}', {'content-type': 'application/json', 'x-supatrace-key': key}); assert.equal(notOtlp.status, 400); assert.equal((await notOtlp.json()).error, 'invalid_otlp');
    const invalid = await post(live, JSON.stringify(envelope([span(T1, 'zz')])), {'content-type': 'application/json', 'x-supatrace-key': key});
    assert.equal(invalid.status, 400); const body = await invalid.json(); assert.equal(body.error, 'no_valid_spans'); assert.match(body.message, /1 × invalid span/);
    const deep = await post(live, '{"resourceSpans":' + '['.repeat(200000) + ']'.repeat(200000) + '}', {'content-type': 'application/json', 'x-supatrace-key': key}); assert.equal(deep.status, 400);
    const nested = await post(live, JSON.stringify(envelope([span(T1, 'dddddddddddddddd', {attributes: [{key: 'k', value: JSON.parse('{"arrayValue":{"values":['.repeat(70) + '{"stringValue":"x"}' + ']}}'.repeat(70))}]})])), {'content-type': 'application/json', 'x-supatrace-key': key}); assert.equal(nested.status, 400);
    const unsafe = await post(live, JSON.stringify(envelope([span(T1, 'eeeeeeeeeeeeeeee', {attributes: [{key: 'k', value: {doubleValue: 1e300}}]})])), {'content-type': 'application/json', 'x-supatrace-key': key}); assert.equal(unsafe.status, 400); assert.match((await unsafe.json()).message, /beyond 2\^53/);
    const empty = await post(live, '{"resourceSpans":[]}', {'content-type': 'application/json', 'x-supatrace-key': key}); assert.equal(empty.status, 200); assert.deepEqual(await empty.json(), {});
    const environment = await post(live, nodeJson, {'content-type': 'application/json', 'x-supatrace-key': key}, '/v1/traces?environment=production'); assert.equal(environment.status, 403);
  } finally { await live.close(); }
});

test('one workspace cannot read spans sent with another workspace key', async () => {
  const live = await start(); try {
    const first = await session(live); let cookie = '';
    await live.signIn({addCookies: async value => { cookie = value.map(c => c.name + '=' + c.value).join('; '); }}, 5252);
    assert.equal((await post(live, JSON.stringify(envelope([span(T2, 'cccccccccccccccc')])), {'content-type': 'application/json', 'x-supatrace-key': first.key})).status, 200);
    assert.equal((await events(live, first.cookie, 'otlp.' + T2)).length, 1);
    assert.equal((await events(live, cookie, 'otlp.' + T2)).length, 0);
  } finally { await live.close(); }
});

// Quota and rate behaviour against a store double, as tests/aws-api.test.mjs does.
function quotaFixture({failAfter = Infinity, code = 'storage_capacity', status = 429, rate = true} = {}) {
  const token = 'a'.repeat(43), rows = new Map(), objects = new Map(); let reserved = 0;
  const store = {getTenant: async tenant_id => ({tenant_id}), now: () => 0, consumeRate: async ({scope}) => scope === 'upload' && !rate ? {allowed: false, retry_after: 7} : {allowed: true}, lookupWriteKey: async h => h === digest(token) ? {tenant_id: 'github-1', token_hash: h} : null,
    _get: async () => null, reserveBatch: async (t, b) => { if (rows.has(b.batch_id)) return rows.get(b.batch_id); if (++reserved > failAfter) throw Object.assign(Error(code), {status, code}); const row = {...b, status: 'pending', object_key: t + '/' + b.request_hash}; rows.set(b.batch_id, row); return row; },
    acceptReservedBatch: async (t, id) => { rows.get(id).status = 'accepted'; }};
  return {token, rows, env: {ENABLED: true, APP_ORIGIN: 'https://supatrace.dev', GITHUB_CLIENT_ID: 'synthetic', GITHUB_CLIENT_SECRET: 'synthetic-not-secret', store, objects: {putImmutable: async (k, v) => { objects.set(k, v); }}}};
}
const direct = (f, body) => handle(new Request('https://supatrace.dev/v1/traces', {method: 'POST', headers: {'content-type': 'application/json', 'x-supatrace-key': f.token}, body: JSON.stringify(body)}), f.env);
test('over-quota export is refused with a clear, non-retryable reason; a part-stored export reports the rest', async () => {
  const two = envelope([span(T1, 'aaaaaaaaaaaaaaaa'), span(T2, 'bbbbbbbbbbbbbbbb')]);
  const none = quotaFixture({failAfter: 0}), refused = await direct(none, two);
  assert.equal(refused.status, 403); const body = await refused.json(); assert.equal(body.error, 'quota_exceeded'); assert.equal(body.code, 7); assert.match(body.message, /storage quota is reached/); assert.equal(none.rows.size, 0);
  const some = quotaFixture({failAfter: 1}), partial = await direct(some, two);
  assert.equal(partial.status, 200); const p = (await partial.json()).partialSuccess; assert.equal(p.rejectedSpans, '1'); assert.match(p.errorMessage, /storage quota is reached/); assert.equal(some.rows.size, 1);
  const blocked = quotaFixture({failAfter: 0, code: 'commercial_upload_blocked', status: 403}), b = await direct(blocked, two);
  assert.equal(b.status, 403); assert.match((await b.json()).message, /billing state/);
  const limited = await direct(quotaFixture({rate: false}), two);
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '7'); assert.equal((await limited.json()).code, 8);
  // A transient store failure fails the whole request as retryable; the retry is idempotent.
  const transient = quotaFixture({failAfter: 1, code: 'internal detail', status: null}), t = await direct(transient, two);
  assert.equal(t.status, 503); assert.equal((await t.json()).error, 'temporarily_unavailable'); transient.env.store.reserveBatch = async (tenant, b) => transient.rows.get(b.batch_id) ?? (transient.rows.set(b.batch_id, {...b, status: 'pending', object_key: 'k'}), transient.rows.get(b.batch_id));
  assert.equal((await direct(transient, two)).status, 200); assert.equal(transient.rows.size, 2);
});

test('planner: trace cap, oversized spans, truncation and batch chunking', () => {
  const hexId = (n, size) => n.toString(16).padStart(size, '0');
  const many = planOtlpBatches(envelope(Array.from({length: OTLP_LIMITS.traces + 5}, (_, i) => span(hexId(i + 1, 32), hexId(i + 1, 16)))));
  assert.equal(many.batches.length, OTLP_LIMITS.traces); assert.equal(many.rejected, 5); assert.match([...many.reasons.keys()][0], /OTEL_BSP_MAX_EXPORT_BATCH_SIZE/);
  const long = planOtlpBatches(envelope([span(T1, 'aaaaaaaaaaaaaaaa', {attributes: [{key: 'gen_ai.prompt', value: {stringValue: 'p'.repeat(60000)}}, {key: 'gen_ai.request.model', value: {stringValue: 'm'}}]})]));
  assert.equal(long.rejected, 0); assert.equal(long.truncated, 1); const data = long.batches[0].batch.events[0].data; assert.equal(data.truncated, true); assert.equal(data.span.model, 'm'); assert.ok(data.otlp.span.attributes[0].value.stringValue.length <= OTLP_LIMITS.clip + 1);
  const huge = planOtlpBatches(envelope([span(T1, 'aaaaaaaaaaaaaaaa', {attributes: Array.from({length: 3000}, (_, i) => ({key: 'k' + i, value: {stringValue: 'v'}}))})]));
  assert.equal(huge.rejected, 1); assert.equal(huge.batches.length, 0);
  const wide = planOtlpBatches(envelope(Array.from({length: 250}, (_, i) => span(T1, hexId(i + 1, 16)))));
  assert.deepEqual(wide.batches.map(b => b.batch.events.length), [100, 100, 50]); assert.equal(new Set(wide.batches.map(b => b.batch.batch_id)).size, 3);
  assert.ok(wide.batches.every(b => b.batch.run_id === 'otlp.' + T1 && Buffer.byteLength(b.raw) <= 524288 && digest(b.raw) === b.request_hash));
  assert.throws(() => planOtlpBatches(envelope(Array.from({length: OTLP_LIMITS.spans + 1}, (_, i) => span(T1, hexId(i + 1, 16))))), {code: 'too_many_spans'});
  assert.deepEqual(planOtlpBatches(envelope([span(T1, 'aaaaaaaaaaaaaaaa')])).batches[0].batch.batch_id, planOtlpBatches(envelope([span(T1, 'aaaaaaaaaaaaaaaa')])).batches[0].batch.batch_id);
});

test('attribute mapping covers OpenLLMetry, OpenInference and Vercel AI SDK names', () => {
  const attrs = pairs => Object.entries(pairs).map(([key, v]) => ({key, value: typeof v === 'number' ? {intValue: String(v)} : {stringValue: v}}));
  const summary = pairs => planOtlpBatches(envelope([span(T1, 'aaaaaaaaaaaaaaaa', {attributes: attrs(pairs)})])).batches[0].batch.events[0];
  const openllmetry = summary({'llm.request.model': 'gpt-a', 'gen_ai.usage.prompt_tokens': 7, 'gen_ai.usage.completion_tokens': 3, 'llm.usage.total_tokens': 10});
  assert.deepEqual([openllmetry.kind, openllmetry.data.span.model, openllmetry.data.span.usage], ['response', 'gpt-a', {input: 7, output: 3, total: 10}]);
  const openinference = summary({'openinference.span.kind': 'LLM', 'llm.model_name': 'claude-a', 'llm.provider': 'anthropic', 'llm.token_count.prompt': 4, 'llm.token_count.completion': 6});
  assert.deepEqual([openinference.data.span.kind, openinference.data.span.model, openinference.data.span.provider, openinference.data.span.usage], ['llm', 'claude-a', 'anthropic', {input: 4, output: 6, total: 10}]);
  const vercel = summary({'ai.model.id': 'model-v', 'ai.model.provider': 'openai.chat', 'ai.usage.promptTokens': 2, 'ai.usage.completionTokens': 1});
  assert.deepEqual([vercel.data.span.model, vercel.data.span.usage.total], ['model-v', 3]);
  const tool = summary({'openinference.span.kind': 'TOOL', 'tool.name': 'search'}); assert.equal(tool.kind, 'tool_call');
  const plain = summary({'http.method': 'GET'}); assert.equal(plain.kind, 'note'); assert.equal(plain.data.span.model, undefined); assert.equal(plain.data.span.duration_ms, 1500);
});

test('protobuf decoder refuses malformed input without throwing anything else', () => {
  let state = 7; const random = () => { state = state * 1103515245 + 12345 & 0x7fffffff; return state & 0xff; };
  for (let round = 0; round < 400; round++) {
    const bytes = Buffer.from(pythonProto); for (let i = 0; i < 4; i++) bytes[random() * 4 % bytes.length] = random();
    try { planOtlpBatches(decodeTraceRequest(round % 3 ? bytes : bytes.subarray(0, random() * 4 % bytes.length))); }
    catch (error) { assert.ok(error instanceof ProtobufError || error.code === 'invalid_otlp', String(error)); }
  }
  assert.throws(() => decodeTraceRequest(Buffer.from([0x0a, 0xff, 0xff, 0xff, 0xff, 0x0f])), ProtobufError);
  assert.throws(() => decodeTraceRequest(Buffer.from([0x0b])), ProtobufError);
  // AnyValue nesting is bounded.
  let nested = Buffer.from([0x0a, 0x01, 0x78]); for (let i = 0; i < 40; i++) { const list = Buffer.concat([Buffer.from([0x0a, nested.length]), nested]); nested = Buffer.concat([Buffer.from([0x2a, list.length]), list]); if (nested.length > 120) break; }
  assert.doesNotThrow(() => { try { decodeTraceRequest(nested); } catch (error) { if (!(error instanceof ProtobufError)) throw error; } });
});

test('POST /api/batches also accepts the write key as a bearer credential', async () => {
  const f = quotaFixture(), raw = JSON.stringify({version: 1, batch_id: 'bearer1', run_id: 'run1', events: [{id: 'e1', time: '2026-10-21T00:00:00Z', kind: 'note', name: 'synthetic', data: {}}]});
  const send = authorization => handle(new Request('https://supatrace.dev/api/batches', {method: 'POST', headers: {'content-type': 'application/json', authorization, 'x-amz-content-sha256': digest(raw)}, body: raw}), f.env);
  assert.equal((await send('Bearer ' + f.token)).status, 201); assert.equal((await send('Bearer ' + 'b'.repeat(43))).status, 401); assert.equal((await send('Basic ' + f.token)).status, 401);
});

test('the Lambda entry returns binary protobuf responses base64-encoded and JSON as text', async () => {
  const f = quotaFixture({failAfter: 1}), two = envelope([span(T1, 'aaaaaaaaaaaaaaaa'), span(T2, 'bbbbbbbbbbbbbbbb')]);
  const wrong = await lambdaResult(await handle(new Request('https://supatrace.dev/v1/traces', {method: 'POST', headers: {'content-type': 'application/x-protobuf', 'x-supatrace-key': 'b'.repeat(43)}, body: pythonProto}), f.env));
  assert.equal(wrong.statusCode, 401); assert.equal(wrong.isBase64Encoded, true); assert.equal(readMessage(Buffer.from(wrong.body, 'base64'))[1], 16);
  const ok = await lambdaResult(await handle(new Request('https://supatrace.dev/v1/traces', {method: 'POST', headers: {'content-type': 'application/x-protobuf', 'x-supatrace-key': f.token}, body: pythonProto}), f.env));
  assert.equal(ok.statusCode, 200); assert.equal(ok.isBase64Encoded, true); assert.equal(ok.body, '');
  const text = await lambdaResult(await direct(quotaFixture({failAfter: 1}), two));
  assert.equal(text.isBase64Encoded, false); assert.equal(JSON.parse(text.body).partialSuccess.rejectedSpans, '1'); assert.deepEqual(text.cookies, []);
});

test('OTLP/JSON leniency: numeric 64-bit values, unknown fields and null attributes do not reject a span', () => {
  const lenient = {traceId: T1, spanId: 'aaaaaaaaaaaaaaaa', name: 'lenient', startTimeUnixNano: 1794685870000000000, endTimeUnixNano: 1794685871000000000, futureSpanField: {x: 1},
    attributes: [{key: 'a', value: {stringValue: 'kept', futureField: 1}, futureKeyValueField: true}, {key: 'gen_ai.usage.input_tokens', value: {intValue: 12}}, {key: 'nothing', value: {}}, {key: 'absent'},
      {key: 'list', value: {arrayValue: {values: [{intValue: 1}, {}, {kvlistValue: {values: [{key: 'inner', value: {boolValue: false, extra: 0}}]}}]}}}],
    events: [{name: 'e', timeUnixNano: 1794685870500000000, attributes: [{key: 'x', value: {doubleValue: 0.5, other: 'y'}}]}], links: [{traceId: T2, spanId: 'bbbbbbbbbbbbbbbb', attributes: [{key: 'n', value: {}}]}]};
  const big = 1794685870000000000; // An unsafe integer in an unknown field must not reach storage validation.
  Object.assign(lenient, {futureField: big, status: {code: 1, futureField: big}}); lenient.events[0].futureField = big; lenient.links[0].futureField = big;
  const body = envelope([lenient]); body.resourceSpans[0].resource.attributes.push({key: 'null', value: {}}); body.resourceSpans[0].futureField = big;
  body.resourceSpans[0].resource.futureField = big; body.resourceSpans[0].scopeSpans[0].futureField = big; body.resourceSpans[0].scopeSpans[0].scope.futureField = big; body.futureField = big;
  const plan = planOtlpBatches(body); assert.equal(plan.rejected, 0, JSON.stringify([...plan.reasons]));
  const event = plan.batches[0].batch.events[0], stored = event.data.otlp.span;
  assert.equal(event.time, '2026-11-14T' + new Date(1794685870000).toISOString().slice(11)); assert.equal(stored.startTimeUnixNano, '1794685870000000000'); assert.equal(stored.events[0].timeUnixNano, '1794685870500000000');
  assert.deepEqual(stored.attributes.map(a => a.key), ['a', 'gen_ai.usage.input_tokens', 'list']); assert.deepEqual(stored.attributes[0], {key: 'a', value: {stringValue: 'kept'}});
  assert.deepEqual(stored.attributes[2].value, {arrayValue: {values: [{intValue: '1'}, {kvlistValue: {values: [{key: 'inner', value: {boolValue: false}}]}}]}});
  assert.deepEqual(stored.events[0].attributes, [{key: 'x', value: {doubleValue: 0.5}}]); assert.deepEqual(stored.links[0].attributes, []);
  assert.deepEqual(event.data.otlp.resource.resource.attributes.map(a => a.key), ['service.name']);
  assert.ok(!JSON.stringify(plan.batches[0].batch).includes('futureField')); assert.deepEqual(stored.status, {code: 1}); assert.equal(event.data.span.status, 'ok'); assert.equal(event.data.otlp.scope.scope.name, 'synthetic');
  // Still strict where the data itself is wrong.
  assert.equal(planOtlpBatches(envelope([{...lenient, startTimeUnixNano: 1.5}])).rejected, 1); assert.equal(planOtlpBatches(envelope([{...lenient, attributes: [{key: 'a', value: {stringValue: 5}}]}])).rejected, 1);
});

test('shared resource and scope are processed once, so a huge shared attribute cannot multiply work per span', () => {
  const hexId = (n, size) => n.toString(16).padStart(size, '0'), spans = Array.from({length: OTLP_LIMITS.spans}, (_, i) => span(T1, hexId(i + 1, 16)));
  const timed = body => { const started = Date.now(), plan = planOtlpBatches(body); return {plan, ms: Date.now() - started}; };
  // 2000 spans sharing one 3.5 MB resource attribute: measured ~0.1 s; it took ~16 s when the resource was re-read per span.
  const huge = timed({resourceSpans: [{resource: {attributes: [{key: 'a', value: {stringValue: 'x'.repeat(3500000)}}]}, scopeSpans: [{spans}]}]});
  assert.ok(huge.ms < 5000, 'planning took ' + huge.ms + ' ms'); assert.equal(huge.plan.rejected, 0); assert.equal(huge.plan.truncated, OTLP_LIMITS.spans);
  assert.equal(huge.plan.batches[0].batch.events[0].data.otlp.resource.resource.attributes[0].value.stringValue.length, OTLP_LIMITS.clip + 1);
  const scopes = timed({resourceSpans: [{resource: {attributes: [{key: 'a', value: {stringValue: 'x'.repeat(3000000)}}]}, scopeSpans: spans.map(item => ({scope: {name: 'n'}, spans: [item]}))}]});
  assert.ok(scopes.ms < 5000); assert.equal(scopes.plan.rejected, 0);
  // A resource that is still over the limit after truncation rejects its spans once, with a reason.
  const wide = timed({resourceSpans: [{resource: {attributes: Array.from({length: 120000}, (_, i) => ({key: 'k' + i, value: {stringValue: 'v'}}))}, scopeSpans: [{spans}]}]});
  assert.ok(wide.ms < 5000); assert.equal(wide.plan.rejected, OTLP_LIMITS.spans); assert.match([...wide.plan.reasons.keys()][0], /resource or scope attributes exceed/);
  // The total stored size of one export is capped.
  const capped = timed({resourceSpans: [{resource: {attributes: [{key: 'a', value: {stringValue: 'x'.repeat(30000)}}]}, scopeSpans: [{spans}]}]});
  assert.ok(capped.ms < 5000); assert.ok(capped.plan.rejected > 0); assert.match([...capped.plan.reasons.keys()][0], /8 MiB once stored/);
  assert.ok(capped.plan.batches.reduce((sum, b) => sum + Buffer.byteLength(b.raw), 0) < OTLP_LIMITS.storedBytes + 40000);
  // An invalid resource rejects its spans without rejecting spans of other resources.
  const mixed = planOtlpBatches({resourceSpans: [{resource: {attributes: [{key: '', value: {stringValue: 'bad key'}}]}, scopeSpans: [{spans: [span(T1, 'aaaaaaaaaaaaaaaa')]}]}, {scopeSpans: [{scope: {name: 5}, spans: [span(T1, 'bbbbbbbbbbbbbbbb')]}, {spans: [span(T1, 'cccccccccccccccc')]}]}]});
  assert.equal(mixed.rejected, 2); assert.equal(mixed.batches[0].batch.events.length, 1); assert.equal(mixed.batches[0].batch.events[0].id, 'span.cccccccccccccccc');
});

// Registered through this file instead of package.json's one-line `test` list, which conflicts
// with every concurrent merge to the trunk. `npm test` runs it all the same.
import './management-api.test.mjs';
import './drains.test.mjs';
import './ingest-log.test.mjs';


test('the published curl body ingests and reads back using either header', async () => {
  assert.ok(OTLP_CURL.split('\n').length <= 6);
  const body=JSON.parse(OTLP_CURL.split("-d '")[1].split("'\n")[0]);
  const live=await start();try{
    const {cookie,key}=await session(live);
    for(const headers of [{'x-supatrace-key':key},{authorization:'Bearer '+key}]){
      const response=await post(live,JSON.stringify(body),{'content-type':'application/json',...headers});assert.equal(response.status,200);
    }
    const trace=body.resourceSpans[0].scopeSpans[0].spans[0].traceId;
    assert.equal((await events(live,cookie,'otlp.'+trace)).length,1);
  }finally{await live.close();}
});
