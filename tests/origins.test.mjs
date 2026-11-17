import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHosts, viewerHost, envForRequest, originsAreProduction, PRODUCTION_ORIGINS} from '../src/origins.mjs';
import {handle} from '../src/aws-api.mjs';
import {digest} from '../src/aws-auth.mjs';

const DEV = 'https://supatrace.dev', TECH = 'https://supatrace.tech';
const state = 's'.repeat(43), verifier = 'v'.repeat(43);

function fixture(overrides = {}) {
  const states = new Map(), sessions = new Map(), tenants = [];
  const store = {
    getTenant: async tenant_id => ({tenant_id}),
    consumeRate: async () => ({allowed: true}),
    createOAuthState: async (key, value) => states.set(key, value),
    consumeOAuthState: async key => { const value = states.get(key); states.delete(key); return value; },
    getOrCreateTenant: async id => { tenants.push('github-' + id); return {tenant_id: 'github-' + id}; },
    getOrCreateGoogleTenant: async id => { tenants.push('google-' + id); return {tenant_id: 'google-' + id}; },
    createSession: async (key, tenant) => sessions.set(key, tenant),
    putSession: async (key, tenant) => sessions.set(key, tenant),
    deleteSession: async key => sessions.delete(key),
    getSession: async key => sessions.has(key) ? {tenant_id: sessions.get(key)} : null
  };
  const env = {
    ENABLED: true, APP_ORIGIN: TECH, APP_ORIGINS: [TECH, DEV], objects: {}, store,
    GITHUB_CLIENT_ID: 'legacy-dev-app', GITHUB_CLIENT_SECRET: 'dev-secret',
    GITHUB_BY_ORIGIN: {[DEV]: {id: 'legacy-dev-app', secret: 'dev-secret'}, [TECH]: {id: 'tech-app', secret: 'tech-secret'}},
    GOOGLE_CLIENT_ID: 'google-client', GOOGLE_CLIENT_SECRET: 'google-secret', ...overrides
  };
  return {env, states, sessions, tenants};
}
const get = (host, path, init) => new Request('https://' + host + path, init);
const location = response => new URL(response.headers.get('location'));

test('parseHosts keeps only known production hosts, in order, with a safe default', () => {
  assert.deepEqual(parseHosts('supatrace.tech, SUPATRACE.dev'), ['supatrace.tech', 'supatrace.dev']);
  assert.deepEqual(parseHosts('supatrace.dev,supatrace.dev'), ['supatrace.dev']);
  assert.deepEqual(parseHosts('evil.example,supatrace.tech'), ['supatrace.tech']);
  assert.deepEqual(parseHosts(''), ['supatrace.dev']);
  assert.deepEqual(parseHosts(undefined), ['supatrace.dev']);
  assert.deepEqual(parseHosts('evil.example'), ['supatrace.dev']);
});

test('viewerHost trusts only allowlisted values and otherwise falls back to the primary host', () => {
  const hosts = ['supatrace.tech', 'supatrace.dev'];
  assert.equal(viewerHost(new Headers({'x-supatrace-host': 'supatrace.dev'}), hosts), 'supatrace.dev');
  assert.equal(viewerHost(new Headers({'x-supatrace-host': ' SupaTrace.Tech '}), hosts), 'supatrace.tech');
  assert.equal(viewerHost(new Headers({'x-supatrace-host': 'evil.example'}), hosts), 'supatrace.tech');
  assert.equal(viewerHost(new Headers({'x-supatrace-host': 'supatrace.dev.evil.example'}), hosts), 'supatrace.tech');
  assert.equal(viewerHost(new Headers(), hosts), 'supatrace.tech');
  assert.equal(viewerHost(new Headers({'x-supatrace-host': 'supatrace.tech'}), ['supatrace.dev']), 'supatrace.dev', 'a host that is not enabled falls back');
});

test('production origin allowlist is exactly the two Supatrace origins', () => {
  assert.deepEqual([...PRODUCTION_ORIGINS], [DEV, TECH]);
  assert.equal(originsAreProduction({APP_ORIGIN: DEV}), true);
  assert.equal(originsAreProduction({APP_ORIGIN: TECH, APP_ORIGINS: [TECH, DEV]}), true);
  assert.equal(originsAreProduction({APP_ORIGIN: TECH, APP_ORIGINS: [TECH, 'https://evil.example']}), false);
});

test('envForRequest picks the arrival origin and its GitHub app, and ignores unknown hosts', () => {
  const {env} = fixture();
  const tech = envForRequest(get('supatrace.tech', '/'), env);
  assert.equal(tech.APP_ORIGIN, TECH);assert.equal(tech.GITHUB_CLIENT_ID, 'tech-app');assert.equal(tech.GITHUB_CLIENT_SECRET, 'tech-secret');
  const dev = envForRequest(get('supatrace.dev', '/'), env);
  assert.equal(dev.APP_ORIGIN, DEV);assert.equal(dev.GITHUB_CLIENT_ID, 'legacy-dev-app');
  const other = envForRequest(get('evil.example', '/'), env);
  assert.equal(other.APP_ORIGIN, TECH, 'unknown host falls back to primary');
  assert.equal(env.APP_ORIGIN, TECH, 'the shared env is never mutated');assert.equal(env.GITHUB_CLIENT_ID, 'legacy-dev-app');
});

test('single-origin deployments behave exactly as before', async () => {
  const {env} = fixture({APP_ORIGIN: DEV, APP_ORIGINS: undefined, GITHUB_BY_ORIGIN: undefined});
  const r = await handle(get('supatrace.dev', '/api/auth/login'), env);
  assert.equal(r.status, 302);
  assert.equal(location(r).searchParams.get('redirect_uri'), DEV + '/api/auth/callback');
  assert.equal(location(r).searchParams.get('client_id'), 'legacy-dev-app');
  const providers = await (await handle(get('supatrace.dev', '/api/auth/providers'), env)).json();
  assert.equal(providers.github, true);
});

test('GitHub sign-in on each host uses that host\'s callback and OAuth app', async () => {
  const {env} = fixture();
  const tech = location(await handle(get('supatrace.tech', '/api/auth/login'), env));
  assert.equal(tech.searchParams.get('redirect_uri'), TECH + '/api/auth/callback');
  assert.equal(tech.searchParams.get('client_id'), 'tech-app');
  const dev = location(await handle(get('supatrace.dev', '/api/auth/login'), env));
  assert.equal(dev.searchParams.get('redirect_uri'), DEV + '/api/auth/callback');
  assert.equal(dev.searchParams.get('client_id'), 'legacy-dev-app');
});

test('Google sign-in uses one client with a per-host redirect URI', async () => {
  const {env} = fixture();
  for (const [host, origin] of [['supatrace.tech', TECH], ['supatrace.dev', DEV]]) {
    const url = location(await handle(get(host, '/api/auth/google'), env));
    assert.equal(url.searchParams.get('client_id'), 'google-client');
    assert.equal(url.searchParams.get('redirect_uri'), origin + '/api/auth/google/callback');
  }
});

test('session and OAuth-state cookies stay host-only (__Host-, no Domain)', async () => {
  const {env} = fixture();
  const response = await handle(get('supatrace.tech', '/api/auth/login'), env);
  const cookies = response.headers.getSetCookie();
  assert.ok(cookies.length >= 1);
  for (const cookie of cookies) {assert.match(cookie, /^__Host-/);assert.doesNotMatch(cookie, /Domain=/i);assert.match(cookie, /Path=\/;/);assert.match(cookie, /Secure/);}
});

test('GitHub callback on .tech exchanges the code with the .tech app and callback', async () => {
  const {env, states, tenants} = fixture();
  states.set(digest(state), verifier);
  let body;
  env.fetcher = async (url, options) => {
    if (url === 'https://github.com/login/oauth/access_token') {body = JSON.parse(options.body);return Response.json({access_token: 'synthetic'});}
    return Response.json({id: 4242});
  };
  const r = await handle(get('supatrace.tech', '/api/auth/callback?code=abc&state=' + state, {headers: {cookie: '__Host-supatrace-oauth=' + state}}), env);
  assert.equal(r.status, 302);
  assert.equal(body.client_id, 'tech-app');assert.equal(body.client_secret, 'tech-secret');assert.equal(body.redirect_uri, TECH + '/api/auth/callback');
  assert.deepEqual(tenants, ['github-4242'], 'the same GitHub account maps to the same tenant on either host');
});

test('Google callback on .dev still uses the .dev redirect URI', async () => {
  const {env, states} = fixture();
  states.set(digest(state), verifier);
  let body;
  env.fetcher = async (url, options) => {
    if (url === 'https://oauth2.googleapis.com/token') {body = new URLSearchParams(options.body);return Response.json({access_token: 'synthetic'});}
    return Response.json({sub: 'g-1'});
  };
  const r = await handle(get('supatrace.dev', '/api/auth/google/callback?code=abc&state=' + state, {headers: {cookie: '__Host-supatrace-oauth=' + state}}), env);
  assert.equal(r.status, 302);
  assert.equal(body.get('redirect_uri'), DEV + '/api/auth/google/callback');
});

test('a host without its own GitHub app has GitHub off but Google and the rest still work', async () => {
  const {env} = fixture();
  delete env.GITHUB_BY_ORIGIN[TECH];
  const providers = await (await handle(get('supatrace.tech', '/api/auth/providers'), env)).json();
  assert.equal(providers.github, false);assert.equal(providers.google, true);
  assert.equal((await handle(get('supatrace.tech', '/api/auth/login'), env)).status, 404);
  const dev = await (await handle(get('supatrace.dev', '/api/auth/providers'), env)).json();
  assert.equal(dev.github, true);
  assert.equal((await handle(get('supatrace.tech', '/api/auth/google'), env)).status, 302);
});

test('mutating requests must come from the same host they arrive on', async () => {
  const {env, sessions} = fixture();
  const token = 't'.repeat(43);
  sessions.set(digest(token), 'github-1');
  const post = (host, origin) => handle(get(host, '/api/auth/logout', {method: 'POST', headers: {cookie: '__Host-supatrace=' + token, origin}}), env);
  assert.equal((await post('supatrace.tech', TECH)).status, 204);
  sessions.set(digest(token), 'github-1');
  assert.equal((await post('supatrace.dev', DEV)).status, 204);
  sessions.set(digest(token), 'github-1');
  assert.equal((await post('supatrace.tech', DEV)).status, 403, 'a .dev origin cannot act on a .tech request');
  assert.equal((await post('supatrace.dev', 'https://evil.example')).status, 403);
});

test('a write key approved on either host uploads through either host', async () => {
  const key = 'k'.repeat(43);
  const raw = JSON.stringify({version: 1, batch_id: 'b1', run_id: 'r1', events: [{id: 'e1', time: '2026-10-21T00:00:00Z', kind: 'note', name: 'synthetic', data: {ok: true}}]});
  const {env} = fixture();
  env.store.lookupWriteKey = async hash => hash === digest(key) ? {tenant_id: 'github-1'} : null;
  env.store.reserveBatch = async (tenant, batch) => ({...batch, status: 'pending', object_key: tenant + '/' + batch.request_hash});
  env.store.acceptReservedBatch = async () => {};
  env.objects = {putImmutable: async () => {}, get: async () => raw};
  for (const host of ['supatrace.tech', 'supatrace.dev']) {
    const r = await handle(get(host, '/api/batches', {method: 'POST', headers: {'content-type': 'application/json', 'x-supatrace-key': key, 'x-amz-content-sha256': digest(raw)}, body: raw}), env);
    assert.equal(r.status, 201, host);
  }
});

test('production origins must be the two Supatrace hosts or the API refuses to run', async () => {
  const {env} = fixture({APP_ORIGINS: [TECH, 'https://evil.example']});
  assert.equal((await handle(get('supatrace.tech', '/api/auth/providers'), env)).status, 503);
});
