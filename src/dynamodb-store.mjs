import {effectivePlanId, stripePlanMatches, stripeStateFence, planUsagePrefix} from './stripe-plan-state.mjs';
import {checkoutScope} from './billing-principal.mjs';
import {validateSandboxEntitlementConfiguration,sandboxEntitlementDecision,TEST_PLAN_SOURCE} from './stripe-sandbox-entitlements.mjs';
import {commercialRiskIntent} from './commercial-risk.mjs';
import {commercialDecision} from './commercial-fulfillment.mjs';
import {validateCommercialPolicy} from './commercial-policy.mjs';
import {buildStripeTestCheckout,stripeTestDecision} from './stripe-test-checkout.mjs';
import {stripeTestIntent,restoreStripeTestStoredIntent} from './stripe-test-webhook.mjs';
import { createHash, randomBytes } from 'node:crypto';
import {alphaProject,requireAlphaProject,requireProject} from './alpha-projects.mjs';
import {KEY_PREFIX,NO_EXPIRY,KEY_LIFETIME,ROTATION_OVERLAP} from './key-model.mjs';
import {requireCount,requireFeature} from './entitlements.mjs';
import {retentionDays,RETENTION_MAX_DAYS,PLAN_LIMITS,planLimits,usagePeriod,UPGRADE_PATH,spendCap,usageAlertLevel,USAGE_ALERT_LEVELS,IDLE_PAUSE,RESUME_PATH,projectLifecycle} from './plan-limits.mjs';
import {auditPut,auditKeyPrefix} from './audit.mjs';
import {acceptedOverage,planFence,requireOverageBinding} from './plan-overage.mjs';

export class StoreError extends Error {
  constructor(status, code, details) { super(code); this.name = 'StoreError'; this.status = status; this.code = code; if (details) this.details = details; }
}
const fail = (status, code, details) => { throw new StoreError(status, code, details); };
export const digest = value => createHash('sha256').update(value).digest('hex');
const billingScopeHash=(value,tenantId)=>value===undefined?undefined:digest(JSON.stringify(checkoutScope(value,tenantId,value?.origin)));
function requireBillingScope(row,value,tenantId){
  const expected=billingScopeHash(value,tenantId);
  if(billingScopeHash(row.checkout_scope,tenantId)!==expected||row.checkout_scope_hash!==expected)fail(409,'billing_scope_mismatch');
}
const random = () => randomBytes(32).toString('base64url');
const absent = 'attribute_not_exists(pk)';
export const ACCESS_TOKEN_CAP = 20;
export const ORGANIZATION_SERVICE_CAP = 1000;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : fail(400, 'invalid_hash');
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) ? value : fail(400, 'invalid_id');
const keyLifetime = value => value === null || value === undefined ? null : Number.isSafeInteger(value) && value >= KEY_LIFETIME.min && value <= KEY_LIFETIME.max ? value : fail(400, 'invalid_key_expiry');
const positive = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value > 0 && value <= max ? value : fail(400, 'invalid_count');
const tenant = value => {
  if (typeof value === 'string' && /^github-[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(Number(value.slice(7)))) return value;
  if (typeof value === 'string' && /^(google|email|chatgpt|sso)-[a-f0-9]{64}$/.test(value)) return value;
  if (typeof value === 'string' && /^org-[a-f0-9]{32}$/.test(value)) return value;
  fail(400, 'invalid_tenant');
};
const tpk = value => `TENANT#${tenant(value)}`;
const tenantKey = value => ({ pk: tpk(value), sk: 'META' });
const epochCondition = epoch => epoch === 0 ? '(attribute_not_exists(session_epoch) OR session_epoch = :epoch)' : 'session_epoch = :epoch';
const epochValue = value => Number.isSafeInteger(value) && value >= 0 ? value : fail(409, 'session_changed');
/** The SSO binding stored on a session or MFA challenge row: {org, idp_version}, or null when the sign-in was not an organization SSO sign-in. */
export const ssoBinding = row => typeof row?.sso_org === 'string' && Number.isSafeInteger(row.sso_idp_version) ? { org: row.sso_org, idp_version: row.sso_idp_version } : null;
const ssoFields = sso => { if (sso == null) return {}; if (typeof sso.org !== 'string' || !sso.org || !Number.isSafeInteger(sso.idp_version)) fail(409, 'session_changed'); return { sso_org: sso.org, sso_idp_version: sso.idp_version }; };
const globalKey = { pk: 'SYS', sk: 'CAPACITY' };
function runSummary(trace, current, row) {
  if (!trace || typeof trace !== 'object') return null;
  if (!Number.isFinite(trace.started_at) || !Number.isFinite(trace.ended_at)) return null;
  // A legacy run can already contain accepted batches without summary fields.
  // Its next batch must not turn a partial summary into whole-run totals/status.
  if(current?.batch_count>0&&(!Number.isFinite(current.started_at)||!Number.isFinite(current.ended_at)||!Number.isSafeInteger(current.event_count)||current.event_count<0||!Number.isSafeInteger(current.byte_count)||current.byte_count<0||typeof current.has_error!=='boolean'||!Array.isArray(current.writers)))return null;
  const writer = typeof trace.writer === 'string' && /^[a-f0-9]{64}$/.test(trace.writer) ? trace.writer : null;
  const prior = Array.isArray(current?.writers) ? current.writers.filter(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) : [];
  const writers = [...new Set(writer ? [...prior, writer] : prior)].sort();
  const started = Math.min(Number.isFinite(current?.started_at) ? current.started_at : trace.started_at, trace.started_at);
  const ended = Math.max(Number.isFinite(current?.ended_at) ? current.ended_at : trace.ended_at, trace.ended_at);
  return {
    ':started': started, ':ended': ended,
    ':err': current?.has_error === true || trace.has_error === true,
    ':writers': writers, ':events': row.event_count, ':bytes': row.byte_count,
    ':prev': Number.isSafeInteger(current?.batch_count) && current.batch_count >= 0 ? current.batch_count : 0
  };
}
const conditional = error => error?.name === 'ConditionalCheckFailedException' ||
  (error?.name === 'TransactionCanceledException' && error.CancellationReasons?.some(reason => reason.Code === 'ConditionalCheckFailed'));
const isTransactionCancellation = error => conditional(error) || error?.name === 'TransactionCanceledException';
const leaseKey = (value, slot) => ({ pk: tpk(value), sk: `SLOT#${String(slot).padStart(3, '0')}` });
const keyLookup = value => ({ pk: `WRITE#${hash(value)}`, sk: 'KEY' });
// Older ephemeral kinds use fixed slots. LINK keys use the full digest; mail rate limits bound their creation.
const ephemeralSlots = 1000;
const tempKey = (kind, value, sk) => ({ pk: `${kind}#${kind === 'LINK' ? hash(value) : Number(BigInt(`0x${hash(value)}`) % BigInt(ephemeralSlots))}`, sk });
const setupKey = value => tempKey('SETUP', value, 'REQUEST');
const codeKey = value => tempKey('CODE', digest(value), 'REQUEST');
const batchKey = (value, batchId) => ({ pk: tpk(value), sk: `BATCH#${id(batchId)}` });
// One counter row per account per UTC calendar month. A new month is a new row, so the allowance resets without a job.
const periodKey = (value, periodId, mode) => ({ pk: tpk(value), sk: planUsagePrefix(mode) + periodId });
const counter = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
// Stripe test-meter reporting state for one account and month. Separate from the usage row so reporting never rewrites a counter.
const meterKey = (value, periodId) => ({ pk: tpk(value), sk: `METER#${periodId}` });
// Spans one account can reserve at once: 30 uploads a minute x 100 events a batch.
const ALERT_RECONCILE_SPANS = 3000;
const pauseNoticeKey = (value, pausedAt) => ({ pk: tpk(value), sk: `NOTICE#PAUSE#${String(pausedAt).padStart(12, '0')}` });
const noticePrefix = (periodId, mode) => `NOTICE#${mode === 'live' ? 'live#' : ''}${periodId}#USAGE#`;
const noticeKey = (value, periodId, level, mode) => ({ pk: tpk(value), sk: noticePrefix(periodId, mode) + String(level).padStart(3, '0') });
function printableSubject(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 255) return false;
  for (const char of value) { const code = char.codePointAt(0); if (code <= 32 || code === 127) return false; }
  return true;
}
const samlCacheKey = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value) ? value : fail(400, 'invalid_id');

/** One PK/SK table. All times are integer epoch seconds. No S3 payloads or raw write keys. */
export class DynamoMetadataStore {
  constructor({ client, commands, tableName, now = () => Math.floor(Date.now() / 1000),
    tenantBytes = 10 * 1024 * 1024, accountCeilingBytes = null, globalBytes = 100 * 1024 * 1024,
    accounts = 100, activeKeys = 100, rateSlots = 5000, stripeTestInbox = false, stripeTestEnvironment = null, stripeInboxTableName = null, stripeStateTableName = null, commercialControls = null, stripeSandboxEntitlements = null } = {}) {
    if (!client?.send || typeof tableName !== 'string' || !tableName || !commands) throw new TypeError('client, commands and tableName required');
    for (const name of ['GetCommand', 'PutCommand', 'DeleteCommand', 'UpdateCommand', 'QueryCommand', 'TransactWriteCommand'])
      if (typeof commands[name] !== 'function') throw new TypeError(`${name} required`);
    const commercial=commercialControls?.enabled===true?validateCommercialPolicy(commercialControls.policy,commercialControls.policyHash):null;if(commercial&&(!stripeStateTableName||commercial.policy.livemode!==true))throw new TypeError('explicit live commercial state required');Object.defineProperty(this,'commercialPolicy',{value:commercial});
    if(stripeStateTableName!==null&&(typeof stripeStateTableName!=='string'||!/^[-A-Za-z0-9_.]{3,255}$/.test(stripeStateTableName)||stripeStateTableName===tableName||stripeStateTableName===stripeInboxTableName||(stripeTestInbox!==true&&commercialControls?.enabled!==true)))throw new TypeError('distinct enabled billing state table required');Object.defineProperty(this,'stripeStateTableName',{value:stripeStateTableName});
    if(stripeInboxTableName!==null&&(typeof stripeInboxTableName!=='string'||!/^[-A-Za-z0-9_.]{3,255}$/.test(stripeInboxTableName)||stripeInboxTableName===tableName))throw new TypeError('distinct billing inbox table required');Object.defineProperty(this,'stripeInboxTableName',{value:stripeInboxTableName});
    if(typeof stripeTestInbox!=='boolean')throw new TypeError('stripeTestInbox must be boolean');if(stripeTestInbox&&(typeof stripeTestEnvironment!=='string'||!/^[-A-Za-z0-9_]{1,100}$/.test(stripeTestEnvironment)))throw new TypeError('explicit Stripe sandbox environment required');Object.defineProperty(this,'stripeTestEnvironment',{value:stripeTestEnvironment,enumerable:true});Object.defineProperty(this,'stripeTestInbox',{value:stripeTestInbox,enumerable:true});
    const sandboxPolicy=validateSandboxEntitlementConfiguration(stripeSandboxEntitlements,tenantBytes);
    if(sandboxPolicy&&(!stripeTestInbox||!stripeStateTableName||!stripeInboxTableName||commercial||sandboxPolicy.policy.environment_id!==stripeTestEnvironment))throw new TypeError('isolated sandbox entitlement store required');
    Object.defineProperty(this,'sandboxEntitlementPolicy',{value:sandboxPolicy});
    this.client = client; this.commands = commands; this.table = tableName; this.now = now;
    // tenantBytes stays the legacy byte_limit stamped on new rows and the commercial ceiling. It bounds the
    // plan stored-byte allowance only when an operator passes accountCeilingBytes explicitly.
    this.limits = { tenantBytes: positive(tenantBytes), accountCeilingBytes: accountCeilingBytes === null ? null : positive(accountCeilingBytes), globalBytes: positive(globalBytes), accounts: positive(accounts),
      activeKeys: positive(activeKeys, 100), rateSlots: positive(rateSlots, 100000) };
  }
  _tableForKey(key){return this.stripeStateTableName&&((key?.pk?.startsWith('STRIPETEST#')||key?.pk?.startsWith('COMMERCIAL#'))||key?.pk?.startsWith('TENANT#')&&key?.sk?.startsWith('STRIPETEST#'))?this.stripeStateTableName:this.table;}
  _send(name, input) { return this.client.send(new this.commands[name]({ TableName: this._tableForKey(input.Key||input.Item), ...input })); }
  async _get(Key) { return (await this._send('GetCommand', { Key, ConsistentRead: true })).Item ?? null; }
  _tx(items) { return this.client.send(new this.commands.TransactWriteCommand({ TransactItems: items.map(item => {
    const [kind, input] = Object.entries(item)[0]; return { [kind]: { TableName: this._tableForKey(input.Key||input.Item), ...input } };
  }) })); }
  // A request sets `audit` ({workspace, actor, ip}) on its own derived store. The event then joins the transaction that makes the change.
  _auditItems(action, target = null, detail = {}) { return this.audit ? [auditPut(this.now(), this.audit, action, target, detail)] : []; }
  async getTenant(tenantId) { return this._get(tenantKey(tenantId)); }

  /**
   * Transaction items that create the tenant partition of a new organization. The caller adds the workspace, owner
   * membership and audit items so the whole organization appears in one transaction. Organizations have their own
   * service-wide counter and do not use the alpha account cap.
   */
  /**
   * True when the tenant has a customer binding from the older billing sandbox. Those rows live under the tenant's
   * partition with a STRIPETEST# sort key, in the billing state table when one is configured and otherwise in the
   * main table, so both are asked.
   */
  async hasStripeTestBinding(tenantId) {
    tenant(tenantId);
    for (const TableName of new Set([this.table, this.stripeStateTableName].filter(Boolean))) {
      const result = await this.client.send(new this.commands.QueryCommand({ TableName, KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': tpk(tenantId), ':prefix': 'STRIPETEST#' }, ConsistentRead: true, Limit: 1 }));
      if (result.Items?.length) return true;
    }
    return false;
  }
  /** The service-wide organization count goes down when an organization is deleted. */
  organizationRemovalItems() {
    return [{ Update: { Key: globalKey, UpdateExpression: 'ADD #n :minus', ConditionExpression: '#n >= :one', ExpressionAttributeNames: { '#n': 'organizations' }, ExpressionAttributeValues: { ':minus': -1, ':one': 1 } } }];
  }
  organizationTenantItems(orgId, ownerAccount) {
    if (!/^org-[a-f0-9]{32}$/.test(orgId)) fail(400, 'invalid_organization'); tenant(ownerAccount);
    return [
      { Put: { Item: { ...tenantKey(orgId), tenant_id: orgId, provider: 'organization', owner_account: ownerAccount, project_id: alphaProject(orgId).id, created_at: this.now(), byte_limit: this.limits.tenantBytes, used_bytes: 0 }, ConditionExpression: absent } },
      { Update: { Key: globalKey, UpdateExpression: 'ADD #n :one', ConditionExpression: 'attribute_not_exists(#n) OR #n < :cap',
        ExpressionAttributeNames: { '#n': 'organizations' }, ExpressionAttributeValues: { ':one': 1, ':cap': ORGANIZATION_SERVICE_CAP } } }
    ];
  }
  /** `guards` are extra transaction conditions for creating the account (identity-links.mjs: the identity must not be linked elsewhere). */
  async _provisionTenant(tenantId, identity, guards = []) {
    const Key = tenantKey(tenantId);
    let row = await this._get(Key); if (Number.isSafeInteger(row?.deleted_at)) fail(403, 'account_closed'); if (row) return row;
    row = { ...Key, tenant_id: tenantId, ...identity, project_id: alphaProject(tenantId).id, created_at: this.now(), byte_limit: this.limits.tenantBytes, used_bytes: 0 };
    try {
      await this._tx([
        { Put: { Item: row, ConditionExpression: absent } },
        ...guards,
        { Update: { Key: globalKey, UpdateExpression: 'ADD #n :one',
          ConditionExpression: 'attribute_not_exists(#n) OR #n < :cap', ExpressionAttributeNames: { '#n': 'accounts' },
          ExpressionAttributeValues: { ':one': 1, ':cap': this.limits.accounts } } }
      ]); return row;
    } catch (error) {
      // Also resolves an ambiguous successful transaction; never create another account blindly.
      const existing = await this._get(Key); if (Number.isSafeInteger(existing?.deleted_at)) fail(403, 'account_closed'); if (existing) return existing;
      if (conditional(error)) fail(429, 'account_capacity'); throw error;
    }
  }

  /** Call only with the numeric subject from the verified GitHub /user response. */
  async getOrCreateTenant(githubSubject, guards = []) {
    if (!Number.isSafeInteger(githubSubject) || githubSubject <= 0) fail(401, 'identity_not_verified');
    return this._provisionTenant(`github-${githubSubject}`, { provider: 'github', github_subject: githubSubject }, guards);
  }

  /** Call only with the sub string from Google's userinfo response. The id is a hash so it cannot collide with a GitHub account. */
  async getOrCreateGoogleTenant(subject, guards = []) {
    if (typeof subject !== 'string' || !/^[A-Za-z0-9._~-]{1,255}$/.test(subject)) fail(401, 'identity_not_verified');
    return this._provisionTenant(`google-${digest(subject)}`, { provider: 'google', google_subject: subject }, guards);
  }

  /** Call only with a verified ChatGPT userinfo sub. The id is a hash of that subject. */
  async getOrCreateChatGptTenant(subject) {
    if (!printableSubject(subject)) fail(401, 'identity_not_verified');
    return this._provisionTenant(`chatgpt-${digest(subject)}`, { provider: 'chatgpt', chatgpt_subject: subject });
  }

  /** Call only with the email NameID from a verified SSO assertion. */
  async getOrCreateSsoTenant(email) {
    if (typeof email !== 'string' || !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email) || email.length > 254) fail(401, 'identity_not_verified');
    return this._provisionTenant(`sso-${digest(email)}`, { provider: 'sso', email });
  }

  emailKey(email) { return { pk: `EMAIL#${digest(email)}`, sk: 'LOGIN' }; }

  async getEmailAccount(email) {
    if (typeof email !== 'string') return null;
    const row = await this._get(this.emailKey(email));
    return row && row.email === email ? row : null;
  }

  /** Creates the account, and counts it toward the alpha cap, only after the address is confirmed. */
  async createVerifiedEmailAccount(email, passwordHash) {
    if (typeof email !== 'string' || !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email) || email.length > 254) fail(400, 'invalid_email');
    if (typeof passwordHash !== 'string' || passwordHash.length < 20 || passwordHash.length > 500) fail(400, 'invalid_hash');
    if (await this.getEmailAccount(email)) fail(409, 'email_already_registered');
    const tenantId = `email-${digest(email)}`;
    await this._provisionTenant(tenantId, { provider: 'email', email });
    try {
      await this._send('PutCommand', { Item: { ...this.emailKey(email), email, tenant_id: tenantId, password_hash: passwordHash, verified: true }, ConditionExpression: absent });
    } catch (error) { if (conditional(error)) fail(409, 'email_already_registered'); throw error; }
    return { tenant_id: tenantId, email, verified: true };
  }

  /** A verified link may create an email account without setting a password. */
  async createPasswordlessEmailAccount(email) {
    if (typeof email !== 'string' || !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email) || email.length > 254) fail(400, 'invalid_email');
    const existing = await this.getEmailAccount(email);
    if (existing) return { ...existing, new_account: false };
    const tenantId = `email-${digest(email)}`;
    await this._provisionTenant(tenantId, { provider: 'email', email });
    const account = { ...this.emailKey(email), email, tenant_id: tenantId, verified: true };
    try {
      await this._send('PutCommand', { Item: account, ConditionExpression: absent });
    } catch (error) {
      if (!conditional(error)) throw error;
      const winner = await this.getEmailAccount(email);
      if (!winner) throw error;
      return { ...winner, new_account: false };
    }
    return { ...account, new_account: true };
  }

  async updateEmailAccount(email, expression, values) {
    await this._send('UpdateCommand', { Key: this.emailKey(email), UpdateExpression: expression,
      ConditionExpression: 'email = :email', ExpressionAttributeValues: { ...values, ':email': email } });
  }

  /** Password and revocation generation must commit together. Never retry an unknown result. */
  async resetEmailPassword(email, tenantId, passwordHash) {
    if (typeof email !== 'string' || !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email) || email.length > 254) fail(400, 'invalid_email');
    if (tenantId !== `email-${digest(email)}`) fail(400, 'invalid_tenant');
    if (typeof passwordHash !== 'string' || passwordHash.length < 20 || passwordHash.length > 500) fail(400, 'invalid_hash');
    await this._tx([
      { Update: { Key: this.emailKey(email), UpdateExpression: 'SET password_hash = :hash',
        ConditionExpression: 'email = :email AND tenant_id = :tenant AND verified = :yes',
        ExpressionAttributeValues: { ':hash': passwordHash, ':email': email, ':tenant': tenantId, ':yes': true } } },
      { Update: { Key: tenantKey(tenantId), UpdateExpression: 'ADD session_epoch :one',
        ConditionExpression: 'attribute_exists(pk) AND (attribute_not_exists(session_epoch) OR (session_epoch >= :zero AND session_epoch < :max))',
        ExpressionAttributeValues: { ':one': 1, ':zero': 0, ':max': Number.MAX_SAFE_INTEGER } } }
    ]);
  }

  async setTenantFields(tenantId, expression, values, expectedEpoch) {
    if (expectedEpoch !== undefined) epochValue(expectedEpoch);
    await this._send('UpdateCommand', { Key: tenantKey(tenantId), UpdateExpression: expression,
      ConditionExpression: 'attribute_exists(pk)' + (expectedEpoch === undefined ? '' : ' AND ' + epochCondition(expectedEpoch)),
      ExpressionAttributeValues: expectedEpoch === undefined ? values : { ...values, ':epoch': expectedEpoch } });
  }

  _challengeKind(kind) { return kind === 'MFA' || kind === 'SIGNUP' || kind === 'RESET' || kind === 'LINK' ? kind : fail(400, 'invalid_challenge'); }

  async replaceAuthChallenge(kind, idHash, fields, maxAge) {
    this._challengeKind(kind); hash(idHash);
    const expiresAt = this.now() + maxAge;
    this._expiry(expiresAt, maxAge);
    await this._send('PutCommand', { Item: { ...tempKey(kind, idHash, 'CHALLENGE'), id_hash: idHash, expires_at: expiresAt, ttl: expiresAt, misses: 0, ...fields } });
  }

  async createAuthChallenge(kind, idHash, fields, maxAge) {
    this._challengeKind(kind); hash(idHash);
    const expiresAt = this.now() + maxAge;
    this._expiry(expiresAt, maxAge);
    try { await this._send('PutCommand', { Item: { ...tempKey(kind, idHash, 'CHALLENGE'), id_hash: idHash, expires_at: expiresAt, ttl: expiresAt, misses: 0, ...fields },
      ConditionExpression: 'attribute_not_exists(pk) OR expires_at <= :now', ExpressionAttributeValues: { ':now': this.now() } }); }
    catch (error) { if (conditional(error)) fail(409, 'state_collision'); throw error; }
  }

  async peekAuthChallenge(kind, idHash) {
    if (kind !== 'MFA' && kind !== 'SIGNUP' && kind !== 'RESET' && kind !== 'LINK') return null;
    try { hash(idHash); } catch { return null; }
    const row = await this._get(tempKey(kind, idHash, 'CHALLENGE'));
    return row && row.id_hash === idHash && row.expires_at > this.now() ? row : null;
  }

  async createMfaChallenge(idHash, tenantId, expectedEpoch, sso = null) {
    hash(idHash); epochValue(expectedEpoch);
    const expiresAt = this.now() + 300;
    try {
      await this._tx([
        { ConditionCheck: { Key: tenantKey(tenantId), ConditionExpression: 'attribute_exists(pk) AND ' + epochCondition(expectedEpoch),
          ExpressionAttributeValues: { ':epoch': expectedEpoch } } },
        { Put: { Item: { ...tempKey('MFA', idHash, 'CHALLENGE'), id_hash: idHash, tenant_id: tenantId, session_epoch: expectedEpoch, expires_at: expiresAt, ttl: expiresAt, misses: 0, ...ssoFields(sso) },
          ConditionExpression: 'attribute_not_exists(pk) OR expires_at <= :now', ExpressionAttributeValues: { ':now': this.now() } } }
      ]);
    } catch (error) {
      const reasons = error?.CancellationReasons;
      if (error?.name === 'TransactionCanceledException' && Array.isArray(reasons) && reasons.length === 2) {
        if (reasons[0]?.Code === 'ConditionalCheckFailed') fail(409, 'session_changed');
        if (reasons[0]?.Code === 'None' && reasons[1]?.Code === 'ConditionalCheckFailed') fail(409, 'mfa_slot_collision');
      }
      throw error;
    }
  }

  async consumeAuthChallenge(kind, idHash) {
    this._challengeKind(kind); hash(idHash);
    try {
      const response = await this._send('DeleteCommand', { Key: tempKey(kind, idHash, 'CHALLENGE'),
        ConditionExpression: 'id_hash = :hash AND expires_at > :now',
        ExpressionAttributeValues: { ':hash': idHash, ':now': this.now() }, ReturnValues: 'ALL_OLD' });
      return response.Attributes ?? null;
    } catch (error) { if (conditional(error)) return null; throw error; }
  }

  /** Counts a wrong code. The `limit`th miss deletes the challenge. */
  async recordChallengeMiss(kind, idHash, limit) {
    this._challengeKind(kind); hash(idHash);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) fail(400, 'invalid_count');
    const Key = tempKey(kind, idHash, 'CHALLENGE');
    try {
      await this._send('UpdateCommand', { Key, UpdateExpression: 'ADD misses :one',
        ConditionExpression: 'id_hash = :hash AND expires_at > :now AND (attribute_not_exists(misses) OR misses < :cap)',
        ExpressionAttributeValues: { ':one': 1, ':hash': idHash, ':now': this.now(), ':cap': limit - 1 } });
      return { burned: false };
    } catch (error) { if (!conditional(error)) throw error; }
    try {
      await this._send('DeleteCommand', { Key, ConditionExpression: 'id_hash = :hash', ExpressionAttributeValues: { ':hash': idHash } });
    } catch (error) { if (!conditional(error)) throw error; }
    return { burned: true };
  }

  async saveSamlCache(cacheKey, value) {
    const key = samlCacheKey(cacheKey), now = this.now(), expiresAt = now + 8 * 3600;
    // Fixed slots must never evict another pending login (or refresh the same ID).
    // The condition is evaluated atomically by DynamoDB, not a read-before-write.
    try { await this._send('PutCommand', { Item: { ...tempKey('SAML', digest(key), 'CACHE'), cache_key: key, value: String(value), expires_at: expiresAt, ttl: expiresAt },
      ConditionExpression: 'attribute_not_exists(pk) OR expires_at <= :now', ExpressionAttributeValues: { ':now': now } }); }
    catch (error) { if (conditional(error)) fail(503, 'sso_request_busy'); throw error; }
  }

  async readSamlCache(cacheKey) {
    let key; try { key = samlCacheKey(cacheKey); } catch { return null; }
    const row = await this._get(tempKey('SAML', digest(key), 'CACHE'));
    return row && row.cache_key === key && row.expires_at > this.now() ? row.value : null;
  }

  async deleteSamlCache(cacheKey) {
    let key; try { key = samlCacheKey(cacheKey); } catch { return null; }
    try {
      const response = await this._send('DeleteCommand', { Key: tempKey('SAML', digest(key), 'CACHE'),
        ConditionExpression: 'cache_key = :key AND expires_at > :now',
        ExpressionAttributeValues: { ':key': key, ':now': this.now() }, ReturnValues: 'ALL_OLD' });
      return response.Attributes?.value ?? null;
    } catch (error) { if (conditional(error)) return null; throw error; }
  }

  async createOAuthState(stateHash, verifier, expiresAt = this.now() + 600, provider = 'github') {
    hash(stateHash); if (typeof verifier !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(verifier)) fail(400, 'invalid_verifier');
    if (provider !== 'github' && provider !== 'google' && provider !== 'chatgpt' && provider !== 'sso') fail(400, 'invalid_provider');
    this._expiry(expiresAt, 600);
    try { await this._send('PutCommand', { Item: { ...tempKey('OAUTH', stateHash, 'STATE'), state_hash: stateHash, verifier, provider, expires_at: expiresAt, ttl: expiresAt },
      ConditionExpression: 'attribute_not_exists(pk) OR expires_at <= :now', ExpressionAttributeValues: { ':now': this.now() } }); }
    catch (error) { if (conditional(error)) fail(409, 'state_collision'); throw error; }
  }
  async consumeOAuthState(stateHash, provider = 'github') {
    if (provider !== 'github' && provider !== 'google' && provider !== 'chatgpt' && provider !== 'sso') fail(400, 'invalid_provider');
    try {
      // A state written before provider was stored can still finish a GitHub login. Google requires its own provider tag.
      const legacy = provider === 'github' ? ' AND (attribute_not_exists(provider) OR provider = :provider)' : ' AND provider = :provider';
      const response = await this._send('DeleteCommand', { Key: tempKey('OAUTH', stateHash, 'STATE'),
        ConditionExpression: 'state_hash = :hash AND expires_at > :now' + legacy,
        ExpressionAttributeValues: { ':hash': stateHash, ':now': this.now(), ':provider': provider }, ReturnValues: 'ALL_OLD' });
      return response.Attributes?.verifier ?? null;
    } catch (error) { if (conditional(error)) return null; throw error; }
  }
  _expiry(expiresAt, maxAge) {
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now() || expiresAt > this.now() + maxAge) fail(400, 'invalid_expiry');
  }
  // `sso` records which organization's IdP, at which version of its settings, vouched for this sign-in. Only the SAML
  // callback passes it; "require SSO" compares it with the organization's current settings on every request.
  async createSession(tokenHash, tenantId, expiresAt = this.now() + 86400, expectedEpoch, sso = null) {
    hash(tokenHash); this._expiry(expiresAt, 86400);
    const tenantRow = await this._get(tenantKey(tenantId));
    if (!tenantRow || Number.isSafeInteger(tenantRow.deleted_at)) fail(409, 'session_collision_or_unknown_tenant');
    const epoch = tenantRow.session_epoch ?? 0;
    if (!Number.isSafeInteger(epoch) || epoch < 0 || (expectedEpoch !== undefined && expectedEpoch !== epoch)) fail(409, 'session_changed');
    const Key = tempKey('SESSION', tokenHash, 'SESSION');
    try {
      await this._tx([
        { ConditionCheck: { Key: tenantKey(tenantId), ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(deleted_at) AND ' + epochCondition(epoch),
          ExpressionAttributeValues: { ':epoch': epoch } } },
        { Put: { Item: { ...Key, token_hash: tokenHash, tenant_id: tenantId, session_epoch: epoch, expires_at: expiresAt, ttl: expiresAt, ...ssoFields(sso) },
          ConditionExpression: 'attribute_not_exists(pk) OR expires_at <= :now', ExpressionAttributeValues: { ':now': this.now() } } }
      ]);
    } catch (error) {
      // A fresh token is safe only after a known rejected slot write, never an
      // unknown outcome, tenant-epoch failure, or a possibly accepted own token.
      const reasons = error?.CancellationReasons;
      if (error?.name === 'TransactionCanceledException' && Array.isArray(reasons) && reasons.length === 2 &&
          reasons[0]?.Code === 'None' && reasons[1]?.Code === 'ConditionalCheckFailed') {
        const occupied = await this._get(Key);
        if (typeof occupied?.token_hash === 'string' && /^[a-f0-9]{64}$/.test(occupied.token_hash) &&
            occupied.token_hash !== tokenHash && Number.isSafeInteger(occupied.expires_at) && occupied.expires_at > this.now()) {
          const collision = new StoreError(409, 'session_slot_collision');
          collision.sessionEpoch = epoch;
          throw collision;
        }
      }
      throw error;
    }
  }
  async getSession(tokenHash) {
    const row = await this._get(tempKey('SESSION', tokenHash, 'SESSION'));
    if (!(row && row.token_hash === tokenHash && row.expires_at > this.now())) return null;
    const tenantRow = await this._get(tenantKey(row.tenant_id));
    if (!tenantRow || Number.isSafeInteger(tenantRow.deleted_at)) return null;
    const current = Number(tenantRow?.session_epoch) || 0;
    const stamped = Number(row.session_epoch) || 0;
    if (stamped !== current) return null;
    return { tenant_id: tenant(row.tenant_id), expires_at: row.expires_at, sso: ssoBinding(row) };
  }
  /** Import control binds writes to this observed session, never to a newer epoch. */
  async getImportSessionStamp(tokenHash) {
    hash(tokenHash);
    const row=await this._get(tempKey('SESSION',tokenHash,'SESSION'));
    if(!row||row.token_hash!==tokenHash||!Number.isSafeInteger(row.expires_at)||row.expires_at<=this.now())return null;
    const stamped=row.session_epoch??0;if(!Number.isSafeInteger(stamped)||stamped<0)return null;
    const owner=tenant(row.tenant_id),account=await this.getTenant(owner),current=account?.session_epoch??0;
    if(!account||Number.isSafeInteger(account.deleted_at)||!Number.isSafeInteger(current)||stamped!==current)return null;
    return {token_hash:tokenHash,tenant_id:owner,session_epoch:stamped};
  }
  importSessionCheck(stamp) {
    const tokenHash=hash(stamp.token_hash),owner=tenant(stamp.tenant_id),epoch=epochValue(stamp.session_epoch);
    return {ConditionCheck:{Key:tempKey('SESSION',tokenHash,'SESSION'),
      ConditionExpression:'token_hash = :token AND tenant_id = :tenant AND expires_at > :now AND '+epochCondition(epoch),
      ExpressionAttributeValues:{':token':tokenHash,':tenant':owner,':now':this.now(),':epoch':epoch}}};
  }
  /** Bumps the tenant generation so every session stamped with the previous one stops working. */
  async endTenantSessions(tenantId) {
    tenant(tenantId);
    await this._send('UpdateCommand', { Key: tenantKey(tenantId), UpdateExpression: 'ADD session_epoch :one',
      ConditionExpression: 'attribute_exists(pk)', ExpressionAttributeValues: { ':one': 1 } });
  }
  async deleteSession(tokenHash) {
    hash(tokenHash);
    try { await this._send('DeleteCommand', { Key: tempKey('SESSION', tokenHash, 'SESSION'),
      ConditionExpression: 'token_hash = :hash', ExpressionAttributeValues: { ':hash': tokenHash } }); }
    catch (error) { if (!conditional(error)) throw error; }
  }

  async createSetup(requestedKeyHash,requestedProjectId=null,environmentId='default') {
    if(typeof environmentId!=='string'||!/^[a-z][a-z0-9-]{0,31}$/.test(environmentId))fail(400,'invalid_environment');
    hash(requestedKeyHash);
    if(requestedProjectId!==null&&(typeof requestedProjectId!=='string'||!/^proj_[a-f0-9]{32}$/.test(requestedProjectId)))fail(400,'invalid_project');
    for (let attempt = 0; attempt < 4; attempt++) {
      const secret = random(), secretHash = digest(secret), code = random().slice(0, 12), expiresAt = this.now() + 600;
      try { await this._tx([
        { Put: { Item: { ...setupKey(secretHash), secret_hash: secretHash, requested_key_hash: requestedKeyHash, ...(requestedProjectId?{requested_project_id:requestedProjectId}:{}), user_code: code, ...(environmentId!=='default'?{environment_id:environmentId}:{}), expires_at: expiresAt, ttl: expiresAt },
          ConditionExpression: 'attribute_not_exists(pk) OR expires_at <= :now', ExpressionAttributeValues: { ':now': this.now() } } },
        { Put: { Item: { ...codeKey(code), user_code: code, secret_hash: secretHash, expires_at: expiresAt, ttl: expiresAt },
          ConditionExpression: 'attribute_not_exists(pk) OR expires_at <= :now', ExpressionAttributeValues: { ':now': this.now() } } }
      ]); return { device_secret: secret, user_code: code, expires_in: 600, verification_uri: requestedProjectId?'/app/?project='+requestedProjectId+'&environment='+environmentId+'#agents?code='+code:'/app/#agents?code='+code }; }
      catch (error) { if (!conditional(error)) throw error; }
    }
    fail(503, 'setup_collision');
  }
  _setupStatus(row) {
    return row.tenant_id ? { approved: true, scope: 'write', project_id:row.project_id??alphaProject(row.tenant_id).id, expires_at: row.key_expires_at,
      expires_in: Math.max(0, row.key_expires_at - this.now()), ...(row.environment_id?{environment_id:row.environment_id}:{}) } : { pending: true };
  }
  async pollSetup(secret) {
    if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret)) fail(400, 'invalid_device_secret');
    const row = await this._get(setupKey(digest(secret)));
    if (!row || row.secret_hash !== digest(secret) || row.expires_at <= this.now()) fail(410, 'setup_expired');
    return this._setupStatus(row);
  }
  /** tenantId MUST come from a verified browser session, never request JSON/query. */
  async approveSetup(tenantId, code) {
    tenant(tenantId);
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{12}$/.test(code)) fail(400, 'invalid_code');
    const mapping = await this._get(codeKey(code));
    if (!mapping || mapping.user_code !== code || mapping.expires_at <= this.now()) fail(410, 'setup_expired');
    for (let attempt = 0; attempt < 4; attempt++) {
      const request = await this._get(setupKey(mapping.secret_hash)), now = this.now();
      if (!request || request.secret_hash !== mapping.secret_hash || request.expires_at <= now) fail(410, 'setup_expired');
      const project=!request.requested_project_id||request.requested_project_id===alphaProject(tenantId).id?alphaProject(tenantId):await requireProject(this,tenantId,request.requested_project_id);if(project.id!==(this.projectId??alphaProject(tenantId).id))fail(403,'project_unavailable');
      if((request.environment_id??'default')!==(this.environmentId??'default'))fail(403,'environment_unavailable');
      if (request.tenant_id) {
        if (request.tenant_id !== tenantId) fail(409, 'code_unavailable');
        return this._setupStatus(request); // Repeat status, never issue/reactivate a credential.
      }
      // Fixed lease slots are the transactional active-key cap. Expired slots can be reused without a scan or TTL lag.
      const slot = await this._freeKeySlot(tenantId, now);
      const expiresAt = now + 2592000, keyHash = hash(request.requested_key_hash);
      const record = { token_hash: keyHash, tenant_id: tenantId, project_id:project.id, scope: 'write', expires_at: expiresAt,
        revoked: false, slot, created_at: now, ttl: expiresAt + 2592000, ...(this.environmentId&&this.environmentId!=='default'?{environment_id:this.environmentId}:{}), ...(this.keyIssuer?{issued_by:this.keyIssuer}:{}), ...(Number.isSafeInteger(this.keyIssuerVersion)?{issued_membership_version:this.keyIssuerVersion}:{}) };
      try { await this._tx([
        { ConditionCheck: { Key: tenantKey(tenantId), ConditionExpression: 'attribute_exists(pk)' } },
        { Update: { Key: setupKey(mapping.secret_hash), UpdateExpression: 'SET tenant_id = :tenant, key_expires_at = :expiry, project_id = :project',
          ConditionExpression: 'secret_hash = :secret AND attribute_not_exists(tenant_id) AND expires_at > :now AND requested_key_hash = :hash',
          ExpressionAttributeValues: { ':tenant': tenantId, ':expiry': expiresAt, ':project':project.id, ':now': now, ':hash': keyHash, ':secret': mapping.secret_hash } } },
        { Put: { Item: { ...keyLookup(keyHash), ...record }, ConditionExpression: absent } },
        { Put: { Item: { pk: tpk(tenantId), sk: `KEY#${keyHash}`, ...record }, ConditionExpression: absent } },
        { Put: { Item: { ...leaseKey(tenantId, slot), token_hash: keyHash, expires_at: expiresAt },
          ConditionExpression: 'attribute_not_exists(pk) OR expires_at <= :now', ExpressionAttributeValues: { ':now': now } } },
        ...this._auditItems('key.create', auditKeyPrefix(keyHash), { environment: this.environmentId ?? 'default', expires: new Date(expiresAt * 1000).toISOString() })
      ]); return this._setupStatus({ tenant_id: tenantId, project_id:project.id, key_expires_at: expiresAt, ...(request.environment_id?{environment_id:request.environment_id}:{}) }); }
      catch (error) {
        if (!isTransactionCancellation(error)) throw error;
        const saved = await this._get(setupKey(mapping.secret_hash));
        if (saved?.secret_hash === mapping.secret_hash && saved.tenant_id === tenantId && saved.expires_at > this.now()) return this._setupStatus(saved);
        if (await this._get(keyLookup(keyHash))) fail(409, 'key_collision');
        if (!conditional(error)) throw error;
      }
    }
    fail(409, 'approval_conflict');
  }
  async lookupWriteKey(tokenHash) {
    const row = await this._get(keyLookup(tokenHash));
    return row && row.token_hash===tokenHash && row.scope === 'write' && row.revoked === false && row.expires_at > this.now()
      && (row.project_id===undefined||row.project_id===alphaProject(row.tenant_id).id||await requireProject(this,row.tenant_id,row.project_id).then(()=>true,()=>false))
      ? { tenant_id: tenant(row.tenant_id), project_id:row.project_id??alphaProject(row.tenant_id).id, token_hash: row.token_hash, scope: 'write', expires_at: row.expires_at, ...(Object.hasOwn(KEY_PREFIX,row.key_type)?{key_type:row.key_type}:{}), ...(Number.isSafeInteger(row.last_used_at)?{last_used_at:row.last_used_at}:{}), ...(row.environment_id?{environment_id:row.environment_id}:{}), ...(row.issued_by?{issued_by:row.issued_by}:{}), ...(Number.isSafeInteger(row.issued_membership_version)?{issued_membership_version:row.issued_membership_version}:{}) } : null;
  }
  // ---- Publishable/secret keys (#105). Same lookup, list and lease rows as pairing keys, plus `key_type`. ----
  /** The organization's plan id as stored on its account row (unknown ids resolve to Free in planLimits). */
  effectivePlanId(account) { return effectivePlanId(account, this.planBillingMode); }
  async planId(tenantId) { return this.effectivePlanId(await this.getTenant(tenantId)) ?? null; }
  // The plan decides how many keys may be active (src/plans.mjs `api_keys`; null is unlimited). limits.activeKeys is the
  // table's hard ceiling of lease slots. A key that already holds a slot above a lowered limit keeps working.
  async _freeKeySlot(tenantId, now) {
    const plan = await this.planId(tenantId), allowed = planLimits(plan).api_keys, ceiling = this.limits.activeKeys, cap = allowed === null ? ceiling : Math.min(allowed, ceiling);
    const slots = (await this._send('QueryCommand', { KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': tpk(tenantId), ':prefix': 'SLOT#' }, ConsistentRead: true, Limit: ceiling })).Items ?? [];
    const occupied = new Map(slots.filter(row => row.expires_at > now).map(row => [row.sk, row]));
    if (allowed !== null) requireCount(plan, 'api_keys', occupied.size);
    for (let index = 0; index < cap; index++) if (!occupied.has(leaseKey(tenantId, index).sk)) return index;
    fail(409, 'active_key_capacity');
  }
  _apiKeyRecord(tenantId, keyHash, keyType, lifetime, slot, now) {
    const expiresAt = lifetime === null ? NO_EXPIRY : now + lifetime;
    return { token_hash: keyHash, tenant_id: tenantId, project_id: this.projectId??alphaProject(tenantId).id, scope: 'write', key_type: keyType, expires_at: expiresAt,
      revoked: false, slot, created_at: now, ...(lifetime === null ? {} : { lifetime_seconds: lifetime, ttl: expiresAt + 2592000 }),
      ...(this.environmentId&&this.environmentId!=='default'?{environment_id:this.environmentId}:{}), ...(this.keyIssuer?{issued_by:this.keyIssuer}:{}), ...(Number.isSafeInteger(this.keyIssuerVersion)?{issued_membership_version:this.keyIssuerVersion}:{}) };
  }
  _apiKeyPuts(tenantId, record, now) {
    return [
      { Put: { Item: { ...keyLookup(record.token_hash), ...record }, ConditionExpression: absent } },
      { Put: { Item: { pk: tpk(tenantId), sk: `KEY#${record.token_hash}`, ...record }, ConditionExpression: absent } },
      { Put: { Item: { ...leaseKey(tenantId, record.slot), token_hash: record.token_hash, expires_at: record.expires_at },
        ConditionExpression: 'attribute_not_exists(pk) OR expires_at <= :now', ExpressionAttributeValues: { ':now': now } } }
    ];
  }
  _apiKeyView(row) {
    return { id: row.token_hash, key_type: row.key_type, project_id: row.project_id??alphaProject(row.tenant_id).id, expires_at: row.expires_at, no_expiry: row.expires_at >= NO_EXPIRY,
      created_at: row.created_at, ...(row.environment_id?{environment_id:row.environment_id}:{}) };
  }
  /** tenantId MUST come from a verified browser session. Only the SHA-256 of the key arrives; the raw key never does. */
  async createApiKey(tenantId, { key_hash, key_type, expires_in = null } = {}) {
    tenant(tenantId); const keyHash = hash(key_hash), lifetime = keyLifetime(expires_in);
    if (!Object.hasOwn(KEY_PREFIX, key_type)) fail(400, 'invalid_key_type');
    const environment = this.environmentId ?? 'default';
    // A repeat of the same request returns the same metadata. It never reactivates or retypes a key.
    const repeat = row => row && row.tenant_id === tenantId && row.key_type === key_type && (row.project_id??alphaProject(tenantId).id)===(this.projectId??alphaProject(tenantId).id) && row.revoked === false && !row.rotated_to && (row.environment_id ?? 'default') === environment
      && (row.lifetime_seconds ?? null) === lifetime ? this._apiKeyView(row) : fail(409, 'key_collision');
    for (let attempt = 0; attempt < 4; attempt++) {
      const existing = await this._get(keyLookup(keyHash)); if (existing) return repeat(existing);
      const now = this.now(), slot = await this._freeKeySlot(tenantId, now), record = this._apiKeyRecord(tenantId, keyHash, key_type, lifetime, slot, now);
      try { await this._tx([{ ConditionCheck: { Key: tenantKey(tenantId), ConditionExpression: 'attribute_exists(pk)' } }, ...this._apiKeyPuts(tenantId, record, now),
        ...this._auditItems('key.create', auditKeyPrefix(keyHash), { environment, key_type })]); return this._apiKeyView(record); }
      catch (error) { if (!isTransactionCancellation(error)) throw error; const saved = await this._get(keyLookup(keyHash)); if (saved) return repeat(saved); if (!conditional(error)) throw error; }
    }
    fail(409, 'key_creation_conflict');
  }
  /** Issue a replacement of the same type and shorten the old key to the overlap window. The old expiry is never extended. */
  async rotateApiKey(tenantId, { id: oldId, key_hash, overlap_seconds = ROTATION_OVERLAP.default } = {}) {
    tenant(tenantId); const oldHash = hash(oldId), keyHash = hash(key_hash);
    if (oldHash === keyHash) fail(400, 'invalid_hash');
    if (!Number.isSafeInteger(overlap_seconds) || overlap_seconds < 0 || overlap_seconds > ROTATION_OVERLAP.max) fail(400, 'invalid_overlap');
    const environment = this.environmentId ?? 'default';
    for (let attempt = 0; attempt < 4; attempt++) {
      const now = this.now(), old = await this._get(keyLookup(oldHash));
      if (!old || old.tenant_id !== tenantId) fail(404, 'key_not_found');
      if ((old.project_id??alphaProject(tenantId).id)!==(this.projectId??alphaProject(tenantId).id))fail(403,'project_unavailable');
      if ((old.environment_id ?? 'default') !== environment) fail(403, 'environment_unavailable');
      if (!Object.hasOwn(KEY_PREFIX, old.key_type)) fail(409, 'key_not_rotatable');
      if (old.rotated_to) {
        const next = old.rotated_to === keyHash ? await this._get(keyLookup(keyHash)) : null;
        if (next && next.tenant_id === tenantId && next.key_type === old.key_type) return { rotated: true, key: this._apiKeyView(next), previous: { id: oldHash, expires_at: old.expires_at } };
        fail(409, 'key_already_rotated');
      }
      if (old.revoked || old.expires_at <= now) fail(409, 'key_inactive');
      if (await this._get(keyLookup(keyHash))) fail(409, 'key_collision');
      const lease = await this._get(leaseKey(tenantId, old.slot));
      if (lease?.token_hash !== oldHash || lease.expires_at <= now) fail(409, 'key_rotation_conflict');
      const record = this._apiKeyRecord(tenantId, keyHash, old.key_type, old.lifetime_seconds ?? null, old.slot, now);
      const cut = Math.min(old.expires_at, now + overlap_seconds);
      const retire = Key => ({ Update: { Key, UpdateExpression: 'SET expires_at = :cut, rotated_to = :next, #ttl = :ttl',
        ConditionExpression: 'tenant_id = :tenant AND revoked = :no AND expires_at > :now AND attribute_not_exists(rotated_to)',
        ExpressionAttributeNames: { '#ttl': 'ttl' }, ExpressionAttributeValues: { ':cut': cut, ':next': keyHash, ':ttl': cut + 2592000, ':tenant': tenantId, ':no': false, ':now': now } } });
      // Transfer the existing credential's lease atomically. The overlap key cannot free the replacement's slot.
      const puts = this._apiKeyPuts(tenantId, record, now);
      puts[2].Put.ConditionExpression = 'token_hash = :old AND expires_at > :now';
      puts[2].Put.ExpressionAttributeValues[':old'] = oldHash;
      const items = [{ ConditionCheck: { Key: tenantKey(tenantId), ConditionExpression: 'attribute_exists(pk)' } }, ...puts,
        retire(keyLookup(oldHash)), retire({ pk: tpk(tenantId), sk: `KEY#${oldHash}` })];
      items.push(...this._auditItems('key.rotate', auditKeyPrefix(oldHash), { environment, key_type: old.key_type, replaced_by: auditKeyPrefix(keyHash), previous_expires: new Date(cut * 1000).toISOString() }));
      try { await this._tx(items); return { rotated: true, key: this._apiKeyView(record), previous: { id: oldHash, expires_at: cut } }; }
      catch (error) { if (!isTransactionCancellation(error)) throw error; }
    }
    fail(409, 'key_rotation_conflict');
  }
  /** Coarse last-use stamp, written at most once an hour per key. Callers bound the wait and ignore failure. */
  async touchKeyUse(row) {
    const now = this.now();
    if (!row || typeof row.token_hash !== 'string' || (Number.isSafeInteger(row.last_used_at) && now - row.last_used_at < 3600)) return false;
    const tokenHash = hash(row.token_hash);
    // Independent rows, written together so the upload receipt waits for one round trip, not two.
    await Promise.all([keyLookup(tokenHash), { pk: tpk(row.tenant_id), sk: `KEY#${tokenHash}` }].map(async Key => {
      try { await this._send('UpdateCommand', { Key, UpdateExpression: 'SET last_used_at = :now',
        ConditionExpression: 'token_hash = :hash AND (attribute_not_exists(last_used_at) OR last_used_at <= :floor)', ExpressionAttributeValues: { ':now': now, ':hash': tokenHash, ':floor': now - 3600 } }); }
      catch (error) { if (!conditional(error)) throw error; }
    }));
    return true;
  }
  listWriteKeys(tenantId, options = {}) { return this._page(tpk(tenantId), 'KEY#', options); }
  // Personal access tokens: account-scoped, read-only credentials for the management API.
  // Only the SHA-256 of the token is stored. A revoked token is deleted, so an account never holds more than the cap.
  async createAccessToken(tenantId, { token_hash, name, expires_at }) {
    tenant(tenantId); hash(token_hash); this._expiry(expires_at, 366 * 86400);
    if (typeof name !== 'string' || name.length < 1 || name.length > 80 || name !== name.trim() || /[\u0000-\u001f\u007f]/.test(name)) fail(400, 'invalid_token_name');
    const item = { token_hash, tenant_id: tenantId, name, scope: 'read', created_at: this.now(), expires_at };
    try { await this._tx([
      { Update: { Key: tenantKey(tenantId), UpdateExpression: 'ADD access_token_count :one',
        ConditionExpression: 'attribute_exists(pk) AND (attribute_not_exists(access_token_count) OR access_token_count < :cap)',
        ExpressionAttributeValues: { ':one': 1, ':cap': ACCESS_TOKEN_CAP } } },
      { Put: { Item: { pk: `PAT#${token_hash}`, sk: 'TOKEN', ...item }, ConditionExpression: absent } },
      { Put: { Item: { pk: tpk(tenantId), sk: `PAT#${token_hash}`, ...item }, ConditionExpression: absent } },
      ...this._auditItems('token.create', auditKeyPrefix(token_hash), { name, expires: new Date(expires_at * 1000).toISOString() })
    ]); }
    catch (error) { if (!conditional(error)) throw error; fail(409, await this._get({ pk: `PAT#${token_hash}`, sk: 'TOKEN' }) ? 'access_token_exists' : 'access_token_limit'); }
    return item;
  }
  async lookupAccessToken(tokenHash) {
    hash(tokenHash);
    const row = await this._get({ pk: `PAT#${tokenHash}`, sk: 'TOKEN' });
    const owner=row?await this.getTenant(row.tenant_id):null;
    if(!owner||Number.isSafeInteger(owner.deleted_at))return null;
    return row && row.token_hash === tokenHash && row.scope === 'read' && Number.isSafeInteger(row.expires_at) && row.expires_at > this.now()
      ? { tenant_id: tenant(row.tenant_id), token_hash: tokenHash, name: row.name, scope: 'read', created_at: row.created_at, expires_at: row.expires_at } : null;
  }
  listAccessTokens(tenantId, options = {}) { return this._page(tpk(tenantId), 'PAT#', options); }
  async revokeAccessToken(tenantId, tokenHash) {
    tenant(tenantId); hash(tokenHash);
    const Key = { pk: `PAT#${tokenHash}`, sk: 'TOKEN' }, row = await this._get(Key);
    if (!row || row.tenant_id !== tenantId) fail(404, 'access_token_not_found');
    try { await this._tx([
      { Delete: { Key, ConditionExpression: 'tenant_id = :tenant', ExpressionAttributeValues: { ':tenant': tenantId } } },
      { Delete: { Key: { pk: tpk(tenantId), sk: `PAT#${tokenHash}` } } },
      { Update: { Key: tenantKey(tenantId), UpdateExpression: 'ADD access_token_count :minus',
        ConditionExpression: 'access_token_count >= :one', ExpressionAttributeValues: { ':minus': -1, ':one': 1 } } },
      ...this._auditItems('token.revoke', auditKeyPrefix(tokenHash), { name: typeof row.name === 'string' ? row.name : undefined })
    ]); }
    catch (error) { if (!conditional(error)) throw error; if (await this._get(Key)) fail(409, 'access_token_changed'); }
    return { revoked: true };
  }
  async revokeWriteKey(tenantId, tokenHash) {
    tenant(tenantId); hash(tokenHash);
    for (let attempt = 0; attempt < 4; attempt++) {
      const row = await this._get(keyLookup(tokenHash));
      if (!row || row.tenant_id !== tenantId) fail(404, 'key_not_found');
      if((row.project_id??alphaProject(tenantId).id)!==(this.projectId??alphaProject(tenantId).id))fail(403,'project_unavailable');
      const environment=this.environmentId??'default';if((row.environment_id??'default')!==environment)fail(403,'environment_unavailable');
      if (row.revoked) return { revoked: true };
      const lease = await this._get(leaseKey(tenantId, row.slot));
      const update = Key => ({ Update: { Key, UpdateExpression: 'SET revoked = :yes',
        ConditionExpression: 'tenant_id = :tenant AND revoked = :no AND '+(environment==='default'?'(attribute_not_exists(environment_id) OR environment_id = :environment)':'environment_id = :environment'), ExpressionAttributeValues: { ':yes': true, ':no': false, ':tenant': tenantId, ':environment':environment } } });
      const items = [update(keyLookup(tokenHash)), update({ pk: tpk(tenantId), sk: `KEY#${tokenHash}` })];
      if (lease?.token_hash === tokenHash) items.push({ Delete: { Key: leaseKey(tenantId, row.slot),
        ConditionExpression: 'token_hash = :hash', ExpressionAttributeValues: { ':hash': tokenHash } } });
      items.push(...this._auditItems('key.revoke', auditKeyPrefix(tokenHash), { environment }));
      try { await this._tx(items); return { revoked: true }; }
      catch (error) { if (!isTransactionCancellation(error)) throw error; }
    }
    fail(409, 'key_revocation_conflict');
  }

  async _stripeTenantExists(tenantId){
    if(!this.stripeStateTableName)return !!await this.getTenant(tenantId);
    try{await this._tx([{ConditionCheck:{Key:tenantKey(tenantId),ConditionExpression:'attribute_exists(pk)'}}]);return true;}catch(error){if(conditional(error))return false;throw error;}
  }
  _stripeTestScope(merchantId){return 'STRIPETEST#'+digest(JSON.stringify([merchantId,this.stripeTestEnvironment]));}
  _commercialScope(){if(!this.commercialPolicy)fail(503,'commercial_controls_disabled');const p=this.commercialPolicy.policy;return 'COMMERCIAL#'+digest(JSON.stringify([p.merchant_id,p.environment_id]));}
  _commercialRiskHoldKey(){return {pk:this._commercialScope(),sk:'RISK_HOLD'};}
  async recordCommercialRisk(token){
    const i=commercialRiskIntent(token),p=this.commercialPolicy?.policy;if(!p||p.livemode!==true||i.merchant_id!==p.merchant_id||i.environment_id!==p.environment_id)fail(409,'commercial_risk_scope_mismatch');
    const Key={pk:this._commercialScope(),sk:'RISK_EVENT#'+i.event_id},holdKey=this._commercialRiskHoldKey();
    const recover=async()=>{const [row,hold]=await Promise.all([this._get(Key),this._get(holdKey)]);if(!row)return null;if(Object.entries(i).some(([key,value])=>row[key]!==value)||row.payload_hash!==i.payload_hash||row.merchant_id!==p.merchant_id||row.environment_id!==p.environment_id||row.status!=='unresolved_hold'||hold?.status!=='unresolved_hold'||hold.livemode!==true||hold.merchant_id!==p.merchant_id||hold.environment_id!==p.environment_id)fail(409,'commercial_risk_event_conflict');return {event_id:i.event_id,status:'unresolved_hold',duplicate:true,entitlements_applied:false};};
    const old=await recover();if(old)return old;
    try{await this._tx([{Put:{Item:{...Key,...i},ConditionExpression:absent}},{Put:{Item:{...holdKey,merchant_id:p.merchant_id,environment_id:p.environment_id,livemode:true,status:'unresolved_hold',last_event_id:i.event_id}}}]);}catch(error){const found=await recover();if(found)return found;throw error;}
    return {event_id:i.event_id,status:'unresolved_hold',duplicate:false,entitlements_applied:false};
  }
  _commercialEntitlementKey(tenantId){tenant(tenantId);return {pk:this._commercialScope(),sk:'ENTITLEMENT#'+tenantId};}
  async enrollCommercialControls(tenantId){
    const view=this.commercialPolicy;if(!view)fail(503,'commercial_controls_disabled');tenant(tenantId);const p=view.policy,scope=this._commercialScope();
    try{await this._tx([{Update:{Key:tenantKey(tenantId),UpdateExpression:'SET commercial_managed = :managed, commercial_namespace = :scope, commercial_policy_hash = :policy, commercial_policy_revision = :revision, byte_limit = :sentinel',ConditionExpression:'attribute_exists(pk) AND ((attribute_not_exists(commercial_managed) AND byte_limit = :operational) OR (commercial_managed = :managed AND commercial_namespace = :scope AND byte_limit = :sentinel AND (commercial_policy_revision < :revision OR (commercial_policy_revision = :revision AND commercial_policy_hash = :policy))))',ExpressionAttributeValues:{':managed':true,':scope':scope,':policy':view.hash,':revision':p.revision,':sentinel':0,':operational':this.limits.tenantBytes}}}]);}catch(error){if(conditional(error))fail(409,'commercial_enrollment_conflict');throw error;}return {enrolled:true,policy_hash:view.hash,policy_version:p.version,paid_access:false,accounting:'cumulative_reserved_bytes'};
  }
  async requireCommercialEnrollment(tenantId){const view=this.commercialPolicy;if(!view)fail(503,'commercial_controls_disabled');try{await this._tx([{ConditionCheck:{Key:tenantKey(tenantId),ConditionExpression:'commercial_managed = :managed AND commercial_namespace = :scope AND commercial_policy_hash = :policy AND commercial_policy_revision = :revision AND byte_limit = :sentinel',ExpressionAttributeValues:{':managed':true,':scope':this._commercialScope(),':policy':view.hash,':revision':view.policy.revision,':sentinel':0}}}]);}catch(error){if(conditional(error))fail(409,'commercial_enrollment_required');throw error;}}
  async getCommercialBinding(tenantId){
    const p=this.commercialPolicy?.policy;if(!p)fail(503,'commercial_controls_disabled');tenant(tenantId);const scope=this._commercialScope(),reverse=await this._get({pk:scope,sk:'BINDING#'+tenantId});
    if(!reverse||!/^cus_[A-Za-z0-9]{1,180}$/.test(reverse.customer_id||'')||!/^sub_[A-Za-z0-9]{1,180}$/.test(reverse.subscription_id||''))fail(409,'commercial_binding_not_configured');const forward=await this._get({pk:scope,sk:'CUSTOMER#'+reverse.customer_id});
    for(const row of [reverse,forward])if(!row||row.tenant_id!==tenantId||row.merchant_id!==p.merchant_id||row.environment_id!==p.environment_id||row.livemode!==true||row.customer_id!==reverse.customer_id||row.subscription_id!==reverse.subscription_id||!Number.isSafeInteger(row.binding_revision)||row.binding_revision<1||row.binding_revision!==reverse.binding_revision)fail(409,'commercial_binding_conflict');
    return {tenant_id:tenantId,merchant_id:p.merchant_id,environment_id:p.environment_id,livemode:true,customer_id:reverse.customer_id,subscription_id:reverse.subscription_id,revision:reverse.binding_revision};
  }
  async getCommercialWatermark(tenantId){const row=await this._get(this._commercialEntitlementKey(tenantId));return row?{revision:row.revision,observed_at:row.observed_at}:null;}
  async applyCommercialFulfillment(tenantId,token){
    const decision=commercialDecision(token),view=this.commercialPolicy;if(!view||view.policy.livemode!==true)fail(503,'commercial_controls_disabled');tenant(tenantId);const p=view.policy;
    if(decision.tenant_id!==tenantId||decision.policy_hash!==view.hash||decision.policy_revision!==p.revision||decision.merchant_id!==p.merchant_id||decision.environment_id!==p.environment_id||decision.livemode!==true||decision.source!=='verified_live_current_state'||!Number.isSafeInteger(decision.observed_at)||decision.observed_at>this.now()*1000+999||this.now()*1000-decision.observed_at>60000||decision.expires_at<=this.now())fail(409,'commercial_decision_expired_or_unbound');
    if(decision.status==='active'&&!p.plans.some(x=>x.id===decision.plan_id&&x.price_id===decision.price_id&&x.storage_limit_bytes<=this.limits.tenantBytes))fail(409,'commercial_operational_limit_not_approved');
    const Key=this._commercialEntitlementKey(tenantId),old=await this._get(Key);if(old?.observation_id===decision.observation_id)return {status:old.status,revision:old.revision,duplicate:true,plan_id:old.plan_id,expires_at:old.expires_at};
    if((old?.revision??0)!==decision.previous_revision||(old?.observed_at??null)!==decision.previous_observed_at||old&&(old.observed_at>=decision.observed_at||old.policy_revision>p.revision||old.policy_revision===p.revision&&old.policy_hash!==view.hash))fail(409,'commercial_revision_conflict');const binding=await this.getCommercialBinding(tenantId);if(binding.customer_id!==decision.customer_id||binding.subscription_id!==decision.subscription_id||binding.revision!==decision.binding_revision)fail(409,'commercial_binding_conflict');
    const row={...Key,...decision,revision:(old?.revision??0)+1};delete row.previous_revision;delete row.previous_observed_at;
    const checks=['BINDING#'+tenantId,'CUSTOMER#'+binding.customer_id].map(sk=>({ConditionCheck:{Key:{pk:Key.pk,sk},ConditionExpression:'tenant_id = :tenant AND customer_id = :customer AND subscription_id = :subscription AND binding_revision = :binding AND livemode = :live AND merchant_id = :merchant AND environment_id = :environment',ExpressionAttributeValues:{':tenant':tenantId,':customer':binding.customer_id,':subscription':binding.subscription_id,':binding':binding.revision,':live':true,':merchant':p.merchant_id,':environment':p.environment_id}}}));
    try{await this._tx([...(decision.status==='active'?[{ConditionCheck:{Key:this._commercialRiskHoldKey(),ConditionExpression:absent}}]:[]),{Put:{Item:row,ConditionExpression:old?'revision = :previous AND observed_at = :observed':absent,...(old?{ExpressionAttributeValues:{':previous':old.revision,':observed':old.observed_at}}:{})}},{ConditionCheck:{Key:tenantKey(tenantId),ConditionExpression:'commercial_managed = :managed AND commercial_namespace = :scope AND commercial_policy_hash = :policy AND commercial_policy_revision = :revision AND byte_limit = :sentinel',ExpressionAttributeValues:{':managed':true,':scope':Key.pk,':policy':view.hash,':revision':p.revision,':sentinel':0}}},...checks]);}catch(error){const saved=await this._get(Key);if(saved?.observation_id===decision.observation_id)return {status:saved.status,revision:saved.revision,duplicate:true,plan_id:saved.plan_id,expires_at:saved.expires_at};if(conditional(error))fail(409,'commercial_revision_conflict');throw error;}return {status:row.status,revision:row.revision,plan_id:row.plan_id,expires_at:row.expires_at,paid_access:row.status==='active',policy_hash:view.hash};
  }
  async resolveCommercialQuota(tenantId){
    if(!this.commercialPolicy)return null;const {policy:p,hash}=this.commercialPolicy,account=await this.getTenant(tenantId);if(!account)fail(404,'tenant_not_found');if(account.commercial_managed!==true)return null;if(account.commercial_namespace!==this._commercialScope()||account.commercial_policy_hash!==hash||account.commercial_policy_revision!==p.revision||account.byte_limit!==0)fail(503,'commercial_policy_enrollment_required');const Key=this._commercialEntitlementKey(tenantId),row=await this._get(Key);
    if(!row){const plan=p.plans.find(x=>x.id===p.free_plan_id);return {plan_id:plan.id,limit_bytes:Math.min(plan.storage_limit_bytes,this.limits.tenantBytes),operational_limit_bytes:this.limits.tenantBytes,policy_hash:hash,status:'free',checks:[{ConditionCheck:{Key,ConditionExpression:absent}}]};}
    if(row.tenant_id!==tenantId||row.merchant_id!==p.merchant_id||row.environment_id!==p.environment_id||row.livemode!==true||row.policy_hash!==hash||row.policy_revision!==p.revision||!Number.isSafeInteger(row.revision)||row.revision<1||!['active','blocked'].includes(row.status))fail(503,'commercial_entitlement_unavailable');
    if(row.status!=='active'||!Number.isSafeInteger(row.expires_at)||row.expires_at<=this.now())return {blocked:true,status:'blocked',reason:'commercial_reconciliation_required',limit_bytes:0,operational_limit_bytes:this.limits.tenantBytes,policy_hash:hash};
    if(await this._get(this._commercialRiskHoldKey()))return {blocked:true,status:'blocked',reason:'commercial_risk_review_required',limit_bytes:0,operational_limit_bytes:this.limits.tenantBytes,policy_hash:hash};
    const plan=p.plans.find(x=>x.id===row.plan_id);if(!plan||plan.price_id!==row.price_id||plan.price_id===null||row.source!=='verified_live_current_state')fail(503,'commercial_entitlement_unavailable');const binding=await this.getCommercialBinding(tenantId);if(binding.revision!==row.binding_revision||binding.customer_id!==row.customer_id||binding.subscription_id!==row.subscription_id)fail(409,'commercial_binding_conflict');
    const values={':revision':row.revision,':policy':hash,':policyRevision':p.revision,':active':'active',':expires':row.expires_at,':now':this.now(),':live':true,':plan':row.plan_id,':customer':binding.customer_id,':subscription':binding.subscription_id,':binding':binding.revision,':tenant':tenantId,':merchant':p.merchant_id,':environment':p.environment_id,':source':'verified_live_current_state',':price':row.price_id};
    const checks=[{ConditionCheck:{Key:this._commercialRiskHoldKey(),ConditionExpression:absent}},{ConditionCheck:{Key,ConditionExpression:'revision = :revision AND policy_hash = :policy AND policy_revision = :policyRevision AND #status = :active AND expires_at = :expires AND expires_at > :now AND livemode = :live AND plan_id = :plan AND customer_id = :customer AND subscription_id = :subscription AND binding_revision = :binding AND tenant_id = :tenant AND merchant_id = :merchant AND environment_id = :environment AND #source = :source AND price_id = :price',ExpressionAttributeNames:{'#status':'status','#source':'source'},ExpressionAttributeValues:values}},...['BINDING#'+tenantId,'CUSTOMER#'+binding.customer_id].map(sk=>({ConditionCheck:{Key:{pk:Key.pk,sk},ConditionExpression:'tenant_id = :tenant AND customer_id = :customer AND subscription_id = :subscription AND binding_revision = :binding AND livemode = :live AND merchant_id = :merchant AND environment_id = :environment',ExpressionAttributeValues:{':tenant':tenantId,':customer':binding.customer_id,':subscription':binding.subscription_id,':binding':binding.revision,':live':true,':merchant':p.merchant_id,':environment':p.environment_id}}}))];
    return {plan_id:plan.id,limit_bytes:Math.min(plan.storage_limit_bytes,this.limits.tenantBytes),operational_limit_bytes:this.limits.tenantBytes,policy_hash:hash,status:'active',revision:row.revision,expires_at:row.expires_at,checks};
  }
  async getCommercialQuotaView(tenantId){const quota=await this.resolveCommercialQuota(tenantId);if(!quota)return null;const {checks,...view}=quota;return {...view,enforced:true,accounting:'cumulative_reserved_bytes'};}
  async prepareStripeSandboxCustomerIntent(tenantId,merchantId){
    if(!this.stripeTestInbox||!this.stripeStateTableName)fail(503,'billing_customer_bootstrap_not_configured');tenant(tenantId);if(typeof merchantId!=='string'||!/^acct_[A-Za-z0-9]{1,180}$/.test(merchantId))fail(400,'invalid_billing_binding');
    const scope=this._stripeTestScope(merchantId),Key={pk:tpk(tenantId),sk:scope+'#CUSTOMERINTENT'};
    const receipt=async row=>{if(row.tenant_id!==tenantId||row.merchant_id!==merchantId||row.environment_id!==this.stripeTestEnvironment||row.livemode!==false||!['prepared','bound'].includes(row.status)||!/^customer-test-[a-f0-9]{64}$/.test(row.intent_id||'')||row.idempotency_key!=='supatrace-'+row.intent_id||!Number.isSafeInteger(row.expires_at))fail(409,'customer_creation_requires_reconciliation');if(row.status==='bound'){const b=await this.getStripeTestBinding(tenantId,merchantId);if(b.customer_id!==row.customer_id)fail(409,'billing_binding_conflict');return {bound:true,customer_id:b.customer_id};}if(row.expires_at<=this.now())fail(409,'customer_creation_requires_reconciliation');return {intent_id:row.intent_id,idempotency_key:row.idempotency_key,expires_at:row.expires_at};};
    const old=await this._get(Key);if(old)return receipt(old);
    const intentId='customer-test-'+digest(JSON.stringify([scope,tenantId,random()])),row={...Key,tenant_id:tenantId,merchant_id:merchantId,environment_id:this.stripeTestEnvironment,livemode:false,status:'prepared',intent_id:intentId,idempotency_key:'supatrace-'+intentId,created_at:this.now(),expires_at:this.now()+23*3600};
    try{await this._tx([{Put:{Item:row,ConditionExpression:absent}},{ConditionCheck:{Key:tenantKey(tenantId),ConditionExpression:'attribute_exists(pk)'}},{ConditionCheck:{Key:{pk:tpk(tenantId),sk:scope},ConditionExpression:absent}}]);}catch(error){const saved=await this._get(Key);if(saved)return receipt(saved);if(conditional(error))fail(409,'customer_creation_intent_conflict');throw error;}return receipt(row);
  }
  async completeStripeSandboxCustomerIntent(tenantId,{merchant_id,intent_id,customer_id}={}){
    if(!this.stripeTestInbox||!this.stripeStateTableName)fail(503,'billing_customer_bootstrap_not_configured');tenant(tenantId);if(typeof merchant_id!=='string'||!/^acct_[A-Za-z0-9]{1,180}$/.test(merchant_id)||!/^customer-test-[a-f0-9]{64}$/.test(intent_id||'')||!/^cus_[A-Za-z0-9]{1,180}$/.test(customer_id||''))fail(400,'invalid_customer_creation_receipt');
    const scope=this._stripeTestScope(merchant_id),Key={pk:tpk(tenantId),sk:scope+'#CUSTOMERINTENT'},row=await this._get(Key);
    if(!row||row.intent_id!==intent_id||row.tenant_id!==tenantId||row.merchant_id!==merchant_id||row.environment_id!==this.stripeTestEnvironment||row.livemode!==false)fail(409,'customer_creation_intent_conflict');
    const recover=async()=>{const saved=await this._get(Key);if(saved?.status!=='bound'||saved.customer_id!==customer_id||saved.intent_id!==intent_id||saved.tenant_id!==tenantId||saved.merchant_id!==merchant_id||saved.environment_id!==this.stripeTestEnvironment||saved.livemode!==false) return null;const b=await this.getStripeTestBinding(tenantId,merchant_id);if(b.customer_id!==customer_id)fail(409,'billing_binding_conflict');return b;};
    if(row.status==='bound'){const b=await recover();if(b)return b;fail(409,'customer_creation_binding_conflict');}if(row.status!=='prepared')fail(409,'customer_creation_requires_reconciliation');
    const binding={tenant_id:tenantId,merchant_id,customer_id,environment_id:this.stripeTestEnvironment,livemode:false,binding_revision:1};
    try{await this._tx([{ConditionCheck:{Key:tenantKey(tenantId),ConditionExpression:'attribute_exists(pk)'}},{Update:{Key,UpdateExpression:'SET #status = :bound, customer_id = :customer',ConditionExpression:'intent_id = :intent AND #status = :prepared AND merchant_id = :merchant AND environment_id = :environment AND livemode = :test',ExpressionAttributeNames:{'#status':'status'},ExpressionAttributeValues:{':bound':'bound',':customer':customer_id,':intent':intent_id,':prepared':'prepared',':merchant':merchant_id,':environment':this.stripeTestEnvironment,':test':false}}},{Put:{Item:{pk:scope,sk:'CUSTOMER#'+customer_id,...binding},ConditionExpression:absent}},{Put:{Item:{pk:tpk(tenantId),sk:scope,...binding},ConditionExpression:absent}}]);}catch(error){const b=await recover();if(b)return b;if(conditional(error))fail(409,'customer_creation_binding_conflict');throw error;}return this.getStripeTestBinding(tenantId,merchant_id);
  }
  async bindStripeTestCustomer(tenantId,{merchant_id,customer_id}={}) {
    if(!this.stripeTestInbox)fail(503,'stripe_test_inbox_disabled');tenant(tenantId);
    if(typeof merchant_id!=='string'||!/^acct_[A-Za-z0-9]{1,180}$/.test(merchant_id)||typeof customer_id!=='string'||!/^cus_[A-Za-z0-9]{1,180}$/.test(customer_id))fail(400,'invalid_billing_binding');
    const scope=this._stripeTestScope(merchant_id),customer={pk:scope,sk:'CUSTOMER#'+customer_id},account={pk:tpk(tenantId),sk:scope};
    const [left,right]=await Promise.all([this._get(customer),this._get(account)]);
    if(left||right){if(left?.tenant_id===tenantId&&left?.customer_id===customer_id&&left?.merchant_id===merchant_id&&left?.livemode===false&&left?.environment_id===this.stripeTestEnvironment&&right?.tenant_id===tenantId&&right?.customer_id===customer_id&&right?.merchant_id===merchant_id&&right?.livemode===false&&right?.environment_id===this.stripeTestEnvironment)return {bound:true,livemode:false,purchases_enabled:false};fail(409,'billing_binding_conflict');}
    const row={tenant_id:tenantId,merchant_id,customer_id,environment_id:this.stripeTestEnvironment,livemode:false,binding_revision:1};
    try{await this._tx([{ConditionCheck:{Key:tenantKey(tenantId),ConditionExpression:'attribute_exists(pk)'}},{Put:{Item:{...customer,...row},ConditionExpression:absent}},{Put:{Item:{...account,...row},ConditionExpression:absent}}]);}
    catch(error){if(conditional(error))fail(409,'billing_binding_conflict');throw error;}
    return {bound:true,livemode:false,purchases_enabled:false};
  }
  async getStripeTestBinding(tenantId,merchantId) {
    if(!this.stripeTestInbox)fail(503,'stripe_test_inbox_disabled');tenant(tenantId);if(typeof merchantId!=='string'||!/^acct_[A-Za-z0-9]{1,180}$/.test(merchantId))fail(400,'invalid_billing_binding');
    const scope=this._stripeTestScope(merchantId),reverse=await this._get({pk:tpk(tenantId),sk:scope});if(!reverse||typeof reverse.customer_id!=='string'||!/^cus_[A-Za-z0-9]{1,180}$/.test(reverse.customer_id))fail(409,'billing_customer_unbound');const forward=await this._get({pk:scope,sk:'CUSTOMER#'+reverse.customer_id});
    for(const row of [forward,reverse])if(!row||row.tenant_id!==tenantId||row.customer_id!==reverse.customer_id||row.merchant_id!==merchantId||row.livemode!==false||row.environment_id!==this.stripeTestEnvironment||!Number.isSafeInteger(row.binding_revision)||row.binding_revision<1||row.binding_revision!==reverse.binding_revision||row.subscription_id!==reverse.subscription_id)fail(409,'billing_binding_conflict');
    if(reverse.subscription_id!==undefined&&(typeof reverse.subscription_id!=='string'||!/^sub_[A-Za-z0-9]{1,180}$/.test(reverse.subscription_id)))fail(409,'billing_binding_conflict');
    if(!await this._stripeTenantExists(tenantId))fail(404,'tenant_not_found');return {tenant_id:tenantId,merchant_id:merchantId,customer_id:reverse.customer_id,subscription_id:reverse.subscription_id,environment_id:this.stripeTestEnvironment,livemode:false,revision:reverse.binding_revision};
  }
  async bindStripeTestSubscription(tenantId,{merchant_id,subscription_id,expected_revision}={}) {
    const b=await this.getStripeTestBinding(tenantId,merchant_id);if(typeof subscription_id!=='string'||!/^sub_[A-Za-z0-9]{1,180}$/.test(subscription_id)||!Number.isSafeInteger(expected_revision)||expected_revision<1)fail(400,'invalid_subscription_binding');
    if(b.subscription_id){if(b.subscription_id===subscription_id)return b;fail(409,'subscription_replacement_requires_review');}if(b.revision!==expected_revision||b.revision>=Number.MAX_SAFE_INTEGER)fail(409,'billing_binding_revision_conflict');
    const scope=this._stripeTestScope(merchant_id),keys=[{pk:scope,sk:'CUSTOMER#'+b.customer_id},{pk:tpk(tenantId),sk:scope}];
    try{await this._tx([{ConditionCheck:{Key:tenantKey(tenantId),ConditionExpression:'attribute_exists(pk)'}},...keys.map(Key=>({Update:{Key,UpdateExpression:'SET subscription_id = :subscription, binding_revision = :next',ConditionExpression:'tenant_id = :tenant AND customer_id = :customer AND merchant_id = :merchant AND livemode = :test AND environment_id = :environment AND binding_revision = :revision AND attribute_not_exists(subscription_id)',ExpressionAttributeValues:{':tenant':tenantId,':customer':b.customer_id,':merchant':merchant_id,':test':false,':environment':this.stripeTestEnvironment,':revision':b.revision,':subscription':subscription_id,':next':b.revision+1}}}))]);}catch(error){if(conditional(error))fail(409,'billing_binding_revision_conflict');throw error;}return {...b,subscription_id,revision:b.revision+1};
  }
  async prepareStripeTestCheckoutIntent(tenantId,input,options={}) {
    try{input=JSON.parse(JSON.stringify(input));options=JSON.parse(JSON.stringify(options));}catch{fail(400,'invalid_test_checkout_input');}
    const appScope=options.checkoutScope===undefined?undefined:checkoutScope(options.checkoutScope,tenantId,options.returnOrigin);
    const b=await this.getStripeTestBinding(tenantId,input?.merchant_id);const descriptor=buildStripeTestCheckout({...input,tenant_id:tenantId,hasActiveSubscription:false},{...options,enabled:options.enabled===true,binding:b});if(appScope)descriptor.headers['Idempotency-Key']='supatrace-test-'+digest(JSON.stringify([descriptor.headers['Idempotency-Key'],appScope]));const scope=this._stripeTestScope(b.merchant_id),Key={pk:tpk(tenantId),sk:scope+'#CHECKOUTLOCK'},requestHash=digest(JSON.stringify(descriptor)),old=await this._get(Key);
    const receipt=row=>{requireBillingScope(row,appScope,tenantId);if(row.request_hash!==requestHash||row.request_id!==input.request_id)fail(409,'checkout_intent_locked');if(row.expires_at<=this.now())fail(409,'checkout_intent_expired_requires_reconciliation');return {intent_id:row.intent_id,status:'prepared_not_sent',descriptor:row.descriptor,expires_at:row.expires_at,purchases_enabled:false};};if(old)return receipt(old);if(b.subscription_id)fail(409,'existing_subscription_requires_review');
    const row={...Key,tenant_id:tenantId,merchant_id:b.merchant_id,customer_id:b.customer_id,binding_revision:b.revision,request_id:input.request_id,request_hash:requestHash,...(appScope?{checkout_scope:appScope,checkout_scope_hash:digest(JSON.stringify(appScope))}:{}),intent_id:'checkout-test-'+requestHash,descriptor,status:'prepared_not_sent',expires_at:this.now()+300};
    const conditions=[{pk:scope,sk:'CUSTOMER#'+b.customer_id},{pk:tpk(tenantId),sk:scope}].map(Key=>({ConditionCheck:{Key,ConditionExpression:'tenant_id = :tenant AND customer_id = :customer AND merchant_id = :merchant AND livemode = :test AND environment_id = :environment AND binding_revision = :revision AND attribute_not_exists(subscription_id)',ExpressionAttributeValues:{':tenant':tenantId,':customer':b.customer_id,':merchant':b.merchant_id,':test':false,':environment':this.stripeTestEnvironment,':revision':b.revision}}}));
    try{await this._tx([{Put:{Item:row,ConditionExpression:absent}},{ConditionCheck:{Key:tenantKey(tenantId),ConditionExpression:'attribute_exists(pk)'}},...conditions]);}catch(error){const saved=await this._get(Key);if(saved)return receipt(saved);if(conditional(error))fail(409,'checkout_intent_conflict');throw error;}return receipt(row);
  }
  async _requireStripeInbox(intent) {
    if(!this.stripeInboxTableName)return;
    const row=(await this._send('GetCommand',{TableName:this.stripeInboxTableName,Key:{pk:this._stripeTestScope(intent.merchant_id),sk:'CAPTURE#'+intent.event_id},ConsistentRead:true})).Item;
    if(!row||row.event_id!==intent.event_id||row.payload_hash!==intent.payload_hash||row.merchant_id!==intent.merchant_id||row.environment_id!==this.stripeTestEnvironment||row.livemode!==false)fail(503,'billing_inbox_reconciliation_required');
  }
  _stripeInboxWrite(intent) {
    if(!this.stripeInboxTableName)return [];
    const row={pk:this._stripeTestScope(intent.merchant_id),sk:'CAPTURE#'+intent.event_id,event_id:intent.event_id,payload_hash:intent.payload_hash,merchant_id:intent.merchant_id,environment_id:this.stripeTestEnvironment,livemode:false};
    return [{Put:{TableName:this.stripeInboxTableName,Item:row,ConditionExpression:'attribute_not_exists(pk) OR payload_hash = :hash',ExpressionAttributeValues:{':hash':intent.payload_hash}}}];
  }
  async loadStripeCapturedEvent(merchantId,eventId) {
    if(!this.stripeTestInbox)fail(503,'stripe_test_inbox_disabled');if(typeof merchantId!=='string'||!/^acct_[A-Za-z0-9]{1,180}$/.test(merchantId)||typeof eventId!=='string'||!/^evt_[A-Za-z0-9]{1,180}$/.test(eventId))fail(400,'invalid_captured_event');const scope=this._stripeTestScope(merchantId);let row=await this._get({pk:scope,sk:'REVIEW#'+eventId});if(!row)row=await this._get({pk:scope,sk:'EVENT#'+eventId});if(!row)fail(404,'captured_event_not_found');if(row.pk!==scope||!['REVIEW#'+eventId,'EVENT#'+eventId].includes(row.sk)||row.event_id!==eventId)fail(409,'captured_event_scope_mismatch');return restoreStripeTestStoredIntent(row,{merchantAccount:merchantId,environmentId:this.stripeTestEnvironment});
  }
  async getStripeTestBindingByCustomer(merchantId,customerId) {
    if(!this.stripeTestInbox)fail(503,'stripe_test_inbox_disabled');if(typeof customerId!=='string'||!/^cus_[A-Za-z0-9]{1,180}$/.test(customerId))fail(400,'invalid_billing_binding');const row=await this._get({pk:this._stripeTestScope(merchantId),sk:'CUSTOMER#'+customerId});if(!row?.tenant_id)fail(409,'billing_customer_unbound');const b=await this.getStripeTestBinding(row.tenant_id,merchantId);if(b.customer_id!==customerId)fail(409,'billing_binding_conflict');return b;
  }
  async recordStripeSandboxReview(verifiedEvent,{status='resolution_required',subscription_ids=[]}={}) {
    if(!this.stripeTestInbox)fail(503,'stripe_test_inbox_disabled');const i=stripeTestIntent(verifiedEvent);if(i.environment_id!==this.stripeTestEnvironment||!['resolution_required','risk_review_required','unpaid_no_binding','checkout_bound'].includes(status)||!Array.isArray(subscription_ids)||subscription_ids.length>10||subscription_ids.some(s=>typeof s!=='string'||!/^sub_[A-Za-z0-9]{1,180}$/.test(s)))fail(400,'invalid_billing_review');
    const Key={pk:this._stripeTestScope(i.merchant_id),sk:'REVIEW#'+i.event_id},old=await this._get(Key);if(old&&old.payload_hash!==i.payload_hash)fail(409,'billing_event_conflict');if(old)await this._requireStripeInbox(i);if(old&&old.status!=='resolution_required'){if(i.action==='risk_review_required')await this._tx([{Put:{Item:{pk:Key.pk,sk:'SANDBOX_RISK_HOLD',merchant_id:i.merchant_id,environment_id:i.environment_id,livemode:false,status:'review_required'}}}]);await this._requireStripeInbox(i);return {event_id:i.event_id,status:old.status,entitlements_applied:false,duplicate:true};}const row={...Key,...i,status,subscription_ids:[...new Set(subscription_ids)].sort(),entitlements_applied:false};
    const riskWrites=i.action==='risk_review_required'?[{Put:{Item:{pk:Key.pk,sk:'SANDBOX_RISK_HOLD',merchant_id:i.merchant_id,environment_id:i.environment_id,livemode:false,status:'review_required'}}}]:[];
    try{await this._tx([...riskWrites,...this._stripeInboxWrite(i),{Put:{Item:row,ConditionExpression:old?'payload_hash = :hash AND #status = :pending':absent,...(old?{ExpressionAttributeValues:{':hash':i.payload_hash,':pending':'resolution_required'},ExpressionAttributeNames:{'#status':'status'}}:{})}}]);}catch(e){const r=await this._get(Key);if(r?.payload_hash!==i.payload_hash)fail(409,'billing_event_conflict');if(r?.status!==status)throw e;}if(riskWrites.length&&!await this._get({pk:Key.pk,sk:'SANDBOX_RISK_HOLD'}))fail(503,'sandbox_risk_hold_not_recorded');await this._requireStripeInbox(i);return {event_id:i.event_id,status,entitlements_applied:false};
  }
  async bindStripeSandboxCheckoutSubscription(verifiedEvent,session) {
    try{session=structuredClone(session);}catch{fail(400,'invalid_checkout_session');}
    const i=stripeTestIntent(verifiedEvent);if(!['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(i.event_type)||session?.id!==i.object_id||session.object!=='checkout.session'||session.customer!==i.customer_id||session.livemode!==false||session.mode!=='subscription'||session.status!=='complete'||session.payment_status!=='paid'||typeof session.subscription!=='string'||!/^sub_[A-Za-z0-9]{1,180}$/.test(session.subscription))fail(409,'paid_bound_checkout_required');
    const b=await this.getStripeTestBindingByCustomer(i.merchant_id,i.customer_id);if(i.environment_id!==b.environment_id)fail(409,'billing_binding_conflict');const scope=this._stripeTestScope(b.merchant_id),lockKey={pk:tpk(b.tenant_id),sk:scope+'#CHECKOUTLOCK'},lock=await this._get(lockKey);if(!lock||lock.session_receipt?.session_id!==session.id||lock.request_id!==session.client_reference_id||lock.customer_id!==b.customer_id)fail(409,'checkout_session_unbound');
    if(b.subscription_id){if(b.subscription_id===session.subscription){const receipt=await this.recordStripeSandboxReview(verifiedEvent,{status:'checkout_bound',subscription_ids:[session.subscription]});if(receipt.status!=='checkout_bound')fail(409,'checkout_review_conflict');return b;}fail(409,'subscription_replacement_requires_review');}if(lock.binding_revision!==b.revision)fail(409,'billing_binding_revision_conflict');
    const reviewKey={pk:scope,sk:'REVIEW#'+i.event_id},keys=[{pk:scope,sk:'CUSTOMER#'+b.customer_id},{pk:tpk(b.tenant_id),sk:scope}];try{await this._tx([{Update:{Key:reviewKey,UpdateExpression:'SET #status = :done, subscription_ids = :subscriptions',ConditionExpression:'payload_hash = :hash AND #status = :pending',ExpressionAttributeNames:{'#status':'status'},ExpressionAttributeValues:{':hash':i.payload_hash,':pending':'resolution_required',':done':'checkout_bound',':subscriptions':[session.subscription]}}},{ConditionCheck:{Key:tenantKey(b.tenant_id),ConditionExpression:'attribute_exists(pk)'}},{ConditionCheck:{Key:lockKey,ConditionExpression:'request_hash = :hash AND attribute_exists(session_receipt)',ExpressionAttributeValues:{':hash':lock.request_hash}}},...keys.map(Key=>({Update:{Key,UpdateExpression:'SET subscription_id = :subscription, binding_revision = :next',ConditionExpression:'tenant_id = :tenant AND customer_id = :customer AND merchant_id = :merchant AND livemode = :test AND environment_id = :environment AND binding_revision = :revision AND attribute_not_exists(subscription_id)',ExpressionAttributeValues:{':tenant':b.tenant_id,':customer':b.customer_id,':merchant':b.merchant_id,':test':false,':environment':b.environment_id,':revision':b.revision,':subscription':session.subscription,':next':b.revision+1}}}))]);}catch(error){const current=await this.getStripeTestBinding(b.tenant_id,b.merchant_id);const review=await this._get(reviewKey);if(current.subscription_id===session.subscription&&review?.status==='checkout_bound'&&review.payload_hash===i.payload_hash)return current;if(conditional(error))fail(409,'billing_binding_revision_conflict');throw error;}return {...b,subscription_id:session.subscription,revision:b.revision+1};
  }
  async getStripeTestReconciliationWatermark(tenantId,merchantId) {
    await this.getStripeTestBinding(tenantId,merchantId);const row=await this._get({pk:tpk(tenantId),sk:this._stripeTestScope(merchantId)+'#RECONCILIATION'});return row?.observed_at;
  }
  async getStripeSandboxCheckoutSession(tenantId,{merchant_id,intent_id,checkout_scope}) {
    await this.getStripeTestBinding(tenantId,merchant_id);const row=await this._get({pk:tpk(tenantId),sk:this._stripeTestScope(merchant_id)+'#CHECKOUTLOCK'});
    if(!row||row.intent_id!==intent_id)fail(409,'checkout_intent_conflict');requireBillingScope(row,checkout_scope,tenantId);return row.session_receipt||null;
  }
  async recordStripeSandboxCheckoutSession(tenantId,{merchant_id,intent_id,session_id,url,livemode,status,checkout_scope}) {
    const b=await this.getStripeTestBinding(tenantId,merchant_id);let parsed;try{parsed=new URL(url);}catch{fail(400,'invalid_checkout_receipt');}
    if(livemode!==false||status!=='open'||!/^cs_test_[A-Za-z0-9]+$/.test(session_id)||parsed.origin!=='https://checkout.stripe.com'||parsed.username||parsed.password)fail(400,'invalid_checkout_receipt');
    const Key={pk:tpk(tenantId),sk:this._stripeTestScope(merchant_id)+'#CHECKOUTLOCK'},row=await this._get(Key);if(!row||row.intent_id!==intent_id||row.binding_revision!==b.revision)fail(409,'checkout_intent_conflict');requireBillingScope(row,checkout_scope,tenantId);
    const receipt={session_id,url,livemode:false,status:'open',intent_id};if(row.session_receipt){if(JSON.stringify(row.session_receipt)!==JSON.stringify(receipt))fail(409,'checkout_session_conflict');return row.session_receipt;}
    const bindings=[{pk:this._stripeTestScope(merchant_id),sk:'CUSTOMER#'+b.customer_id},{pk:tpk(tenantId),sk:this._stripeTestScope(merchant_id)}];
    try{await this._tx([{Update:{Key,UpdateExpression:'SET session_receipt = :receipt',ConditionExpression:'intent_id = :intent AND binding_revision = :revision AND attribute_not_exists(session_receipt) AND '+(checkout_scope?'checkout_scope_hash = :appScopeHash':'attribute_not_exists(checkout_scope)'),ExpressionAttributeValues:{':intent':intent_id,':revision':b.revision,':receipt':receipt,...(checkout_scope?{':appScopeHash':billingScopeHash(checkout_scope,tenantId)}:{})}}},{ConditionCheck:{Key:tenantKey(tenantId),ConditionExpression:'attribute_exists(pk)'}},...bindings.map(Key=>({ConditionCheck:{Key,ConditionExpression:'customer_id = :customer AND binding_revision = :revision AND environment_id = :environment AND livemode = :test AND attribute_not_exists(subscription_id)',ExpressionAttributeValues:{':customer':b.customer_id,':revision':b.revision,':environment':b.environment_id,':test':false}}}))]);}catch(error){const saved=await this.getStripeSandboxCheckoutSession(tenantId,{merchant_id,intent_id,checkout_scope});if(saved&&JSON.stringify(saved)===JSON.stringify(receipt))return saved;if(conditional(error))fail(409,'checkout_session_conflict');throw error;}return receipt;
  }
  async recordStripeTestReconciliation(tenantId,decision,sandboxToken) {
    if(!this.stripeTestInbox)fail(503,'stripe_test_inbox_disabled');tenant(tenantId);
    const d=stripeTestDecision(decision);if(d.environment_id!==this.stripeTestEnvironment)fail(409,'stripe_sandbox_environment_mismatch');if(d.tenant_id!==tenantId)fail(409,'reconciliation_binding_conflict');const eventKey={pk:this._stripeTestScope(d.merchant_id),sk:'EVENT#'+d.event_id},decisionHash=digest(JSON.stringify(d));
    const sandbox=this.sandboxEntitlementPolicy?sandboxEntitlementDecision(sandboxToken,decision,this.sandboxEntitlementPolicy):null;
    if(sandboxToken&&!sandbox)fail(503,'sandbox_entitlements_disabled');
    const recover=row=>{if(row?.status!=='test_reconciled_not_applied')return null;if(row.tenant_id!==tenantId||row.merchant_id!==d.merchant_id||row.livemode!==false||row.environment_id!==this.stripeTestEnvironment||row.payload_hash!==d.payload_hash||row.decision_hash!==decisionHash||row.reconciliation_receipt?.entitlements_applied!==false||sandbox&&row.reconciliation_receipt?.sandbox_policy_hash!==sandbox.policy_hash)fail(409,'reconciliation_receipt_conflict');return {...row.reconciliation_receipt,duplicate:true};};const existingReceipt=recover(await this._get(eventKey));if(existingReceipt)return existingReceipt;
    if(d.observed_at>this.now()||this.now()-d.observed_at>60)fail(409,'reconciliation_decision_expired');const b=await this.getStripeTestBinding(tenantId,d.merchant_id);if(d.tenant_id!==tenantId||d.customer_id!==b.customer_id||d.subscription_id!==b.subscription_id||d.binding_revision!==b.revision)fail(409,'reconciliation_binding_conflict');const scope=this._stripeTestScope(b.merchant_id),Key={pk:tpk(tenantId),sk:scope+'#RECONCILIATION'},old=await this._get(Key);
    if(old?.sandbox_entitlement&&!sandbox)fail(409,'sandbox_entitlement_composition_required');
    if(sandbox&&old?.sandbox_entitlement&&(old.sandbox_entitlement.policy_revision>sandbox.policy_revision||old.sandbox_entitlement.policy_revision===sandbox.policy_revision&&old.sandbox_entitlement.policy_hash!==sandbox.policy_hash))fail(409,'sandbox_policy_revision_conflict');
    const testPlan=sandbox!==null&&this.sandboxEntitlementPolicy.planLimits===true;
    // entitlements_applied is about the live commercial ledger and stays false. test_plan_id is the plan the
    // account row was moved to by this test-mode reconciliation.
    const receipt={event_id:d.event_id,observed_at:d.observed_at,decision_hash:decisionHash,entitlements_applied:false,purchases_enabled:false,...(sandbox?{sandbox_entitlement_recorded:true,sandbox_policy_hash:sandbox.policy_hash}: {}),...(testPlan?{test_plan_id:sandbox.status==='active'?sandbox.plan_id:PLAN_LIMITS.default_plan}:{})};if(old?.decision_hash===decisionHash)fail(409,'reconciliation_receipt_missing');if((old?.observed_at??null)!==d.previous_observed_at||old&&old.observed_at>=d.observed_at)fail(409,'reconciliation_watermark_conflict');
    // Opt-in Stripe TEST-mode plan assignment (planLimits:'test_mode'): the same transaction that records this
    // reconciliation moves the account to the reconciled plan, or back to Free when the subscription is not a
    // current paid one. The reservation path conditions on plan_id, so an upload racing this sees one plan or
    // the other. A plan some other source assigned is never overwritten: the transaction fails instead.
    // Returning to Free also drops the spend-cap choice, so a later upgrade starts with the plan default again.
    const planSource={ConditionExpression:'attribute_exists(pk) AND (attribute_not_exists(plan_id) OR plan_source = :source)'},accountPlan=!testPlan?{ConditionCheck:{Key:tenantKey(tenantId),ConditionExpression:'attribute_exists(pk)'}}:sandbox.status==='active'?{Update:{Key:tenantKey(tenantId),UpdateExpression:'SET plan_id = :plan, plan_source = :source, plan_changed_at = :at',...planSource,ExpressionAttributeValues:{':plan':sandbox.plan_id,':source':TEST_PLAN_SOURCE,':at':this.now()}}}:{Update:{Key:tenantKey(tenantId),UpdateExpression:'SET plan_changed_at = :at REMOVE plan_id, plan_source, spend_cap',...planSource,ExpressionAttributeValues:{':source':TEST_PLAN_SOURCE,':at':this.now()}}};
    const checks=[{pk:scope,sk:'CUSTOMER#'+b.customer_id},{pk:tpk(tenantId),sk:scope}].map(Key=>({ConditionCheck:{Key,ConditionExpression:'tenant_id = :tenant AND customer_id = :customer AND merchant_id = :merchant AND subscription_id = :subscription AND livemode = :test AND environment_id = :environment AND binding_revision = :revision',ExpressionAttributeValues:{':tenant':tenantId,':customer':b.customer_id,':merchant':b.merchant_id,':subscription':b.subscription_id,':test':false,':environment':this.stripeTestEnvironment,':revision':b.revision}}}));
    try{await this._tx([...(sandbox?.status==='active'?[{ConditionCheck:{Key:{pk:scope,sk:'SANDBOX_RISK_HOLD'},ConditionExpression:absent}}]:[]),{Put:{Item:{...Key,...d,decision_hash:decisionHash,entitlements_applied:false,...(sandbox?{sandbox_entitlement:sandbox}: {})},ConditionExpression:old?'observed_at = :previous':absent,...(old?{ExpressionAttributeValues:{':previous':old.observed_at}}:{})}},{Update:{Key:{pk:scope,sk:'EVENT#'+d.event_id},UpdateExpression:'SET #status = :done, decision_hash = :decision, reconciliation_receipt = :receipt',ConditionExpression:'tenant_id = :tenant AND payload_hash = :hash AND #status = :pending',ExpressionAttributeNames:{'#status':'status'},ExpressionAttributeValues:{':tenant':tenantId,':hash':d.payload_hash,':pending':'reconciliation_required',':done':'test_reconciled_not_applied',':decision':decisionHash,':receipt':receipt}}},accountPlan,...checks]);}catch(error){const recovered=recover(await this._get(eventKey));if(recovered)return recovered;if(conditional(error))fail(409,'reconciliation_transaction_conflict');throw error;}return {...receipt,duplicate:false};
  }

  async getStripeTestReconciliationReceipt(tenantId,{merchant_id,event_id}={}) {
    if(!this.stripeTestInbox)fail(503,'stripe_test_inbox_disabled');tenant(tenantId);if(typeof merchant_id!=='string'||!/^acct_[A-Za-z0-9]{1,180}$/.test(merchant_id)||typeof event_id!=='string'||!/^evt_[A-Za-z0-9]{1,180}$/.test(event_id))fail(400,'invalid_billing_receipt_query');if(!await this._stripeTenantExists(tenantId))fail(404,'tenant_not_found');const row=await this._get({pk:this._stripeTestScope(merchant_id),sk:'EVENT#'+event_id});if(!row||row.tenant_id!==tenantId||row.merchant_id!==merchant_id||row.livemode!==false||row.environment_id!==this.stripeTestEnvironment||row.status!=='test_reconciled_not_applied'||row.reconciliation_receipt?.entitlements_applied!==false)fail(404,'billing_receipt_not_found');if(this.sandboxEntitlementPolicy&&row.reconciliation_receipt.sandbox_policy_hash!==this.sandboxEntitlementPolicy.hash)fail(409,'sandbox_entitlement_new_event_required');return {...row.reconciliation_receipt,duplicate:true};
  }

  async getStripeSandboxEntitlement(tenantId,projectId) {
    const view=this.sandboxEntitlementPolicy;
    if(!view)fail(503,'sandbox_entitlements_disabled');
    const project=requireAlphaProject(tenantId,projectId),p=view.policy;
    const binding=await this.getStripeTestBinding(tenantId,p.merchant_id);
    const scope=this._stripeTestScope(p.merchant_id),row=await this._get({pk:tpk(tenantId),sk:scope+'#RECONCILIATION'});
    // quota_enforced is true only under the test-mode plan assignment, where the account's plan limits follow
    // the reconciled subscription. The ledger row below stays a preview; the enforced plan is the account row's.
    const base={sandbox:true,livemode:false,tenant_id:tenantId,project_id:project.id,paid_access:false,purchases_enabled:false,quota_enforced:view.planLimits===true,...(view.planLimits===true?{plan_limits:'stripe_test_mode'}:{})};
    if(await this._get({pk:scope,sk:'SANDBOX_RISK_HOLD'}))return {...base,status:'blocked',reason:'sandbox_risk_review_required'};
    const e=row?.sandbox_entitlement;
    if(!e)return {...base,status:'pending',reason:'sandbox_entitlement_reconciliation_required'};
    if(e.tenant_id!==tenantId||e.project_id!==project.id||e.merchant_id!==p.merchant_id||e.environment_id!==p.environment_id||
      e.livemode!==false||e.policy_hash!==view.hash||e.policy_revision!==p.revision||e.catalog_hash!==view.catalogHash||
      e.customer_id!==binding.customer_id||e.subscription_id!==binding.subscription_id||e.binding_revision!==binding.revision||
      e.source!=='sandbox_current_state'||e.paid_access!==false||e.quota_enforced!==(view.planLimits===true))fail(409,'sandbox_entitlement_binding_mismatch');
    if(e.status!=='active'||!Number.isSafeInteger(e.expires_at)||e.expires_at<=this.now())return {...base,status:'blocked',reason:'sandbox_entitlement_reconciliation_required'};
    const plan=p.plans.find(plan=>plan.id===e.plan_id&&plan.price_id!==null);
    if(!plan||plan.storage_limit_bytes!==e.storage_limit_bytes)fail(409,'sandbox_entitlement_policy_mismatch');
    // Under test-mode plan assignment the policy's storage_limit_bytes is only the ledger's own number; the
    // enforced allowances are the plan's (see /api/usage), so it is left out here rather than shown as a limit.
    return {...base,status:'active',plan_id:plan.id,...(view.planLimits===true?{}:{storage_limit_bytes:plan.storage_limit_bytes}),expires_at:e.expires_at,policy_hash:view.hash};
  }

  async recordStripeTestEvent(verifiedEvent) {
    if(!this.stripeTestInbox)fail(503,'stripe_test_inbox_disabled');const intent=stripeTestIntent(verifiedEvent);if(intent.environment_id!==this.stripeTestEnvironment)fail(409,'stripe_sandbox_environment_mismatch');const scope=this._stripeTestScope(intent.merchant_id),Key={pk:scope,sk:'EVENT#'+intent.event_id};
    const duplicateReceipt=async row=>{if(row.payload_hash!==intent.payload_hash||row.environment_id!==this.stripeTestEnvironment||row.merchant_id!==intent.merchant_id||row.customer_id!==intent.customer_id||row.livemode!==false)fail(409,'billing_event_conflict');await this._requireStripeInbox(intent);return {event_id:intent.event_id,status:row.status,duplicate:true,purchases_enabled:false};};const old=await this._get(Key);if(old)return duplicateReceipt(old);
    const customerKey={pk:scope,sk:'CUSTOMER#'+intent.customer_id},binding=await this._get(customerKey);if(!binding?.tenant_id||binding.livemode!==false||binding.environment_id!==this.stripeTestEnvironment||binding.merchant_id!==intent.merchant_id||binding.customer_id!==intent.customer_id)fail(409,'billing_customer_unbound');
    const row={...Key,...intent,tenant_id:binding.tenant_id,status:'reconciliation_required'};
    try{await this._tx([...this._stripeInboxWrite(intent),{Put:{Item:row,ConditionExpression:absent}},{ConditionCheck:{Key:customerKey,ConditionExpression:'tenant_id = :tenant AND customer_id = :customer AND merchant_id = :merchant AND livemode = :test AND environment_id = :environment',ExpressionAttributeValues:{':tenant':binding.tenant_id,':customer':intent.customer_id,':merchant':intent.merchant_id,':test':false,':environment':this.stripeTestEnvironment}}},{ConditionCheck:{Key:tenantKey(binding.tenant_id),ConditionExpression:'attribute_exists(pk)'}},{ConditionCheck:{Key:{pk:tpk(binding.tenant_id),sk:scope},ConditionExpression:'customer_id = :customer AND merchant_id = :merchant AND tenant_id = :tenant AND livemode = :test AND environment_id = :environment',ExpressionAttributeValues:{':customer':intent.customer_id,':merchant':intent.merchant_id,':tenant':binding.tenant_id,':test':false,':environment':this.stripeTestEnvironment}}}]);}
    catch(error){const saved=await this._get(Key);if(saved)return duplicateReceipt(saved);if(saved)fail(409,'billing_event_conflict');if(conditional(error))fail(409,'billing_event_record_conflict');throw error;}
    await this._requireStripeInbox(intent);return {event_id:intent.event_id,status:row.status,duplicate:false,purchases_enabled:false};
  }

  /** byteCount and requestHash MUST be computed server-side over the exact S3 bytes. */
  async reserveBatch(tenantId, { batch_id, run_id, request_hash, byte_count, event_count }) {
    tenant(tenantId); id(batch_id); id(run_id); hash(request_hash); positive(byte_count, 524288); positive(event_count, 100);
    const Key = batchKey(tenantId, batch_id);
    const check = row => {
      if (row.request_hash !== request_hash || row.byte_count !== byte_count || row.run_id !== run_id || row.event_count !== event_count) fail(409, 'idempotency_conflict');
      return row;
    };
    const existing = await this._get(Key); if (existing) return check(existing);
    const commercial=await this.resolveCommercialQuota(tenantId);if(commercial?.blocked)fail(403,'commercial_upload_blocked');
    // Acceptance order is assigned when the batch is accepted, not when bytes are reserved.
    const row = { ...Key, tenant_id: tenantId, batch_id, run_id, request_hash, byte_count, event_count,
      object_key: `v1/${digest(tenantId+(this.projectId&&this.projectId!==alphaProject(tenantId).id?':project:'+this.projectId:'')+(this.environmentId&&this.environmentId!=='default'?':environment:'+this.environmentId:''))}/${request_hash}.json`, status: 'pending', created_at: this.now() };
    const globalCap = { Update: { Key: globalKey, UpdateExpression: 'ADD used_bytes :bytes',
      ConditionExpression: 'attribute_not_exists(used_bytes) OR used_bytes <= :remaining',
      ExpressionAttributeValues: { ':bytes': byte_count, ':remaining': this.limits.globalBytes - byte_count } } };
    if (commercial) {
      // Explicitly enrolled live commercial accounts keep their policy-bound cumulative limit.
      const tenantLimit=commercial.limit_bytes;
      if (byte_count > tenantLimit || byte_count > this.limits.globalBytes) fail(429, 'storage_capacity');
      try { await this._tx([
        ...(commercial.checks||[]),
        { Put: { Item: row, ConditionExpression: absent } },
        { Update: { Key: tenantKey(tenantId), UpdateExpression: 'ADD used_bytes :bytes',
          ConditionExpression: 'attribute_exists(pk) AND byte_limit = :limit AND used_bytes <= :remaining AND commercial_managed = :managed AND commercial_namespace = :scope AND commercial_policy_hash = :policy AND commercial_policy_revision = :revision',
          ExpressionAttributeValues: { ':bytes': byte_count, ':limit': 0, ':remaining': tenantLimit - byte_count,':managed':true,':scope':this._commercialScope(),':policy':this.commercialPolicy.hash,':revision':this.commercialPolicy.policy.revision } } },
        globalCap
      ]); return row; }
      catch (error) {
        const saved = await this._get(Key); if (saved) return check(saved);
        if (conditional(error)) fail(429, 'storage_capacity_or_unknown_tenant'); throw error;
      }
    }
    // Plan path: the account's plan row decides the monthly span allowance and the stored-byte
    // allowance. Both are checked in the same transaction as the batch marker and the global cap.
    const account = await this._get(tenantKey(tenantId));
    // A deleted organization takes no uploads, whatever key is presented.
    if (Number.isSafeInteger(account?.deleted_at)) fail(403, 'workspace_unavailable');
    // One instant decides the month: the marker's created_at. The marker also records that month, so acceptance
    // meters into the same row even when the request straddles a month boundary.
    const period = usagePeriod(row.created_at), periodRow = periodKey(tenantId, period.id, this.planBillingMode), month = account ? await this._get(periodRow) : null;
    const usage = this._planUsage(account, month, row.created_at), { plan } = usage, storedLimit = this._storedLimit(plan), cap = spendCap(account, plan);
    requireOverageBinding(account, row.created_at, this.planBillingMode);
    const billingFence = planFence(account);
    row.usage_period = period.id;
    row.usage_mode = this.planBillingMode ?? 'test';
    // An identical request may have reserved the last room since the marker read: return its reservation, not a 429.
    if (account) try { this._requireNotPaused(account, plan, row.created_at); this._requirePlanRoom(usage, { byte_count, event_count }); } catch (error) { const saved = await this._get(Key); if (saved) return check(saved); throw error; }
    if (byte_count > this.limits.globalBytes) fail(429, 'storage_capacity');
    try { await this._tx([
      { Put: { Item: row, ConditionExpression: absent } },
      // byte_limit 0 is the commercial-enrollment sentinel: an enrolled account never falls back to a plan allowance here.
      { Update: { Key: tenantKey(tenantId), UpdateExpression: 'ADD used_bytes :bytes',
        // The plan and the spend-cap choice are pinned to what was read, so a downgrade or a cap switched on mid-request fails closed.
        ConditionExpression: 'attribute_exists(pk) AND byte_limit > :zero AND used_bytes <= :remaining AND '+billingFence.condition,
        ExpressionAttributeValues: { ':bytes': byte_count, ':zero': 0, ':remaining': storedLimit - byte_count, ...billingFence.values } } },
      { Update: { Key: periodRow, UpdateExpression: 'SET tenant_id = :tenant, period = :period, starts_at = :starts, resets_at = :resets ADD spans :spans, bytes :bytes, batches :one',
        // Spend cap off: no span ceiling; spans past the included allowance are metered as overage.
        ...(cap.enabled ? { ConditionExpression: 'attribute_not_exists(spans) OR spans <= :room' } : {}),
        ExpressionAttributeValues: { ':tenant': tenantId, ':period': period.id, ':starts': period.starts_at, ':resets': period.resets_at, ':spans': event_count, ':bytes': byte_count, ':one': 1, ...(cap.enabled ? { ':room': plan.spans_per_month - event_count } : {}) } } },
      globalCap
    ]);
      // Tell the caller when this reservation reached an alert threshold that has not been recorded for the month.
      // Not stored on the marker: it is a hint for this request only.
      let used = usage.spans_used + event_count, recorded = counter(month?.alert_level);
      // `used` is this batch plus the count read before the transaction, so concurrent reservations are missing
      // from it. Close to a threshold that is not recorded yet, read the committed row: whichever reservation
      // commits last sees the true total. "Close" is what one account can reserve concurrently: the upload
      // rate limit (30 a minute) times the largest batch (100 events).
      // Every threshold above both the recorded level and the estimate counts, not only the next one: the 80%
      // record can be missing (its write failed, or the spans arrived another way) while 100% is within reach.
      const estimate = usageAlertLevel(used, plan.spans_per_month);
      if (USAGE_ALERT_LEVELS.some(level => level > recorded && level > estimate && used >= Math.ceil(plan.spans_per_month * level / 100) - ALERT_RECONCILE_SPANS)) {
        try { const committed = await this._get(periodRow); used = Math.max(used, counter(committed?.spans)); recorded = Math.max(recorded, counter(committed?.alert_level)); } catch { /* the reservation stands; a later upload re-evaluates */ }
      }
      const level = usageAlertLevel(used, plan.spans_per_month);
      if (level > recorded) Object.defineProperty(row, 'usageAlert', { value: Object.freeze({ level, period: period.id, plan: plan.id, limit: plan.spans_per_month, used, resets_at: period.resets_at, spend_cap: cap.enabled }) });
      return row; }
    catch (error) {
      const saved = await this._get(Key); if (saved) return check(saved);
      if (!conditional(error)) throw error;
      // Name the exhausted allowance when a consistent re-read shows one; otherwise stay with the ambiguous code.
      const current = await this._get(tenantKey(tenantId));
      if (current && current.byte_limit > 0) this._requirePlanRoom(this._planUsage(current, await this._get(periodRow), row.created_at), { byte_count, event_count });
      fail(429, 'storage_capacity_or_unknown_tenant');
    }
  }
  _storedLimit(plan) { return this.limits.accountCeilingBytes === null ? plan.stored_bytes : Math.min(plan.stored_bytes, this.limits.accountCeilingBytes); }
  _planUsage(account, periodRow, at = this.now()) {
    const plan = planLimits(this.effectivePlanId(account)), period = usagePeriod(at), storedLimit = this._storedLimit(plan);
    const row = periodRow?.sk === planUsagePrefix(this.planBillingMode) + period.id ? periodRow : null;
    return { plan, period, spend_cap: spendCap(account, plan), alert_level: counter(row?.alert_level), spans_used: counter(row?.spans), bytes_ingested: counter(row?.bytes), batches: counter(row?.batches), accepted_spans: counter(row?.accepted_spans), accepted_bytes: counter(row?.accepted_bytes), accepted_batches: counter(row?.accepted_batches), stored_bytes: counter(account?.used_bytes), stored_limit: storedLimit };
  }
  /** Idle pause: a Free project with no accepted upload for IDLE_PAUSE.days refuses new uploads until resumed. */
  _requireNotPaused(account, plan, at) {
    const life = projectLifecycle(account, at, plan); if (life.state !== 'paused') return;
    fail(403, 'project_paused', { plan: plan.id, paused_instant: life.pauses_at, paused_at: new Date(life.pauses_at * 1000).toISOString(), resume_url: RESUME_PATH,
      message: `This project is paused: no trace was accepted for ${IDLE_PAUSE.days} days, and ${plan.name} projects pause when idle. Stored traces are kept. The workspace owner can resume it in one click under Usage; uploads work again at once.` });
  }
  /**
   * One-click resume. Idempotent: resuming a project that is not paused changes nothing. Stamps resumed_at, which
   * counts as activity, so the idle window starts again from now.
   */
  async resumeProject(tenantId) {
    tenant(tenantId); const account = await this._get(tenantKey(tenantId)); if (!account) fail(404, 'tenant_not_found');
    const life = row => projectLifecycle(row, this.now(), planLimits(this.effectivePlanId(row)));
    const now = this.now(), before = life(account); if (before.state !== 'paused') return { resumed: false, lifecycle: before };
    // A transaction, not a bare update: the request's scoped store adds its session and owner-membership fences to
    // transactions, so a resume decided before an ownership transfer or sign-out cannot be written after it.
    try { await this._tx([{ Update: { Key: tenantKey(tenantId), UpdateExpression: 'SET resumed_at = :now',
      ConditionExpression: 'attribute_exists(pk) AND (attribute_not_exists(resumed_at) OR resumed_at < :now)', ExpressionAttributeValues: { ':now': now } } }]); }
    catch (error) {
      if (!conditional(error)) throw error;
      // Either a concurrent resume won (nothing left to do) or a fence refused this writer.
      const current = life(await this._get(tenantKey(tenantId))); if (current.state === 'paused') fail(409, 'workspace_changed');
      return { resumed: false, lifecycle: current };
    }
    return { resumed: true, lifecycle: life(await this._get(tenantKey(tenantId))) };
  }
  /**
   * Notification row for a pause, written once per pause (keyed by the instant it took effect). Returns whether
   * this call created it, so the caller sends at most one email per pause.
   */
  async recordPauseNotice(tenantId, pausedAt, { email_status = 'not_configured' } = {}) {
    tenant(tenantId); if (!Number.isSafeInteger(pausedAt) || pausedAt < 0 || !['not_configured', 'no_address', 'pending', 'not_in_plan'].includes(email_status)) fail(400, 'invalid_pause_notice');
    const Key = pauseNoticeKey(tenantId, pausedAt), notice = { ...Key, tenant_id: tenantId, kind: 'project_paused', paused_at: pausedAt, idle_days: IDLE_PAUSE.days, email_status, created_at: this.now() };
    try { await this._send('PutCommand', { Item: notice, ConditionExpression: absent }); return { created: true, notice }; }
    catch (error) { if (!conditional(error)) throw error; return { created: false, notice: await this._get(Key) }; }
  }
  async setPauseNoticeEmail(tenantId, pausedAt, status) {
    tenant(tenantId); if (!['sent', 'failed'].includes(status)) fail(400, 'invalid_pause_notice');
    await this._send('UpdateCommand', { Key: pauseNoticeKey(tenantId, pausedAt), UpdateExpression: 'SET email_status = :status', ConditionExpression: 'email_status = :pending', ExpressionAttributeValues: { ':status': status, ':pending': 'pending' } });
  }
  async getPauseNotice(tenantId, pausedAt) { tenant(tenantId); return await this._get(pauseNoticeKey(tenantId, pausedAt)) ?? null; }
  _requirePlanRoom(usage, { byte_count, event_count }) {
    const { plan, period } = usage, base = { plan: plan.id, period: period.id, resets_at: new Date(period.resets_at * 1000).toISOString(), upgrade_url: UPGRADE_PATH };
    // A plan with overage stops only because its spend cap is on, and says so: the owner can turn the cap off.
    if (usage.spend_cap.enabled && plan.overage && usage.spans_used + event_count > plan.spans_per_month) fail(429, 'spend_cap_reached', { ...base, cost_control_url: UPGRADE_PATH, limit: plan.spans_per_month, used: usage.spans_used, requested: event_count, unit: 'spans',
      message: `Spend cap is on: the ${plan.name} plan's ${plan.spans_per_month} included spans this month are used up, so uploads stop instead of adding overage. They resume on ${base.resets_at.slice(0, 10)} (UTC), or when the workspace owner turns the spend cap off under Billing.` });
    if (usage.spend_cap.enabled && usage.spans_used + event_count > plan.spans_per_month) fail(429, 'monthly_span_allowance_exceeded', { ...base, limit: plan.spans_per_month, used: usage.spans_used, requested: event_count, unit: 'spans',
      message: `${plan.name} plan allowance of ${plan.spans_per_month} spans this month is used up. It resets on ${base.resets_at.slice(0, 10)} (UTC). Upgrade in Billing for a higher allowance.` });
    if (usage.stored_bytes + byte_count > usage.stored_limit) fail(429, 'stored_bytes_allowance_exceeded', { plan: plan.id, upgrade_url: UPGRADE_PATH, limit: usage.stored_limit, used: usage.stored_bytes, requested: byte_count, unit: 'bytes',
      message: `${plan.name} plan stored-data allowance of ${usage.stored_limit} bytes is used up. Stored bytes do not reset monthly. Upgrade in Billing for a higher allowance.` });
  }
  /** This month's and recent months' meters plus the Stripe test-meter reporting state. Read-only. */
  async getUsageMeters(tenantId, currentPeriodId = usagePeriod(this.now()).id) {
    tenant(tenantId); if (typeof currentPeriodId !== 'string' || !/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(currentPeriodId)) fail(400, 'invalid_usage_period');
    const prefix = planUsagePrefix(this.planBillingMode), current = { id: currentPeriodId }, page = await this._page(tpk(tenantId), prefix, { limit: 100 });
    // Rows created by an accept alone (no reservation that month under the plan path) carry no `period`; the key is authoritative.
    const rows = page.items.filter(row => row.sk.startsWith(prefix) && /^[0-9]{4}-(0[1-9]|1[0-2])$/.test(row.sk.slice(prefix.length))).map(row => ({ ...row, period: row.sk.slice(prefix.length) }));
    // reserved_* include uploads still pending or never completed; accepted_* count stored, accepted batches only.
    const view = row => ({ period: row.period, reserved_spans: counter(row.spans), accepted_spans: counter(row.accepted_spans), reserved_bytes: counter(row.bytes), accepted_bytes: counter(row.accepted_bytes), accepted_batches: counter(row.accepted_batches) });
    const state = this.planBillingMode === 'live' ? null : await this._get(meterKey(tenantId, current.id));
    return { current: view(rows.find(row => row.period === current.id) ?? { period: current.id }), history: rows.filter(row => row.period < current.id).slice(-11).map(view),
      reporting: !state ? { status: 'not_reported', reported_spans: 0 } : { status: state.hold === true ? 'held' : state.pending ? 'pending' : 'reported', reported_spans: counter(state.reported_spans) } };
  }
  /** Phase one of a meter report: persist exactly what will be sent before Stripe is called. Returns null when nothing is unreported. */
  async beginUsageMeterReport(tenantId, periodId, { merchant_id, customer_id } = {}) {
    tenant(tenantId); if (typeof periodId !== 'string' || !/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(periodId) || typeof merchant_id !== 'string' || !/^acct_[A-Za-z0-9]{1,180}$/.test(merchant_id) || typeof customer_id !== 'string' || !/^cus_[A-Za-z0-9]{1,180}$/.test(customer_id)) fail(400, 'invalid_usage_meter_report');
    const Key = meterKey(tenantId, periodId), state = await this._get(Key);
    if (state?.hold === true) fail(409, 'usage_meter_hold');
    if (state?.pending) {
      // A stored intent is resent as written. If the account was rebound to another Customer meanwhile, stop.
      if (state.pending.customer_id !== customer_id || state.merchant_id !== merchant_id) fail(409, 'usage_meter_binding_changed');
      return { ...state.pending, seq: state.seq, resumed: true };
    }
    // Only accepted spans are reported: a reservation whose upload failed or was abandoned is never sent to Stripe.
    const usage = await this._get(periodKey(tenantId, periodId)), spans = counter(usage?.accepted_spans), reported = counter(state?.reported_spans);
    if (spans <= reported) return null;
    const [year, month] = periodId.split('-').map(Number), end = Date.UTC(year, month, 1) / 1000, seq = counter(state?.seq) + 1;
    // The identifier is derived from the report's position, never from time or randomness: a retry of report N reuses it.
    const pending = { identifier: 'supatrace-usage-' + digest(JSON.stringify([merchant_id, this.stripeTestEnvironment, tenantId, periodId, seq])).slice(0, 48), value: spans - reported, upto: spans, customer_id, timestamp: Math.min(this.now(), end - 1), created_at: this.now() };
    try { await this._send('PutCommand', { Item: { ...Key, tenant_id: tenantId, period: periodId, merchant_id, livemode: false, reported_spans: reported, seq, pending, hold: false, updated_at: this.now() },
      ConditionExpression: state ? 'seq = :prev AND #hold = :no' : absent, ...(state ? { ExpressionAttributeNames: { '#hold': 'hold' }, ExpressionAttributeValues: { ':prev': state.seq, ':no': false } } : {}) }); }
    catch (error) { if (conditional(error)) fail(409, 'usage_meter_report_conflict'); throw error; }
    return { ...pending, seq, resumed: false };
  }
  /** Phase two: mark the stored intent as delivered, or hold the period for reconciliation. */
  async finishUsageMeterReport(tenantId, periodId, intent, { hold = false } = {}) {
    tenant(tenantId); if (!Number.isSafeInteger(intent?.seq) || !Number.isSafeInteger(intent?.upto) || typeof intent.identifier !== 'string') fail(400, 'invalid_usage_meter_report');
    try { await this._send('UpdateCommand', { Key: meterKey(tenantId, periodId),
      UpdateExpression: hold ? 'SET #hold = :yes, updated_at = :now' : 'SET reported_spans = :upto, pending = :none, last_identifier = :identifier, updated_at = :now',
      ConditionExpression: 'seq = :seq AND #hold = :no', ExpressionAttributeNames: { '#hold': 'hold' },
      ExpressionAttributeValues: hold ? { ':yes': true, ':no': false, ':seq': intent.seq, ':now': this.now() } : { ':upto': intent.upto, ':none': null, ':identifier': intent.identifier, ':no': false, ':seq': intent.seq, ':now': this.now() } }); }
    catch (error) { if (conditional(error)) fail(409, 'usage_meter_report_conflict'); throw error; }
    return { reported_spans: hold ? undefined : intent.upto, hold };
  }
  /** Owner's choice for a plan with overage. Refused for plans that always stop at their allowance. */
  /** Enterprise custom retention: `days` is 1..RETENTION_MAX_DAYS, or null to return to the plan's days. Applies to data accepted from now on. */
  async setRetention(tenantId, days) {
    tenant(tenantId); if (days !== null && (!Number.isSafeInteger(days) || days < 1 || days > RETENTION_MAX_DAYS)) fail(400, 'invalid_retention');
    const account = await this._get(tenantKey(tenantId)); if (!account) fail(404, 'tenant_not_found');
    requireFeature(this.effectivePlanId(account), 'custom_retention');
    const plan = planLimits(this.effectivePlanId(account)), before = retentionDays(account, plan);
    try { await this._tx([{ Update: { Key: tenantKey(tenantId), UpdateExpression: days === null ? 'REMOVE retention_days' : 'SET retention_days = :days',
      ConditionExpression: 'attribute_exists(pk) AND plan_id = :plan', ExpressionAttributeValues: { ':plan': account.plan_id, ...(days === null ? {} : { ':days': days }) } } },
      ...this._auditItems('settings.retention_changed', null, { from: before, to: days ?? plan.retention_days })]); }
    catch (error) { if (conditional(error)) fail(409, 'billing_changed'); throw error; }
    return { retention_days: days ?? plan.retention_days, plan_default_days: plan.retention_days, custom: days !== null };
  }
  async setSpendCap(tenantId, enabled, binding = null) {
    tenant(tenantId); if (typeof enabled !== 'boolean') fail(400, 'invalid_spend_cap');
    const account = await this._get(tenantKey(tenantId)); if (!account) fail(404, 'tenant_not_found');
    if (account.commercial_managed !== true) requireFeature(this.effectivePlanId(account), 'spend_cap');
    const plan = planLimits(this.effectivePlanId(account)); if (!plan.overage || account.commercial_managed === true) fail(409, 'spend_cap_not_configurable');
    if (!enabled && stripePlanMatches(account, this.planBillingMode) && (!binding || binding.customer !== account.stripe_customer_id || binding.subscription !== account.stripe_subscription_id)) fail(409, 'overage_binding_required');
    const bindingSet = !enabled && binding ? ', overage_customer_id = :oc, overage_subscription_id = :os, overage_price_id = :op' : '';
    const modeFence = stripeStateFence(account);
    const bindingCondition = bindingSet ? ' AND plan_source = :source AND stripe_customer_id = :oc AND stripe_subscription_id = :os' : '';
    // A transaction, so the request's session and owner-membership fences (and its audit event) apply to this write too.
    try { await this._tx([{ Update: { Key: tenantKey(tenantId), UpdateExpression: 'SET spend_cap = :cap, spend_cap_updated_at = :now'+bindingSet,
      ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(deleted_at) AND plan_id = :plan AND byte_limit > :zero AND '+modeFence.condition+bindingCondition, ExpressionAttributeValues: { ':cap': enabled, ':now': this.now(), ':plan': account.plan_id, ':zero': 0, ...modeFence.values, ...(bindingSet ? {':source':account.plan_source, ':oc':binding.customer, ':os':binding.subscription, ':op':binding.price} : {}) } } },
      ...this._auditItems('billing.spend_cap_changed', null, { enabled })]); }
    catch (error) { if (conditional(error)) fail(409, 'spend_cap_conflict'); throw error; }
    return spendCap({ ...account, spend_cap: enabled }, plan);
  }
  /**
   * Record that the account reached an alert threshold this month. One notification row per account, month and level;
   * the month's usage row remembers the highest level recorded so later uploads do not try again.
   */
  async recordUsageAlert(tenantId, alert, { email_status = 'not_configured' } = {}) {
    tenant(tenantId);
    if (!USAGE_ALERT_LEVELS.includes(alert?.level) || typeof alert.period !== 'string' || !/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(alert.period) || !Number.isSafeInteger(alert.limit) || !Number.isSafeInteger(alert.used) || !['not_configured', 'no_address', 'pending', 'not_in_plan'].includes(email_status)) fail(400, 'invalid_usage_alert');
    const Key = noticeKey(tenantId, alert.period, alert.level, this.planBillingMode), notice = { ...Key, tenant_id: tenantId, kind: 'usage_' + alert.level, level: alert.level, period: alert.period, plan: alert.plan, limit: alert.limit, used: alert.used, spend_cap: alert.spend_cap === true, resets_at: alert.resets_at, email_status, created_at: this.now() };
    const remember = { Update: { Key: periodKey(tenantId, alert.period, this.planBillingMode), UpdateExpression: 'SET alert_level = :level', ConditionExpression: 'attribute_not_exists(alert_level) OR alert_level < :level', ExpressionAttributeValues: { ':level': alert.level } } };
    try { await this._tx([{ Put: { Item: notice, ConditionExpression: absent } }, remember]); return { created: true, notice }; }
    catch (error) {
      if (!conditional(error)) throw error;
      // Already recorded, or a higher level was. Make sure the month remembers at least this level, then report no new notice.
      try { await this._send('UpdateCommand', { Key: remember.Update.Key, UpdateExpression: remember.Update.UpdateExpression, ConditionExpression: remember.Update.ConditionExpression, ExpressionAttributeValues: remember.Update.ExpressionAttributeValues }); } catch (again) { if (!conditional(again)) throw again; }
      return { created: false, notice: await this._get(Key) };
    }
  }
  async setUsageAlertEmail(tenantId, periodId, level, status) {
    tenant(tenantId); if (!['sent', 'failed'].includes(status)) fail(400, 'invalid_usage_alert');
    await this._send('UpdateCommand', { Key: noticeKey(tenantId, periodId, level, this.planBillingMode), UpdateExpression: 'SET email_status = :status', ConditionExpression: 'email_status = :pending', ExpressionAttributeValues: { ':status': status, ':pending': 'pending' } });
  }
  /** This month's alert notifications for the account, oldest first. */
  async listUsageAlerts(tenantId, periodId) {
    tenant(tenantId); if (typeof periodId !== 'string' || !/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(periodId)) fail(400, 'invalid_usage_period');
    const page = await this._page(tpk(tenantId), noticePrefix(periodId, this.planBillingMode), { limit: 10 });
    return page.items.filter(row => USAGE_ALERT_LEVELS.includes(row.level)).sort((a, b) => a.level - b.level).map(row => ({ kind: row.kind, level: row.level, period: row.period, used: counter(row.used), limit: counter(row.limit), email_status: row.email_status, created_at: row.created_at }));
  }
  /** Own-account plan allowance and this month's meters for /api/usage. Read-only. */
  async getPlanUsage(tenantId) {
    tenant(tenantId); const account = await this._get(tenantKey(tenantId)); if (!account) fail(404, 'tenant_not_found');
    const usage = this._planUsage(account, await this._get(periodKey(tenantId, usagePeriod(this.now()).id, this.planBillingMode)));
    return { ...usage, limits_version: PLAN_LIMITS.version, limits_status: PLAN_LIMITS.status };
  }
  /** Call ONLY after S3 putImmutable durably stores/verifies the exact reserved bytes. */
  async acceptReservedBatch(tenantId, batchId, requestHash, trace) {
    const Key = batchKey(tenantId, batchId); hash(requestHash);
    const receipt = { accepted: true, batch_id: batchId, request_hash: requestHash };
    for (let attempt = 0; attempt < 4; attempt++) {
      const row = await this._get(Key);
      if (!row) fail(404, 'reservation_not_found');
      if (row.request_hash !== requestHash) fail(409, 'idempotency_conflict');
      if (row.status === 'accepted') return receipt;
      const account = await this._get(tenantKey(tenantId));
      const prev = Number.isSafeInteger(account?.upload_seq) && account.upload_seq >= 0 ? account.upload_seq : 0;
      if (prev >= Number.MAX_SAFE_INTEGER) fail(429, 'storage_capacity_or_unknown_tenant');
      const seq = prev + 1;
      // '~' sorts after every batch id, so batches stored before upload_seq existed stay listed first.
      const order = `BATCH#~${String(seq).padStart(10, '0')}#${batchId}`;
      const acceptedAt = this.now();
      // Retention is stamped once, at accept time, from the plan the account has then. A later plan change
      // never rewrites data that is already stored. Commercially enrolled rows are outside the plan table.
      const retention = account && account.commercial_managed !== true ? retentionDays(account, planLimits(this.effectivePlanId(account))) : null;
      const metered = !!account && account.commercial_managed !== true;
      if (metered) requireOverageBinding(account, acceptedAt, this.planBillingMode);
      const billingFence = metered ? planFence(account) : {condition:'attribute_exists(pk)', values:{}};
      const overage = metered ? await acceptedOverage(this,tenantId,account,row,acceptedAt) : [];
      const stamp = retention === null ? {} : { retention_days: retention, retention_expires_at: acceptedAt + retention * 86400 };
      const keep = retention === null ? ['', {}] : [', retention_days = :keepDays, retention_expires_at = :keepUntil', { ':keepDays': stamp.retention_days, ':keepUntil': stamp.retention_expires_at }];
      const runKey = { pk: tpk(tenantId), sk: `RUN#${row.run_id}` };
      const existingRun = await this._get(runKey);
      const summary = runSummary(trace, trace ? existingRun : null, row);
      // The run row holds the newest expiry across its batches, and none at all once the run holds any batch
      // without a stamp (stored before retention stamping, or accepted for a commercially enrolled account).
      // So appending to a run never hides data that does not expire. null is the explicit "no expiry" value.
      const runUntil = retention === null || existingRun && !Number.isSafeInteger(existingRun.retention_expires_at) ? null
        : Math.max(stamp.retention_expires_at, existingRun?.retention_expires_at ?? 0);
      const keepRun = runUntil === null && !Number.isSafeInteger(existingRun?.retention_expires_at) ? ['', {}] : [', retention_expires_at = :runUntil', { ':runUntil': runUntil }];
      const runUpdate = summary
        ? { Update: { Key: runKey,
          UpdateExpression: 'SET run_id = :run, created_at = if_not_exists(created_at, :created), started_at = :started, ended_at = :ended, has_error = :err, writers = :writers' + keepRun[0] + ' ADD batch_count :one, event_count :events, byte_count :bytes',
          ConditionExpression: 'attribute_not_exists(batch_count) OR batch_count = :prev',
          ExpressionAttributeValues: { ':run': row.run_id, ':created': row.created_at, ':one': 1, ...summary, ...keepRun[1] } } }
        : { Update: { Key: runKey,
          UpdateExpression: 'SET run_id = :run, created_at = if_not_exists(created_at, :created)' + keepRun[0] + ' ADD batch_count :one',
          // The run expiry was derived from the row as read: only apply it to that same row state.
          ConditionExpression: existingRun ? 'batch_count = :seen' : 'attribute_not_exists(batch_count)',
          ExpressionAttributeValues: { ':run': row.run_id, ':created': row.created_at, ':one': 1, ...(existingRun ? { ':seen': existingRun.batch_count } : {}), ...keepRun[1] } } };
      try { await this._tx([
        { Update: { Key, UpdateExpression: 'SET #status = :accepted, accepted_at = :now, upload_seq = :seq' + keep[0],
          ConditionExpression: 'tenant_id = :tenant AND request_hash = :hash AND #status = :pending AND attribute_not_exists(upload_seq)',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':tenant': tenantId, ':hash': requestHash, ':pending': 'pending', ':accepted': 'accepted', ':now': acceptedAt, ':seq': seq, ...keep[1] } } },
        runUpdate,
        { Put: { Item: { pk: `${tpk(tenantId)}#RUN#${row.run_id}`, sk: order, tenant_id: tenantId,
          batch_id: batchId, request_hash: requestHash, object_key: row.object_key, byte_count: row.byte_count,
          event_count: row.event_count, upload_seq: seq, accepted_at: acceptedAt, ...stamp }, ConditionExpression: absent } },
        // last_accepted_at is the activity stamp the idle pause (#113) counts from.
        { Update: { Key: tenantKey(tenantId), UpdateExpression: 'SET upload_seq = :seq, last_accepted_at = :accepted',
          ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(deleted_at) AND (attribute_not_exists(upload_seq) OR upload_seq = :prev) AND '+billingFence.condition,
          ExpressionAttributeValues: { ':seq': seq, ':prev': prev, ':accepted': acceptedAt, ...billingFence.values } } },
        // Accepted meters, in the month recorded on the marker at reservation. The marker's pending -> accepted condition above
        // makes this count each batch exactly once. Reserved counters (spans, bytes) include uploads that never finish.
        ...overage,
        ...(metered ? [{ Update: { Key: periodKey(tenantId, typeof row.usage_period === 'string' && /^[0-9]{4}-(0[1-9]|1[0-2])$/.test(row.usage_period) ? row.usage_period : usagePeriod(Number.isSafeInteger(row.created_at) && row.created_at >= 0 ? row.created_at : acceptedAt).id, row.usage_mode ?? 'test'),
          UpdateExpression: 'ADD accepted_spans :spans, accepted_bytes :bytes, accepted_batches :one',
          ExpressionAttributeValues: { ':spans': row.event_count, ':bytes': row.byte_count, ':one': 1 } } }] : [])
      ]); return receipt; }
      catch (error) {
        const saved = await this._get(Key);
        if (saved?.status === 'accepted' && saved.request_hash === requestHash) return receipt;
        if (!conditional(error) || attempt === 3) throw error;
      }
    }
    fail(409, 'accept_conflict');
  }
  async getRun(tenantId, runId) { const row = await this._get({pk:tpk(tenantId),sk:'RUN#'+id(runId)}); return row && Number.isSafeInteger(row.retention_expires_at) && row.retention_expires_at <= this.now() ? null : row; }
  // Every list, read and export of trace data goes through getRun and these two methods, so retention is honored here.
  // Rows past their stamped expiry are skipped; rows stored before retention stamping existed carry no stamp
  // and are never treated as expired. Nothing is deleted.
  listRuns(tenantId, options = {}) { return this._retainedPage(tpk(tenantId), 'RUN#', options); }
  listAcceptedBatchIndexes(tenantId, runId, options = {}) { return this._retainedPage(`${tpk(tenantId)}#RUN#${id(runId)}`, 'BATCH#', options); }
  async _retainedPage(pk, prefix, options) {
    const now = this.now(), retained = row => !(Number.isSafeInteger(row.retention_expires_at) && row.retention_expires_at <= now);
    let cursor = options.cursor ?? null;
    // A page of only expired rows is not an empty result: keep reading, bounded, so small-limit readers still advance.
    for (let read = 0; ; read++) {
      const page = await this._page(pk, prefix, { ...options, cursor }), items = page.items.filter(retained);
      if (items.length || page.next === null || read === 24) return { items, next: page.next };
      cursor = page.next;
    }
  }
  async _page(pk, prefix, { cursor = null, limit = 50 } = {}) {
    positive(limit, 100); let ExclusiveStartKey;
    if (cursor !== null) {
      if (typeof cursor !== 'string' || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) fail(400, 'invalid_cursor');
      try { ExclusiveStartKey = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { fail(400, 'invalid_cursor'); }
      if (!ExclusiveStartKey || Object.keys(ExclusiveStartKey).length !== 2 || ExclusiveStartKey.pk !== pk ||
        typeof ExclusiveStartKey.sk !== 'string' || !ExclusiveStartKey.sk.startsWith(prefix) || ExclusiveStartKey.sk.length > 200) fail(400, 'invalid_cursor');
    }
    const response = await this._send('QueryCommand', { KeyConditionExpression: prefix === '' ? 'pk = :pk' : 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': pk, ...(prefix === '' ? {} : { ':prefix': prefix }) }, ConsistentRead: true, ScanIndexForward: true,
      Limit: limit, ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}) });
    return { items: response.Items ?? [], next: response.LastEvaluatedKey ? Buffer.from(JSON.stringify(response.LastEvaluatedKey)).toString('base64url') : null };
  }

  /** Conservative fixed-slot limiter. Cardinality cannot exceed rateSlots, even with attacker-chosen identities. */
  async consumeRate({ scope, identity, limit = 60, windowSeconds = 60, cooldown = false }) {
    if (typeof scope !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(scope) || typeof identity !== 'string' || !identity || identity.length > 512) fail(400, 'invalid_rate_scope');
    positive(limit, 100000); positive(windowSeconds, 86400);
    if (cooldown && limit !== 1) fail(400, 'invalid_rate_scope');
    const now = this.now(), window = Math.floor(now / windowSeconds), expiresAt = cooldown ? now + windowSeconds : (window + 1) * windowSeconds;
    const bucket = digest(JSON.stringify([scope, identity, windowSeconds, cooldown ? 'cooldown' : window]));
    const slot = Number(BigInt(`0x${bucket}`) % BigInt(this.limits.rateSlots));
    const Key = { pk: `RATE#${slot}`, sk: 'COUNTER' };
    const lease = cooldown ? random() : null;
    try { await this._send('PutCommand', { Item: { ...Key, bucket, hits: 1, expires_at: expiresAt, ttl: expiresAt, ...(lease ? {lease} : {}) },
      ConditionExpression: 'attribute_not_exists(pk) OR expires_at <= :now', ExpressionAttributeValues: { ':now': now } });
      return { allowed: true, hits: 1, retry_after: expiresAt - now, ...(lease ? {complete: async () => {
        await this._send('UpdateCommand', {Key, UpdateExpression: 'SET #completed = :yes', ConditionExpression: '#lease = :lease',
          ExpressionAttributeNames: {'#lease': 'lease', '#completed': 'completed'}, ExpressionAttributeValues: {':yes': true, ':lease': lease}});
      }, release: async () => {
        // A failed send may release only its own reservation, never a newer sender's.
        try { await this._send('DeleteCommand', {Key, ConditionExpression: '#lease = :lease', ExpressionAttributeNames: {'#lease': 'lease'}, ExpressionAttributeValues: {':lease': lease}}); }
        catch (error) { if (!conditional(error)) throw error; }
      }} : {}) };
    } catch (error) { if (!conditional(error)) throw error; }
    if (cooldown) {
      const row = await this._get(Key);
      const same = row?.bucket === bucket && row.expires_at > now;
      return {allowed: false, duplicate: same && row.completed === true, pending: same && row.completed !== true, retry_after: windowSeconds};
    }
    try {
      const response = await this._send('UpdateCommand', { Key, UpdateExpression: 'ADD hits :one',
        ConditionExpression: '#bucket = :bucket AND expires_at > :now AND hits < :limit', ExpressionAttributeNames: { '#bucket': 'bucket' },
        ExpressionAttributeValues: { ':one': 1, ':bucket': bucket, ':now': now, ':limit': limit }, ReturnValues: 'ALL_NEW' });
      return { allowed: true, hits: response.Attributes.hits, retry_after: expiresAt - now };
    } catch (error) { if (conditional(error)) return { allowed: false, retry_after: expiresAt - now }; throw error; }
  }
}
