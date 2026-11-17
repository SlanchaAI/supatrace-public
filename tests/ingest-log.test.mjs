// Ingest log (#88): every ingest route records its outcome for the workspace the key resolved to, and
// GET /api/logs and GET /api/v1/logs read those rows. Runs against the real handler over HTTP and the in-memory store.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {start as startHarness} from './harness.mjs';
// These tests invite read-only members, which needs the roles feature: fixture organizations are on Pro. tests/entitlements.test.mjs covers the gates.
const start = (options = {}) => startHarness({plan: 'pro', ...options});
import {digest} from '../src/aws-auth.mjs';
import {INGEST_LOG, INGEST_REASONS, ingestAttempt, ingestDetail, ingestFailure, recordIngest} from '../src/ingest-log.mjs';
import {IntakeError} from '../src/trace.mjs';
import {HttpError} from '../src/http.mjs';
import {logsQuery, validateLogs, storedText} from '../public/app/logs.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
async function account(live, id) { let cookie = ''; const tenant = await live.signIn({addCookies: async value => { cookie = value.map(c => c.name + '=' + c.value).join('; '); }}, id); return {tenant, cookie}; }
const batch = (run, extra = {}) => ({version: 1, batch_id: run + '-b', run_id: run, events: [{id: run + '-e', time: '2026-11-14T20:00:00.000Z', kind: 'note', name: 'synthetic', data: {}}], ...extra});
const send = (live, key, body, headers = {}) => { const raw = typeof body === 'string' ? body : JSON.stringify(body); return fetch(live.origin + '/api/batches', {method: 'POST', headers: {'content-type': 'application/json', 'x-supatrace-key': key, 'x-amz-content-sha256': digest(raw), ...headers}, body: raw}); };
const span = (trace, id = '00f067aa0ba902b7') => ({traceId: trace, spanId: id, name: 'synthetic span', startTimeUnixNano: '1794685870000000000', endTimeUnixNano: '1794685871500000000'});
const otlp = (live, key, spans, path = '/v1/traces') => fetch(live.origin + path, {method: 'POST', headers: {'content-type': 'application/json', 'x-supatrace-key': key}, body: typeof spans === 'string' ? spans : JSON.stringify({resourceSpans: [{scopeSpans: [{spans}]}]})});
const langfuse = (live, key, events) => fetch(live.origin + '/api/public/ingestion', {method: 'POST', headers: {'content-type': 'application/json', authorization: 'Basic ' + Buffer.from('pk-supatrace:' + key).toString('base64')}, body: JSON.stringify({batch: events})});
const logs = async (live, cookie, query = '') => { const r = await fetch(live.origin + '/api/logs' + query, {headers: {cookie}}); assert.equal(r.status, 200, await r.clone().text()); return r.json(); };
const TRACE = '0af7651916cd43dd8448eb211c80319c';

test('batch uploads: accepted, repeated and refused requests are each recorded with their code', async () => {
  const live = await start(); try {
    const {tenant, cookie} = await account(live), key = await live.writeKey(tenant), prefix = digest(key).slice(0, 12);
    assert.deepEqual((await logs(live, cookie)).attempts, []); assert.deepEqual((await logs(live, cookie, '?stream=accepted')).attempts, []);
    const raw = JSON.stringify(batch('run-a'));
    assert.equal((await send(live, key, raw)).status, 201); assert.equal((await send(live, key, raw)).status, 201);
    assert.equal((await send(live, key, raw, {'x-amz-content-sha256': '0'.repeat(64)})).status, 400);
    assert.equal((await send(live, key, batch('run-b', {surprise: true}))).status, 400);
    assert.equal((await send(live, key, '{not json')).status, 400);
    assert.equal((await send(live, key, {...batch('run-a'), events: [{...batch('run-a').events[0], name: 'changed'}]})).status, 409);
    const accepted = await logs(live, cookie, '?stream=accepted'), issues = await logs(live, cookie);
    assert.equal(accepted.stream, 'accepted'); assert.equal(accepted.workspace_id, tenant); assert.equal(accepted.environment_id, 'default'); assert.equal(accepted.retention_days, INGEST_LOG.retention_days);
    assert.deepEqual(accepted.recorded, {issues_per_minute: 30, unauthenticated_requests: false, best_effort: true}); assert.equal(accepted.next, null); assert.equal(accepted.truncated, false);
    // Newest first: the repeat, then the first upload.
    assert.deepEqual(accepted.attempts.map(a => [a.route, a.outcome, a.http_status, a.reason, a.message, a.batches, a.repeated_batches, a.stored_events, a.rejected_events, a.stored_bytes, a.stored_trace_id, a.stored_trace_count, a.key_prefix]),
      [['batches', 'accepted', 201, null, null, 1, 1, 1, null, Buffer.byteLength(raw), 'run-a', 1, prefix], ['batches', 'accepted', 201, null, null, 1, 0, 1, null, Buffer.byteLength(raw), 'run-a', 1, prefix]]);
    assert.deepEqual(issues.attempts.map(a => [a.outcome, a.http_status, a.reason]), [['rejected', 409, 'idempotency_conflict'], ['rejected', 400, 'invalid_json'], ['rejected', 400, 'unknown_field'], ['rejected', 400, 'payload_hash_required']]);
    for (const a of issues.attempts) { assert.equal(a.message, INGEST_REASONS[a.reason]); assert.equal(a.batches, 0); assert.equal(a.stored_events, 0); assert.equal(a.stored_trace_id, null); assert.equal(a.stored_trace_count, 0); assert.equal(a.key_prefix, prefix); assert.match(a.id, /^[a-f0-9]{16}$/); }
    // The key itself, its full id and the payload are not in the log.
    const text = JSON.stringify([accepted, issues]); assert.ok(!text.includes(key) && !text.includes(digest(key)) && !text.includes('synthetic'));
    // A request that names no workspace is answered 401 and leaves no row anywhere.
    assert.equal((await send(live, randomBytes(32).toString('base64url'), raw)).status, 401); assert.equal((await fetch(live.origin + '/api/batches', {method: 'POST', headers: {'content-type': 'application/json'}, body: raw})).status, 401);
    assert.equal((await logs(live, cookie)).attempts.length, 4); assert.equal((await logs(live, cookie, '?stream=accepted')).attempts.length, 2);
    // Filters, paging, and refused queries.
    assert.deepEqual((await logs(live, cookie, '?reason=unknown_field')).attempts.map(a => a.reason), ['unknown_field']); assert.deepEqual((await logs(live, cookie, '?route=otlp')).attempts, []);
    const first = await logs(live, cookie, '?limit=3'); assert.equal(first.attempts.length, 3); assert.ok(first.next); assert.equal(first.truncated, false);
    const second = await logs(live, cookie, '?limit=3&after=' + first.next); assert.deepEqual([...first.attempts, ...second.attempts].map(a => a.id), issues.attempts.map(a => a.id)); assert.equal(second.next, null);
    const exact = await logs(live, cookie, '?limit=4'); assert.equal(exact.attempts.length, 4); assert.equal(exact.next, null);
    assert.equal((await logs(live, cookie, '?from=' + new Date(Date.now() + 3600e3).toISOString())).attempts.length, 0); assert.equal((await logs(live, cookie, '?to=' + new Date(Date.now() - 3600e3).toISOString())).attempts.length, 0);
    assert.equal((await logs(live, cookie, '?from=' + new Date(Date.now() - 3600e3).toISOString() + '&to=' + new Date(Date.now() + 3600e3).toISOString())).attempts.length, 4);
    for (const bad of ['?stream=all', '?route=grpc', '?reason=Not-A-Code', '?limit=0', '?limit=201', '?from=yesterday', '?unknown=1', '?route=otlp&route=batches']) assert.equal((await fetch(live.origin + '/api/logs' + bad, {headers: {cookie}})).status, 400, bad);
    assert.equal((await fetch(live.origin + '/api/logs?after=' + Buffer.from(JSON.stringify({pk: 'INGESTLOG#someone-else#default', sk: 'ISSUE#0'})).toString('base64url'), {headers: {cookie}})).status, 400);
    assert.equal((await fetch(live.origin + '/api/logs')).status, 401);
    // A viewer of the shared workspace reads the rows without key prefixes (a viewer cannot list keys); an admin gets them.
    const member = await account(live, 6262), post = async (who, path, data) => { const r = await fetch(live.origin + '/api/' + path, {method: 'POST', headers: {cookie: who, origin: live.origin, 'content-type': 'application/json'}, body: JSON.stringify(data)}); assert.ok(r.ok, path + ' ' + r.status + ' ' + await r.clone().text()); return r.json(); };
    await post(cookie, 'workspaces', {name: 'Shared'}); const invite = await post(cookie, 'workspaces/invite', {recipient_id: member.tenant, role: 'viewer'}); await post(member.cookie, 'workspaces/accept', {workspace_id: tenant, token: invite.token});
    const shared = await logs(live, member.cookie, '?workspace=' + encodeURIComponent(tenant)); assert.equal(shared.attempts.length, 4); assert.ok(shared.attempts.every(a => a.key_prefix === null)); assert.ok(!JSON.stringify(shared).includes(prefix));
    assert.deepEqual((await logs(live, member.cookie)).attempts, [], 'the viewer\'s own workspace has its own, empty log');
  } finally { await live.close(); }
});

test('OTLP and Langfuse requests are recorded as accepted, partly stored or rejected, with the refusal detail', async () => {
  const live = await start(); try {
    const {tenant, cookie} = await account(live), key = await live.writeKey(tenant);
    assert.equal((await otlp(live, key, [span(TRACE)])).status, 200);
    assert.equal((await otlp(live, key, [span('1bf7651916cd43dd8448eb211c80319c'), {traceId: 'nope', spanId: 'x', name: 'bad'}], '/api/otlp/v1/traces')).status, 200);
    assert.equal((await otlp(live, key, [{traceId: 'nope', spanId: 'x', name: 'bad'}])).status, 400);
    assert.equal((await otlp(live, key, '{broken')).status, 400);
    assert.equal((await langfuse(live, key, [{id: 'e1', type: 'trace-create', timestamp: '2026-11-14T20:00:00.000Z', body: {id: 'checkout', name: 'checkout'}}])).status, 207);
    assert.equal((await langfuse(live, key, [{id: 'e2', type: 'trace-create', timestamp: '2026-11-14T20:00:00.000Z', body: {id: 'cart', name: 'cart'}}, {id: 'e3', type: 'bogus-type', timestamp: '2026-11-14T20:00:00.000Z', body: {}}])).status, 207);
    assert.equal((await langfuse(live, key, [{id: 'e4', type: 'bogus-type', timestamp: '2026-11-14T20:00:00.000Z', body: {}}, {id: 'e5', type: 'bogus-type', timestamp: '2026-11-14T20:00:00.000Z', body: {}}])).status, 207);
    assert.equal((await langfuse(live, key, [])).status, 400);
    const accepted = await logs(live, cookie, '?stream=accepted'), issues = await logs(live, cookie);
    assert.deepEqual(accepted.attempts.map(a => [a.route, a.outcome, a.http_status, a.batches, a.stored_events, a.rejected_events, a.stored_trace_id]), [['langfuse', 'accepted', 207, 1, 1, 0, 'lf.checkout'], ['otlp', 'accepted', 200, 1, 1, 0, 'otlp.' + TRACE]]);
    assert.deepEqual(issues.attempts.map(a => [a.route, a.outcome, a.http_status, a.reason, a.stored_events, a.rejected_events]), [
      ['langfuse', 'rejected', 400, 'invalid_langfuse_batch', 0, null], ['langfuse', 'rejected', 207, 'no_event_stored', 0, 2], ['langfuse', 'partial', 207, 'partly_stored', 1, 1],
      ['otlp', 'rejected', 400, 'invalid_otlp', 0, null], ['otlp', 'rejected', 400, 'no_valid_spans', 0, 1], ['otlp', 'partial', 200, 'partly_stored', 1, 1]]);
    // The refusal detail is fixed text: the sender's own event type is not quoted into the log.
    assert.equal(issues.attempts[1].detail, '2 × Event type is not accepted.'); assert.equal(issues.attempts[2].detail, '1 × Event type is not accepted.'); assert.ok(!JSON.stringify(issues).includes('bogus-type'));
    assert.match(issues.attempts[4].detail, /^1 × invalid span/); assert.match(issues.attempts[5].detail, /^1 × invalid span/);
    // Trace fields describe what was stored: the partly stored requests name their one stored trace, the rejected ones name none.
    assert.deepEqual(issues.attempts.map(a => [a.stored_trace_count, a.stored_trace_id]), [[0, null], [0, null], [1, 'lf.cart'], [0, null], [0, null], [1, 'otlp.1bf7651916cd43dd8448eb211c80319c']]);
    assert.deepEqual((await logs(live, cookie, '?route=langfuse')).attempts.map(a => a.route), ['langfuse', 'langfuse', 'langfuse']); assert.deepEqual((await logs(live, cookie, '?route=otlp&reason=partly_stored')).attempts.length, 1);
    // A wrong content type is refused before the key is read, so it names no workspace and is not recorded; a bad key likewise.
    assert.equal((await fetch(live.origin + '/v1/traces', {method: 'POST', headers: {'content-type': 'text/plain', 'x-supatrace-key': key}, body: '{}'})).status, 415);
    assert.equal((await otlp(live, randomBytes(32).toString('base64url'), [span(TRACE)])).status, 401); assert.equal((await logs(live, cookie)).attempts.length, 6);
  } finally { await live.close(); }
});

test('the upload rate refusal is recorded, another account cannot read the log, and a personal access token reads the same rows', async () => {
  const live = await start(); try {
    const owner = await account(live), other = await account(live, 5252), key = await live.writeKey(owner.tenant);
    // The harness stubs the limiter; this test runs the real one.
    delete live.store.consumeRate;
    for (let i = 0; i < 30; i++) assert.equal((await send(live, key, batch('run-' + i))).status, 201);
    const limited = await send(live, key, batch('run-30')); assert.equal(limited.status, 429);
    const issues = await logs(live, owner.cookie); assert.deepEqual(issues.attempts.map(a => [a.route, a.outcome, a.http_status, a.reason, a.message]), [['batches', 'rejected', 429, 'rate_limit', INGEST_REASONS.rate_limit]]);
    // One request reads 50 rows by default and says more remain.
    const page = await logs(live, owner.cookie, '?stream=accepted&limit=20'); assert.equal(page.attempts.length, 20); assert.ok(page.next);
    assert.deepEqual((await logs(live, other.cookie)).attempts, []); assert.deepEqual((await logs(live, other.cookie, '?stream=accepted')).attempts, []);
    assert.equal((await fetch(live.origin + '/api/logs?workspace=' + encodeURIComponent(owner.tenant), {headers: {cookie: other.cookie}})).status, 403);
    const token = 'stpat_' + randomBytes(32).toString('base64url'), made = await fetch(live.origin + '/api/tokens', {method: 'POST', headers: {cookie: owner.cookie, origin: live.origin, 'content-type': 'application/json'}, body: JSON.stringify({name: 'ci', token_hash: digest(token)})}); assert.equal(made.status, 201);
    const viaToken = await fetch(live.origin + '/api/v1/logs?stream=issues', {headers: {authorization: 'Bearer ' + token}}); assert.equal(viaToken.status, 200); assert.deepEqual((await viaToken.json()).attempts, issues.attempts);
    assert.equal((await fetch(live.origin + '/api/v1/logs?offset=1', {headers: {authorization: 'Bearer ' + token}})).status, 400);
    // A write key is not a reading credential on the management route.
    assert.equal((await fetch(live.origin + '/api/v1/logs', {headers: {authorization: 'Bearer ' + key}})).status, 401);
  } finally { await live.close(); }
});

test('rows are partitioned by environment, hidden after expiry, capped per minute for refusals, and a failed log write never fails an upload', async () => {
  const live = await start(); try {
    const {tenant, cookie} = await account(live), key = await live.writeKey(tenant), store = live.store;
    delete store.consumeRate;
    const attempt = environment => { const a = ingestAttempt('otlp'); a.bind({tenant_id: tenant, token_hash: 'ab'.repeat(32), ...(environment ? {environment_id: environment} : {})}); return a; };
    assert.equal(await recordIngest(store, attempt('dev'), {status: 400, code: 'invalid_otlp'}), true); assert.deepEqual((await logs(live, cookie)).attempts, []);
    // An unbound attempt (no key resolved) writes nothing.
    assert.equal(await recordIngest(store, ingestAttempt('batches'), {status: 401, code: 'invalid_write_key'}), false);
    // A request that failed after storing part of itself is partial, with the error code kept; one that stored nothing is rejected.
    const part = attempt(); part.stored({run_id: 'r1', events: [{}, {}]}, 'xx', true);
    assert.equal(await recordIngest(store, part, {status: 503, code: 'temporarily_unavailable'}), true);
    const none = attempt(); assert.equal(await recordIngest(store, none, {status: 207, rejected: 2}), true);
    const mixed = await logs(live, cookie, '?limit=2'); assert.deepEqual(mixed.attempts.map(a => [a.outcome, a.http_status, a.reason, a.stored_events, a.rejected_events]), [['rejected', 207, 'no_event_stored', 0, 2], ['partial', 503, 'temporarily_unavailable', 2, null]]);
    // Refusals stop being recorded past the per-minute cap; accepted requests are bounded by the upload rate instead.
    const results = []; for (let i = 0; i < INGEST_LOG.issues_per_minute + 3; i++) results.push(await recordIngest(store, attempt(), {status: 400, code: 'invalid_otlp', detail: 'line\u0000one\ntwo'}));
    assert.equal(results.filter(Boolean).length, INGEST_LOG.issues_per_minute - 3, 'the three refusals above used three of this minute\'s slots');
    assert.equal(await recordIngest(store, attempt(), {status: 200}), true);
    const issues = await logs(live, cookie); assert.equal(issues.attempts.length, INGEST_LOG.issues_per_minute - 1); assert.equal(issues.attempts[0].detail, 'line one two'); assert.equal(issues.attempts[0].key_prefix, 'abababababab');
    // An unknown code is stored as a generic one, never as free text.
    const odd = ingestAttempt('batches'); odd.bind({tenant_id: tenant + '-odd', token_hash: 'cd'.repeat(32)});
    assert.equal(await recordIngest(store, odd, {status: 500, code: 'Not A Code <script>'}), true);
    // An expired row is not listed even before DynamoDB TTL removes it.
    const now = store.now(); await store._send('PutCommand', {Item: {pk: `INGESTLOG#${tenant}#default`, sk: 'OK#000000000000#0000000#feedfacefeedface', attempt_id: 'feedfacefeedface', workspace_id: tenant, environment_id: 'default', at: now, route: 'otlp', outcome: 'accepted', http_status: 200, reason: null, expires_at: now - 1, ttl: now - 1}});
    assert.ok(!(await logs(live, cookie, '?stream=accepted')).attempts.some(a => a.id === 'feedfacefeedface'));
    // The log write failing or hanging does not change the upload's answer.
    const send_ = store._send.bind(store); let mode = 'throw';
    store._send = (name, input) => name === 'PutCommand' && String(input?.Item?.pk).startsWith('INGESTLOG#') ? (mode === 'throw' ? Promise.reject(new Error('log table down')) : new Promise(() => {})) : send_(name, input);
    const errors = [], original = console.error; console.error = line => errors.push(line);
    try { assert.equal((await send(live, key, batch('survives'))).status, 201); mode = 'hang'; const started = Date.now(); assert.equal((await send(live, key, batch('survives-2'))).status, 201); assert.ok(Date.now() - started < 3000); }
    finally { console.error = original; store._send = send_; }
    assert.deepEqual(errors.map(line => JSON.parse(line).event), ['ingest_log_write_failed']);
  } finally { await live.close(); }
});

test('helpers: failure mapping, detail summary, and the dashboard module', () => {
  assert.deepEqual(ingestFailure(new SyntaxError('x')), {status: 400, code: 'invalid_json'}); assert.deepEqual(ingestFailure(new IntakeError('invalid_time', 'x')), {status: 400, code: 'invalid_time'});
  assert.deepEqual(ingestFailure(new HttpError(403, 'spend_cap_reached')), {status: 403, code: 'spend_cap_reached'}); assert.deepEqual(ingestFailure(new Error('boom')), {status: 503, code: 'temporarily_unavailable'});
  assert.equal(ingestDetail(['a', 'b', 'a', '', null, 'c', 'd', 'e', 'f']), '2 × a; 1 × b; 1 × c; 1 × d; 1 × e'); assert.equal(ingestDetail([]), '');
  assert.throws(() => ingestAttempt('grpc'));
  for (const code of Object.keys(INGEST_REASONS)) assert.match(code, /^[a-z][a-z0-9_]{0,63}$/);
  assert.equal(logsQuery().toString(), ''); assert.equal(logsQuery({stream: 'accepted', route: 'otlp', reason: ' rate_limit '}).toString(), 'stream=accepted&route=otlp&reason=rate_limit');
  const dated = logsQuery({from: '2026-11-10', to: '2026-11-12'}); assert.ok(Date.parse(dated.get('to')) - Date.parse(dated.get('from')) > 2 * 86400e3);
  const row = {id: 'a', time: '2026-11-14T00:00:00Z', route: 'otlp', outcome: 'partial', http_status: 200, reason: 'partly_stored', message: 'm', detail: null, key_prefix: 'abc', batches: 2, repeated_batches: 1, stored_events: 3, rejected_events: 1, stored_bytes: 10, stored_trace_id: null, stored_trace_count: 2};
  const good = {stream: 'issues', retention_days: 7, attempts: [row], next: null, truncated: false}; assert.equal(validateLogs(good), good);
  for (const broken of [{}, {...good, stream: 'all'}, {...good, truncated: 'no'}, {...good, next: 5}, {...good, attempts: [{...row, route: 'grpc'}]}, {...good, attempts: [{...row, outcome: 'ok'}]}, {...good, attempts: [{...row, stored_events: -1}]}, {...good, attempts: [{...row, time: 'never'}]}, {...good, attempts: [{...row, detail: 'x'.repeat(401)}]}]) assert.throws(() => validateLogs(broken), /invalid_response/);
  assert.equal(storedText(row), '3 events in 2 batches · 1 batch already stored by an earlier request · 1 event refused');
  // Unknown is not zero: a refused batch upload has no event count to show.
  assert.equal(storedText({stored_events: null, batches: null, rejected_events: null}), 'Not recorded'); assert.equal(storedText({stored_events: 0, batches: 0, rejected_events: null}), '0 events in 0 batches');
  const app = readFileSync(repo + 'public/app/app.js', 'utf8'), view = readFileSync(repo + 'public/app/logs.js', 'utf8');
  assert.match(app, /^import '\.\/logs\.js';$/m); assert.match(view, /^if \(typeof document !== 'undefined'\) mountLogs\(document\);$/m);
  assert.ok(view.includes('data-nav="logs"') && view.includes('id="view-logs"'), 'the proof grep in issue #88 matches');
  assert.match(readFileSync(repo + 'docs/logs.md', 'utf8'), /GET \/api\/v1\/logs/);
});
