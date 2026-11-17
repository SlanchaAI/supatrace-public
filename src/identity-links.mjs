// Linking GitHub and Google sign-ins to one account by verified email.
//
// Rules, all enforced here:
// - An email counts only when the provider itself asserts it is verified (Google `email_verified: true`; GitHub's primary
//   address with `verified: true`). An unverified or missing email never links anything.
// - A sign-in method that has no account yet joins the one existing account whose own provider verified the same address.
//   Nothing is created and no data moves.
// - A sign-in method that already has its own account keeps it. Two existing accounts with the same verified email are
//   only linked by an explicit choice in Settings, and the choice to keep them separate is remembered. Data is never merged.
// - An account has its own sign-in method and at most one linked method, which is of the other provider. So a second
//   identity of the linked provider that later verifies the same address does not get in.
// - Unlinking returns a sign-in method to its own account and ends every session of the account it was removed from.
//
// Rows: IDENTITY#<native account id>/LINK says where a sign-in method resolves (linked to a target, or kept separate);
// TENANT#<target>/IDENTITY#<native id> lists a target's linked methods; VEMAIL#<sha256 email>/ACCOUNT#<id> finds accounts
// by verified email. The tenant row keeps `verified_email` and `inbound_identities` (how many methods are linked to it).
import {HttpError, json, boundedText, requireOrigin} from './http.mjs';
import {createHash} from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex'); // same digest as aws-auth.mjs, kept local to avoid an import cycle

export const LINKABLE_PROVIDERS = Object.freeze(['github', 'google']);
const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const tenantKey = id => ({pk: 'TENANT#' + id, sk: 'META'});
const linkKey = native => ({pk: 'IDENTITY#' + native, sk: 'LINK'});
const memberKey = (target, native) => ({pk: 'TENANT#' + target, sk: 'IDENTITY#' + native});
const emailIndexKey = (email, id) => ({pk: 'VEMAIL#' + digest(email), sk: 'ACCOUNT#' + id});
const conditional = error => error?.name === 'ConditionalCheckFailedException' || error?.name === 'TransactionCanceledException';
const absent = 'attribute_not_exists(pk)';
/** The store must expose the single-table primitives; simple test doubles without them keep the unlinked behaviour. */
export const identityLinksAvailable = store => ['_get', '_tx', '_page', 'getTenant', 'getOrCreateTenant', 'getOrCreateGoogleTenant'].every(name => typeof store?.[name] === 'function');

/** Lower-cased address, or null when it is missing, malformed or not asserted as verified. */
export function verifiedEmail(value, verified) {
  if (verified !== true || typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
}
/** GitHub: the primary address, and only if GitHub marks it verified. */
export function githubVerifiedEmail(list) {
  if (!Array.isArray(list)) return null;
  const primary = list.find(item => item && item.primary === true);
  return primary ? verifiedEmail(primary.email, primary.verified) : null;
}
export function nativeAccountId(provider, subject) {
  if (provider === 'github' && Number.isSafeInteger(subject) && subject > 0) return 'github-' + subject;
  if (provider === 'google' && typeof subject === 'string' && /^[A-Za-z0-9._~-]{1,255}$/.test(subject)) return 'google-' + digest(subject);
  throw new HttpError(401, 'identity_not_verified');
}
const providerOf = row => LINKABLE_PROVIDERS.includes(row?.provider) && row.tenant_id === (row.provider === 'github' ? 'github-' + row.github_subject : 'google-' + digest(String(row.google_subject ?? ''))) ? row.provider : null;

/** Accounts a method could be linked to: their own provider verified this address, their own sign-in method is undecided
 *  (not linked into another account, not marked to stay separate) and no method is linked to them yet. */
async function accountsWithEmail(store, email, exclude) {
  const page = await store._page('VEMAIL#' + digest(email), 'ACCOUNT#', {limit: 10}), found = [];
  for (const item of page.items) {
    if (item.tenant_id === exclude) continue;
    const row = await store.getTenant(item.tenant_id), link = row ? await store._get(linkKey(row.tenant_id)) : null;
    if (row && row.verified_email === email && providerOf(row) && !link && !(row.inbound_identities > 0)) found.push(row);
  }
  return page.next ? null : found; // more than ten accounts on one address: do not guess
}
const epochOf = row => { const epoch = row?.session_epoch ?? 0; if (!Number.isSafeInteger(epoch) || epoch < 0) throw new HttpError(409, 'session_changed'); return epoch; };
/**
 * Confirms a link and returns the target's session epoch, or null when the link is gone. The account row is read first and
 * the link second: unlinking removes the link and raises the epoch in one transaction, so a link still present after the
 * epoch was read means that epoch is current, and a session issued against it fails if an unlink lands afterwards.
 */
async function linkedEpoch(store, target, native) {
  const row = await store.getTenant(target); if (!row) return null;
  const epoch = epochOf(row);
  return await store._get(memberKey(target, native)) ? epoch : null;
}
/** Records what the account's own provider said on this sign-in. No verified address this time withdraws the old one,
 *  so it can no longer be the basis of a new link. Links already made are separate rows and stay. */
async function rememberEmail(store, row, email) {
  if ((row.verified_email ?? null) === email) return;
  if (email === null) { await store._send('UpdateCommand', {Key: tenantKey(row.tenant_id), UpdateExpression: 'SET verified_email = :none', ConditionExpression: 'attribute_exists(pk)', ExpressionAttributeValues: {':none': null}}); return; }
  // The index row is written first: a stale index entry is harmless because every reader checks the tenant row.
  await store._send('PutCommand', {Item: {...emailIndexKey(email, row.tenant_id), tenant_id: row.tenant_id}});
  await store._send('UpdateCommand', {Key: tenantKey(row.tenant_id), UpdateExpression: 'SET verified_email = :email', ConditionExpression: 'attribute_exists(pk)', ExpressionAttributeValues: {':email': email}});
}
function linkItems(native, provider, target, email, how, now) {
  return [
    {Put: {Item: {...memberKey(target, native), native_id: native, identity_provider: provider, verified_email: email, linked_at: now, linked_by: how}, ConditionExpression: absent}},
    // The target must still hold this verified address, must have no linked method yet (one per account), and its own
    // sign-in method must be undecided (not linked away, not kept separate).
    {Update: {Key: tenantKey(target), UpdateExpression: 'ADD inbound_identities :one', ConditionExpression: 'attribute_exists(pk) AND verified_email = :email AND (attribute_not_exists(inbound_identities) OR inbound_identities = :zero)', ExpressionAttributeValues: {':one': 1, ':zero': 0, ':email': email}}},
    {ConditionCheck: {Key: linkKey(target), ConditionExpression: absent}}
  ];
}

/**
 * Resolves a provider sign-in to an account. `subject` and `email` MUST come from the provider's own response in this
 * request; `email` is null unless the provider asserted it verified. For a linked sign-in the result carries the target's
 * `session_epoch`; the caller MUST issue the session against it, so an unlink that lands meanwhile wins.
 */
export async function signInIdentity(store, {provider, subject, email = null}) {
  const native = nativeAccountId(provider, subject), link = await store._get(linkKey(native));
  if (link?.link_state === 'linked') {
    const epoch = await linkedEpoch(store, link.target_tenant, native);
    if (epoch !== null) return {tenant_id: link.target_tenant, via: 'link', session_epoch: epoch};
  }
  if (link?.link_state === 'linked') {
    // The link points at an account or membership that no longer exists. Mark the method separate so that it can have its
    // own account; only this exact stale link is replaced.
    try { await store._tx([{Put: {Item: {...link, link_state: 'separate', target_tenant: null, unlinked_at: store.now()}, ConditionExpression: 'link_state = :linked AND target_tenant = :target', ExpressionAttributeValues: {':linked': 'linked', ':target': link.target_tenant}}}]); }
    catch (error) { if (!conditional(error)) throw error; }
  }
  const hadAccount = link ? true : !!(await store.getTenant(native));
  if (email && !link && !hadAccount) {
    const candidates = (await accountsWithEmail(store, email, native))?.filter(row => row.provider !== provider);
    if (candidates?.length === 1) {
      const target = candidates[0].tenant_id, now = store.now();
      try {
        // The identity must still have no account of its own when the link commits. Without this a concurrent sign-in of
        // the same identity could create that account and have another method linked to it first, leaving an account
        // whose own method opens somewhere else while others open it (a chain).
        await store._tx([{Put: {Item: {...linkKey(native), native_id: native, identity_provider: provider, link_state: 'linked', target_tenant: target, verified_email: email, linked_at: now}, ConditionExpression: absent}},
          {ConditionCheck: {Key: tenantKey(native), ConditionExpression: absent}}, ...linkItems(native, provider, target, email, 'sign_in', now)]);
      } catch (error) {
        if (!conditional(error)) throw error; // a concurrent sign-in of the same identity may have linked it; checked below
      }
      const saved = await store._get(linkKey(native));
      if (saved?.link_state === 'linked' && saved.target_tenant === target) {
        const epoch = await linkedEpoch(store, target, native);
        if (epoch !== null) return {tenant_id: target, via: 'verified_email', session_epoch: epoch};
      }
    }
  }
  // Open or create the identity's own account. Creating it is conditional, in the same transaction, on the identity not
  // being linked to another account: a concurrent sign-in of the same identity may have linked it since the first read,
  // and an account created beside that link would be opened once and then stranded. (The link transaction above has the
  // mirror condition: it requires that this account does not exist.)
  const unlinked = [{ConditionCheck: {Key: linkKey(native), ConditionExpression: 'attribute_not_exists(pk) OR link_state = :separate', ExpressionAttributeValues: {':separate': 'separate'}}}];
  let row;
  try { row = provider === 'google' ? await store.getOrCreateGoogleTenant(subject, unlinked) : await store.getOrCreateTenant(subject, unlinked); }
  catch (error) {
    // The store reports any failed creation condition as account_capacity. If the reason was a link, follow it.
    if (error?.code !== 'account_capacity') throw error;
    const now = await store._get(linkKey(native));
    const epoch = now?.link_state === 'linked' ? await linkedEpoch(store, now.target_tenant, native) : null;
    if (epoch === null) throw error;
    return {tenant_id: now.target_tenant, via: 'link', session_epoch: epoch};
  }
  await rememberEmail(store, row, email);
  return {tenant_id: row.tenant_id, via: 'own_account'};
}

async function describe(store, actor) {
  const row = await store.getTenant(actor);
  if (!row) throw new HttpError(401, 'sign_in_required');
  const provider = providerOf(row), email = typeof row.verified_email === 'string' ? row.verified_email : null;
  const page = await store._page('TENANT#' + actor, 'IDENTITY#', {limit: 20}); // an account holds at most one; see linkItems
  const linked = page.items.map(item => ({id: item.native_id, provider: item.identity_provider, verified_email: item.verified_email, linked_at: new Date(item.linked_at * 1000).toISOString(), linked_by: item.linked_by}));
  // A suggestion exists only for an account that can itself move: its own sign-in method is undecided and nothing is linked to it.
  let other = null;
  if (provider && email && !linked.length && !(row.inbound_identities > 0) && !(await store._get(linkKey(actor)))) {
    const candidates = (await accountsWithEmail(store, email, actor))?.filter(candidate => candidate.provider !== provider);
    if (candidates?.length === 1) other = candidates[0];
  }
  return {row, provider, email, linked, other};
}
const view = ({provider, email, linked, other}) => ({account: {provider, verified_email: email, linkable: provider !== null}, linked, same_email_account: other ? {provider: other.provider} : null});

/** Session-only: GET /api/auth/identities, POST /api/auth/identities/{link,separate,unlink}. `actor` comes from the session. */
export async function identityApi(request, env, actor) {
  const store = env.store, path = new URL(request.url).pathname;
  if (!identityLinksAvailable(store)) throw new HttpError(404, 'not_found');
  if (request.method === 'GET' && path === '/api/auth/identities') return json(view(await describe(store, actor)));
  if (request.method !== 'POST') throw new HttpError(404, 'not_found');
  requireOrigin(request, env.APP_ORIGIN);
  let data; try { data = JSON.parse(await boundedText(request, 1024)); } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'invalid_identity_request'); }
  if (!data || Object.getPrototypeOf(data) !== Object.prototype) throw new HttpError(400, 'invalid_identity_request');
  const state = await describe(store, actor), now = store.now();
  if (path === '/api/auth/identities/link' || path === '/api/auth/identities/separate') {
    if (Object.keys(data).length) throw new HttpError(400, 'invalid_identity_request');
    if (!state.other) throw new HttpError(409, 'no_account_to_link');
    const base = {...linkKey(actor), native_id: actor, identity_provider: state.provider, verified_email: state.email, linked_at: now};
    if (path.endsWith('/separate')) {
      try { await store._tx([{Put: {Item: {...base, link_state: 'separate'}, ConditionExpression: absent}}]); } catch (error) { if (!conditional(error)) throw error; throw new HttpError(409, 'identity_changed'); }
      return json({kept_separate: true});
    }
    // This account's own sign-in method will open the other account. It must hold the same verified address and have nothing linked to it.
    try {
      await store._tx([
        {Put: {Item: {...base, link_state: 'linked', target_tenant: state.other.tenant_id}, ConditionExpression: absent}},
        {ConditionCheck: {Key: tenantKey(actor), ConditionExpression: 'verified_email = :email AND (attribute_not_exists(inbound_identities) OR inbound_identities = :zero)', ExpressionAttributeValues: {':email': state.email, ':zero': 0}}},
        ...linkItems(actor, state.provider, state.other.tenant_id, state.email, 'settings', now)
      ]);
    } catch (error) { if (!conditional(error)) throw error; throw new HttpError(409, 'identity_changed'); }
    return json({linked: true, provider: state.provider, opens: {provider: state.other.provider}});
  }
  if (path === '/api/auth/identities/unlink') {
    // Authorised against this account's own membership row for that method, not against a listing.
    if (Object.keys(data).join() !== 'id' || typeof data.id !== 'string' || !/^(github-[1-9][0-9]{0,15}|google-[a-f0-9]{64})$/.test(data.id) || !(await store._get(memberKey(actor, data.id)))) throw new HttpError(400, 'invalid_identity_request');
    const saved = await store._get(linkKey(data.id));
    if (saved?.link_state !== 'linked' || saved.target_tenant !== actor) throw new HttpError(409, 'identity_changed');
    // The method goes back to its own account and is never linked by email again. Every session of this account ends,
    // because a session does not record which sign-in method opened it.
    try {
      await store._tx([
        {Put: {Item: {...saved, link_state: 'separate', target_tenant: null, unlinked_at: now}, ConditionExpression: 'link_state = :linked AND target_tenant = :target', ExpressionAttributeValues: {':linked': 'linked', ':target': actor}}},
        {Delete: {Key: memberKey(actor, data.id), ConditionExpression: 'attribute_exists(pk)'}},
        {Update: {Key: tenantKey(actor), UpdateExpression: 'ADD inbound_identities :minus, session_epoch :one', ConditionExpression: 'attribute_exists(pk) AND inbound_identities >= :one', ExpressionAttributeValues: {':minus': -1, ':one': 1}}}
      ]);
    } catch (error) { if (!conditional(error)) throw error; throw new HttpError(409, 'identity_changed'); }
    return json({unlinked: true, signed_out: true});
  }
  throw new HttpError(404, 'not_found');
}
