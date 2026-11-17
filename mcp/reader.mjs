import {createHash} from 'node:crypto';
import {loadAccountRuns, queryAccountRuns} from '../public/app/run-data.js';
import {validateEventPage} from '../public/app/event-data.js';

const fail = code => {throw Error(code);};
const object = v => v && Object.getPrototypeOf(v) === Object.prototype;
const id = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const origins = ['https://supatrace.dev', 'https://supatrace.tech'];
export function validateScope(spec) {
  if (!object(spec) || Object.keys(spec).some(k => !['origin', 'tenantId', 'projectId', 'content', 'runIds'].includes(k)) ||
      !origins.includes(spec.origin) || !id(spec.tenantId) || !/^proj_[a-f0-9]{32}$/.test(spec.projectId ?? '') ||
      !['metadata', 'include'].includes(spec.content)) fail('invalid_scope');
  if (spec.runIds !== undefined && (!Array.isArray(spec.runIds) || !spec.runIds.length || spec.runIds.length > 100 || spec.runIds.some(v => !id(v)) || new Set(spec.runIds).size !== spec.runIds.length)) fail('invalid_scope');
  return Object.freeze({...spec, ...(spec.runIds ? {runIds: Object.freeze([...spec.runIds])} : {})});
}
function abortable(work, signal) {
  if (signal.aborted) fail('cancelled');
  return new Promise((resolve, reject) => {
    const abort = () => {signal.removeEventListener('abort', abort); reject(Error('cancelled'));};
    signal.addEventListener('abort', abort, {once: true});
    Promise.resolve().then(() => {if (signal.aborted) fail('cancelled'); return work();}).then(
      value => {signal.removeEventListener('abort', abort); resolve(value);},
      error => {signal.removeEventListener('abort', abort); reject(error);});
  });
}
const safeCodes = new Set(['invalid_scope', 'invalid_arguments', 'read_access_unavailable', 'scope_mismatch', 'content_not_authorized', 'trace_not_available', 'limit_exceeded', 'rate_limited', 'cancelled', 'deadline', 'reader_busy', 'reader_closed', 'source_unavailable', 'invalid_source_data', 'credential_echo']);
export function safeError(error) {return safeCodes.has(error?.message) ? error.message : 'source_unavailable';}

// Existing approved session only. No credential discovery/refresh, new read key,
// mutation route, persistent cache, browser-cookie access or outbound file write.
export function createTraceReader(spec, {credentialProvider, authorize, fetchImpl = globalThis.fetch, timeoutMs = 30000, lifecycleSignal} = {}) {
  const scope = validateScope(spec);
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') fail('read_access_unavailable');
  if (typeof credentialProvider !== 'function' || typeof authorize !== 'function' || typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) fail('invalid_scope');
  let active = null, closed = false, totalRequests = 0;
  async function execute(tool, args = {}, signal) {
    if (closed) fail('reader_closed');
    if (active) fail('reader_busy');
    const controller = new AbortController(); active = controller;
    const relay = () => controller.abort(); lifecycleSignal?.addEventListener('abort', relay, {once: true}); signal?.addEventListener('abort', relay, {once: true});
    if (signal?.aborted || lifecycleSignal?.aborted) controller.abort();
    let expired = false, requests = 0, wireBytes = 0;
    const timer = setTimeout(() => {expired = true; controller.abort();}, timeoutMs);
    const s = controller.signal;
    try {
      if (!object(args)) fail('invalid_arguments');
      args = Object.freeze({...args});
      const list = tool === 'supatrace_list_traces' || tool === 'supatrace_search_traces';
      if (!list && !['supatrace_inspect_trace', 'supatrace_export_trace'].includes(tool)) fail('invalid_arguments');
      const allowed = list ? ['query', 'limit', 'offset'] : ['runId', 'includeContent'];
      if (Object.keys(args).some(k => !allowed.includes(k))) fail('invalid_arguments');
      if (list && (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 128 || /[^\w.:-]/.test(args.query)) || args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100) || args.offset !== undefined && (!Number.isInteger(args.offset) || args.offset < 0 || args.offset > 5000))) fail('invalid_arguments');
      if (!list && (!id(args.runId) || args.includeContent !== undefined && typeof args.includeContent !== 'boolean')) fail('invalid_arguments');
      if (!list && scope.runIds && !scope.runIds.includes(args.runId)) fail('trace_not_available');
      if (args.includeContent && scope.content !== 'include') fail('content_not_authorized');
      const descriptor = Object.freeze({tool, scope, arguments: Object.freeze({...args})});
      if (await abortable(() => authorize(descriptor, s), s) !== true) fail('read_access_unavailable');
      const suppliedLease = await abortable(() => credentialProvider(descriptor, s), s);
      const lease = object(suppliedLease) ? Object.freeze({...suppliedLease}) : suppliedLease;
      const delegated = lease?.type === 'delegated_read';
      const credential = delegated ? lease.readToken : lease?.sessionToken;
      const checkLease = () => {
        if (!object(lease) || Object.keys(lease).some(k => !(delegated ? ['type','origin','tenantId','projectId','readToken','expiresAt'] : ['origin','tenantId','projectId','sessionToken','expiresAt']).includes(k)) || lease.origin !== scope.origin || lease.tenantId !== scope.tenantId || lease.projectId !== scope.projectId || !/^[A-Za-z0-9_-]{43}$/.test(credential ?? '') || !Number.isSafeInteger(lease.expiresAt) || lease.expiresAt <= Date.now() || lease.expiresAt > Date.now() + 300000) fail('read_access_unavailable');
      };
      checkLease();
      async function request(path, requestSignal = s) {
        if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') fail('read_access_unavailable');
        checkLease();
        if (++requests > 100 || ++totalRequests > 1000) fail('limit_exceeded');
        if (!/^(me|runs\/page(?:\?after=[A-Za-z0-9_-]{1,2048})?|events\?run=[A-Za-z0-9_.:%-]{1,400}(?:&after=[A-Za-z0-9_-]{1,2048})?)$/.test(path)) fail('invalid_arguments');
        const url = new URL((delegated ? '/api/mcp/read/' : '/api/') + path, scope.origin); url.searchParams.set('project', scope.projectId);
        if (delegated && path.startsWith('events?')) url.searchParams.set('content', args.includeContent ? 'include' : 'metadata');
        const merged = AbortSignal.any([s, requestSignal]);
        return abortable(async () => {
          const response = await fetchImpl(url.href, {method: 'GET', headers: {accept: 'application/json', cookie: (delegated ? '__Host-supatrace-mcp=' : '__Host-supatrace=') + credential}, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: merged});
          if (response.redirected || response.url && response.url !== url.href) fail('source_unavailable');
          if (response.status !== 200) {
            void response.body?.cancel().catch(() => {});
            fail(response.status === 429 ? 'rate_limited' : [401, 403].includes(response.status) ? 'read_access_unavailable' : 'source_unavailable');
          }
          if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {void response.body?.cancel().catch(() => {}); fail('invalid_source_data');}
          const length = response.headers.get('content-length');
          if (length !== null && (!/^\d+$/.test(length) || Number(length) > 1048576)) {void response.body?.cancel().catch(() => {}); fail('limit_exceeded');}
          const reader = response.body?.getReader(); if (!reader) fail('invalid_source_data');
          let bytes = 0; const chunks = [];
          const cancel = () => {void reader.cancel().catch(() => {});}; merged.addEventListener('abort', cancel, {once: true});
          try {
            while (true) {
              const next = await abortable(() => reader.read(), merged); if (next.done) break;
              bytes += next.value.byteLength; wireBytes += next.value.byteLength;
              if (bytes > 1048576 || wireBytes > 8 * 1048576) fail('limit_exceeded');
              chunks.push(next.value);
            }
            const raw = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks));
            if (raw.includes(credential)) fail('credential_echo');
            const data = JSON.parse(raw);
            if (JSON.stringify(data).includes(credential)) fail('credential_echo');
            checkLease(); return data;
          } finally {merged.removeEventListener('abort', cancel); cancel();}
        }, merged);
      }
      const me = await request('me');
      if (me?.tenant_id !== scope.tenantId || me?.project_id !== scope.projectId) fail('scope_mismatch');
      const catalog = await loadAccountRuns(request, {projectId: scope.projectId, signal: s, maxRuns: 5000, maxBytes: 4 * 1048576, totalTimeoutMs: timeoutMs});
      const scoped = scope.runIds ? catalog.filter(r => scope.runIds.includes(r.id)) : catalog;
      if (list) {
        const result = queryAccountRuns(scoped, new URLSearchParams({q: args.query ?? '', limit: String(args.limit ?? 25), offset: String(args.offset ?? 0)}));
        result.runs = result.runs.map(row => Object.fromEntries(['id', 'created_at', 'started_at', 'ended_at', 'duration_ms', 'event_count', 'batch_count', 'byte_count', 'agents', 'status'].map(key => [key, row[key]])));
        return {project_id: scope.projectId, content: 'metadata', observed_read: true, ...result};
      }
      const run = scoped.find(r => r.id === args.runId); if (!run) fail('trace_not_available');
      if (run.event_count === null || run.batch_count === null || run.event_count > 1000 || run.batch_count > 100) fail('limit_exceeded');
      const events = [], cursors = new Set(); let after = null, pages = 0, batches = 0, dataBytes = 0;
      do {
        if (++pages > 100) fail('limit_exceeded');
        const page = validateEventPage(await request('events?run=' + encodeURIComponent(args.runId) + (after ? '&after=' + encodeURIComponent(after) : '')));
        if (page.events.length) batches++;
        if (page.next !== null && cursors.has(page.next)) fail('invalid_source_data');
        if (page.next !== null) cursors.add(page.next);
        for (const event of page.events) {
          const value = args.includeContent ? event : {id: event.id, time: event.time, kind: event.kind};
          dataBytes += Buffer.byteLength(JSON.stringify(value));
          if (events.length >= 1000 || dataBytes > 262144) fail('limit_exceeded'); events.push(value);
        }
        after = page.next;
      } while (after);
      if (events.length !== run.event_count || batches !== run.batch_count) fail('invalid_source_data');
      // Reconcile catalog counts/revisions before returning; this is not a snapshot.
      const current = await loadAccountRuns(request, {projectId: scope.projectId, signal: s, maxRuns: 5000, maxBytes: 4 * 1048576, totalTimeoutMs: timeoutMs});
      if (JSON.stringify(current.find(r => r.id === args.runId)) !== JSON.stringify(run)) fail('invalid_source_data');
      checkLease();
      const original = args.includeContent === true;
      const trace = original ? {version: 1, run_id: args.runId, events} : {format: 'supatrace-metadata-v1', run_id: args.runId, events};
      if (tool === 'supatrace_export_trace') {
        const json = JSON.stringify(trace);
        return {project_id: scope.projectId, complete: true, observed_read: true, content: original ? 'original' : 'metadata', filename: original ? 'supatrace-run.json' : 'supatrace-run-metadata.json', media_type: 'application/json', sha256: createHash('sha256').update(json).digest('hex'), bytes: Buffer.byteLength(json), json};
      }
      return {project_id: scope.projectId, complete: true, observed_read: true, content: original ? 'original' : 'metadata', trace};
    } catch (error) {if (expired) fail('deadline'); if (s.aborted) fail('cancelled'); fail(safeError(error));}
    finally {clearTimeout(timer); signal?.removeEventListener('abort', relay); lifecycleSignal?.removeEventListener('abort', relay); if (active === controller) active = null;}
  }
  return {scope, execute, close() {closed = true; active?.abort();}};
}
