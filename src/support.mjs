import {effectivePlanId} from './stripe-plan-state.mjs';
// Support is delivered to the configured service inbox. No trace payloads or credentials are attached.
import {randomUUID} from 'node:crypto';
import {HttpError, json} from './http.mjs';
import {emailConfigured} from './dashboard-auth.mjs';
import {entitlementsFor, requireFeature} from './entitlements.mjs';

export async function supportInfo(env, tenant) {
  const row = await env.store.getTenant(tenant);
  return {available: emailConfigured(env), ...entitlementsFor(effectivePlanId(row, env.planBilling?.mode)), inbox: 'support@supatrace.dev'};
}
export async function submitSupport(env, {tenant, actor, project, environment}, data) {
  const info = await supportInfo(env, tenant);
  requireFeature(info.plan_id, 'email_support');
  if (!data || Object.getPrototypeOf(data) !== Object.prototype ||
    Object.keys(data).some(key => !['email', 'subject', 'message', 'priority', 'contract'].includes(key)) ||
    typeof data.email !== 'string' || data.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email) ||
    typeof data.subject !== 'string' || !data.subject.trim() || data.subject.length > 120 || /[\r\n\x00]/.test(data.subject) ||
    typeof data.message !== 'string' || !data.message.trim() || data.message.length > 2500 || data.message.includes('\0') ||
    typeof data.priority !== 'boolean' || typeof data.contract !== 'boolean') throw new HttpError(400, 'invalid_support_request');
  if (data.priority) requireFeature(info.plan_id, 'priority_support');
  if (data.contract) requireFeature(info.plan_id, 'sla');
  if (!info.available) throw new HttpError(503, 'support_unavailable');
  const rate = await env.store.consumeRate({scope: 'support', identity: actor, limit: 5, windowSeconds: 3600});
  if (!rate.allowed) {const response = json({error: 'rate_limit'}, 429); response.headers.set('Retry-After', String(Math.max(1, Math.ceil(rate.retry_after || 3600)))); return response;}
  const id = randomUUID(), routing = data.contract ? 'CONTRACT' : data.priority ? 'PRIORITY' : 'STANDARD';
  try {
    // Keep the existing delivery route; changing public contact text does not provision mail.
    await env.sendEmail({to: 'support@supatrace.dev', subject: `[${routing}] SupaTrace ${id}: ${data.subject.trim()}`,
      text: `Support request: ${id}\nRoute: ${routing}\nPlan: ${info.plan_id}\nWorkspace: ${tenant}\nProject: ${project}\nEnvironment: ${environment}\nAccount: ${actor}\nReply address supplied by member: ${data.email}\n\n${data.message.trim()}\n`});
  } catch {throw new HttpError(503, 'support_delivery_unconfirmed');}
  return json({id, route: routing.toLowerCase(), delivered: true}, 201);
}
