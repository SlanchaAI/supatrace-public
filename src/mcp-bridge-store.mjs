// Short-lived delegated reads, separate from account SESSION and write-key rows.
import {randomBytes} from 'node:crypto';
import {digest} from './aws-auth.mjs';
import {HttpError} from './http.mjs';
import {requireAlphaProject} from './alpha-projects.mjs';
const fail = (status, code) => {throw new HttpError(status, code);};
const tokenHash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export const bridgeScopeHash=scope=>digest(JSON.stringify(Object.fromEntries(Object.keys(scope).sort().map(k=>[k,scope[k]]))));
const codeValid = v => typeof v === 'string' && /^[A-Za-z0-9_-]{12}$/.test(v);
const object = v => v && Object.getPrototypeOf(v) === Object.prototype;
const key = (kind, hash) => ({pk: 'MCP' + kind + '#' + (BigInt('0x' + hash) % 1000n), sk: 'LEASE'});
const conditional = e => e?.name === 'ConditionalCheckFailedException' || e?.name === 'TransactionCanceledException';
export function bridgeScope(value) {
  if (!object(value) || Object.keys(value).sort().join() !== 'client,content,origin,projectId,runIds,tenantId' ||
      !['https://supatrace.dev','https://supatrace.tech'].includes(value.origin) ||
      !/^proj_[a-f0-9]{32}$/.test(value.projectId ?? '') ||
      !['metadata','include'].includes(value.content) || typeof value.client !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/.test(value.client) ||
      !Array.isArray(value.runIds) || !value.runIds.length || value.runIds.length > 20 || new Set(value.runIds).size !== value.runIds.length || value.runIds.some(v => typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v))) fail(400,'invalid_mcp_scope');
  requireAlphaProject(value.tenantId,value.projectId);
  return {...value,runIds:[...value.runIds]};
}
export function mcpBridgeStore(store) {
  const now = () => store.now();
  async function read(hash, origin) {
    if (!tokenHash(hash)) fail(401,'mcp_access_unavailable');
    const row = await store._get(key('READ',hash));
    if (!row || row.token_hash !== hash || row.scope.origin !== origin || row.expires_at <= now() || row.revoked) fail(401,'mcp_access_unavailable');
    return row;
  }
  async function lease(hash, origin) {
    const row = await read(hash,origin);
    if (!row.parent_session_hash) fail(401,'mcp_approval_required');
    const parent = await store.getSession(row.parent_session_hash);
    if (!parent || parent.tenant_id !== row.scope.tenantId || parent.expires_at <= now() || row.expires_at <= now()) fail(401,'mcp_access_unavailable');
    const current=await read(hash,origin);
    if(current.code!==row.code||current.parent_session_hash!==row.parent_session_hash)fail(401,'mcp_access_unavailable');
    return current;
  }
  async function byCode(code, origin, tenant) {
    if (!codeValid(code)) fail(400,'invalid_mcp_code');
    const mapping = await store._get(key('CODE',digest(code)));
    if (!mapping || mapping.code !== code || mapping.expires_at <= now()) fail(404,'mcp_request_unavailable');
    const row = await read(mapping.token_hash,origin);
    if (row.code !== code) fail(404,'mcp_request_unavailable');
    if (row.scope.tenantId !== tenant) fail(403,'mcp_scope_mismatch');
    return row;
  }
  const describe = row => ({code:row.code,scope:row.scope,scopeHash:row.scope_hash,expiresAt:row.expires_at*1000,approved:!!row.parent_session_hash});
  return {
    lease, describe,
    async register(hash, scope, origin) {
      scope = bridgeScope(scope);
      if (!tokenHash(hash) || scope.origin !== origin) fail(400,'invalid_mcp_scope');
      const code = randomBytes(9).toString('base64url'), expires = now()+300;
      const row = {...key('READ',hash),token_hash:hash,scope,scope_hash:bridgeScopeHash(scope),code,expires_at:expires,ttl:expires};
      try {await store._tx([
        {Put:{Item:row,ConditionExpression:'attribute_not_exists(pk) OR expires_at <= :now',ExpressionAttributeValues:{':now':now()}}},
        {Put:{Item:{...key('CODE',digest(code)),code,token_hash:hash,expires_at:expires,ttl:expires},ConditionExpression:'attribute_not_exists(pk) OR expires_at <= :now',ExpressionAttributeValues:{':now':now()}}}
      ]);} catch(e) {if(conditional(e)) fail(409,'mcp_request_unavailable'); throw e;}
      return describe(row);
    },
    async inspect(code, origin, tenant) {const row=await byCode(code,origin,tenant);return describe(row.parent_session_hash?await lease(row.token_hash,origin):row);},
    async approve(code, origin, tenant, parentHash, consent) {
      const row = await byCode(code,origin,tenant), parent = await store.getSession(parentHash);
      if (!parent || parent.tenant_id !== tenant) fail(401,'sign_in_required');
      if (!object(consent) || Object.keys(consent).sort().join() !== 'confirmed,content,scopeHash' || consent.confirmed !== true || consent.content !== row.scope.content || consent.scopeHash !== row.scope_hash) fail(400,'mcp_consent_required');
      if (row.parent_session_hash) fail(409,'mcp_already_approved');
      const expires = Math.min(row.expires_at,parent.expires_at);
      if (expires <= now()) fail(401,'mcp_access_unavailable');
      try {await store._send('UpdateCommand',{Key:key('READ',row.token_hash),UpdateExpression:'SET parent_session_hash = :parent, expires_at = :expires, ttl = :expires',ConditionExpression:'token_hash = :hash AND code = :code AND scope_hash = :scope AND expires_at > :now AND attribute_not_exists(parent_session_hash) AND attribute_not_exists(revoked)',ExpressionAttributeValues:{':parent':parentHash,':expires':expires,':hash':row.token_hash,':code':row.code,':scope':row.scope_hash,':now':now()}});}
      catch(e) {if(conditional(e)) fail(409,'mcp_request_unavailable');throw e;}
      return describe(await lease(row.token_hash,origin));
    },
    async poll(hash,origin) {const row=await read(hash,origin);return describe(row.parent_session_hash?await lease(hash,origin):row);},
    async revoke(hash,origin,expectedCode) {
      const row=await read(hash,origin);if(expectedCode&&row.code!==expectedCode)fail(404,'mcp_request_unavailable');
      try {await store._send('UpdateCommand',{Key:key('READ',hash),UpdateExpression:'SET revoked = :yes',ConditionExpression:'token_hash = :hash AND code = :code',ExpressionAttributeValues:{':yes':true,':hash':hash,':code':row.code}});}
      catch(e) {if(conditional(e))fail(401,'mcp_access_unavailable');throw e;}
      return {revoked:true,expiresAt:row.expires_at*1000};
    },
    async revokeByCode(code,origin,tenant) {const row=await byCode(code,origin,tenant);return this.revoke(row.token_hash,origin,row.code);},
  };
}
