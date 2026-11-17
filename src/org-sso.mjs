// Per-organization single sign-on (SAML 2.0) and SCIM 2.0 Users provisioning.
// An organization's owner stores the IdP's sign-on URL, issuer and signing certificate (a public certificate, not a
// secret), claims email domains by DNS TXT, and may then require SSO for members and issue one SCIM bearer token.
// Sign-in still goes through /api/auth/sso and /api/auth/sso/callback (src/dashboard-auth.mjs), which ask this module
// which organization owns the email domain. The deployment-wide IdP from stack parameters keeps working and wins for its domains.
import {randomBytes, X509Certificate} from 'node:crypto';
import {resolveTxt} from 'node:dns/promises';
import {HttpError, json, boundedText, requireOrigin, securityHeaders} from './http.mjs';
import {digest} from './aws-auth.mjs';
import {auditPut} from './audit.mjs';
import {MEMBER_ROLES, authorizeRoute} from './roles.mjs';
import {hasFeature, requireFeature, countLimit} from './entitlements.mjs';
import {seatAdmission} from './seat-admission.mjs';

export const SSO_LIMITS = Object.freeze({domains: 5, certBytes: 8192, scimPage: 100, scimUsers: 20});
const fail = (status, code) => { throw new HttpError(status, code); };
// An audit detail holds at most 160 characters; a longer issuer or domain list is recorded shortened, never refused (#216).
const clip = value => value.length <= 160 ? value : value.slice(0, 159) + '…';
// The organization's plan decides whether SSO (sso_saml) and SCIM (scim) may be used; see src/entitlements.mjs.
const planId = async (store, org) => typeof store?.planId === 'function' ? await store.planId(org) : null;
const pk = org => 'TENANT#' + org, configKey = org => ({pk: pk(org), sk: 'SSO#CONFIG'}), domainKey = domain => ({pk: 'SSODOMAIN#' + domain, sk: 'ORG'});
const DOMAIN = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const SCIM_TOKEN = /^stscim_[A-Za-z0-9_-]{43}$/;
const exact = (v, keys) => v && Object.getPrototypeOf(v) === Object.prototype && Object.keys(v).sort().join() === [...keys].sort().join();
const conditional = e => e?.name === 'ConditionalCheckFailedException' || e?.name === 'TransactionCanceledException';
export const verificationRecord = (domain, token) => ({name: '_supatrace.' + domain, type: 'TXT', value: 'supatrace-verification=' + token});
const verifiedDomains = config => Object.entries(config?.domains ?? {}).filter(([, state]) => Number.isSafeInteger(state.verified_at)).map(([domain]) => domain).sort();
const complete = config => !!(config?.idp_sso_url && config.idp_issuer && config.idp_cert);
// Domains of the deployment-wide IdP (stack parameter SsoEmailDomains). They belong to that IdP alone: sign-in sends them
// there, an organization cannot verify one, and one an organization verified before the operator listed it stops counting
// for that organization everywhere (its IdP may not assert such an email, SCIM may not provision one, Require SSO refuses it).
export const deploymentDomains = env => typeof env?.SSO_EMAIL_DOMAINS === 'string' ? env.SSO_EMAIL_DOMAINS.split(',').map(domain => domain.trim().toLowerCase()).filter(Boolean) : [];

function idpUrl(value) { let url; try { url = new URL(value); } catch { fail(400, 'invalid_sso_configuration'); } if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1') || value.length > 2048) fail(400, 'invalid_sso_configuration'); return url.href; }
function idpCert(value) {
  if (typeof value !== 'string' || value.length > SSO_LIMITS.certBytes || !value.includes('BEGIN CERTIFICATE')) fail(400, 'invalid_sso_certificate');
  try { const cert = new X509Certificate(value); return {pem: cert.toString(), sha256: cert.fingerprint256}; } catch { fail(400, 'invalid_sso_certificate'); }
}
function view(org, config, origin) {
  return {organization_id: org, configured: complete(config), idp_sso_url: config?.idp_sso_url ?? null, idp_issuer: config?.idp_issuer ?? null, idp_cert_sha256: config?.idp_cert_sha256 ?? null,
    default_role: config?.default_role ?? 'viewer', enforce: config?.enforce === true,
    domains: Object.entries(config?.domains ?? {}).sort(([a], [b]) => a < b ? -1 : 1).map(([domain, state]) => ({domain, verified: Number.isSafeInteger(state.verified_at), record: verificationRecord(domain, state.token)})),
    service_provider: {entity_id: origin + '/api/auth/sso', acs_url: origin + '/api/auth/sso/callback', name_id: 'emailAddress'},
    scim: {token_set: typeof config?.scim_token_hash === 'string', base_url: origin + '/api/scim/v2'}};
}
// Session routes: GET /api/orgs/sso, POST /api/orgs/sso, /verify, /enforce, /scim-token. Owner only (src/roles.mjs).
export async function orgSsoApi(request, env, actor, spaces, fence) {
  const url = new URL(request.url), path = url.pathname, store = env.store;
  const owner = async org => { const access = await spaces.access(actor, org); authorizeRoute(access, request.method, path); await spaces.requireMfa(actor, access); if (!access.shared) fail(409, 'workspace_not_shared'); return access; };
  if (request.method === 'GET' && path === '/api/orgs/sso') { const org = url.searchParams.get('workspace') ?? actor; await owner(org); return json(view(org, await store._get(configKey(org)), env.APP_ORIGIN)); }
  if (request.method !== 'POST') fail(404, 'not_found');
  requireOrigin(request, env.APP_ORIGIN);
  let data; try { data = JSON.parse(await boundedText(request, 16384)); } catch { fail(400, 'invalid_sso_request'); }
  const org = data?.organization_id; if (typeof org !== 'string') fail(400, 'invalid_sso_request');
  const access = await owner(org);
  // Changing SSO settings needs the plan's SSO feature, and a SCIM token its SCIM feature. Turning "require SSO" off is
  // always allowed, so an organization that moved to a lower plan can still clear the rule.
  if (!(path === '/api/orgs/sso/enforce' && data.enforce === false)) requireFeature(await planId(store, org), path === '/api/orgs/sso/scim-token' ? 'scim' : 'sso_saml');
  const old = await store._get(configKey(org)), now = store.now(), audit = (action, target, detail) => spaces.audit(org, action, target, detail);
  const guard = old ? {ConditionExpression: 'updated_at = :seen', ExpressionAttributeValues: {':seen': old.updated_at}} : {ConditionExpression: 'attribute_not_exists(pk)'};
  const meta = fields => ({Update: {Key: {pk: pk(org), sk: 'WORKSPACE#META'}, UpdateExpression: 'SET sso_enforced = :on, sso_domains = :domains, sso_idp_version = :idp', ConditionExpression: 'attribute_exists(pk)', ExpressionAttributeValues: {':on': fields.enforce === true, ':domains': verifiedDomains(fields), ':idp': fields.idp_version}}});
  const save = async (next, extra, event) => { next.updated_at = Math.max(now, (old?.updated_at ?? 0) + 1); await spaces.tx([{Put: {Item: {...configKey(org), ...next}, ...guard}}, meta(next), ...extra, event], fence(access)); return next; };

  if (path === '/api/orgs/sso') {
    if (!exact(data, ['organization_id', 'idp_sso_url', 'idp_issuer', 'idp_cert', 'default_role', 'domains'])) fail(400, 'invalid_sso_request');
    if (typeof data.idp_issuer !== 'string' || !data.idp_issuer || data.idp_issuer.length > 1024 || /[\u0000-\u001f\u007f]/.test(data.idp_issuer) || !MEMBER_ROLES.includes(data.default_role)) fail(400, 'invalid_sso_configuration');
    if (!Array.isArray(data.domains) || data.domains.length > SSO_LIMITS.domains || data.domains.some(d => typeof d !== 'string' || !DOMAIN.test(d)) || new Set(data.domains).size !== data.domains.length) fail(400, 'invalid_sso_domain');
    const cert = idpCert(data.idp_cert), domains = {}, released = [];
    // A domain that stays keeps its token and verification; a new one starts unverified; a removed one gives up its claim.
    for (const domain of data.domains) domains[domain] = old?.domains?.[domain] ?? {token: randomBytes(18).toString('base64url'), verified_at: null};
    for (const [domain, state] of Object.entries(old?.domains ?? {})) if (!Object.hasOwn(domains, domain) && Number.isSafeInteger(state.verified_at)) released.push({Delete: {Key: domainKey(domain), ConditionExpression: 'org = :org', ExpressionAttributeValues: {':org': org}}});
    const next = {...(old ?? {}), ...configKey(org), organization_id: org, idp_sso_url: idpUrl(data.idp_sso_url), idp_issuer: data.idp_issuer, idp_cert: cert.pem, idp_cert_sha256: cert.sha256, default_role: data.default_role, domains, enforce: old?.enforce === true};
    // The IdP version names one (sign-on URL, issuer, certificate). Sessions are bound to the version that vouched for them,
    // so replacing any of the three ends, for "require SSO", every session the previous IdP signed in.
    next.idp_version = !old ? 1 : old.idp_sso_url === next.idp_sso_url && old.idp_issuer === next.idp_issuer && old.idp_cert_sha256 === next.idp_cert_sha256 ? old.idp_version : old.idp_version + 1;
    // Enforcement cannot outlive the last verified domain.
    if (next.enforce && !verifiedDomains(next).length) next.enforce = false;
    const saved = await save(next, released, audit('sso.config_changed', org, {issuer: clip(data.idp_issuer), domains: clip(data.domains.join(' ') || 'none'), certificate_sha256: cert.sha256}));
    return json(view(org, saved, env.APP_ORIGIN));
  }
  if (!old) fail(409, 'sso_not_configured');
  if (path === '/api/orgs/sso/verify') {
    if (!exact(data, ['organization_id', 'domain']) || !Object.hasOwn(old.domains ?? {}, data.domain)) fail(400, 'invalid_sso_domain');
    const state = old.domains[data.domain], expected = verificationRecord(data.domain, state.token);
    if (!Number.isSafeInteger(state.verified_at)) {
      if (deploymentDomains(env).includes(data.domain)) fail(409, 'sso_domain_claimed');
      let records = []; try { records = (await (env.resolveTxt ?? resolveTxt)(expected.name)).map(parts => Array.isArray(parts) ? parts.join('') : String(parts)); } catch { records = []; }
      if (!records.includes(expected.value)) fail(409, 'sso_domain_not_verified');
      const next = {...old, domains: {...old.domains, [data.domain]: {...state, verified_at: now}}};
      // One organization per domain, service-wide. The marker lets the sign-in page offer SSO without a scan.
      const claim = {Put: {Item: {...domainKey(data.domain), org, domain: data.domain, verified_at: now}, ConditionExpression: 'attribute_not_exists(pk) OR org = :org', ExpressionAttributeValues: {':org': org}}};
      try { return json(view(org, await save(next, [claim, {Put: {Item: {pk: 'SYS', sk: 'ORGSSO', enabled: true}}}], audit('sso.domain_verified', data.domain)), env.APP_ORIGIN)); }
      catch (error) { if (error.code === 'workspace_changed' && (await store._get(domainKey(data.domain)))?.org !== org && await store._get(domainKey(data.domain))) fail(409, 'sso_domain_claimed'); throw error; }
    }
    return json(view(org, old, env.APP_ORIGIN));
  }
  if (path === '/api/orgs/sso/enforce') {
    if (!exact(data, ['organization_id', 'enforce']) || typeof data.enforce !== 'boolean') fail(400, 'invalid_sso_request');
    if (data.enforce && (!complete(old) || !verifiedDomains(old).length)) fail(409, 'sso_not_ready');
    if ((old.enforce === true) === data.enforce) return json(view(org, old, env.APP_ORIGIN));
    return json(view(org, await save({...old, enforce: data.enforce}, [], audit('sso.enforcement_changed', org, {enabled: data.enforce})), env.APP_ORIGIN));
  }
  if (path === '/api/orgs/sso/scim-token') {
    // The browser makes the token and sends only its SHA-256, as with keys and access tokens. A new token replaces the old one.
    if (!exact(data, ['organization_id', 'token_hash']) || !/^[a-f0-9]{64}$/.test(data.token_hash ?? '')) fail(400, 'invalid_sso_request');
    const extra = [{Put: {Item: {pk: 'SCIM#' + data.token_hash, sk: 'TOKEN', org, token_hash: data.token_hash, created_at: now}, ConditionExpression: 'attribute_not_exists(pk)'}}];
    if (typeof old.scim_token_hash === 'string') extra.push({Delete: {Key: {pk: 'SCIM#' + old.scim_token_hash, sk: 'TOKEN'}}});
    return json(view(org, await save({...old, scim_token_hash: data.token_hash}, extra, audit('scim.token_created', data.token_hash.slice(0, 12))), env.APP_ORIGIN), 201);
  }
  fail(404, 'not_found');
}

// ---- Sign-in side -------------------------------------------------------------------------------------------------
/** True once any organization has a verified domain: the sign-in page then offers "Continue with SSO". */
export async function orgSsoAvailable(store) { return typeof store?._get === 'function' && (await store._get({pk: 'SYS', sk: 'ORGSSO'}))?.enabled === true; }
/** The organization and IdP settings that own this email domain, or null. Only a verified, complete configuration counts. */
export async function orgSsoForDomain(store, domain) {
  if (typeof store?._get !== 'function' || !DOMAIN.test(domain ?? '')) return null;
  const claim = await store._get(domainKey(domain)); if (!claim || typeof claim.org !== 'string') return null;
  return orgSso(store, claim.org, domain);
}
export async function orgSso(store, org, domain = null) {
  // An organization whose plan no longer has SSO has no SSO sign-in: its domains are not offered and its IdP is not trusted.
  if (!hasFeature(await planId(store, org), 'sso_saml')) return null;
  // A deleted organization has no sign-in.
  if (Number.isSafeInteger((await store._get({pk: pk(org), sk: 'WORKSPACE#META'}))?.deleted_at)) return null;
  const config = await store._get(configKey(org));
  if (!complete(config) || (domain !== null && !verifiedDomains(config).includes(domain)) || (await store._get(domainKey(domain ?? verifiedDomains(config)[0] ?? '-')))?.org !== org) return null;
  return {org, idp_sso_url: config.idp_sso_url, idp_issuer: config.idp_issuer, idp_cert: config.idp_cert, idp_version: config.idp_version, config_version: config.updated_at, default_role: config.default_role, domains: verifiedDomains(config)};
}
// The SAML response arrives without the email, so the request's RelayState remembers which organization it was for.
export async function rememberSsoRelay(store, relay, org) { const expires = store.now() + 600; await store._tx([{Put: {Item: {pk: 'SSORELAY#' + digest(relay), sk: 'ORG', org, expires_at: expires, ttl: expires}, ConditionExpression: 'attribute_not_exists(pk)'}}]); }
export async function takeSsoRelay(store, relay) {
  const Key = {pk: 'SSORELAY#' + digest(relay), sk: 'ORG'}, row = await store._get(Key); if (!row || !(row.expires_at > store.now())) return null;
  try { await store._tx([{Delete: {Key, ConditionExpression: 'org = :org', ExpressionAttributeValues: {':org': row.org}}}]); } catch (error) { if (conditional(error)) return null; throw error; }
  return row.org;
}

// ---- Membership without an invitation (just-in-time at SSO sign-in, and SCIM) --------------------------------------
const memberKey = (org, id) => ({pk: pk(org), sk: 'MEMBER#' + id}), inviteKey = (org, id) => ({pk: pk(org), sk: 'INVITE#' + id});
// An unused invitation for this person is spent in the same transaction as a membership change made here. Otherwise an
// invitation issued earlier could be accepted later and undo a SCIM deactivation, or bring back someone the owner removed
// after they had joined by SSO instead of accepting it.
// "There is no unused invitation" is checked in that transaction as well: an invitation the owner issues or reissues after
// this read fails the transaction (409), and the retry spends it. So every invitation that exists when the membership
// change commits is spent by it; one issued afterwards is the owner's later decision.
async function spendInvite(store, org, account) {
  const Key = inviteKey(org, account), invite = await store._get(Key);
  if (!invite) return [{ConditionCheck: {Key, ConditionExpression: 'attribute_not_exists(pk)'}}];
  const same = {ConditionExpression: 'token_hash = :hash AND used = :used', ExpressionAttributeValues: {':hash': invite.token_hash, ':used': invite.used}};
  return invite.used === false ? [{Update: {Key, UpdateExpression: 'SET used = :yes', ...same, ExpressionAttributeValues: {...same.ExpressionAttributeValues, ':yes': true}}}] : [{ConditionCheck: {Key, ...same}}];
}
// `reactivate` is false for a sign-in: it may only create a membership that does not exist, and the write itself requires
// that (attribute_not_exists), so a membership created and then removed while the sign-in was in flight is left removed.
// SCIM passes true: setting a user active is the explicit action that brings a removed or deactivated member back.
async function provision(store, org, account, role, context, action, guard = [], reactivate = false) {
  // In a personal organization the owner is the account itself and has no membership row; neither sign-in nor SCIM makes one.
  if (account === org) return {created: false, role: 'owner', active: true};
  const old = await store._get(memberKey(org, account)); if (old && (old.active === true || !reactivate)) return {created: false, role: old.role, active: old.active === true};
  const joined = await store._get({pk: pk(account), sk: 'WORKSPACE#JOIN#' + org}), version = (old?.version ?? -1) + 1;
  // Seats: active members, plus the account itself in a personal organization. A full organization provisions nobody.
  const seats = countLimit(await planId(store, org), 'seats'), admission = await seatAdmission(store, org, !old);
  if (seats !== null && admission.active >= seats) fail(409, 'member_capacity_or_conflict');
  try { await store._tx([
    {Put: {Item: {...memberKey(org, account), user_id: account, role, active: true, version, provisioned_by: context.source}, ConditionExpression: old ? '#v = :v AND active = :no' : 'attribute_not_exists(pk)', ...(old ? {ExpressionAttributeNames: {'#v': 'version'}, ExpressionAttributeValues: {':v': old.version, ':no': false}} : {})}},
    {Put: {Item: {pk: pk(account), sk: 'WORKSPACE#JOIN#' + org, owner: org}, ConditionExpression: 'attribute_not_exists(pk) OR #owner = :owner', ExpressionAttributeNames: {'#owner': 'owner'}, ExpressionAttributeValues: {':owner': org}}},
    // A deleted organization provisions nobody, even for a sign-in or SCIM request that was already in flight.
    admission.item,
    ...(!joined ? [{Update: {Key: {pk: pk(account), sk: 'WORKSPACE#CAPACITY'}, UpdateExpression: 'ADD #n :one', ConditionExpression: 'attribute_not_exists(#n) OR #n < :cap', ExpressionAttributeNames: {'#n': 'count'}, ExpressionAttributeValues: {':one': 1, ':cap': 19}}}] : []),
    auditPut(store.now(), {workspace: org, actor: context.actor, ip: context.ip}, action, account, {role}),
    ...await spendInvite(store, org, account), ...guard,
  ]); } catch (error) { if (conditional(error)) fail(409, 'member_capacity_or_conflict'); throw error; }
  return {created: true, role, active: true};
}
async function deactivate(store, org, account, context, guard = []) {
  if (account === org) fail(409, 'owner_not_managed_by_scim');
  const old = await store._get(memberKey(org, account)), spent = await spendInvite(store, org, account);
  if (old?.active && old.role === 'owner') fail(409, 'owner_not_managed_by_scim');
  // "Nothing to deactivate" is a claim about the membership too, so it is checked in a transaction like a change is: the
  // membership must still be absent, or still the inactive version that was read. An invitation accepted between the read
  // and this check fails it (409) and the retry deactivates the membership that acceptance made.
  const names = {'#v': 'version'}, member = old?.active ? [{Put: {Item: {...old, active: false, version: old.version + 1}, ConditionExpression: '#v = :v AND active = :yes', ExpressionAttributeNames: names, ExpressionAttributeValues: {':v': old.version, ':yes': true}}},
    auditPut(store.now(), {workspace: org, actor: context.actor, ip: context.ip}, 'scim.user_deactivated', account, {role: old.role})]
    : [{ConditionCheck: {Key: memberKey(org, account), ...(old ? {ConditionExpression: '#v = :v AND active = :no', ExpressionAttributeNames: names, ExpressionAttributeValues: {':v': old.version, ':no': false}} : {ConditionExpression: 'attribute_not_exists(pk)'})}}];
  try { await store._tx([...member, ...spent, ...guard]); }
  catch (error) { if (conditional(error)) fail(409, 'member_capacity_or_conflict'); throw error; }
  return old?.active === true;
}
/**
 * Called after a valid SAML response for an organization: a person the organization has never seen becomes a member with
 * its default role. Signing in never undoes a decision: a membership the owner removed or SCIM deactivated stays inactive,
 * and a SCIM user who is not active (or was deleted) is not admitted. Only the owner or SCIM can bring those back.
 */
export async function joinBySso(env, sso, account) {
  const store = env.store, member = await store._get(memberKey(sso.org, account)); if (member) return {created: false, role: member.role, active: member.active === true};
  const user = await store._get(userKey(sso.org, account)); if (user && (user.active !== true || user.deleted === true)) return {created: false, active: false};
  // The join commits only if SCIM still has no inactive or deleted record for this person. SCIM writes that record before it
  // touches the membership, so whichever of the two runs second sees the other: an inactive SCIM user never ends up a member.
  const scimAllows = {ConditionCheck: {Key: userKey(sso.org, account), ConditionExpression: 'attribute_not_exists(pk) OR (active = :yes AND attribute_not_exists(deleted))', ExpressionAttributeValues: {':yes': true}}};
  // And only while the organization's SSO settings are the ones the SAML response was checked against: the same IdP, the
  // same verified domains, the same default role. A response that is overtaken by a settings change joins nobody.
  const sameIdp = {ConditionCheck: {Key: configKey(sso.org), ConditionExpression: 'updated_at = :seen', ExpressionAttributeValues: {':seen': sso.config_version}}};
  try { return await provision(store, sso.org, account, sso.default_role, {actor: account, ip: env.sourceIp, source: 'sso'}, 'sso.member_joined', [scimAllows, sameIdp]); }
  catch (error) { if (error.code === 'member_capacity_or_conflict') return {created: false, active: false}; throw error; }
}

// ---- SCIM 2.0 Users: /api/scim/v2 ---------------------------------------------------------------------------------
const SCIM_USER = 'urn:ietf:params:scim:schemas:core:2.0:User', SCIM_LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse', SCIM_ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';
const scim = (body, status = 200) => new Response(body === null ? null : JSON.stringify(body), {status, headers: securityHeaders(body === null ? {} : {'Content-Type': 'application/scim+json'})});
const scimError = (status, detail, scimType) => scim({schemas: [SCIM_ERROR], status: String(status), detail, ...(scimType ? {scimType} : {})}, status);
const userKey = (org, id) => ({pk: pk(org), sk: 'SCIMUSER#' + id});
const iso = seconds => new Date(seconds * 1000).toISOString();
const resource = (row, origin) => ({schemas: [SCIM_USER], id: row.tenant_id, userName: row.user_name, ...(row.external_id ? {externalId: row.external_id} : {}), active: row.active === true,
  emails: [{value: row.user_name, primary: true}], meta: {resourceType: 'User', created: iso(row.created_at), lastModified: iso(row.updated_at), location: origin + '/api/scim/v2/Users/' + row.tenant_id}});
export async function scimApi(request, env) {
  try {
    const store = env.store, url = new URL(request.url), path = url.pathname.slice('/api/scim/v2'.length) || '/', origin = env.APP_ORIGIN;
    const bearer = /^Bearer (\S+)$/i.exec(request.headers.get('authorization') || ''), token = bearer ? bearer[1] : request.headers.get('x-supatrace-key') || '';
    if (!SCIM_TOKEN.test(token)) return scimError(401, 'A SCIM bearer token is required.');
    const hash = digest(token), row = await store._get({pk: 'SCIM#' + hash, sk: 'TOKEN'}), config = row ? await store._get(configKey(row.org)) : null;
    // The index row alone is not enough: the organization's configuration must still name this token.
    if (!row || row.token_hash !== hash || config?.scim_token_hash !== hash) return scimError(401, 'The SCIM token is not valid.');
    // The token of a deleted organization is dead (deleting removes its index row; this covers a request already in flight).
    if (Number.isSafeInteger((await store._get({pk: pk(row.org), sk: 'WORKSPACE#META'}))?.deleted_at)) return scimError(401, 'The SCIM token is not valid.');
    const rate = await store.consumeRate({scope: 'scim', identity: hash, limit: 120, windowSeconds: 60}); if (!rate.allowed) return scimError(429, 'Too many requests.');
    // Off-plan, SCIM stops giving access but keeps taking it away: reads, deactivation and DELETE of existing users still
    // work, so a person who leaves the company is still removed after the organization leaves Enterprise. Creating a user
    // and setting one active are refused.
    const offPlan = !hasFeature(await planId(store, row.org), 'scim'), notInPlan = () => scimError(403, 'SCIM provisioning is not included in this organization\'s plan. Deactivating and deleting users still works.');
    const org = row.org, context = {actor: 'scim:' + hash.slice(0, 12), ip: env.sourceIp, source: 'scim'}, domains = verifiedDomains(config).filter(domain => !deploymentDomains(env).includes(domain));
    if (request.method === 'GET' && path === '/ServiceProviderConfig') return scim({schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'], patch: {supported: true}, bulk: {supported: false, maxOperations: 0, maxPayloadSize: 0}, filter: {supported: true, maxResults: SSO_LIMITS.scimPage}, changePassword: {supported: false}, sort: {supported: false}, etag: {supported: false}, authenticationSchemes: [{type: 'oauthbearertoken', name: 'Bearer token', description: 'The SCIM token created in the organization SSO settings.'}]});
    const body = async () => { let value; try { value = JSON.parse(await new Response(request.body).text().then(text => text.length > 16384 ? fail(413, 'too_large') : text)); } catch (error) { if (error instanceof HttpError) throw error; fail(400, 'invalid_json'); } if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_json'); return value; };
    // Deleted users stay as hidden rows. They still count toward the cap, so deleting and recreating cannot mint accounts without limit.
    // Every SCIM record write is conditioned on the version it read, and every membership change SCIM makes is conditioned on
    // the record still being the version that change was derived from. Two SCIM requests for one user therefore cannot
    // interleave into a membership the latest record does not describe: the loser gets 409 and the IdP retries.
    const bump = row => Math.max(store.now(), (row?.updated_at ?? 0) + 1);
    // Every SCIM write also requires that the organization's SSO settings are still the ones this request was authenticated
    // and validated against: the same token, verified domains and default role. A request that was authenticated just before
    // the owner replaced the token, or removed a domain, cannot write after that change; it gets 401 or 409.
    const tokenLive = {ConditionCheck: {Key: configKey(org), ConditionExpression: 'scim_token_hash = :token AND updated_at = :seen', ExpressionAttributeValues: {':token': hash, ':seen': config.updated_at}}};
    const still = row => [{ConditionCheck: {Key: userKey(org, row.tenant_id), ConditionExpression: 'updated_at = :version', ExpressionAttributeValues: {':version': row.updated_at}}}, tokenLive];
    const apply = row => row.active === true && row.deleted !== true ? provision(store, org, row.tenant_id, config.default_role ?? 'viewer', context, 'scim.user_provisioned', still(row), true) : deactivate(store, org, row.tenant_id, context, still(row));
    const write = async (row, seen) => { try { await store._tx([{Put: {Item: row, ConditionExpression: seen ? 'updated_at = :seen' : 'attribute_not_exists(pk)', ...(seen ? {ExpressionAttributeValues: {':seen': seen.updated_at}} : {})}}, tokenLive]); } catch (error) { if (conditional(error)) fail(409, 'scim_user_changed'); throw error; } return row; };
    // SCIM never deactivates or deletes the owner, and says so before it writes anything. (deactivate() checks again inside its own write.)
    const notOwner = async id => { if (id === org || (await store._get(memberKey(org, id)))?.role === 'owner') fail(409, 'owner_not_managed_by_scim'); };
    const every = async () => (await store._page(pk(org), 'SCIMUSER#', {limit: SSO_LIMITS.scimPage})).items, all = async () => (await every()).filter(user => user.deleted !== true);
    if (path === '/Users' && request.method === 'GET') {
      const filter = url.searchParams.get('filter'); let rows = await all();
      if (filter !== null) { const match = /^userName eq "([^"\\]{1,254})"$/.exec(filter); if (!match) return scimError(400, 'Only the filter userName eq "value" is supported.', 'invalidFilter'); rows = rows.filter(user => user.user_name === match[1].toLowerCase()); }
      const start = Math.max(1, Number(url.searchParams.get('startIndex') ?? 1) || 1), count = Math.min(SSO_LIMITS.scimPage, Math.max(0, Number(url.searchParams.get('count') ?? SSO_LIMITS.scimPage) || 0)), page = rows.slice(start - 1, start - 1 + count);
      return scim({schemas: [SCIM_LIST], totalResults: rows.length, startIndex: start, itemsPerPage: page.length, Resources: page.map(user => resource(user, origin))});
    }
    if (path === '/Users' && request.method === 'POST') {
      const data = await body(), email = typeof data.userName === 'string' ? data.userName.trim().toLowerCase() : '';
      // Off-plan nothing is created: not a member, and not an inactive record or account either.
      if (offPlan) return notInPlan();
      if (!EMAIL.test(email) || email.length > 254) return scimError(400, 'userName must be an email address.', 'invalidValue');
      if (!domains.includes(email.split('@')[1])) return scimError(400, 'userName must be in a domain this organization has verified.', 'invalidValue');
      if (data.externalId !== undefined && (typeof data.externalId !== 'string' || data.externalId.length > 256 || /[\u0000-\u001f\u007f]/.test(data.externalId))) return scimError(400, 'externalId is not valid.', 'invalidValue');
      // Each SCIM user is an account. The cap matches the member limit, so a token cannot use up the service's account capacity.
      const known = (await every()).find(user => user.user_name === email);
      if (known && known.deleted !== true) return scimError(409, 'A user with this userName already exists.', 'uniqueness');
      // Each new address is an account. A place is reserved for the address, atomically with the count, before the account exists,
      // and the reservation is kept for good: concurrent requests and create-then-delete cannot mint more than the cap.
      if (!known) {
        const slot = {pk: pk(org), sk: 'SCIMSLOT#' + digest(email)};
        try { await store._tx([{Put: {Item: {...slot, reserved_at: store.now()}, ConditionExpression: 'attribute_not_exists(pk)'}},
          {Update: {Key: {pk: pk(org), sk: 'SCIM#CAPACITY'}, UpdateExpression: 'ADD #n :one', ConditionExpression: 'attribute_not_exists(#n) OR #n < :cap', ExpressionAttributeNames: {'#n': 'count'}, ExpressionAttributeValues: {':one': 1, ':cap': SSO_LIMITS.scimUsers}}}, tokenLive]); }
        catch (error) { if (!conditional(error)) throw error; const current = await store._get(configKey(org)); if (current?.scim_token_hash !== hash) return scimError(401, 'The SCIM token is not valid.'); if (current.updated_at !== config.updated_at) fail(409, 'scim_user_changed'); if (!await store._get(slot)) return scimError(409, 'This organization has used its ' + SSO_LIMITS.scimUsers + ' SCIM users.', 'tooMany'); }
      }
      const account = (await store.getOrCreateSsoTenant(email)).tenant_id, active = data.active !== false, now = store.now(); if (!active) await notOwner(account);
      // The SCIM record is written first and the membership second. A sign-in that races this request either sees the record
      // (and is refused when it says inactive) or has already joined (and is deactivated just below).
      const user = {...userKey(org, account), tenant_id: account, user_name: email, ...(data.externalId ? {external_id: data.externalId} : {}), active, created_at: now, updated_at: bump(known)};
      try { await write(user, known ?? null); } catch (error) { if (error.code === 'scim_user_changed') return scimError(409, 'A user with this userName already exists.', 'uniqueness'); throw error; }
      await apply(user);
      return scim(resource(user, origin), 201);
    }
    const match = /^\/Users\/((?:sso)-[a-f0-9]{64})$/.exec(path);
    if (!match) return scimError(404, 'Not found.');
    const user = await store._get(userKey(org, match[1])); if (!user) return scimError(404, 'User not found.');
    // A repeated DELETE finishes the job: if the first attempt wrote the deleted record and then failed before the membership
    // was deactivated, the retry deactivates it. Every other method sees a deleted user as gone.
    if (user.deleted === true) { if (request.method !== 'DELETE') return scimError(404, 'User not found.'); await apply(user); return scim(null, 204); }
    if (request.method === 'GET') return scim(resource(user, origin));
    const setActive = async active => {
      if (offPlan && active === true) fail(403, 'scim_not_in_plan');
      // Record first, membership second (see create). The membership is brought in line every time, even when the record already matched.
      if (!active) await notOwner(user.tenant_id);
      // Activation is provisioning, so it has the same domain rule as create: the address must be in a domain the organization
      // has verified now and the deployment's IdP does not own. Deactivating and deleting stay possible for any stored user.
      else if (!domains.includes(String(user.user_name).split('@')[1])) fail(400, 'userName is no longer in a domain this organization has verified.');
      const next = active !== user.active ? await write({...user, active, updated_at: bump(user)}, user) : user;
      await apply(next); return next;
    };
    if (request.method === 'PUT') { const data = await body(); if (typeof data.active !== 'boolean') return scimError(400, 'active must be true or false.', 'invalidValue'); return scim(resource(await setActive(data.active), origin)); }
    if (request.method === 'PATCH') {
      const data = await body(); let active;
      for (const op of Array.isArray(data.Operations) ? data.Operations : []) {
        if (String(op?.op).toLowerCase() !== 'replace') return scimError(400, 'Only replace of active is supported.', 'invalidValue');
        const value = op.path === 'active' ? op.value : op.path === undefined && op.value && typeof op.value === 'object' ? op.value.active : undefined;
        if (value === true || value === 'true' || value === 'True') active = true; else if (value === false || value === 'false' || value === 'False') active = false; else return scimError(400, 'Only replace of active is supported.', 'invalidValue');
      }
      if (active === undefined) return scimError(400, 'Only replace of active is supported.', 'invalidValue');
      return scim(resource(await setActive(active), origin));
    }
    if (request.method === 'DELETE') { await notOwner(user.tenant_id); await apply(await write({...user, active: false, deleted: true, updated_at: bump(user)}, user)); return scim(null, 204); }
    return scimError(405, 'Method not allowed.');
  } catch (error) {
    if (error?.code === 'scim_not_in_plan') return scimError(403, 'SCIM provisioning is not included in this organization\'s plan. Deactivating and deleting users still works.');
    if (error instanceof HttpError || Number.isInteger(error?.status)) return scimError(error.status, error.code || 'Request failed.');
    return scimError(503, 'Temporarily unavailable.');
  }
}
