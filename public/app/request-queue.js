// A quiet retry when the service was momentarily busy.
//
// The production function runs one request at a time. A second request that arrives while one is running is refused by
// the function URL itself, before the application runs: HTTP 429 with the header
// `x-amzn-errortype: TooManyRequestsException` (seen on supatrace.dev, 2026-11-15). The dashboard makes several reads
// at once when it opens (by design: a reachability probe runs beside the account reads), so it refused its own
// requests and showed "request limit" on the sign-in screen (#219).
//
// This module wraps the page's fetch for same-origin /api/ requests. Requests still leave together. The throttle
// answer, and only that, is retried with a growing, randomised pause, so requests that collided take turns. The
// application never ran for a throttled request, so repeating it cannot apply anything twice. Every 429 the application
// itself sends (rate limit, plan allowance) lacks that header and goes straight to the page.
// Other people's requests can still take the slot; the retries cover short overlaps (#189 is the real fix).
// Twelve retries with these pauses let fourteen requests that leave together all get their turn on one slot: a
// simulation of that case (150 ms per request, 4,000 page loads) had no failed request and finished in about 3.5 s.
// With six retries more than half of such page loads lost a request.
export const RETRIES = 12;
/** True for the function URL's own throttle answer, which is produced before the application runs. */
export const throttled = response => response.status === 429 && /TooManyRequests/i.test(response.headers.get('x-amzn-errortype') ?? '');
/** Pause before retry number `tries` (0-based): 80 ms more each time up to 400 ms, plus up to 500 ms of jitter so colliding requests spread out. */
export const retryPause = (tries, random = Math.random) => Math.min(400, 80 * (tries + 1)) + random() * 500;
const aborted = signal => { const error = new Error('The request was aborted.'); error.name = 'AbortError'; return signal?.reason instanceof Error ? signal.reason : error; };
/** Resolves after `ms`, or rejects at once when the signal aborts. */
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(aborted(signal));
    const stop = () => reject(aborted(signal)); signal?.addEventListener('abort', stop, {once: true});
    setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
  });
}
/** Wraps a fetch function. `origin` is the page origin; `wait` and `random` are injectable for tests. */
export function retryingFetch(original, origin, {wait = pause, random = Math.random} = {}) {
  const address = input => typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const own = input => { try { const url = new URL(address(input), origin); return url.origin === origin && url.pathname.startsWith('/api/'); } catch { return false; } };
  return async (input, init) => {
    if (!own(input)) return original(input, init);
    const request = typeof input === 'object' && !(input instanceof URL), signal = init?.signal ?? (request ? input.signal : undefined);
    for (let tries = 0; ; tries++) {
      // A Request object can be read once, so each attempt sends its own copy.
      const response = await original(request ? input.clone() : input, init);
      if (!throttled(response) || tries === RETRIES) return response;
      try { await response.body?.cancel(); } catch { /* the body is not needed */ }
      // An abort during the pause rejects like an aborted fetch does; the caller never gets the throttle answer for a request it gave up on.
      await wait(retryPause(tries, random), signal);
      if (signal?.aborted) throw aborted(signal);
    }
  };
}
/** Installs the retry on a page once. Safe to load from every module that makes API requests. */
export function installRequestRetry(target = globalThis.window) {
  if (!target || typeof target.fetch !== 'function' || target.fetch.supatraceRetry) return false;
  const wrapped = retryingFetch(target.fetch.bind(target), target.location.origin);
  wrapped.supatraceRetry = true; target.fetch = wrapped; return true;
}
installRequestRetry();
