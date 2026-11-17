// Alpha SupaTrace client. Source mode writes local batches; only explicit OTLP
// mode with an endpoint, key and optional exporter sends spans. Import sends nothing.
// The bundled batch validator matches the server and is checked for drift in tests.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { instrument as wrapClient, notWrapped } from './instrument.mjs';

const require = createRequire(import.meta.url);

// If the bundled validator is missing, `batch` reports the absence instead of pretending a
// check happened.
let parseBatch = null;
let validatorSource = null;
try {
  // Dynamic, awaited: a resolution miss must degrade to "validation unavailable" rather
  // than take the whole module down at import time.
  const trace = await import('./trace.mjs');
  if (typeof trace.parseBatch === 'function') {
    parseBatch = trace.parseBatch;
    validatorSource = 'trace.mjs (copy of the server validator)';
  }
} catch {
  validatorSource = null;
}

export const PROVIDER_PACKAGES = Object.freeze(['openai', 'anthropic', '@langchain/core', 'llamaindex']);
export const DEFAULT_INSTRUMENTS = Object.freeze(['openai', 'anthropic']);

// A bare 43-character pairing key, or a typed st_pub_ (ingest) / st_sec_ (secret) key.
const KEY_RE = /^(?:st_(?:pub|sec)_)?[A-Za-z0-9_-]{43}$/;
const PROJECT_RE = /^proj_[a-f0-9]{32}$/;
const CONTENT_ENV = 'SUPATRACE_CAPTURE_CONTENT';
const ENDPOINT_ENV = 'SUPATRACE_OTLP_ENDPOINT';
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  }
  return value;
}

// Canonical UTF-8 JSON keeps spool hashes stable across retries.
//
// Throws instead of returning bytes when the payload contains a non-finite double or an
// unsafe integer. `JSON.stringify(Infinity)` silently yields `null` and a BigInt throws, so
// without this check a logged Infinity would reach the spool as `null` — silent data loss —
// and the same logical batch would serialise differently than the same batch authored in
// other languages. Reject these at build time instead of silently rewriting them.
function unsafeNumbers(value) {
  const stack = [[value, 0]];
  while (stack.length) {
    const [node, depth] = stack.pop();
    // Matches trace.mjs depthCheck exactly: reject non-finite doubles, and integers that are
    // neither safe integers nor BigInt. Ordinary fractions like 1.5 are finite and fine.
    if (typeof node === 'number' &&
        (!Number.isFinite(node) || (Number.isInteger(node) && !Number.isSafeInteger(node)))) {
      return true;
    }
    if (typeof node === 'bigint') return true;
    if (node && typeof node === 'object') {
      if (depth > 32) return true;
      for (const child of Object.values(node)) stack.push([child, depth + 1]);
    }
  }
  return false;
}

function canonicalBytes(value) {
  if (unsafeNumbers(value)) {
    throw new Error('unsupported_number: non-finite or unsafe numeric values must be strings');
  }
  return Buffer.from(JSON.stringify(canonical(value)), 'utf8');
}

function redacted(text) {
  if (!text || text.length <= 12) return '<redacted>';
  return `${text.slice(0, 4)}…${text.slice(-4)} (len ${text.length}, redacted)`;
}

/** Split a redacted key into secret + project. Throws on a shape that cannot be read: a
 *  mistyped key silently downgrading to "no project" is how traces get misattributed. */
export function parseApiKey(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('SUPATRACE_API_KEY is empty');
  const text = value.trim();
  if (text.includes('.')) {
    const split = text.indexOf('.');
    const secret = text.slice(0, split);
    const project = text.slice(split + 1);
    if (!KEY_RE.test(secret)) {
      throw new Error(`key secret part is not ^(?:st_(?:pub|sec)_)?[A-Za-z0-9_-]{43}$ (redacted: ${redacted(text)})`);
    }
    if (!PROJECT_RE.test(project)) {
      throw new Error(`project part is not proj_[a-f0-9]{32} (redacted: ${redacted(text)})`);
    }
    return { secret, project, redacted: redacted(text), source: 'key' };
  }
  if (PROJECT_RE.test(text)) return { secret: null, project: text, redacted: redacted(text), source: 'key' };
  if (KEY_RE.test(text)) {
    // A bare secret takes its project from the environment.
    const project = process.env.SUPATRACE_PROJECT || 'default';
    return { secret: text, project, redacted: redacted(text), source: 'SUPATRACE_PROJECT' };
  }
  throw new Error(`key does not match ^(?:st_(?:pub|sec)_)?[A-Za-z0-9_-]{43}$ (redacted: ${redacted(text)})`);
}

function readEndpoint(explicit) {
  const value = explicit || process.env[ENDPOINT_ENV] || '';
  if (!value) return null;
  return value.replace(/\/$/, '');
}

function contentRequested(explicit) {
  if (typeof explicit === 'boolean') return explicit;
  const flag = process.env[CONTENT_ENV];
  if (flag === undefined) return false;
  return ['1', 'true', 'yes', 'on'].includes(String(flag).trim().toLowerCase());
}

export class SupaTrace {
  constructor(options) {
    Object.assign(this, options);
    this._batches = [];
    this._instrumented = [];
    this._skipped = [];
    this._provider = null;
    this._exporter = null;
    this._telemetryUsed = false;
  }

  /** What is actually wired, including what is *not*. Safe to print: never contains a key. */
  get capture() {
    return {
      mode: this.mode,
      endpoint: this.endpoint || null,
      sending: Boolean(this.endpoint && this._provider && this._exporter),
      project: this.project,
      instrumented: [...this._instrumented],
      // Instrumented calls whose span could not be recorded (the call itself was not affected).
      instrumentErrors: this._instrumentErrors ?? 0,
      skipped: [...this._skipped],
      captureContent: this.captureContent,
      telemetryUsed: this._telemetryUsed,
      validator: validatorSource,
      key: this._secret ? 'present' : 'absent',
    };
  }

  toString() {
    const c = this.capture;
    return `<SupaTrace service='${this.service}' mode=${c.mode} project=${c.project} `
      + `sending=${c.sending} instrumented=[${c.instrumented}] key=${c.key}>`;
  }

  /**
   * A traced view of one OpenAI or Anthropic client instance (see instrument.mjs). The client passed in is not
   * modified and nothing global is patched; use the returned client for the calls you want recorded.
   */
  instrument(client, options) {
    return wrapClient(this, client, options);
  }

  /** Old name for batch(), kept so existing callers keep working. */
  build(events, options) {
    return this.batch(events, options);
  }

  /** Build one batch and, in source mode, spool it for review. Nothing is sent. */
  batch(events, { batchId = null, runId = null, write = true, dryRun = false } = {}) {
    this._telemetryUsed = true;
    let sourceLabel = null;
    if (typeof events === 'function') {
      sourceLabel = events.name || 'callable';
      events = events();
    }
    const list = (events || []).filter((e) => e && typeof e === 'object');
    if (!list.length) {
      return { batch: null, report: { empty: true, source: sourceLabel, errors: ['empty_batch_skipped'] } };
    }
    // Content-derived IDs let identical retries reuse the same spool file.
    const body = { version: 1, run_id: runId || this.service, events: list };
    // Content check runs before identity: an unencodable value makes canonicalBytes throw, and
    // hashing first would surface it as a throw from build() in the caller's own thread.
    if (unsafeNumbers(body)) {
      return {
        batch: null,
        report: { empty: false, source: sourceLabel, valid: false, delegated: false,
          errors: ['unsupported_number: non-finite or unsafe values must be encoded as strings'],
          deduplicated: false, path: null, sha256: null },
      };
    }
    const digestForId = createHash('sha256').update(canonicalBytes(body)).digest('hex');
    const payload = { ...body, batch_id: batchId || `${this.service}-${digestForId.slice(0, 16)}` };
    if (parseBatch === null) {
      // Fail visibly. Reporting `valid: true` here would be the exact failure mode the
      // delegation comment above exists to prevent.
      return {
        batch: payload,
        report: { empty: false, source: sourceLabel, valid: false, delegated: false,
          errors: ['no_validator'], path: null, sha256: null },
      };
    }
    let report;
    try {
      const parsed = parseBatch(JSON.stringify(payload));
      report = { valid: true, errors: [], contentHash: parsed.content_hash };
    } catch (error) {
      report = { valid: false, errors: [`${error.code}: ${error.message}`], contentHash: null };
    }
    let file = null;
    let deduplicated = false;
    if (report.valid && write && this.mode === 'source' && this.spool && !dryRun) {
      // spool/<content-sha256>.json: identical retries reuse the same path.
      const bytes = canonicalBytes(payload);
      const digestForName = createHash('sha256').update(bytes).digest('hex');
      // Owner-only: spooled batches can hold prompts and outputs.
      mkdirSync(this.spool, { recursive: true, mode: 0o700 });
      file = join(this.spool, `${digestForName}.json`);
      if (existsSync(file)) {
        if (readFileSync(file).equals(bytes)) {
          deduplicated = true;
        } else {
          // Same digest, different bytes: the file is not what its name claims. Refuse rather
          // than overwrite evidence.
          throw new Error(`spool entry ${digestForName}.json does not match its digest`);
        }
      } else {
        writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
        this._batches.push([payload, file]);
      }
    }
    return {
      batch: payload,
      report: {
        empty: false,
        source: sourceLabel,
        delegated: true,
        valid: report.valid,
        errors: report.errors,
        deduplicated,
        path: file,
        sha256: report.contentHash,
      },
    };
  }

  /** One traced span. Source mode records a batch entry for review; it does not transmit. */
  span(name, attributes = {}, { kind = 'note' } = {}) {
    this._telemetryUsed = true;
    if (this._provider && this.tracer) {
      const span = this.tracer.startSpan(name, { attributes });
      span.end();
      return { recorded: 'otlp', name };
    }
    return this.batch([{
      id: `span-${this._batches.length}-${process.pid}`,
      time: new Date().toISOString(),
      kind,
      name,
      data: { ...attributes },
    }]);
  }

  flush() {
    if (!this._provider) return { flushed: false, reason: 'no provider — source mode or no endpoint' };
    return { flushed: this._provider.forceFlush ? this._provider.forceFlush() : true };
  }

  close() {
    const provider = this._provider;
    this.tracer = null;
    this._provider = null;
    this._exporter = null;
    // shutdown() flushes pending spans; it is async and close() stays sync, so the
    // promise is returned for a caller that wants to await the final export.
    const shutdown = provider && provider.shutdown ? provider.shutdown() : null;
    return { closed: true, ...(shutdown ? { shutdown } : {}) };
  }
}

/** One-line init. `init()` and `init('checkout', {...})` both work.
 *  No client is imported and no socket is opened unless mode === 'otlp' is requested. */
export function init(component = null, config = null) {
  let options = { ...(config || {}) };
  if (component && typeof component === 'object') {
    options = { ...component };
    component = null;
  }

  const service = component || options.service || process.env.SUPATRACE_SERVICE || 'supatrace';
  let endpoint = null;
  try {
    endpoint = readEndpoint(options.endpoint);
  } catch {
    endpoint = null;
  }
  // Export is opt-in: an endpoint in the environment alone never turns on a sender.
  const mode = options.mode || 'source';
  if (!['source', 'otlp'].includes(mode)) {
    throw new Error(`unknown mode '${mode}'; use "source" or "otlp"`);
  }

  const rawKey = options.apiKey || process.env.SUPATRACE_API_KEY || '';
  let parsed = null;
  let keyError = null;
  if (rawKey) {
    try {
      parsed = parseApiKey(rawKey);
    } catch (error) {
      keyError = error.message;
      parsed = { secret: null, project: options.project || 'default', redacted: redacted(rawKey) };
    }
  }

  const trace = new SupaTrace({
    service,
    mode,
    endpoint,
    project: options.project || (parsed && parsed.project) || process.env.SUPATRACE_PROJECT || 'default',
    environment: options.environment || 'default',
    // Source mode spools to ~/.supatrace/pending.
    spool: options.spool || process.env.SUPATRACE_SPOOL
      || (mode === 'source' ? join(homedir(), '.supatrace', 'pending') : null),
    captureContent: contentRequested(options.captureContent),
    _secret: parsed ? parsed.secret : null,
  });
  trace.keyError = keyError;
  trace.keySummary = parsed ? parsed.redacted : 'absent';

  if (mode === 'otlp') attachTelemetry(trace, options);
  return trace;
}

function attachTelemetry(trace, options) {
  // Only reached when mode === 'otlp'. Optional deps are resolved lazily and a miss is
  // recorded on the handle rather than thrown, so an app without OTel still boots, with
  // tracing simply inactive and `capture.skipped` saying so.
  const instruments = options.instruments || DEFAULT_INSTRUMENTS;
  if (!trace.endpoint) {
    trace._skipped = instruments.map((n) => `${n}: no ${ENDPOINT_ENV}; nothing to export to`);
    return;
  }
  if (!trace._secret) {
    trace._skipped = instruments.map((n) => `${n}: no SUPATRACE_API_KEY secret; refusing to export unauthenticated`);
    return;
  }
  let sdk = null;
  let otlp = null;
  try {
    sdk = require('@opentelemetry/sdk-trace-base');
    otlp = require('@opentelemetry/exporter-trace-otlp-http');
  } catch {
    trace._skipped = instruments.map(
      (n) => `${n}: @opentelemetry/sdk-trace-base or @opentelemetry/exporter-trace-otlp-http is not installed`);
    return;
  }
  // Authenticate the OTLP request with the supplied ingest key.
  const exporter = new otlp.OTLPTraceExporter({
    url: `${trace.endpoint}/v1/traces`,
    headers: { Authorization: `Bearer ${trace._secret}`, 'X-Supatrace-Key': trace._secret },
  });
  const processor = new sdk.BatchSpanProcessor(exporter);
  const config = {};
  try {
    const resources = require('@opentelemetry/resources');
    const attributes = { 'service.name': trace.service, 'supatrace.project': trace.project,
      'supatrace.mode': 'otlp' };
    if (typeof resources.resourceFromAttributes === 'function') {
      config.resource = resources.resourceFromAttributes(attributes);
    } else if (typeof resources.Resource === 'function') {
      config.resource = new resources.Resource(attributes);
    }
  } catch {
    // Resource attributes are a label, not a precondition for export.
  }
  // sdk-trace-base 2.x takes processors in the constructor; 1.x adds them afterwards.
  let provider;
  if (typeof sdk.BasicTracerProvider.prototype.addSpanProcessor === 'function') {
    provider = new sdk.BasicTracerProvider(config);
    provider.addSpanProcessor(processor);
  } else {
    provider = new sdk.BasicTracerProvider({ ...config, spanProcessors: [processor] });
  }
  trace._provider = provider;
  trace._exporter = exporter;
  trace.tracer = provider.getTracer('supatrace', '0.1.0');
  // Nothing is traced until a client is wrapped: there is no global patching to do it implicitly.
  trace._skipped = instruments.map((n) => notWrapped(n));
}

export { instrument, wrapOpenAI, wrapAnthropic, detectProvider, INSTRUMENTED } from './instrument.mjs';

export default { init, parseApiKey, SupaTrace };
