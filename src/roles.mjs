// Roles and the one table that says which role may call which dashboard route.
// Owner: everything. Admin: environments, drains, keys, traces. Developer: keys and traces. Read-only (stored as
// `viewer`): traces, usage and exports. Members, billing, the audit log and organization settings are the owner's.
// A member may also be limited to listed environments; routes marked `scoped` then refuse any other environment,
// and routes that act on the whole organization (`whole`) refuse a limited member.
import {HttpError} from './http.mjs';

export const MEMBER_ROLES = Object.freeze(['admin', 'developer', 'viewer']);
export const ROLE_LABELS = Object.freeze({owner: 'Owner', admin: 'Admin', developer: 'Developer', viewer: 'Read-only'});
const CAPABILITIES = Object.freeze({owner: ['read', 'keys', 'manage', 'owner'], admin: ['read', 'keys', 'manage'], developer: ['read', 'keys'], viewer: ['read']});
export const can = (role, capability) => CAPABILITIES[role]?.includes(capability) === true;
/** Roles whose members may issue keys. A key stops working when its issuer leaves this set. */
export const KEY_ISSUER_ROLES = Object.freeze(['owner', 'admin', 'developer']);

// method, path (exact, or a prefix when it ends in `*`), capability, flags. First match wins.
export const ROUTES = Object.freeze([
  ['GET', '/api/support', 'read', 'scoped'], ['POST', '/api/support', 'read', 'scoped'],
  ['POST','/api/projects','manage','whole'], ['POST','/api/projects/rename','manage','whole'], ['POST','/api/projects/delete','manage','whole'],
  ['GET', '/api/workspace', 'read'], ['GET', '/api/entitlements', 'read'], ['GET', '/api/usage', 'read'], ['GET', '/api/imports/capabilities', 'read'],
  ['GET', '/api/integrations', 'read', 'scoped'],
  ['GET', '/api/runs', 'read', 'scoped'], ['GET', '/api/runs/page', 'read', 'scoped'], ['GET', '/api/events', 'read', 'scoped'],
  ['GET', '/api/logs', 'read', 'scoped'],
  ['POST', '/api/audit/events', 'read', 'scoped'],
  ['GET', '/api/keys', 'keys', 'scoped'], ['POST', '/api/setup/approve', 'keys', 'scoped'],
  ['POST', '/api/keys/create', 'keys', 'scoped'], ['POST', '/api/keys/rotate', 'keys', 'scoped'], ['POST', '/api/keys/revoke', 'keys', 'scoped'],
  ['GET', '/api/environments', 'read'], ['POST', '/api/environments', 'manage', 'whole'], ['POST', '/api/environments/rename', 'manage', 'whole'], ['POST', '/api/environments/delete', 'manage', 'whole'],
  ['GET', '/api/drains*', 'manage', 'whole'], ['POST', '/api/drains*', 'manage', 'whole'],
  ['GET', '/api/workspaces/members', 'owner'], ['POST', '/api/workspaces/invite', 'owner'], ['POST', '/api/workspaces/member', 'owner'],
  ['GET', '/api/audit', 'owner'], ['GET', '/api/audit/export', 'owner'],
  ['GET', '/api/billing/*', 'owner'], ['POST', '/api/billing/*', 'owner'],
  ['GET', '/api/imports/*', 'owner'], ['POST', '/api/imports/*', 'owner'],
  ['GET', '/api/orgs/sso/*', 'owner'], ['POST', '/api/orgs/sso/*', 'owner'],
  ['GET', '/api/orgs/roles/*', 'owner'], ['POST', '/api/orgs/roles/*', 'owner'],
  ['POST', '/api/orgs/delete', 'owner'],
  ['POST', '/api/orgs/rename', 'owner'], ['POST', '/api/orgs/transfer', 'owner'], ['POST', '/api/orgs/security', 'owner'],
]);
/** The rule for a route. A route that is not in the table is the owner's: new routes are closed to members until listed. */
export function routeRule(method, path) {
  for (const [verb, pattern, capability, flag] of ROUTES) {
    if (verb !== method) continue;
    if (pattern.endsWith('*') ? path === pattern.slice(0, -2) || path.startsWith(pattern.slice(0, -1)) : path === pattern) return {capability, scoped: flag === 'scoped', whole: flag === 'whole'};
  }
  return {capability: 'owner', scoped: false, whole: false};
}
/** Throws unless `access` (from Workspaces.access) may call the route in `environment`. Error codes match the ones the dashboard already handles. */
export function authorizeRoute(access, method, path, environment = 'default') {
  const rule = routeRule(method, path);
  if (!can(access.role, rule.capability)) throw new HttpError(403, rule.capability === 'owner' ? 'workspace_owner_required' : 'workspace_admin_required');
  const allowed = access.environments;
  if (Array.isArray(allowed)) {
    if (rule.whole) throw new HttpError(403, 'workspace_admin_required');
    if (rule.scoped && !allowed.includes(environment)) throw new HttpError(403, 'environment_unavailable');
  }
  return rule;
}
