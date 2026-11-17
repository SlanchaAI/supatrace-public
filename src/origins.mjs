// Host-aware origins. One deployment answers on every host in APP_ORIGINS.
// Cookies are __Host- (host-only), so each host keeps its own session; all hosts share one account store.
export const PRODUCTION_HOSTS = Object.freeze(['supatrace.dev', 'supatrace.tech']);
export const PRODUCTION_ORIGINS = Object.freeze(PRODUCTION_HOSTS.map(host => 'https://' + host));

// Parse a comma-separated host list (the Lambda APP_HOSTS value). Only known production hosts survive.
// The first one is the primary origin and the fallback for unknown or missing hosts.
export function parseHosts(value, fallback = ['supatrace.dev']) {
  const hosts = [];
  for (const item of String(value || '').split(',')) {
    const host = item.trim().toLowerCase();
    if (PRODUCTION_HOSTS.includes(host) && !hosts.includes(host)) hosts.push(host);
  }
  return hosts.length ? hosts : [...fallback];
}

export const allowedOrigins = env => Array.isArray(env.APP_ORIGINS) && env.APP_ORIGINS.length ? env.APP_ORIGINS : [env.APP_ORIGIN];

// The viewer host reaches the Lambda only as x-supatrace-host, which a CloudFront Function overwrites on every /api/* request.
// Anything outside the allowlist falls back to the primary host, so a spoofed value can never choose an origin.
export function viewerHost(headers, hosts) {
  const value = String(headers.get('x-supatrace-host') || '').trim().toLowerCase();
  return hosts.includes(value) ? value : hosts[0];
}

// Per-request environment: APP_ORIGIN becomes the origin the request arrived on (if allowed), and the GitHub OAuth app
// is the one registered for that origin. A host without its own GitHub app has GitHub sign-in off.
export function envForRequest(request, env) {
  const origins = allowedOrigins(env);
  const arrived = new URL(request.url).origin;
  const origin = origins.includes(arrived) ? arrived : origins[0];
  const next = {...env, APP_ORIGIN: origin};
  if (env.GITHUB_BY_ORIGIN) {
    const app = env.GITHUB_BY_ORIGIN[origin];
    next.GITHUB_CLIENT_ID = app?.id;
    next.GITHUB_CLIENT_SECRET = app?.secret;
  }
  return next;
}

export const originsAreProduction = env => allowedOrigins(env).every(origin => PRODUCTION_ORIGINS.includes(origin));
