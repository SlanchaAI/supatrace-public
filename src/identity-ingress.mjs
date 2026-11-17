// SAML form posts and SCIM clients cannot compute Lambda URL OAC body hashes.
// These identity-only routes reuse the distribution's guarded HTTP API origin.
import {createHash, timingSafeEqual} from 'node:crypto';
import {isIP} from 'node:net';
import {HttpError} from './http.mjs';

export const IDENTITY_ROUTES = Object.freeze(['POST /api/auth/sso/callback', 'GET /api/scim/v2', 'ANY /api/scim/v2/{proxy+}']);
const fail = (status, code) => { const error = new HttpError(status, code); error.edgeIngress = true; throw error; };
const hash = value => createHash('sha256').update(value).digest();
const base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
export const isIdentityIngress = event => IDENTITY_ROUTES.includes(event?.routeKey);

export function identityIngressRequest(event, {apiId, region, edgeToken, origins = ['https://supatrace.dev']} = {}) {
  if (!/^[a-z0-9]{1,40}$/.test(apiId || '') || !/^[-a-z0-9]{1,32}$/.test(region || '') ||
    !/^[A-Za-z0-9]{32,128}$/.test(edgeToken || '') || !Array.isArray(origins) || !origins.length ||
    origins.some(origin => !['https://supatrace.dev', 'https://supatrace.tech'].includes(origin))) fail(503, 'identity_ingress_disabled');
  const context = event?.requestContext, route = event?.routeKey, method = context?.http?.method, path = event?.rawPath;
  if (event?.version !== '2.0' || !IDENTITY_ROUTES.includes(route) || context?.routeKey !== route || context.apiId !== apiId ||
    context.stage !== '$default' || context.domainName !== `${apiId}.execute-api.${region}.amazonaws.com` || context.http.path !== path) fail(403, 'identity_ingress_scope_mismatch');
  const callback = route === IDENTITY_ROUTES[0];
  if (callback ? method !== 'POST' || path !== '/api/auth/sso/callback' :
    route === IDENTITY_ROUTES[1] ? method !== 'GET' || path !== '/api/scim/v2' :
      !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ||
      !/^\/api\/scim\/v2\/(?:ServiceProviderConfig|Users(?:\/[A-Za-z0-9_-]{1,128})?)$/.test(path || '')) fail(403, 'identity_ingress_scope_mismatch');
  const query = event.rawQueryString;
  if (typeof query !== 'string' || query.length > 8192 || /[\r\n#]/.test(query) || callback && query) fail(400, 'invalid_ingress_query');
  const headers = new Headers(), seen = new Set();
  let presented = '', viewerIp = '', host = '', rawCookie = '';
  for (const [name, value] of Object.entries(event.headers || {})) {
    const key = name.toLowerCase();
    if (seen.has(key) || typeof value !== 'string' || value.length > 8192 || /[\r\n]/.test(value)) fail(400, 'invalid_ingress_header');
    seen.add(key);
    if (key === 'x-supatrace-edge') presented = value;
    else if (key === 'x-supatrace-viewer-ip') viewerIp = value;
    else if (key === 'x-supatrace-host') host = value;
    else if (key === 'cookie') rawCookie = value;
    else if (['content-type', 'accept'].includes(key) || !callback && ['authorization', 'x-supatrace-key'].includes(key)) headers.set(key, value);
  }
  if (!presented || !timingSafeEqual(hash(presented), hash(edgeToken))) fail(403, 'identity_ingress_forbidden');
  if (!isIP(viewerIp)) fail(400, 'invalid_ingress_source_ip');
  const origin = 'https://' + host;
  if (!origins.includes(origin)) fail(403, 'identity_ingress_host_mismatch');
  if (callback) {
    if (event.cookies !== undefined && (!Array.isArray(event.cookies) || event.cookies.length > 32 ||
      event.cookies.some(value => typeof value !== 'string' || value.length > 8192 || /[\r\n]/.test(value)))) fail(400, 'invalid_ingress_cookie');
    const cookies = (event.cookies?.length ? event.cookies.join('; ') : rawCookie).split(';').map(value => value.trim()).filter(value => value.startsWith('supatrace-sso='));
    if (cookies.length > 1) fail(400, 'invalid_ingress_cookie');
    if (cookies.length) headers.set('cookie', cookies[0]);
  }
  const url = origin + path + (query ? '?' + query : '');
  if (['GET', 'DELETE'].includes(method)) {
    if (event.body != null && event.body !== '') fail(400, 'invalid_ingress_body');
    return {request: new Request(url, {method, headers}), sourceIp: viewerIp};
  }
  if (typeof event.body !== 'string' || typeof event.isBase64Encoded !== 'boolean' || !event.body.length) fail(400, 'invalid_ingress_body');
  if (event.body.length > (callback ? 40000 : 720000)) fail(413, 'identity_ingress_body_limit');
  if (event.isBase64Encoded && !base64.test(event.body)) fail(400, 'invalid_ingress_base64');
  return {request: new Request(url, {method, headers, body: Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8')}), sourceIp: viewerIp};
}
