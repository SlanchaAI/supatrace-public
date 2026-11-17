import {planBraintrustCapture, validCursor} from './braintrust-capture.mjs';
import {braintrustQuery} from './vendor/kitaru/braintrust-query.mjs';
import {hash} from './langfuse.mjs';

class BraintrustTransportError extends Error {}
const fail = code => { throw new BraintrustTransportError(code); };
export const BRAINTRUST_TRANSPORT_BOUNDS = Object.freeze({requestTimeoutMs: 30000, totalTimeoutMs: 300000, maxRequests: 300, maxResponseBytes: 2 * 1024 * 1024, maxTotalBytes: 16 * 1024 * 1024});
function checkedBounds(bounds) {
  if (!bounds || Object.keys(bounds).sort().join() !== Object.keys(BRAINTRUST_TRANSPORT_BOUNDS).sort().join()) fail('braintrust_explicit_transport_bounds_required');
  for (const [key, max] of Object.entries(BRAINTRUST_TRANSPORT_BOUNDS)) if (!Number.isInteger(bounds[key]) || bounds[key] <= 0 || bounds[key] > max) fail('braintrust_invalid_transport_bounds');
  if (bounds.requestTimeoutMs > bounds.totalTimeoutMs || bounds.maxResponseBytes > bounds.maxTotalBytes) fail('braintrust_invalid_transport_bounds');
  return {...bounds};
}

// Explicit injected dependencies. No environment secrets, discovery, implicit network,
// host override, redirect following or query text supplied by the caller.
export function createBraintrustTransport(spec, {fetchImpl, credentialProvider, authorize, bounds, now = Date.now, monotonic = () => performance.now()} = {}) {
  const plan = planBraintrustCapture(spec), b = checkedBounds(bounds), {scope} = plan;
  if ([fetchImpl, credentialProvider, authorize].some(fn => typeof fn !== 'function')) fail('braintrust_runtime_hooks_required');
  if (fetchImpl === globalThis.fetch && process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') fail('braintrust_tls_validation_disabled');
  const deadline = monotonic() + b.totalTimeoutMs;
  let closed = false, busy = false, requests = 0, totalBytes = 0;
  const controllers = new Set();
  function remaining(signal) {
    if (closed || signal?.aborted) fail('braintrust_cancelled');
    const left = deadline - monotonic();
    if (!Number.isFinite(left) || left <= 0) fail('braintrust_total_deadline_exceeded');
    return left;
  }
  async function bounded(fn, signal, ms = b.requestTimeoutMs) {
    const controller = new AbortController(); controllers.add(controller);
    let timer, abort;
    const cancel = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new BraintrustTransportError('braintrust_cancelled')), {once: true});
      abort = () => controller.abort();
      signal?.addEventListener('abort', abort, {once: true});
      // A wait cut short by the total deadline, not by its own limit, is the total deadline running out. Callers that
      // set the total budget to something of their own (a job's remaining lifetime) tell the two apart by this code.
      const left = remaining(signal);
      timer = setTimeout(() => { reject(new BraintrustTransportError(left <= ms ? 'braintrust_total_deadline_exceeded' : 'braintrust_operation_timeout')); controller.abort(); }, Math.min(ms, left));
    });
    try { return await Promise.race([Promise.resolve().then(() => { remaining(signal); return fn(controller.signal); }), cancel]); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); controllers.delete(controller); }
  }
  async function permission(action, requestHash, signal) {
    const descriptor = {action, fingerprint: plan.fingerprint, origin: scope.origin, sourceProject: scope.sourceProject, destinationProject: scope.destinationProject, rootSpanIds: [...scope.rootSpanIds], content: scope.content, requestHash, bounds: {...b}};
    let allowed;
    try { allowed = await bounded(() => authorize(descriptor), signal); }
    catch (e) { if (e instanceof BraintrustTransportError) throw e; fail('braintrust_authorization_unavailable'); }
    if (allowed !== true) fail('braintrust_action_not_authorized');
  }
  async function wire(path, body, credentials, signal) {
    remaining(signal);
    if (requests >= b.maxRequests || totalBytes >= b.maxTotalBytes) fail('braintrust_transport_budget_exceeded');
    if (credentials.expiresAt <= now()) fail('braintrust_credential_expired');
    const url = scope.origin + path, authorization = 'Bearer ' + credentials.apiKey;
    const secretIn = value => JSON.stringify(value).includes(credentials.apiKey);
    if (secretIn({scope, body})) fail('braintrust_credential_in_scope_rejected');
    requests++;
    try {
      const result = await bounded(async abortSignal => {
        let response;
        try { response = await fetchImpl(url, {method: body ? 'POST' : 'GET', headers: {Authorization: authorization, Accept: 'application/json', ...(body ? {'Content-Type': 'application/json'} : {})}, ...(body ? {body: JSON.stringify(body)} : {}), redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: abortSignal}); }
        catch { fail('braintrust_transport_failed'); }
        if (abortSignal.aborted) fail('braintrust_cancelled');
        if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599 || response.redirected || response.url && response.url !== url) fail('braintrust_response_target_refused');
        if (response.status >= 300 && response.status < 400) fail('braintrust_redirect_refused');
        const cursor = response.headers?.get?.('x-bt-cursor') ?? null, retryAfter = response.headers?.get?.('retry-after') ?? null;
        if (secretIn({cursor, retryAfter})) fail('braintrust_credential_echo_rejected');
        if (response.status !== 200) {
          try { await response.body?.cancel(); } catch { /* Never expose an upstream error body. */ }
          if (retryAfter !== null && (typeof retryAfter !== 'string' || retryAfter.length > 128)) fail('braintrust_retry_header_invalid');
          return {status: response.status, retryAfter};
        }
        if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:;|$)/i.test(response.headers?.get?.('content-type') ?? '')) fail('braintrust_json_required');
        const length = response.headers?.get?.('content-length');
        if (length != null && (!/^\d+$/.test(length) || Number(length) > Math.min(b.maxResponseBytes, b.maxTotalBytes - totalBytes))) fail('braintrust_response_bound_exceeded');
        if (!response.body?.getReader) fail('braintrust_stream_reader_required');
        const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', {fatal: true});
        let text = '', bytes = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (abortSignal.aborted) fail('braintrust_cancelled');
            if (part.done) break;
            if (!(part.value instanceof Uint8Array)) fail('braintrust_invalid_stream');
            bytes += part.value.byteLength; totalBytes += part.value.byteLength;
            if (bytes > b.maxResponseBytes || totalBytes > b.maxTotalBytes) fail('braintrust_response_bound_exceeded');
            try { text += decoder.decode(part.value, {stream: true}); } catch { fail('braintrust_invalid_utf8'); }
          }
          try { text += decoder.decode(); } catch { fail('braintrust_invalid_utf8'); }
        } finally { try { void reader.cancel()?.catch(() => {}); } catch {} try { reader.releaseLock(); } catch {} }
        let data; try { data = JSON.parse(text); } catch { fail('braintrust_invalid_json'); }
        if (secretIn(data)) fail('braintrust_credential_echo_rejected');
        return {status: 200, data, cursor};
      }, signal, Math.min(b.requestTimeoutMs, credentials.expiresAt - now()));
      if (credentials.expiresAt <= now()) fail('braintrust_credential_expired');
      return result;
    } catch (e) {
      // All public errors are fixed codes, never raw fetch/provider exceptions.
      if (e instanceof BraintrustTransportError) throw e;
      fail('braintrust_transport_failed');
    }
  }
  return Object.freeze({
    async request(cursor, signal) {
      if (!validCursor(cursor)) fail('braintrust_cursor_invalid');
      if (busy) fail('braintrust_concurrent_request_refused');
      busy = true; let credentials;
      try {
        const body = braintrustQuery(scope, cursor);
        await permission('verify-source-project', hash('/v1/project/' + scope.sourceProject), signal);
        try { credentials = await bounded(() => credentialProvider({origin: scope.origin, projectId: scope.sourceProject}), signal); }
        catch (e) { if (e instanceof BraintrustTransportError) throw e; fail('braintrust_credential_unavailable'); }
        if (!credentials || credentials.origin !== scope.origin || credentials.projectId !== scope.sourceProject || typeof credentials.apiKey !== 'string' || !/^[A-Za-z0-9_.-]{16,512}$/.test(credentials.apiKey) || !Number.isFinite(credentials.expiresAt) || credentials.expiresAt <= now() || credentials.expiresAt > now() + 300000) fail('braintrust_credential_binding_or_lease_invalid');
        credentials = {...credentials};
        const project = await wire('/v1/project/' + scope.sourceProject, null, credentials, signal);
        if (project.status !== 200) return project;
        if (project.data?.id !== scope.sourceProject) fail('braintrust_verified_project_mismatch');
        await permission('read-trace-page', hash(body), signal);
        return await wire('/btql', body, credentials, signal);
      } finally { credentials = undefined; busy = false; }
    },
    async authorizeStage(conversionHash, signal) { await permission('stage-destination', conversionHash, signal); },
    async checkpoint(state, save, signal) {
      // The private runtime's writer performs its atomic write synchronously and
      // checks this signal first. Other callers must honor cancellation before I/O.
      try { await bounded(abortSignal => save(state, {signal: abortSignal}), signal); }
      catch (e) { if (e instanceof BraintrustTransportError) throw e; fail('braintrust_checkpoint_failed'); }
    },
    async wait(ms, signal) {
      if (!Number.isFinite(ms) || ms < 0 || ms >= remaining(signal)) fail('braintrust_retry_deadline_exceeded');
      await bounded(abortSignal => new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        abortSignal.addEventListener('abort', () => { clearTimeout(timer); reject(Error('braintrust_cancelled')); }, {once: true});
      }), signal, ms + 100);
    },
    status: () => ({requests, totalBytes, closed}),
    close() { closed = true; for (const controller of controllers) controller.abort(); },
  });
}
