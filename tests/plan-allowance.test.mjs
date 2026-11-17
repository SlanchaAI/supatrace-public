import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {DynamoMetadataStore} from '../src/dynamodb-store.mjs';
import {MemoryDynamo, commandClasses} from './memory-dynamo.mjs';
import {PLAN_LIMITS, planLimits, usagePeriod} from '../src/plan-limits.mjs';
import {handle} from '../src/aws-api.mjs';
import {digest} from '../src/aws-auth.mjs';
import {alphaProject} from '../src/alpha-projects.mjs';
import {validateUsage} from '../public/app/usage-data.js';
import {PLANS} from '../src/plans.mjs';

const tenant = 'github-7', NOV = Date.UTC(2026, 10, 14, 12) / 1000, DEC = Date.UTC(2026, 11, 1) / 1000;
const sha = value => createHash('sha256').update(value).digest('hex');
const code = expected => error => error.code === expected;
// Allowances come from the plan table; the first test pins the table's literal numbers.
const FREE = planLimits('free').spans_per_month, BASE = planLimits('base').spans_per_month, PRO = planLimits('pro').spans_per_month, FREE_BYTES = planLimits('free').stored_bytes;
async function fixture(options = {}) {
  let now = NOV; const client = new MemoryDynamo();
  const store = new DynamoMetadataStore({client, commands: commandClasses(), tableName: 'synthetic', now: () => now, ...options});
  await store.getOrCreateTenant(7);
  const root = () => client.items.get('TENANT#' + tenant + '\0META');
  const period = id => client.items.get('TENANT#' + tenant + '\0USAGE#' + id);
  const reserve = (id, spans = 1, bytes = 100) => store.reserveBatch(tenant, {batch_id: id, run_id: 'run1', request_hash: sha(id), byte_count: bytes, event_count: spans});
  // Seed this month's counter directly: tens of thousands of real 100-event batches would only slow the test.
  const used = spans => client.items.set('TENANT#' + tenant + '\0USAGE#' + usagePeriod(now).id, {pk: 'TENANT#' + tenant, sk: 'USAGE#' + usagePeriod(now).id, tenant_id: tenant, period: usagePeriod(now).id, spans, bytes: spans * 10, batches: 1});
  return {store, client, root, period, reserve, used, at: value => now = value};
}

test('one plan table holds every per-plan value and unknown plans never grant more than Free', () => {
  const {free, base, pro, enterprise} = PLAN_LIMITS.plans, GB = 1000000000;
  // Pinned on purpose: a silent edit to the plan table must fail here.
  const row = p => [p.spans_per_month, p.stored_bytes, p.retention_days, p.environments, p.seats, p.api_keys, p.hard_stop, p.overage, p.overage_usd_per_million_spans, p.spend_cap_default];
  assert.deepEqual(row(free), [50000, 1 * GB, 7, 2, 2, 2, true, false, null, true]);
  assert.deepEqual(row(base), [1000000, 10 * GB, 30, 3, 5, 10, true, false, null, true]);
  assert.deepEqual(row(pro), [5000000, 50 * GB, 90, 10, 10, 25, false, true, 5, true]);
  assert.deepEqual(row(enterprise), [50000000, 500 * GB, 365, 20, 20, 100, true, false, null, true]);
  assert.deepEqual(PLANS.plans.map(p => [p.id, p.monthly_base_usd, p.price_kind]), [['free', 0, 'fixed'], ['base', 9.99, 'fixed'], ['pro', 25.99, 'fixed'], ['enterprise', null, 'custom']]);
  assert.equal(PLANS.status, 'approved'); assert.equal(PLAN_LIMITS.status, 'approved'); assert.equal(Object.isFrozen(PLAN_LIMITS.plans.free), true);
  for (const bad of [undefined, null, '', 'team', 'PRO', 'Enterprise', '__proto__', 'constructor', 7, {}]) assert.equal(planLimits(bad), free);
  assert.equal(planLimits('free'), free); assert.equal(planLimits('base'), base); assert.equal(planLimits('pro'), pro); assert.equal(planLimits('enterprise'), enterprise);
  // Enforcement reads the same table the public pricing page is generated from: every plan, every enforced number.
  for (const p of PLANS.plans) { const l = planLimits(p.id); assert.equal(l.id, p.id); assert.deepEqual([l.name, l.spans_per_month, l.stored_bytes, l.retention_days, l.projects, l.environments, l.seats, l.api_keys], [p.name, p.included_spans_per_month, p.storage_gb * GB, p.retention_days, p.projects, p.environments, p.seats, p.api_keys]); }
  assert.equal(PLAN_LIMITS.version, PLANS.version); assert.deepEqual(Object.keys(PLAN_LIMITS.plans), ['free', 'base', 'pro', 'enterprise']); assert.equal(PLANS.plans.length, 4);
});

test('calendar-month period boundaries are UTC and roll over the year', () => {
  assert.deepEqual(usagePeriod(NOV), {id: '2026-11', starts_at: Date.UTC(2026, 10, 1) / 1000, resets_at: DEC});
  assert.equal(usagePeriod(DEC - 1).id, '2026-11'); assert.equal(usagePeriod(DEC).id, '2026-12');
  assert.deepEqual(usagePeriod(Date.UTC(2026, 11, 31, 23, 59, 59) / 1000).resets_at, Date.UTC(2027, 0, 1) / 1000);
  assert.throws(() => usagePeriod(-1)); assert.throws(() => usagePeriod(1.5));
});

test('accepted reservations meter spans and bytes for the month in the same transaction as the batch', async () => {
  const f = await fixture(); await f.reserve('a', 3, 200); await f.reserve('b', 2, 50);
  const row = f.period('2026-11');
  assert.deepEqual([row.spans, row.bytes, row.batches, row.period, row.resets_at], [5, 250, 2, '2026-11', DEC]);
  assert.equal(f.root().used_bytes, 250);
  // An identical retry is read-only: nothing is counted twice.
  await f.reserve('a', 3, 200); assert.equal(f.period('2026-11').spans, 5); assert.equal(f.root().used_bytes, 250);
  // The old 10 MiB lifetime cap no longer stops a Free account.
  f.root().used_bytes = 10 * 1024 * 1024; await f.reserve('past-old-cap', 1, 100);
});

test('Free hard stop at the monthly span allowance names the limit, usage, reset date and upgrade link', async () => {
  const f = await fixture(); f.used(FREE - 1); await f.reserve('last', 1);
  assert.equal(f.period('2026-11').spans, FREE);
  await assert.rejects(f.reserve('over', 1), error => {
    assert.equal(error.status, 429); assert.equal(error.code, 'monthly_span_allowance_exceeded');
    assert.deepEqual({...error.details, message: undefined}, {plan: 'free', period: '2026-11', resets_at: '2026-12-01T00:00:00.000Z', upgrade_url: '/app/#billing', limit: FREE, used: FREE, requested: 1, unit: 'spans', message: undefined});
    assert.ok(error.details.message.startsWith('Free plan allowance of ' + FREE + ' spans this month is used up. It resets on 2026-12-01'), error.details.message); return true;
  });
  // A rejected batch leaves no marker and charges nothing.
  assert.equal(f.client.items.has('TENANT#' + tenant + '\0BATCH#over'), false);
  assert.equal(f.period('2026-11').spans, FREE); assert.equal(f.root().used_bytes, 100);
  // A batch that would cross the line is refused whole, not partly counted.
  const g = await fixture(); g.used(FREE - 10); await assert.rejects(g.reserve('crossing', 11), code('monthly_span_allowance_exceeded')); assert.equal(g.period('2026-11').spans, FREE - 10);
  await g.reserve('exactly', 10); assert.equal(g.period('2026-11').spans, FREE);
});

test('the allowance resets on the first of the next month without touching stored bytes or last month', async () => {
  const f = await fixture(); f.used(FREE); await assert.rejects(f.reserve('nov', 1), code('monthly_span_allowance_exceeded'));
  f.at(DEC - 1); await assert.rejects(f.reserve('still-nov', 1), code('monthly_span_allowance_exceeded'));
  f.at(DEC); await f.reserve('dec', 4, 300);
  assert.equal(f.period('2026-12').spans, 4); assert.equal(f.period('2026-11').spans, FREE); assert.equal(f.root().used_bytes, 300);
  const usage = await f.store.getPlanUsage(tenant);
  assert.deepEqual([usage.period.id, usage.spans_used, usage.bytes_ingested, usage.stored_bytes], ['2026-12', 4, 300, 300]);
});

test('the limit is enforced in the transaction: racing reservations at the edge cannot both pass', async () => {
  const f = await fixture(); f.used(FREE - 1);
  const results = await Promise.allSettled([f.reserve('r1', 1), f.reserve('r2', 1), f.reserve('r3', 1)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  for (const r of results.filter(r => r.status === 'rejected')) assert.equal(r.reason.code, 'monthly_span_allowance_exceeded');
  assert.equal(f.period('2026-11').spans, FREE);
});

test('a plan on the account row raises the allowance; a plan change mid-request fails closed', async () => {
  const f = await fixture(); f.used(FREE); await assert.rejects(f.reserve('free', 1), code('monthly_span_allowance_exceeded'));
  // Base is a larger hard stop: no overage, so it ends in the same allowance refusal at its own limit.
  f.root().plan_id = 'base'; await f.reserve('base', 100); f.used(BASE - 1); await f.reserve('base-last', 1);
  await assert.rejects(f.reserve('base-over', 1), error => error.status === 429 && error.code === 'monthly_span_allowance_exceeded' && error.details.plan === 'base' && error.details.limit === BASE && error.details.used === BASE);
  f.used(FREE);
  f.root().plan_id = 'pro'; await f.reserve('pro', 100);
  assert.equal((await f.store.getPlanUsage(tenant)).plan.id, 'pro');
  // Pro has metered overage and its spend cap is on by default, so the stop is a spend-cap stop.
  f.used(PRO); await assert.rejects(f.reserve('pro-over', 1), error => error.code === 'spend_cap_reached' && error.details.plan === 'pro' && error.details.limit === PRO);
  // Enterprise resolves to its own limits and stops until custom overage terms exist.
  const ENTERPRISE = planLimits('enterprise').spans_per_month; f.root().plan_id = 'enterprise'; await f.reserve('enterprise', 1); assert.equal((await f.store.getPlanUsage(tenant)).plan.id, 'enterprise');
  f.used(ENTERPRISE); await assert.rejects(f.reserve('enterprise-over', 1), error => error.code === 'monthly_span_allowance_exceeded' && error.details.plan === 'enterprise' && error.details.limit === ENTERPRISE);
  f.root().plan_id = 'pro';
  // Downgrade lands between the plan read and the transaction: the Pro-sized check must not commit.
  const raced = FREE * 3; assert.ok(raced > FREE && raced < PRO); f.used(raced); const send = f.client.send.bind(f.client); let changed = false;
  f.client.send = async command => { if (!changed && command.name === 'TransactWriteCommand') { changed = true; delete f.root().plan_id; } return send(command); };
  await assert.rejects(f.reserve('raced', 1), code('monthly_span_allowance_exceeded')); assert.equal(f.period('2026-11').spans, raced);
  f.root().plan_id = 'not-a-plan'; f.client.send = send; await assert.rejects(f.reserve('unknown-plan', 1), code('monthly_span_allowance_exceeded'));
});

test('stored bytes stop at the plan allowance and do not reset with the month', async () => {
  const f = await fixture(); f.root().used_bytes = FREE_BYTES - 100; await f.reserve('fits', 1, 100);
  for (const at of [NOV, DEC]) { f.at(at); await assert.rejects(f.reserve('full' + at, 1, 1), error => error.status === 429 && error.code === 'stored_bytes_allowance_exceeded' && error.details.limit === FREE_BYTES && error.details.used === FREE_BYTES && error.details.upgrade_url === '/app/#billing' && !('resets_at' in error.details)); }
  f.root().plan_id = 'pro'; await f.reserve('pro-room', 1, 1);
});

test('an identical request that took the last room is returned its reservation, not a 429', async () => {
  for (const [seed, bytes] of [[f => f.root().used_bytes = FREE_BYTES - 100, 100], [f => f.used(FREE - 1), 100]]) {
    const f = await fixture(); seed(f); const send = f.client.send.bind(f.client); let raced = false;
    // The twin request commits after this request's marker read and before its allowance check.
    f.client.send = async command => { const result = await send(command); if (!raced && command.name === 'GetCommand' && command.input.Key.sk === 'BATCH#twin') { raced = true; f.client.send = send; await f.reserve('twin', 1, bytes); f.client.send = hooked; } return result; };
    const hooked = f.client.send; const row = await f.reserve('twin', 1, bytes);
    assert.equal(raced, true); assert.equal(row.status, 'pending'); assert.equal(row.request_hash, sha('twin'));
    await assert.rejects(f.reserve('twin', 2, bytes), code('idempotency_conflict'));
  }
});

test('global safety caps stay: the service-wide byte cap still stops a reservation inside the plan allowance', async () => {
  const f = await fixture({globalBytes: 500}); await f.reserve('a', 1, 400);
  await assert.rejects(f.reserve('b', 1, 200), code('storage_capacity_or_unknown_tenant'));
  await assert.rejects(f.reserve('c', 1, 501), code('storage_capacity'));
  assert.equal(f.period('2026-11').spans, 1);
  const capped = await fixture({accounts: 1}); await assert.rejects(capped.store.getOrCreateTenant(8), error => error.status === 429 || error.status === 503);
  // An explicit operator ceiling can still bound the plan's stored bytes.
  const g = await fixture({accountCeilingBytes: 300}); await g.reserve('a', 1, 300); await assert.rejects(g.reserve('b', 1, 1), code('stored_bytes_allowance_exceeded'));
});

test('unknown accounts and commercially enrolled rows never fall back to a plan allowance', async () => {
  const f = await fixture();
  await assert.rejects(f.store.reserveBatch('github-99', {batch_id: 'x', run_id: 'run1', request_hash: sha('x'), byte_count: 10, event_count: 1}), code('storage_capacity_or_unknown_tenant'));
  assert.equal(f.client.items.has('TENANT#github-99\0USAGE#2026-11'), false);
  f.root().byte_limit = 0; await assert.rejects(f.reserve('enrolled', 1), code('storage_capacity_or_unknown_tenant')); assert.equal(f.period('2026-11'), undefined);
});

const token = 'c'.repeat(43);
test('/api/usage reports the month, allowance and reset date, and the dashboard validator accepts it', async () => {
  const f = await fixture(); await f.reserve('a', 7, 700); await f.store.createSession(digest(token), tenant);
  const env = {ENABLED: true, APP_ORIGIN: 'https://supatrace.dev', GITHUB_CLIENT_ID: 'synthetic', GITHUB_CLIENT_SECRET: 'synthetic', store: f.store, objects: {}};
  const response = await handle(new Request('https://supatrace.dev/api/usage', {headers: {cookie: '__Host-supatrace=' + token}}), env);
  assert.equal(response.status, 200); const body = await response.json();
  assert.deepEqual(body.monthly, {period: '2026-11', starts_at: '2026-11-01T00:00:00.000Z', resets_at: '2026-12-01T00:00:00.000Z', spans_used: 7, spans_limit: FREE, spans_remaining: FREE - 7, bytes_ingested: 700, batches: 1});
  const free = planLimits('free');
  assert.deepEqual(body.plan_limits, {plan_id: 'free', name: 'Free', spans_per_month: FREE, stored_bytes: FREE_BYTES, retention_days: free.retention_days, projects: free.projects, hard_stop: true, version: PLANS.version, status: 'approved'});
  assert.deepEqual(body.projects, {used: 1, limit: free.projects});
  assert.deepEqual([body.storage.used_bytes, body.storage.limit_bytes, body.storage.remaining_bytes, body.storage.limit_kind], [700, FREE_BYTES, FREE_BYTES - 700, 'plan_stored_bytes_allowance']);
  const view = validateUsage(body);
  assert.deepEqual({...view.monthly, spend_cap: undefined}, {spend_cap: undefined, history: [], period: '2026-11', resets_at: '2026-12-01T00:00:00.000Z', spans_used: 7, spans_limit: FREE, spans_remaining: FREE - 7, plan_id: 'free', plan_name: 'Free', retention_days: free.retention_days, retention_enforced: true, retention_physical: false, projects: free.projects, proposal: false});
  assert.deepEqual(view.monthly.spend_cap, {enabled: true, configurable: false, default_enabled: true, overage_spans: 0, overage_usd_per_million_spans: null});
  // Older APIs omit the additive fields; half-present or inconsistent ones are refused, not rendered.
  const {monthly, plan_limits, retention, meters, ...legacy} = body; assert.equal(validateUsage(legacy).monthly, undefined);
  for (const bad of [{...body, plan_limits: undefined}, {...body, monthly: {...monthly, spans_remaining: 5}}, {...body, monthly: {...monthly, resets_at: '2026-11-01T00:00:00.000Z'}}, {...body, monthly: {...monthly, spans_limit: 5}}, {...body, monthly: {...monthly, period: '2026-13'}}, {...body, plan_limits: {...plan_limits, name: ''}}])
    assert.throws(() => validateUsage(bad), /invalid_usage/);
});

test('an over-allowance upload gets a 429 whose body explains itself and leaks nothing else', async () => {
  const f = await fixture(); f.used(FREE); const project = alphaProject(tenant).id, key = 'a'.repeat(43);
  await f.store.createSession(digest(token), tenant);
  const raw = JSON.stringify({version: 1, batch_id: 'over1', run_id: 'run1', events: [{id: 'event1', time: '2026-11-14T00:00:00Z', kind: 'note', name: 'Synthetic', data: {safe: true}}]});
  let objects = 0; const store = Object.create(f.store); store.consumeRate = async () => ({allowed: true}); store.lookupWriteKey = async () => ({tenant_id: tenant, project_id: project, token_hash: digest(key)});
  const env = {ENABLED: true, APP_ORIGIN: 'https://supatrace.dev', GITHUB_CLIENT_ID: 'synthetic', GITHUB_CLIENT_SECRET: 'synthetic', store, objects: {putImmutable: async () => { objects++; }}};
  const post = () => handle(new Request('https://supatrace.dev/api/batches?project=' + project, {method: 'POST', headers: {'content-type': 'application/json', 'x-supatrace-key': key, 'x-amz-content-sha256': digest(raw)}, body: raw}), env);
  const response = await post(); assert.equal(response.status, 429); assert.equal(objects, 0);
  assert.deepEqual(await response.json(), {error: 'monthly_span_allowance_exceeded', message: 'Free plan allowance of ' + FREE + ' spans this month is used up. It resets on 2026-12-01 (UTC). Upgrade in Billing for a higher allowance.', plan: 'free', period: '2026-11', unit: 'spans', limit: FREE, used: FREE, requested: 1, resets_at: '2026-12-01T00:00:00.000Z', upgrade_url: '/app/#billing'});
  // Other errors keep the bare code even if something attaches details.
  store.reserveBatch = async () => { throw Object.assign(new Error('x'), {status: 409, code: 'idempotency_conflict', details: {message: 'PRIVATE', used: 5}}); };
  assert.deepEqual(await (await post()).json(), {error: 'idempotency_conflict'});
  store.reserveBatch = async () => { throw Object.assign(new Error('x'), {status: 429, code: 'stored_bytes_allowance_exceeded', details: {message: 'ok', secret: 'PRIVATE', limit: {nested: 1}, used: 3}}); };
  assert.deepEqual(await (await post()).json(), {error: 'stored_bytes_allowance_exceeded', message: 'ok', used: 3});
});

test('the Usage view has the monthly allowance card and the agent uploader explains both rejections', () => {
  const html = readFileSync(new URL('../public/app/index.html', import.meta.url), 'utf8'), app = readFileSync(new URL('../public/app/app.js', import.meta.url), 'utf8'), agent = readFileSync(new URL('../agent/upload.py', import.meta.url), 'utf8');
  assert.match(html, /<h2>Spans this month<\/h2><p id="usage-monthly" role="status">/); assert.match(html, /id="usage-plan-limits"/);
  assert.match(app, /of \$\{count\(monthly\.spans_limit\)\} spans this month\. Resets \$\{resets\} \(UTC\)\./);
  for (const name of ['monthly_span_allowance_exceeded', 'stored_bytes_allowance_exceeded']) { assert.match(app, new RegExp(name + ':')); assert.match(agent, new RegExp("\\(429, '" + name + "'\\)")); }
});
