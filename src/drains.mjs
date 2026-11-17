// Trace drains: per-workspace HTTPS webhooks that receive every accepted batch.
// Delivery is retried but bounded, not guaranteed. A delivery is queued after its batch is accepted
// and before the upload is answered (a resent upload of a recently accepted batch queues it if an
// earlier attempt did not), and it may be sent more than once. It is given up, and counted, after
// 8 failed attempts or 3 days, or when the drain's queue is full. Queued deliveries are attempted
// after ingest requests and on demand; there is no background scheduler in this release. Each request is signed, the destination is resolved and pinned to a
// public address, and redirects are never followed.
import {requireFeature, hasFeature} from './entitlements.mjs';
import {createHash, createHmac, randomBytes} from 'node:crypto';
import {BlockList, isIP} from 'node:net';
import {lookup} from 'node:dns/promises';
import {request as httpsRequest} from 'node:https';
import {HttpError, json, boundedText} from './http.mjs';
import {alphaProject, projectPrefix, requireProject} from './alpha-projects.mjs';
import {environmentStore} from './workspaces.mjs';

export const DRAIN_LIMITS = Object.freeze({drains: 3, queued: 500, attempts: 8, maxAgeSeconds: 259200, requeueSeconds: 86400, timeoutMs: 3000, perPass: 3, passMs: 4000, pauses: Object.freeze([30, 60, 300, 900, 3600])});
const digest = text => createHash('sha256').update(text).digest('hex');
const tpk = tenant => 'TENANT#' + tenant;
const drainKey = (tenant, id) => ({pk: tpk(tenant), sk: 'DRAIN#' + id});
const queuePk = (tenant, id) => tpk(tenant) + '#DRAINQ#' + id;
const markerKey = (tenant, id, project, environment, requestHash) => ({pk: queuePk(tenant, id), sk: 'SEEN#' + projectPrefix(tenant, project) + environment + '#' + requestHash});
const conditional = error => error?.name === 'ConditionalCheckFailedException' || (error?.name === 'TransactionCanceledException' && error.CancellationReasons?.some(reason => reason.Code === 'ConditionalCheckFailed'));
const fail = (status, code) => { throw new HttpError(status, code); };

// Addresses a webhook may never reach: loopback, private, link-local (cloud metadata), carrier NAT,
// documentation, multicast and reserved ranges, and IPv6 forms that embed an IPv4 address.
const blocked = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]]) blocked.addSubnet(net, bits, 'ipv4');
const globalUnicast = new BlockList(); globalUnicast.addSubnet('2000::', 3, 'ipv6');
for (const [net, bits] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) blocked.addSubnet(net, bits, 'ipv6');
/** True only for an address on the public internet. */
export function publicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family === 6) return globalUnicast.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
  return false;
}
/** Accepts only https://<dns name>[:443]/path with no credentials or fragment. Returns the parsed URL. */
export function validateDrainUrl(text) {
  if (typeof text !== 'string' || text.length < 12 || text.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(text)) fail(400, 'invalid_drain_url');
  let url; try { url = new URL(text); } catch { fail(400, 'invalid_drain_url'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) fail(400, 'invalid_drain_url');
  // No IP literals (any notation the URL parser normalises to one), single-label names or internal suffixes.
  if (isIP(host) || host.startsWith('[') || !/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(host)) fail(400, 'invalid_drain_url');
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp|test|example|invalid|onion|arpa)$/.test(host) || /(^|\.)supatrace\.(dev|tech)$/.test(host)) fail(400, 'invalid_drain_url');
  return url;
}
export const drainSignature = (secret, timestamp, body) => 't=' + timestamp + ',v1=' + createHmac('sha256', secret).update(timestamp + '.' + body).digest('hex');
/**
 * Default transport. Resolves the host, refuses unless every address is public, then connects to
 * the checked address itself (so a second DNS answer cannot redirect the connection) with TLS
 * verified for the host name. Never follows redirects; the response body is discarded.
 */
export async function safeTransport({url, body, headers, timeoutMs}, {resolve = host => lookup(host, {all: true, verbatim: true}), connect = httpsRequest} = {}) {
  let target;
  try { target = validateDrainUrl(String(url)); } catch { return {ok: false, error: 'blocked_url'}; }
  // One deadline covers the DNS lookup and the request together.
  const started = Date.now(); let addresses, dnsTimer;
  try { addresses = await Promise.race([resolve(target.hostname), new Promise((_, reject) => { dnsTimer = setTimeout(() => reject(Object.assign(Error('timeout'), {deadline: true})), timeoutMs); })]); }
  catch (error) { return {ok: false, error: error?.deadline ? 'timeout' : 'dns_failed'}; }
  finally { clearTimeout(dnsTimer); }
  const remaining = Math.max(1, timeoutMs - (Date.now() - started));
  if (!Array.isArray(addresses) || !addresses.length || addresses.length > 16 || !addresses.every(item => publicAddress(item?.address))) return {ok: false, error: 'blocked_address'};
  const pinned = addresses[0];
  return await new Promise(done => {
    let settled = false; const finish = value => { if (!settled) { settled = true; done(value); } };
    const request = connect({host: target.hostname, servername: target.hostname, port: 443, path: target.pathname + target.search, method: 'POST', agent: false, timeout: remaining,
      headers: {...headers, 'content-length': Buffer.byteLength(body)},
      lookup: (hostname, options, callback) => options?.all ? callback(null, [{address: pinned.address, family: isIP(pinned.address)}]) : callback(null, pinned.address, isIP(pinned.address))},
    response => { const status = response.statusCode; response.resume(); response.destroy(); finish(status >= 200 && status < 300 ? {ok: true, status} : {ok: false, status, error: 'http_' + status}); });
    const timer = setTimeout(() => { request.destroy(); finish({ok: false, error: 'timeout'}); }, remaining);
    request.on('timeout', () => { request.destroy(); finish({ok: false, error: 'timeout'}); });
    request.on('error', () => finish({ok: false, error: 'connect_failed'}));
    request.on('close', () => clearTimeout(timer));
    request.end(body);
  });
}
const view = (row, now) => ({id: row.id, url: row.url, created_at: new Date(row.created_at * 1000).toISOString(), delivered: row.delivered ?? 0, failed: row.failed ?? 0, dropped: row.dropped ?? 0, queued: Math.max(0, row.queued ?? 0),
  last_status: row.last_status ?? null, last_error: row.last_error ?? null, last_attempt_at: row.last_attempt_at ? new Date(row.last_attempt_at * 1000).toISOString() : null,
  paused_until: row.paused_until > now ? new Date(row.paused_until * 1000).toISOString() : null});
/** The workspace's drains, or [] for a store without the query primitive (unit-test doubles). */
export async function listDrains(store, tenant) {
  if (typeof store?._page !== 'function') return [];
  return (await store._page(tpk(tenant), 'DRAIN#', {limit: DRAIN_LIMITS.drains + 1})).items;
}
async function send(env, drain, type, id, payload) {
  const body = JSON.stringify({id, type, created_at: new Date(env.store.now() * 1000).toISOString(), ...payload}), timestamp = env.store.now();
  const headers = {'content-type': 'application/json', 'user-agent': 'SupaTrace-Drain/1', 'x-supatrace-event': type, 'x-supatrace-delivery': id, 'x-supatrace-signature': drainSignature(drain.secret, timestamp, body)};
  let timer;
  try {
    // A hard deadline around the transport, so nothing it awaits can hold an upload response longer.
    const result = await Promise.race([(env.drainTransport ?? safeTransport)({url: drain.url, body, headers, timeoutMs: DRAIN_LIMITS.timeoutMs}), new Promise(done => { timer = setTimeout(() => done({ok: false, error: 'timeout'}), DRAIN_LIMITS.timeoutMs + 250); })]); return result?.ok === true ? {ok: true, status: result.status ?? 200} : {ok: false, status: result?.status ?? null, error: typeof result?.error === 'string' ? result.error.slice(0, 40) : 'failed'}; }
  catch { return {ok: false, status: null, error: 'failed'}; }
  finally { clearTimeout(timer); }
}
/**
 * Queues one delivery per drain for an accepted batch. Idempotent per batch, project and environment, so
 * calling it again for a resent upload queues nothing twice. A full queue counts the batch as dropped, once.
 */
export async function enqueueDrainDeliveries(store, drains, {tenant, project = alphaProject(tenant).id, environment, record, batch}) {
  for (const drain of drains) {
    // Oldest first, to the millisecond. The same bytes uploaded to two project environments are two batches and two deliveries.
    const Key = {pk: queuePk(tenant, drain.id), sk: 'D#' + String(store.now()).padStart(12, '0') + String(Date.now() % 1000).padStart(3, '0') + '#' + projectPrefix(tenant, project) + environment + '#' + record.request_hash};
    const item = {...Key, drain_id: drain.id, tenant_id: tenant, project_id: project, environment_id: environment, batch_id: batch.batch_id, run_id: batch.run_id, request_hash: record.request_hash, object_key: record.object_key, byte_count: record.byte_count, event_count: record.event_count, created_at: store.now(), attempts: 0};
    const marker = markerKey(tenant, drain.id, project, environment, record.request_hash);
    try { await store._tx([
      {Put: {Item: {...marker, created_at: store.now(), ttl: store.now() + DRAIN_LIMITS.maxAgeSeconds * 2}, ConditionExpression: 'attribute_not_exists(pk)'}},
      {Put: {Item: item, ConditionExpression: 'attribute_not_exists(pk)'}},
      {Update: {Key: drainKey(tenant, drain.id), UpdateExpression: 'ADD queued :one', ConditionExpression: 'attribute_exists(pk) AND (attribute_not_exists(queued) OR queued < :cap)', ExpressionAttributeValues: {':one': 1, ':cap': DRAIN_LIMITS.queued}}}
    ]); }
    catch (error) {
      if (!conditional(error)) throw error;
      if (await store._get(marker)) continue; // Already queued by an earlier attempt of this upload.
      // The queue is full (or the drain is gone). Record the drop with the marker, so a resent upload neither counts it again nor delivers it later.
      try { await store._tx([
        {Put: {Item: {...marker, dropped: true, created_at: store.now(), ttl: store.now() + DRAIN_LIMITS.maxAgeSeconds * 2}, ConditionExpression: 'attribute_not_exists(pk)'}},
        {Update: {Key: drainKey(tenant, drain.id), UpdateExpression: 'ADD dropped :one', ConditionExpression: 'attribute_exists(pk)', ExpressionAttributeValues: {':one': 1}}}
      ]); } catch (inner) { if (!conditional(inner)) throw inner; }
    }
  }
}
async function settle(store, tenant, drain, row, outcome, result) {
  const now = store.now(), remove = outcome !== 'retry';
  const failures = outcome === 'delivered' ? 0 : (drain.consecutive_failures ?? 0) + (outcome === 'expired' ? 0 : 1);
  const pause = outcome === 'retry' || outcome === 'failed' ? now + DRAIN_LIMITS.pauses[Math.min(failures, DRAIN_LIMITS.pauses.length) - 1] : 0;
  const counter = outcome === 'delivered' ? 'delivered' : outcome === 'retry' ? null : 'failed';
  const drainUpdate = {Update: {Key: drainKey(tenant, drain.id),
    UpdateExpression: 'SET last_attempt_at = :now, consecutive_failures = :failures, paused_until = :pause, last_status = :status, last_error = :error' + (remove ? ' ADD queued :minus' + (counter ? ', ' + counter + ' :one' : '') : ''),
    ConditionExpression: 'attribute_exists(pk)',
    ExpressionAttributeValues: {':now': now, ':failures': failures, ':pause': pause, ':status': result.status ?? 0, ':error': result.error ?? '', ...(remove ? {':minus': -1, ...(counter ? {':one': 1} : {})} : {})}}};
  const rowKey = {pk: row.pk, sk: row.sk};
  try { await store._tx([remove ? {Delete: {Key: rowKey, ConditionExpression: 'attribute_exists(pk)'}} : {Update: {Key: rowKey, UpdateExpression: 'SET attempts = :next', ConditionExpression: 'attempts = :old', ExpressionAttributeValues: {':next': row.attempts + 1, ':old': row.attempts}}}, drainUpdate]); }
  catch (error) { if (!conditional(error)) throw error; } // Another invocation settled this row first.
  Object.assign(drain, {consecutive_failures: failures, paused_until: pause});
}
/**
 * Attempts queued deliveries, oldest first, within a small time budget. A failure pauses the drain
 * with growing delays, so a dead endpoint does not slow every later upload. Never throws.
 */
export async function deliverDrains(env, tenant, {max = DRAIN_LIMITS.perPass, budgetMs = DRAIN_LIMITS.passMs, graceMs = DRAIN_LIMITS.timeoutMs + 500, resume = false, drains = null} = {}) {
  const totals = {attempted: 0, delivered: 0, failed: 0}, state = {stopped: false}; let timer;
  // The whole pass, including its database and object reads, is raced against one limit: the budget for starting
  // work plus the time one delivery in flight may take. Whatever has not finished by then stays queued for a later pass.
  try { await Promise.race([deliveryPass(env, tenant, {max, budgetMs, resume, drains}, totals, state), new Promise(done => { timer = setTimeout(done, budgetMs + graceMs); })]); }
  finally { clearTimeout(timer); state.stopped = true; }
  return {...totals};
}
async function deliveryPass(env, tenant, {max, budgetMs, resume, drains}, totals, state) {
  try {
    const store = env.store, deadline = Date.now() + budgetMs;
    // Delivery is the trace_drains feature: on a plan without it nothing is sent, and what is queued waits (it expires after 3 days).
    if (typeof store.planId === 'function' && !hasFeature(await store.planId(tenant), 'trace_drains')) return;
    for (const drain of drains ?? await listDrains(store, tenant)) {
      if (!resume && drain.paused_until > store.now()) continue;
      const page = await store._page(queuePk(tenant, drain.id), 'D#', {limit: Math.min(25, max)});
      for (const row of page.items) {
        if (state.stopped || totals.attempted >= max || Date.now() > deadline) return;
        const age = store.now() - row.created_at;
        // A delivery queued for an environment that has since been deleted is dropped, never sent: deleting an environment ends access to its traces.
        let project;
        try { project = await requireProject(store, tenant, row.project_id); } catch (error) { if (error?.code !== 'project_unavailable') throw error; await settle(store, tenant, drain, row, 'expired', {error: 'project_deleted'}); totals.failed++; continue; }
        const environment = row.environment_id ?? 'default';
        if (environment !== 'default' && !await store._get({pk: tpk(tenant), sk: projectPrefix(tenant, project.id) + 'ENVIRONMENT#' + environment})) { await settle(store, tenant, drain, row, 'expired', {error: 'environment_deleted'}); totals.failed++; continue; }
        const scoped = environmentStore(store, {owner: tenant, project: project.id, environment}), accepted = await scoped._get({pk: tpk(tenant), sk: 'BATCH#' + row.batch_id});
        // Rows are queued only for accepted batches; one whose batch cannot be read back as accepted is dropped, never sent.
        if (!accepted || accepted.status !== 'accepted' || accepted.request_hash !== row.request_hash) { await settle(store, tenant, drain, row, 'expired', {error: 'batch_unavailable'}); totals.failed++; continue; }
        if (age > DRAIN_LIMITS.maxAgeSeconds || (Number.isSafeInteger(accepted.retention_expires_at) && accepted.retention_expires_at <= store.now())) { await settle(store, tenant, drain, row, 'expired', {error: 'expired'}); totals.failed++; continue; }
        const raw = await env.objects.get(row.object_key);
        if (state.stopped) return; // The caller has already answered; leave the row queued.
        if (digest(raw) !== row.request_hash) { await settle(store, tenant, drain, row, 'expired', {error: 'stored_content_mismatch'}); totals.failed++; continue; }
        totals.attempted++;
        const result = await send(env, drain, 'batch.accepted', digest(drain.id + ':' + projectPrefix(tenant, project.id) + (row.environment_id ?? 'default') + ':' + row.request_hash).slice(0, 32), {workspace_id: tenant, project_id: project.id, environment_id: row.environment_id ?? 'default', batch_id: row.batch_id, run_id: row.run_id, request_hash: row.request_hash, event_count: row.event_count, byte_count: row.byte_count, batch: JSON.parse(raw)});
        if (result.ok) { await settle(store, tenant, drain, row, 'delivered', result); totals.delivered++; continue; }
        await settle(store, tenant, drain, row, row.attempts + 1 >= DRAIN_LIMITS.attempts ? 'failed' : 'retry', result); totals.failed++;
        break; // The drain is now paused; later rows wait behind this one.
      }
    }
  } catch (error) { env.authDiagnostic?.({event: 'drain_delivery_error', code: typeof error?.code === 'string' ? error.code : 'unexpected'}); }
}
/** Session routes for owners and admins: GET /api/drains, POST /api/drains, /api/drains/delete, /api/drains/test, /api/drains/flush. */
// `store` is the request's guarded workspace store: for a shared workspace its transactions also require the caller's live
// session and membership, so a member removed after the role check cannot commit a change.
export async function drainApi(request, env, tenant, actor, store = env.store) {
  const path = new URL(request.url).pathname, now = store.now();
  if (request.method === 'GET' && path === '/api/drains') return json({drains: (await listDrains(store, tenant)).map(row => view(row, now)), limit: DRAIN_LIMITS.drains});
  if (request.method !== 'POST') fail(404, 'not_found');
  // Creating, testing and flushing a drain is the trace_drains feature. Listing and deleting stay open, so an
  // organization that moved to a lower plan can still see and remove what it has.
  if (path !== '/api/drains/delete') requireFeature(typeof store.planId === 'function' ? await store.planId(tenant) : null, 'trace_drains');
  const data = JSON.parse(await boundedText(request, 4096));
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail(400, 'invalid_drain_request');
  if (path === '/api/drains') {
    const url = validateDrainUrl(data.url).href, id = randomBytes(8).toString('hex'), secret = 'whsec_' + randomBytes(32).toString('base64url');
    const row = {...drainKey(tenant, id), id, url, secret, created_at: now, created_by: actor, delivered: 0, failed: 0, dropped: 0, queued: 0};
    try { await store._tx([
      {Update: {Key: {pk: tpk(tenant), sk: 'META'}, UpdateExpression: 'ADD drain_count :one', ConditionExpression: 'attribute_exists(pk) AND (attribute_not_exists(drain_count) OR drain_count < :cap)', ExpressionAttributeValues: {':one': 1, ':cap': DRAIN_LIMITS.drains}}},
      {Put: {Item: row, ConditionExpression: 'attribute_not_exists(pk)'}}
    ]); } catch (error) { if (!conditional(error)) throw error; const meta = await store._get({pk: tpk(tenant), sk: 'META'}); fail(409, (meta?.drain_count ?? 0) >= DRAIN_LIMITS.drains ? 'drain_limit' : 'workspace_changed'); }
    // The only response that carries the signing secret.
    return json({...view(row, now), secret}, 201);
  }
  if (path === '/api/drains/flush') return json(await deliverDrains(env, tenant, {max: 10, budgetMs: 8000, resume: true}));
  if (typeof data.id !== 'string' || !/^[a-f0-9]{16}$/.test(data.id)) fail(400, 'invalid_drain_id');
  const drain = await store._get(drainKey(tenant, data.id));
  if (!drain) fail(404, 'drain_not_found');
  if (path === '/api/drains/test') {
    const result = await send(env, drain, 'drain.test', randomBytes(16).toString('hex'), {workspace_id: tenant});
    return json({delivered: result.ok, status: result.status, error: result.ok ? null : result.error});
  }
  if (path === '/api/drains/delete') {
    // The guarded transaction is the authorisation: nothing is discarded unless it commits.
    try { await store._tx([
      {Delete: {Key: drainKey(tenant, drain.id), ConditionExpression: 'attribute_exists(pk)'}},
      {Update: {Key: {pk: tpk(tenant), sk: 'META'}, UpdateExpression: 'ADD drain_count :minus', ConditionExpression: 'drain_count >= :one', ExpressionAttributeValues: {':minus': -1, ':one': 1}}}
    ]); } catch (error) { if (!conditional(error)) throw error; if (await env.store._get(drainKey(tenant, drain.id))) fail(409, 'workspace_changed'); return json({deleted: true}); }
    // The drain is gone; what it still had queued can no longer be delivered and is removed.
    for (const prefix of ['D#', 'SEEN#']) for (let pages = 0; pages < 12; pages++) {
      const page = await env.store._page(queuePk(tenant, drain.id), prefix, {limit: 100});
      for (const row of page.items) await env.store._send('DeleteCommand', {Key: {pk: row.pk, sk: row.sk}});
      if (!page.items.length) break;
    }
    return json({deleted: true});
  }
  fail(404, 'not_found');
}
