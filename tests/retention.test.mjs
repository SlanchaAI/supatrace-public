import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {DynamoMetadataStore} from '../src/dynamodb-store.mjs';
import {MemoryDynamo, commandClasses} from './memory-dynamo.mjs';
import {PLAN_LIMITS, planLimits} from '../src/plan-limits.mjs';
import {handle} from '../src/aws-api.mjs';
import {digest} from '../src/aws-auth.mjs';
import {environmentStore} from '../src/workspaces.mjs';
import {validateUsage} from '../public/app/usage-data.js';

const tenant = 'github-7', START = Date.UTC(2026, 10, 14, 12) / 1000, DAY = 86400;
const sha = value => createHash('sha256').update(value).digest('hex');
// Retention windows come from the plan table; the first test pins their literal values.
const FREE = planLimits('free').retention_days, BASE = planLimits('base').retention_days, PRO = planLimits('pro').retention_days, ENTERPRISE = planLimits('enterprise').retention_days;
async function fixture() {
  let now = START; const client = new MemoryDynamo(), saved = new Map();
  const store = new DynamoMetadataStore({client, commands: commandClasses(), tableName: 'synthetic', now: () => now});
  await store.getOrCreateTenant(7);
  const root = () => client.items.get('TENANT#' + tenant + '\0META');
  // Reserve, store and accept one batch the way POST /api/batches does.
  const upload = async (run, batch, target = store, trace = true) => {
    const raw = JSON.stringify({version: 1, batch_id: batch, run_id: run, events: [{id: 'e-' + batch, time: '2026-11-14T00:00:00Z', kind: 'note', name: 'Synthetic', data: {safe: true}}]}), hash = digest(raw);
    const record = await target.reserveBatch(tenant, {batch_id: batch, run_id: run, request_hash: hash, byte_count: Buffer.byteLength(raw), event_count: 1});
    saved.set(record.object_key, raw); await target.acceptReservedBatch(tenant, batch, hash, trace ? {writer: sha('w'), started_at: 1, ended_at: 2, has_error: false} : null); return record;
  };
  const env = {ENABLED: true, APP_ORIGIN: 'https://supatrace.dev', GITHUB_CLIENT_ID: 'synthetic', GITHUB_CLIENT_SECRET: 'synthetic', store, objects: {get: async key => saved.get(key)}};
  // Sessions are short-lived and these tests move the clock by months: sign in again for each read.
  let sessions = 0;
  const api = async path => { const fresh = String(++sessions).padStart(43, 'e'); await store.createSession(digest(fresh), tenant); const response = await handle(new Request('https://supatrace.dev/api/' + path, {headers: {cookie: '__Host-supatrace=' + fresh}}), env); return {status: response.status, body: await response.json()}; };
  const runs = async () => (await store.listRuns(tenant, {limit: 100})).items.map(row => row.run_id);
  const batches = async run => (await store.listAcceptedBatchIndexes(tenant, run, {limit: 100})).items.map(row => row.batch_id);
  return {store, client, saved, root, upload, api, runs, batches, env, at: value => now = value};
}

test('accept stamps the plan retention on the batch marker, index row and run row', async () => {
  assert.deepEqual([FREE, BASE, PRO, ENTERPRISE], [7, 30, 90, 365]);
  const f = await fixture(); await f.upload('run1', 'b1');
  const expires = START + FREE * DAY, rows = [...f.client.items.values()];
  const marker = rows.find(r => r.sk === 'BATCH#b1'), index = rows.find(r => r.pk === 'TENANT#' + tenant + '#RUN#run1'), run = rows.find(r => r.sk === 'RUN#run1');
  for (const row of [marker, index]) assert.deepEqual([row.retention_days, row.retention_expires_at], [PLAN_LIMITS.plans.free.retention_days, expires]);
  assert.equal(run.retention_expires_at, expires);
  assert.equal(marker.status, 'accepted');
  // A retried accept is a no-op and does not move the expiry.
  f.at(START + DAY); await f.store.acceptReservedBatch(tenant, 'b1', marker.request_hash, null); assert.equal(f.client.items.get(marker.pk + '\0' + marker.sk).retention_expires_at, expires);
});

test('retention days follow the plan at accept time; a later plan change does not rewrite stored data', async () => {
  const f = await fixture(); await f.upload('free-run', 'b1');
  f.root().plan_id = 'base'; await f.upload('base-run', 'b2'); f.root().plan_id = 'pro'; await f.upload('pro-run', 'b3'); f.root().plan_id = 'enterprise'; await f.upload('enterprise-run', 'b4');
  delete f.root().plan_id;
  const expiry = async run => (await f.store.listRuns(tenant, {limit: 100})).items.find(r => r.run_id === run).retention_expires_at, runs = async () => (await f.runs()).sort();
  assert.deepEqual([await expiry('free-run'), await expiry('base-run'), await expiry('pro-run'), await expiry('enterprise-run')], [START + FREE * DAY, START + BASE * DAY, START + PRO * DAY, START + ENTERPRISE * DAY]);
  f.at(START + FREE * DAY - 1); assert.deepEqual(await runs(), ['base-run', 'enterprise-run', 'free-run', 'pro-run']);
  f.at(START + FREE * DAY); assert.deepEqual(await runs(), ['base-run', 'enterprise-run', 'pro-run']);
  f.at(START + BASE * DAY - 1); assert.deepEqual(await runs(), ['base-run', 'enterprise-run', 'pro-run']);
  f.at(START + BASE * DAY); assert.deepEqual(await runs(), ['enterprise-run', 'pro-run']);
  f.at(START + PRO * DAY); assert.deepEqual(await runs(), ['enterprise-run']);
  f.at(START + ENTERPRISE * DAY - 1); assert.deepEqual(await runs(), ['enterprise-run']);
  f.at(START + ENTERPRISE * DAY); assert.deepEqual(await runs(), []);
});

test('expired data is hidden from list, read and export; unexpired and unstamped data is never touched', async () => {
  const GAP = 3; assert.ok(GAP < FREE);
  const f = await fixture(); await f.upload('old', 'old-1'); f.at(START + GAP * DAY); await f.upload('old', 'old-2'); await f.upload('new', 'new-1');
  // A run stored before retention stamping existed: no stamp on any of its rows.
  await f.upload('legacy', 'legacy-1');
  for (const row of f.client.items.values()) if (row.batch_id === 'legacy-1' || row.run_id === 'legacy') { delete row.retention_expires_at; delete row.retention_days; }
  const data = () => [...f.client.items.values()].filter(row => row.pk.startsWith('TENANT#' + tenant)).length, before = data(), objects = f.saved.size, reserved = f.root().used_bytes;
  f.at(START + FREE * DAY - 1); assert.deepEqual(await f.runs(), ['legacy', 'new', 'old']); assert.deepEqual(await f.batches('old'), ['old-1', 'old-2']);
  // End of the Free window: the first batch expires, the run stays listed because its newer batch is retained.
  f.at(START + FREE * DAY); assert.deepEqual(await f.runs(), ['legacy', 'new', 'old']); assert.deepEqual(await f.batches('old'), ['old-2']);
  let events = await f.api('events?run=old'); assert.equal(events.status, 200); assert.deepEqual(events.body.events.map(e => e.id), ['e-old-2']); assert.equal(events.body.next, null);
  // GAP days later everything uploaded on day GAP expires, and not a second earlier. Only the unstamped run remains.
  f.at(START + (FREE + GAP) * DAY - 1); assert.deepEqual(await f.runs(), ['legacy', 'new', 'old']); assert.deepEqual(await f.batches('old'), ['old-2']);
  f.at(START + (FREE + GAP) * DAY); assert.deepEqual(await f.runs(), ['legacy']); assert.deepEqual(await f.batches('old'), []); assert.deepEqual(await f.batches('legacy'), ['legacy-1']);
  events = await f.api('events?run=old'); assert.deepEqual([events.status, events.body.events, events.body.next], [200, [], null]);
  for (const path of ['runs', 'runs/page']) { const list = await f.api(path); assert.equal(list.status, 200); assert.deepEqual(list.body.runs.map(r => r.id), ['legacy']); assert.equal(list.body.runs[0].expires_at, null); }
  f.at(START + 4000 * DAY); assert.deepEqual(await f.runs(), ['legacy']);
  // Hidden, not deleted: no row or object was removed and reserved bytes are unchanged.
  assert.equal(data(), before); assert.equal(f.saved.size, objects); assert.equal(f.root().used_bytes, reserved);
});

test('appending to a run that holds pre-retention batches never gives that run an expiry', async () => {
  for (const trace of [true, false]) {
    const f = await fixture(); await f.upload('legacy', 'legacy-1', f.store, trace);
    for (const row of f.client.items.values()) if (row.batch_id === 'legacy-1' || row.run_id === 'legacy') { delete row.retention_expires_at; delete row.retention_days; }
    f.at(START + DAY); await f.upload('legacy', 'appended', f.store, trace);
    assert.equal('retention_expires_at' in [...f.client.items.values()].find(r => r.sk === 'RUN#legacy'), false);
    f.at(START + 31 * DAY); assert.deepEqual(await f.runs(), ['legacy']);
    // The stamped batch itself expired; the unstamped one is still read and exported.
    assert.deepEqual(await f.batches('legacy'), ['legacy-1']);
    assert.deepEqual((await f.api('events?run=legacy')).body.events.map(e => e.id), ['e-legacy-1']);
  }
});

test('the run expiry is the newest across its batches, even after a downgrade shortens later stamps', async () => {
  const f = await fixture(); f.root().plan_id = 'pro'; await f.upload('run', 'pro-batch');
  delete f.root().plan_id; f.at(START + DAY); await f.upload('run', 'free-batch');
  assert.equal([...f.client.items.values()].find(r => r.sk === 'RUN#run').retention_expires_at, START + PRO * DAY);
  f.at(START + (FREE + 1) * DAY - 1); assert.deepEqual(await f.batches('run'), ['pro-batch', 'free-batch']);
  f.at(START + (FREE + 1) * DAY); assert.deepEqual(await f.runs(), ['run']); assert.deepEqual(await f.batches('run'), ['pro-batch']);
  f.at(START + PRO * DAY - 1); assert.deepEqual(await f.runs(), ['run']); f.at(START + PRO * DAY); assert.deepEqual(await f.runs(), []);
});

test('an unstamped batch appended to a stamped run clears the run expiry', async () => {
  for (const trace of [true, false]) {
    const f = await fixture(); await f.upload('run', 'stamped', f.store, trace);
    // Reserve under the plan, then accept as a commercially enrolled account: that batch gets no stamp.
    const raw = JSON.stringify({version: 1, batch_id: 'unstamped', run_id: 'run', events: [{id: 'e-unstamped', time: '2026-11-14T00:00:00Z', kind: 'note', name: 'Synthetic', data: {safe: true}}]}), hash = digest(raw);
    const record = await f.store.reserveBatch(tenant, {batch_id: 'unstamped', run_id: 'run', request_hash: hash, byte_count: Buffer.byteLength(raw), event_count: 1}); f.saved.set(record.object_key, raw);
    f.root().commercial_managed = true; await f.store.acceptReservedBatch(tenant, 'unstamped', hash, trace ? {writer: sha('w'), started_at: 1, ended_at: 2, has_error: false} : null); delete f.root().commercial_managed;
    assert.equal([...f.client.items.values()].find(r => r.sk === 'RUN#run').retention_expires_at, null);
    f.at(START + DAY); await f.upload('run', 'later', f.store, trace);
    assert.equal([...f.client.items.values()].find(r => r.sk === 'RUN#run').retention_expires_at, null);
    f.at(START + 400 * DAY); assert.deepEqual(await f.runs(), ['run']); assert.equal((await f.store.getRun(tenant, 'run')).run_id, 'run'); assert.deepEqual(await f.batches('run'), ['unstamped']);
    assert.equal((await f.api('runs')).body.runs[0].expires_at, null);
  }
});

test('a run row that changed since it was read is re-read, not stamped from stale state', async () => {
  const f = await fixture(); await f.upload('run', 'first', f.store, false);
  const send = f.client.send.bind(f.client); let raced = false;
  // Between this accept's read of the run row and its transaction, another accept clears the run expiry.
  f.client.send = async command => { if (!raced && command.name === 'TransactWriteCommand' && command.input.TransactItems.some(i => i.Update?.Key.sk === 'RUN#run')) { raced = true; const row = [...f.client.items.values()].find(r => r.sk === 'RUN#run'); row.retention_expires_at = null; row.batch_count += 1; } return send(command); };
  await f.upload('run', 'second', f.store, false); f.client.send = send;
  const row = [...f.client.items.values()].find(r => r.sk === 'RUN#run'); assert.equal(raced, true); assert.equal(row.retention_expires_at, null); assert.equal(row.batch_count, 3);
});

test('a single-run read (the MCP bridge path) does not return an expired run', async () => {
  const f = await fixture(); await f.upload('run1', 'b1');
  assert.equal((await f.store.getRun(tenant, 'run1')).run_id, 'run1');
  f.at(START + FREE * DAY - 1); assert.equal((await f.store.getRun(tenant, 'run1')).run_id, 'run1');
  f.at(START + FREE * DAY); assert.equal(await f.store.getRun(tenant, 'run1'), null);
  assert.equal(await f.store.getRun(tenant, 'missing'), null);
  const mcp = readFileSync(new URL('../src/mcp-bridge-api.mjs', import.meta.url), 'utf8');
  assert.match(mcp, /env\.store\.getRun\(scope\.tenantId,id\);if\(row\)runs\.push/); assert.match(mcp, /env\.store\.listAcceptedBatchIndexes\(/);
});

test('readers that page one row at a time still advance past expired rows', async () => {
  const f = await fixture(); for (let i = 0; i < 6; i++) await f.upload('run', 'early-' + i);
  assert.ok(5 < FREE); f.at(START + 5 * DAY); await f.upload('run', 'late'); f.at(START + FREE * DAY);
  const page = await f.store.listAcceptedBatchIndexes(tenant, 'run', {limit: 1});
  assert.deepEqual(page.items.map(r => r.batch_id), ['late']);
  const events = await f.api('events?run=run'); assert.deepEqual(events.body.events.map(e => e.id), ['e-late']);
});

test('retention applies inside every environment and never crosses accounts', async () => {
  const f = await fixture(); await f.client.items.set('TENANT#' + tenant + '\0ENVIRONMENT#dev', {pk: 'TENANT#' + tenant, sk: 'ENVIRONMENT#dev', id: 'dev', name: 'Dev'});
  const dev = environmentStore(f.store, {owner: tenant, environment: 'dev'}); await f.upload('dev-run', 'd1', dev); await f.upload('default-run', 'p1');
  await f.store.getOrCreateTenant(8);
  assert.deepEqual((await dev.listRuns(tenant, {limit: 100})).items.map(r => r.run_id), ['dev-run']);
  assert.deepEqual((await f.store.listRuns('github-8', {limit: 100})).items, []);
  f.at(START + FREE * DAY - 1); assert.deepEqual((await dev.listRuns(tenant, {limit: 100})).items.map(r => r.run_id), ['dev-run']); assert.deepEqual(await f.runs(), ['default-run']);
  f.at(START + FREE * DAY); assert.deepEqual((await dev.listRuns(tenant, {limit: 100})).items, []); assert.deepEqual(await f.runs(), []);
});

test('/api/usage and run rows state the retention, and the dashboard shows and marks it', async () => {
  const f = await fixture(); await f.upload('run1', 'b1');
  const usage = (await f.api('usage')).body;
  assert.deepEqual(usage.retention, {days: FREE, enforcement: 'hidden_after_expiry', physical_deletion: false, applies_to: 'data_accepted_after_retention_stamping'});
  assert.equal(usage.plan_limits.retention_days, FREE);
  const view = validateUsage(usage); assert.equal(view.monthly.retention_days, FREE); assert.equal(view.monthly.retention_enforced, true);
  const {retention, ...older} = usage; assert.equal(validateUsage(older).monthly.retention_enforced, false);
  for (const bad of [{...retention, days: FREE + 1}, {...retention, physical_deletion: true}, {...retention, enforcement: 'deleted'}, 'thirty']) assert.throws(() => validateUsage({...usage, retention: bad}), /invalid_usage/);
  const run = (await f.api('runs')).body.runs[0]; assert.equal(run.expires_at, new Date((START + FREE * DAY) * 1000).toISOString());
  const html = readFileSync(new URL('../public/app/index.html', import.meta.url), 'utf8'), app = readFileSync(new URL('../public/app/app.js', import.meta.url), 'utf8');
  assert.match(html, /<h2>Data retention<\/h2><p id="usage-retention" role="status">/);
  assert.match(app, /Expired data is hidden, not yet deleted, and still counts toward reserved bytes\./); assert.match(app, /note\.className='hint expiring'/);
  const doc = readFileSync(new URL('../docs/retention.md', import.meta.url), 'utf8');
  for (const fact of ['RETENTION_ERASURE_MODE=execute', 'Account and organization deletion', 'Rows accepted before retention stamping have no automatic expiry']) assert.ok(doc.includes(fact), fact);
});

 test('usage and browser report physical expiry only when the production worker is enabled',async()=>{
 const f=await fixture();f.env.RETENTION_ERASURE_MODE='execute';const usage=(await f.api('usage')).body;assert.equal(usage.retention.physical_deletion,true);assert.equal(usage.retention.enforcement,'scheduled_physical_expiry');assert.equal(validateUsage(usage).monthly.retention_physical,true);
 for(const bad of [{...usage.retention,physical_deletion:false},{...usage.retention,enforcement:'hidden_after_expiry'}])assert.throws(()=>validateUsage({...usage,retention:bad}),/invalid_usage/);
 });
