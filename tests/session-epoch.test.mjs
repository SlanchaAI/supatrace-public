import test from 'node:test';
import assert from 'node:assert/strict';
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import * as commands from '@aws-sdk/lib-dynamodb';
import {handle} from '../src/aws-api.mjs';
import {hashPassword, totp, checkPassword} from '../src/dashboard-auth.mjs';
import {DynamoMetadataStore, digest} from '../src/dynamodb-store.mjs';
import {MemoryDynamo, commandClasses} from './memory-dynamo.mjs';
import {first, collisions, free, token, withSessionTokens} from './session-token-fixtures.mjs';
import {establishSession} from '../src/aws-auth.mjs';

const NOW = 1793870400, email = 'epoch@example.com', tenantId = 'email-' + digest(email);
const oldPassword = 'Old!12345', newPassword = 'New!67890', recovery = 'synthetic-recovery';
const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
async function world(t, mfa = false) {
  t.mock.method(Date, 'now', () => NOW * 1000);
  const client = new MemoryDynamo(), store = new DynamoMetadataStore({client, commands: commandClasses(), tableName: 'synthetic'}), mailbox = [];
  const env = {store, objects: {}, ENABLED: true, APP_ORIGIN: 'https://supatrace.dev', GITHUB_CLIENT_ID: 'synthetic', GITHUB_CLIENT_SECRET: 'synthetic', EMAIL_FROM: 'member@example.com', MFA_ENABLED: true, sourceIp: '203.0.113.40', sendEmail: async value => mailbox.push(value)};
  await store.createVerifiedEmailAccount(email, hashPassword(oldPassword));
  if (mfa) await store.setTenantFields(tenantId, 'SET mfa_secret = :secret, recovery_hashes = :hashes, mfa_failures = :failures', {':secret': secret, ':hashes': [digest(recovery)], ':failures': 2});
  return {env, store, mailbox, client};
}
const post = (w, path, body, cookie = '') => handle(new Request(w.env.APP_ORIGIN + path, {method: 'POST', headers: {origin: w.env.APP_ORIGIN, 'content-type': 'application/json', cookie}, body: JSON.stringify(body)}), w.env);
const cookie = (response, name) => {const value = response.headers.getSetCookie().find(item => item.startsWith(name + '=')); assert.ok(value, name); return value.split(';')[0];};
const me = (w, value) => handle(new Request(w.env.APP_ORIGIN + '/api/me', {headers: {cookie: value}}), w.env);
const login = (w, password = oldPassword) => post(w, '/api/auth/email/sign-in', {email, password});
const mfaPath = recovery => recovery ? '/api/auth/mfa/recovery' : '/api/auth/mfa';
const mfaBody = recover => ({code: recover ? recovery : totp(secret)});
async function prepareReset(w) {
  assert.equal((await post(w, '/api/auth/email/reset', {email})).status, 200);
  const code = w.mailbox.at(-1).text.match(/reset code is (\d{6})/)[1];
  const response = await post(w, '/api/auth/email/reset/confirm', {email, code}); assert.equal(response.status, 200);
  return cookie(response, '__Host-supatrace-reset');
}
const finishReset = (w, value) => post(w, '/api/auth/email/reset/password', {password: newPassword}, value);
async function reset(w) {assert.equal((await finishReset(w, await prepareReset(w))).status, 200);}
function pauseRead(target, name) {
  const original = target[name].bind(target); let entered, release, used = false;
  const reached = new Promise(resolve => entered = resolve), resumed = new Promise(resolve => release = resolve);
  target[name] = async (...args) => {const row = await original(...args); if (!used) {used = true; entered(); await resumed;} return row;};
  return {reached, release};
}
async function denied(response, status = 409, code = 'session_changed') {
  assert.equal(response.status, status); assert.deepEqual(await response.json(), {error: code});
  assert.equal(response.headers.getSetCookie().length, 0);
}

for (const mfa of [false, true]) test('old password snapshot cannot cross completed reset, MFA=' + mfa, async t => {
  const w = await world(t, mfa), gate = pauseRead(w.store, 'getEmailAccount');
  const pending = login(w); await gate.reached; await reset(w); gate.release();
  await denied(await pending);
  assert.equal((await login(w)).status, 401);
  const fresh = await login(w, newPassword); assert.equal(fresh.status, mfa ? 200 : 204);
  if (mfa) assert.equal((await post(w, '/api/auth/mfa', {code: totp(secret)}, cookie(fresh, '__Host-supatrace-mfa'))).status, 204);
  assert.equal((await w.store.getTenant(tenantId)).session_epoch, 1);
});

for (const password of [oldPassword, newPassword]) test('epoch capture before password read cannot adopt reset credentials: ' + (password === oldPassword ? 'old' : 'new'), async t => {
  const w = await world(t), gate = pauseRead(w.store, 'getTenant');
  const pending = login(w, password); await gate.reached; await reset(w); gate.release();
  await denied(await pending, password === oldPassword ? 401 : 409, password === oldPassword ? 'invalid_credentials' : 'session_changed');
  assert.equal((await login(w, newPassword)).status, 204);
});

test('reset between session pre-read and transaction fails the atomic epoch condition', async t => {
  const w = await world(t), send = w.client.send.bind(w.client); let intercepted = false;
  w.client.send = async command => {
    if (!intercepted && command.input.TransactItems?.[1]?.Put?.Item?.sk === 'SESSION') {intercepted = true; await reset(w);}
    return send(command);
  };
  await denied(await login(w), 503, 'temporarily_unavailable');
  assert.equal(intercepted, true); assert.equal([...w.client.items.values()].filter(row => row.sk === 'SESSION').length, 0);
  assert.equal((await login(w, newPassword)).status, 204);
});

test('MFA challenge creation is atomically bound to the password generation', async t => {
  const w = await world(t, true), create = w.store.createMfaChallenge.bind(w.store); let once = false;
  w.store.createMfaChallenge = async (...args) => {if (!once) {once = true; await reset(w);} return create(...args);};
  await denied(await login(w));
  assert.equal([...w.client.items.values()].filter(row => row.pk.startsWith('MFA#')).length, 0);
  assert.equal((await login(w, newPassword)).status, 200);
});

for (const recover of [false, true]) test('pre-reset MFA ' + (recover ? 'recovery' : 'TOTP') + ' is revoked; fresh challenge succeeds', async t => {
  const w = await world(t, true), challenge = cookie(await login(w), '__Host-supatrace-mfa');
  const id = digest(challenge.split('=')[1]); assert.equal((await w.store.peekAuthChallenge('MFA', id)).session_epoch, 0);
  await reset(w); await denied(await post(w, mfaPath(recover), mfaBody(recover), challenge));
  const unchanged = await w.store.getTenant(tenantId); assert.equal(unchanged.mfa_failures, 2); assert.deepEqual(unchanged.recovery_hashes, [digest(recovery)]);
  const fresh = cookie(await login(w, newPassword), '__Host-supatrace-mfa');
  assert.equal((await w.store.peekAuthChallenge('MFA', digest(fresh.split('=')[1]))).session_epoch, 1);
  const accepted = await post(w, mfaPath(recover), mfaBody(recover), fresh); assert.equal(accepted.status, 204);
  assert.equal((await me(w, cookie(accepted, '__Host-supatrace'))).status, 200);
  await denied(await post(w, mfaPath(recover), mfaBody(recover), fresh), 401, 'sign_in_required');
});

for (const epoch of [undefined, -1, '0', 0.5]) test('legacy or invalid MFA epoch is rejected: ' + String(epoch), async t => {
  const w = await world(t, true), value = token(first);
  await w.store.createAuthChallenge('MFA', digest(value), {tenant_id: tenantId, ...(epoch === undefined ? {} : {session_epoch: epoch})}, 300);
  await denied(await post(w, '/api/auth/mfa', {code: totp(secret)}, '__Host-supatrace-mfa=' + value));
});

for (const kind of ['clear', 'miss', 'recovery']) test('reset before MFA ' + kind + ' state write cannot mutate the new generation', async t => {
  const w = await world(t, true), challenge = cookie(await login(w), '__Host-supatrace-mfa');
  const write = w.store.setTenantFields.bind(w.store); let once = false;
  w.store.setTenantFields = async (...args) => {if (!once) {once = true; assert.equal(args[3], 0); await reset(w);} return write(...args);};
  const response = await post(w, mfaPath(kind === 'recovery'), kind === 'miss' ? {code: 'invalid'} : mfaBody(kind === 'recovery'), challenge);
  await denied(response, 503, 'temporarily_unavailable');
  const current = await w.store.getTenant(tenantId); assert.equal(current.session_epoch, 1); assert.equal(current.mfa_failures, 2); assert.deepEqual(current.recovery_hashes, [digest(recovery)]);
});

for (const recover of [false, true]) test('reset after MFA validation cannot mint a new-generation session: ' + recover, async t => {
  const w = await world(t, true), challenge = cookie(await login(w), '__Host-supatrace-mfa');
  const create = w.store.createSession.bind(w.store); let once = false;
  w.store.createSession = async (...args) => {if (!once) {once = true; assert.equal(args[3], 0); await reset(w);} return create(...args);};
  await denied(await post(w, mfaPath(recover), mfaBody(recover), challenge));
  assert.equal([...w.client.items.values()].filter(row => row.sk === 'SESSION').length, 0);
});

test('losing MFA challenge consumption cannot issue a session', async t => {
  const w = await world(t, true), challenge = cookie(await login(w), '__Host-supatrace-mfa'), consume = w.store.consumeAuthChallenge.bind(w.store);
  w.store.consumeAuthChallenge = async (...args) => {if (args[0] === 'MFA') await consume(...args); return consume(...args);};
  await denied(await post(w, '/api/auth/mfa', {code: totp(secret)}, challenge), 401, 'sign_in_required');
  assert.equal([...w.client.items.values()].filter(row => row.sk === 'SESSION').length, 0);
});

for (const committed of [false, true]) test('ambiguous reset outcome has no fallback writes; accepted=' + committed, async t => {
  const w = await world(t), signedIn = cookie(await login(w), '__Host-supatrace'), resetToken = await prepareReset(w);
  const send = w.client.send.bind(w.client); let writes = 0, fallback = 0;
  w.client.send = async command => {
    if (command.name === 'UpdateCommand' && (command.input.UpdateExpression.includes('password_hash') || command.input.UpdateExpression.includes('session_epoch'))) fallback++;
    if (command.input.TransactItems?.[0]?.Update?.UpdateExpression === 'SET password_hash = :hash') {writes++; if (committed) await send(command); throw Error('private reset storage failure');}
    return send(command);
  };
  await denied(await finishReset(w, resetToken), 503, 'temporarily_unavailable');
  assert.equal(writes, 1); assert.equal(fallback, 0);
  assert.equal((await me(w, signedIn)).status, committed ? 401 : 200);
  assert.equal((await login(w, committed ? newPassword : oldPassword)).status, 204);
  assert.equal((await login(w, committed ? oldPassword : newPassword)).status, 401);
});

for (const missing of ['tenant', 'verified email']) test('reset transaction condition failure rolls back both fields: ' + missing, async t => {
  const w = await world(t), before = (await w.store.getEmailAccount(email)).password_hash;
  if (missing === 'tenant') w.client.items.delete('TENANT#' + tenantId + '\0META');
  else [...w.client.items.values()].find(row => row.pk.startsWith('EMAIL#')).verified = false;
  await assert.rejects(w.store.resetEmailPassword(email, tenantId, hashPassword(newPassword)), error => error.name === 'TransactionCanceledException');
  assert.equal((await w.store.getEmailAccount(email)).password_hash, before);
  if (missing !== 'tenant') assert.equal((await w.store.getTenant(tenantId)).session_epoch, undefined);
});

test('email account must match the server-derived tenant', async t => {
  const w = await world(t); [...w.client.items.values()].find(row => row.pk.startsWith('EMAIL#')).tenant_id = 'github-1';
  await denied(await login(w), 401, 'invalid_credentials');
});

test('nonzero epoch cannot become an absent field between read and session commit', async t => {
  const w = await world(t); await w.store.endTenantSessions(tenantId); const send = w.client.send.bind(w.client);
  w.client.send = command => {if (command.input.TransactItems?.[1]?.Put?.Item?.sk === 'SESSION') delete [...w.client.items.values()].find(row => row.pk === 'TENANT#' + tenantId).session_epoch; return send(command);};
  await assert.rejects(w.store.createSession(digest(token(free[0])), tenantId, NOW + 86400, 1), error => error.name === 'TransactionCanceledException');
  assert.equal([...w.client.items.values()].filter(row => row.sk === 'SESSION').length, 0);
});

test('pinned SDK serializes atomic reset and MFA epoch checks without additional writes', async t => {
  t.mock.method(Date, 'now', () => NOW * 1000); const requests = [];
  const client = new DynamoDBClient({region: 'us-east-1', maxAttempts: 1, credentials: {accessKeyId: 'synthetic', secretAccessKey: 'synthetic'}, requestHandler: {async handle(request) {
    assert.match(request.headers['x-amz-target'], /TransactWriteItems$/); const body = JSON.parse(request.body); requests.push(body);
    return {response: {statusCode: 200, headers: {'content-type': 'application/x-amz-json-1.0'}, body: Buffer.from('{}')}};
  }}});
  try {
    const store = new DynamoMetadataStore({client: commands.DynamoDBDocumentClient.from(client), commands, tableName: 'synthetic'});
    const hash = hashPassword(newPassword); assert.equal(checkPassword(newPassword, hash), true);
    await store.resetEmailPassword(email, tenantId, hash); await store.createMfaChallenge(digest(token(first)), tenantId, 1);
    assert.equal(requests.length, 2); assert.equal(requests[0].TransactItems.length, 2);
    assert.equal(requests[0].TransactItems[0].Update.Key.pk.S, 'EMAIL#' + digest(email));
    assert.equal(requests[0].TransactItems[0].Update.ExpressionAttributeValues[':hash'].S, hash);
    assert.equal(requests[0].TransactItems[1].Update.UpdateExpression, 'ADD session_epoch :one');
    assert.equal(requests[1].TransactItems[0].ConditionCheck.ConditionExpression, 'attribute_exists(pk) AND session_epoch = :epoch');
    assert.equal(requests[1].TransactItems[0].ConditionCheck.ExpressionAttributeValues[':epoch'].N, '1');
    assert.equal(requests[1].TransactItems[1].Put.Item.session_epoch.N, '1');
    assert.equal(requests[1].TransactItems[1].Put.Item.expires_at.N, String(NOW + 300));
  } finally {client.destroy();}
});


test('MFA login retries an occupied slot without replacing the pending challenge', async t => {
  const w = await world(t, true);
  await w.store.createMfaChallenge(digest(token(first)), tenantId, 0);
  const held = structuredClone(await w.store.peekAuthChallenge('MFA', digest(token(first))));
  const response = await withSessionTokens([collisions[0], free[0]], () => login(w));
  assert.equal(response.status, 200);
  assert.equal(cookie(response, '__Host-supatrace-mfa'), '__Host-supatrace-mfa=' + token(free[0]));
  assert.deepEqual(await w.store.peekAuthChallenge('MFA', digest(token(first))), held);
  assert.equal(await w.store.peekAuthChallenge('MFA', digest(token(collisions[0]))), null);
  assert.equal((await w.store.peekAuthChallenge('MFA', digest(token(free[0])))).session_epoch, 0);
});

test('three MFA slot collisions return a retryable failure without a cookie or replacement', async t => {
  const w = await world(t, true);
  await w.store.createMfaChallenge(digest(token(first)), tenantId, 0);
  const held = structuredClone(await w.store.peekAuthChallenge('MFA', digest(token(first))));
  const response = await withSessionTokens(collisions, () => login(w));
  await denied(response, 503, 'temporarily_unavailable');
  assert.equal(response.headers.getSetCookie().some(value => value.startsWith('__Host-supatrace-mfa=')), false);
  assert.deepEqual(await w.store.peekAuthChallenge('MFA', digest(token(first))), held);
  assert.equal([...w.client.items.values()].filter(row => row.pk.startsWith('MFA#')).length, 1);
});

for (const codes of [null, ['ConditionalCheckFailed'], ['None', 'TransactionConflict'], ['None', 'ConditionalCheckFailed', 'None']]) {
  test('ambiguous MFA transaction does not retry: ' + JSON.stringify(codes), async t => {
    const w = await world(t, true), send = w.client.send.bind(w.client);
    const failure = Object.assign(new Error('synthetic unavailable write'), {name: 'TransactionCanceledException', ...(codes ? {CancellationReasons: codes.map(Code => ({Code}))} : {})});
    let attempts = 0;
    w.client.send = command => {
      if (command.input.TransactItems?.[1]?.Put?.Item?.pk.startsWith('MFA#')) {attempts++; return Promise.reject(failure);}
      return send(command);
    };
    await withSessionTokens([free[0]], () => assert.rejects(establishSession(w.env, tenantId, 'json'), error => error === failure));
    assert.equal(attempts, 1);
  });
}
