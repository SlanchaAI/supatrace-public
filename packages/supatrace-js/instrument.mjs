// Wrapper-based instrumentation for OpenAI and Anthropic clients (alpha).
//
// `instrument(trace, client)` returns a wrapped view of ONE client instance. Nothing global is touched: no prototype,
// module or `fetch` is patched, the client you pass in is not modified, and a client you did not wrap is not traced.
// The wrapper is a Proxy that forwards everything and records one span for each call to:
//
//   OpenAI      client.chat.completions.create(...)   client.responses.create(...)
//   Anthropic   client.messages.create(...)
//
// The call's own return value is handed back with its helpers (the SDKs return a promise subclass with
// `.withResponse()` and `.asResponse()`; wrapping it in another promise would drop them). The span is recorded from a
// side branch of that promise, and a failure while recording is counted on the handle and never reaches the caller.
//
// Raw responses and timing: the recorder never touches the returned promise before the caller does, so it neither
// parses a body the caller wants raw nor changes how Node reports an unhandled failure. The span is taken from the
// caller's own first use. A first use of `.asResponse()`, chained or later, is recorded without parsing (request side
// and duration only, marked `supatrace.raw_response`). The span ends when the result settles as seen from that first
// use, so its duration includes any time the caller waited before using the promise. A first use 5 ms or more after
// the call returned is marked `supatrace.late_use` with that wait in `supatrace.first_use_delay_ms`. A promise that
// is never awaited or used records no span.
//
// What a span holds: provider, operation, requested and served model, response id, token usage and finish reasons
// when the response carries them, duration, and the error type on failure. Prompts and outputs are recorded only
// when the trace handle has captureContent on (off by default), cut to CONTENT_LIMIT bytes of serialized JSON each.
//
// Streaming (`stream: true`): the span is recorded when the stream opens, marked `supatrace.streamed`. Chunks are
// not read, so a streamed call has no token usage, finish reason or output on its span.
//
// Unmeasured: the response field names below follow the providers' published response shapes and are exercised
// against fake clients only. No live provider call has been made from this repository.
import { randomUUID } from 'node:crypto';

export const CONTENT_LIMIT = 8000;
export const INSTRUMENTED = Object.freeze({
  openai: Object.freeze(['chat.completions.create', 'responses.create']),
  anthropic: Object.freeze(['messages.create']),
});

const whole = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : undefined);
// Identifiers and labels (model, response id, finish reason, error name) are short by nature. Each is cut to
// LABEL_LIMIT characters, so an oversized value can neither break the span name limit (200) nor crowd the event.
export const LABEL_LIMIT = 120;
const text = (value) => (typeof value === 'string' && value ? value.slice(0, LABEL_LIMIT) : undefined);
// Content is cut by what it costs in a stored event: the UTF-8 bytes of its JSON form, escapes included. A string of
// control characters or of multi-byte text is therefore cut shorter than plain ASCII. Returns {text, truncated}, or
// null for a value that cannot be serialized.
const cost = (string) => Buffer.byteLength(JSON.stringify(string), 'utf8');
function clip(value) {
  let out;
  try { out = typeof value === 'string' ? value : JSON.stringify(value); } catch { return null; }
  if (typeof out !== 'string') return null;
  if (cost(out) <= CONTENT_LIMIT) return { text: out, truncated: false };
  let low = 0, high = out.length;
  while (low < high) { const middle = Math.ceil((low + high) / 2); if (cost(out.slice(0, middle)) <= CONTENT_LIMIT) low = middle; else high = middle - 1; }
  // Never end on half of a surrogate pair.
  if (low > 0 && out.charCodeAt(low - 1) >= 0xD800 && out.charCodeAt(low - 1) <= 0xDBFF) low--;
  return { text: out.slice(0, low), truncated: true };
}

// One reader per instrumented method: {operation, input(params), read(response) -> {id, model, input, output, finish, status?, content}}.
const READERS = Object.freeze({
  'openai:chat.completions.create': {
    operation: 'chat',
    input: (params) => params?.messages,
    read: (r) => ({
      id: text(r?.id), model: text(r?.model), input: whole(r?.usage?.prompt_tokens), output: whole(r?.usage?.completion_tokens),
      finish: Array.isArray(r?.choices) ? r.choices.map((c) => text(c?.finish_reason)).filter(Boolean) : [],
      content: Array.isArray(r?.choices) ? r.choices[0]?.message?.content : undefined,
    }),
  },
  'openai:responses.create': {
    operation: 'responses',
    input: (params) => params?.input,
    read: (r) => ({
      id: text(r?.id), model: text(r?.model), input: whole(r?.usage?.input_tokens), output: whole(r?.usage?.output_tokens),
      // `status` is the response's lifecycle state (completed, incomplete, queued, …), not a finish reason, and is
      // recorded under its own name. The one finish reason the Responses API states is why a response is incomplete.
      status: text(r?.status), finish: [text(r?.incomplete_details?.reason)].filter(Boolean),
      content: r?.output_text ?? r?.output,
    }),
  },
  'anthropic:messages.create': {
    operation: 'chat',
    input: (params) => params?.messages,
    read: (r) => ({
      id: text(r?.id), model: text(r?.model), input: whole(r?.usage?.input_tokens), output: whole(r?.usage?.output_tokens),
      finish: [text(r?.stop_reason)].filter(Boolean),
      content: r?.content,
    }),
  },
});

// Views made by instrument(): the handle each one records to and the client underneath it.
const VIEWS = new WeakMap();

/** The note init() leaves for a provider whose client has not been wrapped yet. */
export const notWrapped = (provider) => `${provider}: not wrapped; call trace.instrument(client) with your ${provider} client`;

/** Which provider a client instance is, by the methods it has. Null when it is neither. */
export function detectProvider(client) {
  if (!client || typeof client !== 'object') return null;
  if (typeof client.chat?.completions?.create === 'function' || typeof client.responses?.create === 'function') return 'openai';
  if (typeof client.messages?.create === 'function') return 'anthropic';
  return null;
}

// What is read from the request, taken when the call is made. The caller may reuse or change its parameter object
// while the request runs; the span describes the request as it was sent. Content is read only with captureContent on.
function snapshot(reader, params, captureContent) {
  try {
    const request = { model: text(params?.model), streamed: params?.stream === true, input: null };
    if (captureContent) { const sent = reader.input(params); if (sent !== undefined) request.input = clip(sent); }
    return request;
  } catch { return { model: undefined, streamed: false, input: null }; }
}

// Attributes for one finished call. A value the response did not carry is left out, never written as zero.
// `outcome` is {failed: true, error} for a thrown or rejected call (whatever the rejection value), {raw: true} for a
// call whose raw response was asked for, or {value}.
function describe(provider, reader, request, outcome, captureContent) {
  const attributes = { 'gen_ai.system': provider, 'gen_ai.operation.name': reader.operation };
  if (request.model) attributes['gen_ai.request.model'] = request.model;
  if (request.streamed) attributes['supatrace.streamed'] = true;
  if (outcome.raw) attributes['supatrace.raw_response'] = true;
  if (outcome.late) { attributes['supatrace.late_use'] = true; attributes['supatrace.first_use_delay_ms'] = outcome.late; }
  if (outcome.failed) {
    const error = outcome.error;
    attributes['error.type'] = text(error?.name) ?? 'Error';
    if (Number.isInteger(error?.status)) attributes['http.response.status_code'] = error.status;
  } else if (!request.streamed && !outcome.raw) {
    const seen = reader.read(outcome.value);
    if (seen.id) attributes['gen_ai.response.id'] = seen.id;
    if (seen.model) attributes['gen_ai.response.model'] = seen.model;
    if (seen.input !== undefined) attributes['gen_ai.usage.input_tokens'] = seen.input;
    if (seen.output !== undefined) attributes['gen_ai.usage.output_tokens'] = seen.output;
    if (seen.finish.length) attributes['gen_ai.response.finish_reasons'] = seen.finish;
    if (seen.status) attributes['openai.response.status'] = seen.status;
    if (captureContent && seen.content !== undefined) {
      const output = clip(seen.content);
      if (output) { attributes['supatrace.output'] = output.text; if (output.truncated) attributes['supatrace.output_truncated'] = true; }
    }
  }
  if (request.input) { attributes['supatrace.input'] = request.input.text; if (request.input.truncated) attributes['supatrace.input_truncated'] = true; }
  return attributes;
}

const unrecorded = (trace) => { trace._instrumentErrors = (trace._instrumentErrors ?? 0) + 1; };
// Writes the span the way the handle is configured: an OTLP span when otlp mode is exporting, or a two-event batch
// in the review spool in source mode (which sends nothing). A handle with neither (otlp mode with no endpoint, key or
// OpenTelemetry packages, otlp mode after close(), source mode without a spool) has nowhere to put the span: the call
// is counted as unrecorded. close() does not stop a source-mode handle: it keeps spooling. Never throws into the caller.
function record(trace, provider, reader, request, captureContent, started, outcome) {
  try {
    const ended = Date.now(), attributes = describe(provider, reader, request, outcome, captureContent);
    const name = `${reader.operation} ${attributes['gen_ai.request.model'] ?? provider}`;
    if (trace._provider && trace.tracer) {
      const span = trace.tracer.startSpan(name, { kind: 2, startTime: started, attributes });
      if (outcome.failed) span.setStatus({ code: 2 });
      span.end(ended);
      return;
    }
    if (trace.mode !== 'source' || !trace.spool) { unrecorded(trace); return; }
    const { 'supatrace.input': input, 'supatrace.output': output, ...rest } = attributes;
    const call = randomUUID().slice(0, 13), at = (ms) => new Date(ms).toISOString();
    // The trace id is `<service>.<provider>.<call>`, with the service cut so the whole id fits the 128-character limit.
    const suffix = `.${provider}.${call}`, runId = String(trace.service).slice(0, 128 - suffix.length) + suffix;
    const events = (content) => [
      { id: 'request', time: at(started), kind: 'request', name, data: { span_id: call, attributes: { 'gen_ai.system': provider, 'gen_ai.operation.name': reader.operation, ...(rest['gen_ai.request.model'] ? { 'gen_ai.request.model': rest['gen_ai.request.model'] } : {}) }, ...(content && input !== undefined ? { input } : {}) } },
      { id: outcome.failed ? 'error' : 'response', time: at(Math.max(ended, started)), kind: outcome.failed ? 'error' : 'response', name, data: { span_id: call, duration_ms: Math.max(0, ended - started), attributes: content ? rest : { ...rest, ...(input !== undefined || output !== undefined ? { 'supatrace.content_dropped': true } : {}) }, ...(content && output !== undefined ? { output } : {}) } },
    ];
    let result = trace.batch(events(true), { runId });
    // Content the batch format still refuses is dropped and said to be dropped; the call's metadata is kept.
    if (result?.report?.valid === false && (input !== undefined || output !== undefined)) result = trace.batch(events(false), { runId });
    // A span that was refused, or that the handle did not write, was not recorded: count it.
    if (result?.report?.valid !== true || !result.report.path) unrecorded(trace);
  } catch (error) {
    unrecorded(trace);
  }
}

// A first use this many milliseconds after the call returned is reported as a wait (below it is scheduling noise).
const LATE_USE_MS = 5;
const PARSED_USE = new Set(['then', 'catch', 'finally', 'withResponse']);

function traced(trace, provider, path, original, owner) {
  const reader = READERS[`${provider}:${path}`];
  return function supatraceInstrumented(...args) {
    const started = Date.now(), captureContent = trace.captureContent === true, request = snapshot(reader, args[0], captureContent);
    const done = (outcome) => record(trace, provider, reader, request, captureContent, started, outcome);
    let returned;
    try { returned = original.apply(owner, args); }
    catch (error) { done({ failed: true, error }); throw error; }
    if (!returned || typeof returned.then !== 'function') { done({ value: returned }); return returned; }
    // The recorder never touches the returned promise before the caller does. Attaching a handler first would parse a
    // provider response body (the SDKs parse once, on `.then()`) and would change Node's unhandled-rejection reporting
    // for a failure the caller has not handled yet. The caller gets a view, and the span is recorded from the caller's
    // own first use: parsed use (`await`, `.then`, `.catch`, `.finally`, `.withResponse`) records the result;
    // `.asResponse()` records without parsing. A promise that is never used records no span.
    // The span therefore ends when the result settles as seen from that first use, which includes any time the caller
    // waited before using it. That wait cannot be told from a slow provider (timing the response would need the earlier
    // handler), so it is measured and reported: a first use 5 ms or more after the call returned marks the span
    // `supatrace.late_use` with `supatrace.first_use_delay_ms`.
    let observed = false; const returnedAt = performance.now();
    const raws = typeof returned.asResponse === 'function';
    const observe = (raw) => {
      if (observed) return; observed = true;
      const delay = Math.round(performance.now() - returnedAt), late = delay >= LATE_USE_MS ? { late: delay } : {};
      try {
        if (raw) returned.asResponse().then(() => done({ raw: true, ...late }), (error) => done({ failed: true, error, ...late }));
        else returned.then((value) => done({ value, ...late }), (error) => done({ failed: true, error, ...late }));
      } catch (error) { done({ failed: true, error }); }
    };
    return new Proxy(returned, { get(promise, property) {
      const value = Reflect.get(promise, property, promise);
      if (typeof value !== 'function') return value;
      const use = raws && property === 'asResponse' ? true : PARSED_USE.has(property) ? false : null;
      if (use === null) return value.bind(promise);
      return (...args) => { const out = value.apply(promise, args); observe(use); return out; };
    } });
  };
}

// One entry per (owning object, property), valid only while that property still holds the same value.
function remember(cache, owner, property, value, make) {
  let entries = cache.get(owner); if (!entries) { entries = new Map(); cache.set(owner, entries); }
  const entry = entries.get(property);
  if (entry && entry.original === value) return entry.wrapped;
  const wrapped = make(); entries.set(property, { original: value, wrapped }); return wrapped;
}

function view(trace, provider, target, prefix, cache) {
  const paths = INSTRUMENTED[provider];
  return new Proxy(target, {
    get(object, property) {
      const value = Reflect.get(object, property, object);
      // Symbols and `constructor` are the client's own: `view.constructor` stays the client's class.
      if (typeof property !== 'string' || property === 'constructor') return value;
      // A Proxy must report a frozen (non-configurable, non-writable) property as it is. Such a property is handed
      // back untouched, so a method or namespace frozen onto the client is not traced.
      const own = Reflect.getOwnPropertyDescriptor(object, property);
      if (own && own.configurable === false && own.writable === false) return value;
      const path = prefix ? `${prefix}.${property}` : property;
      if (typeof value === 'function') {
        // Methods run against the real client, so private fields keep working. The wrapper is kept per resource
        // object and per function: the same access returns the same wrapper, and a namespace or method that the
        // client replaces later gets a wrapper bound to the new one, never to the old.
        const make = () => (paths.includes(path) ? traced(trace, provider, path, value, object) : value.bind(object));
        return remember(cache, object, property, value, make);
      }
      // Only the objects on the way to an instrumented method are wrapped; everything else is the client's own.
      if (value && typeof value === 'object' && paths.some((p) => p.startsWith(path + '.'))) {
        return remember(cache, object, property, value, () => view(trace, provider, value, path, cache));
      }
      return value;
    },
  });
}

/**
 * Returns a traced view of `client`. `provider` is detected from the client's shape unless given.
 * Throws for a client that is neither an OpenAI nor an Anthropic client: tracing nothing silently is the failure
 * that matters here. A client made from the wrapped one (for example `client.withOptions(...)`) is not traced
 * until it is wrapped itself.
 */
export function instrument(trace, client, { provider = null } = {}) {
  if (!trace || typeof trace.batch !== 'function') throw new Error('instrument() needs a trace handle from init()');
  const kind = provider ?? detectProvider(client);
  // (detectProvider reads through a view to the client's own methods, so a view is recognised like its client.)
  if (!Object.hasOwn(INSTRUMENTED, kind ?? '')) throw new Error('instrument() supports OpenAI and Anthropic clients; pass {provider: "openai" | "anthropic"} for a client it cannot recognise');
  if (!client || typeof client !== 'object') throw new Error('instrument() needs a client instance');
  if (Array.isArray(trace._instrumented) && !trace._instrumented.includes(kind)) trace._instrumented.push(kind);
  // Only the "not wrapped" note is answered by wrapping. Any other reason the provider is listed as skipped (no
  // endpoint, no key, OpenTelemetry not installed) still stands and stays on the handle.
  if (Array.isArray(trace._skipped)) trace._skipped = trace._skipped.filter((entry) => entry !== notWrapped(kind));
  // A view is never wrapped again. The same handle gets its own view back, so a call is recorded once. Another
  // handle gets a fresh view of the underlying client, so each handle records only under its own settings and one
  // handle's content opt-in never applies to calls made through another's view.
  const made = VIEWS.get(client);
  if (made && made.trace === trace) return client;
  const target = made ? made.client : client;
  const wrapped = view(trace, kind, target, '', new WeakMap());
  VIEWS.set(wrapped, { trace, client: target });
  return wrapped;
}
export const wrapOpenAI = (trace, client) => instrument(trace, client, { provider: 'openai' });
export const wrapAnthropic = (trace, client) => instrument(trace, client, { provider: 'anthropic' });
