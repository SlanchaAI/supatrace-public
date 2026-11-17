// Trace drains: real handler and store logic (in-memory DynamoDB adapter) delivering to a local
// HTTP receiver that verifies the signature. The production transport's address checks and
// pinning are tested directly, because it refuses loopback by design.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHmac,createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {start as startHarness} from './harness.mjs';
// These tests exercise paid features, so every fixture organization is on Enterprise. tests/entitlements.test.mjs covers the gates.
const start = (options = {}) => startHarness({plan: 'enterprise', ...options});
import {digest} from '../src/aws-auth.mjs';
import {validateDrainUrl, publicAddress, safeTransport, drainSignature, deliverDrains, enqueueDrainDeliveries, listDrains, DRAIN_LIMITS} from '../src/drains.mjs';

// A receiver that records each delivery and answers with whatever `respond` returns.
async function receiver() {
  const received = []; let status = 200;
  const server = createServer((req, res) => { const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => { received.push({headers: req.headers, body: Buffer.concat(chunks).toString()}); res.writeHead(status).end(); }); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return {received, port: server.address().port, set status(value) { status = value; }, close: () => new Promise(done => { server.closeAllConnections?.(); server.close(done); })};
}
// Test transport: the public https URL of a drain is delivered to the local receiver instead.
const localTransport = port => async ({body, headers}) => { const r = await fetch('http://127.0.0.1:' + port + '/hook', {method: 'POST', headers, body, redirect: 'manual'}); return r.status >= 200 && r.status < 300 ? {ok: true, status: r.status} : {ok: false, status: r.status, error: 'http_' + r.status}; };
async function setup() {
  const hook = await receiver(); let env;
  const live = await start({configureEnvironment: async e => { env = e; e.drainTransport = localTransport(hook.port); }});
  const account = async id => { let cookie = ''; const tenant = await live.signIn({addCookies: async value => { cookie = value.map(c => c.name + '=' + c.value).join('; '); }}, id); return {tenant, cookie}; };
  const post = (cookie, path, data, origin = live.origin) => fetch(live.origin + '/api/' + path, {method: 'POST', headers: {cookie, origin, 'content-type': 'application/json'}, body: JSON.stringify(data)});
  const list = async cookie => (await (await fetch(live.origin + '/api/drains', {headers: {cookie}})).json()).drains;
  const batch = n => ({version: 1, batch_id: 'batch-' + n, run_id: 'run-' + n, events: [{id: 'e1', time: '2026-11-14T00:00:0' + n % 10 + 'Z', kind: 'note', name: 'synthetic ' + n, data: {n}}]});
  return {hook, live, env: () => env, account, post, list, batch, close: async () => { await live.close(); await hook.close(); }};
}
const verify = (secret, delivery) => { const [, t, v1] = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(delivery.headers['x-supatrace-signature']); return v1 === createHmac('sha256', secret).update(t + '.' + delivery.body).digest('hex'); };

test('an accepted batch is delivered once, signed, with the batch body; the secret is shown only at creation', async () => {
  const t = await setup(); try {
    const owner = await t.account(), key = await t.live.writeKey(owner.tenant);
    const created = await t.post(owner.cookie, 'drains', {url: 'https://hooks.customer-site.com/supatrace?x=1'}); assert.equal(created.status, 201);
    const drain = await created.json(); assert.match(drain.secret, /^whsec_[A-Za-z0-9_-]{43}$/); assert.match(drain.id, /^[a-f0-9]{16}$/); assert.equal(drain.url, 'https://hooks.customer-site.com/supatrace?x=1');
    assert.ok(!JSON.stringify(await t.list(owner.cookie)).includes(drain.secret)); assert.ok(!JSON.stringify(await t.list(owner.cookie)).includes('secret'));
    await t.live.upload(key, t.batch(1));
    assert.equal(t.hook.received.length, 1); const delivery = t.hook.received[0], body = JSON.parse(delivery.body);
    assert.ok(verify(drain.secret, delivery)); assert.ok(!verify('whsec_wrong', delivery)); assert.equal(delivery.headers['x-supatrace-signature'], drainSignature(drain.secret, /t=(\d+)/.exec(delivery.headers['x-supatrace-signature'])[1], delivery.body));
    assert.equal(delivery.headers['x-supatrace-event'], 'batch.accepted'); assert.equal(delivery.headers['x-supatrace-delivery'], body.id); assert.equal(delivery.headers['content-type'], 'application/json');
    assert.deepEqual({type: body.type, workspace_id: body.workspace_id, environment_id: body.environment_id, batch_id: body.batch_id, run_id: body.run_id, event_count: body.event_count}, {type: 'batch.accepted', workspace_id: owner.tenant, environment_id: 'default', batch_id: 'batch-1', run_id: 'run-1', event_count: 1});
    assert.deepEqual(Object.keys(body), ['id', 'type', 'created_at', 'workspace_id', 'project_id', 'environment_id', 'batch_id', 'run_id', 'request_hash', 'event_count', 'byte_count', 'batch']);
    assert.deepEqual(body.batch, t.batch(1)); assert.equal(body.request_hash, digest(JSON.stringify(t.batch(1)))); assert.ok(!delivery.body.includes(key) && !delivery.body.includes(drain.secret));
    // A resent upload of the same batch is not delivered again.
    await t.live.upload(key, t.batch(1)); assert.equal(t.hook.received.length, 1);
    const [row] = await t.list(owner.cookie); assert.deepEqual({delivered: row.delivered, failed: row.failed, queued: row.queued, last_status: row.last_status, paused_until: row.paused_until}, {delivered: 1, failed: 0, queued: 0, last_status: 200, paused_until: null});
    // OTLP ingest goes through the same path.
    const otlp = await fetch(t.live.origin + '/v1/traces', {method: 'POST', headers: {'content-type': 'application/json', 'x-supatrace-key': key}, body: JSON.stringify({resourceSpans: [{scopeSpans: [{spans: [{traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'aaaaaaaaaaaaaaaa', name: 's', startTimeUnixNano: '1794685870000000000', endTimeUnixNano: '1794685871000000000'}]}]}]})});
    assert.equal(otlp.status, 200); assert.equal(t.hook.received.length, 2); assert.equal(JSON.parse(t.hook.received[1].body).run_id, 'otlp.0af7651916cd43dd8448eb211c80319c');
    // The test ping is signed the same way and does not count as a delivery.
    const ping = await (await t.post(owner.cookie, 'drains/test', {id: drain.id})).json(); assert.deepEqual(ping, {delivered: true, status: 200, error: null});
    assert.equal(JSON.parse(t.hook.received[2].body).type, 'drain.test'); assert.ok(verify(drain.secret, t.hook.received[2])); assert.equal((await t.list(owner.cookie))[0].delivered, 2);
  } finally { await t.close(); }
});

test('a failing endpoint is retried later in order, pauses instead of slowing uploads, and gives up after the attempt cap', async () => {
  const t = await setup(); try {
    const owner = await t.account(), key = await t.live.writeKey(owner.tenant), drain = await (await t.post(owner.cookie, 'drains', {url: 'https://hooks.customer-site.com/a'})).json();
    t.hook.status = 500;
    await t.live.upload(key, t.batch(1)); assert.equal(t.hook.received.length, 1);
    let [row] = await t.list(owner.cookie); assert.deepEqual({delivered: row.delivered, failed: row.failed, queued: row.queued, last_status: row.last_status, last_error: row.last_error}, {delivered: 0, failed: 0, queued: 1, last_status: 500, last_error: 'http_500'}); assert.ok(row.paused_until);
    // While paused, uploads are accepted and queued without another attempt.
    const tick = () => new Promise(done => setTimeout(done, 3));
    await tick(); await t.live.upload(key, t.batch(2)); await tick(); await t.live.upload(key, t.batch(3)); assert.equal(t.hook.received.length, 1); assert.equal((await t.list(owner.cookie))[0].queued, 3);
    // After the pause the next upload retries the oldest first; a recovered endpoint drains the queue in order.
    const store = t.live.store, real = store.now.bind(store); let shift = DRAIN_LIMITS.pauses[0] + 1; store.now = () => real() + shift;
    t.hook.status = 200; await t.live.upload(key, t.batch(4));
    assert.deepEqual(t.hook.received.slice(1).map(d => JSON.parse(d.body).batch_id), ['batch-1', 'batch-2', 'batch-3']);
    const flushed = await (await t.post(owner.cookie, 'drains/flush', {})).json(); assert.deepEqual(flushed, {attempted: 1, delivered: 1, failed: 0}); assert.equal(JSON.parse(t.hook.received.at(-1).body).batch_id, 'batch-4');
    [row] = await t.list(owner.cookie); assert.deepEqual({delivered: row.delivered, queued: row.queued, paused_until: row.paused_until}, {delivered: 4, queued: 0, paused_until: null});
    // A resent upload that stores nothing new still retries what is queued.
    t.hook.status = 500; shift += 7200; await t.live.upload(key, t.batch(7)); assert.equal((await t.list(owner.cookie))[0].queued, 1); const queuedAt = t.hook.received.length;
    t.hook.status = 200; shift += DRAIN_LIMITS.pauses[0] + 1; await t.live.upload(key, t.batch(7));
    assert.equal(t.hook.received.length, queuedAt + 1); assert.equal(JSON.parse(t.hook.received.at(-1).body).batch_id, 'batch-7'); assert.equal((await t.list(owner.cookie))[0].queued, 0);
    // A retried delivery carries the same delivery id, so a receiver can de-duplicate.
    assert.equal(t.hook.received[0].headers['x-supatrace-delivery'], t.hook.received[1].headers['x-supatrace-delivery']);
    // An endpoint that never recovers: the batch is given up after the cap and counted as failed. It stays stored and exportable.
    t.hook.status = 503; await t.live.upload(key, t.batch(5)); const before = t.hook.received.length;
    for (let attempt = 1; attempt < DRAIN_LIMITS.attempts; attempt++) assert.deepEqual(await (await t.post(owner.cookie, 'drains/flush', {})).json(), {attempted: 1, delivered: 0, failed: 1});
    assert.equal(t.hook.received.length - before, DRAIN_LIMITS.attempts - 1); [row] = await t.list(owner.cookie); assert.deepEqual({failed: row.failed, queued: row.queued, delivered: row.delivered}, {failed: 1, queued: 0, delivered: 5});
    assert.deepEqual(await (await t.post(owner.cookie, 'drains/flush', {})).json(), {attempted: 0, delivered: 0, failed: 0});
    // Deliveries older than the retention window are dropped without an attempt.
    await t.live.upload(key, t.batch(6)); const seen = t.hook.received.length; shift += DRAIN_LIMITS.maxAgeSeconds + 1;
    try { assert.deepEqual(await deliverDrains(t.env(), owner.tenant, {resume: true}), {attempted: 0, delivered: 0, failed: 1}); } finally { store.now = real; }
    assert.equal(t.hook.received.length, seen); [row] = await t.list(owner.cookie); assert.deepEqual({failed: row.failed, queued: row.queued, last_error: row.last_error}, {failed: 2, queued: 0, last_error: 'expired'});
  } finally { await t.close(); }
});

test('only owners and admins of the workspace manage its drains; other workspaces never reach them', async () => {
  const t = await setup(); try {
    const owner = await t.account(), other = await t.account(5252), viewer = await t.account(6262), key = await t.live.writeKey(owner.tenant), otherKey = await t.live.writeKey(other.tenant);
    const drain = await (await t.post(owner.cookie, 'drains', {url: 'https://hooks.customer-site.com/a'})).json();
    assert.equal((await t.post(owner.cookie, 'drains', {url: 'https://hooks.customer-site.com/a'}, 'https://evil.example')).status, 403);
    assert.equal((await t.post('', 'drains', {url: 'https://hooks.customer-site.com/a'})).status, 401); assert.equal((await fetch(t.live.origin + '/api/drains')).status, 401);
    assert.deepEqual(await t.list(other.cookie), []);
    for (const path of ['drains/delete', 'drains/test']) assert.equal((await t.post(other.cookie, path, {id: drain.id})).status, 404, path);
    assert.equal((await fetch(t.live.origin + '/api/drains?workspace=' + owner.tenant, {headers: {cookie: other.cookie}})).status, 403);
    await t.live.upload(otherKey, t.batch(1)); assert.equal(t.hook.received.length, 0);
    await t.live.upload(key, t.batch(1)); assert.equal(t.hook.received.length, 1);
    // A viewer of a shared workspace cannot see or change drains; an admin can.
    assert.equal((await t.post(owner.cookie, 'workspaces', {name: 'Team'})).status, 201);
    for (const [member, role] of [[viewer, 'viewer'], [other, 'admin']]) { const invite = await (await t.post(owner.cookie, 'workspaces/invite', {recipient_id: member.tenant, role})).json(); assert.equal((await t.post(member.cookie, 'workspaces/accept', {workspace_id: owner.tenant, token: invite.token})).status, 200); }
    assert.equal((await fetch(t.live.origin + '/api/drains?workspace=' + owner.tenant, {headers: {cookie: viewer.cookie}})).status, 403);
    assert.equal((await t.post(viewer.cookie, 'drains?workspace=' + owner.tenant, {url: 'https://hooks.customer-site.com/v'})).status, 403);
    const shared = await (await fetch(t.live.origin + '/api/drains?workspace=' + owner.tenant, {headers: {cookie: other.cookie}})).json(); assert.deepEqual(shared.drains.map(d => d.id), [drain.id]);
    // An admin's change is committed in a transaction that also requires the admin's live session and membership.
    const env0 = t.env(), store = env0.store, tx = store._tx.bind(store), seen = []; store._tx = async items => { seen.push(items); return tx(items); };
    const byAdmin = await t.post(other.cookie, 'drains?workspace=' + owner.tenant, {url: 'https://hooks.customer-site.com/admin'}); store._tx = tx; assert.equal(byAdmin.status, 201);
    const committed = seen.find(items => items.some(item => item.Put?.Item?.sk?.startsWith('DRAIN#')));
    assert.ok(committed.some(item => item.ConditionCheck?.Key?.sk === 'MEMBER#' + other.tenant), 'membership is a condition of the write'); assert.ok(committed.some(item => item.ConditionCheck?.Key?.pk?.startsWith('SESSION#')), 'so is the session');
    const adminDrain = (await byAdmin.json()).id;
    // If the membership ends between the role check and the write, nothing is deleted: not the drain, not its queue.
    t.hook.status = 500; await t.live.upload(key, t.batch(5)); t.hook.status = 200;
    const queuedBefore = (await t.list(owner.cookie)).find(d => d.id === adminDrain).queued; assert.equal(queuedBefore, 1);
    store._tx = async items => { if (items.some(item => item.Delete?.Key?.sk === 'DRAIN#' + adminDrain)) { const members = (await (await fetch(t.live.origin + '/api/workspaces/members', {headers: {cookie: owner.cookie}})).json()).members, m = members.find(x => (x.user_id ?? x.id) === other.tenant); store._tx = tx; assert.equal((await t.post(owner.cookie, 'workspaces/member', {user_id: other.tenant, role: 'removed', version: m.version})).status, 200); } return tx(items); };
    const refused = await t.post(other.cookie, 'drains/delete?workspace=' + owner.tenant, {id: adminDrain}); store._tx = tx; assert.ok([401, 403, 409].includes(refused.status), 'status ' + refused.status);
    const kept = (await t.list(owner.cookie)).find(d => d.id === adminDrain); assert.ok(kept, 'drain kept'); assert.equal(kept.queued, 1);
    assert.equal((await env0.store._page('TENANT#' + owner.tenant + '#DRAINQ#' + adminDrain, 'D#', {limit: 5})).items.length, 1, 'queue kept');
    assert.equal((await t.post(owner.cookie, 'drains/delete', {id: adminDrain})).status, 200);
    assert.equal((await env0.store._page('TENANT#' + owner.tenant + '#DRAINQ#' + adminDrain, 'D#', {limit: 5})).items.length, 0, 'queue removed with the drain');
    // Limit, bad input, delete.
    for (let i = 1; i < DRAIN_LIMITS.drains; i++) assert.equal((await t.post(owner.cookie, 'drains', {url: 'https://hooks.customer-site.com/' + i})).status, 201);
    const full = await t.post(owner.cookie, 'drains', {url: 'https://hooks.customer-site.com/more'}); assert.equal(full.status, 409); assert.equal((await full.json()).error, 'drain_limit');
    for (const id of ['nope', 'a'.repeat(16)]) assert.ok([400, 404].includes((await t.post(owner.cookie, 'drains/delete', {id})).status));
    assert.equal((await t.post(owner.cookie, 'drains/delete', {id: drain.id})).status, 200); assert.equal((await t.list(owner.cookie)).length, DRAIN_LIMITS.drains - 1);
    assert.equal((await t.post(owner.cookie, 'drains', {url: 'https://hooks.customer-site.com/again'})).status, 201);
    for (const d of await t.list(owner.cookie)) assert.equal((await t.post(owner.cookie, 'drains/delete', {id: d.id})).status, 200);
    const before = t.hook.received.length; await t.live.upload(key, t.batch(2)); assert.equal(t.hook.received.length, before, 'no drain, no delivery');
  } finally { await t.close(); }
});

test('a delivery is queued only for an accepted batch, a resent upload queues what an earlier attempt missed, and stale rows are dropped unsent', async () => {
  const t = await setup(); try {
    const owner = await t.account(), key = await t.live.writeKey(owner.tenant), env = t.env();
    // Accepted before any drain existed (the same state as an upload that was accepted but failed before queueing).
    await t.live.upload(key, t.batch(1)); assert.equal(t.hook.received.length, 0);
    const drain = await (await t.post(owner.cookie, 'drains', {url: 'https://hooks.customer-site.com/a'})).json(), drains = await listDrains(env.store, owner.tenant); assert.equal(drains[0].id, drain.id);
    // The client resends the upload: the delivery is queued now, once, and sent.
    await t.live.upload(key, t.batch(1)); assert.equal(t.hook.received.length, 1); assert.equal(JSON.parse(t.hook.received[0].body).batch_id, 'batch-1');
    await t.live.upload(key, t.batch(1)); assert.equal(t.hook.received.length, 1, 'already delivered: nothing is queued again');
    // A resend more than a day after acceptance does not queue an old batch.
    await t.live.upload(key, t.batch(2)); assert.equal(t.hook.received.length, 2);
    const second = await (await t.post(owner.cookie, 'drains', {url: 'https://hooks.customer-site.com/b'})).json(), real = env.store.now.bind(env.store);
    env.store.now = () => real() + DRAIN_LIMITS.requeueSeconds + 1; try { await t.live.upload(key, t.batch(2)); } finally { env.store.now = real; }
    assert.equal(t.hook.received.length, 2); assert.equal((await t.list(owner.cookie)).find(d => d.id === second.id).queued, 0);
    assert.equal((await t.post(owner.cookie, 'drains/delete', {id: second.id})).status, 200);
    // A queue row whose batch cannot be read back as accepted is dropped and never sent.
    const raw = JSON.stringify(t.batch(9)), record = {request_hash: digest(raw), object_key: 'v1/x/' + digest(raw) + '.json', byte_count: raw.length, event_count: 1};
    await enqueueDrainDeliveries(env.store, drains, {tenant: owner.tenant, environment: 'default', record, batch: t.batch(9)}); await enqueueDrainDeliveries(env.store, drains, {tenant: owner.tenant, environment: 'default', record, batch: t.batch(9)});
    assert.equal((await t.list(owner.cookie))[0].queued, 1, 'queued once');
    assert.deepEqual(await deliverDrains(env, owner.tenant), {attempted: 0, delivered: 0, failed: 1}); assert.equal(t.hook.received.length, 2);
    const [row] = await t.list(owner.cookie); assert.deepEqual({queued: row.queued, last_error: row.last_error}, {queued: 0, last_error: 'batch_unavailable'});
    // The same bytes in two environments are two batches: the second environment's copy is queued too.
    await enqueueDrainDeliveries(env.store, drains, {tenant: owner.tenant, environment: 'staging', record, batch: t.batch(9)}); await enqueueDrainDeliveries(env.store, drains, {tenant: owner.tenant, environment: 'staging', record, batch: t.batch(9)});
    assert.equal((await t.list(owner.cookie))[0].queued, 1); await deliverDrains(env, owner.tenant);
    // A full queue drops the batch for that drain once: resending the upload neither counts it again nor delivers it later.
    await env.store._send('UpdateCommand', {Key: {pk: 'TENANT#' + owner.tenant, sk: 'DRAIN#' + drain.id}, UpdateExpression: 'SET queued = :full', ExpressionAttributeValues: {':full': DRAIN_LIMITS.queued}});
    const sentBefore = t.hook.received.length; await t.live.upload(key, t.batch(6)); await t.live.upload(key, t.batch(6)); await t.live.upload(key, t.batch(6));
    let full = (await t.list(owner.cookie))[0]; assert.equal(full.dropped, 1); assert.equal(full.queued, DRAIN_LIMITS.queued);
    await env.store._send('UpdateCommand', {Key: {pk: 'TENANT#' + owner.tenant, sk: 'DRAIN#' + drain.id}, UpdateExpression: 'SET queued = :none', ExpressionAttributeValues: {':none': 0}});
    await t.live.upload(key, t.batch(6)); full = (await t.list(owner.cookie))[0]; assert.equal(full.dropped, 1); assert.equal(full.queued, 0); assert.equal(t.hook.received.length, sentBefore, 'a dropped batch is not delivered later');
    // A stored-object read that never answers cannot hold the pass: it returns at its limit and the row stays queued.
    await t.live.upload(key, t.batch(7)); const realGet = env.objects.get; let reads = 0;
    env.drainTransport = async () => ({ok: false, status: 500, error: 'http_500'}); await t.live.upload(key, t.batch(8)); const waiting = (await t.list(owner.cookie))[0].queued; assert.ok(waiting >= 1);
    env.objects.get = () => { reads++; return new Promise(() => {}); };
    try { const began = Date.now(), result = await deliverDrains(env, owner.tenant, {resume: true, budgetMs: 40, graceMs: 40}); assert.ok(Date.now() - began < 1500); assert.deepEqual(result, {attempted: 0, delivered: 0, failed: 0}); assert.equal(reads, 1); } finally { env.objects.get = realGet; }
    assert.equal((await t.list(owner.cookie))[0].queued, waiting, 'left queued');
    env.drainTransport = async () => ({ok: true, status: 200}); await deliverDrains(env, owner.tenant, {resume: true, max: 10}); assert.equal((await t.list(owner.cookie))[0].queued, 0);
    // A transport that throws is a failed delivery, never a failed upload.
    env.drainTransport = async () => { throw Error('boom'); }; await t.live.upload(key, t.batch(3));
    assert.equal((await t.list(owner.cookie))[0].last_error, 'failed');
    // A transport that never answers is cut off; the upload still succeeds.
    env.drainTransport = () => new Promise(() => {}); const realNow = env.store.now.bind(env.store); env.store.now = () => realNow() + 7200;
    try { const began = Date.now(); await t.live.upload(key, t.batch(4)); assert.ok(Date.now() - began < DRAIN_LIMITS.timeoutMs + 2500); } finally { env.store.now = realNow; }
    assert.equal((await t.list(owner.cookie))[0].last_error, 'timeout');
  } finally { await t.close(); }
});

test('drain URLs must be public https names; private, loopback and metadata addresses are refused at delivery', async () => {
  for (const ok of ['https://hooks.customer-site.com/path?x=1', 'https://a.b.example.org:443/', 'https://xn--bcher-kva.example.com/h']) assert.equal(validateDrainUrl(ok).protocol, 'https:');
  for (const bad of ['http://hooks.customer-site.com/', 'https://user:pass@hooks.customer-site.com/', 'https://hooks.customer-site.com:8443/', 'https://hooks.customer-site.com/#frag', 'https://127.0.0.1/', 'https://2130706433/', 'https://0x7f.0.0.1/', 'https://[::1]/', 'https://[fd00::1]/', 'https://169.254.169.254/latest/meta-data/',
    'https://localhost/', 'https://service.internal/', 'https://printer.local/', 'https://intranet/', 'https://supatrace.dev/api/batches', 'https://app.supatrace.tech/', 'ftp://hooks.customer-site.com/', 'https://hooks.customer-site.com/\n', 'https://', '', null, 'https://' + 'a'.repeat(2100) + '.com/', 'https://metadata.google.internal/', 'https://exa mple.com/'])
    assert.throws(() => validateDrainUrl(bad), {code: 'invalid_drain_url'}, String(bad));
  for (const address of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111']) assert.equal(publicAddress(address), true, address);
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1', '::1', '::', 'fe80::1', 'fd00::1', 'fc00::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::', '2001:db8::1', '2001::1', 'not-an-address', '']) assert.equal(publicAddress(address), false, address);
  // The transport never connects when any resolved address is not public, even next to a public one.
  let connects = 0; const never = () => { connects++; throw Error('must not connect'); }, request = {url: 'https://hooks.customer-site.com/h', body: '{}', headers: {}, timeoutMs: 500};
  for (const answers of [[{address: '10.0.0.5', family: 4}], [{address: '93.184.216.34', family: 4}, {address: '127.0.0.1', family: 4}], [{address: '169.254.169.254', family: 4}], [{address: '::1', family: 6}], [], Array.from({length: 17}, () => ({address: '93.184.216.34', family: 4}))])
    assert.deepEqual(await safeTransport(request, {resolve: async () => answers, connect: never}), {ok: false, error: 'blocked_address'});
  assert.deepEqual(await safeTransport(request, {resolve: async () => { throw Error('nx'); }, connect: never}), {ok: false, error: 'dns_failed'});
  assert.deepEqual(await safeTransport({...request, url: 'https://127.0.0.1/'}, {resolve: async () => [{address: '93.184.216.34', family: 4}], connect: never}), {ok: false, error: 'blocked_url'}); assert.equal(connects, 0);
  // It connects to the checked address, not to a second DNS answer, with TLS for the host name, and does not follow redirects.
  const fake = status => (options, onResponse) => { const req = new EventEmitter(); req.destroy = () => {}; req.end = body => { let pinned; options.lookup('ignored.example', {}, (error, address, family) => { pinned = {address, family}; }); let all; options.lookup('ignored.example', {all: true}, (error, list) => { all = list; });
    fake.seen = {host: options.host, servername: options.servername, port: options.port, path: options.path, method: options.method, agent: options.agent, pinned, all, body, length: options.headers['content-length']};
    const response = new EventEmitter(); response.statusCode = status; response.resume = () => {}; response.destroy = () => {}; response.headers = {location: 'https://127.0.0.1/'}; onResponse(response); req.emit('close'); }; return req; };
  const resolve = async () => [{address: '93.184.216.34', family: 4}, {address: '8.8.8.8', family: 4}];
  assert.deepEqual(await safeTransport({...request, url: 'https://hooks.customer-site.com/h?x=1', body: '{"a":1}'}, {resolve, connect: fake(204)}), {ok: true, status: 204});
  assert.deepEqual(fake.seen, {host: 'hooks.customer-site.com', servername: 'hooks.customer-site.com', port: 443, path: '/h?x=1', method: 'POST', agent: false, pinned: {address: '93.184.216.34', family: 4}, all: [{address: '93.184.216.34', family: 4}], body: '{"a":1}', length: 7});
  assert.deepEqual(await safeTransport(request, {resolve, connect: fake(302)}), {ok: false, status: 302, error: 'http_302'});
  // A DNS lookup that never answers is cut off by the same deadline.
  const began = Date.now(); assert.deepEqual(await safeTransport({...request, timeoutMs: 40}, {resolve: () => new Promise(() => {}), connect: never}), {ok: false, error: 'timeout'}); assert.ok(Date.now() - began < 1000);
  const hang = () => { const req = new EventEmitter(); req.destroy = () => req.emit('close'); req.end = () => {}; return req; };
  assert.deepEqual(await safeTransport({...request, timeoutMs: 30}, {resolve, connect: hang}), {ok: false, error: 'timeout'});
  const refuse = () => { const req = new EventEmitter(); req.destroy = () => {}; req.end = () => { req.emit('error', Error('ECONNREFUSED')); req.emit('close'); }; return req; };
  assert.deepEqual(await safeTransport(request, {resolve, connect: refuse}), {ok: false, error: 'connect_failed'});
});

test('the receiver example in the docs verifies a real delivery and rejects a tampered or stale one', async () => {
  const guide = readFileSync(new URL('../docs/trace-drains.md', import.meta.url), 'utf8'), [, code] = /```js\n([\s\S]*?)```/.exec(guide), source = code + '\nexport {verified};';
  const {verified} = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const secret = 'whsec_' + 'a'.repeat(43), body = '{"type":"batch.accepted"}', now = Math.floor(Date.now() / 1000), header = drainSignature(secret, now, body);
  assert.equal(verified(secret, header, body), true); assert.equal(verified(secret, header, body + ' '), false); assert.equal(verified('whsec_other', header, body), false);
  assert.equal(verified(secret, drainSignature(secret, now - 3600, body), body), false); assert.equal(verified(secret, undefined, body), false); assert.equal(verified(secret, 't=1,v1=zz', body), false);
  // The documented payload fields are the ones a delivery carries.
  const documented = [...guide.matchAll(/^  "([a-z_]+)":/gm)].map(match => match[1]);
  assert.deepEqual(documented, ['id', 'type', 'created_at', 'workspace_id', 'project_id', 'environment_id', 'batch_id', 'run_id', 'request_hash', 'event_count', 'byte_count', 'batch']);
});

test('additional projects deliver identical batches separately and respect project-specific environment removal',async()=>{
 const t=await setup();try{
  const owner=await t.account(),defaultKey=await t.live.writeKey(owner.tenant),drain=await(await t.post(owner.cookie,'drains',{url:'https://hooks.customer-site.com/supatrace'})).json();
  const projectResponse=await t.post(owner.cookie,'projects',{name:'Drain isolation'});assert.equal(projectResponse.status,201);const project=(await projectResponse.json()).id;
  const scopedKey='st_sec_'+createHash('sha256').update('project-drain-fixture').digest('base64url');const kr=await t.post(owner.cookie,'keys/create?project='+project,{key_hash:digest(scopedKey),key_type:'secret',expires_in:86400});assert.equal(kr.status,201);
  await t.live.upload(defaultKey,t.batch(7));await t.live.upload(scopedKey,t.batch(7));assert.equal(t.hook.received.length,2,'same payload from two projects delivers twice');
  const bodies=t.hook.received.map(v=>JSON.parse(v.body));assert.equal(bodies[1].project_id,project);assert.notEqual(bodies[0].project_id,project);assert.notEqual(bodies[0].id,bodies[1].id);for(const delivery of t.hook.received)assert.ok(verify(drain.secret,delivery));
  const er=await t.post(owner.cookie,'environments?project='+project,{name:'Staging',id:'staging'});assert.equal(er.status,201);
  const envKey='st_sec_'+createHash('sha256').update('project-environment-drain-fixture').digest('base64url');assert.equal((await t.post(owner.cookie,'keys/create?project='+project+'&environment=staging',{key_hash:digest(envKey),key_type:'secret',expires_in:86400})).status,201);
  const uploadEnvironment=async n=>{const raw=JSON.stringify(t.batch(n)),r=await fetch(t.live.origin+'/api/batches?environment=staging',{method:'POST',headers:{'content-type':'application/json','x-supatrace-key':envKey,'x-amz-content-sha256':digest(raw)},body:raw});assert.equal(r.status,201);};
  await uploadEnvironment(8);assert.equal(t.hook.received.length,3);assert.equal(JSON.parse(t.hook.received[2].body).environment_id,'staging');assert.equal(JSON.parse(t.hook.received[2].body).project_id,project);
  // Queue an accepted batch while the destination is paused, then remove the project environment.
  const store=t.env().store,row=await store._get({pk:'TENANT#'+owner.tenant,sk:'DRAIN#'+drain.id});row.paused_until=store.now()+300;await store._send('PutCommand',{Item:row});await uploadEnvironment(9);
  assert.equal((await t.list(owner.cookie))[0].queued,1);await store._send('DeleteCommand',{Key:{pk:'TENANT#'+owner.tenant,sk:'PROJECT#'+project+'#ENVIRONMENT#staging'}});
  const r=await deliverDrains(t.env(),owner.tenant,{resume:true});assert.equal(r.failed,1);assert.equal(t.hook.received.length,3);assert.equal((await t.list(owner.cookie))[0].last_error,'environment_deleted');
  const paused=await store._get({pk:'TENANT#'+owner.tenant,sk:'DRAIN#'+drain.id});paused.paused_until=store.now()+300;await store._send('PutCommand',{Item:paused});await t.live.upload(scopedKey,t.batch(10));
  await store._send('DeleteCommand',{Key:{pk:'TENANT#'+owner.tenant,sk:'PROJECT_META#'+project}});const removed=await deliverDrains(t.env(),owner.tenant,{resume:true});assert.equal(removed.failed,1);assert.equal(t.hook.received.length,3);assert.equal((await t.list(owner.cookie))[0].last_error,'project_deleted');
 }finally{await t.close();}
});

test('queued payload whose retention elapsed is never delivered',async()=>{
 const t=await setup();try{
  const owner=await t.account(),key=await t.live.writeKey(owner.tenant),drain=await(await t.post(owner.cookie,'drains',{url:'https://hooks.customer-site.com/supatrace'})).json(),store=t.env().store;
  const row=await store._get({pk:'TENANT#'+owner.tenant,sk:'DRAIN#'+drain.id});row.paused_until=store.now()+300;await store._send('PutCommand',{Item:row});await t.live.upload(key,t.batch(11));
  const accepted=await store._get({pk:'TENANT#'+owner.tenant,sk:'BATCH#batch-11'});accepted.retention_expires_at=store.now();await store._send('PutCommand',{Item:accepted});
  assert.equal((await deliverDrains(t.env(),owner.tenant,{resume:true})).failed,1);assert.equal(t.hook.received.length,0);assert.equal((await t.list(owner.cookie))[0].last_error,'expired');
 }finally{await t.close();}
});
