import test from 'node:test';
import assert from 'node:assert/strict';
import {handle} from '../src/aws-api.mjs';
import {DynamoMetadataStore} from '../src/dynamodb-store.mjs';
import {MemoryDynamo, commandClasses} from './memory-dynamo.mjs';
import {createFixtureSession} from './fixture-session.mjs';

const origin = 'https://supatrace.dev', tenant = 'github-7';
const message = {email: 'customer@example.test', subject: 'Synthetic question', message: 'Synthetic delivery proof', priority: false, contract: false};
async function fixture(plan = 'base') {
  const client = new MemoryDynamo(), store = new DynamoMetadataStore({client, commands: commandClasses(), tableName: 'synthetic'}), mail = [];
  await store.getOrCreateTenant(7); const token = await createFixtureSession(store, tenant);
  const row = client.items.get('TENANT#' + tenant + '\0META'); row.plan_id = plan;
  const env = {ENABLED: true, APP_ORIGIN: origin, GITHUB_CLIENT_ID: 'synthetic', GITHUB_CLIENT_SECRET: 'synthetic', store, objects: {}, EMAIL_FROM: 'support@supatrace.dev', sendEmail: async value => mail.push(value)};
  const call = (data = message, options = {}) => handle(new Request(origin + '/api/support' + (options.query ?? ''), {method: options.method ?? 'POST', headers: {cookie: '__Host-supatrace=' + token, origin, 'content-type': 'application/json', ...options.headers}, ...(options.method === 'GET' ? {} : {body: JSON.stringify(data)})}), env);
  return {client, store, env, setPlan: plan => {client.items.get('TENANT#' + tenant + '\0META').plan_id = plan;}, call, mail};
}
for (const [plan, priority, contract, expected] of [['free', false, false, 402], ['base', false, false, 201], ['base', true, false, 402], ['base', false, true, 402], ['pro', true, false, 201], ['pro', false, true, 402], ['enterprise', true, true, 201]]) {
  test(`${plan} support priority=${priority} contract=${contract}: ${expected}`, async () => {
    const f = await fixture(plan), response = await f.call({...message, priority, contract}); assert.equal(response.status, expected, await response.clone().text());
    if (expected !== 201) {assert.equal(f.mail.length, 0); assert.equal((await response.json()).error, 'plan_upgrade_required'); return;}
    const body = await response.json(), route = contract ? 'contract' : priority ? 'priority' : 'standard';
    assert.equal(body.route, route); assert.equal(body.delivered, true); assert.equal(f.mail.length, 1);
    const sent = f.mail[0]; assert.equal(sent.to, 'support@supatrace.dev'); assert.ok(sent.subject.startsWith('[' + route.toUpperCase() + ']'));
    for (const value of [tenant, message.email, message.message, body.id, 'Environment: default']) assert.ok(sent.text.includes(value));
    assert.ok([...f.client.items.values()].some(row => row.action === 'support.request'), 'accepted delivery has an audit event');
  });
}
test('downgrade immediately closes priority and email gates without trusting client flags', async () => {
  const f = await fixture('pro'); assert.equal((await f.call({...message, priority: true})).status, 201);
  f.setPlan('base'); assert.equal((await f.call({...message, priority: true})).status, 402);
  f.setPlan('free'); assert.equal((await f.call()).status, 402); assert.equal(f.mail.length, 1);
});
test('support rejects malformed data, origin, session and out-of-scope environment before sending', async () => {
  const f = await fixture();
  for (const data of [null, [], {...message, subject: 'Injected\r\nHeader'}, {...message, message: 'x'.repeat(2501)}, {...message, email: 'invalid'}, {...message, priority: 'true'}, {...message, contract: undefined}, {...message, to: 'other@example.test'}]) assert.equal((await f.call(data)).status, 400);
  assert.equal((await f.call(message, {headers: {origin: 'https://other.example'}})).status, 403);
  assert.equal((await f.call(message, {headers: {cookie: ''}})).status, 401);
  assert.equal((await f.call(message, {query: '?environment=missing'})).status, 403); assert.equal(f.mail.length, 0);
});
test('five-per-hour limiter runs on the account and cannot be bypassed with a project selector', async () => {
  const f = await fixture();
  for (let i = 0; i < 5; i++) assert.equal((await f.call()).status, 201);
  const response = await f.call(); assert.equal(response.status, 429); assert.ok(Number(response.headers.get('Retry-After')) > 0); assert.equal(f.mail.length, 5);
});
test('maximum valid escaped and Unicode messages fit the support-only body budget', async () => {
  const f = await fixture();
  for (const character of ['"', '\u0001', '雪']) {
    const data = {...message, subject: 'x'.repeat(120), message: character.repeat(2500)};
    assert.equal((await f.call(data)).status, 201);
    assert.ok(f.mail.at(-1).text.includes(data.message));
  }
});
test('configuration and sender failures report unconfirmed delivery, never success', async () => {
  const f = await fixture(); delete f.env.EMAIL_FROM;
  assert.equal((await f.call(null, {method: 'GET'})).status, 200);
  assert.equal((await f.call()).status, 503); f.env.EMAIL_FROM = 'support@supatrace.dev'; f.env.sendEmail = async () => {throw Error('synthetic sender failure');};
  const response = await f.call(); assert.equal(response.status, 503); assert.equal((await response.json()).error, 'support_delivery_unconfirmed'); assert.equal(f.mail.length, 0);
});
