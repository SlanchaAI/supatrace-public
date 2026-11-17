// API Gateway v2 transport adapter for the trace-ingest edge. No network, secrets store, grants or account access.
//
// The function URL sits behind CloudFront origin access control, which needs the caller to send a SHA-256 of
// every POST body and replaces Authorization. A stock OpenTelemetry exporter or Langfuse SDK can do neither.
// The ingest routes therefore arrive through an HTTP API that the distribution fronts. Only the listed routes,
// the listed headers and the body cross this boundary. Cookies, Origin and query strings never do.
import {createHash, timingSafeEqual} from 'node:crypto';
import {isIP} from 'node:net';
import {HttpError} from './http.mjs';

export const INGEST_ROUTES = Object.freeze([
  'POST /v1/traces',
  'POST /api/public/otel/v1/traces',
  'POST /api/public/ingestion',
  'GET /api/public/projects',
  'GET /api/public/health'
]);
// The distribution adds this header to every origin request, overriding any viewer value. A request without the
// configured value did not come through the distribution, so its viewer address cannot be trusted.
export const EDGE_TOKEN_HEADER = 'x-supatrace-edge';
// Set by a CloudFront function from the viewer connection, overwriting any viewer value.
export const VIEWER_IP_HEADER = 'x-supatrace-viewer-ip';
const FORWARDED = new Set(['content-type', 'content-encoding', 'accept', 'authorization', 'x-supatrace-key', 'user-agent']);
const ORIGINS = ['https://supatrace.dev', 'https://supatrace.tech'];
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const fail = (status, code) => { const error = new HttpError(status, code); error.edgeIngress = true; throw error; };
const hash = value => createHash('sha256').update(value).digest();

/** True when the event came from the configured ingest HTTP API. Anything else is left to the other adapters. */
export function isIngestIngress(event, apiId) {
  return typeof apiId === 'string' && /^[a-z0-9]{1,40}$/.test(apiId) && event?.requestContext?.apiId === apiId;
}

/** Returns {request, sourceIp}, or throws an HttpError marked edgeIngress before any application work. */
export function ingestIngressRequest(event, {apiId, region, edgeToken, appOrigin = ORIGINS[0]} = {}) {
  if (typeof apiId !== 'string' || !/^[a-z0-9]{1,40}$/.test(apiId) || !/^[-a-z0-9]{1,32}$/.test(region || '') ||
    typeof edgeToken !== 'string' || !/^[A-Za-z0-9]{32,128}$/.test(edgeToken) || !ORIGINS.includes(appOrigin)) fail(503, 'ingest_ingress_disabled');
  const context = event?.requestContext, route = event?.routeKey;
  if (event?.version !== '2.0' || !INGEST_ROUTES.includes(route) || context?.routeKey !== route || context.apiId !== apiId ||
    context.stage !== '$default' || context.domainName !== `${apiId}.execute-api.${region}.amazonaws.com`) fail(403, 'ingest_ingress_scope_mismatch');
  const [method, path] = route.split(' ');
  if (context.http?.method !== method || context.http.path !== path || event.rawPath !== path || event.rawQueryString !== '') fail(403, 'ingest_ingress_scope_mismatch');

  const headers = new Headers();
  let presented = '', viewerIp = '';
  for (const [name, value] of Object.entries(event.headers || {})) {
    if (typeof value !== 'string' || value.length > 8192 || /[\r\n]/.test(value)) fail(400, 'invalid_ingress_header');
    const key = name.toLowerCase();
    if (key === EDGE_TOKEN_HEADER) { if (presented) fail(400, 'duplicate_ingress_header'); presented = value; }
    else if (key === VIEWER_IP_HEADER) { if (viewerIp) fail(400, 'duplicate_ingress_header'); viewerIp = value; }
    else if (FORWARDED.has(key)) { if (headers.has(key)) fail(400, 'duplicate_ingress_header'); headers.set(key, value); }
  }
  // Compare digests so the comparison takes the same time for any presented length.
  if (!presented || !timingSafeEqual(hash(presented), hash(edgeToken))) fail(403, 'ingest_ingress_forbidden');
  if (!isIP(viewerIp)) fail(400, 'invalid_ingress_source_ip');

  if (method === 'GET') {
    if (event.body != null && event.body !== '') fail(400, 'invalid_ingress_body');
    return {request: new Request(appOrigin + path, {method, headers}), sourceIp: viewerIp};
  }
  if (typeof event.body !== 'string' || typeof event.isBase64Encoded !== 'boolean' || !event.body.length) fail(400, 'invalid_ingress_body');
  if (event.body.length > 720000) fail(413, 'ingest_ingress_body_limit');
  if (event.isBase64Encoded && !BASE64.test(event.body)) fail(400, 'invalid_ingress_base64');
  const raw = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
  return {request: new Request(appOrigin + path, {method, headers, body: raw}), sourceIp: viewerIp};
}
