// Langfuse-compatible ingest so an app using a Langfuse SDK only changes LANGFUSE_HOST and its keys.
// POST /api/public/ingestion takes the Langfuse batch ingestion body and answers 207 with
// per-event successes and errors. Events are stored append-only as ordinary version-1 batch
// events through the same reserve → immutable put → accept path as POST /api/batches; an
// update event is stored as its own event and is not merged into the observation it updates.
import {createHash} from 'node:crypto';
import {HttpError, json} from './http.mjs';
import {parseBatch, hash, LIMITS, IntakeError} from './trace.mjs';
import {isObject, nestedTooDeep} from './importers/vendor/hue/fields.mjs';
import {readBody, clip} from './otlp-ingest.mjs';
import {ingestDetail} from './ingest-log.mjs';
import {canonical} from './importers/langfuse.mjs';

export const LANGFUSE_LIMITS = Object.freeze({events: 1000, traces: 50, batchBytes: 480000});
const CREATE = Object.freeze({'span-create': 'span', 'generation-create': 'generation', 'event-create': 'event', 'observation-create': 'observation', 'agent-create': 'agent', 'tool-create': 'tool', 'chain-create': 'chain', 'retriever-create': 'retriever', 'evaluator-create': 'evaluator', 'embedding-create': 'embedding', 'guardrail-create': 'guardrail'});
const UPDATE = Object.freeze({'span-update': 'span', 'generation-update': 'generation', 'observation-update': 'observation'});
/** Event types that are stored. `sdk-log` is acknowledged and discarded; anything else is an error entry. */
export const LANGFUSE_STORED_TYPES = Object.freeze(['trace-create', ...Object.keys(CREATE), ...Object.keys(UPDATE), 'score-create']);
const QUOTA = new Set(['storage_capacity', 'storage_capacity_or_unknown_tenant']);
const digest = text => createHash('sha256').update(text).digest('hex');
const size = value => Buffer.byteLength(JSON.stringify(value));
const text = (value, max = 200) => typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
const instant = value => { if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null; const ms = Date.parse(value); return Number.isFinite(ms) ? ms : null; };
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
/** Langfuse trace ids that are 32 hex characters are OpenTelemetry trace ids, so they share the run the OTLP receiver uses. */
export function langfuseRunId(traceId) {
  if (/^[0-9a-fA-F]{32}$/.test(traceId)) return 'otlp.' + traceId.toLowerCase();
  return /^[A-Za-z0-9_.:-]{1,120}$/.test(traceId) ? 'lf.' + traceId : 'lf.' + hash(['langfuse-trace', traceId]);
}
function summary(type, body, traceId) {
  const kind = CREATE[type] ?? UPDATE[type] ?? (type === 'trace-create' ? 'trace' : 'score');
  const usageSource = isObject(body.usageDetails) ? body.usageDetails : isObject(body.usage) ? body.usage : {};
  const input = count(usageSource.input ?? usageSource.promptTokens ?? usageSource.prompt_tokens), output = count(usageSource.output ?? usageSource.completionTokens ?? usageSource.completion_tokens);
  const total = count(usageSource.total ?? usageSource.totalTokens ?? usageSource.total_tokens) ?? (input !== undefined && output !== undefined ? input + output : undefined);
  const usage = Object.fromEntries(Object.entries({input, output, total}).filter(([, value]) => value !== undefined));
  const cost = amount(isObject(body.costDetails) ? body.costDetails.total : undefined) ?? amount(usageSource.totalCost);
  const start = instant(body.startTime), end = instant(body.endTime);
  return {traceId, ...(type === 'trace-create' ? {} : type === 'score-create' ? (text(body.observationId) ? {spanId: body.observationId} : {}) : {spanId: body.id}),
    // Keep presence even when the parent ID cannot fit the validated summary.
    ...(body.parentObservationId !== undefined && body.parentObservationId !== null && body.parentObservationId !== '' ? {has_parent: true} : {}),
    ...(text(body.parentObservationId) ? {parentSpanId: body.parentObservationId} : {}),
    ...(start !== null ? {startTime: new Date(start).toISOString()} : {}), ...(end !== null ? {endTime: new Date(end).toISOString()} : {}), ...(start !== null && end !== null && end >= start ? {duration_ms: end - start} : {}),
    kind: kind === 'generation' ? 'llm' : kind, ...(type in UPDATE ? {update: true} : {}), status: body.level === 'ERROR' ? 'error' : 'unset',
    ...(text(body.model) ? {model: body.model} : {}), ...(Object.keys(usage).length ? {usage} : {}), ...(cost !== undefined ? {reported_cost: cost} : {}),
    ...(type === 'score-create' ? {score: {name: text(body.name) ?? 'score', ...(typeof body.value === 'number' || typeof body.value === 'string' ? {value: typeof body.value === 'string' ? body.value.slice(0, 200) : body.value} : {})}} : {})};
}
/** Pure: Langfuse ingestion body → version-1 batches plus per-event results. Throws HttpError for a malformed envelope. */
export function planLangfuseBatches(value) {
  if (!isObject(value) || !Array.isArray(value.batch) || value.batch.length < 1) throw new HttpError(400, 'invalid_langfuse_batch');
  if (value.batch.length > LANGFUSE_LIMITS.events) throw new HttpError(413, 'too_many_events');
  const successes = [], errors = [], runs = new Map(), seen = new Set(), repeats = [];
  const refuse = (id, status, message) => errors.push({id: typeof id === 'string' ? id.slice(0, 200) : 'unknown', status, message, error: status === 403 ? 'ForbiddenError' : 'BadRequestError'});
  for (const item of value.batch) {
    const id = isObject(item) ? text(item.id) : null;
    if (!id) { refuse(isObject(item) ? item.id : null, 400, 'Each event needs a string id of 1 to 200 characters.'); continue; }
    if (seen.has(id)) { repeats.push(id); continue; } seen.add(id); // A repeated id gets the first occurrence's final result.
    if (item.type === 'sdk-log') { successes.push({id, status: 201}); continue; }
    if (!LANGFUSE_STORED_TYPES.includes(item.type)) { refuse(id, 400, 'Event type ' + JSON.stringify(typeof item.type === 'string' ? item.type.slice(0, 60) : null) + ' is not accepted. Accepted: ' + LANGFUSE_STORED_TYPES.join(', ') + '.'); continue; }
    const body = item.body;
    if (!isObject(body)) { refuse(id, 400, 'Event body must be an object.'); continue; }
    const traceId = text(item.type === 'trace-create' ? body.id : body.traceId);
    if (!traceId) { refuse(id, 400, item.type === 'trace-create' ? 'trace-create needs body.id (1 to 200 characters).' : item.type + ' needs body.traceId (1 to 200 characters).'); continue; }
    if (item.type !== 'trace-create' && item.type !== 'score-create' && !text(body.id)) { refuse(id, 400, item.type + ' needs body.id (1 to 200 characters).'); continue; }
    const at = (item.type in UPDATE ? null : instant(body.startTime) ?? instant(body.timestamp)) ?? instant(item.timestamp);
    if (at === null) { refuse(id, 400, 'Event needs an ISO 8601 timestamp with a timezone.'); continue; }
    const run = langfuseRunId(traceId);
    if (!runs.has(run) && runs.size >= LANGFUSE_LIMITS.traces) { refuse(id, 400, 'More than ' + LANGFUSE_LIMITS.traces + ' traces in one request; lower the SDK flush size.'); continue; }
    const kind = body.level === 'ERROR' ? 'error' : item.type === 'generation-create' ? 'response' : item.type === 'tool-create' ? 'tool_call' : 'note';
    const name = (typeof body.name === 'string' ? body.name.trim().slice(0, 200) : '') || item.type;
    const build = extra => ({id: 'lf.' + hash(['langfuse-event', id]).slice(0, 40), time: new Date(at).toISOString(), kind, name, data: {source: 'langfuse', type: item.type, span: summary(item.type, body, traceId), ...extra}});
    let event;
    try {
      const check = candidate => { parseBatch(JSON.stringify({version: 1, batch_id: 'check', run_id: 'check', events: [candidate]})); return candidate; };
      const full = build({langfuse: body});
      if (size(full.data) <= LIMITS.text) event = check(full); else event = check(build({truncated: true, langfuse: clip(body)}));
    } catch (error) {
      if (!(error instanceof IntakeError)) throw error;
      refuse(id, 400, error.code === 'invalid_data' ? 'Event exceeds the 32 KiB stored-event limit even after truncating long values.' : 'Event holds a value the store cannot keep (an integer beyond 2^53, or nesting deeper than 32).'); continue;
    }
    const events = runs.get(run) ?? []; events.push({id, event, bytes: size(event) + 1}); runs.set(run, events);
  }
  const batches = [];
  for (const [run, events] of runs) {
    let chunk = [], bytes = 0;
    const flush = () => {
      if (!chunk.length) return;
      // Stored bytes are canonical (sorted keys), so the same events with body keys in another order are the same batch, not a conflict.
      const body = {version: 1, run_id: run, events: chunk.map(item => item.event)}, batch = canonical({...body, batch_id: 'lf.' + hash(body)}), raw = JSON.stringify(batch);
      batches.push({batch, raw, request_hash: digest(raw), ids: chunk.map(item => item.id)}); chunk = []; bytes = 0;
    };
    for (const item of events) { if (chunk.length === 100 || bytes + item.bytes > LANGFUSE_LIMITS.batchBytes) flush(); chunk.push(item); bytes += item.bytes; }
    flush();
  }
  // Call after storage: every id, including repeats, with its final outcome.
  const results = () => {
    const done = new Set(successes.map(item => item.id)), failed = new Map(errors.map(item => [item.id, item]));
    return {successes: [...successes, ...repeats.filter(id => done.has(id)).map(id => ({id, status: 201}))], errors: [...errors, ...repeats.filter(id => !done.has(id) && failed.has(id)).map(id => ({...failed.get(id)}))]};
  };
  return {batches, successes, errors, refuse, results};
}
const MESSAGES = Object.freeze({
  write_key_required: 'Missing credentials. Use HTTP Basic auth with any public key as the username and a SupaTrace write key as the secret key (password).',
  invalid_write_key: 'The secret key is not a recognised SupaTrace write key, or it has expired or been revoked.',
  rate_limit: 'Too many ingest requests for this workspace. Retry after the Retry-After interval.',
  invalid_langfuse_batch: 'Body must be JSON of the form {"batch": [event, ...]} with at least one event.',
  too_many_events: 'One request may carry at most 1000 events.',
  payload_too_large: 'The request is larger than 512 KiB on the wire or 4 MiB uncompressed. Lower the SDK flush size.',
  json_required: 'Send the batch as application/json.',
  quota_exceeded: 'The workspace storage quota is reached, so this event was not stored.',
  commercial_upload_blocked: 'Uploads are blocked for this workspace by its billing state, so this event was not stored.',
  temporarily_unavailable: 'SupaTrace could not store the events right now. Retry the request.',
});
const NAMES = {400: 'BadRequestError', 401: 'UnauthorizedError', 403: 'ForbiddenError', 413: 'PayloadTooLargeError', 415: 'UnsupportedMediaTypeError', 429: 'TooManyRequestsError', 503: 'ServiceUnavailableError'};
/** Langfuse-shaped error body: {error: <name>, message}; `code` is the SupaTrace error code. */
export function langfuseFailure(error, observe) {
  const known = Number.isInteger(error?.status) && typeof error?.code === 'string';
  const status = known ? error.status : 503, code = known ? error.code : 'temporarily_unavailable';
  observe?.({status, code});
  const response = json({error: NAMES[status] ?? 'Error', message: MESSAGES[code] ?? code, code}, status);
  if (status === 429 || status === 503) { const after = error?.retryAfter ?? (status === 429 ? 60 : undefined); if (Number.isFinite(after) && after > 0) response.headers.set('Retry-After', String(Math.ceil(after))); }
  return response;
}
/** authorize(): resolves the Basic-auth secret key to {store(planned)}; throws HttpError (401/403/429). */
export async function langfuseIngestion(request, {authorize, observe}) {
  try {
    if ((request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') throw new HttpError(415, 'json_required');
    const scope = await authorize();
    const bytes = await readBody(request);
    let value; try { value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); } catch { throw new HttpError(400, 'invalid_langfuse_batch'); }
    if (nestedTooDeep(value, 64)) throw new HttpError(400, 'invalid_langfuse_batch');
    const plan = planLangfuseBatches(value);
    let stop = null;
    for (const planned of plan.batches) {
      if (stop) { for (const id of planned.ids) plan.refuse(id, 403, stop); continue; }
      try { await scope.store(planned); for (const id of planned.ids) plan.successes.push({id, status: 201}); }
      catch (error) {
        const code = QUOTA.has(error?.code) ? 'quota_exceeded' : error?.code;
        if (code === 'quota_exceeded' || code === 'commercial_upload_blocked') { stop = MESSAGES[code]; for (const id of planned.ids) plan.refuse(id, 403, stop); }
        else if (code === 'idempotency_conflict') for (const id of planned.ids) plan.refuse(id, 400, 'Event conflicts with a different event already stored under the same ids.');
        else throw error; // Transient: the whole request is retryable and the retry is idempotent.
      }
    }
    const results = plan.results();
    // The ingest log gets the count of refused events and the most frequent refusal messages. The one message that quotes
    // the sender's own text (an unaccepted event type) is logged without the quote, so no request content reaches the log.
    observe?.({status: 207, rejected: results.errors.length, detail: ingestDetail(results.errors.map(item => item.message.startsWith('Event type ') ? 'Event type is not accepted.' : item.message))});
    return json(results, 207);
  } catch (error) { return langfuseFailure(error, observe); }
}
