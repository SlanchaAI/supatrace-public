import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {DynamoMetadataStore} from '../src/dynamodb-store.mjs';
import {MemoryDynamo, commandClasses} from './memory-dynamo.mjs';
import {PLAN_LIMITS, planLimits, spendCap, usageAlertLevel} from '../src/plan-limits.mjs';
import {PLANS} from '../src/plans.mjs';
import {notifyUsageAlert, usageAlertMessage, ALERT_EMAIL_TIMEOUT_MS} from '../src/usage-alerts.mjs';
import {handle} from '../src/aws-api.mjs';
import {digest} from '../src/aws-auth.mjs';
import {alphaProject} from '../src/alpha-projects.mjs';
import {validateUsage} from '../public/app/usage-data.js';

const tenant = 'github-7', NOV = Date.UTC(2026, 10, 14, 12) / 1000, DEC = Date.UTC(2026, 11, 1) / 1000, token = 'c'.repeat(43), key = 'a'.repeat(43), ORIGIN = 'https://supatrace.dev';
// Expected numbers come from the plan table; the first test pins the table's literal allowances once.
const FREE = planLimits('free'), BASE = planLimits('base'), PRO = planLimits('pro'), ENT = planLimits('enterprise');
const F = FREE.spans_per_month, F80 = F * 0.8, B = BASE.spans_per_month, B80 = B * 0.8, P = PRO.spans_per_month, commas = value => value.toLocaleString('en-US');
const sha = value => createHash('sha256').update(value).digest('hex'), code = expected => error => error.code === expected;
async function fixture({plan, identity} = {}) {
  let now = NOV; const client = new MemoryDynamo(), mail = [];
  const store = new DynamoMetadataStore({client, commands: commandClasses(), tableName: 'synthetic', now: () => now});
  await store.getOrCreateTenant(7); await store.createSession(digest(token), tenant);
  const root = () => client.items.get('TENANT#' + tenant + '\0META'); if (plan) root().plan_id = plan; if (identity) Object.assign(root(), identity);
  const month = (id = '2026-11') => client.items.get('TENANT#' + tenant + '\0USAGE#' + id);
  const used = spans => client.items.set('TENANT#' + tenant + '\0USAGE#2026-11', {pk: 'TENANT#' + tenant, sk: 'USAGE#2026-11', tenant_id: tenant, period: '2026-11', spans, bytes: spans, batches: 1});
  const reserve = (id, spans = 1) => store.reserveBatch(tenant, {batch_id: id, run_id: 'run1', request_hash: sha(id), byte_count: 100, event_count: spans});
  const notices = () => [...client.items.values()].filter(row => row.sk.startsWith('NOTICE#'));
  // A live write key row: the upload transaction checks it.
  client.items.set('WRITE#' + digest(key) + '\0KEY', {pk: 'WRITE#' + digest(key), sk: 'KEY', token_hash: digest(key), tenant_id: tenant, scope: 'write', revoked: false, expires_at: DEC + 86400 * 365});
  const api = Object.create(store); api.consumeRate = async () => ({allowed: true}); api.lookupWriteKey = async () => ({tenant_id: tenant, project_id: alphaProject(tenant).id, token_hash: digest(key)});
  const env = {ENABLED: true, APP_ORIGIN: ORIGIN, GITHUB_CLIENT_ID: 'synthetic', GITHUB_CLIENT_SECRET: 'synthetic', store: api, objects: {putImmutable: async () => {}}};
  const post = (path, body) => handle(new Request(ORIGIN + '/api/' + path, {method: 'POST', headers: {'content-type': 'application/json', origin: ORIGIN, cookie: '__Host-supatrace=' + token}, body: JSON.stringify(body)}), env);
  const usage = async () => (await handle(new Request(ORIGIN + '/api/usage', {headers: {cookie: '__Host-supatrace=' + token}}), env)).json();
  let batches = 0;
  const upload = spans => { const raw = JSON.stringify({version: 1, batch_id: 'up' + ++batches, run_id: 'run1', events: Array.from({length: spans}, (_, i) => ({id: 'e' + batches + '-' + i, time: '2026-11-14T00:00:00Z', kind: 'note', name: 'Synthetic', data: {safe: true}}))});
    return handle(new Request(ORIGIN + '/api/batches?project=' + alphaProject(tenant).id, {method: 'POST', headers: {'content-type': 'application/json', 'x-supatrace-key': key, 'x-amz-content-sha256': digest(raw)}, body: raw}), env); };
  const email = () => { env.EMAIL_FROM = 'member@example.com'; env.sendEmail = async message => { mail.push(message); }; };
  return {store, client, root, month, used, reserve, notices, env, post, usage, upload, email, mail, at: value => now = value};
}

test('spend cap defaults come from the plan table: on for Pro and Enterprise, fixed on for Free and Base', () => {
  const byId = Object.fromEntries(PLANS.plans.map(p => [p.id, p]));
  assert.deepEqual(Object.keys(PLAN_LIMITS.plans), ['free', 'base', 'pro', 'enterprise']); assert.equal(planLimits('team'), FREE);
  // The one literal copy of the allowances in this file: a silent change to the table fails here.
  assert.deepEqual([F, B, P, ENT.spans_per_month], [50000, 1000000, 5000000, 50000000]);
  assert.deepEqual([FREE.overage, BASE.overage, PRO.overage, ENT.overage], [false, false, true, false]);
  assert.deepEqual([PRO.overage_usd_per_million_spans, ENT.overage_usd_per_million_spans, BASE.overage_usd_per_million_spans, FREE.overage_usd_per_million_spans], [byId.pro.overage_usd_per_million_spans, byId.enterprise.overage_usd_per_million_spans, null, null]);
  assert.deepEqual([byId.pro.overage_usd_per_million_spans, byId.enterprise.overage_usd_per_million_spans], [5, null]);
  // Every plan with overage has the cap on until the account chooses; an explicit boolean on the row wins either way.
  for (const plan_id of ['pro']) {
    assert.deepEqual(spendCap({plan_id}), {configurable: true, default_enabled: true, enabled: true});
    assert.deepEqual(spendCap({plan_id, spend_cap: false}), {configurable: true, default_enabled: true, enabled: false});
    assert.deepEqual(spendCap({plan_id, spend_cap: true}), {configurable: true, default_enabled: true, enabled: true});
  }
  // Free and Base cannot be uncapped by a stray attribute, and garbage values mean the default.
  for (const row of [{}, {spend_cap: false}, {plan_id: 'free', spend_cap: false}, {plan_id: 'base', spend_cap: false}, {plan_id: 'enterprise', spend_cap: false}, {plan_id: 'nope', spend_cap: false}, {plan_id: 'team', spend_cap: false}]) assert.deepEqual(spendCap(row), {configurable: false, default_enabled: true, enabled: true});
  for (const bad of ['false', 0, null, 'off']) assert.equal(spendCap({plan_id: 'pro', spend_cap: bad}).enabled, true);
  assert.deepEqual([FREE.hard_stop, BASE.hard_stop, PRO.hard_stop, ENT.hard_stop], [true, true, false, true]);
});

test('cap on: Pro stops at its included spans with a spend-cap rejection; cap off: uploads continue as overage', async () => {
  const f = await fixture({plan: 'pro'}); f.used(P - 1); await f.reserve('last');
  await assert.rejects(f.reserve('over'), error => {
    assert.equal(error.status, 429); assert.equal(error.code, 'spend_cap_reached');
    assert.deepEqual({...error.details, message: undefined}, {plan: 'pro', period: '2026-11', resets_at: '2026-12-01T00:00:00.000Z', upgrade_url: '/app/#billing', cost_control_url: '/app/#billing', limit: P, used: P, requested: 1, unit: 'spans', message: undefined});
    assert.equal(error.details.message.startsWith(`Spend cap is on: the Pro plan's ${P} included spans this month are used up, so uploads stop instead of adding overage.`), true); return true;
  });
  assert.equal(f.month().spans, P);
  assert.deepEqual(await f.store.setSpendCap(tenant, false), {configurable: true, default_enabled: true, enabled: false});
  await f.reserve('over'); await f.reserve('more', 100); assert.equal(f.month().spans, P + 101);
  assert.equal((await f.usage()).spend_cap.overage_spans, 101);
  // Turning it back on stops uploads again even though the month is already over the allowance.
  await f.store.setSpendCap(tenant, true); await assert.rejects(f.reserve('capped-again'), code('spend_cap_reached')); assert.equal(f.month().spans, P + 101);
  // The cap is a monthly matter: the next month starts with room.
  f.at(DEC); await f.reserve('december'); assert.equal(f.month('2026-12').spans, 1);
});

test('the stored-byte allowance and the global cap still apply with the cap off', async () => {
  // Pro overage does not bypass the stored-data limit.
  const f = await fixture({plan: 'pro'}); f.root().spend_cap = false; f.used(PRO.spans_per_month * 2); await f.reserve('overage-ok');
  f.root().used_bytes = PRO.stored_bytes; await assert.rejects(f.reserve('bytes'), code('stored_bytes_allowance_exceeded'));
  const g = new DynamoMetadataStore({client: new MemoryDynamo(), commands: commandClasses(), tableName: 'synthetic', globalBytes: 150, now: () => NOV}); await g.getOrCreateTenant(7);
  Object.assign(g.client.items.get('TENANT#' + tenant + '\0META'), {plan_id: 'enterprise', spend_cap: false});
  await g.reserveBatch(tenant, {batch_id: 'a', run_id: 'run1', request_hash: sha('a'), byte_count: 100, event_count: 1});
  await assert.rejects(g.reserveBatch(tenant, {batch_id: 'b', run_id: 'run1', request_hash: sha('b'), byte_count: 100, event_count: 1}), code('storage_capacity_or_unknown_tenant'));
});

test('concurrent batches straddling the limit: cap on admits exactly up to the limit, cap off admits all', async () => {
  for (const [cap, admitted, total] of [[true, 2, P], [false, 5, P + 3]]) {
    const f = await fixture({plan: 'pro'}); f.root().spend_cap = cap; f.used(P - 2);
    const results = await Promise.allSettled(['r1', 'r2', 'r3', 'r4', 'r5'].map(id => f.reserve(id)));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, admitted);
    for (const r of results.filter(r => r.status === 'rejected')) assert.equal(r.reason.code, 'spend_cap_reached');
    assert.equal(f.month().spans, total);
  }
});

test('a cap switched on, or a plan change, between the read and the transaction fails closed', async () => {
  for (const mutate of [row => row.spend_cap = true, row => delete row.plan_id, row => row.plan_id = 'base', row => row.plan_id = 'enterprise']) {
    const f = await fixture({plan: 'pro'}); f.root().spend_cap = false; f.used(P);
    const send = f.client.send.bind(f.client); let changed = false;
    f.client.send = async command => { if (!changed && command.name === 'TransactWriteCommand') { changed = true; mutate(f.root()); } return send(command); };
    await assert.rejects(f.reserve('raced'), error => error.status === 429); assert.equal(f.month().spans, P);
    assert.equal(f.client.items.has('TENANT#' + tenant + '\0BATCH#raced'), false);
  }
});

test('only a plan with overage can change the cap, and the write is pinned to that plan', async () => {
  // Free and Base do not have the spend-cap feature: the switch answers 402 and names the plan that has it.
  for (const plan of [undefined, 'base']) { const low = await fixture({plan}), name = plan ? 'Base' : 'Free';
    for (const enabled of [false, true]) await assert.rejects(low.store.setSpendCap(tenant, enabled), error => {
      assert.equal(error.status, 402); assert.equal(error.code, 'plan_upgrade_required');
      assert.deepEqual(error.details, {feature: 'spend_cap', plan: plan ?? 'free', required_plan: 'pro', message: 'Spend cap control (run past the allowance) needs the Pro plan. This organization is on ' + name + '.', upgrade_url: '/app/#billing'}); return true;
    });
    assert.equal('spend_cap' in low.root(), false); }
  const free = await fixture();
  for (const bad of ['off', 0, null, undefined]) await assert.rejects(free.store.setSpendCap(tenant, bad), code('invalid_spend_cap'));
  await assert.rejects(free.store.setSpendCap('github-99', false), code('tenant_not_found'));
  const f = await fixture({plan: 'pro'}), send = f.client.send.bind(f.client);
  f.client.send = async command => { if (command.name === 'TransactWriteCommand') delete f.root().plan_id; return send(command); };
  await assert.rejects(f.store.setSpendCap(tenant, false), code('spend_cap_conflict')); assert.equal('spend_cap' in f.root(), false); f.client.send = send;
  const enrolled = await fixture({plan: 'pro'}); enrolled.root().commercial_managed = true; await assert.rejects(enrolled.store.setSpendCap(tenant, false), error => error.status === 409 && error.code === 'spend_cap_not_configurable'); assert.equal('spend_cap' in enrolled.root(), false);
  // Enterprise pricing is custom: a leftover cap-off attribute cannot authorize uncontracted overage.
  const ent = await fixture({plan: 'enterprise'}); ent.root().spend_cap = false;
  await assert.rejects(ent.store.setSpendCap(tenant, false), code('spend_cap_not_configurable'));
  ent.used(ENT.spans_per_month); await assert.rejects(ent.reserve('uncontracted'), code('monthly_span_allowance_exceeded'));
  assert.equal(ent.month().spans, ENT.spans_per_month); assert.equal(ent.client.items.has('TENANT#' + tenant + '\0BATCH#uncontracted'), false);
  // A Free account carrying a leftover spend_cap:false from a past Pro plan is still capped.
  const down = await fixture(); down.root().spend_cap = false; down.used(F); await assert.rejects(down.reserve('free-over'), code('monthly_span_allowance_exceeded'));
  const based = await fixture({plan: 'base'}); based.root().spend_cap = false; based.used(B - 1); await based.reserve('base-last'); await assert.rejects(based.reserve('base-over'), code('monthly_span_allowance_exceeded')); assert.equal(based.month().spans, B);
});

test('POST /api/billing/spend-cap is owner-only, exact-body, and /api/usage reports the cap', async () => {
  const f = await fixture({plan: 'pro'});
  let body = await f.usage(); assert.deepEqual(body.spend_cap, {enabled: true, configurable: true, default_enabled: true, overage_usd_per_million_spans: PRO.overage_usd_per_million_spans, overage_spans: 0}); assert.equal(body.plan_limits.hard_stop, true);
  await f.store.setSpendCap(tenant, false);
  assert.equal((await f.post('billing/spend-cap', {enabled: false})).status, 503);
  const response = await f.post('billing/spend-cap', {enabled: true}); assert.equal(response.status, 200); assert.deepEqual(await response.json(), {spend_cap: {configurable: true, default_enabled: true, enabled: true}});
  body = await f.usage(); assert.equal(body.spend_cap.enabled, true); assert.equal(body.plan_limits.hard_stop, true); assert.equal(validateUsage(body).monthly.spend_cap.enabled, true);
  for (const bad of [{}, {enabled: 'false'}, {enabled: false, plan_id: 'enterprise'}, {enabled: null}, []]) { const r = await f.post('billing/spend-cap', bad); assert.equal(r.status, 400); assert.deepEqual(await r.json(), {error: 'invalid_spend_cap'}); }
  assert.equal(f.root().spend_cap, true);
  // Another workspace, a non-default environment, a foreign origin and a signed-out caller are all refused.
  assert.equal((await f.post('billing/spend-cap?workspace=github-8', {enabled: true})).status, 403);
  assert.equal((await f.post('billing/spend-cap?environment=dev', {enabled: true})).status, 403);
  assert.equal((await handle(new Request(ORIGIN + '/api/billing/spend-cap', {method: 'POST', headers: {'content-type': 'application/json', origin: 'https://evil.example', cookie: '__Host-supatrace=' + token}, body: '{"enabled":true}'}), f.env)).status, 403);
  assert.equal((await handle(new Request(ORIGIN + '/api/billing/spend-cap', {method: 'POST', headers: {'content-type': 'application/json', origin: ORIGIN}, body: '{"enabled":true}'}), f.env)).status, 401);
  assert.equal(f.root().spend_cap, true);
  const free = await fixture(), refused = await free.post('billing/spend-cap', {enabled: false}); assert.equal(refused.status, 402);
  assert.deepEqual(await refused.json(), {error: 'plan_upgrade_required', message: 'Spend cap control (run past the allowance) needs the Pro plan. This organization is on Free.', feature: 'spend_cap', plan: 'free', required_plan: 'pro', upgrade_url: '/app/#billing'}); assert.equal('spend_cap' in free.root(), false);
  const base = await fixture({plan: 'base'}), baseRefused = await base.post('billing/spend-cap', {enabled: false}); assert.equal(baseRefused.status, 402); assert.deepEqual([(await baseRefused.json()).plan, 'spend_cap' in base.root()], ['base', false]);
  assert.deepEqual((await base.usage()).spend_cap, {enabled: true, configurable: false, default_enabled: true, overage_usd_per_million_spans: null, overage_spans: 0});
  assert.deepEqual((await free.usage()).spend_cap, {enabled: true, configurable: false, default_enabled: true, overage_usd_per_million_spans: null, overage_spans: 0});
  for (const bad of [{enabled: false, configurable: false}, {enabled: true, configurable: true, overage_usd_per_million_spans: null}, {overage_spans: 3}, {enabled: 'yes'}]) assert.throws(() => validateUsage({...body, spend_cap: {...body.spend_cap, ...bad}}), /invalid_usage/);
});

test('a capped Pro upload gets the spend-cap body over HTTP', async () => {
  const f = await fixture({plan: 'pro'}); f.used(P);
  const response = await f.upload(1); assert.equal(response.status, 429);
  const body = await response.json(); assert.equal(body.error, 'spend_cap_reached'); assert.equal(body.cost_control_url, '/app/#billing'); assert.equal(body.resets_at, '2026-12-01T00:00:00.000Z'); assert.equal(body.limit, P);
  assert.deepEqual(Object.keys(body).sort(), ['cost_control_url', 'error', 'limit', 'message', 'period', 'plan', 'requested', 'resets_at', 'unit', 'upgrade_url', 'used']);
});

test('alert thresholds are 80% and 100% of included spans', () => {
  assert.deepEqual([0, 79999, 80000, 99999, 100000, 250000].map(used => usageAlertLevel(used, 100000)), [0, 0, 80, 80, 100, 100]);
  assert.deepEqual([usageAlertLevel(7, 9), usageAlertLevel(8, 9), usageAlertLevel(9, 9)], [0, 80, 100]);
});

test('crossing 80% and 100% writes one notification each, once, and /api/usage lists them', async () => {
  const f = await fixture(); f.used(F80 - 10);
  assert.equal((await f.upload(9)).status, 201); assert.deepEqual(f.notices(), []);
  assert.equal((await f.upload(1)).status, 201);
  assert.deepEqual(f.notices().map(n => [n.sk, n.kind, n.level, n.period, n.plan, n.limit, n.used, n.spend_cap, n.email_status, n.created_at]), [['NOTICE#2026-11#USAGE#080', 'usage_80', 80, '2026-11', 'free', F, F80, true, 'not_in_plan', NOV]]);
  assert.equal(f.month().alert_level, 80);
  // More uploads between thresholds add nothing.
  for (let i = 0; i < 3; i++) assert.equal((await f.upload(50)).status, 201); assert.equal(f.notices().length, 1);
  f.used(F - 1); f.month().alert_level = 80; assert.equal((await f.upload(1)).status, 201);
  assert.deepEqual(f.notices().map(n => n.kind), ['usage_80', 'usage_100']); assert.equal(f.month().alert_level, 100);
  assert.equal((await f.upload(1)).status, 429); assert.equal(f.notices().length, 2);
  const body = await f.usage();
  assert.deepEqual(body.alerts, [{kind: 'usage_80', level: 80, period: '2026-11', used: F80, limit: F, email: 'not_in_plan', created_at: new Date(NOV * 1000).toISOString()}, {kind: 'usage_100', level: 100, period: '2026-11', used: F, limit: F, email: 'not_in_plan', created_at: new Date(NOV * 1000).toISOString()}]);
  // A new month starts clean.
  assert.deepEqual(await f.store.listUsageAlerts(tenant, '2026-12'), []); assert.equal((await f.store.listUsageAlerts(tenant, '2026-11')).length, 2);
});

test('one upload that jumps past both thresholds records the highest; a lost usage-row marker cannot duplicate a notice', async () => {
  const f = await fixture(); f.used(F80 - 50); assert.equal((await f.upload(100)).status, 201); assert.equal(f.notices().length, 1);
  const g = await fixture(); g.used(F - 50); assert.equal((await g.upload(50)).status, 201);
  assert.deepEqual(g.notices().map(n => n.kind), ['usage_100']); assert.equal(g.month().alert_level, 100);
  // The month forgot its level (as if the marker write was lost): the notice row itself is the idempotency key.
  delete f.month().alert_level; assert.equal((await f.upload(1)).status, 201); assert.equal(f.notices().length, 1); assert.equal(f.month().alert_level, 80);
  const again = await f.store.recordUsageAlert(tenant, {level: 80, period: '2026-11', plan: 'free', limit: F, used: F80 + 51, resets_at: DEC, spend_cap: true}); assert.equal(again.created, false); assert.equal(again.notice.used, F80 + 50);
  for (const bad of [{level: 50}, {period: '2026-13'}, {limit: 1.5}]) await assert.rejects(f.store.recordUsageAlert(tenant, {level: 80, period: '2026-11', plan: 'free', limit: F, used: 1, resets_at: DEC, ...bad}), code('invalid_usage_alert'));
});

test('racing uploads across a threshold produce exactly one notification', async () => {
  const f = await fixture(); f.used(F80 - 1);
  const results = await Promise.all([f.upload(1), f.upload(1), f.upload(1)]); assert.deepEqual(results.map(r => r.status), [201, 201, 201]);
  assert.equal(f.notices().length, 1); assert.equal(f.month().alert_level, 80); assert.equal(f.month().spans, F80 + 2);
});

test('concurrent uploads that reach 100% together still produce the 100% notification', async () => {
  // Each reservation alone computes one short of the allowance from the count it read; the committed total is the allowance.
  for (const [start, sizes, total] of [[F - 2, [1, 1], F], [F - 10, [3, 3, 4], F], [F - 3, [1, 1, 1], F]]) {
    const f = await fixture(); f.used(start); f.month().alert_level = 80;
    const results = await Promise.all(sizes.map(n => f.upload(n))); assert.deepEqual(results.map(r => r.status), sizes.map(() => 201));
    assert.equal(f.month().spans, total); assert.deepEqual(f.notices().map(n => [n.kind, n.used]), [['usage_100', F]]); assert.equal(f.month().alert_level, 100);
    assert.equal((await f.upload(1)).status, 429); assert.equal(f.notices().length, 1);
  }
  // With no 80% record at all (its write failed, or the spans arrived another way), 100% is still caught.
  { const m = await fixture(); m.used(F - 2); const r = await Promise.all([m.upload(1), m.upload(1)]); assert.deepEqual(r.map(x => x.status), [201, 201]); assert.deepEqual(m.notices().map(n => n.kind), ['usage_100']); assert.equal(m.month().alert_level, 100); }
  // The 80% crossing is reconciled the same way.
  for (const [start, sizes] of [[F80 - 2, [1, 1]], [F80 - 200, [100, 100, 100]]]) { const e = await fixture(); e.used(start); await Promise.all(sizes.map(n => e.upload(n))); assert.deepEqual(e.notices().map(n => n.kind), ['usage_80']); assert.equal(e.notices()[0].used >= F80, true); }
  // Same for a capped Pro account, and the committed read happens only close to a threshold that is not recorded yet.
  const pro = await fixture({plan: 'pro'}); pro.used(P - 2); pro.month().alert_level = 80;
  await Promise.all([pro.upload(1), pro.upload(1)]); assert.deepEqual(pro.notices().map(n => n.kind), ['usage_100']);
  const quiet = await fixture(); quiet.used(10); let reads = 0; const send = quiet.client.send.bind(quiet.client);
  quiet.client.send = async command => { if (command.name === 'GetCommand' && command.input.Key.sk === 'USAGE#2026-11') reads++; return send(command); };
  await quiet.reserve('low'); assert.equal(reads, 1);
  for (const [spans, recorded, expected] of [[F80 - 3002, 0, 1], [F80 - 3001, 0, 2], [F80 - 2, 0, 2], [F80 + 5000, 80, 1], [F - 3002, 80, 1], [F - 3001, 80, 2], [F - 1000, 100, 1], [F80 - 30000, 80, 1], [F80 + 5000, 0, 1], [F - 3001, 0, 2], [F - 1000, 0, 2]]) { quiet.used(spans); if (recorded) quiet.month().alert_level = recorded; reads = 0; await quiet.reserve('probe-' + spans + '-' + recorded); assert.equal(reads, expected, spans + '/' + recorded); }
  // A failed committed read never fails the reservation.
  quiet.used(F - 2000); quiet.month().alert_level = 80; let n = 0; quiet.client.send = async command => { if (command.name === 'GetCommand' && command.input.Key.sk === 'USAGE#2026-11' && ++n === 2) throw new Error('throttled'); return send(command); };
  assert.equal((await quiet.reserve('read-fails')).status, 'pending');
});

test('email is sent once, only on a plan with usage alert emails, with the SES path configured and an email-address sign-in', async () => {
  const owner = {provider: 'email', email: 'owner@example.com'};
  assert.deepEqual(PLANS.plans.filter(p => p.features.includes('usage_alerts')).map(p => p.id), ['base', 'pro', 'enterprise']);
  // Base is the cheapest plan with alert emails. Configured, email sign-in: sent once with the right content.
  const f = await fixture({plan: 'base', identity: {provider: 'email', email: 'owner@example.com'}}); f.email(); f.used(B80 - 1);
  assert.equal((await f.upload(1)).status, 201); assert.equal((await f.upload(1)).status, 201);
  assert.equal(f.mail.length, 1); assert.equal(f.mail[0].to, 'owner@example.com'); assert.equal(f.mail[0].subject, "SupaTrace: 80% of this month's spans used");
  assert.equal(f.mail[0].text.startsWith(`Your workspace has used ${commas(B80)} of the ${commas(B)} spans included this month (80%).\n\nThe count resets on 2026-12-01 (UTC).\n\nUsage: https://supatrace.dev/app/#usage`), true); assert.equal(commas(B80) + '/' + commas(B), '800,000/1,000,000');
  assert.equal(f.notices()[0].email_status, 'sent'); assert.equal((await f.usage()).alerts[0].email, 'sent');
  f.used(B - 1); f.month().alert_level = 80; await f.upload(1); assert.equal(f.mail.length, 2); assert.deepEqual(f.notices().map(n => n.email_status), ['sent', 'sent']); assert.match(f.mail[1].text, /New uploads are rejected until 2026-12-01 \(UTC\)\. Nothing extra is billed\./);
  // The other plans with the feature send too; Pro's 100% mail with the cap off says overage continues.
  for (const plan of ['pro', 'enterprise']) { const paid = await fixture({plan, identity: owner}), limit = planLimits(plan).spans_per_month; paid.email(); paid.root().spend_cap = false; paid.used(limit * 0.8 - 1);
    assert.equal((await paid.upload(1)).status, 201); assert.equal(paid.mail.length, 1); assert.equal(paid.notices()[0].email_status, 'sent'); assert.equal(paid.mail[0].text.includes(commas(limit * 0.8) + ' of the ' + commas(limit) + ' spans'), true);
    paid.used(limit - 1); paid.month().alert_level = 80; assert.equal((await paid.upload(1)).status, 201); assert.equal(paid.mail.length, 2); assert.match(paid.mail[1].text, plan === 'pro' ? /The spend cap is off, so uploads continue/ : /New uploads are rejected/); }
  // SSO sign-in also has an address.
  const sso = await fixture({plan: 'base', identity: {provider: 'sso', email: 'sso@example.com'}}); sso.email(); sso.used(B80 - 1); await sso.upload(1); assert.equal(sso.mail[0].to, 'sso@example.com');
  // Not configured: record only.
  const off = await fixture({plan: 'base', identity: {provider: 'email', email: 'owner@example.com'}}); off.used(B80 - 1); await off.upload(1); assert.equal(off.mail.length, 0); assert.equal(off.notices()[0].email_status, 'not_configured');
  // Configured but no address on file (GitHub sign-in), or a malformed one: record only, nothing sent.
  for (const identity of [undefined, {provider: 'github', email: 'spoof@example.com'}, {provider: 'email', email: 'not-an-address'}]) { const g = await fixture({plan: 'base', identity}); g.email(); g.used(B80 - 1); await g.upload(1); assert.equal(g.mail.length, 0); assert.equal(g.notices()[0].email_status, 'no_address'); }
  // A sender failure is recorded and never fails the upload.
  const bad = await fixture({plan: 'base', identity: {provider: 'email', email: 'owner@example.com'}}); bad.env.EMAIL_FROM = 'member@example.com'; bad.env.sendEmail = async () => { throw new Error('SES down'); }; bad.used(B80 - 1);
  assert.equal((await bad.upload(1)).status, 201); assert.equal(bad.notices()[0].email_status, 'failed');
  // A sender that never answers is cut off, and only after the batch was accepted: the upload still succeeds.
  const stalled = await fixture({plan: 'base', identity: {provider: 'email', email: 'owner@example.com'}}); stalled.env.EMAIL_FROM = 'member@example.com'; stalled.env.alertEmailTimeoutMs = 20; stalled.used(B80 - 1);
  let acceptedBeforeEmail = null; stalled.env.sendEmail = () => { acceptedBeforeEmail = [...stalled.client.items.values()].some(row => row.sk.startsWith('BATCH#') && row.status === 'accepted'); return new Promise(() => {}); };
  const started = Date.now(), slow = await stalled.upload(1); assert.equal(slow.status, 201); assert.equal(acceptedBeforeEmail, true); assert.equal(Date.now() - started < 2000, true);
  assert.equal(stalled.notices()[0].email_status, 'failed'); assert.equal(ALERT_EMAIL_TIMEOUT_MS, 3000);
  // A store failure while recording never fails the upload either.
  const broken = await fixture({plan: 'base'}); broken.used(B80 - 1); broken.env.store.recordUsageAlert = async () => { throw new Error('dynamo down'); }; assert.equal((await broken.upload(1)).status, 201);
  assert.deepEqual(await notifyUsageAlert(broken.env, broken.env.store, tenant, {level: 80, period: '2026-11', plan: 'base', limit: B, used: B80, resets_at: DEC, spend_cap: true}), {recorded: false, reason: 'failed'});
  // With the cap off, the 100% message says overage continues.
  assert.match(usageAlertMessage({level: 100, limit: P, used: P, resets_at: DEC, spend_cap: false}, ORIGIN).text, /The spend cap is off, so uploads continue and further spans are metered as overage until 2026-12-01 \(UTC\)\./);
});

test('Free has no alert emails: both notification rows are still written, nothing is sent, and the row says why', async () => {
  const owner = {provider: 'email', email: 'owner@example.com'};
  // This holds with the SES path configured and a deliverable address, and whatever the sign-in or email setup is.
  for (const [identity, configured] of [[owner, true], [{provider: 'sso', email: 'sso@example.com'}, true], [owner, false], [undefined, true]]) { const none = await fixture({identity}); if (configured) none.email(); none.used(F80 - 1);
    assert.equal((await none.upload(1)).status, 201); none.used(F - 1); none.month().alert_level = 80; assert.equal((await none.upload(1)).status, 201);
    assert.equal(none.mail.length, 0); assert.deepEqual(none.notices().map(n => [n.kind, n.plan, n.email_status]), [['usage_80', 'free', 'not_in_plan'], ['usage_100', 'free', 'not_in_plan']]); assert.deepEqual((await none.usage()).alerts.map(a => a.email), ['not_in_plan', 'not_in_plan']); }
});

test('the dashboard has the banner and the Cost control card, and the uploader explains the rejection', () => {
  const html = readFileSync(new URL('../public/app/index.html', import.meta.url), 'utf8'), app = readFileSync(new URL('../public/app/app.js', import.meta.url), 'utf8'), agent = readFileSync(new URL('../agent/upload.py', import.meta.url), 'utf8');
  assert.match(html, /<main id="workspace" tabindex="-1"><p id="usage-banner" class="usage-banner" role="status" aria-live="polite" hidden><\/p>/);
  assert.match(html, /<h2 id="cost-control-title">Cost control<\/h2><p id="spend-cap-state" role="status"/); assert.match(html, /<button id="spend-cap-toggle" type="button" hidden>/);
  assert.match(app, /api\('billing\/spend-cap',\{enabled:next\}\)/); assert.match(app, /spend_cap_reached:/); assert.match(agent, /\(429, 'spend_cap_reached'\): 'spend_cap'/);
});


test('organization usage alerts follow the current email owner and reject missing, closed or non-email owners', async () => {
  const f = await fixture({plan: 'base', identity: {provider: 'organization', owner_account: 'github-8'}}); f.email();
  const ownerKey = 'TENANT#github-8\0META', nextKey = 'TENANT#github-9\0META';
  f.client.items.set(ownerKey, {pk: 'TENANT#github-8', sk: 'META', provider: 'email', email: 'first@example.com'});
  f.used(B80 - 1); assert.equal((await f.upload(1)).status, 201); assert.equal(f.mail[0].to, 'first@example.com');
  f.client.items.set(nextKey, {pk: 'TENANT#github-9', sk: 'META', provider: 'sso', email: 'next@example.com'});
  f.root().owner_account = 'github-9'; f.used(B - 1); f.month().alert_level = 80;
  assert.equal((await f.upload(1)).status, 201); assert.equal(f.mail[1].to, 'next@example.com');
  for (const identity of [null, {provider: 'github', email: 'private@example.com'}, {provider: 'email', email: 'bad'}, {provider: 'email', email: 'closed@example.com', deleted_at: NOV}]) {
    const g = await fixture({plan: 'base', identity: {provider: 'organization', owner_account: 'github-8'}}); g.email();
    if (identity) g.client.items.set(ownerKey, {pk: 'TENANT#github-8', sk: 'META', ...identity});
    g.used(B80 - 1); assert.equal((await g.upload(1)).status, 201); assert.equal(g.mail.length, 0); assert.equal(g.notices()[0].email_status, 'no_address');
  }
});
