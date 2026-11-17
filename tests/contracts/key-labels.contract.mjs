// Contract for issue #66 (J1: tell which API key is the new one). No server, browser, Docker or network.
// Run: node --test tests/contracts/key-labels.contract.mjs
// Interface:
//  1. GET /api/keys includes `created_at` (integer epoch seconds, as stored on the key row) on every key.
//  2. public/app/key-data.js loadAccountKeys accepts that optional field and returns it on each row;
//     a non-integer or negative created_at is rejected like any other malformed key (error invalid_key_page).
//  3. public/app/key-data.js exports newestKeyId(rows): the id of the row with the largest created_at
//     (ties: the first such row), or null when no row has a created_at.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {handle} from '../../src/aws-api.mjs';
import {digest} from '../../src/aws-auth.mjs';
import {DynamoMetadataStore} from '../../src/dynamodb-store.mjs';
import {MemoryDynamo, commandClasses} from '../memory-dynamo.mjs';
import * as keyData from '../../public/app/key-data.js';

function world() {
  const store = new DynamoMetadataStore({client: new MemoryDynamo(), commands: commandClasses(), tableName: 'metadata'});
  return {store, env: {ENABLED: true, APP_ORIGIN: 'https://supatrace.dev', GITHUB_CLIENT_ID: 'synthetic-client', GITHUB_CLIENT_SECRET: 'synthetic-secret', store, objects: {async putImmutable() {}, async get() { throw new Error('unused'); }}, sourceIp: '203.0.113.10'}};
}
async function signIn(env, id) {
  const start = await handle(new Request('https://supatrace.dev/api/auth/login'), env);
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const oauth = start.headers.getSetCookie().find(v => v.startsWith('__Host-supatrace-oauth=')).split(';')[0];
  let step = 0;
  env.fetcher = async () => ++step === 1 ? Response.json({access_token: 'synthetic-token'}) : Response.json({id, login: 'synthetic'});
  const back = await handle(new Request(`https://supatrace.dev/api/auth/callback?code=c-${id}&state=${state}`, {headers: {cookie: oauth}}), env);
  return back.headers.getSetCookie().find(v => v.startsWith('__Host-supatrace=')).split(';')[0];
}

test('GET /api/keys exposes created_at for each key', async () => {
  const {env, store} = world(), session = await signIn(env, 5858), tenant = 'github-5858';
  const key = randomBytes(32).toString('base64url');
  const setup = await store.createSetup(digest(key));
  await store.approveSetup(tenant, setup.user_code);
  const res = await handle(new Request('https://supatrace.dev/api/keys', {headers: {cookie: session}}), env);
  assert.equal(res.status, 200);
  const {keys} = await res.json();
  assert.equal(keys.length, 1);
  assert.ok(Number.isInteger(keys[0].created_at) && Math.abs(keys[0].created_at - Date.now() / 1000) < 300);
});

const project = 'proj_' + 'b'.repeat(32);
const row = (n, created_at) => ({id: n.toString(16).padStart(64, '0'), project_id: project, scope: 'write_only', expires_at: 2_000_000_000, revoked: false, ...(created_at === undefined ? {} : {created_at})});
const load = keys => keyData.loadAccountKeys(async () => ({keys, next: null}), {projectId: project});

test('loadAccountKeys keeps created_at and rejects malformed values', async () => {
  const rows = await load([row(1, 100), row(2, 300)]);
  const list = Array.isArray(rows) ? rows : rows.keys ?? rows.rows;
  assert.deepEqual(list.map(k => k.created_at), [100, 300]);
  const legacy = await load([row(9)]);
  assert.equal((Array.isArray(legacy) ? legacy : legacy.keys ?? legacy.rows).length, 1);
  await assert.rejects(load([row(3, 1.5)]), /invalid_key_page/);
  await assert.rejects(load([row(4, -1)]), /invalid_key_page/);
});

test('newestKeyId picks the largest created_at', () => {
  assert.equal(typeof keyData.newestKeyId, 'function');
  assert.equal(keyData.newestKeyId([row(1, 100), row(2, 300), row(3, 200)]), row(2).id);
  assert.equal(keyData.newestKeyId([row(5, 7), row(6, 7)]), row(5).id);
  assert.equal(keyData.newestKeyId([row(7), row(8)]), null);
  assert.equal(keyData.newestKeyId([row(10), row(11, 50), row(12)]), row(11).id);
  assert.equal(keyData.newestKeyId([]), null);
});
