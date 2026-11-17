// Wrapper instrumentation against fake OpenAI and Anthropic clients. No provider package and no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { init, instrument, wrapOpenAI, wrapAnthropic, detectProvider, INSTRUMENTED } from '../index.mjs';
import { CONTENT_LIMIT } from '../instrument.mjs';
import { parseBatch } from '../../../src/trace.mjs';

const spool = () => mkdtempSync(join(tmpdir(), 'supatrace-instrument-'));
const batches = (dir) => readdirSync(dir).map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8'))).sort((a, b) => a.events[0].time.localeCompare(b.events[0].time) || a.run_id.localeCompare(b.run_id));
const settle = () => new Promise((resolve) => setImmediate(resolve));
const KEY = 'a'.repeat(43) + '.proj_' + '0'.repeat(32);

// The provider SDKs return a promise subclass with extra helpers. The fake keeps that shape.
class ApiPromise extends Promise { withResponse() { return this.then((data) => ({ data, response: { status: 200 } })); } }
class ApiError extends Error { constructor(status, message) { super(message); this.name = 'RateLimitError'; this.status = status; } }

class FakeOpenAI {
  #secret = 'sk-private';
  constructor() {
    const self = this;
    this.calls = [];
    this.chat = { completions: {
      create(params) { self.calls.push(['chat', params, this]); if (params.fail) return ApiPromise.reject(new ApiError(429, 'slow down')); if (params.stream) return ApiPromise.resolve({ async *[Symbol.asyncIterator]() { yield { choices: [{ delta: { content: 'hi' } }] }; } }); return ApiPromise.resolve({ id: 'chatcmpl-1', model: 'gpt-4o-mini-2024-07-18', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Hello there' } }], usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } }); },
      list() { return 'listed'; },
    } };
    this.responses = { create(params) { self.calls.push(['responses', params, this]); return ApiPromise.resolve({ id: 'resp_1', model: 'gpt-4.1', status: 'completed', output_text: 'Done', usage: { input_tokens: 5, output_tokens: 2 } }); } };
    this.embeddings = { create() { return ApiPromise.resolve({ data: [] }); } };
  }
  secretLength() { return this.#secret.length; }
  withOptions() { return new FakeOpenAI(); }
}
class FakeAnthropic {
  constructor() { this.messages = { create: (params) => { if (params.throwNow) throw new TypeError('bad params'); return ApiPromise.resolve({ id: 'msg_1', model: 'claude-sonnet-4-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Bonjour' }], usage: { input_tokens: 11, output_tokens: 4 } }); } }; }
}

test('OpenAI chat and responses calls are each recorded as a valid two-event batch, with nothing global patched', async () => {
  const dir = spool(), trace = init('checkout', { spool: dir }), raw = new FakeOpenAI(), before = [raw.chat.completions.create, raw.responses.create, globalThis.fetch, Promise.prototype.then];
  const client = trace.instrument(raw);
  assert.notEqual(client, raw); assert.deepEqual(trace.capture.instrumented, ['openai']);
  const pending = client.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'SECRET PROMPT' }] });
  // The provider's own promise comes back, helpers included.
  assert.ok(pending instanceof ApiPromise); assert.equal((await pending.withResponse()).response.status, 200);
  const completion = await client.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'SECRET PROMPT' }] }); assert.equal(completion.id, 'chatcmpl-1');
  assert.equal((await client.responses.create({ model: 'gpt-4.1', input: 'SECRET PROMPT' })).output_text, 'Done');
  await settle();
  // The original client and the globals are untouched, and the original is not traced.
  assert.deepEqual([raw.chat.completions.create, raw.responses.create, globalThis.fetch, Promise.prototype.then], before);
  await raw.chat.completions.create({ model: 'gpt-4o-mini', messages: [] }); await settle();
  const written = batches(dir); assert.equal(written.length, 3);
  for (const batch of written) { parseBatch(JSON.stringify(batch)); assert.match(batch.run_id, /^checkout\.openai\.[a-f0-9-]{13}$/); assert.deepEqual(batch.events.map((e) => e.kind), ['request', 'response']); assert.equal(batch.events[0].data.span_id, batch.events[1].data.span_id); }
  const chat = written.find((b) => b.events[1].data.attributes['gen_ai.response.id'] === 'chatcmpl-1'), responses = written.find((b) => b.events[1].data.attributes['gen_ai.response.id'] === 'resp_1');
  assert.equal(chat.events[0].name, 'chat gpt-4o-mini');
  assert.deepEqual(chat.events[1].data.attributes, { 'gen_ai.system': 'openai', 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'gpt-4o-mini', 'gen_ai.response.id': 'chatcmpl-1', 'gen_ai.response.model': 'gpt-4o-mini-2024-07-18', 'gen_ai.usage.input_tokens': 9, 'gen_ai.usage.output_tokens': 3, 'gen_ai.response.finish_reasons': ['stop'] });
  assert.deepEqual(responses.events[1].data.attributes, { 'gen_ai.system': 'openai', 'gen_ai.operation.name': 'responses', 'gen_ai.request.model': 'gpt-4.1', 'gen_ai.response.id': 'resp_1', 'gen_ai.response.model': 'gpt-4.1', 'gen_ai.usage.input_tokens': 5, 'gen_ai.usage.output_tokens': 2, 'openai.response.status': 'completed' });
  assert.ok(Number.isSafeInteger(chat.events[1].data.duration_ms));
  // Content capture is off by default: neither prompt nor output is in any spooled file.
  const text = JSON.stringify(written); assert.ok(!text.includes('SECRET PROMPT') && !text.includes('Hello there') && !text.includes('Done'));
  // Calls reach the client with their own receiver and arguments; other methods and private fields still work.
  assert.equal(raw.calls[0][2], raw.chat.completions); assert.equal(client.chat.completions.list(), 'listed'); assert.equal(client.secretLength(), 10);
  assert.equal(client.chat.completions.create, client.chat.completions.create, 'the wrapped method is stable');
  // Uninstrumented calls and derived clients are not recorded.
  await client.embeddings.create({}); await client.withOptions().chat.completions.create({ model: 'x', messages: [] }); await settle(); assert.equal(batches(dir).length, 3);
});

test('content is recorded only when asked for, and is cut at the limit', async () => {
  const dir = spool(), trace = init('checkout', { spool: dir, captureContent: true }), client = wrapOpenAI(trace, new FakeOpenAI());
  await client.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'x'.repeat(CONTENT_LIMIT + 50) }] }); await settle();
  const [batch] = batches(dir); parseBatch(JSON.stringify(batch));
  const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
  assert.ok(bytes(batch.events[0].data.input) <= CONTENT_LIMIT && bytes(batch.events[0].data.input) > CONTENT_LIMIT - 8); assert.equal(batch.events[1].data.attributes['supatrace.input_truncated'], true);
  assert.equal(batch.events[1].data.output, 'Hello there'); assert.equal(batch.events[1].data.attributes['supatrace.output_truncated'], undefined);
});

test('content is cut by its serialized size, a long service name still yields a valid trace id, and refused content never costs the metadata', async () => {
  const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
  // Control characters cost six bytes each once escaped, and multi-byte text more than its length: both still fit.
  for (const text of ['\u0001'.repeat(CONTENT_LIMIT), '漢'.repeat(CONTENT_LIMIT), '"'.repeat(CONTENT_LIMIT), 'x' + '😀'.repeat(CONTENT_LIMIT), '😀'.repeat(CONTENT_LIMIT)]) {
    const dir = spool(), trace = init('checkout', { spool: dir, captureContent: true }), raw = new FakeOpenAI();
    raw.responses.create = () => Promise.resolve({ id: 'resp_big', output_text: text });
    await trace.instrument(raw).responses.create({ model: 'gpt-4.1', input: text }); await settle();
    const [batch] = batches(dir); parseBatch(JSON.stringify(batch)); assert.equal(trace.capture.instrumentErrors, 0);
    for (const value of [batch.events[0].data.input, batch.events[1].data.output]) { assert.ok(value.length > 0 && bytes(value) <= CONTENT_LIMIT); assert.ok(text.startsWith(value)); }
    // The cut never leaves half of a surrogate pair behind.
    assert.ok(batch.events[0].data.input.isWellFormed() && batch.events[1].data.output.isWellFormed());
    assert.equal(batch.events[1].data.attributes['supatrace.input_truncated'], true); assert.equal(batch.events[1].data.attributes['supatrace.output_truncated'], true);
  }
  // The longest service name a manual batch accepts (its batch id adds 17 characters): the generated trace id is cut to fit, not refused.
  const long = 's'.repeat(108), dir = spool(), trace = init(long, { spool: dir });
  await trace.instrument(new FakeOpenAI()).chat.completions.create({ model: 'gpt-4o-mini', messages: [] }); await settle();
  const [batch] = batches(dir); parseBatch(JSON.stringify(batch)); assert.equal(batch.run_id.length, 128); assert.match(batch.run_id, /^s+\.openai\.[a-f0-9-]{13}$/); assert.equal(trace.capture.instrumentErrors, 0);
  // An oversized model name, response id or error name is cut, so the span name and event stay within the format.
  const dir3 = spool(), wide = init('checkout', { spool: dir3 }), odd = new FakeOpenAI();
  odd.responses.create = () => Promise.resolve({ id: 'r'.repeat(5000), model: 'm'.repeat(50000), incomplete_details: { reason: 'z'.repeat(900) } });
  await wide.instrument(odd).responses.create({ model: 'q'.repeat(40000) }); await settle();
  const [cut] = batches(dir3); parseBatch(JSON.stringify(cut)); assert.equal(wide.capture.instrumentErrors, 0);
  assert.equal(cut.events[0].name, 'responses ' + 'q'.repeat(120)); assert.equal(cut.events[1].data.attributes['gen_ai.response.id'].length, 120); assert.equal(cut.events[1].data.attributes['gen_ai.response.finish_reasons'][0].length, 120);
  // If the batch format refuses the content anyway, the span is kept without it and says so.
  const dir2 = spool(), picky = init('checkout', { spool: dir2, captureContent: true }), real = picky.batch.bind(picky); let refusals = 0;
  picky.batch = (events, options) => { if (events.some((event) => 'input' in event.data || 'output' in event.data)) { refusals++; return { batch: null, report: { valid: false, errors: ['invalid_data'] } }; } return real(events, options); };
  await picky.instrument(new FakeOpenAI()).chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }); await settle();
  const [kept] = batches(dir2); assert.equal(refusals, 1); assert.equal(picky.capture.instrumentErrors, 0);
  assert.equal(kept.events[1].data.attributes['supatrace.content_dropped'], true); assert.equal(kept.events[1].data.attributes['gen_ai.response.id'], 'chatcmpl-1'); assert.ok(!('input' in kept.events[0].data) && !('output' in kept.events[1].data));
});

test('Anthropic messages calls are recorded; a rejected call and a synchronous throw are recorded as errors and still reach the caller', async () => {
  const dir = spool(), trace = init('support', { spool: dir }), client = trace.instrument(new FakeAnthropic());
  assert.deepEqual(trace.capture.instrumented, ['anthropic']);
  assert.equal((await client.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] })).id, 'msg_1');
  assert.throws(() => client.messages.create({ model: 'claude-sonnet-4-5', throwNow: true }), TypeError);
  const openai = trace.instrument(new FakeOpenAI());
  await assert.rejects(openai.chat.completions.create({ model: 'gpt-4o-mini', fail: true }), (error) => error.status === 429 && error.message === 'slow down');
  await settle();
  assert.deepEqual(trace.capture.instrumented, ['anthropic', 'openai']);
  const written = batches(dir); assert.equal(written.length, 3); for (const batch of written) parseBatch(JSON.stringify(batch));
  const ok = written.find((b) => b.events[1].kind === 'response'), thrown = written.find((b) => b.events[1].data.attributes['error.type'] === 'TypeError'), rejected = written.find((b) => b.events[1].data.attributes['error.type'] === 'RateLimitError');
  assert.deepEqual(ok.events[1].data.attributes, { 'gen_ai.system': 'anthropic', 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'claude-sonnet-4-5', 'gen_ai.response.id': 'msg_1', 'gen_ai.response.model': 'claude-sonnet-4-5', 'gen_ai.usage.input_tokens': 11, 'gen_ai.usage.output_tokens': 4, 'gen_ai.response.finish_reasons': ['end_turn'] });
  assert.equal(thrown.events[1].kind, 'error'); assert.equal(rejected.events[1].kind, 'error'); assert.equal(rejected.events[1].data.attributes['http.response.status_code'], 429);
  // An error span claims no usage.
  assert.equal(rejected.events[1].data.attributes['gen_ai.usage.input_tokens'], undefined);
});

test('a Responses API status is not a finish reason: only the stated reason for an incomplete response is one', async () => {
  const dir = spool(), trace = init('checkout', { spool: dir });
  const answers = [{ id: 'resp_a', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }, { id: 'resp_b', status: 'queued' }, { id: 'resp_c', status: 'incomplete' }];
  const client = trace.instrument({ responses: { create: () => Promise.resolve(answers.shift()) } }, { provider: 'openai' });
  for (let i = 0; i < 3; i++) await client.responses.create({ model: 'gpt-4.1' }); await settle();
  const seen = Object.fromEntries(batches(dir).map((b) => { const a = b.events[1].data.attributes; return [a['gen_ai.response.id'], [a['openai.response.status'], a['gen_ai.response.finish_reasons']]]; }));
  assert.deepEqual(seen, { resp_a: ['incomplete', ['max_output_tokens']], resp_b: ['queued', undefined], resp_c: ['incomplete', undefined] });
});

test('a streamed call is passed through untouched and recorded without usage; a sparse response records only what it carries', async () => {
  const dir = spool(), trace = init('checkout', { spool: dir }), raw = new FakeOpenAI(), client = trace.instrument(raw);
  const stream = await client.chat.completions.create({ model: 'gpt-4o-mini', stream: true, messages: [] }), chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.equal(chunks.length, 1); await settle();
  const [streamed] = batches(dir);
  assert.deepEqual(streamed.events[1].data.attributes, { 'gen_ai.system': 'openai', 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'gpt-4o-mini', 'supatrace.streamed': true });
  raw.responses.create = () => Promise.resolve({ usage: { input_tokens: -1, output_tokens: 'many' } });
  await client.responses.create({}); await settle();
  const sparse = batches(dir).find((b) => b.events[0].name === 'responses openai');
  assert.deepEqual(sparse.events[1].data.attributes, { 'gen_ai.system': 'openai', 'gen_ai.operation.name': 'responses' });
});

test('a raw-response call is recorded without parsing its body; a frozen namespace is handed back as it is', async () => {
  // A provider-style thenable: `then` parses (once is all a body allows), `asResponse` does not.
  const provider = () => { const state = { parsed: 0 }; return { state, client: { responses: { create: () => ({
    then(resolve, reject) { state.parsed++; return Promise.resolve({ id: 'resp_9', model: 'gpt-4.1', usage: { input_tokens: 1, output_tokens: 1 } }).then(resolve, reject); },
    asResponse() { return Promise.resolve({ status: 200, bodyUsed: state.parsed > 0 }); },
    withResponse() { return this.then((data) => ({ data, response: { status: 200 } })); },
  }) } } }; };
  const dir = spool(), trace = init('checkout', { spool: dir }), raw = provider(), client = trace.instrument(raw.client, { provider: 'openai' });
  const response = await client.responses.create({ model: 'gpt-4.1' }).asResponse(); await settle();
  assert.equal(response.bodyUsed, false); assert.equal(raw.state.parsed, 0, 'the recorder did not parse a body the caller asked for raw');
  const [span] = batches(dir); parseBatch(JSON.stringify(span));
  assert.deepEqual(span.events[1].data.attributes, { 'gen_ai.system': 'openai', 'gen_ai.operation.name': 'responses', 'gen_ai.request.model': 'gpt-4.1', 'supatrace.raw_response': true });
  // Kept and asked for raw later, after other code has run: still unparsed, as with the unwrapped client.
  const late = provider(), lateClient = trace.instrument(late.client, { provider: 'openai' }), pending = lateClient.responses.create({ model: 'gpt-4.1' });
  await settle(); assert.equal(late.state.parsed, 0, 'nothing parses before the caller uses the promise');
  const before = Date.now(); await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal((await pending.asResponse()).bodyUsed, false); await settle(); assert.equal(late.state.parsed, 0);
  // A first use after a wait is marked and carries the wait, since the duration includes it; the chained call above is not.
  const rawSpans = batches(dir).filter((b) => b.events[1].data.attributes['supatrace.raw_response'] === true).map((b) => b.events[1].data), waited = rawSpans.find((d) => d.attributes['supatrace.late_use'] === true);
  assert.equal(rawSpans.length, 2); assert.ok(waited && waited.attributes['supatrace.first_use_delay_ms'] >= 50 && waited.duration_ms >= waited.attributes['supatrace.first_use_delay_ms'] - 2 && before > 0); // two clocks: allow rounding
  assert.equal(rawSpans.filter((d) => d.attributes['supatrace.late_use'] === undefined && d.attributes['supatrace.first_use_delay_ms'] === undefined).length, 1);
  // Synchronous work between the call and its use, inside one immediate callback, is a wait too.
  const busy = provider(), busyClient = trace.instrument(busy.client, { provider: 'openai' });
  await new Promise((resolve) => setImmediate(() => { const held = busyClient.responses.create({ model: 'gpt-4.1' }), until = Date.now() + 30; while (Date.now() < until); held.then(resolve); })); await settle();
  assert.ok(batches(dir).some((b) => b.events[1].data.attributes['supatrace.first_use_delay_ms'] >= 25 && b.events[1].data.attributes['gen_ai.response.id'] === 'resp_9'));
  assert.equal(batches(dir).filter((b) => b.events[1].data.attributes['supatrace.raw_response'] === true).length, 2);
  // The ordinary path still parses and records the response, and withResponse keeps working.
  const parsed = provider(), second = trace.instrument(parsed.client, { provider: 'openai' });
  assert.equal((await second.responses.create({ model: 'gpt-4.1' })).id, 'resp_9'); assert.equal((await second.responses.create({ model: 'gpt-4.1' }).withResponse()).data.id, 'resp_9'); await settle();
  assert.equal(batches(dir).filter((b) => b.events[1].data.attributes['gen_ai.response.id'] === 'resp_9').length, 3); // the two calls above and the held one
  // Frozen onto the client: reported as it is (a Proxy may not substitute it) and so not traced.
  const frozen = new FakeOpenAI(), own = frozen.chat; Object.defineProperty(frozen, 'chat', { value: own, writable: false, configurable: false });
  const view = trace.instrument(frozen); assert.equal(view.chat, own); const count = batches(dir).length;
  await view.chat.completions.create({ model: 'gpt-4o-mini', messages: [] }); await view.responses.create({ model: 'gpt-4.1', input: 'x' }); await settle();
  assert.equal(batches(dir).length, count + 1, 'only the unfrozen responses namespace was traced');
});

test('a namespace or method the client replaces later is called on the new one, and wrapping keeps export blockers listed', async () => {
  const dir = spool(), trace = init('checkout', { spool: dir });
  // Two resource objects that share one prototype method, as SDK resources do.
  class Responses { constructor(label) { this.label = label; } create() { return Promise.resolve({ id: this.label }); } }
  const raw = { responses: new Responses('first') }, client = trace.instrument(raw, { provider: 'openai' });
  assert.equal((await client.responses.create({})).id, 'first');
  raw.responses = new Responses('second');
  assert.equal((await raw.responses.create({})).id, 'second'); assert.equal((await client.responses.create({})).id, 'second', 'the wrapped call follows the replaced namespace');
  const again = client.responses.create; raw.responses.create = () => Promise.resolve({ id: 'third' });
  assert.notEqual(client.responses.create, again); assert.equal((await client.responses.create({})).id, 'third'); await settle();
  assert.deepEqual(batches(dir).map((b) => b.events[1].data.attributes['gen_ai.response.id']).sort(), ['first', 'second', 'third']);
  // otlp mode with nothing to send to: the reason stays listed after wrapping, because wrapping does not fix it.
  for (const options of [{ mode: 'otlp' }, { mode: 'otlp', endpoint: 'http://127.0.0.1:9' }]) {
    const blocked = init('checkout', options), before = blocked.capture.skipped.filter((entry) => entry.startsWith('openai:'));
    assert.equal(before.length, 1); assert.match(before[0], /nothing to export to|refusing to export unauthenticated/);
    blocked.instrument(new FakeOpenAI());
    assert.deepEqual(blocked.capture.skipped.filter((entry) => entry.startsWith('openai:')), before); assert.equal(blocked.capture.sending, false); assert.deepEqual(blocked.capture.instrumented, ['openai']);
  }
});

test('the span describes the request as sent, a handle with nowhere to record counts the call, and a view is not wrapped twice', async () => {
  // The caller reuses its parameter object while the request is in flight.
  const dir = spool(), trace = init('checkout', { spool: dir, captureContent: true }); let finish;
  const client = trace.instrument({ responses: { create: () => new Promise((resolve) => { finish = resolve; }) } }, { provider: 'openai' });
  const params = { model: 'first-model', input: 'first prompt' }, pending = client.responses.create(params);
  params.model = 'next-model'; params.input = 'next prompt'; finish({ id: 'resp_1' }); await pending; await settle();
  const [batch] = batches(dir); assert.equal(batch.events[0].name, 'responses first-model'); assert.equal(batch.events[0].data.input, 'first prompt'); assert.ok(!JSON.stringify(batch).includes('next'));
  // Content opt-in is also read when the call is made.
  const later = init('checkout', { spool: spool() }), slow = later.instrument({ responses: { create: () => new Promise((resolve) => { finish = resolve; }) } }, { provider: 'openai' });
  const second = slow.responses.create({ model: 'm', input: 'SECRET PROMPT' }); later.captureContent = true; finish({ id: 'resp_2', output_text: 'SECRET OUTPUT' }); await second; await settle();
  assert.ok(!JSON.stringify(batches(later.spool)).includes('SECRET'));
  // otlp mode with nothing to export to and a source handle without a spool record nothing, and say so.
  for (const handle of [init('checkout', { mode: 'otlp' }), init('checkout', { mode: 'otlp', endpoint: 'http://127.0.0.1:9' }), Object.assign(init('checkout', { spool: spool() }), { spool: null })]) {
    assert.equal((await handle.instrument(new FakeOpenAI()).chat.completions.create({ model: 'gpt-4o-mini', messages: [] })).id, 'chatcmpl-1'); await settle();
    assert.equal(handle.capture.instrumentErrors, 1, handle.mode);
  }
  // A rejection with no value is still a failed call, not a response.
  const dir2 = spool(), odd = init('checkout', { spool: dir2 }), rejecting = odd.instrument({ messages: { create: () => Promise.reject(undefined) } }, { provider: 'anthropic' });
  await assert.rejects(rejecting.messages.create({ model: 'claude-sonnet-4-5' }), (error) => error === undefined); await settle();
  const [failed] = batches(dir2); assert.equal(failed.events[1].kind, 'error'); assert.equal(failed.events[1].data.attributes['error.type'], 'Error');
  // The same handle wrapping its own view hands the view back, so a call is recorded once; the class is still reachable.
  const dir3 = spool(), once = init('checkout', { spool: dir3 }), raw = new FakeOpenAI(), view = once.instrument(raw);
  assert.equal(once.instrument(view), view); assert.equal(view.constructor, FakeOpenAI); assert.ok(view instanceof FakeOpenAI);
  await once.instrument(view).chat.completions.create({ model: 'gpt-4o-mini', messages: [] }); await settle(); assert.equal(batches(dir3).length, 1);
});

test('handles are isolated: wrapping another handle\'s view records only to the new handle, under its own content setting', async () => {
  const dirA = spool(), dirB = spool(), a = init('service-a', { spool: dirA, captureContent: true }), b = init('service-b', { spool: dirB }), raw = new FakeOpenAI();
  const viewA = a.instrument(raw), viewB = b.instrument(viewA);
  assert.notEqual(viewB, viewA); assert.equal(b.instrument(viewB), viewB); assert.equal(a.instrument(viewA), viewA);
  await viewB.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'SECRET PROMPT' }] }); await settle();
  // B recorded the call without content; A, which captures content, recorded nothing of B's call.
  assert.equal(batches(dirA).length, 0); const [only] = batches(dirB); assert.match(only.run_id, /^service-b\.openai\./); assert.ok(!JSON.stringify(only).includes('SECRET PROMPT') && !JSON.stringify(only).includes('Hello there'));
  assert.equal(raw.calls.length, 1, 'the provider was called once');
  // A's own view still records to A, with A's content setting.
  await viewA.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'A PROMPT' }] }); await settle();
  assert.equal(batches(dirB).length, 1); assert.ok(JSON.stringify(batches(dirA)).includes('A PROMPT'));
  // close() does not stop a source-mode handle: it keeps spooling, as documented. An otlp handle that is closed has nowhere to record.
  a.close(); await viewA.chat.completions.create({ model: 'gpt-4o-mini', messages: [] }); await settle(); assert.equal(batches(dirA).length, 2); assert.equal(a.capture.instrumentErrors, 0);
});

test('instrumentation cannot fail the call it observes, and refuses clients it does not know', async () => {
  const trace = init('checkout', { spool: spool() }); trace.batch = () => { throw new Error('spool is gone'); };
  const client = trace.instrument(new FakeOpenAI());
  assert.equal((await client.chat.completions.create({ model: 'gpt-4o-mini', messages: [] })).id, 'chatcmpl-1'); await settle();
  assert.equal(trace.capture.instrumentErrors, 1);
  // A service name the batch format refuses as a trace id: the call still succeeds, nothing is spooled, and the handle says so.
  const odd = init('not a valid id!', { spool: spool() }), second = odd.instrument(new FakeOpenAI());
  assert.equal((await second.chat.completions.create({ model: 'gpt-4o-mini', messages: [] })).id, 'chatcmpl-1'); await settle();
  assert.equal(odd.capture.instrumentErrors, 1); assert.equal(readdirSync(odd.spool).length, 0);
  assert.equal(detectProvider(new FakeOpenAI()), 'openai'); assert.equal(detectProvider(new FakeAnthropic()), 'anthropic'); assert.equal(detectProvider({}), null); assert.equal(detectProvider(null), null);
  assert.throws(() => trace.instrument({}), /supports OpenAI and Anthropic clients/); assert.throws(() => instrument(null, new FakeOpenAI()), /needs a trace handle/); assert.throws(() => instrument(trace, new FakeOpenAI(), { provider: 'cohere' }), /supports OpenAI and Anthropic/);
  assert.equal(wrapAnthropic(trace, new FakeAnthropic()).messages.create.name, 'supatraceInstrumented');
  assert.deepEqual(INSTRUMENTED, { openai: ['chat.completions.create', 'responses.create'], anthropic: ['messages.create'] });
});

const require = createRequire(import.meta.url);
let hasOtel = true; try { require.resolve('@opentelemetry/sdk-trace-base'); require.resolve('@opentelemetry/exporter-trace-otlp-http'); } catch { hasOtel = false; }
test('otlp mode exports an instrumented call as a span with gen_ai attributes', { skip: !hasOtel && 'OTel packages not installed' }, async () => {
  const bodies = [];
  const server = createServer((req, res) => { const parts = []; req.on('data', (part) => parts.push(part)); req.on('end', () => { bodies.push(Buffer.concat(parts).toString('utf8')); res.writeHead(200, { 'content-type': 'application/json' }).end('{}'); }); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const trace = init('checkout', { mode: 'otlp', endpoint: `http://127.0.0.1:${server.address().port}`, apiKey: KEY });
    assert.match(trace.capture.skipped.join(' '), /openai: not wrapped; call trace\.instrument\(client\)/);
    const client = trace.instrument(new FakeOpenAI());
    assert.ok(!trace.capture.skipped.some((entry) => entry.startsWith('openai:')), 'a wrapped provider is no longer listed as skipped'); assert.ok(trace.capture.skipped.some((entry) => entry.startsWith('anthropic:')));
    await client.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'SECRET PROMPT' }] }); await settle();
    await trace.flush().flushed; await trace.close().shutdown;
  } finally { server.close(); }
  const sent = bodies.join('\n'); assert.ok(bodies.length, 'no OTLP request reached the listener');
  for (const fact of ['chat gpt-4o-mini', 'gen_ai.system', 'gen_ai.request.model', 'gen_ai.usage.input_tokens', 'chatcmpl-1']) assert.ok(sent.includes(fact), fact);
  assert.ok(!sent.includes('SECRET PROMPT'));
});

test('wrapping does not change unhandled-rejection behaviour: an unused failure is still reported, a handled one is not', async () => {
  const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util'); const { fileURLToPath } = await import('node:url');
  const sdk = new URL('../index.mjs', import.meta.url).href, dir = spool();
  // Run in a child process: Node's report is process-wide. Each case prints the unhandled rejections it saw.
  const script = `
    import { init } from ${JSON.stringify(sdk)};
    const seen = []; process.on('unhandledRejection', (error) => seen.push(error.message)); const handled = []; process.on('rejectionHandled', () => handled.push(1));
    const boom = () => new Error('provider down');
    const plain = { responses: { create: () => Promise.reject(boom()) } };
    const provider = { responses: { create: () => { const response = Promise.reject(boom()); return {
      then(resolve, reject) { return response.then(resolve, reject); }, catch(reject) { return response.catch(reject); },
      asResponse() { return response.then((value) => value); } }; } } };
    const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
    const out = {};
    for (const [name, client] of [['plain', plain], ['provider', provider]]) {
      for (const wrap of [false, true]) {
        const used = wrap ? init('checkout', { spool: ${JSON.stringify(dir)} }).instrument(client, { provider: 'openai' }) : client;
        seen.length = 0; used.responses.create({ model: 'gpt-4.1' }); await tick(); const unused = seen.length;
        seen.length = 0; try { await used.responses.create({ model: 'gpt-4.1' }); } catch {} await tick(); const awaited = seen.length;
        seen.length = 0; await used.responses.create({ model: 'gpt-4.1' }).catch(() => {}); await tick(); const caught = seen.length;
        // Caught one turn late: Node reports it unhandled, then handled.
        seen.length = 0; handled.length = 0; const pending = used.responses.create({ model: 'gpt-4.1' }); await new Promise((resolve) => setImmediate(resolve)); pending.catch(() => {}); await tick();
        out[name + (wrap ? ':wrapped' : ':bare')] = { unused, awaited, caught, lateUnhandled: seen.length, lateHandled: handled.length };
      }
    }
    console.log(JSON.stringify(out));`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { cwd: fileURLToPath(new URL('..', import.meta.url)) });
  const out = JSON.parse(stdout.trim().split('\n').at(-1));
  for (const name of ['plain', 'provider']) {
    assert.deepEqual(out[name + ':bare'], { unused: 1, awaited: 0, caught: 0, lateUnhandled: 1, lateHandled: 1 }, name + ' fixture behaves like a real promise');
    assert.deepEqual(out[name + ':wrapped'], out[name + ':bare'], name + ': wrapped matches unwrapped');
  }
});
