// Actual Lambda composition; only AWS I/O is replaced. Synthetic secrets never leave the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import {SecretsManagerClient} from '@aws-sdk/client-secrets-manager';
import {DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {DynamoMetadataStore} from '../src/dynamodb-store.mjs';
import {MemoryDynamo, commandClasses} from './memory-dynamo.mjs';
import {createFixtureSession} from './fixture-session.mjs';

for (const kind of ['valid', 'malformed', 'live', 'unreadable']) test('Lambda billing secret: ' + kind + ' preserves account access', async t => {
  const memory = new MemoryDynamo(), store = new DynamoMetadataStore({client: memory, commands: commandClasses(), tableName: 'synthetic'});
  await store.getOrCreateTenant(4242);
  const token = await createFixtureSession(store, 'github-4242'), reads = [];
  t.mock.method(SecretsManagerClient.prototype, 'send', async command => {
    reads.push(command.input.SecretId);
    if (command.input.SecretId === 'synthetic-github') return {SecretString: 'synthetic-oauth'};
    assert.equal(command.input.SecretId, 'synthetic-billing');
    if (kind === 'unreadable') throw new Error('synthetic-secret-unreadable');
    return {SecretString: kind === 'valid' ? 'sk_test_' + 'f'.repeat(24) : kind === 'live' ? 'sk_live_' + 'f'.repeat(24) : 'malformed'};
  });
  t.mock.method(DynamoDBDocumentClient, 'from', () => ({send: command => memory.send({name: command.constructor.name, input: command.input})}));
  const warnings = []; t.mock.method(console, 'warn', value => warnings.push(JSON.parse(value)));
  const settings = {SUPATRACE_ENABLED: 'true', TABLE_NAME: 'synthetic', PAYLOAD_BUCKET: 'synthetic', GITHUB_SECRET_ARN: 'synthetic-github', GITHUB_CLIENT_ID: 'synthetic', PLAN_BILLING_SECRET_ARN: 'synthetic-billing', APP_HOSTS: 'supatrace.dev'};
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  try {
    const {handler} = await import('../aws/handler.mjs?billing-case=' + kind);
    const call = path => handler({rawPath: '/api/' + path, requestContext: {http: {method: 'GET', sourceIp: '127.0.0.1'}}, headers: {host: 'supatrace.dev'}, cookies: ['__Host-supatrace=' + token]});
    const catalog = await call('billing/catalog'); assert.equal(catalog.statusCode, 200);
    const body = JSON.parse(catalog.body);
    assert.equal(body.checkout_available, ['valid','live'].includes(kind));
    assert.equal(body.mode, ['valid','live'].includes(kind) ? (kind==='live'?'stripe_live':'stripe_test') : 'unavailable');
    assert.equal((await call('me')).statusCode, 200, 'bad billing secrets cannot break a valid sign-in');
    assert.equal((await call('auth/providers')).statusCode, 200);
    assert.deepEqual(reads, ['synthetic-github', 'synthetic-billing'], 'warm calls cache success or back off failure');
    assert.equal(warnings.length, ['valid','live'].includes(kind) ? 0 : 1);
    if (warnings.length) assert.deepEqual(warnings[0], {event: 'plan_billing_unavailable', reason: kind === 'unreadable' ? 'secret_unreadable' : 'plan_billing_test_key_required'});
  } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});
