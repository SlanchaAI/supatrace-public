import { createHash, randomBytes } from 'node:crypto';
import {alphaProject,requireAlphaProject} from './alpha-projects.mjs';

export class StoreError extends Error {
  constructor(status, code) { super(code); this.name = 'StoreError'; this.status = status; this.code = code; }
}
const fail = (status, code) => { throw new StoreError(status, code); };
export const digest = value => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
const absent = 'attribute_not_exists(pk)';
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : fail(400, 'invalid_hash');
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) ? value : fail(400, 'invalid_id');
const positive = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value > 0 && value <= max ? value : fail(400, 'invalid_count');
const tenant = value => {
  if (typeof value === 'string' && /^github-[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(Number(value.slice(7)))) return value;
  if (typeof value === 'string' && /^(google|email|chatgpt|sso)-[a-f0-9]{64}$/.test(value)) return value;
  fail(400, 'invalid_tenant');
};
const tpk = value => `TENANT#${tenant(value)}`;
const tenantKey = value => ({ pk: tpk(value), sk: 'META' });
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
// Physical ephemeral cardinality is fixed, not dependent on asynchronous TTL deletion.
const ephemeralSlots = 1000;
const tempKey = (kind, value, sk) => ({ pk: `${kind}#${Number(BigInt(`0x${hash(value)}`) % BigInt(ephemeralSlots))}`, sk });
const setupKey = value => tempKey('SETUP', value, 'REQUEST');
const codeKey = value => tempKey('CODE', digest(value), 'REQUEST');
const batchKey = (value, batchId) => ({ pk: tpk(value), sk: `BATCH#${id(batchId)}` });
function printableSubject(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 255) return false;
  for (const char of value) { const code = char.codePointAt(0); if (code <= 32 || code === 127) return false; }
  return true;
}
const samlCacheKey = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value) ? value : fail(400, 'invalid_id');

/** One PK/SK table. All times are integer epoch seconds. No S3 payloads or raw write keys. */
export class DynamoMetadataStore {
  constructor({ client, commands, tableName, now = () => Math.floor(Date.now() / 1000),
    tenantBytes = 10 * 1024 * 1024, globalBytes = 100 * 1024 * 1024,
    accounts = 100, activeKeys = 10, rateSlots = 5000 } = {}) {
    if (!client?.send || typeof tableName !== 'string' || !tableName || !commands) throw new TypeError('client, commands and tableName required');
    for (const name of ['GetCommand', 'PutCommand', 'DeleteCommand', 'UpdateCommand', 'QueryCommand', 'TransactWriteCommand'])
      if (typeof commands[name] !== 'function') throw new TypeError(`${name} required`);
    this.client = client; this.commands = commands; this.table = tableName; this.now = now;
    this.limits = { tenantBytes: positive(tenantBytes), globalBytes: positive(globalBytes), accounts: positive(accounts),
      activeKeys: positive(activeKeys, 100), rateSlots: positive(rateSlots, 100000) };
  }
  _send(name, input) { return this.client.send(new this.commands[name]({ TableName: this.table, ...input })); }
  async _get(Key) { return (await this._send('GetCommand', { Key, ConsistentRead: true })).Item ?? null; }
  _tx(items) { return this.client.send(new this.commands.TransactWriteCommand({ TransactItems: items.map(item => {
    const [kind, input] = Object.entries(item)[0]; return { [kind]: { TableName: this.table, ...input } };
  }) })); }
  async getTenant(tenantId) { return this._get(tenantKey(tenantId)); }

  async _provisionTenant(tenantId, identity) {
    const Key = tenantKey(tenantId);
    let row = await this._get(Key); if (row) return row;
    row = { ...Key, tenant_id: tenantId, ...identity, project_id: alphaProject(tenantId).id, created_at: this.now(), byte_limit: this.limits.tenantBytes, used_bytes: 0 };
    try {
      await this._tx([
        { Put: { Item: row, ConditionExpression: absent } },
        { Update: { Key: globalKey, UpdateExpression: 'ADD #n :one',
          ConditionExpression: 'attribute_not_exists(#n) OR #n < :cap', ExpressionAttributeNames: { '#n': 'accounts' },
          ExpressionAttributeValues: { ':one': 1, ':cap': this.limits.accounts } } }
      ]); return row;
    } catch (error) {
      // Also resolves an ambiguous successful transaction; never create another account blindly.
      const existing = await this._get(Key); if (existing) return existing;
      if (conditional(error)) fail(429, 'account_capacity'); throw error;
    }
  }

  /** Call only with the numeric subject from the verified GitHub /user response. */
  async getOrCreateTenant(githubSubject) {
    if (!Number.isSafeInteger(githubSubject) || githubSubject <= 0) fail(401, 'identity_not_verified');
    return this._provisionTenant(`github-${githubSubject}`, { provider: 'github', github_subject: githubSubject });
  }

  /** Call only with the sub string from Google's userinfo response. The id is a hash so it cannot collide with a GitHub account. */
  async getOrCreateGoogleTenant(subject) {
    if (typeof subject !== 'string' || !/^[A-Za-z0-9._~-]{1,255}$/.test(subject)) fail(401, 'identity_not_verified');
    return this._provisionTenant(`google-${digest(subject)}`, { provider: 'google', google_subject: subject });
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

  async updateEmailAccount(email, expression, values) {
    await this._send('UpdateCommand', { Key: this.emailKey(email), UpdateExpression: expression,
      ConditionExpression: 'email = :email', ExpressionAttributeValues: { ...values, ':email': email } });
  }

  async setTenantFields(tenantId, expression, values) {
    await this._send('UpdateCommand', { Key: tenantKey(tenantId), UpdateExpression: expression,
      ConditionExpression: 'attribute_exists(pk)', ExpressionAttributeValues: values });
  }

  _challengeKind(kind) { return kind === 'MFA' || kind === 'SIGNUP' || kind === 'RESET' ? kind : fail(400, 'invalid_challenge'); }

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
    if (kind !== 'MFA' && kind !== 'SIGNUP' && kind !== 'RESET') return null;
    try { hash(idHash); } catch { return null; }
    const row = await this._get(tempKey(kind, idHash, 'CHALLENGE'));
    return row && row.id_hash === idHash && row.expires_at > this.now() ? row : null;
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
    const key = samlCacheKey(cacheKey), expiresAt = this.now() + 8 * 3600;
    await this._send('PutCommand', { Item: { ...tempKey('SAML', digest(key), 'CACHE'), cache_key: key, value: String(value), expires_at: expiresAt, ttl: expiresAt } });
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
  async createSession(tokenHash, tenantId, expiresAt = this.now() + 86400) {
    hash(tokenHash); this._expiry(expiresAt, 86400);
    for (let attempt = 0; attempt < 2; attempt++) {
      const tenantRow = await this._get(tenantKey(tenantId));
      if (!tenantRow) fail(409, 'session_collision_or_unknown_tenant');
      const epoch = Number(tenantRow.session_epoch) || 0;
      try {
        await this._tx([
          { ConditionCheck: { Key: tenantKey(tenantId), ConditionExpression: 'attribute_exists(pk) AND (attribute_not_exists(session_epoch) OR session_epoch = :epoch)',
            ExpressionAttributeValues: { ':epoch': epoch } } },
          { Put: { Item: { ...tempKey('SESSION', tokenHash, 'SESSION'), token_hash: tokenHash, tenant_id: tenantId, session_epoch: epoch, expires_at: expiresAt, ttl: expiresAt },
            ConditionExpression: 'attribute_not_exists(pk) OR expires_at <= :now', ExpressionAttributeValues: { ':now': this.now() } } }
        ]);
        return;
      } catch (error) { if (!conditional(error)) throw error; }
    }
    fail(409, 'session_collision_or_unknown_tenant');
  }
  async getSession(tokenHash) {
    const row = await this._get(tempKey('SESSION', tokenHash, 'SESSION'));
    if (!(row && row.token_hash === tokenHash && row.expires_at > this.now())) return null;
    const tenantRow = await this._get(tenantKey(row.tenant_id));
    const current = Number(tenantRow?.session_epoch) || 0;
    const stamped = Number(row.session_epoch) || 0;
    if (stamped !== current) return null;
    return { tenant_id: tenant(row.tenant_id), expires_at: row.expires_at };
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

  async createSetup(requestedKeyHash,requestedProjectId=null) {
    hash(requestedKeyHash);
    if(requestedProjectId!==null&&(typeof requestedProjectId!=='string'||!/^proj_[a-f0-9]{32}$/.test(requestedProjectId)))fail(400,'invalid_project');
    for (let attempt = 0; attempt < 4; attempt++) {
      const secret = random(), secretHash = digest(secret), code = random().slice(0, 12), expiresAt = this.now() + 600;
      try { await this._tx([
        { Put: { Item: { ...setupKey(secretHash), secret_hash: secretHash, requested_key_hash: requestedKeyHash, ...(requestedProjectId?{requested_project_id:requestedProjectId}:{}), user_code: code, expires_at: expiresAt, ttl: expiresAt },
          ConditionExpression: 'attribute_not_exists(pk) OR expires_at <= :now', ExpressionAttributeValues: { ':now': this.now() } } },
        { Put: { Item: { ...codeKey(code), user_code: code, secret_hash: secretHash, expires_at: expiresAt, ttl: expiresAt },
          ConditionExpression: 'attribute_not_exists(pk) OR expires_at <= :now', ExpressionAttributeValues: { ':now': this.now() } } }
      ]); return { device_secret: secret, user_code: code, expires_in: 600, verification_uri: '/app/' }; }
      catch (error) { if (!conditional(error)) throw error; }
    }
    fail(503, 'setup_collision');
  }
  _setupStatus(row) {
    return row.tenant_id ? { approved: true, scope: 'write', project_id:alphaProject(row.tenant_id).id, expires_at: row.key_expires_at,
      expires_in: Math.max(0, row.key_expires_at - this.now()) } : { pending: true };
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
      requireAlphaProject(tenantId,request.requested_project_id);
      if (request.tenant_id) {
        if (request.tenant_id !== tenantId) fail(409, 'code_unavailable');
        return this._setupStatus(request); // Repeat status, never issue/reactivate a credential.
      }
      // Fixed lease slots are the transactional active-key cap. Expired slots can be reused without a scan or TTL lag.
      const slots = (await this._send('QueryCommand', { KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': tpk(tenantId), ':prefix': 'SLOT#' }, ConsistentRead: true, Limit: this.limits.activeKeys })).Items ?? [];
      const occupied = new Map(slots.map(row => [row.sk, row]));
      let slot = -1;
      for (let index = 0; index < this.limits.activeKeys; index++) {
        const lease = occupied.get(leaseKey(tenantId, index).sk); if (!lease || lease.expires_at <= now) { slot = index; break; }
      }
      if (slot < 0) fail(409, 'active_key_capacity');
      const expiresAt = now + 2592000, keyHash = hash(request.requested_key_hash);
      const record = { token_hash: keyHash, tenant_id: tenantId, project_id:alphaProject(tenantId).id, scope: 'write', expires_at: expiresAt,
        revoked: false, slot, created_at: now, ttl: expiresAt + 2592000 };
      try { await this._tx([
        { ConditionCheck: { Key: tenantKey(tenantId), ConditionExpression: 'attribute_exists(pk)' } },
        { Update: { Key: setupKey(mapping.secret_hash), UpdateExpression: 'SET tenant_id = :tenant, key_expires_at = :expiry',
          ConditionExpression: 'secret_hash = :secret AND attribute_not_exists(tenant_id) AND expires_at > :now AND requested_key_hash = :hash',
          ExpressionAttributeValues: { ':tenant': tenantId, ':expiry': expiresAt, ':now': now, ':hash': keyHash, ':secret': mapping.secret_hash } } },
        { Put: { Item: { ...keyLookup(keyHash), ...record }, ConditionExpression: absent } },
        { Put: { Item: { pk: tpk(tenantId), sk: `KEY#${keyHash}`, ...record }, ConditionExpression: absent } },
        { Put: { Item: { ...leaseKey(tenantId, slot), token_hash: keyHash, expires_at: expiresAt },
          ConditionExpression: 'attribute_not_exists(pk) OR expires_at <= :now', ExpressionAttributeValues: { ':now': now } } }
      ]); return this._setupStatus({ tenant_id: tenantId, key_expires_at: expiresAt }); }
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
      && (row.project_id===undefined||row.project_id===alphaProject(row.tenant_id).id)
      ? { tenant_id: tenant(row.tenant_id), project_id:alphaProject(row.tenant_id).id, token_hash: row.token_hash, scope: 'write', expires_at: row.expires_at } : null;
  }
  listWriteKeys(tenantId, options = {}) { return this._page(tpk(tenantId), 'KEY#', options); }
  async revokeWriteKey(tenantId, tokenHash) {
    tenant(tenantId); hash(tokenHash);
    for (let attempt = 0; attempt < 4; attempt++) {
      const row = await this._get(keyLookup(tokenHash));
      if (!row || row.tenant_id !== tenantId) fail(404, 'key_not_found');
      if (row.revoked) return { revoked: true };
      const lease = await this._get(leaseKey(tenantId, row.slot));
      const update = Key => ({ Update: { Key, UpdateExpression: 'SET revoked = :yes',
        ConditionExpression: 'tenant_id = :tenant AND revoked = :no', ExpressionAttributeValues: { ':yes': true, ':no': false, ':tenant': tenantId } } });
      const items = [update(keyLookup(tokenHash)), update({ pk: tpk(tenantId), sk: `KEY#${tokenHash}` })];
      if (lease?.token_hash === tokenHash) items.push({ Delete: { Key: leaseKey(tenantId, row.slot),
        ConditionExpression: 'token_hash = :hash', ExpressionAttributeValues: { ':hash': tokenHash } } });
      try { await this._tx(items); return { revoked: true }; }
      catch (error) { if (!isTransactionCancellation(error)) throw error; }
    }
    fail(409, 'key_revocation_conflict');
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
    if (byte_count > this.limits.tenantBytes || byte_count > this.limits.globalBytes) fail(429, 'storage_capacity');
    // Acceptance order is assigned when the batch is accepted, not when bytes are reserved.
    const row = { ...Key, tenant_id: tenantId, batch_id, run_id, request_hash, byte_count, event_count,
      object_key: `v1/${digest(tenantId)}/${request_hash}.json`, status: 'pending', created_at: this.now() };
    try { await this._tx([
      { Put: { Item: row, ConditionExpression: absent } },
      { Update: { Key: tenantKey(tenantId), UpdateExpression: 'ADD used_bytes :bytes',
        ConditionExpression: 'attribute_exists(pk) AND byte_limit = :limit AND used_bytes <= :remaining',
        ExpressionAttributeValues: { ':bytes': byte_count, ':limit': this.limits.tenantBytes, ':remaining': this.limits.tenantBytes - byte_count } } },
      { Update: { Key: globalKey, UpdateExpression: 'ADD used_bytes :bytes',
        ConditionExpression: 'attribute_not_exists(used_bytes) OR used_bytes <= :remaining',
        ExpressionAttributeValues: { ':bytes': byte_count, ':remaining': this.limits.globalBytes - byte_count } } }
    ]); return row; }
    catch (error) {
      const saved = await this._get(Key); if (saved) return check(saved);
      if (conditional(error)) fail(429, 'storage_capacity_or_unknown_tenant'); throw error;
    }
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
      const runKey = { pk: tpk(tenantId), sk: `RUN#${row.run_id}` };
      const summary = runSummary(trace, await (trace ? this._get(runKey) : null), row);
      const runUpdate = summary
        ? { Update: { Key: runKey,
          UpdateExpression: 'SET run_id = :run, created_at = if_not_exists(created_at, :created), started_at = :started, ended_at = :ended, has_error = :err, writers = :writers ADD batch_count :one, event_count :events, byte_count :bytes',
          ConditionExpression: 'attribute_not_exists(batch_count) OR batch_count = :prev',
          ExpressionAttributeValues: { ':run': row.run_id, ':created': row.created_at, ':one': 1, ...summary } } }
        : { Update: { Key: runKey,
          UpdateExpression: 'SET run_id = :run, created_at = if_not_exists(created_at, :created) ADD batch_count :one',
          ExpressionAttributeValues: { ':run': row.run_id, ':created': row.created_at, ':one': 1 } } };
      try { await this._tx([
        { Update: { Key, UpdateExpression: 'SET #status = :accepted, accepted_at = :now, upload_seq = :seq',
          ConditionExpression: 'tenant_id = :tenant AND request_hash = :hash AND #status = :pending AND attribute_not_exists(upload_seq)',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':tenant': tenantId, ':hash': requestHash, ':pending': 'pending', ':accepted': 'accepted', ':now': acceptedAt, ':seq': seq } } },
        runUpdate,
        { Put: { Item: { pk: `${tpk(tenantId)}#RUN#${row.run_id}`, sk: order, tenant_id: tenantId,
          batch_id: batchId, request_hash: requestHash, object_key: row.object_key, byte_count: row.byte_count,
          event_count: row.event_count, upload_seq: seq, accepted_at: acceptedAt }, ConditionExpression: absent } },
        { Update: { Key: tenantKey(tenantId), UpdateExpression: 'SET upload_seq = :seq',
          ConditionExpression: 'attribute_exists(pk) AND (attribute_not_exists(upload_seq) OR upload_seq = :prev)',
          ExpressionAttributeValues: { ':seq': seq, ':prev': prev } } }
      ]); return receipt; }
      catch (error) {
        const saved = await this._get(Key);
        if (saved?.status === 'accepted' && saved.request_hash === requestHash) return receipt;
        if (!conditional(error) || attempt === 3) throw error;
      }
    }
    fail(409, 'accept_conflict');
  }
  listRuns(tenantId, options = {}) { return this._page(tpk(tenantId), 'RUN#', options); }
  listAcceptedBatchIndexes(tenantId, runId, options = {}) { return this._page(`${tpk(tenantId)}#RUN#${id(runId)}`, 'BATCH#', options); }
  async _page(pk, prefix, { cursor = null, limit = 50 } = {}) {
    positive(limit, 100); let ExclusiveStartKey;
    if (cursor !== null) {
      if (typeof cursor !== 'string' || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) fail(400, 'invalid_cursor');
      try { ExclusiveStartKey = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { fail(400, 'invalid_cursor'); }
      if (!ExclusiveStartKey || Object.keys(ExclusiveStartKey).length !== 2 || ExclusiveStartKey.pk !== pk ||
        typeof ExclusiveStartKey.sk !== 'string' || !ExclusiveStartKey.sk.startsWith(prefix) || ExclusiveStartKey.sk.length > 200) fail(400, 'invalid_cursor');
    }
    const response = await this._send('QueryCommand', { KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': pk, ':prefix': prefix }, ConsistentRead: true, ScanIndexForward: true,
      Limit: limit, ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}) });
    return { items: response.Items ?? [], next: response.LastEvaluatedKey ? Buffer.from(JSON.stringify(response.LastEvaluatedKey)).toString('base64url') : null };
  }

  /** Conservative fixed-slot limiter. Cardinality cannot exceed rateSlots, even with attacker-chosen identities. */
  async consumeRate({ scope, identity, limit = 60, windowSeconds = 60 }) {
    if (typeof scope !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(scope) || typeof identity !== 'string' || !identity || identity.length > 512) fail(400, 'invalid_rate_scope');
    positive(limit, 100000); positive(windowSeconds, 86400);
    const now = this.now(), window = Math.floor(now / windowSeconds), expiresAt = (window + 1) * windowSeconds;
    const bucket = digest(JSON.stringify([scope, identity, windowSeconds, window]));
    const slot = Number(BigInt(`0x${bucket}`) % BigInt(this.limits.rateSlots));
    const Key = { pk: `RATE#${slot}`, sk: 'COUNTER' };
    try { await this._send('PutCommand', { Item: { ...Key, bucket, hits: 1, expires_at: expiresAt, ttl: expiresAt },
      ConditionExpression: 'attribute_not_exists(pk) OR expires_at <= :now', ExpressionAttributeValues: { ':now': now } });
      return { allowed: true, hits: 1, retry_after: expiresAt - now };
    } catch (error) { if (!conditional(error)) throw error; }
    try {
      const response = await this._send('UpdateCommand', { Key, UpdateExpression: 'ADD hits :one',
        ConditionExpression: '#bucket = :bucket AND expires_at > :now AND hits < :limit', ExpressionAttributeNames: { '#bucket': 'bucket' },
        ExpressionAttributeValues: { ':one': 1, ':bucket': bucket, ':now': now, ':limit': limit }, ReturnValues: 'ALL_NEW' });
      return { allowed: true, hits: response.Attributes.hits, retry_after: expiresAt - now };
    } catch (error) { if (conditional(error)) return { allowed: false, retry_after: expiresAt - now }; throw error; }
  }
}
