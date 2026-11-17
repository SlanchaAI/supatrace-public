// Hosted OTLP/HTTP trace receiver (POST /v1/traces). Spans are validated one at a time with the
// file importer's OTLP validator, grouped by trace into ordinary version-1 batches and stored
// through the same reserve → immutable put → accept path as POST /api/batches, so quotas,
// idempotency and receipts are unchanged. Responses follow the OTLP/HTTP specification:
// 200 with an optional partial_success, or a google.rpc.Status body on failure.
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {HttpError, securityHeaders} from './http.mjs';
import {parseBatch, hash, LIMITS, IntakeError} from './trace.mjs';
import {otlpJson} from './importers/otlp-json.mjs';
import {ConversionError, isObject, nestedTooDeep} from './importers/vendor/hue/fields.mjs';
import {decodeTraceRequest, encodeTraceResponse, encodeStatus, ProtobufError} from './otlp-protobuf.mjs';

// wireBytes fits the Lambda event cap after base64. traces bounds the sequential store work per request
// (one batch per trace) so it fits the 15 s function timeout; a timed-out request is safe to retry.
export const OTLP_LIMITS = Object.freeze({wireBytes: 524288, bytes: 4194304, spans: 2000, traces: 50, batchBytes: 480000, storedBytes: 8388608, clip: 256});
const MESSAGES = Object.freeze({
  write_key_required: 'Missing ingest key. Send the project write key as "Authorization: Bearer <key>" or "x-supatrace-key: <key>".',
  invalid_write_key: 'Ingest key not recognised or malformed. Copy the full key that starts with st_pub_. Create or copy a key under API keys in the app.',
  environment_unavailable: 'The ingest key does not belong to the requested environment.',
  project_unavailable: 'The ingest key does not belong to the requested project.',
  rate_limit: 'Too many export requests for this workspace. Retry after the Retry-After interval.',
  quota_exceeded: 'The workspace storage quota is reached, so these spans were not stored. Free space or upgrade the plan, then send new spans.',
  commercial_upload_blocked: 'Uploads are blocked for this workspace by its billing state, so these spans were not stored.',
  unsupported_media_type: 'Send OTLP/HTTP as application/x-protobuf or application/json (OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf or http/json).',
  unsupported_content_encoding: 'Only gzip or no compression is supported (OTEL_EXPORTER_OTLP_COMPRESSION=gzip or none).',
  payload_too_large: 'The export request is larger than 512 KiB on the wire or 4 MiB uncompressed. Lower OTEL_BSP_MAX_EXPORT_BATCH_SIZE.',
  invalid_gzip: 'The gzip request body could not be decompressed.',
  invalid_otlp: 'The body is not a valid OTLP ExportTraceServiceRequest.',
  too_many_spans: 'One export request may carry at most 2000 spans. Lower OTEL_BSP_MAX_EXPORT_BATCH_SIZE.',
  no_valid_spans: 'No span in the request could be stored.',
  temporarily_unavailable: 'SupaTrace could not store the spans right now. Retry the export.',
});
const GRPC = {400: 3, 401: 16, 403: 7, 404: 5, 409: 10, 413: 8, 415: 3, 429: 8, 503: 14};
const QUOTA = new Set(['storage_capacity', 'storage_capacity_or_unknown_tenant']);
const digest = text => createHash('sha256').update(text).digest('hex');

/** Bounded request body; gzip is inflated up to OTLP_LIMITS.bytes. Shared by the Langfuse-compatible ingest. */
export async function readBody(request) {
  const encoding = (request.headers.get('content-encoding') || 'identity').trim().toLowerCase();
  if (!['identity', 'gzip'].includes(encoding)) throw new HttpError(415, 'unsupported_content_encoding');
  if (!request.body) throw new HttpError(400, 'invalid_otlp');
  const reader = request.body.getReader(), parts = []; let length = 0;
  try { while (true) { const {done, value} = await reader.read(); if (done) break; length += value.byteLength; if (length > OTLP_LIMITS.wireBytes) { await reader.cancel(); throw new HttpError(413, 'payload_too_large'); } parts.push(value); } }
  finally { reader.releaseLock(); }
  const wire = Buffer.concat(parts);
  if (encoding !== 'gzip') return wire;
  try { return gunzipSync(wire, {maxOutputLength: OTLP_LIMITS.bytes}); }
  catch (error) { throw new HttpError(...(error?.code === 'ERR_BUFFER_TOO_LARGE' ? [413, 'payload_too_large'] : [400, 'invalid_gzip'])); }
}

const attribute = (span, key) => span.attributes?.find(item => item.key === key)?.value;
function text(span, keys) { for (const key of keys) { const value = attribute(span, key)?.stringValue; if (typeof value === 'string' && value) return value.slice(0, 200); } }
function number(span, keys, integer) {
  for (const key of keys) {
    const value = attribute(span, key), raw = value?.intValue ?? value?.doubleValue;
    if (raw === undefined) continue;
    const n = Number(raw); if (Number.isFinite(n) && n >= 0 && (!integer || Number.isSafeInteger(n))) return n;
  }
}
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
function jsonAttribute(span, key) {
  const value = attribute(span, key)?.stringValue;
  if (typeof value !== 'string' || value.length > 4096) return {};
  try { const parsed = JSON.parse(value); return isObject(parsed) ? parsed : {}; } catch { return {}; }
}
/** The fields a trace list needs, read from OpenTelemetry GenAI, OpenLLMetry, OpenInference and Vercel AI SDK attribute names. */
export function spanSummary(row) {
  const span = row.record.span;
  // Langfuse SDKs export OTLP with their own attribute names; usage and cost are JSON text.
  const langfuseKind = ({generation: 'llm', embedding: 'embedding', tool: 'tool', agent: 'agent', retriever: 'retrieval'})[attribute(span, 'langfuse.observation.type')?.stringValue];
  const langfuseUsage = jsonAttribute(span, 'langfuse.observation.usage_details'), langfuseCost = jsonAttribute(span, 'langfuse.observation.cost_details');
  const model = text(span, ['gen_ai.response.model', 'gen_ai.request.model', 'llm.model_name', 'llm.response.model', 'llm.request.model', 'ai.model.id', 'langfuse.observation.model.name']);
  const provider = text(span, ['gen_ai.provider.name', 'gen_ai.system', 'llm.provider', 'llm.system', 'ai.model.provider']);
  const input = number(span, ['gen_ai.usage.input_tokens', 'gen_ai.usage.prompt_tokens', 'llm.token_count.prompt', 'llm.usage.prompt_tokens', 'ai.usage.promptTokens'], true) ?? count(langfuseUsage.input);
  const output = number(span, ['gen_ai.usage.output_tokens', 'gen_ai.usage.completion_tokens', 'llm.token_count.completion', 'llm.usage.completion_tokens', 'ai.usage.completionTokens'], true) ?? count(langfuseUsage.output);
  const total = number(span, ['gen_ai.usage.total_tokens', 'llm.token_count.total', 'llm.usage.total_tokens'], true) ?? count(langfuseUsage.total) ?? (input !== undefined && output !== undefined ? input + output : undefined);
  // Only a cost the instrumentation itself reported; SupaTrace applies no price table here.
  const cost = number(span, ['gen_ai.usage.cost', 'llm.cost.total', 'llm.usage.total_cost'], false) ?? (typeof langfuseCost.total === 'number' && Number.isFinite(langfuseCost.total) && langfuseCost.total >= 0 ? langfuseCost.total : undefined);
  const tool = text(span, ['gen_ai.tool.name', 'tool.name']);
  const kind = row.kind ?? langfuseKind ?? (attribute(span, 'gen_ai.operation.name')?.stringValue === 'execute_tool' || tool ? 'tool' : model && (input !== undefined || output !== undefined) ? 'llm' : undefined);
  const usage = Object.fromEntries(Object.entries({input, output, total}).filter(([, value]) => value !== undefined));
  return {traceId: row.traceKey, spanId: row.spanKey, ...(row.parentKey ? {parentSpanId: row.parentKey} : {}),
    startTimeUnixNano: row.start.toString(), endTimeUnixNano: row.end.toString(), duration_ms: Number(row.end - row.start) / 1e6,
    ...(kind ? {kind} : {}), status: row.error ? 'error' : span.status?.code === 1 ? 'ok' : 'unset',
    ...(model ? {model} : {}), ...(provider ? {provider} : {}), ...(tool ? {tool} : {}),
    ...(Object.keys(usage).length ? {usage} : {}), ...(cost !== undefined ? {reported_cost: cost} : {})};
}
export function clip(value) {
  if (typeof value === 'string') return value.length > OTLP_LIMITS.clip ? value.slice(0, OTLP_LIMITS.clip) + '…' : value;
  if (Array.isArray(value)) return value.map(clip);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clip(item)]));
  return value;
}
const size = value => Buffer.byteLength(JSON.stringify(value));
/**
 * One stored event per span. `context` carries the span's resource and scope, prepared once per scope:
 * {full, clipped()} where full is null when the pair alone is over the stored-span limit.
 * Returns {event, truncated}; throws IntakeError when the span cannot fit the intake limits.
 */
export function spanEvent(row, context) {
  const summary = spanSummary(row), name = row.name.trim().slice(0, 200) || 'span', span = row.record.span;
  const kind = row.error ? 'error' : summary.kind === 'tool' ? 'tool_call' : summary.kind === 'llm' ? 'response' : 'note';
  const build = otlp => ({id: 'span.' + row.spanKey, time: new Date(Number(row.start / 1000000n)).toISOString(), kind, name, data: {source: 'otlp', span: summary, ...otlp}});
  const check = event => { parseBatch(JSON.stringify({version: 1, batch_id: 'check', run_id: 'check', events: [event]})); return event; };
  if (context.full) { const full = build({otlp: {...context.full, span}}); if (size(full.data) <= LIMITS.text) return {event: check(full), truncated: false}; }
  return {event: check(build({truncated: true, otlp: {...context.clipped(), span: clip(span)}})), truncated: true};
}
// OTLP/JSON receivers must ignore unknown fields and accept 64-bit integers as numbers or strings.
// The strict file validator does neither, so each message is reduced to the form it expects first.
const VALUE_KEYS = ['stringValue', 'boolValue', 'intValue', 'doubleValue', 'arrayValue', 'kvlistValue', 'bytesValue'];
const int64 = value => typeof value === 'number' && Number.isInteger(value) ? BigInt(value).toString() : value;
function tidyValue(value) {
  if (!isObject(value)) return value;
  const key = VALUE_KEYS.find(name => value[name] !== undefined && value[name] !== null);
  if (!key) return undefined; // An empty AnyValue is a null attribute; it is dropped.
  const inner = value[key];
  if (key === 'intValue') return {intValue: int64(inner)};
  if (key === 'arrayValue' && isObject(inner)) return {arrayValue: {values: Array.isArray(inner.values) ? inner.values.map(tidyValue).filter(item => item !== undefined) : inner.values}};
  if (key === 'kvlistValue' && isObject(inner)) return {kvlistValue: {values: tidyAttributes(inner.values)}};
  return {[key]: inner};
}
function tidyAttributes(items) {
  if (!Array.isArray(items)) return items;
  return items.map(item => isObject(item) ? {key: item.key, value: tidyValue(item.value)} : item).filter(item => !isObject(item) || item.value !== undefined);
}
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
const OWNER = ['attributes', 'droppedAttributesCount'];
// Keeps only the fields of the named message, with attributes reduced as above.
function tidy(value, keys) {
  if (!isObject(value)) return value;
  const out = pick(value, keys);
  if (out.attributes !== undefined) out.attributes = tidyAttributes(out.attributes);
  return out;
}
function tidySpan(span) {
  if (!isObject(span)) return span;
  const out = tidy(span, ['traceId', 'spanId', 'traceState', 'parentSpanId', 'name', 'kind', 'startTimeUnixNano', 'endTimeUnixNano', ...OWNER, 'events', 'droppedEventsCount', 'links', 'droppedLinksCount', 'status', 'flags']);
  out.startTimeUnixNano = int64(out.startTimeUnixNano); out.endTimeUnixNano = int64(out.endTimeUnixNano);
  if (Array.isArray(out.events)) out.events = out.events.map(event => { const item = tidy(event, ['timeUnixNano', 'name', ...OWNER]); if (isObject(item)) item.timeUnixNano = int64(item.timeUnixNano); return item; });
  if (Array.isArray(out.links)) out.links = out.links.map(link => tidy(link, ['traceId', 'spanId', 'traceState', ...OWNER, 'flags']));
  if (isObject(out.status)) out.status = pick(out.status, ['message', 'code']);
  return out;
}
const list = value => value === undefined ? [] : Array.isArray(value) ? value : (() => { throw new HttpError(400, 'invalid_otlp'); })();
/** Pure: OTLP/JSON-shaped request → version-1 batches plus per-span rejections. Throws HttpError for a malformed envelope. */
export function planOtlpBatches(value) {
  if (!otlpJson.detect(value)) throw new HttpError(400, 'invalid_otlp');
  const traces = new Map(), reasons = new Map(); let spans = 0, rejected = 0, truncated = 0;
  const reject = (reason, count = 1) => { rejected += count; reasons.set(reason, (reasons.get(reason) ?? 0) + count); };
  // Resource and scope are shared by many spans, so each is validated, measured and truncated once,
  // never once per span; the work per span is then proportional to the span itself.
  const valid = envelope => { try { otlpJson.convert(envelope, {row() {}}); return true; } catch (error) { if (!(error instanceof ConversionError)) throw error; return false; } };
  const TOO_LARGE = 'resource or scope attributes exceed the 32 KiB stored-span limit even after truncating long values';
  let planned = 0;
  for (const resource of value.resourceSpans) {
    if (!isObject(resource)) throw new HttpError(400, 'invalid_otlp');
    const {scopeSpans} = resource, resourceContext = pick(resource, ['resource', 'schemaUrl']);
    if (resourceContext.resource !== undefined) resourceContext.resource = tidy(resourceContext.resource, OWNER);
    const resourceValid = valid({resourceSpans: [{...resourceContext, scopeSpans: []}]}), resourceBytes = size(resourceContext);
    let resourceClip = null;
    for (const scope of list(scopeSpans)) {
      if (!isObject(scope)) throw new HttpError(400, 'invalid_otlp');
      const scoped = list(scope.spans), scopeContext = pick(scope, ['scope', 'schemaUrl']);
      if (scopeContext.scope !== undefined) scopeContext.scope = tidy(scopeContext.scope, ['name', 'version', ...OWNER]);
      if ((spans += scoped.length) > OTLP_LIMITS.spans) throw new HttpError(400, 'too_many_spans');
      if (!scoped.length) continue;
      if (!resourceValid || !valid({resourceSpans: [{scopeSpans: [{...scopeContext, spans: []}]}]})) { reject('invalid resource or scope (attributes do not follow OTLP)', scoped.length); continue; }
      const full = resourceBytes + size(scopeContext) <= LIMITS.text ? {resource: resourceContext, scope: scopeContext} : null;
      let clipped = null;
      if (!full) {
        resourceClip ??= (value => ({value, bytes: size(value)}))(clip(resourceContext));
        const scopeClip = clip(scopeContext);
        if (resourceClip.bytes + size(scopeClip) > LIMITS.text) { reject(TOO_LARGE, scoped.length); continue; }
        clipped = {resource: resourceClip.value, scope: scopeClip};
      }
      const context = {full, clipped: () => clipped ??= {resource: clip(resourceContext), scope: clip(scopeContext)}};
      for (const span of scoped) {
        if (planned > OTLP_LIMITS.storedBytes) { reject('export is larger than 8 MiB once stored; lower OTEL_BSP_MAX_EXPORT_BATCH_SIZE'); continue; }
        let row;
        try { otlpJson.convert({resourceSpans: [{scopeSpans: [{spans: [tidySpan(span)]}]}]}, {row: item => { row = item; }}); }
        catch (error) { if (!(error instanceof ConversionError)) throw error; reject('invalid span (ids, name, timestamps or attributes do not follow OTLP)'); continue; }
        const events = traces.get(row.traceKey) ?? new Map();
        if (events.has(row.spanKey)) { reject('span id repeated within one trace in this request'); continue; }
        if (!traces.has(row.traceKey) && traces.size >= OTLP_LIMITS.traces) { reject('more than ' + OTLP_LIMITS.traces + ' traces in one export request; lower OTEL_BSP_MAX_EXPORT_BATCH_SIZE'); continue; }
        try { const built = spanEvent(row, context), bytes = size(built.event) + 1; planned += bytes; events.set(row.spanKey, {event: built.event, bytes}); if (built.truncated) truncated++; traces.set(row.traceKey, events); }
        catch (error) { if (!(error instanceof IntakeError)) throw error; reject(error.code === 'invalid_data' ? 'span exceeds the 32 KiB stored-span limit even after truncating long values' : 'span holds a value the store cannot keep (an integer beyond 2^53 sent as a number, or nesting deeper than 32)'); }
      }
    }
  }
  const batches = [];
  for (const [trace, events] of traces) {
    let chunk = [], bytes = 0;
    const flush = () => {
      if (!chunk.length) return;
      const body = {version: 1, run_id: 'otlp.' + trace, events: chunk}, batch = {...body, batch_id: 'otlp.' + hash(body)}, raw = JSON.stringify(batch);
      batches.push({batch, raw, request_hash: digest(raw)}); chunk = []; bytes = 0;
    };
    for (const {event, bytes: eventBytes} of events.values()) {
      if (chunk.length === 100 || bytes + eventBytes > OTLP_LIMITS.batchBytes) flush();
      chunk.push(event); bytes += eventBytes;
    }
    flush();
  }
  return {batches, spans, truncated, reasons, reject, get rejected() { return rejected; }};
}
function respond(proto, status, json, bytes, retryAfter) {
  const headers = securityHeaders({'Content-Type': proto ? 'application/x-protobuf' : 'application/json'});
  if (Number.isFinite(retryAfter) && retryAfter > 0) headers['Retry-After'] = String(Math.ceil(retryAfter));
  return new Response(proto ? bytes : JSON.stringify(json), {status, headers});
}
function failure(proto, error, observe) {
  const known = Number.isInteger(error?.status) && typeof error?.code === 'string';
  let status = known ? error.status : 503, code = known ? error.code : 'temporarily_unavailable';
  if (QUOTA.has(code)) { status = 403; code = 'quota_exceeded'; }
  if (error instanceof ProtobufError) { status = 400; code = 'invalid_otlp'; }
  const message = MESSAGES[code] ?? code, grpc = GRPC[status] ?? 2;
  observe?.({status, code});
  return respond(proto, status, {code: grpc, message, error: code}, encodeStatus(grpc, message), status === 429 || status === 503 ? error?.retryAfter ?? (status === 429 ? 60 : undefined) : undefined);
}
/**
 * authorize(): resolves the write key to {store(batch)}; throws HttpError (401/403/429).
 * store(planned): persists one planned batch; a thrown 403/429 quota error stops the request.
 * observe({status, code?, rejected?, detail?}): optional; called once with the outcome being answered (the ingest log).
 */
export async function otlpTraces(request, {authorize, observe}) {
  const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(), proto = type === 'application/x-protobuf';
  try {
    if (!proto && type !== 'application/json') throw new HttpError(415, 'unsupported_media_type');
    const scope = await authorize();
    const bytes = await readBody(request);
    let value;
    if (proto) value = decodeTraceRequest(bytes);
    else { try { value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); } catch { throw new HttpError(400, 'invalid_otlp'); } }
    // The validators below recurse; refuse pathological nesting before walking it.
    if (nestedTooDeep(value, 64)) throw new HttpError(400, 'invalid_otlp');
    const plan = planOtlpBatches(value);
    let stored = 0, stop = null;
    for (const planned of plan.batches) {
      if (stop) { plan.reject(stop, planned.batch.events.length); continue; }
      try { await scope.store(planned); stored += planned.batch.events.length; }
      catch (error) {
        const code = QUOTA.has(error?.code) ? 'quota_exceeded' : error?.code;
        if (code === 'quota_exceeded' || code === 'commercial_upload_blocked') { stop = MESSAGES[code]; plan.reject(stop, planned.batch.events.length); if (!stored) throw error; }
        else if (code === 'idempotency_conflict') plan.reject('span conflicts with a different span already stored under the same ids', planned.batch.events.length);
        else throw error;
      }
    }
    if (!stored && plan.rejected) {
      const detail = [...plan.reasons].map(([reason, count]) => count + ' × ' + reason).join('; ');
      observe?.({status: 400, code: 'no_valid_spans', rejected: plan.rejected, detail});
      return respond(proto, 400, {code: 3, message: MESSAGES.no_valid_spans + ' ' + detail, error: 'no_valid_spans'}, encodeStatus(3, MESSAGES.no_valid_spans + ' ' + detail));
    }
    const notes = [...plan.reasons].map(([reason, count]) => count + ' × ' + reason);
    if (plan.truncated) notes.push(plan.truncated + ' span(s) stored with attribute values longer than ' + OTLP_LIMITS.clip + ' characters truncated to fit 32 KiB');
    const partial = notes.length ? {rejectedSpans: plan.rejected, errorMessage: notes.join('; ')} : null;
    observe?.({status: 200, rejected: plan.rejected, detail: notes.join('; ')});
    // OTLP/JSON encodes int64 as a decimal string.
    return respond(proto, 200, partial ? {partialSuccess: {rejectedSpans: String(partial.rejectedSpans), errorMessage: partial.errorMessage}} : {}, encodeTraceResponse(partial ?? {}));
  } catch (error) { return failure(proto, error, observe); }
}
