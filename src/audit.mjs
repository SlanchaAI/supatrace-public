// Append-only audit events, one partition per workspace: pk AUDIT#<workspace>, sk EVENT#<inverted time>#<id>.
// The inverted time makes the ordinary ascending page read newest first. Rows are only ever Put with
// attribute_not_exists; nothing in this codebase updates or deletes them. DynamoDB TTL removes a row after retention.
// No setting turns the write path off. Events hold identifiers and short labels only: never a key, token or secret.
import {requireFeature} from './entitlements.mjs';
import {randomBytes} from 'node:crypto';
import {HttpError, json, boundedText, requireOrigin, securityHeaders} from './http.mjs';

export const AUDIT_RETENTION_DAYS = 90;
export const AUDIT_ACTIONS = Object.freeze([
  'auth.sign_in',
  'support.request',
  'key.create', 'key.rotate', 'key.revoke',
  'token.create', 'token.revoke',
  'member.invite', 'member.accept', 'member.role_change', 'member.remove',
  'sso.config_changed', 'sso.domain_verified', 'sso.enforcement_changed', 'sso.member_joined', 'scim.token_created', 'scim.user_provisioned', 'scim.user_deactivated',
  'member.leave', 'member.scope_change', 'settings.require_mfa_changed', 'project.create', 'project.rename', 'project.delete', 'org.create', 'org.rename', 'org.transfer_ownership', 'org.delete',
  'workspace.sharing_enabled', 'environment.create', 'environment.rename', 'environment.delete',
  'settings.mfa_enabled', 'settings.mfa_disabled',
  'billing.checkout_started', 'billing.portal_opened', 'billing.controls_enrolled', 'billing.reconciled', 'billing.spend_cap_changed', 'billing.plan_changed', 'settings.retention_changed', 'role.create', 'role.update', 'role.delete',
  'export.started', 'audit.export',
]);
const ACTIONS = new Set(AUDIT_ACTIONS), CATEGORIES = new Set(AUDIT_ACTIONS.map(action => action.split('.')[0]));
const EXPORT_KINDS = new Set(['trace', 'account', 'workspace']);
const inverted = (value, width) => String(10 ** width - 1 - value).padStart(width, '0');
const label = value => typeof value === 'string' && value.length <= 160 && !/[\u0000-\u001f\u007f]/.test(value);
// Orders events written by one process inside the same millisecond.
let sequence = 0;
const prefix = hash => typeof hash === 'string' ? hash.slice(0, 12) : null;
/** A key or token is named in the log by the first 12 hex characters of its SHA-256 id, never by the id or the secret. */
export const auditKeyPrefix = prefix;

/** One transaction item. Put it in the same transaction as the change it records and the two commit or fail together. */
export function auditPut(now, context, action, target = null, detail = {}) {
  if (!ACTIONS.has(action) || !context || !label(context.workspace) || !label(context.actor)) throw new HttpError(500, 'invalid_audit_event');
  const clean = {};
  for (const [name, value] of Object.entries(detail)) {
    if (value === undefined || value === null) continue;
    if (!(label(value) || Number.isSafeInteger(value) || typeof value === 'boolean')) throw new HttpError(500, 'invalid_audit_event');
    clean[name] = value;
  }
  const id = randomBytes(8).toString('hex'), expires = now + AUDIT_RETENTION_DAYS * 86400;
  return {Put: {Item: {pk: 'AUDIT#' + context.workspace, sk: `EVENT#${inverted(now, 12)}#${inverted(Date.now() % 1000, 3)}${inverted(sequence++ % 10000, 4)}#${id}`,
    event_id: id, workspace_id: context.workspace, at: now, actor: context.actor, action, target: label(target) ? target : null,
    detail: clean, ip: label(context.ip) ? context.ip : 'unknown', origin: context.origin === 'client' ? 'client' : 'server', expires_at: expires, ttl: expires},
    ConditionExpression: 'attribute_not_exists(pk)'}};
}
/**
 * For changes whose transaction this module cannot join (they commit inside another service call). The event is written
 * right after the change succeeds, with one retry. A second failure is logged without the event body and does not undo the change.
 */
export async function recordAudit(store, context, action, target = null, detail = {}) {
  if (typeof store?._tx !== 'function' || typeof store.now !== 'function') return false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await store._tx([auditPut(store.now(), context, action, target, detail)]); return true; }
    catch (error) { if (attempt === 1) console.error(JSON.stringify({event: 'audit_write_failed', action, error: error?.name || 'Error'})); }
  }
  return false;
}
const view = row => ({id: row.event_id, time: new Date(row.at * 1000).toISOString(), actor: row.actor, action: row.action, target: row.target ?? null,
  detail: row.detail && typeof row.detail === 'object' ? row.detail : {}, ip: row.ip ?? 'unknown', source: row.origin === 'client' ? 'client_reported' : 'server'});
function filters(url) {
  const allowed = new Set(['workspace', 'environment', 'project', 'action', 'actor', 'from', 'to', 'limit', 'after', 'format']);
  for (const name of url.searchParams.keys()) if (!allowed.has(name) || url.searchParams.getAll(name).length > 1) throw new HttpError(400, 'invalid_query');
  const action = url.searchParams.get('action') || '', actor = url.searchParams.get('actor') || '';
  if (action && !ACTIONS.has(action) && !CATEGORIES.has(action)) throw new HttpError(400, 'invalid_query');
  if (actor && !/^[A-Za-z0-9][A-Za-z0-9_.:@|-]{0,127}$/.test(actor)) throw new HttpError(400, 'invalid_query');
  const bound = name => { const value = url.searchParams.get(name) || ''; if (!value) return null; const ms = Date.parse(value); if (!Number.isFinite(ms)) throw new HttpError(400, 'invalid_query'); return Math.floor(ms / 1000); };
  const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new HttpError(400, 'invalid_query');
  return {action, actor, from: bound('from'), to: bound('to'), limit, after: url.searchParams.get('after') || null};
}
// Filters run over bounded page reads. Rows are newest first, so a `to` bound seeks straight to that time and a `from`
// bound ends the scan: a date range costs its own rows, however many newer events exist. `next` continues the scan.
const cursorAt = (workspace, sk) => Buffer.from(JSON.stringify({pk: 'AUDIT#' + workspace, sk})).toString('base64url');
async function scan(store, workspace, query, {limit, maxPages}) {
  const events = [], now = store.now(); let cursor = query.after ?? (query.to === null ? null : cursorAt(workspace, `EVENT#${inverted(query.to, 12)}`)), pages = 0;
  do {
    const page = await store._page('AUDIT#' + workspace, 'EVENT#', {cursor, limit: 100}); pages++;
    for (const [index, row] of page.items.entries()) {
      // A full result stops here; the cursor is the last row read, in the store's own cursor form.
      if (events.length === limit) return {events, next: cursorAt(workspace, page.items[index - 1].sk), truncated: false};
      if (query.from !== null && Number.isSafeInteger(row.at) && row.at < query.from) return {events, next: null, truncated: false};
      if (row.workspace_id !== workspace || !Number.isSafeInteger(row.at) || !(row.expires_at > now)) continue;
      if (query.action && row.action !== query.action && row.action.split('.')[0] !== query.action) continue;
      if (query.actor && row.actor !== query.actor) continue;
      if ((query.from !== null && row.at < query.from) || (query.to !== null && row.at > query.to)) continue;
      events.push(view(row));
    }
    cursor = page.next;
  } while (cursor && events.length < limit && pages < maxPages);
  return {events, next: cursor, truncated: !!cursor && events.length < limit};
}
// Spreadsheet programs run a cell that starts with = + - @; such a cell is stored with a leading apostrophe.
const cell = value => { let text = value === null || value === undefined ? '' : String(value); if (/^[=+\-@\t\r]/.test(text)) text = "'" + text; return /[",\n\r]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text; };
export function auditCsv(events) {
  return ['time,actor,action,target,ip,source,detail', ...events.map(e => [e.time, e.actor, e.action, e.target, e.ip, e.source, Object.keys(e.detail).length ? JSON.stringify(e.detail) : ''].map(cell).join(','))].join('\r\n') + '\r\n';
}
/**
 * GET /api/audit (owner; filters action, actor, from, to, limit, after), GET /api/audit/export?format=json|csv (owner),
 * POST /api/audit/events (any member; reports an export this browser is starting, because exports are assembled client-side).
 */
export async function auditApi(request, env, store, {tenant, actor, access}) {
  const url = new URL(request.url), path = url.pathname, context = {workspace: tenant, actor, ip: env.sourceIp};
  if (request.method === 'POST' && path === '/api/audit/events') {
    requireOrigin(request, env.APP_ORIGIN);
    const data = JSON.parse(await boundedText(request, 1024));
    if (!data || Object.getPrototypeOf(data) !== Object.prototype || Object.keys(data).some(name => !['action', 'kind', 'run_id'].includes(name)) || data.action !== 'export.started' || !EXPORT_KINDS.has(data.kind) ||
      (data.run_id !== undefined && (data.kind !== 'trace' || typeof data.run_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(data.run_id)))) throw new HttpError(400, 'invalid_audit_event');
    // A member cannot flood the log: ten export reports a minute for each account.
    const rate = await store.consumeRate({scope: 'auditreport', identity: actor, limit: 10, windowSeconds: 60});
    if (!rate.allowed) { const error = new HttpError(429, 'rate_limit'); error.retryAfter = Number.isFinite(rate.retry_after) && rate.retry_after > 0 ? rate.retry_after : 60; throw error; }
    await store._tx([auditPut(store.now(), {...context, origin: 'client'}, 'export.started', data.run_id ?? null, {kind: data.kind, environment: store.environmentId ?? 'default'})]);
    return json({recorded: true}, 201);
  }
  if (request.method !== 'GET' || (path !== '/api/audit' && path !== '/api/audit/export')) throw new HttpError(404, 'not_found');
  if (access.role !== 'owner') throw new HttpError(403, 'workspace_owner_required');
  // Events are recorded on every plan; reading them is the audit_log feature and exporting them audit_log_export.
  requireFeature(typeof store.planId === 'function' ? await store.planId(tenant) : null, path === '/api/audit' ? 'audit_log' : 'audit_log_export');
  const query = filters(url);
  if (path === '/api/audit') {
    if (url.searchParams.has('format')) throw new HttpError(400, 'invalid_query');
    const result = await scan(store, tenant, query, {limit: query.limit, maxPages: 10});
    return json({workspace_id: tenant, retention_days: AUDIT_RETENTION_DAYS, actions: AUDIT_ACTIONS, events: result.events, next: result.next, truncated: result.truncated});
  }
  const format = url.searchParams.get('format') || 'json';
  if (!['json', 'csv'].includes(format) || url.searchParams.has('limit')) throw new HttpError(400, 'invalid_query');
  // One export holds at most 5,000 scanned events. When more remain, `next` (JSON) or X-Audit-Export-Next (CSV) continues it with `after`.
  const result = await scan(store, tenant, query, {limit: Infinity, maxPages: 50});
  await recordAudit(store, context, 'audit.export', null, {format, events: result.events.length});
  const name = `supatrace-audit-${tenant.replace(/[^A-Za-z0-9_-]/g, '_')}.${format}`, complete = result.next ? 'false' : 'true';
  const headers = securityHeaders({'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json', 'Content-Disposition': `attachment; filename="${name}"`, 'X-Audit-Export-Complete': complete, ...(result.next ? {'X-Audit-Export-Next': result.next} : {})});
  if (format === 'csv') return new Response(auditCsv(result.events), {status: 200, headers});
  return new Response(JSON.stringify({version: 1, workspace_id: tenant, exported_at: new Date(store.now() * 1000).toISOString(), retention_days: AUDIT_RETENTION_DAYS,
    filters: {action: query.action || null, actor: query.actor || null, from: query.from === null ? null : new Date(query.from * 1000).toISOString(), to: query.to === null ? null : new Date(query.to * 1000).toISOString()},
    complete: !result.next, next: result.next, events: result.events}), {status: 200, headers});
}
