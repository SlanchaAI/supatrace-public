// Linking GitHub and Google sign-ins by verified email, through the real OAuth callbacks, handler and store logic
// (in-memory DynamoDB). The provider responses are synthetic; no network request is made.
import test from 'node:test';
import assert from 'node:assert/strict';
import {start} from './harness.mjs';
import {handle} from '../src/aws-api.mjs';
import {digest} from '../src/aws-auth.mjs';
import {githubVerifiedEmail, verifiedEmail, nativeAccountId} from '../src/identity-links.mjs';
import {validateIdentities} from '../public/app/sign-in-methods.js'; // also proves the Settings panel module parses

const ORIGIN = 'https://supatrace.dev';
const cookieOf = (response, name) => response.headers.getSetCookie().map(value => value.split(';')[0]).find(value => value.startsWith(name + '=') && value.length > name.length + 1) ?? null;
async function world() {
  let env; const live = await start({google: true, configureEnvironment: async value => { env = value; }});
  const calls = [];
  /** One provider sign-in. `identity` is what the provider would answer for this person. */
  async function signIn(provider, identity, {raw = false} = {}) {
    const begin = await handle(new Request(ORIGIN + (provider === 'google' ? '/api/auth/google' : '/api/auth/login')), env); assert.equal(begin.status, 302);
    const location = new URL(begin.headers.get('location')), state = location.searchParams.get('state');
    env.fetcher = async url => {
      url = String(url); calls.push(url);
      if (url.includes('/token') || url.includes('access_token')) return Response.json({access_token: 'synthetic-provider-token'});
      if (url.startsWith('https://api.github.com/user/emails')) return identity.emails === undefined ? Response.json({message: 'Not Found'}, {status: 404}) : Response.json(identity.emails);
      if (url === 'https://api.github.com/user') return Response.json({id: identity.id, login: 'synthetic', email: identity.publicEmail ?? null});
      if (url === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json({sub: identity.sub, ...(identity.email === undefined ? {} : {email: identity.email}), ...(identity.email_verified === undefined ? {} : {email_verified: identity.email_verified})});
      throw new Error('unexpected provider request ' + url);
    };
    const back = await handle(new Request(ORIGIN + (provider === 'google' ? '/api/auth/google/callback' : '/api/auth/callback') + '?code=synthetic-code&state=' + state, {headers: {cookie: cookieOf(begin, '__Host-supatrace-oauth')}}), env);
    if (raw) return back;
    assert.equal(back.status, 302, await back.clone().text()); assert.ok(!JSON.stringify([...back.headers]).includes('synthetic-provider-token'));
    const session = cookieOf(back, '__Host-supatrace');
    return {session, mfa: cookieOf(back, '__Host-supatrace-mfa'), scope: location.searchParams.get('scope'), tenant: session ? (await (await api(session, 'me')).json()).tenant_id : null};
  }
  const api = (session, path, body, {origin = ORIGIN, headers = {}} = {}) => handle(new Request(ORIGIN + '/api/' + path, {method: body === undefined ? 'GET' : 'POST', headers: {...(session ? {cookie: session} : {}), ...(body === undefined ? {} : {origin, 'content-type': 'application/json'}), ...headers}, body: body === undefined ? undefined : JSON.stringify(body)}), env);
  const identities = async session => { const r = await api(session, 'auth/identities'); assert.equal(r.status, 200, await r.clone().text()); return r.json(); };
  return {live, env, store: live.store, signIn, api, identities, calls, close: () => live.close()};
}
const gh = (id, email, {verified = true, primary = true, extra = []} = {}) => ({id, emails: [...extra, {email, primary, verified, visibility: 'private'}]});
const google = (sub, email, email_verified = true) => ({sub, email, email_verified});
const googleId = sub => 'google-' + digest(sub);

test('a provider email counts only when that provider asserts it verified', () => {
  assert.equal(verifiedEmail('Ada@Example.com ', true), 'ada@example.com');
  for (const [value, flag] of [['ada@example.com', false], ['ada@example.com', 'true'], ['ada@example.com', 1], ['ada@example.com', undefined], [undefined, true], ['not-an-address', true], ['a@b', true], ['x'.repeat(250) + '@example.com', true], [{email: 'ada@example.com'}, true]]) assert.equal(verifiedEmail(value, flag), null);
  assert.equal(githubVerifiedEmail([{email: 'old@example.com', primary: false, verified: true}, {email: 'Ada@Example.com', primary: true, verified: true}]), 'ada@example.com');
  assert.equal(githubVerifiedEmail([{email: 'ada@example.com', primary: true, verified: false}, {email: 'other@example.com', primary: false, verified: true}]), null, 'a verified secondary address is not used');
  for (const bad of [null, {}, 'x', [], [{email: 'ada@example.com', verified: true}], {message: 'Not Found'}]) assert.equal(githubVerifiedEmail(bad), null);
  assert.equal(nativeAccountId('github', 7), 'github-7'); assert.equal(nativeAccountId('google', 'abc'), googleId('abc'));
  for (const [provider, subject] of [['github', '7'], ['github', 0], ['google', ''], ['google', 'a b'], ['sso', 'x'], ['email', 'ada@example.com']]) assert.throws(() => nativeAccountId(provider, subject), /identity_not_verified/);
});

test('a second provider with the same verified email opens the existing account instead of creating one', async () => {
  const w = await world(); try {
    const first = await w.signIn('github', gh(101, 'ada@example.com')); assert.equal(first.tenant, 'github-101'); assert.equal(first.scope, 'user:email');
    assert.deepEqual(await w.identities(first.session), {account: {provider: 'github', verified_email: 'ada@example.com', linkable: true}, linked: [], same_email_account: null});
    await w.live.upload(await w.live.writeKey('github-101'), {version: 1, batch_id: 'b1', run_id: 'ada-run', events: [{id: 'e1', time: new Date().toISOString(), kind: 'note', name: 'n', data: {}}]});
    const second = await w.signIn('google', google('google-sub-ada', 'Ada@Example.com')); assert.equal(second.scope, 'openid email');
    assert.equal(second.tenant, 'github-101', 'the Google sign-in lands in the GitHub account'); assert.equal(await w.store.getTenant(googleId('google-sub-ada')), null, 'no second account is created');
    assert.equal((await (await w.api(second.session, 'runs')).json()).runs[0].id, 'ada-run');
    const state = await w.identities(second.session);
    assert.equal(state.linked.length, 1); assert.deepEqual({...state.linked[0], linked_at: null}, {id: googleId('google-sub-ada'), provider: 'google', verified_email: 'ada@example.com', linked_at: null, linked_by: 'sign_in'});
    // Signing in again with either provider reaches the same account, with or without the email this time.
    assert.equal((await w.signIn('google', {sub: 'google-sub-ada'})).tenant, 'github-101'); assert.equal((await w.signIn('github', {id: 101})).tenant, 'github-101');
    // The other direction: Google first, GitHub second.
    const g = await w.signIn('google', google('google-sub-bob', 'bob@example.com')); assert.equal(g.tenant, googleId('google-sub-bob'));
    assert.equal((await w.signIn('github', gh(202, 'bob@example.com'))).tenant, googleId('google-sub-bob')); assert.equal(await w.store.getTenant('github-202'), null);
    // A different person whose provider verifies another address is not affected.
    assert.equal((await w.signIn('google', google('google-sub-eve', 'eve@example.com'))).tenant, googleId('google-sub-eve'));
  } finally { await w.close(); }
});

test('an unverified, missing or secondary email never links: the sign-in gets its own account', async () => {
  const w = await world(); try {
    assert.equal((await w.signIn('github', gh(301, 'cy@example.com'))).tenant, 'github-301');
    const attempts = [google('g-unverified', 'cy@example.com', false), google('g-string', 'cy@example.com', 'true'), {sub: 'g-noflag', email: 'cy@example.com'}, {sub: 'g-noemail', email_verified: true}, google('g-other', 'cy@example.org')];
    for (const identity of attempts) { const r = await w.signIn('google', identity); assert.equal(r.tenant, googleId(identity.sub), identity.sub); assert.deepEqual((await w.identities(r.session)).linked, []); }
    assert.deepEqual((await w.identities((await w.signIn('github', {id: 301})).session)).linked, [], 'nothing was linked to the GitHub account');
    // GitHub side: an unverified primary, a verified secondary, a public profile email and an unreadable email list do not link.
    assert.equal((await w.signIn('google', google('g-dee', 'dee@example.com'))).tenant, googleId('g-dee'));
    const refused = [gh(311, 'dee@example.com', {verified: false}), gh(312, 'dee@example.com', {primary: false, extra: [{email: 'else@example.com', primary: true, verified: true}]}), {id: 313, publicEmail: 'dee@example.com'}, {id: 314, emails: {message: 'requires authentication'}}];
    for (const identity of refused) assert.equal((await w.signIn('github', identity)).tenant, 'github-' + identity.id, String(identity.id));
    assert.deepEqual((await w.identities((await w.signIn('google', {sub: 'g-dee'})).session)).linked, []);
  } finally { await w.close(); }
});

test('existing separate accounts are never linked at sign-in; each gets an explicit link-or-keep choice and data is not merged', async () => {
  const w = await world(); try {
    // Two accounts that already exist (created before either provider reported a verified email).
    const a = await w.signIn('github', {id: 401}), b = await w.signIn('google', {sub: 'g-fay'}); assert.notEqual(a.tenant, b.tenant);
    for (const [tenant, run] of [[a.tenant, 'github-run'], [b.tenant, 'google-run']]) await w.live.upload(await w.live.writeKey(tenant), {version: 1, batch_id: run, run_id: run, events: [{id: 'e', time: new Date().toISOString(), kind: 'note', name: 'n', data: {}}]});
    // Both providers now assert the same verified address: each sign-in still opens its own account.
    const a2 = await w.signIn('github', gh(401, 'fay@example.com')), b2 = await w.signIn('google', google('g-fay', 'fay@example.com'));
    assert.equal(a2.tenant, 'github-401'); assert.equal(b2.tenant, googleId('g-fay'));
    assert.deepEqual((await w.identities(a2.session)).same_email_account, {provider: 'google'}); assert.deepEqual((await w.identities(b2.session)).same_email_account, {provider: 'github'});
    assert.ok(!JSON.stringify(await w.identities(b2.session)).includes('github-401'), 'the other account is named by provider only');
    // Link from the Google account: its sign-in will open the GitHub account. Nothing is copied or moved.
    const link = await w.api(b2.session, 'auth/identities/link', {}); assert.equal(link.status, 200, await link.clone().text()); assert.deepEqual(await link.json(), {linked: true, provider: 'google', opens: {provider: 'github'}});
    const after = await w.signIn('google', google('g-fay', 'fay@example.com')); assert.equal(after.tenant, 'github-401');
    assert.deepEqual((await (await w.api(after.session, 'runs')).json()).runs.map(run => run.id), ['github-run'], 'the GitHub account holds only its own traces');
    assert.deepEqual((await w.store.listRuns(googleId('g-fay'), {limit: 10})).items.map(run => run.run_id), ['google-run'], 'the Google account and its traces are untouched');
    const owner = await w.identities(a2.session); assert.equal(owner.linked.length, 1); assert.equal(owner.linked[0].linked_by, 'settings'); assert.equal(owner.same_email_account, null);
    // Links cannot chain or loop: an account that has methods linked to it cannot itself be moved.
    assert.equal((await w.api(a2.session, 'auth/identities/link', {})).status, 409); assert.equal((await w.api(a2.session, 'auth/identities/separate', {})).status, 409);

    // Keep separate: the choice is remembered for both accounts and sign-ins stay apart.
    const c = await w.signIn('github', gh(402, 'gus@example.com')); await w.signIn('google', {sub: 'g-gus'}); const d = await w.signIn('google', google('g-gus', 'gus@example.com'));
    assert.deepEqual((await w.identities(c.session)).same_email_account, {provider: 'google'});
    const keep = await w.api(c.session, 'auth/identities/separate', {}); assert.equal(keep.status, 200); assert.deepEqual(await keep.json(), {kept_separate: true});
    assert.equal((await w.identities(c.session)).same_email_account, null); assert.equal((await w.identities(d.session)).same_email_account, null);
    assert.equal((await w.api(d.session, 'auth/identities/link', {})).status, 409); assert.equal((await w.api(c.session, 'auth/identities/link', {})).status, 409);
    assert.equal((await w.signIn('google', google('g-gus', 'gus@example.com'))).tenant, googleId('g-gus')); assert.equal((await w.signIn('github', gh(402, 'gus@example.com'))).tenant, 'github-402');
  } finally { await w.close(); }
});

test('unlinking returns the sign-in method to its own account, ends the sessions and is not undone by a later sign-in', async () => {
  const w = await world(); try {
    const owner = await w.signIn('github', gh(501, 'hal@example.com')), linked = await w.signIn('google', google('g-hal', 'hal@example.com')); assert.equal(linked.tenant, 'github-501');
    const id = googleId('g-hal');
    // Only the account that holds the link can remove it, and only its own.
    const stranger = await w.signIn('github', gh(502, 'ivy@example.com'));
    assert.equal((await w.api(stranger.session, 'auth/identities/unlink', {id})).status, 400);
    for (const body of [{}, {id: 'github-501'}, {id, extra: true}, {id: 5}]) assert.equal((await w.api(owner.session, 'auth/identities/unlink', body)).status, 400, JSON.stringify(body));
    const done = await w.api(owner.session, 'auth/identities/unlink', {id}); assert.equal(done.status, 200, await done.clone().text()); assert.deepEqual(await done.json(), {unlinked: true, signed_out: true});
    // Every session of the account ends, including the one opened through the linked method.
    for (const session of [owner.session, linked.session]) assert.equal((await w.api(session, 'me')).status, 401);
    // The Google sign-in now has its own, new and empty account, and stays there.
    const again = await w.signIn('google', google('g-hal', 'hal@example.com')); assert.equal(again.tenant, id);
    assert.equal((await w.signIn('google', google('g-hal', 'hal@example.com'))).tenant, id);
    const back = await w.signIn('github', gh(501, 'hal@example.com')); assert.equal(back.tenant, 'github-501');
    assert.deepEqual(await w.identities(back.session), {account: {provider: 'github', verified_email: 'hal@example.com', linkable: true}, linked: [], same_email_account: null});
    assert.equal((await w.identities(again.session)).same_email_account, null, 'an unlinked method is not offered for linking again');
    assert.equal((await w.api(back.session, 'auth/identities/unlink', {id})).status, 400);
  } finally { await w.close(); }
});

test('linking never weakens the account: ambiguity, other account types, MFA and request rules', async () => {
  const w = await world(); try {
    // Two accounts already hold the address (one linked pair would be one account; these are two separate ones): no guess is made.
    await w.signIn('github', {id: 601}); await w.signIn('github', {id: 602});
    await w.signIn('github', gh(601, 'jo@example.com')); await w.signIn('github', gh(602, 'jo@example.com'));
    assert.equal((await w.signIn('google', google('g-jo', 'jo@example.com'))).tenant, googleId('g-jo'));
    // Same provider, same email: never linked (a link is between two different providers).
    assert.equal((await w.signIn('github', gh(603, 'kit@example.com'))).tenant, 'github-603'); assert.equal((await w.signIn('github', gh(604, 'kit@example.com'))).tenant, 'github-604');
    // An SSO account with that address is not a link target.
    const sso = await w.store.getOrCreateSsoTenant('lee@example.com'); await w.store._send('UpdateCommand', {Key: {pk: 'TENANT#' + sso.tenant_id, sk: 'META'}, UpdateExpression: 'SET verified_email = :e', ExpressionAttributeValues: {':e': 'lee@example.com'}});
    await w.store._send('PutCommand', {Item: {pk: 'VEMAIL#' + digest('lee@example.com'), sk: 'ACCOUNT#' + sso.tenant_id, tenant_id: sso.tenant_id}});
    assert.equal((await w.signIn('google', google('g-lee', 'lee@example.com'))).tenant, googleId('g-lee'));
    // A stale index entry (the account's verified address has since changed) does not link.
    const moved = await w.signIn('github', gh(605, 'old@example.com')); await w.signIn('github', gh(605, 'new@example.com'));
    assert.equal((await w.identities(moved.session)).account.verified_email, 'new@example.com'); assert.equal((await w.signIn('google', google('g-old', 'old@example.com'))).tenant, googleId('g-old'));
    // An account protected by MFA still asks for the second factor when reached through a linked method.
    await w.signIn('github', gh(606, 'max@example.com')); w.env.MFA_ENABLED = true;
    await w.store._send('UpdateCommand', {Key: {pk: 'TENANT#github-606', sk: 'META'}, UpdateExpression: 'SET mfa_secret = :s', ExpressionAttributeValues: {':s': 'JBSWY3DPEHPK3PXP'}});
    const challenged = await w.signIn('google', google('g-max', 'max@example.com')); assert.equal(challenged.session, null, 'no session before the second factor'); assert.ok(challenged.mfa);
    assert.equal(await w.store.getTenant(googleId('g-max')), null); w.env.MFA_ENABLED = false;
    // Request rules: session only, same-origin POST, strict bodies, no personal-access-token route.
    const user = await w.signIn('github', gh(607, 'nia@example.com'));
    assert.equal((await w.api(null, 'auth/identities')).status, 401); assert.equal((await w.api(null, 'auth/identities/link', {})).status, 401);
    assert.equal((await w.api(user.session, 'auth/identities/link', {}, {origin: 'https://evil.example'})).status, 403);
    assert.equal((await w.api(user.session, 'auth/identities/link', {})).status, 409); assert.equal((await w.api(user.session, 'auth/identities/link', {target: 'github-601'})).status, 400);
    assert.equal((await w.api(user.session, 'auth/identities/nope', {})).status, 404);
    assert.equal((await w.api(null, 'v1/auth/identities', undefined, {headers: {authorization: 'Bearer stpat_' + 'a'.repeat(43)}})).status, 404);
    // The provider token and the email lookups never reach a response; only the fixed provider endpoints are called.
    assert.deepEqual([...new Set(w.calls.map(url => url.split('?')[0]))].sort(), ['https://api.github.com/user', 'https://api.github.com/user/emails', 'https://github.com/login/oauth/access_token', 'https://oauth2.googleapis.com/token', 'https://openidconnect.googleapis.com/v1/userinfo']);
  } finally { await w.close(); }
});

test('an unlink that lands while a linked sign-in is in flight wins: the callback gets no session', async () => {
  const w = await world(); try {
    const owner = await w.signIn('github', gh(801, 'ona@example.com')), linked = await w.signIn('google', google('g-ona', 'ona@example.com')); assert.equal(linked.tenant, 'github-801');
    // The Google callback has confirmed the link and is about to issue its session when the owner unlinks.
    const createSession = w.store.createSession.bind(w.store); let raced = 0;
    w.store.createSession = async (...args) => { if (raced++ === 0) { const r = await w.api(owner.session, 'auth/identities/unlink', {id: googleId('g-ona')}); assert.equal(r.status, 200, await r.clone().text()); } return createSession(...args); };
    const back = await w.signIn('google', google('g-ona', 'ona@example.com'), {raw: true}); w.store.createSession = createSession;
    assert.equal(raced, 1); assert.notEqual(back.status, 204); assert.equal(cookieOf(back, '__Host-supatrace'), null, 'no session for the unlinked method');
    assert.ok(back.status === 409 || back.status === 302 && /auth_error/.test(back.headers.get('location')), 'refused: ' + back.status + ' ' + back.headers.get('location'));
    assert.equal((await w.store.listSessions?.('github-801'))?.length ?? 0, 0);
    // Afterwards the method opens its own account, as after any unlink.
    assert.equal((await w.signIn('google', google('g-ona', 'ona@example.com'))).tenant, googleId('g-ona'));
    const again = await w.signIn('github', gh(801, 'ona@example.com')); assert.deepEqual((await w.identities(again.session)).linked, []);
  } finally { await w.close(); }
});

test('an account whose provider stops verifying its address can no longer be linked to or from', async () => {
  const w = await world(); try {
    // New-identity link: the GitHub account once had a verified address, then signs in without one.
    const a = await w.signIn('github', gh(811, 'pat@example.com')); assert.equal((await w.identities(a.session)).account.verified_email, 'pat@example.com');
    for (const lost of [gh(811, 'pat@example.com', {verified: false}), {id: 811}, {id: 811, emails: []}]) {
      await w.signIn('github', gh(811, 'pat@example.com')); const now = await w.signIn('github', lost);
      assert.equal((await w.identities(now.session)).account.verified_email, null, JSON.stringify(lost));
    }
    assert.equal((await w.signIn('google', google('g-pat', 'pat@example.com'))).tenant, googleId('g-pat'), 'the old address is not a basis for a new link');
    // Settings link: two existing accounts were offered the choice; one loses verification and the offer is withdrawn for both.
    await w.signIn('github', {id: 812}); await w.signIn('google', {sub: 'g-quin'});
    const g = await w.signIn('github', gh(812, 'quin@example.com')), o = await w.signIn('google', google('g-quin', 'quin@example.com'));
    assert.deepEqual((await w.identities(g.session)).same_email_account, {provider: 'google'});
    await w.signIn('google', google('g-quin', 'quin@example.com', false));
    assert.equal((await w.identities(g.session)).same_email_account, null); assert.equal((await w.identities(o.session)).same_email_account, null);
    assert.equal((await w.api(g.session, 'auth/identities/link', {})).status, 409); assert.equal((await w.api(o.session, 'auth/identities/link', {})).status, 409);
    // A link made earlier does not depend on later verification.
    await w.signIn('github', gh(813, 'rae@example.com')); assert.equal((await w.signIn('google', google('g-rae', 'rae@example.com'))).tenant, 'github-813');
    await w.signIn('github', {id: 813}); assert.equal((await w.signIn('google', google('g-rae', 'rae@example.com', false))).tenant, 'github-813');
  } finally { await w.close(); }
});

test('a link at sign-in commits only while the identity still has no account of its own: no chain can form', async () => {
  const w = await world(); try {
    const target = await w.signIn('github', gh(901, 'sam@example.com')); assert.equal(target.tenant, 'github-901');
    // While the Google callback is about to commit its link, a concurrent callback of the same Google identity creates
    // that identity's own account. The link must then not commit.
    const tx = w.store._tx.bind(w.store); let raced = 0;
    w.store._tx = async items => { if (raced++ === 0 && items.some(item => item.Put?.Item?.pk === 'IDENTITY#' + googleId('g-sam'))) await w.store.getOrCreateGoogleTenant('g-sam'); return tx(items); };
    const r = await w.signIn('google', google('g-sam', 'sam@example.com')); w.store._tx = tx;
    assert.ok(raced >= 1); assert.equal(r.tenant, googleId('g-sam'), 'the sign-in opens the account that now exists');
    assert.equal(await w.store._get({pk: 'IDENTITY#' + googleId('g-sam'), sk: 'LINK'}), null); assert.ok(!((await w.store.getTenant('github-901')).inbound_identities > 0));
    assert.deepEqual((await w.identities(target.session)).linked, []);
    // The two accounts now both exist with the same verified address, so the choice is the explicit one in Settings.
    assert.deepEqual((await w.identities(r.session)).same_email_account, {provider: 'github'});
    // The other order: the link commits first, and a late callback of the same identity follows it instead of creating an orphan account.
    await w.signIn('github', gh(902, 'tess@example.com'));
    const get = w.store._get.bind(w.store); let late = 0;
    w.store._get = async key => { const value = await get(key); if (late === 0 && key.pk === 'IDENTITY#' + googleId('g-tess')) { late++; w.store._get = get; assert.equal((await w.signIn('google', google('g-tess', 'tess@example.com'))).tenant, 'github-902'); w.store._get = get; } return value; };
    const second = await w.signIn('google', google('g-tess', 'tess@example.com')); w.store._get = get;
    assert.equal(late, 1); assert.equal(second.tenant, 'github-902'); assert.equal(await w.store.getTenant(googleId('g-tess')), null, 'no orphan account');
    assert.equal((await w.store.getTenant('github-902')).inbound_identities, 1);
  } finally { await w.close(); }
});

test('an account is never created beside a link made meanwhile: the late sign-in follows the link', async () => {
  const w = await world(); try {
    await w.signIn('github', gh(911, 'uma@example.com'));
    // Callback 1 carries no verified address this time, so it goes straight to creating the Google identity's own account.
    // Before that creation commits, callback 2 (same identity, verified address) links the identity to the GitHub account.
    const create = w.store.getOrCreateGoogleTenant.bind(w.store); let raced = 0;
    w.store.getOrCreateGoogleTenant = async (...args) => { if (raced++ === 0) { w.store.getOrCreateGoogleTenant = create; assert.equal((await w.signIn('google', google('g-uma', 'uma@example.com'))).tenant, 'github-911'); } return create(...args); };
    const first = await w.signIn('google', google('g-uma', 'uma@example.com', false)); w.store.getOrCreateGoogleTenant = create;
    assert.equal(raced, 1); assert.equal(first.tenant, 'github-911', 'the first callback follows the link instead of opening a new account');
    assert.equal(await w.store.getTenant(googleId('g-uma')), null, 'no stranded account was created'); assert.equal((await w.store.getTenant('github-911')).inbound_identities, 1);
    // An identity that was unlinked (kept separate) still gets its own account: the guard allows that state.
    const owner = await w.signIn('github', gh(911, 'uma@example.com')); assert.equal((await w.api(owner.session, 'auth/identities/unlink', {id: googleId('g-uma')})).status, 200);
    assert.equal((await w.signIn('google', google('g-uma', 'uma@example.com'))).tenant, googleId('g-uma'));
    // A real account-capacity refusal is still reported as such.
    w.store.limits.accounts = 0; const begin = await w.signIn('google', google('g-full', 'full@example.com'), {raw: true}); assert.notEqual(cookieOf(begin, '__Host-supatrace'), undefined); assert.equal(cookieOf(begin, '__Host-supatrace'), null); assert.equal(await w.store.getTenant(googleId('g-full')), null);
  } finally { await w.close(); }
});

test('an account takes one linked method: a second identity of that provider with the same address stays out', async () => {
  const w = await world(); try {
    const owner = await w.signIn('github', gh(921, 'vic@example.com')); assert.equal((await w.signIn('google', google('g-vic-1', 'vic@example.com'))).tenant, 'github-921');
    // A different Google account later verifies the same address (a reassigned mailbox, say). It does not join.
    const second = await w.signIn('google', google('g-vic-2', 'vic@example.com')); assert.equal(second.tenant, googleId('g-vic-2'));
    const mine = await w.identities(second.session); assert.equal(mine.same_email_account, null, 'and is not offered the account'); assert.equal((await w.api(second.session, 'auth/identities/link', {})).status, 409);
    const state = await w.identities(owner.session); assert.deepEqual(state.linked.map(item => item.id), [googleId('g-vic-1')]); assert.equal((await w.store.getTenant('github-921')).inbound_identities, 1);
    // Unlink is authorised against this account's own membership row: another account's method, or one never linked, is refused.
    for (const id of [googleId('g-vic-2'), 'github-921', googleId('nobody')]) assert.equal((await w.api(owner.session, 'auth/identities/unlink', {id})).status, 400, id);
    assert.equal((await w.api(owner.session, 'auth/identities/unlink', {id: googleId('g-vic-1')})).status, 200);
    assert.equal((await w.store.getTenant('github-921')).inbound_identities, 0);
  } finally { await w.close(); }
});

test('a link that points at a missing membership is retired, and the method gets its own account', async () => {
  const w = await world(); try {
    await w.signIn('github', gh(931, 'wes@example.com')); assert.equal((await w.signIn('google', google('g-wes', 'wes@example.com'))).tenant, 'github-931');
    // Remove only the membership row, as a partial manual cleanup would.
    await w.store._send('DeleteCommand', {Key: {pk: 'TENANT#github-931', sk: 'IDENTITY#' + googleId('g-wes')}});
    assert.equal((await w.signIn('google', google('g-wes', 'wes@example.com'))).tenant, googleId('g-wes'));
    assert.equal((await w.store._get({pk: 'IDENTITY#' + googleId('g-wes'), sk: 'LINK'})).link_state, 'separate');
    assert.equal((await w.signIn('google', google('g-wes', 'wes@example.com'))).tenant, googleId('g-wes'));
  } finally { await w.close(); }
});

test('the Settings panel accepts only the documented response shape', () => {
  const good = {account: {provider: 'github', verified_email: 'ada@example.com', linkable: true}, linked: [{id: 'google-' + 'a'.repeat(64), provider: 'google', verified_email: 'ada@example.com', linked_at: '2026-11-14T00:00:00.000Z', linked_by: 'sign_in'}], same_email_account: null};
  assert.equal(validateIdentities(good), good); assert.equal(validateIdentities({...good, account: {provider: null, verified_email: null, linkable: false}, linked: [], same_email_account: {provider: 'google'}}).linked.length, 0);
  for (const broken of [null, {}, {...good, account: {...good.account, provider: 'sso'}}, {...good, linked: [{...good.linked[0], id: 'github-1; drop'}]}, {...good, linked: [{...good.linked[0], verified_email: '<img src=x>'}]}, {...good, linked: [{...good.linked[0], linked_by: 'magic'}]}, {...good, same_email_account: {provider: 'email'}}, {...good, linked: 'none'}]) assert.throws(() => validateIdentities(broken), /invalid_response/);
});
