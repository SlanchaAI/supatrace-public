import test from 'node:test';
import assert from 'node:assert/strict';
import {establishSession, devSession, digest} from '../src/aws-auth.mjs';
import {DynamoMetadataStore} from '../src/dynamodb-store.mjs';
import {handle} from '../src/aws-api.mjs';
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import * as documentCommands from '@aws-sdk/lib-dynamodb';
import {MemoryDynamo, commandClasses} from './memory-dynamo.mjs';
import {first, collisions, free, token, withSessionTokens} from './session-token-fixtures.mjs';

const NOW = 1793870400;
const cancellation = codes => Object.assign(new Error('synthetic private storage detail'), {
  name: 'TransactionCanceledException', ...(codes === null ? {} : {CancellationReasons: codes.map(Code => ({Code}))})
});
async function world(t) {
  t.mock.method(Date, 'now', () => NOW * 1000);
  const client = new MemoryDynamo(), store = new DynamoMetadataStore({client, commands: commandClasses(), tableName: 'metadata'});
  await store.getOrCreateTenant(1); await store.getOrCreateTenant(2);
  const writes = [], reads = [], original = client.send.bind(client);
  client.send = async command => {
    if (command.name === 'GetCommand') reads.push(command.input.Key);
    if (command.input.TransactItems?.[1]?.Put?.Item?.sk === 'SESSION') writes.push(command.input.TransactItems[1].Put.Item);
    return original(command);
  };
  return {client, store, writes, reads};
}
const sessionRows = client => [...client.items.values()].filter(row => row.sk === 'SESSION');
const cookieToken = response => response.headers.getSetCookie().find(value => value.startsWith('__Host-supatrace=')).split(';')[0].split('=')[1];
const issue = (store, bytes, tenant = 'github-1') => withSessionTokens(bytes, () => establishSession({store}, tenant, 'json'));

test('a confirmed cross-tenant collision selects a fresh token without replacing the holder', async t => {
  const {store, client, writes} = await world(t);
  await store.createSession(digest(token(first)), 'github-1'); const held = structuredClone(sessionRows(client)); writes.length = 0;
  const response = await issue(store, [collisions[0], free[0]], 'github-2');
  assert.equal(response.status, 204); assert.equal(cookieToken(response), token(free[0]));
  assert.equal(writes.length, 2); assert.notEqual(writes[0].pk, writes[1].pk);
  assert.deepEqual(sessionRows(client).filter(row => row.token_hash === digest(token(first))), held);
  assert.equal((await store.getSession(digest(token(first)))).tenant_id, 'github-1');
  assert.equal(await store.getSession(digest(token(collisions[0]))), null);
  assert.equal((await store.getSession(digest(token(free[0])))).tenant_id, 'github-2');
  assert.ok(writes.every(row => row.expires_at === NOW + 86400 && row.session_epoch === 0));
  assert.equal(sessionRows(client).length, 2);
});

test('three confirmed collisions stop with a retryable public error and preserve all rows', async t => {
  const {store, client, writes} = await world(t);
  await store.createSession(digest(token(first)), 'github-1'); const before = structuredClone(sessionRows(client)); writes.length = 0;
  await withSessionTokens(collisions, () => assert.rejects(establishSession({store}, 'github-2', 'json'), error => error.status === 503 && error.code === 'session_unavailable'));
  assert.equal(writes.length, 3); assert.equal(new Set(writes.map(row => row.token_hash)).size, 3);
  assert.deepEqual(sessionRows(client), before);
});

test('expired occupied slots are reusable without waiting for TTL deletion', async t => {
  const {store, client, writes} = await world(t);
  await store.createSession(digest(token(first)), 'github-1'); sessionRows(client)[0].expires_at = NOW; writes.length = 0;
  const response = await issue(store, [collisions[0]], 'github-2');
  assert.equal(response.status, 204); assert.equal(writes.length, 1); assert.equal(sessionRows(client).length, 1);
  assert.equal(await store.getSession(digest(token(first))), null);
});

test('local QA session issuance uses the same bounded collision recovery', async t => {
  const {store} = await world(t); await store.createSession(digest(token(first)), 'github-1');
  const response = await withSessionTokens([collisions[0], free[0]], () => devSession(new Request('http://127.0.0.1:9000/api/auth/dev/session?subject=2'), {store}));
  assert.equal(response.status, 302); assert.equal(cookieToken(response), token(free[0]));
});

for (const [label, codes] of [
  ['missing reasons', null], ['short reasons', ['ConditionalCheckFailed']],
  ['reversed reasons', ['ConditionalCheckFailed', 'None']], ['both conditions failed', ['ConditionalCheckFailed', 'ConditionalCheckFailed']],
  ['throttled slot', ['None', 'ThrottlingError']], ['transaction conflict', ['None', 'TransactionConflict']],
  ['extra reason', ['None', 'ConditionalCheckFailed', 'None']]
]) test(label + ' cannot trigger another token or slot readback', async t => {
  const {store, client, reads} = await world(t); const send = client.send.bind(client), error = cancellation(codes);
  client.send = command => command.input.TransactItems?.[1]?.Put?.Item?.sk === 'SESSION' ? Promise.reject(error) : send(command);
  await withSessionTokens([free[0]], () => assert.rejects(establishSession({store}, 'github-1', 'json'), failure => failure === error));
  assert.equal(reads.filter(key => key.sk === 'SESSION').length, 0);
});

for (const [label, change] of [
  ['own token', row => row.token_hash = digest(token(collisions[0]))],
  ['malformed token', row => row.token_hash = 'bad'],
  ['expired row', row => row.expires_at = NOW],
  ['malformed expiry', row => row.expires_at = String(NOW + 86400)]
]) test(label + ' readback cannot authorize regeneration', async t => {
  const {store, client} = await world(t); await store.createSession(digest(token(first)), 'github-1');
  const send = client.send.bind(client), error = cancellation(['None', 'ConditionalCheckFailed']);
  client.send = async command => {
    if (command.input.TransactItems?.[1]?.Put?.Item?.sk === 'SESSION') throw error;
    const result = await send(command); if (command.input.Key?.sk === 'SESSION') change(result.Item); return result;
  };
  await withSessionTokens([collisions[0]], () => assert.rejects(establishSession({store}, 'github-2', 'json'), failure => failure === error));
});

for (const readback of ['missing', 'failure']) test('collision readback ' + readback + ' stops without another token', async t => {
  const {store, client} = await world(t); await store.createSession(digest(token(first)), 'github-1');
  const send = client.send.bind(client), error = new Error('private readback failure');
  client.send = command => {
    if (command.input.Key?.sk === 'SESSION') return readback === 'missing' ? Promise.resolve({}) : Promise.reject(error);
    return send(command);
  };
  await withSessionTokens([collisions[0]], () => assert.rejects(establishSession({store}, 'github-2', 'json'), failure => readback === 'missing' ? failure.name === 'TransactionCanceledException' : failure === error));
});

for (const committed of [false, true]) test('ambiguous ' + (committed ? 'accepted' : 'unaccepted') + ' write never regenerates a token', async t => {
  const {store, client, writes} = await world(t), send = client.send.bind(client), error = new Error('private transport failure'); let attempts = 0;
  client.send = async command => {
    if (command.input.TransactItems?.[1]?.Put?.Item?.sk === 'SESSION') { attempts++; if (committed) await send(command); throw error; }
    return send(command);
  };
  await withSessionTokens([free[0]], () => assert.rejects(establishSession({store}, 'github-1', 'json'), failure => failure === error));
  assert.equal(attempts, 1); assert.equal(writes.length, committed ? 1 : 0); assert.equal(sessionRows(client).length, committed ? 1 : 0);
});

for (const when of ['before retry read', 'during retry transaction']) test('revocation ' + when + ' fences collision recovery', async t => {
  const {store, client, writes} = await world(t); await store.createSession(digest(token(first)), 'github-1'); writes.length = 0;
  const send = client.send.bind(client); let changed = false;
  client.send = async command => {
    const retryRead = command.input.Key?.pk === 'TENANT#github-1' && writes.length === 1;
    const retryWrite = command.input.TransactItems?.[1]?.Put?.Item?.token_hash === digest(token(free[0]));
    if (!changed && (when === 'before retry read' ? retryRead : retryWrite)) { changed = true; await store.endTenantSessions('github-1'); }
    return send(command);
  };
  await withSessionTokens([collisions[0], free[0]], () => assert.rejects(establishSession({store}, 'github-1', 'json'), error => when === 'before retry read' ? error.code === 'session_changed' : error.name === 'TransactionCanceledException'));
  assert.equal(changed, true); assert.equal(writes.length, when === 'before retry read' ? 1 : 2);
  assert.equal(await store.getSession(digest(token(first))), null); assert.equal(await store.getSession(digest(token(free[0]))), null);
  assert.equal(sessionRows(client).length, 1);
});

test('unknown tenant and invalid epochs never write a session', async t => {
  const {store, client, writes} = await world(t);
  await withSessionTokens([free[0]], () => assert.rejects(establishSession({store}, 'github-3', 'json'), /session_collision_or_unknown_tenant/));
  for (const epoch of [-1, '1', 1.5]) {
    [...client.items.values()].find(row => row.pk === 'TENANT#github-1').session_epoch = epoch;
    await withSessionTokens([free[0]], () => assert.rejects(establishSession({store}, 'github-1', 'json'), /session_changed/));
  }
  assert.equal(writes.length, 0);
});

test('retry expiry stays fixed when wall time advances', async t => {
  const {store, writes} = await world(t); await store.createSession(digest(token(first)), 'github-1'); writes.length = 0;
  let clock = NOW; t.mock.method(Date, 'now', () => clock * 1000);
  const create = store.createSession.bind(store);
  store.createSession = (...args) => { clock++; return create(...args); };
  assert.equal((await issue(store, [collisions[0], collisions[1], free[0]])).status, 204);
  assert.equal(writes.length, 3); assert.ok(writes.every(row => row.expires_at === NOW + 86400));
});

test('tenant disappearance between collision attempts stops before another transaction', async t => {
  const {store, client, writes} = await world(t); await store.createSession(digest(token(first)), 'github-1'); writes.length = 0;
  const send = client.send.bind(client);
  client.send = command => {
    if (command.input.Key?.pk === 'TENANT#github-1' && writes.length === 1) client.items.delete('TENANT#github-1\0META');
    return send(command);
  };
  await withSessionTokens([collisions[0], free[0]], () => assert.rejects(establishSession({store}, 'github-1', 'json'), /session_collision_or_unknown_tenant/));
  assert.equal(writes.length, 1); assert.equal(sessionRows(client).length, 1);
});

test('unknown storage failure produces only a generic HTTP error without a cookie', async t => {
  const {store} = await world(t); let attempts = 0;
  store.createSession = async () => { attempts++; throw new Error('private token and storage detail'); };
  const env = {store, objects: {}, ENABLED: true, DEV_AUTH: true, APP_ORIGIN: 'http://127.0.0.1:9000', GITHUB_CLIENT_ID: 'synthetic', GITHUB_CLIENT_SECRET: 'synthetic'};
  const response = await withSessionTokens([free[0]], () => handle(new Request(env.APP_ORIGIN + '/api/auth/dev/session?subject=1'), env));
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), {error: 'temporarily_unavailable'});
  assert.equal(response.headers.getSetCookie().length, 0); assert.equal(attempts, 1);
});

test('the pinned AWS SDK exposes ordered cancellation reasons to real store recovery', async t => {
  t.mock.method(Date, 'now', () => NOW * 1000); const operations = [];
  const client = new DynamoDBClient({region: 'us-east-1', maxAttempts: 1,
    credentials: {accessKeyId: 'synthetic', secretAccessKey: 'synthetic'},
    requestHandler: {async handle(request) {
      const operation = request.headers['x-amz-target'].split('.').at(-1), body = JSON.parse(request.body);
      operations.push(operation); let result = {}, statusCode = 200;
      if (operations.length === 2) {
        assert.equal(operation, 'TransactWriteItems');
        assert.equal(body.TransactItems[1].Put.Item.token_hash.S, digest(token(collisions[0])));
        statusCode = 400; result = {__type: 'com.amazonaws.dynamodb.v20120810#TransactionCanceledException',
          CancellationReasons: [{Code: 'None'}, {Code: 'ConditionalCheckFailed'}]};
      } else if (operations.length === 3) {
        assert.equal(body.Key.pk.S, 'SESSION#' + Number(BigInt('0x' + digest(token(first))) % 1000n));
        assert.equal(body.ConsistentRead, true);
        result = {Item: {token_hash: {S: digest(token(first))}, expires_at: {N: String(NOW + 86400)}}};
      } else if (operation === 'GetItem') result = {Item: {pk: {S: 'TENANT#github-1'}, sk: {S: 'META'}}};
      else if (operations.length === 6) {
        // The sign-in audit event is its own single-item write after the session exists.
        assert.equal(operation, 'TransactWriteItems'); assert.equal(body.TransactItems.length, 1);
        assert.equal(body.TransactItems[0].Put.Item.pk.S, 'AUDIT#github-1'); assert.equal(body.TransactItems[0].Put.Item.action.S, 'auth.sign_in');
        assert.equal(body.TransactItems[0].Put.ConditionExpression, 'attribute_not_exists(pk)');
      } else {
        assert.equal(operations.length, 5); assert.equal(operation, 'TransactWriteItems');
        assert.equal(body.TransactItems[1].Put.Item.token_hash.S, digest(token(free[0])));
        assert.equal(body.TransactItems[0].ConditionCheck.ExpressionAttributeValues[':epoch'].N, '0');
      }
      return {response: {statusCode, headers: {'content-type': 'application/x-amz-json-1.0'}, body: Buffer.from(JSON.stringify(result))}};
    }}});
  try {
    const store = new DynamoMetadataStore({client: documentCommands.DynamoDBDocumentClient.from(client), commands: documentCommands, tableName: 'synthetic-session-test'});
    const response = await issue(store, [collisions[0], free[0]]);
    assert.equal(response.status, 204); assert.equal(cookieToken(response), token(free[0]));
    assert.deepEqual(operations, ['GetItem', 'TransactWriteItems', 'GetItem', 'GetItem', 'TransactWriteItems', 'TransactWriteItems']);
  } finally { client.destroy(); }
});
