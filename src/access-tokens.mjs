// Personal access tokens and the management API route table.
// A token is `stpat_` + 32 random bytes (base64url), made in the browser; only its SHA-256 is sent and stored. Tokens are
// account-scoped and read-only: they authenticate GET requests on /api/v1 and nothing else.
import {HttpError, json, boundedText, requireOrigin} from './http.mjs';
import {digest} from './aws-auth.mjs';

export const ACCESS_TOKEN_LIMITS = Object.freeze({count: 20, nameLength: 80, defaultDays: 30, maxDays: 365});
const TOKEN = /^stpat_[A-Za-z0-9_-]{43}$/;
/** The token travels as a bearer credential, or as x-supatrace-key where the edge does not forward Authorization. */
export function accessToken(request) {
  const bearer = /^Bearer (\S+)$/i.exec(request.headers.get('authorization') || '');
  const value = bearer ? bearer[1] : request.headers.get('x-supatrace-key') || '';
  return TOKEN.test(value) ? value : '';
}
export async function accessTokenActor(request, store) {
  const token = accessToken(request);
  if (!token) throw new HttpError(401, 'access_token_required');
  const row = typeof store.lookupAccessToken === 'function' ? await store.lookupAccessToken(digest(token)) : null;
  if (!row) throw new HttpError(401, 'invalid_access_token');
  return row;
}
const view = (row, now) => ({id: row.token_hash, name: row.name, scope: 'read', created_at: new Date(row.created_at * 1000).toISOString(), expires_at: new Date(row.expires_at * 1000).toISOString(), expired: row.expires_at <= now});
/** Session-only token management: GET /api/tokens, POST /api/tokens, POST /api/tokens/revoke. */
export async function accessTokenApi(request, env, actor) {
  const store = Object.create(env.store), path = new URL(request.url).pathname;
  store.audit = {workspace: actor, actor, ip: env.sourceIp};
  if (request.method === 'GET' && path === '/api/tokens') {
    const page = await store.listAccessTokens(actor, {limit: 100});
    return json({tokens: page.items.map(row => view(row, store.now())), limit: ACCESS_TOKEN_LIMITS.count});
  }
  if (request.method !== 'POST') throw new HttpError(404, 'not_found');
  requireOrigin(request, env.APP_ORIGIN);
  const data = JSON.parse(await boundedText(request, 4096));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'invalid_token_request');
  if (path === '/api/tokens') {
    const name = typeof data.name === 'string' ? data.name.trim() : '', days = data.expires_in_days ?? ACCESS_TOKEN_LIMITS.defaultDays;
    if (!name || name.length > ACCESS_TOKEN_LIMITS.nameLength) throw new HttpError(400, 'invalid_token_name');
    if (!Number.isInteger(days) || days < 1 || days > ACCESS_TOKEN_LIMITS.maxDays) throw new HttpError(400, 'invalid_token_expiry');
    // As with write keys, the browser makes the token and sends only its SHA-256; the server never sees the token.
    if (typeof data.token_hash !== 'string' || !/^[a-f0-9]{64}$/.test(data.token_hash)) throw new HttpError(400, 'invalid_token_hash');
    return json(view(await store.createAccessToken(actor, {token_hash: data.token_hash, name, expires_at: store.now() + days * 86400}), store.now()), 201);
  }
  if (path === '/api/tokens/revoke') {
    if (typeof data.id !== 'string' || !/^[a-f0-9]{64}$/.test(data.id)) throw new HttpError(400, 'invalid_token_id');
    return json(await store.revokeAccessToken(actor, data.id));
  }
  throw new HttpError(404, 'not_found');
}
// /api/v1 route table. Each entry maps a public path to the existing dashboard handler and names the query parameters it passes on.
const SCOPE = ['workspace', 'project', 'environment'];
const ROUTES = [
  {pattern: /^\/api\/v1\/me$/, custom: 'me', query: []},
  {pattern: /^\/api\/v1\/workspaces$/, custom: 'workspaces', query: []},
  {pattern: /^\/api\/v1\/projects$/, custom: 'projects', query: []},
  {pattern: /^\/api\/v1\/keys$/, internal: '/api/keys', query: [...SCOPE, 'after']},
  {pattern: /^\/api\/v1\/usage$/, internal: '/api/usage', query: ['workspace']},
  {pattern: /^\/api\/v1\/logs$/, internal: '/api/logs', query: [...SCOPE, 'stream', 'route', 'reason', 'from', 'to', 'limit', 'after']},
  {pattern: /^\/api\/v1\/traces$/, internal: '/api/runs', query: [...SCOPE, 'limit', 'offset', 'sort', 'dir', 'q', 'from', 'to']},
  {pattern: /^\/api\/v1\/traces\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})\/events$/, internal: '/api/events', param: 'run', query: [...SCOPE, 'after']},
];
/** Resolves a /api/v1 request to {custom} or {url} (the internal URL). Read-only: anything but GET is 405. */
export function managementRoute(method, url) {
  for (const route of ROUTES) {
    const match = route.pattern.exec(url.pathname);
    if (!match) continue;
    if (method !== 'GET') throw new HttpError(405, 'method_not_allowed');
    for (const name of url.searchParams.keys()) if (!route.query.includes(name) || url.searchParams.getAll(name).length > 1) throw new HttpError(400, 'invalid_query');
    if (route.custom) return {custom: route.custom};
    const internal = new URL(route.internal, url.origin);
    for (const name of route.query) if (url.searchParams.has(name)) internal.searchParams.set(name, url.searchParams.get(name));
    if (route.param) internal.searchParams.set(route.param, match[1]);
    return {url: internal};
  }
  throw new HttpError(404, 'not_found');
}
