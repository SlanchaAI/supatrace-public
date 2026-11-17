// Ingest log: one row per upload request that reached a workspace, on every ingest route (batches, OTLP, Langfuse).
// pk INGESTLOG#<workspace>#<environment>; sk ISSUE#<inverted time>#<id> for a refused or partly stored request and
// OK#<inverted time>#<id> for a fully stored one, so each stream pages newest first and a busy workspace's accepted
// uploads never bury its refusals. Rows hold codes, counts and the first 12 characters of the key id: never a key,
// a payload or a network address. DynamoDB TTL removes a row after INGEST_LOG.retention_days.
//
// What is not here: a request whose key is missing, unknown, expired or revoked cannot be tied to a workspace, so
// it is answered 401 and no row is written. Recording is best effort: it never changes the upload's answer, and can
// hold that answer for at most INGEST_LOG.write_ms.
import {randomBytes} from 'node:crypto';
import {HttpError, json} from './http.mjs';
import {IntakeError} from './trace.mjs';
import {projectPrefix} from './alpha-projects.mjs';
const logPartition=(owner,environment,project)=>`INGESTLOG#${owner}#${projectPrefix(owner,project)}${environment}`;

export const INGEST_LOG = Object.freeze({retention_days: 7, issues_per_minute: 30, write_ms: 400, routes: Object.freeze(['batches', 'otlp', 'langfuse'])});
const STREAMS = {issues: 'ISSUE#', accepted: 'OK#'};
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
// Plain-language reasons for the codes an ingest route answers with. A code without an entry is shown as the code.
export const INGEST_REASONS = Object.freeze({
  rate_limit: 'More than 30 upload requests reached this workspace within a minute. The sender should wait for the Retry-After interval and send again.',
  environment_unavailable: 'The key belongs to a different environment than the one the request named.',
  project_unavailable: 'The request named a project this key does not belong to.',
  invalid_write_key: 'The member who created this key no longer has the role it was issued under, so the key stopped working.',
  payload_hash_required: 'The x-amz-content-sha256 header was missing or did not match the request body.',
  json_required: 'The body was not sent as application/json.',
  compressed_upload_not_supported: 'This route does not accept a compressed body.',
  unsupported_content_encoding: 'Only gzip or no compression is accepted.',
  empty_body: 'The request had no body.',
  batch_too_large: 'The batch was larger than 512 KiB.',
  payload_too_large: 'The request was larger than 512 KiB on the wire or 4 MiB uncompressed.',
  invalid_gzip: 'The gzip body could not be decompressed.',
  invalid_json: 'The body was not valid JSON.',
  invalid_version: 'The batch did not declare version 1.',
  invalid_id: 'A batch, trace or event id was missing or used characters outside letters, digits and _ . : -',
  invalid_event: 'An event was not an object with the required fields.',
  invalid_kind: 'An event had a kind the store does not accept.',
  invalid_name: 'An event name was missing or too long.',
  invalid_time: 'An event time was not an ISO 8601 timestamp.',
  invalid_data: 'An event carried more data than the 32 KiB stored-event limit.',
  invalid_count: 'The batch held no events or more than 100.',
  duplicate_event: 'The same event id appeared twice in one batch.',
  unknown_field: 'The batch or an event carried a field the batch format does not define.',
  unsupported_number: 'A number was not finite or was an integer beyond 2^53.',
  too_deep: 'A value was nested deeper than 32 levels.',
  too_large: 'The batch was larger than the batch size limit.',
  idempotency_conflict: 'A different batch is already stored under this batch id.',
  monthly_span_allowance_exceeded: 'The plan’s monthly span allowance was used up, so the upload was refused.',
  stored_bytes_allowance_exceeded: 'The plan’s stored-bytes allowance was used up, so the upload was refused.',
  spend_cap_reached: 'The spend cap stopped uploads at the plan’s included spans.',
  project_paused: 'The project was paused after a period without uploads. Resume it from Usage.',
  storage_capacity: 'The workspace storage limit was reached.',
  storage_capacity_or_unknown_tenant: 'The workspace storage limit was reached.',
  quota_exceeded: 'The workspace storage limit was reached.',
  commercial_upload_blocked: 'Uploads are blocked for this workspace by its billing state.',
  invalid_otlp: 'The body was not a valid OTLP trace export request.',
  too_many_spans: 'The export request carried more than 2000 spans.',
  no_valid_spans: 'No span in the request could be stored.',
  invalid_langfuse_batch: 'The body was not of the form {"batch": [event, ...]} with at least one event.',
  too_many_events: 'The request carried more than 1000 events.',
  no_event_stored: 'Every event in the request was refused.',
  partly_stored: 'Some events were stored and some were refused.',
  request_failed: 'The request failed without a more specific code.',
  temporarily_unavailable: 'The service could not store the upload at that moment. The same request can be sent again.',
});
const inverted = (value, width) => String(10 ** width - 1 - value).padStart(width, '0');
let sequence = 0;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

/**
 * Per-request tally. `bind` is called once the key has resolved to a workspace; `stored` once per batch kept or already held.
 * `runs` therefore holds only the traces the request stored events for, never a trace it was refused.
 */
export function ingestAttempt(route) {
  if (!INGEST_LOG.routes.includes(route)) throw new HttpError(500, 'invalid_ingest_route');
  const runs = new Set();
  return {route, workspace: null, project: null, environment: null, key: null, batches: 0, repeated: 0, events: 0, bytes: 0, runs,
    bind(binding) { this.workspace = binding.tenant_id; this.project = binding.project_id; this.environment = binding.environment_id ?? 'default'; this.key = typeof binding.token_hash === 'string' ? binding.token_hash.slice(0, 12) : null; },
    stored(batch, raw, fresh) { this.batches++; if (!fresh) this.repeated++; this.events += batch.events.length; this.bytes += Buffer.byteLength(raw); runs.add(batch.run_id); }};
}
/** The status and code the caller is about to answer with for a thrown error (the same mapping as the API's catch). */
export function ingestFailure(error) {
  if (error instanceof SyntaxError) return {status: 400, code: 'invalid_json'};
  if (error instanceof IntakeError) return {status: 400, code: error.code};
  if (Number.isInteger(error?.status)) return {status: error.status, code: typeof error.code === 'string' ? error.code : 'request_failed'};
  return {status: 503, code: 'temporarily_unavailable'};
}
/** `count × message` for the most frequent messages, bounded. */
export function ingestDetail(messages) {
  const tally = new Map();
  for (const message of messages) if (typeof message === 'string' && message) tally.set(message, (tally.get(message) ?? 0) + 1);
  return [...tally].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([message, n]) => n + ' × ' + message).join('; ');
}
const clean = text => typeof text === 'string' && text ? text.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 400) : null;
/**
 * Writes the row for one finished request. `result` is {status, code?, rejected?, detail?}. Returns true when a row was
 * written. Never throws and waits at most INGEST_LOG.write_ms: a slow log write holds the upload's answer for that long at
 * most, and a failed one does not fail the upload.
 */
export async function recordIngest(store, attempt, result) {
  if (!attempt?.workspace || typeof store?._send !== 'function' || typeof store.now !== 'function' || !Number.isInteger(result?.status)) return false;
  // `rejected` means this request stored nothing. A request that failed after storing part of itself (a later batch hit
  // an error) is `partial` and keeps the error code as its reason.
  const rejected = count(result.rejected) ?? 0, error = result.status >= 400, kept = attempt.events > 0;
  const outcome = !kept && (error || rejected > 0) ? 'rejected' : error || rejected > 0 ? 'partial' : 'accepted';
  const code = CODE.test(result.code ?? '') ? result.code : null;
  const reason = outcome === 'accepted' ? null : error ? code ?? 'request_failed' : outcome === 'partial' ? 'partly_stored' : code ?? 'no_event_stored';
  const write = async () => {
    // A sender stuck in a retry loop cannot fill the table: refusals are recorded up to a per-workspace rate.
    if (outcome !== 'accepted' && !(await store.consumeRate({scope: 'ingestlog', identity: attempt.workspace, limit: INGEST_LOG.issues_per_minute, windowSeconds: 60})).allowed) return false;
    const now = store.now(), id = randomBytes(8).toString('hex'), expires = now + INGEST_LOG.retention_days * 86400;
    await store._send('PutCommand', {Item: {pk: logPartition(attempt.workspace,attempt.environment,attempt.project),
      sk: `${outcome === 'accepted' ? STREAMS.accepted : STREAMS.issues}${inverted(now, 12)}#${inverted(Date.now() % 1000, 3)}${inverted(sequence++ % 10000, 4)}#${id}`,
      attempt_id: id, workspace_id: attempt.workspace, environment_id: attempt.environment, at: now, route: attempt.route, outcome, http_status: result.status, reason,
      detail: clean(result.detail), key_prefix: attempt.key, batches: attempt.batches, repeated_batches: attempt.repeated, stored_events: attempt.events, rejected_events: count(result.rejected),
      stored_bytes: attempt.bytes, stored_trace_id: attempt.runs.size === 1 ? [...attempt.runs][0] : null, stored_trace_count: attempt.runs.size, expires_at: expires, ttl: expires}});
    return true;
  };
  // The write keeps its own failure handler: when the timer wins, a later rejection must not surface as unhandled.
  const pending = write().catch(error => { console.error(JSON.stringify({event: 'ingest_log_write_failed', error: error?.name || 'Error'})); return false; });
  let timer;
  try { return await Promise.race([pending, new Promise(resolve => { timer = setTimeout(() => resolve(false), INGEST_LOG.write_ms); })]); }
  finally { clearTimeout(timer); }
}
const view = row => ({id: row.attempt_id, time: new Date(row.at * 1000).toISOString(), route: row.route, outcome: row.outcome, http_status: row.http_status,
  reason: row.reason ?? null, message: row.reason ? INGEST_REASONS[row.reason] ?? null : null, detail: row.detail ?? null, key_prefix: row.key_prefix ?? null,
  batches: count(row.batches), repeated_batches: count(row.repeated_batches), stored_events: count(row.stored_events), rejected_events: count(row.rejected_events), stored_bytes: count(row.stored_bytes),
  // Traces this request stored events for (or found already stored). A trace whose events were all refused is not named.
  stored_trace_id: typeof row.stored_trace_id === 'string' ? row.stored_trace_id : null, stored_trace_count: count(row.stored_trace_count)});
function filters(url) {
  const allowed = new Set(['workspace', 'environment', 'project', 'stream', 'route', 'reason', 'from', 'to', 'limit', 'after']);
  for (const name of url.searchParams.keys()) if (!allowed.has(name) || url.searchParams.getAll(name).length > 1) throw new HttpError(400, 'invalid_query');
  const stream = url.searchParams.get('stream') || 'issues', route = url.searchParams.get('route') || '', reason = url.searchParams.get('reason') || '';
  if (!Object.hasOwn(STREAMS, stream) || (route && !INGEST_LOG.routes.includes(route)) || (reason && !CODE.test(reason))) throw new HttpError(400, 'invalid_query');
  const bound = name => { const value = url.searchParams.get(name) || ''; if (!value) return null; const ms = Date.parse(value); if (!Number.isFinite(ms)) throw new HttpError(400, 'invalid_query'); return Math.floor(ms / 1000); };
  const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new HttpError(400, 'invalid_query');
  return {stream, route, reason, from: bound('from'), to: bound('to'), limit, after: url.searchParams.get('after') || null};
}
/**
 * GET /api/logs (any member of the workspace; also GET /api/v1/logs with a personal access token).
 * A read-only member cannot list keys, so `keys: false` leaves the key prefix out of the rows such a member reads.
 * Filters: stream=issues|accepted (default issues), route, reason, from, to, limit (1 to 200), after.
 * Rows are newest first. A `to` bound seeks to that time and a `from` bound ends the read, so a date range costs its own rows.
 * One request reads at most 1,000 rows; `truncated` says the read stopped there with rows left, and `next` continues it.
 */
export async function ingestLogApi(store, tenant, environment, url, {keys = true} = {}) {
  const query = filters(url), pk = logPartition(tenant,environment,store.projectId), prefix = STREAMS[query.stream], now = store.now(), attempts = [];
  const cursorAt = sk => Buffer.from(JSON.stringify({pk, sk})).toString('base64url');
  const done = (next, truncated) => json({workspace_id: tenant, environment_id: environment, stream: query.stream, retention_days: INGEST_LOG.retention_days, routes: INGEST_LOG.routes,
    recorded: {issues_per_minute: INGEST_LOG.issues_per_minute, unauthenticated_requests: false, best_effort: true}, attempts, next, truncated});
  let cursor = query.after ?? (query.to === null ? null : cursorAt(prefix + inverted(query.to, 12))), pages = 0;
  do {
    const page = await store._page(pk, prefix, {cursor, limit: 100}); pages++;
    for (const [index, row] of page.items.entries()) {
      // A full result stops here; the cursor is the last row read, so the next request starts at this one.
      if (attempts.length === query.limit) return done(cursorAt(page.items[index - 1].sk), false);
      if (!Number.isSafeInteger(row.at) || row.workspace_id !== tenant || row.environment_id !== environment || !(row.expires_at > now)) continue;
      if (query.from !== null && row.at < query.from) return done(null, false);
      if ((query.to !== null && row.at > query.to) || (query.route && row.route !== query.route) || (query.reason && row.reason !== query.reason)) continue;
      attempts.push(keys ? view(row) : {...view(row), key_prefix: null});
    }
    cursor = page.next;
  } while (cursor && attempts.length < query.limit && pages < 10);
  return done(cursor, !!cursor && attempts.length < query.limit);
}
