import test from 'node:test';
import assert from 'node:assert/strict';
import { DynamoMetadataStore, digest } from '../src/dynamodb-store.mjs';
import {MemoryDynamo, commandClasses} from './memory-dynamo.mjs';
import {PLAN_LIMITS, planLimits, usagePeriod} from '../src/plan-limits.mjs';
import {PLANS} from '../src/plans.mjs';
import {UPGRADE_PATH} from '../src/entitlements.mjs';

const names = ['GetCommand','PutCommand','DeleteCommand','UpdateCommand','QueryCommand','TransactWriteCommand'];
const commands = Object.fromEntries(names.map(name => [name, class { constructor(input) { this.name = name; this.input = input; } }]));
const slot = hash => Number(BigInt(`0x${hash}`) % 1000n);
const H = 'a'.repeat(64), H2 = 'b'.repeat(64), SECRET = 's'.repeat(43), NOW = 2000000000;
const conditionError = () => Object.assign(new Error('condition'), { name: 'ConditionalCheckFailedException' });
const txError = () => Object.assign(new Error('transaction condition'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] });
function harness(steps, options = {}) {
  const calls = [];
  const client = { async send(command) {
    calls.push(command); const step = steps.shift(); assert.ok(step, `Unexpected ${command.name}`);
    assert.equal(command.name, step[0]);
    if (typeof step[1] === 'function') return step[1](command.input);
    if (step[1] instanceof Error) throw step[1]; return step[1] ?? {};
  } };
  return { store: new DynamoMetadataStore({ client, commands, tableName: 'metadata', now: () => NOW, ...options }), calls,
    done() { assert.equal(steps.length, 0, 'Unconsumed mock calls'); } };
}
const code = value => error => error.code === value;
const SAML_HELD = '_synthetic-held-request', SAML_COLLISION = '_synthetic-forgery-293';
function samlStore(now = () => NOW) {
  const client = new MemoryDynamo();
  return {client, store: new DynamoMetadataStore({client, commands: commandClasses(), tableName: 'metadata', now})};
}

test('SAML cache collision cannot overwrite, read or delete the pending full request ID', async () => {
  assert.equal(slot(digest(SAML_HELD)), 529); assert.equal(slot(digest(SAML_COLLISION)), 529);
  const {store, client} = samlStore();
  await store.saveSamlCache(SAML_HELD, 'original');
  await assert.rejects(store.saveSamlCache(SAML_COLLISION, 'other'), code('sso_request_busy'));
  assert.equal(client.items.size, 1);
  assert.equal(await store.readSamlCache(SAML_HELD), 'original');
  assert.equal(await store.readSamlCache(SAML_COLLISION), null);
  assert.equal(await store.deleteSamlCache(SAML_COLLISION), null);
  assert.equal(await store.readSamlCache(SAML_HELD), 'original');
});
test('SAML cache concurrent colliding starts have one atomic winner', async () => {
  const {store, client} = samlStore();
  const results = await Promise.allSettled([store.saveSamlCache(SAML_HELD, 'held'), store.saveSamlCache(SAML_COLLISION, 'other')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected' && r.reason.code === 'sso_request_busy').length, 1);
  assert.equal(client.items.size, 1);
  const winner = results[0].status === 'fulfilled' ? SAML_HELD : SAML_COLLISION;
  assert.equal(await store.readSamlCache(winner), winner === SAML_HELD ? 'held' : 'other');
});
test('SAML cache same-ID save cannot change the value or extend a pending expiry', async () => {
  let now = NOW; const {store, client} = samlStore(() => now);
  await store.saveSamlCache(SAML_HELD, 'original'); const original = [...client.items.values()][0];
  now += 60;
  await assert.rejects(store.saveSamlCache(SAML_HELD, 'replacement'), code('sso_request_busy'));
  assert.deepEqual([...client.items.values()][0], original);
});
test('SAML cache reuses an expired slot despite TTL lag and a late old delete preserves its new occupant', async () => {
  let now = NOW; const {store, client} = samlStore(() => now);
  await store.saveSamlCache(SAML_HELD, 'old'); now += 8 * 3600;
  assert.equal(await store.readSamlCache(SAML_HELD), null); assert.equal(client.items.size, 1);
  await store.saveSamlCache(SAML_COLLISION, 'new');
  assert.equal(await store.deleteSamlCache(SAML_HELD), null);
  assert.equal(await store.readSamlCache(SAML_COLLISION), 'new');
  const row = [...client.items.values()][0]; assert.equal(row.expires_at, now + 8 * 3600); assert.equal(row.ttl, row.expires_at);
});
test('SAML cache simultaneous consumption returns the assertion request once', async () => {
  const {store} = samlStore(); await store.saveSamlCache(SAML_HELD, 'original');
  const consumed = await Promise.all([store.deleteSamlCache(SAML_HELD), store.deleteSamlCache(SAML_HELD)]);
  assert.deepEqual(consumed.sort(), ['original', null].sort());
  assert.equal(await store.readSamlCache(SAML_HELD), null);
});
test('SAML cache conditional put is one bounded write with unchanged expiry and no scan', async () => {
  const h = harness([['PutCommand', input => {
    assert.deepEqual({pk:input.Item.pk, sk:input.Item.sk}, {pk:'SAML#529', sk:'CACHE'});
    assert.equal(input.ConditionExpression, 'attribute_not_exists(pk) OR expires_at <= :now');
    assert.deepEqual(input.ExpressionAttributeValues, {':now':NOW});
    assert.equal(input.Item.cache_key, SAML_HELD); assert.equal(input.Item.expires_at, NOW + 8 * 3600);
    return {};
  }]]);
  await h.store.saveSamlCache(SAML_HELD, 'value'); h.done();
});
test('SAML cache malformed occupied slots fail closed and nonconditional storage failures propagate', async () => {
  const {store, client} = samlStore(); client.items.set('SAML#529\0CACHE', {pk:'SAML#529', sk:'CACHE', cache_key:SAML_COLLISION});
  await assert.rejects(store.saveSamlCache(SAML_HELD, 'value'), code('sso_request_busy'));
  const unavailable = Object.assign(Error('storage unavailable'), {name:'ProvisionedThroughputExceededException'});
  const h = harness([['PutCommand', unavailable]]);
  await assert.rejects(h.store.saveSamlCache(SAML_HELD, 'value'), e => e === unavailable); h.done();
});
const uniqueTargets = input => {
  const keys = input.TransactItems.map(item => { const op = Object.values(item)[0]; return JSON.stringify(op.Key ?? { pk: op.Item.pk, sk: op.Item.sk }); });
  assert.equal(new Set(keys).size, keys.length, 'DynamoDB cannot operate twice on one item in a transaction');
};

test('numeric verified GitHub subject only, no client-selected tenant claims', async () => {
  const h = harness([]);
  for (const bad of [0, -1, 1.1, '1', 'github-1', Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(h.store.getOrCreateTenant(bad), code('identity_not_verified'));
  h.done();
});
test('account creation atomically caps global accounts and initializes tenant bytes', async () => {
  const h = harness([['GetCommand', {}], ['TransactWriteCommand', input => {
    uniqueTargets(input); assert.equal(input.TransactItems.length, 2);
    const [put, cap] = input.TransactItems;
    assert.equal(put.Put.Item.pk, 'TENANT#github-123'); assert.equal(put.Put.Item.used_bytes, 0);
    assert.equal(put.Put.Item.byte_limit, 10485760); assert.equal(put.Put.ConditionExpression, 'attribute_not_exists(pk)');
    assert.deepEqual(cap.Update.Key, { pk: 'SYS', sk: 'CAPACITY' });
    assert.match(cap.Update.ConditionExpression, /#n < :cap/); assert.equal(cap.Update.ExpressionAttributeValues[':cap'], 100);
    return {};
  }]]);
  assert.equal((await h.store.getOrCreateTenant(123)).tenant_id, 'github-123'); h.done();
});
test('account race recovers existing tenant instead of charging twice', async () => {
  const h = harness([['GetCommand', {}], ['TransactWriteCommand', txError()], ['GetCommand', { Item: { tenant_id: 'github-1' } }]]);
  assert.equal((await h.store.getOrCreateTenant(1)).tenant_id, 'github-1'); h.done();
});
test('OAuth state consumption uses expiry-conditional atomic delete and ALL_OLD', async () => {
  const h = harness([['DeleteCommand', input => {
    assert.deepEqual(input.Key, { pk: `OAUTH#${slot(H)}`, sk: 'STATE' });
    assert.equal(input.ReturnValues, 'ALL_OLD'); assert.match(input.ConditionExpression, /expires_at > :now/);
    assert.equal(input.ExpressionAttributeValues[':now'], NOW); return { Attributes: { verifier: SECRET } };
  }], ['DeleteCommand', conditionError()]]);
  assert.equal(await h.store.consumeOAuthState(H), SECRET); assert.equal(await h.store.consumeOAuthState(H), null); h.done();
});
test('OAuth hash collisions cannot overwrite an existing state', async () => {
  const h = harness([['PutCommand', input => { assert.match(input.ConditionExpression, /attribute_not_exists\(pk\) OR expires_at <= :now/); throw conditionError(); }]]);
  await assert.rejects(h.store.createOAuthState(H, SECRET), code('state_collision')); h.done();
});
test('session writes bind a real tenant and session reads reject TTL-lagged expiry', async () => {
  const h = harness([
    ['GetCommand', { Item: { pk: 'TENANT#github-1', sk: 'META' } }],
    ['TransactWriteCommand', input => {
      uniqueTargets(input); assert.deepEqual(input.TransactItems[0].ConditionCheck.Key, { pk: 'TENANT#github-1', sk: 'META' });
      assert.match(input.TransactItems[0].ConditionCheck.ConditionExpression, /session_epoch/);
      const item = input.TransactItems[1].Put.Item; assert.equal(item.pk, `SESSION#${slot(H)}`); assert.equal(item.tenant_id, 'github-1');
      assert.equal(item.session_epoch, 0); assert.equal(item.ttl, NOW + 86400); return {};
    }],
    ['GetCommand', { Item: { tenant_id: 'github-1', token_hash: H, expires_at: NOW } }],
    ['GetCommand', { Item: { tenant_id: 'github-2', token_hash: H, expires_at: NOW + 1, session_epoch: 0 } }],
    ['GetCommand', {Item:{pk:'TENANT#github-2',sk:'META'}}]
  ]);
  await h.store.createSession(H, 'github-1'); assert.equal(await h.store.getSession(H), null);
  assert.equal((await h.store.getSession(H)).tenant_id, 'github-2'); h.done();
});
test('setup stores requested hash and separate unique human code, never a write-key secret', async () => {
  const h = harness([['TransactWriteCommand', input => {
    uniqueTargets(input); const [request, mapping] = input.TransactItems.map(item => item.Put);
    assert.equal(request.Item.requested_key_hash, H); assert.equal(request.Item.expires_at, NOW + 600);
    assert.match(request.Item.pk, /^SETUP#[0-9]{1,3}$/); assert.match(mapping.Item.pk, /^CODE#[0-9]{1,3}$/);
    assert.match(request.ConditionExpression, /attribute_not_exists\(pk\) OR expires_at <= :now/); assert.match(mapping.ConditionExpression, /expires_at <= :now/);
    assert.equal('token' in request.Item, false); return {};
  }]]);
  const result = await h.store.createSetup(H); assert.match(result.device_secret, /^[A-Za-z0-9_-]{43}$/); assert.equal(result.user_code.length, 12); h.done();
});
const mapping = { user_code: 'abcdefghijkl', secret_hash: H2, expires_at: NOW + 600 };
const pending = { secret_hash: H2, requested_key_hash: H, expires_at: NOW + 600 };
// Approval reads the account row for its plan (one consistent Get), then the lease slots (one bounded Query).
const accountRow = plan_id => ['GetCommand', input => { assert.deepEqual(input.Key, { pk: 'TENANT#github-1', sk: 'META' }); assert.equal(input.ConsistentRead, true); return { Item: { pk: 'TENANT#github-1', sk: 'META', tenant_id: 'github-1', ...(plan_id ? { plan_id } : {}) } }; }];
const liveSlots = count => Array.from({ length: count }, (_, i) => ({ sk: `SLOT#${String(i).padStart(3, '0')}`, expires_at: NOW + 1 }));
const KEY_CEILING = Math.max(...PLANS.plans.map(plan => plan.api_keys));
test('approval atomically claims expiring fixed key slot and binds both key indexes to authenticated tenant', async () => {
  const h = harness([['GetCommand', { Item: mapping }], ['GetCommand', { Item: pending }], accountRow(),
    ['QueryCommand', input => { assert.equal(input.ConsistentRead, true); assert.equal(input.Limit, KEY_CEILING); assert.equal(input.ExpressionAttributeValues[':pk'], 'TENANT#github-1'); return { Items: [{ sk: 'SLOT#000', expires_at: NOW }] }; }],
    ['TransactWriteCommand', input => {
      uniqueTargets(input); assert.equal(input.TransactItems.length, 5);
      const update = input.TransactItems[1].Update; assert.match(update.ConditionExpression, /attribute_not_exists\(tenant_id\)/);
      assert.match(update.ConditionExpression, /expires_at > :now/); assert.equal(update.ExpressionAttributeValues[':tenant'], 'github-1');
      assert.equal(input.TransactItems[2].Put.Item.pk, `WRITE#${H}`); assert.equal(input.TransactItems[2].Put.Item.tenant_id, 'github-1');
      assert.equal(input.TransactItems[3].Put.Item.pk, 'TENANT#github-1'); assert.equal(input.TransactItems[3].Put.Item.sk, `KEY#${H}`);
      const lease = input.TransactItems[4].Put; assert.equal(lease.Item.sk, 'SLOT#000'); assert.match(lease.ConditionExpression, /expires_at <= :now/);
      return {};
    }]]);
  assert.equal((await h.store.approveSetup('github-1', 'abcdefghijkl')).approved, true); h.done();
});
test('approval is repeatable status, not credential reissuance, and cannot move tenants', async () => {
  const approved = { ...pending, tenant_id: 'github-1', key_expires_at: NOW + 500 };
  const h = harness([['GetCommand', { Item: mapping }], ['GetCommand', { Item: approved }], ['GetCommand', { Item: mapping }], ['GetCommand', { Item: approved }]]);
  assert.equal((await h.store.approveSetup('github-1', 'abcdefghijkl')).expires_in, 500);
  await assert.rejects(h.store.approveSetup('github-2', 'abcdefghijkl'), code('code_unavailable')); h.done();
});
test('live slots at the plan count prevent approval with the plan refusal, without table scans or extra writes', async () => {
  const free = planLimits('free').api_keys, base = planLimits('base').api_keys; assert.ok(base > free);
  // No plan on the row, Free, and an unknown plan id all get the Free count.
  for (const plan of [undefined, 'free', 'platinum']) {
    const h = harness([['GetCommand', { Item: mapping }], ['GetCommand', { Item: pending }], accountRow(plan), ['QueryCommand', { Items: liveSlots(free) }]]);
    await assert.rejects(h.store.approveSetup('github-1', 'abcdefghijkl'), error => {
      assert.equal(error.status, 402); assert.equal(error.code, 'plan_limit_reached');
      const { message, ...details } = error.details; assert.deepEqual(details, { limit_name: 'api_keys', plan: 'free', limit: free, used: free, required_plan: 'base', upgrade_url: UPGRADE_PATH });
      assert.ok(message.includes(String(free)) && message.includes(String(base)), message); return true;
    }); h.done();
  }
  // The same slots on a higher plan leave room: the next free slot is claimed in one transaction.
  const paid = harness([['GetCommand', { Item: mapping }], ['GetCommand', { Item: pending }], accountRow('base'), ['QueryCommand', { Items: liveSlots(free) }],
    ['TransactWriteCommand', input => { assert.equal(input.TransactItems[4].Put.Item.sk, `SLOT#${String(free).padStart(3, '0')}`); return {}; }]]);
  assert.equal((await paid.store.approveSetup('github-1', 'abcdefghijkl')).approved, true); paid.done();
  // An expired slot does not count toward the plan and is the one reused.
  const lapsed = harness([['GetCommand', { Item: mapping }], ['GetCommand', { Item: pending }], accountRow(), ['QueryCommand', { Items: [{ sk: 'SLOT#000', expires_at: NOW }, ...liveSlots(free).slice(1)] }],
    ['TransactWriteCommand', input => { assert.equal(input.TransactItems[4].Put.Item.sk, 'SLOT#000'); return {}; }]]);
  assert.equal((await lapsed.store.approveSetup('github-1', 'abcdefghijkl')).approved, true); lapsed.done();
  // The top plan stops at its own count too, and has no plan to point at.
  const top = PLANS.plans.at(-1), full = harness([['GetCommand', { Item: mapping }], ['GetCommand', { Item: pending }], accountRow(top.id), ['QueryCommand', { Items: liveSlots(top.api_keys) }]]);
  await assert.rejects(full.store.approveSetup('github-1', 'abcdefghijkl'), error => error.status === 402 && error.code === 'plan_limit_reached' && error.details.limit === top.api_keys && !('required_plan' in error.details)); full.done();
});
test('the hard slot ceiling still prevents approval below a plan count, without table scans or extra writes', async () => {
  const ceiling = 3; assert.ok(planLimits('base').api_keys > ceiling);
  const h = harness([['GetCommand', { Item: mapping }], ['GetCommand', { Item: pending }], accountRow('base'),
    ['QueryCommand', input => { assert.equal(input.Limit, ceiling); return { Items: liveSlots(ceiling) }; }]], { activeKeys: ceiling });
  await assert.rejects(h.store.approveSetup('github-1', 'abcdefghijkl'), error => error.status === 409 && error.code === 'active_key_capacity' && error.details === undefined); h.done();
  assert.equal(harness([]).store.limits.activeKeys, KEY_CEILING);
});
test('poll rejects expired records even before TTL deletion', async () => {
  const h = harness([['GetCommand', input => { assert.equal(input.Key.pk, `SETUP#${slot(digest(SECRET))}`); return { Item: { ...pending, expires_at: NOW } }; }]]);
  await assert.rejects(h.store.pollSetup(SECRET), code('setup_expired')); h.done();
});
test('write authentication derives tenant from stored live key only', async () => {
  const row = { token_hash: H, tenant_id: 'github-2', scope: 'write', expires_at: NOW + 1, revoked: false };
  const h = harness([['GetCommand', { Item: row }], ['GetCommand', { Item: { ...row, expires_at: NOW } }], ['GetCommand', { Item: { ...row, revoked: true } }]]);
  assert.equal((await h.store.lookupWriteKey(H)).tenant_id, 'github-2'); assert.equal(await h.store.lookupWriteKey(H), null); assert.equal(await h.store.lookupWriteKey(H), null); h.done();
});
test('key revocation refuses a different tenant before any write', async () => {
  const h = harness([['GetCommand', { Item: { tenant_id: 'github-2', revoked: false } }]]);
  await assert.rejects(h.store.revokeWriteKey('github-1', H), code('key_not_found')); h.done();
});
test('revoking an expired old key cannot delete a reassigned key lease', async () => {
  const h = harness([['GetCommand', { Item: { tenant_id: 'github-1', revoked: false, slot: 0 } }],
    ['GetCommand', { Item: { token_hash: H2 } }], ['TransactWriteCommand', input => {
      uniqueTargets(input); assert.equal(input.TransactItems.length, 2);
      for (const operation of input.TransactItems) assert.match(operation.Update.ConditionExpression, /tenant_id = :tenant AND revoked = :no/);
      return {};
    }]]);
  assert.deepEqual(await h.store.revokeWriteKey('github-1', H), { revoked: true }); h.done();
});
const batch = { batch_id: 'batch1', run_id: 'run1', request_hash: H, byte_count: 300, event_count: 2 };
const reservation = { ...batch, pk: 'TENANT#github-1', sk: 'BATCH#batch1', tenant_id: 'github-1', status: 'pending', created_at: NOW, object_key: `v1/${digest('github-1')}/${H}.json` };
test('reservation transaction enforces durable tenant+batch idempotency and tenant/global byte caps', async () => {
  const h = harness([['GetCommand', {}], ['GetCommand', { Item: { pk: 'TENANT#github-1', sk: 'META', byte_limit: 10485760, used_bytes: 0, created_at: NOW } }], ['GetCommand', input => { assert.deepEqual(input.Key, { pk: 'TENANT#github-1', sk: 'USAGE#' + usagePeriod(NOW).id }); return {}; }], ['TransactWriteCommand', input => {
    uniqueTargets(input); const [marker, tenantCap, monthly, globalCap] = input.TransactItems;
    assert.equal(marker.Put.Item.pk, 'TENANT#github-1'); assert.equal(marker.Put.Item.sk, 'BATCH#batch1');
    assert.equal(marker.Put.Item.status, 'pending'); assert.equal(marker.Put.ConditionExpression, 'attribute_not_exists(pk)');
    assert.equal('upload_seq' in marker.Put.Item, false);
    assert.match(tenantCap.Update.ConditionExpression, /attribute_exists\(pk\).*used_bytes <= :remaining/);
    // The per-account stored-byte limit is the Free plan allowance, no longer the 10 MiB lifetime cap.
    assert.equal(tenantCap.Update.ExpressionAttributeValues[':remaining'], PLAN_LIMITS.plans.free.stored_bytes - 300);
    assert.match(tenantCap.Update.ConditionExpression, /byte_limit > :zero.*attribute_not_exists\(plan_id\) AND attribute_not_exists\(spend_cap\)$/);
    assert.deepEqual(monthly.Update.Key, { pk: 'TENANT#github-1', sk: 'USAGE#' + usagePeriod(NOW).id });
    assert.match(monthly.Update.UpdateExpression, /ADD spans :spans, bytes :bytes/);
    assert.equal(monthly.Update.ConditionExpression, 'attribute_not_exists(spans) OR spans <= :room');
    assert.equal(monthly.Update.ExpressionAttributeValues[':room'], PLAN_LIMITS.plans.free.spans_per_month - 2);
    assert.equal(globalCap.Update.ExpressionAttributeValues[':remaining'], 104857600 - 300);
    assert.deepEqual(globalCap.Update.Key, { pk: 'SYS', sk: 'CAPACITY' }); assert.match(globalCap.Update.UpdateExpression, /ADD used_bytes/);
    assert.equal('events' in marker.Put.Item, false); return {};
  }]]);
  assert.equal((await h.store.reserveBatch('github-1', batch)).object_key, reservation.object_key); h.done();
});
test('same batch ID belongs to different tenant partition, never a global request body claim', async () => {
  const h = harness([['GetCommand', input => { assert.equal(input.Key.pk, 'TENANT#github-2'); return {}; }], ['GetCommand', {}], ['TransactWriteCommand', input => {
    assert.equal(input.TransactItems[0].Put.Item.object_key, `v1/${digest('github-2')}/${H}.json`); return {};
  }]]);
  await h.store.reserveBatch('github-2', batch); h.done();
});
test('identical retry is read-only, modified batch metadata conflicts', async () => {
  const h = harness([['GetCommand', { Item: reservation }], ['GetCommand', { Item: reservation }]]);
  assert.equal((await h.store.reserveBatch('github-1', batch)).status, 'pending');
  await assert.rejects(h.store.reserveBatch('github-1', { ...batch, request_hash: H2 }), code('idempotency_conflict')); h.done();
});
test('reservation conflict recovers durable marker without a second counter update', async () => {
  const h = harness([['GetCommand', {}], ['GetCommand', {}], ['TransactWriteCommand', txError()], ['GetCommand', { Item: reservation }]]);
  assert.equal((await h.store.reserveBatch('github-1', batch)).request_hash, H); h.done();
});
test('known quota failure with no marker fails closed', async () => {
  const h = harness([['GetCommand', {}], ['GetCommand', {}], ['TransactWriteCommand', txError()], ['GetCommand', {}], ['GetCommand', {}]]);
  await assert.rejects(h.store.reserveBatch('github-1', batch), code('storage_capacity_or_unknown_tenant')); h.done();
});
test('acceptance assigns upload order and creates the visible index without charging bytes again', async () => {
  const h = harness([['GetCommand', { Item: reservation }], ['GetCommand', { Item: { pk: 'TENANT#github-1', sk: 'META' } }], ['GetCommand', input => { assert.deepEqual(input.Key, { pk: 'TENANT#github-1', sk: 'RUN#run1' }); return {}; }], ['TransactWriteCommand', input => {
    uniqueTargets(input); assert.equal(input.TransactItems.length, 5);
    const [marker, run, index, sequence, accepted] = input.TransactItems;
    assert.deepEqual(accepted.Update.Key, { pk: 'TENANT#github-1', sk: 'USAGE#' + usagePeriod(NOW).id }); assert.equal(accepted.Update.UpdateExpression, 'ADD accepted_spans :spans, accepted_bytes :bytes, accepted_batches :one');
    assert.deepEqual(accepted.Update.ExpressionAttributeValues, { ':spans': 2, ':bytes': 300, ':one': 1 });
    assert.match(marker.Update.ConditionExpression, /tenant_id = :tenant AND request_hash = :hash AND #status = :pending/);
    assert.match(marker.Update.ConditionExpression, /attribute_not_exists\(upload_seq\)/);
    assert.equal(marker.Update.ExpressionAttributeValues[':seq'], 1);
    assert.equal(run.Update.Key.pk, 'TENANT#github-1'); assert.equal(run.Update.Key.sk, 'RUN#run1');
    assert.equal(index.Put.Item.pk, 'TENANT#github-1#RUN#run1'); assert.equal(index.Put.Item.sk, 'BATCH#~0000000001#batch1');
    assert.equal(index.Put.Item.upload_seq, 1); assert.equal(index.Put.Item.object_key, reservation.object_key);
    assert.equal(index.Put.ConditionExpression, 'attribute_not_exists(pk)');
    assert.equal(sequence.Update.ExpressionAttributeValues[':prev'], 0);
    assert.equal(sequence.Update.ExpressionAttributeValues[':seq'], 1);
    assert.match(sequence.Update.ConditionExpression, /upload_seq = :prev/);
    assert.equal(JSON.stringify(input).includes('used_bytes'), false); return {};
  }], ['GetCommand', { Item: { ...reservation, status: 'accepted', upload_seq: 1 } }]]);
  assert.equal((await h.store.acceptReservedBatch('github-1', 'batch1', H)).accepted, true);
  assert.equal((await h.store.acceptReservedBatch('github-1', 'batch1', H)).accepted, true); h.done();
});
test('run/event pagination consistently scopes exact tenant and rejects foreign cursors before a request', async () => {
  const key = { pk: 'TENANT#github-1#RUN#run1', sk: 'BATCH#batch1' };
  const h = harness([['QueryCommand', input => {
    assert.equal(input.ConsistentRead, true); assert.equal(input.ExpressionAttributeValues[':pk'], key.pk);
    assert.equal(input.ExpressionAttributeValues[':prefix'], 'BATCH#'); assert.equal(input.Limit, 1);
    return { Items: [reservation], LastEvaluatedKey: key };
  }], ['QueryCommand', input => { assert.deepEqual(input.ExclusiveStartKey, key); return {}; }]]);
  const first = await h.store.listAcceptedBatchIndexes('github-1', 'run1', { limit: 1 });
  await h.store.listAcceptedBatchIndexes('github-1', 'run1', { cursor: first.next });
  await assert.rejects(h.store.listAcceptedBatchIndexes('github-2', 'run1', { cursor: first.next }), code('invalid_cursor'));
  await assert.rejects(h.store.listAcceptedBatchIndexes('github-1', 'run2', { cursor: first.next }), code('invalid_cursor')); h.done();
});
test('cooldown reservations are atomic and a stale release cannot delete a newer reservation', async () => {
  let now = NOW;
  const {store} = samlStore(() => now);
  const input = {scope: 'linkresend', identity: digest('synthetic@example.com'), limit: 1, windowSeconds: 60, cooldown: true};
  const attempts = await Promise.all([store.consumeRate(input), store.consumeRate(input)]);
  assert.equal(attempts.filter(rate => rate.allowed).length, 1);
  const first = attempts.find(rate => rate.allowed);
  assert.equal(attempts.find(rate => !rate.allowed).pending, true);
  await first.complete();
  const duplicate = await store.consumeRate(input);
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.pending, false);
  await first.release();
  const second = await store.consumeRate(input); assert.equal(second.allowed, true);
  await assert.rejects(first.complete());
  assert.equal((await store.consumeRate(input)).pending, true);
  await first.release(); assert.equal((await store.consumeRate(input)).allowed, false);
  now += 59; assert.equal((await store.consumeRate(input)).allowed, false);
  now++; assert.equal((await store.consumeRate(input)).allowed, true);
  await second.release(); assert.equal((await store.consumeRate(input)).allowed, false);
});

test('rate cardinality is bounded, hit increments conditional and live hash collisions fail closed', async () => {
  let rateKey;
  const h = harness([['PutCommand', input => {
    rateKey = input.Item.pk; assert.match(rateKey, /^RATE#[0-9]+$/); assert.ok(Number(rateKey.slice(5)) < 5);
    assert.match(input.ConditionExpression, /expires_at <= :now/); assert.equal(JSON.stringify(input).includes('sensitive-ip'), false);
    throw conditionError();
  }], ['UpdateCommand', input => {
    assert.equal(input.Key.pk, rateKey); assert.match(input.ConditionExpression, /#bucket = :bucket AND expires_at > :now AND hits < :limit/);
    assert.equal(input.ExpressionAttributeValues[':limit'], 2); assert.equal(input.UpdateExpression, 'ADD hits :one'); throw conditionError();
  }]], { rateSlots: 5 });
  assert.equal((await h.store.consumeRate({ scope: 'ip', identity: 'sensitive-ip', limit: 2 })).allowed, false); h.done();
});
test('rate first hit and conditional next hit return bounded counts', async () => {
  const h = harness([['PutCommand', {}], ['PutCommand', conditionError()], ['UpdateCommand', { Attributes: { hits: 2 } }]]);
  assert.equal((await h.store.consumeRate({ scope: 'tenant', identity: 'github-1', limit: 2 })).hits, 1);
  assert.equal((await h.store.consumeRate({ scope: 'tenant', identity: 'github-1', limit: 2 })).hits, 2); h.done();
});

test('OAuth/session/setup records use only 1000 physical slots per namespace, independently of TTL', async () => {
  const h = harness([
    ['PutCommand', input => { assert.equal(input.Item.pk, `OAUTH#${slot(H)}`); assert.equal(input.Item.state_hash, H); assert.match(input.ConditionExpression, /expires_at <= :now/); return {}; }],
    ['GetCommand', { Item: { pk: 'TENANT#github-1', sk: 'META' } }],
    ['TransactWriteCommand', input => { const item = input.TransactItems[1].Put.Item; assert.equal(item.pk, `SESSION#${slot(H)}`); assert.equal(item.token_hash, H); assert.equal(item.session_epoch, 0); return {}; }],
    ['TransactWriteCommand', input => { for (const item of input.TransactItems.map(op => op.Put.Item)) assert.ok(Number(item.pk.split('#')[1]) < 1000); return {}; }]
  ]);
  await h.store.createOAuthState(H, SECRET); await h.store.createSession(H, 'github-1'); await h.store.createSetup(H); h.done();
});
test('fixed-slot OAuth consumption binds full hash, not merely the hash slot', async () => {
  const h = harness([['DeleteCommand', input => {
    assert.match(input.ConditionExpression, /state_hash = :hash AND expires_at > :now/);
    assert.equal(input.ExpressionAttributeValues[':hash'], H); throw conditionError();
  }]]);
  assert.equal(await h.store.consumeOAuthState(H), null); h.done();
});
test('session collision cannot authenticate or delete another full-hash token', async () => {
  const h = harness([['GetCommand', { Item: { token_hash: H2, tenant_id: 'github-2', expires_at: NOW + 1 } }],
    ['DeleteCommand', input => { assert.equal(input.ConditionExpression, 'token_hash = :hash'); assert.equal(input.ExpressionAttributeValues[':hash'], H); throw conditionError(); }]]);
  assert.equal(await h.store.getSession(H), null); await h.store.deleteSession(H); h.done();
});
test('validly formatted but colliding user code cannot approve someone else’s setup', async () => {
  const h = harness([['GetCommand', { Item: { ...mapping, user_code: '000000000000' } }]]);
  await assert.rejects(h.store.approveSetup('github-1', 'abcdefghijkl'), code('setup_expired')); h.done();
});
test('setup full secret hash is checked when fixed slot was reused', async () => {
  const h = harness([['GetCommand', { Item: mapping }], ['GetCommand', { Item: { ...pending, secret_hash: H } }]]);
  await assert.rejects(h.store.approveSetup('github-1', 'abcdefghijkl'), code('setup_expired')); h.done();
});
