import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DynamoMetadataStore} from '../src/dynamodb-store.mjs';
import {MemoryDynamo, commandClasses} from './memory-dynamo.mjs';
import {reportUsagePeriod, createUsageMeterWorker, RESEND_WINDOW_SECONDS} from '../src/stripe-usage-meter.mjs';
import {buildStripeSandboxRuntime} from '../src/stripe-runtime.mjs';
import {start} from './harness.mjs';
import {configureLocalBilling, configuration} from '../scripts/local-billing.mjs';
import {seedLocalWorkspace} from '../scripts/dev.mjs';
import {usagePeriod} from '../src/plan-limits.mjs';
import {validateUsage} from '../public/app/usage-data.js';

const tenant = 'github-7', merchant = 'acct_synthetic', customer = 'cus_seven', NOV = Date.UTC(2026, 10, 14, 12) / 1000, DEC = Date.UTC(2026, 11, 1) / 1000, EVENT = 'supatrace_spans';
const sha = value => createHash('sha256').update(value).digest('hex'), code = expected => error => error.code === expected;
// A fake Stripe client: only billing.meterEvents.create exists, and it records every call.
function fakeStripe({duplicates = 'reject', livemode = false} = {}) {
  const events = new Map(), calls = []; let failNext = null;
  const client = {billing: {meterEvents: {create: async (params, options) => {
    calls.push({params: structuredClone(params), options});
    if (failNext) { const error = failNext; failNext = null; throw error; }
    if (events.has(params.identifier)) { if (duplicates === 'reject') throw Object.assign(new Error('An event already exists with this identifier.'), {statusCode: 400, type: 'StripeInvalidRequestError'}); return events.get(params.identifier); }
    const event = {object: 'billing.meter_event', identifier: params.identifier, event_name: params.event_name, livemode, payload: params.payload, timestamp: params.timestamp};
    events.set(params.identifier, event); return event;
  }}}};
  return {client, events, calls, fail: error => failNext = error, total: () => [...events.values()].reduce((sum, e) => sum + Number(e.payload.value), 0)};
}
async function fixture(stripeOptions) {
  let now = NOV; const dynamo = new MemoryDynamo(), stripe = fakeStripe(stripeOptions), actions = [];
  const store = new DynamoMetadataStore({client: dynamo, commands: commandClasses(), tableName: 'synthetic', stripeTestInbox: true, stripeTestEnvironment: 'synthetic-dev', now: () => now});
  await store.getOrCreateTenant(7); await store.bindStripeTestCustomer(tenant, {merchant_id: merchant, customer_id: customer});
  const stripeBilling = {enabled: true, mode: 'isolated_sandbox', purchasesEnabled: false, catalog: {livemode: false, merchant_id: merchant, environment_id: 'synthetic-dev', api_version: '2026-10-28.endive'}, client: stripe.client, authorize: async action => { actions.push(action); return action.action === 'usage.report'; }};
  const env = {stripeBilling, store};
  const reserve = (id, spans, who = tenant) => store.reserveBatch(who, {batch_id: id, run_id: 'run1', request_hash: sha(id), byte_count: 100, event_count: spans});
  // Reserve and accept, the way a completed POST /api/batches does.
  const upload = async (id, spans, who = tenant) => { const row = await reserve(id, spans, who); await store.acceptReservedBatch(who, id, sha(id), null); return row; };
  const report = (period = usagePeriod(now).id, who = tenant) => reportUsagePeriod(env, who, period, {eventName: EVENT});
  const state = (period = '2026-11') => dynamo.items.get('TENANT#' + tenant + '\0METER#' + period);
  return {store, dynamo, stripe, env, actions, upload, reserve, report, state, at: value => now = value};
}

test('the meter total equals accepted spans; replayed batches and repeated reports add nothing', async () => {
  const f = await fixture(); await f.upload('a', 40); await f.upload('b', 60);
  const first = await f.report(); assert.deepEqual([first.status, first.value, first.period], ['reported', 100, '2026-11']);
  assert.equal(f.stripe.total(), 100); assert.equal(f.stripe.calls.length, 1);
  const sent = f.stripe.calls[0];
  assert.deepEqual(sent.params, {event_name: EVENT, payload: {stripe_customer_id: customer, value: '100'}, identifier: first.identifier, timestamp: NOV});
  assert.match(first.identifier, /^supatrace-usage-[a-f0-9]{48}$/); assert.deepEqual(sent.options, {apiVersion: '2026-10-28.endive', maxNetworkRetries: 0, timeout: 10000});
  // Replaying the same batch is read-only, so there is nothing new to report.
  await f.upload('a', 40); await f.upload('b', 60);
  assert.deepEqual(await f.report(), {status: 'up_to_date'}); assert.deepEqual(await f.report(), {status: 'up_to_date'}); assert.equal(f.stripe.calls.length, 1);
  await f.upload('c', 7); const second = await f.report(); assert.equal(second.value, 7); assert.notEqual(second.identifier, first.identifier);
  assert.equal(f.stripe.total(), 107); assert.equal((await f.store.getPlanUsage(tenant)).accepted_spans, 107);
  assert.deepEqual([f.state().reported_spans, f.state().pending, f.state().seq, f.state().hold], [107, null, 2, false]);
});

test('a reservation whose upload never finished counts toward the allowance but is never reported', async () => {
  const f = await fixture(); await f.upload('done', 10); await f.reserve('abandoned', 25);
  const usage = await f.store.getPlanUsage(tenant); assert.deepEqual([usage.spans_used, usage.accepted_spans, usage.accepted_batches, usage.accepted_bytes], [35, 10, 1, 100]);
  assert.equal((await f.report()).value, 10); assert.equal(f.stripe.total(), 10);
  // Completing it later reports it once; accepting again changes nothing.
  await f.store.acceptReservedBatch(tenant, 'abandoned', sha('abandoned'), null); await f.store.acceptReservedBatch(tenant, 'abandoned', sha('abandoned'), null);
  assert.equal((await f.report()).value, 25); assert.equal(f.stripe.total(), 35); assert.deepEqual(await f.report(), {status: 'up_to_date'});
  // A batch reserved in November and accepted in December is metered in November, where its reservation was counted.
  await f.reserve('late', 4); f.at(DEC + 60); await f.store.acceptReservedBatch(tenant, 'late', sha('late'), null);
  const meters = await f.store.getUsageMeters(tenant); assert.deepEqual(meters.current, {period: '2026-12', reserved_spans: 0, accepted_spans: 0, reserved_bytes: 0, accepted_bytes: 0, accepted_batches: 0});
  assert.deepEqual(meters.history, [{period: '2026-11', reserved_spans: 39, accepted_spans: 39, reserved_bytes: 300, accepted_bytes: 300, accepted_batches: 3}]);
  // Commercially enrolled accounts are outside the plan meters.
  f.dynamo.items.get('TENANT#' + tenant + '\0META').commercial_managed = true; const before = structuredClone(f.dynamo.items.get('TENANT#' + tenant + '\0USAGE#2026-12') ?? null);
  await f.dynamo.items.set('TENANT#' + tenant + '\0BATCH#enrolled', {pk: 'TENANT#' + tenant, sk: 'BATCH#enrolled', tenant_id: tenant, batch_id: 'enrolled', run_id: 'run1', request_hash: sha('enrolled'), byte_count: 100, event_count: 9, status: 'pending', created_at: DEC + 60, object_key: 'v1/x/y.json'});
  await f.store.acceptReservedBatch(tenant, 'enrolled', sha('enrolled'), null); assert.deepEqual(f.dynamo.items.get('TENANT#' + tenant + '\0USAGE#2026-12') ?? null, before);
});

test('a reservation that straddles the month boundary is reserved and accepted in one month', async () => {
  // A clock that passes midnight UTC after its first read: any second read inside reserveBatch would land in December.
  let ticks = 0; const dynamo = new MemoryDynamo(), store = new DynamoMetadataStore({client: dynamo, commands: commandClasses(), tableName: 'synthetic', now: () => DEC - 1});
  await store.getOrCreateTenant(7); store.now = () => ticks++ === 0 ? DEC - 1 : DEC + 5;
  const row = await store.reserveBatch(tenant, {batch_id: 'edge', run_id: 'run1', request_hash: sha('edge'), byte_count: 100, event_count: 2});
  assert.deepEqual([row.created_at, row.usage_period], [DEC - 1, '2026-11']);
  // The reservation reads the clock once; that single instant picks the month.
  assert.equal(ticks, 1);
  await store.acceptReservedBatch(tenant, 'edge', sha('edge'), null);
  const nov = dynamo.items.get('TENANT#' + tenant + '\0USAGE#2026-11'); assert.deepEqual([nov.spans, nov.accepted_spans, nov.period], [2, 2, '2026-11']);
  assert.equal(dynamo.items.has('TENANT#' + tenant + '\0USAGE#2026-12'), false);
  // A marker written before the month was recorded on it falls back to its created_at month.
  const f = await fixture(); await f.reserve('old', 3); delete f.dynamo.items.get('TENANT#' + tenant + '\0BATCH#old').usage_period; f.at(DEC + 60);
  await f.store.acceptReservedBatch(tenant, 'old', sha('old'), null); assert.equal(f.dynamo.items.get('TENANT#' + tenant + '\0USAGE#2026-11').accepted_spans, 3);
});

test('each calendar month is metered and reported on its own', async () => {
  const f = await fixture(); await f.upload('nov', 30); f.at(DEC + 3600); await f.upload('dec', 5);
  const late = await f.report('2026-11'); assert.equal(late.value, 30);
  // A report sent after the month ended is stamped inside that month.
  assert.equal(f.stripe.calls[0].params.timestamp, DEC - 1);
  assert.equal((await f.report('2026-12')).value, 5); assert.equal(f.stripe.calls[1].params.timestamp, DEC + 3600);
  const meters = await f.store.getUsageMeters(tenant);
  assert.deepEqual(meters, {current: {period: '2026-12', reserved_spans: 5, accepted_spans: 5, reserved_bytes: 100, accepted_bytes: 100, accepted_batches: 1}, history: [{period: '2026-11', reserved_spans: 30, accepted_spans: 30, reserved_bytes: 100, accepted_bytes: 100, accepted_batches: 1}], reporting: {status: 'reported', reported_spans: 5}});
  // The caller's period wins, so a month rollover between two reads cannot list the current month as history.
  assert.deepEqual((await f.store.getUsageMeters(tenant, '2026-11')).history, []); await assert.rejects(f.store.getUsageMeters(tenant, '2026-13'), code('invalid_usage_period'));
});

test('a crash between Stripe accepting an event and the local commit resends the same identifier, never a new one', async () => {
  for (const duplicates of ['return', 'reject']) {
    const f = await fixture({duplicates}); await f.upload('a', 50);
    const finish = f.store.finishUsageMeterReport.bind(f.store); f.store.finishUsageMeterReport = async () => { throw new Error('process died'); };
    await assert.rejects(f.report(), /process died/); f.store.finishUsageMeterReport = finish;
    assert.equal(f.stripe.total(), 50); assert.equal(f.state().pending.value, 50); assert.equal(f.state().reported_spans, 0);
    await f.upload('b', 9);
    const retry = await f.report(); assert.equal(f.stripe.calls.length, 2);
    // The retry carries the stored identifier and the stored value, not the spans that arrived meanwhile.
    assert.deepEqual(f.stripe.calls[1].params, f.stripe.calls[0].params); assert.equal(f.stripe.total(), 50);
    if (duplicates === 'return') {
      assert.equal(retry.status, 'reported'); assert.equal((await f.report()).value, 9); assert.equal(f.stripe.total(), 59);
    } else {
      // Stripe refused the resent identifier: hold the month for reconciliation and send nothing more for it.
      assert.deepEqual(retry, {status: 'held'}); assert.equal(f.state().hold, true);
      await assert.rejects(f.report(), code('usage_meter_hold')); assert.equal(f.stripe.calls.length, 2); assert.equal(f.stripe.total(), 50);
      assert.equal((await f.store.getUsageMeters(tenant)).reporting.status, 'held');
    }
  }
});

test('a stored intent older than the resend window is held, because Stripe may no longer deduplicate it', async () => {
  // Fake Stripe whose identifier memory expires, like the real rolling window.
  for (const [age, held] of [[RESEND_WINDOW_SECONDS - 1, false], [RESEND_WINDOW_SECONDS, true], [3 * 86400, true], [-5, true]]) {
    const f = await fixture({duplicates: 'return'}); await f.upload('a', 10);
    const finish = f.store.finishUsageMeterReport.bind(f.store); f.store.finishUsageMeterReport = async () => { throw new Error('process died'); };
    await assert.rejects(f.report('2026-11'), /process died/); f.store.finishUsageMeterReport = finish;
    f.stripe.events.clear(); f.at(NOV + age);
    const retry = await f.report('2026-11');
    if (held) { assert.deepEqual(retry, {status: 'held'}); assert.equal(f.stripe.calls.length, 1); assert.equal(f.stripe.total(), 0); await assert.rejects(f.report('2026-11'), code('usage_meter_hold')); }
    else { assert.equal(retry.status, 'reported'); assert.equal(f.stripe.calls.length, 2); }
  }
  assert.equal(RESEND_WINDOW_SECONDS <= 12 * 3600, true);
});

test('a Stripe failure leaves the intent pending and the next attempt reuses it', async () => {
  for (const error of [Object.assign(new Error('down'), {statusCode: 500}), Object.assign(new Error('slow down'), {statusCode: 429}), new Error('socket hang up')]) {
    const f = await fixture(); await f.upload('a', 12); f.stripe.fail(error);
    await assert.rejects(f.report(), code('usage_meter_unavailable'));
    assert.equal(f.stripe.total(), 0); assert.equal((await f.store.getUsageMeters(tenant)).reporting.status, 'pending');
    const retry = await f.report(); assert.equal(retry.status, 'reported'); assert.equal(retry.identifier, f.stripe.calls[0].params.identifier); assert.equal(f.stripe.total(), 12);
  }
});

test('a response that is not a test-mode echo of the request holds the month', async () => {
  const f = await fixture({livemode: true}); await f.upload('a', 3);
  await assert.rejects(f.report(), code('usage_meter_response_mismatch')); assert.equal(f.state().hold, true);
  await assert.rejects(f.report(), code('usage_meter_hold')); assert.equal(f.stripe.calls.length, 1);
});

test('nothing is sent without a sandbox runtime, an authorization, a bound test Customer or valid input', async () => {
  const f = await fixture(); await f.upload('a', 3);
  for (const mutate of [b => b.enabled = false, b => b.mode = 'live', b => b.purchasesEnabled = true, b => b.catalog.livemode = true, b => b.client = {}, b => b.authorize = null]) {
    const stripeBilling = {...f.env.stripeBilling, catalog: {...f.env.stripeBilling.catalog}}; mutate(stripeBilling);
    await assert.rejects(reportUsagePeriod({stripeBilling, store: f.store}, tenant, '2026-11', {eventName: EVENT}), code('usage_meter_disabled'));
  }
  await assert.rejects(reportUsagePeriod({store: f.store}, tenant, '2026-11', {eventName: EVENT}), code('usage_meter_disabled'));
  await assert.rejects(reportUsagePeriod({...f.env, stripeBilling: {...f.env.stripeBilling, authorize: async () => false}}, tenant, '2026-11', {eventName: EVENT}), code('usage_meter_authorization_required'));
  for (const [who, period, name] of [['github-0', '2026-11', EVENT], [tenant, '2026-13', EVENT], [tenant, '2026-11', 'Bad Name'], [tenant, '2026-11', undefined]]) await assert.rejects(reportUsagePeriod(f.env, who, period, {eventName: name}), code('usage_meter_request_invalid'));
  await f.store.getOrCreateTenant(8); await f.upload('other', 4, 'github-8');
  assert.deepEqual(await f.report('2026-11', 'github-8'), {status: 'no_customer'});
  assert.equal(f.stripe.calls.length, 0); assert.equal(f.state(), undefined);
  assert.deepEqual(f.actions.at(-1), {action: 'usage.report', tenant_id: 'github-8', merchant_id: merchant, environment_id: 'synthetic-dev', livemode: false});
});

test('two workers reporting the same month cannot both send', async () => {
  const f = await fixture(); await f.upload('a', 20);
  const binding = {merchant_id: merchant, customer_id: customer}, results = await Promise.allSettled([f.store.beginUsageMeterReport(tenant, '2026-11', binding), f.store.beginUsageMeterReport(tenant, '2026-11', binding)]);
  const won = results.filter(r => r.status === 'fulfilled' && r.value && !r.value.resumed); assert.equal(won.length, 1);
  // Whatever the loser saw, it holds the same stored intent or a conflict, never a second identifier.
  for (const r of results) if (r.status === 'fulfilled') assert.equal(r.value.identifier, won[0].value.identifier); else assert.equal(r.reason.code, 'usage_meter_report_conflict');
  await f.store.finishUsageMeterReport(tenant, '2026-11', won[0].value);
  await assert.rejects(f.store.finishUsageMeterReport(tenant, '2026-11', {...won[0].value, seq: 99}), code('usage_meter_report_conflict'));
  // A Customer rebind while an intent is pending stops the resend.
  await f.upload('b', 1); await f.store.beginUsageMeterReport(tenant, '2026-11', binding);
  await assert.rejects(f.store.beginUsageMeterReport(tenant, '2026-11', {merchant_id: merchant, customer_id: 'cus_other'}), code('usage_meter_binding_changed'));
});

const streamArn = 'arn:aws:dynamodb:us-east-1:123456789012:table/synthetic/stream/2026-11-14T00:00:00.000';
const record = (pk, sk, extra = {}) => ({Records: [{eventName: 'MODIFY', eventSource: 'aws:dynamodb', eventSourceARN: streamArn, dynamodb: {StreamViewType: 'KEYS_ONLY', SequenceNumber: '42', Keys: {pk: {S: pk}, sk: {S: sk}}}, ...extra}]});
test('the stream worker reports usage rows, ignores every other key and fails closed on a foreign source', async () => {
  const f = await fixture(); await f.upload('a', 15); let loads = 0;
  const worker = createUsageMeterWorker({enabled: true, streamArn, merchantId: merchant, environmentId: 'synthetic-dev', eventName: EVENT, authorize: async action => action.action === 'worker.invoke', loadEnvironment: async () => { loads++; return f.env; }});
  assert.deepEqual(await worker(record('TENANT#' + tenant, 'USAGE#2026-11')), {batchItemFailures: []}); assert.equal(f.stripe.total(), 15);
  for (const [pk, sk] of [['TENANT#' + tenant, 'BATCH#a'], ['TENANT#' + tenant, 'METER#2026-11'], ['TENANT#' + tenant, 'META'], ['SYS', 'CAPACITY'], ['TENANT#not-a-tenant', 'USAGE#2026-11'], ['TENANT#' + tenant, 'USAGE#2026-13'], ['TENANT#' + tenant + '#RUN#run1', 'USAGE#2026-11']])
    assert.deepEqual(await worker(record(pk, sk)), {batchItemFailures: []});
  assert.deepEqual(await worker(record('TENANT#' + tenant, 'USAGE#2026-11', {eventName: 'REMOVE'})), {batchItemFailures: []});
  assert.equal(loads, 1); assert.equal(f.stripe.calls.length, 1);
  // A failed report asks the stream to redeliver that one record.
  await f.upload('b', 2); f.stripe.fail(Object.assign(new Error('down'), {statusCode: 503}));
  assert.deepEqual(await worker(record('TENANT#' + tenant, 'USAGE#2026-11')), {batchItemFailures: [{itemIdentifier: '42'}]});
  assert.deepEqual(await worker(record('TENANT#' + tenant, 'USAGE#2026-11')), {batchItemFailures: []}); assert.equal(f.stripe.total(), 17);
  for (const bad of [{Records: []}, {Records: [record('a', 'b').Records[0], record('a', 'b').Records[0]]}, record('TENANT#' + tenant, 'USAGE#2026-11', {eventSourceARN: streamArn.replace('synthetic', 'other')}), record('TENANT#' + tenant, 'USAGE#2026-11', {eventSource: 'aws:sqs'})]) await assert.rejects(worker(bad), /invalid_usage_meter_worker_(batch|source)/);
  const images = record('TENANT#' + tenant, 'USAGE#2026-11'); images.Records[0].dynamodb.NewImage = {}; await assert.rejects(worker(images), /invalid_usage_meter_worker_source/);
  const denied = createUsageMeterWorker({enabled: true, streamArn, merchantId: merchant, environmentId: 'synthetic-dev', eventName: EVENT, authorize: async () => false, loadEnvironment: async () => f.env});
  assert.deepEqual(await denied(record('TENANT#' + tenant, 'USAGE#2026-11')), {batchItemFailures: [{itemIdentifier: '42'}]});
  const foreign = createUsageMeterWorker({enabled: true, streamArn, merchantId: 'acct_other', environmentId: 'synthetic-dev', eventName: EVENT, authorize: async () => true, loadEnvironment: async () => f.env});
  assert.deepEqual(await foreign(record('TENANT#' + tenant, 'USAGE#2026-11')), {batchItemFailures: [{itemIdentifier: '42'}]}); assert.equal(f.stripe.calls.length, 3);
  await assert.rejects(createUsageMeterWorker()({}), /usage_meter_worker_disabled/);
  assert.throws(() => createUsageMeterWorker({enabled: true, streamArn, merchantId: merchant, environmentId: 'synthetic-dev', eventName: 'Bad', authorize: async () => true, loadEnvironment: async () => f.env}), /invalid_usage_meter_worker_configuration/);
});

test('live and non-restricted keys are refused before any Stripe client exists, and the AWS entry is off by default', async () => {
  const config = {...configuration('worker').runtime, authorizedActions: ['runtime.credentials', 'usage.report']};
  for (const key of ['sk_live_' + 'x'.repeat(24), 'rk_live_' + 'x'.repeat(24), 'sk_test_' + 'x'.repeat(24), 'pk_test_' + 'x'.repeat(24), '', 'rk_test_short']) {
    let constructed = 0; function Client() { constructed++; }
    await assert.rejects(buildStripeSandboxRuntime(config, {expectedPurpose: 'worker', StripeClient: Client, awsAccountId: '123456789012', awsRegion: 'us-east-1', authorize: async () => true, loadSecret: async () => key}), error => error.code === 'stripe_runtime_credentials_unavailable');
    assert.equal(constructed, 0, key.slice(0, 8));
  }
  let made = 0; function Ok() { made++; this.billing = {meterEvents: {create: async () => ({})}}; }
  const runtime = await buildStripeSandboxRuntime(config, {expectedPurpose: 'worker', StripeClient: Ok, awsAccountId: '123456789012', awsRegion: 'us-east-1', authorize: async () => true, loadSecret: async () => 'rk_test_' + 'x'.repeat(24)});
  assert.equal(made, 1); assert.equal(await runtime.authorize({action: 'usage.report'}), true); assert.equal(await runtime.authorize({action: 'checkout.create'}), false);
  // usage.report is a worker permission; an API runtime cannot be configured with a worker's key path by mistake.
  await assert.rejects(buildStripeSandboxRuntime({...config, authorizedActions: ['runtime.credentials', 'usage.report', 'customer.create']}, {expectedPurpose: 'worker', StripeClient: Ok, awsAccountId: '123456789012', awsRegion: 'us-east-1', authorize: async () => true, loadSecret: async () => 'rk_test_' + 'x'.repeat(24)}), error => error.code === 'invalid_stripe_runtime_purpose');
  const {handler} = await import('../aws/stripe-usage-meter-worker.mjs'), saved = process.env.BILLING_METER_WORKER_CONFIG;
  try {
    delete process.env.BILLING_METER_WORKER_CONFIG; await assert.rejects(handler(record('TENANT#' + tenant, 'USAGE#2026-11')), /usage_meter_worker_disabled/);
    process.env.BILLING_METER_WORKER_CONFIG = JSON.stringify({enabled: true, streamArn, merchantId: merchant, environmentId: 'synthetic-dev', eventName: EVENT, approvalRef: 'synthetic-approval'});
    await assert.rejects(handler(record('TENANT#' + tenant, 'USAGE#2026-11')), /usage_meter_worker_store_scope_mismatch/);
    process.env.BILLING_METER_WORKER_CONFIG = JSON.stringify({enabled: true, streamArn, merchantId: merchant, environmentId: 'synthetic-dev', eventName: EVENT, approvalRef: 'synthetic-approval', liveKey: 'x'});
    await assert.rejects(handler(record('TENANT#' + tenant, 'USAGE#2026-11')), /invalid_usage_meter_worker_configuration/);
  } finally { if (saved === undefined) delete process.env.BILLING_METER_WORKER_CONFIG; else process.env.BILLING_METER_WORKER_CONFIG = saved; }
});

test('local harness: real Stripe SDK, fake transport, meter total = accepted spans and /api/usage reports it', async () => {
  let billing; const live = await start({localDev: true, configureEnvironment: async env => { billing = env.localBilling = await configureLocalBilling(env); }});
  try {
    await seedLocalWorkspace(live); let cookies; await live.signIn({addCookies: async v => { cookies = v.map(c => c.name + '=' + c.value).join('; '); }}, 4242);
    const period = (await live.store.getPlanUsage('github-4242')).period.id, accepted = async () => (await live.store.getPlanUsage('github-4242')).accepted_spans;
    assert.equal(await accepted() > 0, true);
    assert.deepEqual(await billing.reportUsage('github-4242', period), {meter_total: await accepted(), events: 1});
    assert.deepEqual(await billing.reportUsage('github-4242', period), {meter_total: await accepted(), events: 1});
    // Send a known number of spans, replay the batch, and reconcile again.
    const before = await accepted(), batch = {batch_id: 'meter-known', run_id: 'meter-run', request_hash: sha('meter-known'), byte_count: 500, event_count: 37};
    await live.store.reserveBatch('github-4242', batch); await live.store.reserveBatch('github-4242', batch);
    // Reserved but not yet accepted: nothing to report.
    assert.equal(await accepted(), before); assert.deepEqual(await billing.reportUsage('github-4242', period), {meter_total: before, events: 1});
    await live.store.acceptReservedBatch('github-4242', batch.batch_id, batch.request_hash, null); await live.store.acceptReservedBatch('github-4242', batch.batch_id, batch.request_hash, null);
    assert.equal(await accepted(), before + 37);
    assert.deepEqual(await billing.reportUsage('github-4242', period), {meter_total: before + 37, events: 2});
    assert.equal(billing.calls.filter(path => path === '/v1/billing/meter_events').length, 2);
    // Members of the workspace without their own Customer are skipped, not failed.
    assert.deepEqual(await billing.reportUsage('github-5252', period), {meter_total: before + 37, events: 2});
    const response = await fetch(live.origin + '/api/usage', {headers: {cookie: cookies}}); assert.equal(response.status, 200); const body = await response.json();
    assert.deepEqual(body.meters.current, {period, reserved_spans: body.monthly.spans_used, accepted_spans: before + 37, reserved_bytes: body.monthly.bytes_ingested, accepted_bytes: body.meters.current.accepted_bytes, accepted_batches: body.meters.current.accepted_batches, stored_bytes: body.storage.used_bytes});
    assert.equal(body.monthly.spans_used, before + 37); assert.equal(body.meters.current.accepted_bytes, body.monthly.bytes_ingested);
    assert.deepEqual([body.meters.unit, body.meters.span_definition, body.meters.period_kind, body.meters.history], ['span', 'one_trace_event', 'calendar_month_utc', []]);
    assert.deepEqual(body.meters.stripe_test_meter, {status: 'reported', reported_spans: before + 37});
    assert.deepEqual(validateUsage(body).monthly.history, []);
    // An upload landing between the handler's reads cannot make `meters` and `monthly` disagree.
    const plan = live.store.getPlanUsage.bind(live.store); live.store.getPlanUsage = async id => { const value = await plan(id); await live.store.reserveBatch('github-4242', {batch_id: 'between-reads', run_id: 'meter-run', request_hash: sha('between-reads'), byte_count: 10, event_count: 3}); return value; };
    const raced = await (await fetch(live.origin + '/api/usage', {headers: {cookie: cookies}})).json(); live.store.getPlanUsage = plan;
    assert.equal(raced.meters.current.reserved_spans, raced.monthly.spans_used); assert.equal(raced.meters.current.reserved_spans, before + 37); validateUsage(raced);
    const earlier = {...body, meters: {...body.meters, history: [{period: '2020-01', reserved_spans: 10, accepted_spans: 9, reserved_bytes: 90, accepted_bytes: 80, accepted_batches: 1}]}};
    assert.deepEqual(validateUsage(earlier).monthly.history, [{period: '2020-01', reserved_spans: 10, accepted_spans: 9}]);
    for (const bad of [{...body.meters, current: {...body.meters.current, reserved_spans: 1}}, {...body.meters, current: {...body.meters.current, accepted_spans: -1}}, {...body.meters, history: [{period, reserved_spans: 1, accepted_spans: 1}]}, {...body.meters, history: 'none'}, {...body.meters, history: [{period: '2020-01', reserved_spans: 1, accepted_spans: -1}]}]) assert.throws(() => validateUsage({...body, meters: bad}), /invalid_usage/);
  } finally { await live.close(); }
});
