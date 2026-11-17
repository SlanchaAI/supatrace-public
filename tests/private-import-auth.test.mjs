import test from 'node:test';
import {first, free, collisions, token as sessionToken, withSessionTokens} from './session-token-fixtures.mjs';
import assert from 'node:assert/strict';
import {privateLauncherFixture} from './private-launcher-fixture.mjs';
import {createPrivateImportAuthenticator} from '../src/private-import-auth.mjs';
import {digest} from '../src/aws-auth.mjs';

const origin = 'https://supatrace.dev';
const request = (token, init = {}) => new Request(origin + '/private-import-control', {
  method: 'POST', headers: {origin, cookie: '__Host-supatrace=' + token}, ...init
});

test('application session authenticator composes with the launcher through actual workers and saved export', async () => {
  const f = await privateLauncherFixture();
  try {
    f.options.authenticate = createPrivateImportAuthenticator({store: f.store, origin});
    const launcher = f.launcher(), incoming = request(f.token), job = await launcher.queue(incoming, f.input);
    const result = await launcher.runOne(incoming, f.jobInput(job));
    assert.equal(result.receipt.export_verified, true);
    const archive = JSON.parse(await launcher.download(incoming, f.jobInput(job)));
    assert.equal(archive.event_count, 2);
    assert.deepEqual(archive.runs[0].events.map(e => e.data.observation.id).sort(), ['child', 'root']);
    assert.equal(JSON.stringify([...f.client.items.values()]).includes(f.token), false);
  } finally { f.close(); }
});

test('identity comes from the stored session; JSON identity, pairing and MCP tokens cannot authenticate', async () => {
  const f = await privateLauncherFixture();
  try {
    const authenticate = createPrivateImportAuthenticator({store: f.store, origin});
    const identity = await authenticate(request(f.token, {body: JSON.stringify({tenant_id: 'github-999', parent_session: {token_hash: '0'.repeat(64)}})}));
    assert.deepEqual(identity, {tenant_id: f.submit.tenant, parent_session: f.parentSession});
    assert.equal(JSON.stringify(identity).includes(f.token), false);
    for (const headers of [{origin}, {origin, cookie: '__Host-supatrace-mcp=' + f.token},
      {origin, authorization: 'Bearer ' + f.token}, {origin, 'x-supatrace-key': f.key}])
      await assert.rejects(authenticate(request(f.token, {headers})), /authentication_required/);
  } finally { f.close(); }
});

test('authenticator requires exact production origin, POST and one unambiguous session cookie', async () => {
  const f = await privateLauncherFixture();
  try {
    const authenticate = createPrivateImportAuthenticator({store: f.store, origin});
    assert.throws(() => createPrivateImportAuthenticator({store: f.store, origin: 'https://unapproved.invalid'}), /authentication_required/);
    assert.throws(() => createPrivateImportAuthenticator({store: {}, origin}), /authentication_required/);
    for (const incoming of [request(f.token, {method: 'GET'}), request(f.token, {headers: {origin: 'https://foreign.invalid', cookie: '__Host-supatrace=' + f.token}}),
      new Request('https://supatrace.tech/private-import-control', {method: 'POST', headers: {origin, cookie: '__Host-supatrace=' + f.token}}),
      request(f.token, {headers: {origin, cookie: '__Host-supatrace=' + f.token + '; __Host-supatrace=' + f.token}}), request('malformed')])
      await assert.rejects(authenticate(incoming), /authentication_required/);
  } finally { f.close(); }
});

for (const invalid of ['expired', 'removed', 'account-epoch', 'occupied-slot']) test('actual store rejects session ' + invalid, async () => {
  const f = await privateLauncherFixture();
  try {
    const authenticate = createPrivateImportAuthenticator({store: f.store, origin}), incoming = request(f.token);
    if (invalid === 'expired') {
      const now = f.store.now(); f.store.now = () => now + 31 * 86400;
    }
    if (invalid === 'removed') await f.store.deleteSession(digest(f.token));
    if (invalid === 'account-epoch') await f.store.endTenantSessions(f.submit.tenant);
    if (invalid === 'occupied-slot') {
      const row = [...f.client.items.values()].find(r => r.token_hash === digest(f.token) && r.sk === 'SESSION');
      assert.ok(row); row.token_hash = '0'.repeat(64);
    }
    await assert.rejects(authenticate(incoming), /authentication_required/);
    assert.deepEqual(f.counts(), {sourceRequests: 0, destinationRequests: 0, leases: 0});
  } finally { f.close(); }
});

test('session removed during initial storage read cannot produce an authenticated identity', async () => {
  const f = await privateLauncherFixture();
  try {
    const read = f.store.getImportSessionStamp.bind(f.store); let calls = 0;
    f.store.getImportSessionStamp = async tokenHash => {
      const value = await read(tokenHash);
      if (++calls === 1) await f.store.deleteSession(tokenHash);
      return value;
    };
    await assert.rejects(createPrivateImportAuthenticator({store: f.store, origin})(request(f.token)), /authentication_required/);
    assert.equal(calls, 2);
  } finally { f.close(); }
});

test('cookie mutation during await cannot switch to a replacement physical session', async () => {
  const f = await withSessionTokens([first, free[1], free[0], collisions[0]], () => privateLauncherFixture());
  try {
    const incoming = request(f.token), replacement = sessionToken(free[0]);
    await f.store.createSession(digest(replacement), f.submit.tenant);
    const read = f.store.getImportSessionStamp.bind(f.store);
    f.store.getImportSessionStamp = async tokenHash => { incoming.headers.set('cookie', '__Host-supatrace=' + replacement); return read(tokenHash); };
    const result = await createPrivateImportAuthenticator({store: f.store, origin})(incoming);
    assert.equal(result.parent_session.token_hash, digest(f.token));
    assert.notEqual(result.parent_session.token_hash, digest(replacement));
  } finally { f.close(); }
});

test('aborted authentication and unexpected store diagnostics fail closed without leaking details', async () => {
  const f = await privateLauncherFixture();
  try {
    const abort = new AbortController(); abort.abort();
    await assert.rejects(createPrivateImportAuthenticator({store: f.store, origin})(request(f.token, {signal: abort.signal})), /authentication_required/);
    f.store.getImportSessionStamp = async () => { throw Error('SYNTHETIC_STORE_SECRET', {cause: 'SYNTHETIC_STORE_SECRET'}); };
    await assert.rejects(createPrivateImportAuthenticator({store: f.store, origin})(request(f.token)), error => {
      assert.equal(error.code, 'private_import_authentication_required');
      assert.equal(String(error).includes('SYNTHETIC_STORE_SECRET'), false);
      assert.equal(error.cause, undefined); return true;
    });
  } finally { f.close(); }
});
