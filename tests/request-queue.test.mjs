// The dashboard's retry for the function throttle (#219). The production function has one execution slot; a request
// that arrives while another runs gets the function URL's own 429. The page retries that answer, and only that.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {retryingFetch, installRequestRetry, retryPause, RETRIES, throttled} from '../public/app/request-queue.js';

const origin = 'https://supatrace.dev';
const reply = (status, headers = {}) => new Response(status === 204 ? null : '{}', {status, headers});
// What the function URL answers when its one slot is taken (headers as observed on supatrace.dev).
const busy429 = () => new Response('{"Reason":"ReservedFunctionConcurrentInvocationLimitExceeded","Type":"User","message":"Rate Exceeded."}', {status: 429, headers: {'content-type': 'application/json', 'x-amzn-errortype': 'TooManyRequestsException'}});
/** A server with one execution slot: a request that arrives while another is running gets the throttle answer. */
function oneSlot(delay = 4) { let busy = false; const seen = []; return {seen, fetch: async input => { const path = new URL(typeof input === 'string' ? input : input.url, origin).pathname; if (busy) { seen.push('429 ' + path); return busy429(); } busy = true; await new Promise(resolve => setTimeout(resolve, delay)); busy = false; seen.push('200 ' + path); return reply(200); }}; }
// Test pauses are the real ones scaled down 30 times, so collisions still spread out and the test stays fast.
const quick = (ms, signal) => new Promise((resolve, reject) => { if (signal?.aborted) return reject(Object.assign(new Error('aborted'), {name: 'AbortError'})); signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'})), {once: true}); setTimeout(resolve, ms / 30); });

test('without the retry, requests that leave together collide on one slot; with it, every one of them succeeds', async () => {
  const paths = ['/api/me', '/api/projects', '/api/auth/providers'];
  const bare = oneSlot(), collided = await Promise.all(paths.map(path => bare.fetch(path)));
  assert.deepEqual(collided.map(r => r.status), [200, 429, 429], 'this is the failure on supatrace.dev');
  // The dashboard's startup (three requests) and a signed-in page (fourteen), many times over.
  for (const count of [3, 14]) for (let round = 0; round < 25; round++) {
    const server = oneSlot(), fetch = retryingFetch(server.fetch, origin, {wait: quick});
    const responses = await Promise.all(Array.from({length: count}, (unused, index) => fetch('/api/read' + index)));
    assert.deepEqual(responses.map(r => r.status), Array(count).fill(200), `${count} requests, round ${round}`);
    // They did leave together (the slot refused some of them), and each was served exactly once.
    assert.ok(server.seen.filter(line => line.startsWith('429')).length >= count - 1); assert.equal(server.seen.filter(line => line.startsWith('200')).length, count);
  }
});

test('the throttle answer is retried with a growing pause and then returned; no 429 from the application is ever retried', async () => {
  const waits = [], calls = [], fetch = retryingFetch(async input => { calls.push(input); return calls.length <= 2 ? busy429() : reply(200); }, origin, {wait: async ms => { waits.push(ms); }, random: () => 0});
  assert.equal((await fetch('/api/me')).status, 200); assert.equal(calls.length, 3); assert.deepEqual(waits, [80, 160]);
  assert.deepEqual([retryPause(0, () => 0), retryPause(4, () => 0), retryPause(11, () => 0), retryPause(0, () => 1)], [80, 400, 400, 580]);
  // Someone else holds the slot the whole time: the page gets the 429 after the last retry, not a hang.
  const stuck = [], always = retryingFetch(async input => { stuck.push(input); return busy429(); }, origin, {wait: async () => {}, random: () => 0});
  assert.equal((await always('/api/me')).status, 429); assert.equal(stuck.length, RETRIES + 1);
  // The application's own limit says when to come back; that answer goes straight to the page.
  const limited = [], app = retryingFetch(async input => { limited.push(input); return reply(429, {'Retry-After': '60'}); }, origin, {wait: async () => { throw new Error('must not wait'); }});
  const response = await app('/api/me'); assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '60'); assert.equal(limited.length, 1);
  // So does a plan-allowance refusal, which is a 429 with neither header: it is the application's answer and is final.
  const refusedOnce = [], allowance = retryingFetch(async input => { refusedOnce.push(input); return new Response('{"error":"monthly_span_allowance_exceeded"}', {status: 429, headers: {'content-type': 'application/json'}}); }, origin, {wait: async () => { throw new Error('must not wait'); }});
  assert.equal((await allowance('/api/batches')).status, 429); assert.equal(refusedOnce.length, 1);
  assert.equal(throttled(busy429()), true); assert.equal(throttled(reply(429)), false); assert.equal(throttled(reply(503, {'x-amzn-errortype': 'TooManyRequestsException'})), false);
});

test('only same-origin API requests are wrapped; requests are never held behind one another; failures pass through', async () => {
  const seen = []; let release;
  const fetch = retryingFetch(async input => { const url = String(typeof input === 'object' && !(input instanceof URL) ? input.url : input); seen.push(url); if (url.endsWith('/api/slow')) await new Promise(resolve => { release = resolve; }); if (url.includes('boom')) throw new TypeError('network'); return reply(200); }, origin);
  // A request that never answers does not delay the others (the startup probe runs beside the account reads).
  const slow = fetch('/api/slow'); assert.equal((await fetch('/api/next')).status, 200); assert.equal((await fetch(new URL('/api/url-object', origin))).status, 200);
  assert.deepEqual([(await fetch('/app/app.css')).status, (await fetch('https://example.com/api/x')).status], [200, 200]);
  await assert.rejects(fetch('/api/boom'), TypeError); release(); assert.equal((await slow).status, 200);
  assert.deepEqual(seen, ['/api/slow', '/api/next', origin + '/api/url-object', '/app/app.css', 'https://example.com/api/x', '/api/boom']);
  // Static files and other origins are not retried even on a throttle-shaped answer.
  const outside = [], other = retryingFetch(async input => { outside.push(input); return busy429(); }, origin, {wait: async () => { throw new Error('must not wait'); }});
  assert.equal((await other('/app/app.js')).status, 429); assert.equal((await other('https://example.com/api/x')).status, 429); assert.equal(outside.length, 2);
  // A Request object is cloned for each attempt, so a retried POST still has its body.
  const bodies = [], posting = retryingFetch(async input => { bodies.push(await input.text()); return bodies.length === 1 ? busy429() : reply(201); }, origin, {wait: async () => {}});
  assert.equal((await posting(new Request(origin + '/api/keys/create', {method: 'POST', body: '{"a":1}'}))).status, 201); assert.deepEqual(bodies, ['{"a":1}', '{"a":1}']);
});

test('an abort during the retry pause rejects with AbortError at once, for an init signal and for a Request signal', async () => {
  for (const viaRequest of [false, true]) {
    const controller = new AbortController(), tries = [], fetch = retryingFetch(async input => { tries.push(input); return busy429(); }, origin, {random: () => 0});
    const started = Date.now(), pending = viaRequest ? fetch(new Request(origin + '/api/me', {signal: controller.signal})) : fetch('/api/me', {signal: controller.signal});
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, {name: 'AbortError'}); assert.equal(tries.length, 1); assert.ok(Date.now() - started < 140, 'the pause was cut short');
  }
  // Already aborted before the first attempt: the underlying fetch decides, as it always did.
  const gone = new AbortController(); gone.abort();
  await assert.rejects(retryingFetch(async (input, init) => { if (init.signal.aborted) throw Object.assign(new Error('aborted'), {name: 'AbortError'}); return reply(200); }, origin)('/api/me', {signal: gone.signal}), {name: 'AbortError'});
});

test('installing wraps fetch once and leaves a page without fetch alone', async () => {
  const calls = [], page = {location: {origin}, fetch: async input => { calls.push(input); return reply(200); }};
  assert.equal(installRequestRetry(page), true); assert.equal(page.fetch.supatraceRetry, true); const wrapped = page.fetch;
  assert.equal(installRequestRetry(page), false); assert.equal(page.fetch, wrapped, 'a second module loading it does not wrap again');
  assert.equal((await page.fetch('/api/me')).status, 200); assert.deepEqual(calls, ['/api/me']);
  assert.equal(installRequestRetry({}), false); assert.equal(installRequestRetry(undefined), false);
});

test('every page that calls the API loads the retry before it makes a request', () => {
  const read = path => readFileSync(new URL('../public/' + path, import.meta.url), 'utf8');
  const app = read('app/app.js'), imports = [...app.matchAll(/^import [^\n]*?'([^']+)';/gm)].map(match => match[1]);
  assert.equal(imports[0], './request-queue.js');
  // The dashboard page loads app.js as its only script.
  assert.deepEqual([...read('app/index.html').matchAll(/<script[^>]*src="([^"]+)"/g)].map(match => match[1]), ['app.js']);
  assert.match(read('signin.js'), /^import '\.\/app\/request-queue\.js';$/m);
  for (const page of ['status/status.js', 'mcp/consent.js']) assert.match(read(page), /^import '\.\.\/app\/request-queue\.js';$/m, page);
});

// The public email/MFA forms share this caller. Production rejects an unhashed POST before the API runs.
test('sign-in form POST hashes exact UTF-8 JSON and preserves authentication errors', async () => {
  const originalDocument = globalThis.document;
  globalThis.document = {body: {dataset: {}}};
  let post;
  try { ({post} = await import('../public/signin.js')); }
  finally { if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument; }
  const {createHash} = await import('node:crypto');
  const original = globalThis.fetch;
  try {
    for (const path of ['sign-up', 'sign-in', 'confirm', 'forgot', 'reset', 'mfa', 'link', 'link/confirm']) {
      const body = {email: 'synthetic@example.invalid', password: 'Synthetic!9雪', code: '123456'};
      globalThis.fetch = async (url, init) => {
        assert.equal(url, '/api/auth/email/' + path);
        assert.equal(init.method, 'POST');
        assert.equal(init.credentials, 'same-origin');
        assert.equal(init.body, JSON.stringify(body));
        assert.equal(init.headers['content-type'], 'application/json');
        assert.equal(init.headers['x-amz-content-sha256'], createHash('sha256').update(init.body).digest('hex'));
        return reply(204);
      };
      assert.deepEqual(await post('/api/auth/email/' + path, body), {});
    }
    globalThis.fetch = async () => new Response('{"error":"invalid_credentials"}', {status: 401});
    await assert.rejects(post('/api/auth/email/sign-in', {}), {message: 'invalid_credentials', status: 401});
  } finally { globalThis.fetch = original; }
});
