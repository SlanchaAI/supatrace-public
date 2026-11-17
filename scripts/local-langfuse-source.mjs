// Local Langfuse source adapter for issue #67: with SUPATRACE_LOCAL_LANGFUSE_URL set,
// requests are forwarded to a loopback Langfuse server (http://127.0.0.1:*, http://localhost:*,
// or http://[::1]:*) instead of the synthetic fixture. The cloud origin stays in the spec; only the
// wire transport changes. The response.url is set to the requested (cloud) URL so the transport
// accepts it. In both modes, requests must use the spec's cloud origin, include no cookie header,
// and observe the spec's traceId and path allowlist.

export function createLocalSourceFetch({spec, rows, env = process.env, fetchImpl = (...a) => globalThis.fetch(...a), count = () => {}}) {
  const localUrl = env.SUPATRACE_LOCAL_LANGFUSE_URL;
  const useLocal = localUrl && localUrl !== '';
  
  if (useLocal) {
    // Validate that the local URL is an http loopback
    let localBase;
    try {
      localBase = new URL(localUrl);
    } catch {
      throw new Error('SUPATRACE_LOCAL_LANGFUSE_URL must be a valid URL');
    }
    
    if (localBase.username || localBase.password) {
      throw new Error('SUPATRACE_LOCAL_LANGFUSE_URL must not include userinfo');
    }
    
    if (localBase.protocol !== 'http:') {
      throw new Error('SUPATRACE_LOCAL_LANGFUSE_URL must use http: protocol');
    }
    
    const host = localBase.hostname;
    // Note: URL() keeps brackets for IPv6 addresses
    const validHosts = ['127.0.0.1', 'localhost', '[::1]'];
    if (!validHosts.includes(host)) {
      throw new Error('SUPATRACE_LOCAL_LANGFUSE_URL must be localhost, 127.0.0.1, or [::1]');
    }
  }
  
  return async (url, init = {}) => {
    // Validate request: no cookies
    const headers = new Headers(init.headers);
    if (headers.has('cookie') || headers.has('Cookie')) {
      throw new Error('Cookie header not allowed in source requests');
    }
    
    // Validate URL: must match spec origin
    const requestUrl = new URL(url);
    if (requestUrl.origin !== spec.origin) {
      throw new Error('Request origin must match spec origin');
    }
    
    // Validate path: only /api/public/projects and /api/public/v2/observations allowed
    const allowedPaths = ['/api/public/projects', '/api/public/v2/observations'];
    if (!allowedPaths.includes(requestUrl.pathname)) {
      throw new Error('Request path not allowed');
    }
    
    // For observations path, validate traceId
    if (requestUrl.pathname === '/api/public/v2/observations') {
      const traceId = requestUrl.searchParams.get('traceId');
      if (traceId !== spec.traceId) {
        throw new Error('Request traceId must match spec traceId');
      }
    }
    
    count();
    
    if (useLocal) {
      // Forward to local server
      const localBase = new URL(localUrl);
      const localRequestUrl = new URL(requestUrl.pathname + requestUrl.search, localBase);
      
      const response = await fetchImpl(localRequestUrl.toString(), {...init, redirect: 'error'});
      
      // Set response.url to the cloud URL as expected by the transport
      Object.defineProperty(response, 'url', {
        value: url,
        configurable: true
      });
      
      return response;
    } else {
      // Synthetic mode: serve fixture directly
      let body;
      if (requestUrl.pathname === '/api/public/projects') {
        body = {
          data: [{id: spec.sourceProject}]
        };
      } else if (requestUrl.pathname === '/api/public/v2/observations') {
        body = {
          data: rows,
          meta: {cursor: null}
        };
      }
      
      const response = new Response(JSON.stringify(body), {
        status: 200,
        headers: {'content-type': 'application/json'}
      });
      
      // Set response.url to the requested URL
      Object.defineProperty(response, 'url', {
        value: url,
        configurable: true
      });
      
      return response;
    }
  };
}
