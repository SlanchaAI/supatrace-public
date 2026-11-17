import {hash, canonical, LIMITS} from './langfuse.mjs';
import {parseBatch} from '../trace.mjs';
import {ConversionError, parseJsonText, isObject} from './vendor/hue/fields.mjs';
import {langsmithRuns} from './vendor/hue/langsmith.mjs';
import {braintrust} from './vendor/hue/braintrust.mjs';
import {weaveCalls} from './vendor/hue/weave.mjs';
import {opikTraces} from './vendor/hue/opik.mjs';
import {datadogLlmObs} from './vendor/hue/datadog.mjs';
import {mlflowTraces} from './vendor/hue/mlflow.mjs';
import {helicone} from './vendor/hue/helicone.mjs';
import {otlpJson} from './otlp-json.mjs';

const adapters = new Map([['langsmith', langsmithRuns], ['braintrust', braintrust], ['weave', weaveCalls], ['opik', opikTraces], ['datadog', datadogLlmObs], ['mlflow', mlflowTraces], ['helicone', helicone], ['otlp', otlpJson]]);
export const FILE_FORMATS = Object.freeze([...adapters.keys()]);
export const CONNECTOR_LIMITS = Object.freeze({...LIMITS, rows: 10000, batches: 1000, outputBytes: 19 * 1024 * 1024});
const fail = code => { throw new Error(code); };
const json = value => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v));
const key = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && value.isWellFormed() && !value.includes('\0');
function bounded(value) {
  const stack = [[value, 0]];
  while (stack.length) {
    const [v, depth] = stack.pop();
    if (depth > 24) fail('input_nesting_too_deep');
    if (typeof v === 'number' && (!Number.isFinite(v) || Number.isInteger(v) && !Number.isSafeInteger(v))) fail('unsafe_number');
    if (typeof v === 'string' && (!v.isWellFormed() || v.includes('\0'))) fail('invalid_text');
    if (v && typeof v === 'object') for (const child of Object.values(v)) stack.push([child, depth + 1]);
  }
}
function parse(raw, encoding) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > LIMITS.inputBytes) fail('input_too_large');
  if (!['json', 'jsonl'].includes(encoding)) fail('explicit_encoding_required');
  const texts = encoding === 'jsonl' ? raw.split(/\r?\n/).filter(s => s.trim()) : [raw];
  if (texts.length > CONNECTOR_LIMITS.rows) fail('too_many_rows');
  const values = [], coerced = [];
  for (const text of texts) {
    const parsed = parseJsonText(text); bounded(parsed.value);
    coerced.push(parsed.unsafeIntegers);
    if (encoding === 'json' && Array.isArray(parsed.value)) values.push(...parsed.value);
    else values.push(parsed.value);
  }
  if (!values.length || values.length > CONNECTOR_LIMITS.rows) fail('empty_or_oversized_input');
  return {values, unsafeIntegers: coerced.some(Boolean)};
}

/** Pure common adapter contract: explicit format/namespace/encoding/content policy,
 * bounded JSON in; complete stable-ID batches and a review report out. No I/O.
 * Any refusal makes the conversion unstageable; no partial-success CLI writes.
 */
export function convertConnectorFile(raw, {format, namespace, encoding = 'json', content = 'metadata'} = {}) {
  const adapter = adapters.get(format);
  if (!adapter) fail('unsupported_file_format');
  if (!key(namespace) || namespace.length > 200) fail('namespace_required');
  if (!['metadata', 'include'].includes(content)) fail('explicit_content_policy_required');
  const {values, unsafeIntegers} = parse(raw, encoding);
  const report = {format: 'connector-file-v1', adapter: format, adapterVersion: 1, namespace, content,
    inputValues: values.length, acceptedRows: 0, acceptedTraces: 0, duplicateRows: 0, outputBatches: 0, rejected: [], warnings: [],
    losses: ['JSON formatting and object-key order are not retained.', 'API pagination/completeness is not established by a file.', 'Export ordering follows stored batch IDs; exact source timestamps and parent IDs are retained for reconstruction.']};
  if (content === 'metadata') report.losses.push('Content omitted: names, prompts, outputs, tools, errors, arbitrary attributes, source records, resource/scope values and user metadata. Source trace/span/parent identifiers and timing remain; this is not anonymization.');
  if (unsafeIntegers) report.warnings.push('unsafe_integer_literals_preserved_as_decimal_strings');
  const groups = new Map(); let rowCount = 0;
  const group = trace => {
    if (!key(trace)) throw new ConversionError('invalid_trace_id');
    if (!groups.has(trace)) groups.set(trace, {rows: new Map(), events: new Map(), rejected: false});
    return groups.get(trace);
  };
  const reject = (reason, trace) => {
    // Never echo upstream messages: providers may embed source content in errors.
    report.rejected.push({reason: 'invalid_source_record', ...(key(trace) ? {sourceTraceId: trace} : {})});
    if (key(trace)) group(trace).rejected = true;
  };
  const context = {keys: {}, source: {}, refuse: reject,
    row(row) {
      if (++rowCount > CONNECTOR_LIMITS.rows) fail('too_many_rows');
      if (!key(row.spanKey) || row.parentKey !== undefined && !key(row.parentKey)) throw new ConversionError('invalid_span_id');
      const g = group(row.traceKey), old = g.rows.get(row.spanKey);
      if (old) {
        if (hash(json(old)) !== hash(json(row))) { g.rejected = true; report.rejected.push({reason: 'conflicting_duplicate_span', sourceTraceId: row.traceKey}); }
        else report.duplicateRows++;
      } else g.rows.set(row.spanKey, row);
    },
    event(event) {
      if (++rowCount > CONNECTOR_LIMITS.rows) fail('too_many_rows');
      // MLflow events are already retained, in original order, in the span record.
      // Adding its derived event rows would duplicate them on overlapping exports.
      if (format === 'mlflow') return;
      // Braintrust log rows need their own record ID to distinguish real repeated
      // logs from replay. Never dedupe by content and silently erase occurrences.
      if (!key(event.record?.id)) throw new ConversionError('event_record_id_required');
      const g = group(event.traceKey), identity = event.record.id, prior = g.events.get(identity);
      if (prior && hash(json(prior)) !== hash(json(event))) throw new ConversionError('conflicting_event');
      if (!prior) g.events.set(identity, event);
      else report.duplicateRows++;
    },
    trace() { throw new ConversionError('unsupported_collector'); },
    collector() { throw new ConversionError('unsupported_collector'); },
  };
  for (const value of values) {
    try {
      if (!adapter.detect(value)) throw new ConversionError('format_mismatch');
      adapter.convert(value, context);
    } catch (error) {
      if (!(error instanceof ConversionError)) throw error;
      reject('invalid_source_record');
    }
  }
  const batches = []; let totalBytes = 0;
  for (const [trace, g] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    if (g.rejected) continue;
    const built = [];
    try {
      for (const event of g.events.values()) if (!g.rows.has(event.spanKey)) throw new ConversionError('orphan_event');
      const settled = new Set();
      for (const row of g.rows.values()) {
        const path = new Set(); let cursor = row.spanKey;
        while (cursor && g.rows.has(cursor) && !settled.has(cursor)) {
          if (path.has(cursor)) throw new ConversionError('cyclic_parent');
          path.add(cursor); cursor = g.rows.get(cursor).parentKey;
        }
        for (const item of path) settled.add(item);
      }
      for (const row of g.rows.values()) {
        if (typeof row.start !== 'bigint' || row.start <= 0n || row.start > 18446744073709551615n || row.end !== undefined && (typeof row.end !== 'bigint' || row.end < row.start || row.end > 18446744073709551615n)) throw new ConversionError('invalid_timing');
        if (row.parentKey && !g.rows.has(row.parentKey)) report.warnings.push({reason: 'parent_not_present', sourceTraceId: trace, sourceSpanId: row.spanKey});
        // Upstream rows can contain derived content. Metadata is a strict projection,
        // never a blacklist applied to arbitrary attributes or a source record.
        const span = {traceId: trace, spanId: row.spanKey, ...(row.parentKey ? {parentSpanId: row.parentKey} : {}),
          startTimeUnixNano: row.start.toString(), ...(row.end !== undefined ? {endTimeUnixNano: row.end.toString()} : {}),
          ...(row.kind && ['llm', 'tool', 'agent', 'embedding', 'retrieval'].includes(row.kind) ? {kind: row.kind} : {}), status: row.error ? 'error' : 'unset'};
        // Do not sum parent aggregates or scoring subtrees into model usage.
        let scoring = false, ancestor = row;
        while (ancestor) { scoring ||= !!ancestor.scoring; ancestor = ancestor.parentKey ? g.rows.get(ancestor.parentKey) : undefined; }
        if (row.kind === 'llm' && !scoring && isObject(row.usage)) {
          const usage = Object.fromEntries(Object.entries(row.usage).filter(([k, v]) => ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'].includes(k) && Number.isSafeInteger(v) && v >= 0));
          if (Object.keys(usage).length) span.usage = usage;
        }
        const data = {source: format, namespace, content, span};
        if (content === 'include') {
          data.original = row.record;
          if (row.context !== undefined) data.context = row.context;
          const events = [...g.events.values()].filter(e => e.spanKey === row.spanKey).sort((a, b) => (a.time ?? 0n) < (b.time ?? 0n) ? -1 : (a.time ?? 0n) > (b.time ?? 0n) ? 1 : a.record.id.localeCompare(b.record.id));
          if (events.length) data.attachedEvents = json(events);
        }
        const identity = [format, namespace, trace, row.spanKey];
        const event = {id: 'imp.' + hash(identity), time: new Date(Number(row.start / 1000000n)).toISOString(), kind: row.error ? 'error' : 'note', name: 'Imported ' + format + ' span', data};
        const batch = canonical({version: 1, run_id: 'imp.' + hash([format, namespace, trace]), batch_id: 'imp.' + hash(identity), events: [event]});
        parseBatch(JSON.stringify(batch)); built.push(batch);
      }
    } catch {
      report.rejected.push({reason: 'whole_trace_invalid_or_exceeds_intake_limits', sourceTraceId: trace}); continue;
    }
    built.sort((a, b) => a.events[0].data.span.startTimeUnixNano.padStart(20, '0').localeCompare(b.events[0].data.span.startTimeUnixNano.padStart(20, '0')) || a.batch_id.localeCompare(b.batch_id));
    for (const batch of built) { totalBytes += Buffer.byteLength(JSON.stringify(batch)); if (totalBytes > CONNECTOR_LIMITS.outputBytes) fail('converted_output_too_large'); }
    if (batches.length + built.length > CONNECTOR_LIMITS.batches) fail('too_many_batches_for_private_upload');
    batches.push(...built); report.acceptedRows += built.length; if (built.length) report.acceptedTraces++;
  }
  if (!rowCount) report.rejected.push({reason: 'no_spans'});
  report.outputBatches = batches.length;
  return {batches, report};
}
