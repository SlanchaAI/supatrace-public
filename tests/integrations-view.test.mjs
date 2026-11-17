// In-app Integrations (GET /api/integrations and public/app/integrations.js) against the real handler and store logic.
// Sources are fed through the real ingest paths, so the id prefixes the view groups by are the ones those paths write.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {start as startHarness} from './harness.mjs';
// These tests invite read-only members, which needs the roles feature: fixture organizations are on Pro. tests/entitlements.test.mjs covers the gates.
const start = (options = {}) => startHarness({plan: 'pro', ...options});
import {digest} from '../src/aws-auth.mjs';
import {alphaProject} from '../src/alpha-projects.mjs';
import {planCustomerImport} from '../src/import-planning.mjs';
import {ImportJobLedger} from '../src/import-job-ledger.mjs';
import {INTEGRATION_SOURCES, integrationSource} from '../src/integrations.mjs';
import {validateIntegrations} from '../public/app/integrations.js';
import {INTEGRATIONS, pageUrl} from '../scripts/site-pages.mjs';
import {convertConnectorFile} from '../src/importers/connector-files.mjs';
import {fixtures} from './connector-fixtures.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
async function account(live, id) { let cookie = ''; const tenant = await live.signIn({addCookies: async value => { cookie = value.map(c => c.name + '=' + c.value).join('; '); }}, id); return {tenant, cookie}; }
const post = async (live, cookie, path, data) => { const r = await fetch(live.origin + '/api/' + path, {method: 'POST', headers: {cookie, origin: live.origin, 'content-type': 'application/json'}, body: JSON.stringify(data)}); assert.ok(r.ok, path + ' ' + r.status + ' ' + await r.clone().text()); return r.json(); };
const read = (live, cookie, query = '') => fetch(live.origin + '/api/integrations' + query, {headers: cookie ? {cookie} : {}});
const batch = (run, kind = 'note') => ({version: 1, batch_id: run + '-b', run_id: run, events: [{id: run + '-e', time: new Date().toISOString(), kind, name: 'synthetic', data: {}}]});
const by = body => Object.fromEntries(body.sources.map(source => [source.id, source]));

test('each real ingest path is counted under its own source, with error traces and receive times', async () => {
  const live = await start(); try {
    const {tenant, cookie} = await account(live), key = await live.writeKey(tenant), before = Date.now() - 2000;
    const empty = await (await read(live, cookie)).json();
    assert.deepEqual(empty.sources.map(s => [s.id, s.traces, s.error_traces, s.unknown_error_traces, s.first_received_at, s.last_received_at, s.last_error_trace_at]), INTEGRATION_SOURCES.map(s => [s.id, 0, 0, 0, null, null, null]));
    assert.deepEqual(empty.scanned, {traces: 0, truncated: false}); assert.deepEqual(empty.import_jobs, {scope: 'listed', job_control_available: false, server_pull_available: false, jobs: [], truncated: false});

    // OTLP receiver, two traces.
    for (const trace of ['0af7651916cd43dd8448eb211c80319c', '1bf7651916cd43dd8448eb211c80319c']) {
      const otlp = await fetch(live.origin + '/v1/traces', {method: 'POST', headers: {'content-type': 'application/json', 'x-supatrace-key': key}, body: JSON.stringify({resourceSpans: [{scopeSpans: [{spans: [{traceId: trace, spanId: '00f067aa0ba902b7', name: 'synthetic span', startTimeUnixNano: '1794685870000000000', endTimeUnixNano: '1794685871500000000'}]}]}]})});
      assert.equal(otlp.status, 200, await otlp.clone().text());
    }
    // Langfuse SDK ingest, one trace.
    const langfuse = await fetch(live.origin + '/api/public/ingestion', {method: 'POST', headers: {'content-type': 'application/json', authorization: 'Basic ' + Buffer.from('pk-supatrace:' + key).toString('base64')}, body: JSON.stringify({batch: [{id: 'e1', type: 'trace-create', timestamp: '2026-11-14T20:00:00.000Z', body: {id: 'checkout-trace', name: 'checkout'}}]})});
    assert.equal(langfuse.status, 207, await langfuse.clone().text());
    // A converted provider export, uploaded as the local importers do.
    const converted = convertConnectorFile(JSON.stringify(fixtures.langsmith()), {format: 'langsmith', namespace: 'synthetic-import'});
    for (const item of converted.batches) await live.upload(key, item);
    // Plain uploads: three traces, one holding an error event; and a Claude hook trace.
    for (const run of ['app-1', 'app-2']) await live.upload(key, batch(run));
    await live.upload(key, batch('app-3', 'error')); await live.upload(key, batch('claude-' + 'a'.repeat(40)));

    const response = await read(live, cookie); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json(), sources = by(body); validateIntegrations(body);
    assert.deepEqual(Object.fromEntries(body.sources.map(s => [s.id, s.traces])), {otlp: 2, langfuse: 1, 'import-files': new Set(converted.batches.map(b => b.run_id)).size, 'claude-hooks': 1, uploads: 3});
    assert.ok(sources['import-files'].traces >= 1);
    assert.equal(body.scanned.traces, body.sources.reduce((n, s) => n + s.traces, 0)); assert.equal(body.scanned.truncated, false);
    assert.equal(sources.uploads.error_traces, 1); assert.ok(sources.uploads.last_error_trace_at); assert.equal(sources.otlp.error_traces, 0); assert.equal(sources.otlp.last_error_trace_at, null);
    for (const source of body.sources) { assert.ok(Date.parse(source.last_received_at) >= before && Date.parse(source.last_received_at) <= Date.now() + 2000, source.id); assert.ok(source.first_received_at <= source.last_received_at); }
    for (const source of body.sources) assert.equal(source.unknown_error_traces, 0);
    // A run stored before error summaries were kept has no has_error: it is reported as unknown, never as error-free.
    const legacy = (await live.store.listRuns(tenant, {limit: 100})).items.find(row => row.run_id === 'app-1'), {has_error, ...withoutSummary} = legacy;
    await live.store._send('PutCommand', {Item: withoutSummary});
    const after = by(await (await read(live, cookie)).json()).uploads; assert.deepEqual([after.traces, after.error_traces, after.unknown_error_traces], [3, 1, 1]);
    assert.equal(body.workspace_id, tenant); assert.equal(body.environment_id, 'default'); assert.equal(body.directory, '/integrations/');
    // The response holds counts and times only: no key, no trace id, no event content.
    const text = JSON.stringify(body); for (const secret of [key, 'checkout-trace', 'app-1', '0af7651916cd43dd8448eb211c80319c']) assert.ok(!text.includes(secret), secret);
  } finally { await live.close(); }
});

test('integrations are scoped to the signed-in account, the selected workspace and the selected environment', async () => {
  const live = await start(); try {
    const owner = await account(live, 4242), admin = await account(live, 5252), viewer = await account(live, 6262), stranger = await account(live, 7272);
    await live.upload(await live.writeKey(owner.tenant), batch('owner-run'));
    assert.equal((await read(live, '')).status, 401);
    assert.equal(by(await (await read(live, stranger.cookie)).json()).uploads.traces, 0, 'another account sees its own workspace only');
    assert.equal((await read(live, stranger.cookie, '?workspace=' + owner.tenant)).status, 403);
    // Members of a shared workspace read the same source state; import jobs stay with the owner.
    await post(live, owner.cookie, 'workspaces', {name: 'Shared'});
    for (const [member, role] of [[admin, 'admin'], [viewer, 'viewer']]) { const invite = await post(live, owner.cookie, 'workspaces/invite', {recipient_id: member.tenant, role}); await post(live, member.cookie, 'workspaces/accept', {workspace_id: owner.tenant, token: invite.token}); }
    for (const member of [admin, viewer]) {
      const shared = await (await read(live, member.cookie, '?workspace=' + owner.tenant)).json();
      assert.equal(by(shared).uploads.traces, 1); assert.equal(shared.workspace_id, owner.tenant); assert.deepEqual(shared.import_jobs.jobs, []); assert.equal(shared.import_jobs.scope, 'own_default_environment_only');
    }
    // Another environment has its own traces.
    await post(live, owner.cookie, 'environments', {id: 'production', name: 'Production'});
    const token = randomBytes(32).toString('base64url'), setup = await post(live, owner.cookie, 'setup/start?project=' + alphaProject(owner.tenant).id + '&environment=production', {key_hash: digest(token)});
    await post(live, owner.cookie, 'setup/approve?environment=production', {user_code: setup.user_code});
    for (const run of ['otlp.' + 'c'.repeat(32), 'prod-app']) { const raw = JSON.stringify(batch(run)), r = await fetch(live.origin + '/api/batches?environment=production', {method: 'POST', headers: {'content-type': 'application/json', 'x-supatrace-key': token, 'x-amz-content-sha256': digest(raw)}, body: raw}); assert.equal(r.status, 201, await r.clone().text()); }
    const production = await (await read(live, owner.cookie, '?environment=production')).json(), standard = await (await read(live, owner.cookie)).json();
    assert.deepEqual([by(production).otlp.traces, by(production).uploads.traces, production.environment_id, production.import_jobs.scope], [1, 1, 'production', 'own_default_environment_only']);
    assert.deepEqual([by(standard).otlp.traces, by(standard).uploads.traces], [0, 1]);
    // Read-only route: nothing but GET, and no personal-access-token route reaches it.
    assert.notEqual((await fetch(live.origin + '/api/integrations', {method: 'POST', headers: {cookie: owner.cookie, origin: live.origin, 'content-type': 'application/json'}, body: '{}'})).status, 200);
    assert.equal((await fetch(live.origin + '/api/v1/integrations', {headers: {authorization: 'Bearer stpat_' + 'a'.repeat(43)}})).status, 404);
  } finally { await live.close(); }
});

test('import jobs from the ledger are listed for the owner with their real state, newest first', async () => {
  const live = await start({importJobControl: true}); try {
    const owner = await account(live, 4242), other = await account(live, 5252), project = alphaProject(owner.tenant).id, ledger = new ImportJobLedger(live.store, {objects: {}});
    const plan = n => ({provider: 'langfuse', origin: 'https://cloud.langfuse.com', sourceProject: 'synthetic-source', environment: 'synthetic-production', namespace: 'synthetic-job', from: `2026-10-0${n}T00:00:00Z`, to: `2026-10-0${n + 1}T00:00:00Z`, maxRows: 10, maxPages: 2, pageSize: 5, maxBytes: 100000, maxRetries: 0});
    const first = await ledger.create(owner.tenant, plan(1), planCustomerImport(plan(1), project).plan.fingerprint);
    const second = await ledger.create(owner.tenant, plan(2), planCustomerImport(plan(2), project).plan.fingerprint);
    await ledger.cancel(owner.tenant, second.job_id);
    const body = await (await read(live, owner.cookie)).json(); validateIntegrations(body);
    assert.equal(body.import_jobs.job_control_available, true); assert.equal(body.import_jobs.scope, 'listed'); assert.equal(body.import_jobs.truncated, false);
    assert.deepEqual(body.import_jobs.jobs.map(job => job.id).sort(), [first.job_id, second.job_id].sort());
    const jobs = Object.fromEntries(body.import_jobs.jobs.map(job => [job.id, job])), status = async id => (await ledger.status(owner.tenant, id)).status;
    assert.equal(jobs[first.job_id].status, await status(first.job_id)); assert.equal(jobs[first.job_id].status, 'awaiting_bindings'); assert.equal(jobs[first.job_id].state, 'in_progress');
    assert.equal(jobs[second.job_id].status, await status(second.job_id)); assert.equal(jobs[second.job_id].state, 'finished');
    for (const job of body.import_jobs.jobs) { assert.equal(job.kind, 'import_job'); assert.ok(Date.parse(job.created_at) <= Date.now()); assert.deepEqual(job.progress, {pages: 0, rows: 0, staged_batches: 0, verified_batches: 0}); assert.deepEqual(Object.keys(job).sort(), ['created_at', 'id', 'kind', 'progress', 'provider', 'state', 'status']); }
    // The job's source scope (project, namespace, window) is not echoed here, and another account sees none of it.
    const text = JSON.stringify(body); for (const hidden of ['synthetic-source', 'synthetic-job', 'cloud.langfuse.com']) assert.ok(!text.includes(hidden), hidden);
    assert.deepEqual((await (await read(live, other.cookie)).json()).import_jobs.jobs, []);
  } finally { await live.close(); }
});

test('every source links to a guide that exists, and the view is wired into the dashboard', () => {
  assert.equal(integrationSource('otlp.abc').id, 'otlp'); assert.equal(integrationSource('lf.x').id, 'langfuse'); assert.equal(integrationSource('imp.x').id, 'import-files'); assert.equal(integrationSource('claude-x').id, 'claude-hooks');
  for (const id of ['otlpx', 'my-run', 'LF.x', '', null]) assert.equal(integrationSource(id).id, 'uploads');
  const hrefs = new Set([...INTEGRATIONS.flatMap(group => group.items.map(item => item.href)), '/docs/quickstart/']);
  for (const source of INTEGRATION_SOURCES) {
    assert.ok(hrefs.has(source.guide), source.id + ' guide is one the public directory links to');
    const [path, anchor] = source.guide.split('#'), file = pageUrl(path.slice(1) + 'index.html'); assert.ok(existsSync(file), source.guide);
    if (anchor) assert.match(readFileSync(file, 'utf8'), new RegExp('id="' + anchor + '"'), source.guide);
  }
  assert.ok(existsSync(pageUrl('integrations/index.html')));
  const app = readFileSync(repo + 'public/app/app.js', 'utf8'), view = readFileSync(repo + 'public/app/integrations.js', 'utf8');
  assert.match(app, /^import '\.\/integrations\.js';$/m);
  // app.js routes to every section in #workspace, registered before the first route is shown.
  const register = "if(section.dataset.view&&!views.includes(section.dataset.view))views.push(section.dataset.view);";
  assert.ok(app.includes(register) && app.indexOf(register) < app.lastIndexOf('\nshowView();'), 'self-mounted views are registered before the first route is shown');
  assert.match(view, /^if \(typeof document !== 'undefined'\) mountIntegrations\(document\);$/m);
  assert.ok(view.includes('data-nav="integrations"') && view.includes('id="view-integrations"'), 'the proof grep in issue #94 matches'); assert.match(view, /href="\/integrations\/"/);
  // A malformed body is refused rather than rendered.
  const good = {sources: [{id: 'otlp', name: 'OTLP', note: 'n', kind: 'ingest', guide: '/docs/x/#y', traces: 2, error_traces: 1, unknown_error_traces: 1, first_received_at: null, last_received_at: '2026-11-14T00:00:00Z', last_error_trace_at: null}], scanned: {traces: 2, truncated: false}, import_jobs: {jobs: []}};
  assert.equal(validateIntegrations(good), good);
  for (const broken of [{}, {...good, sources: []}, {...good, sources: [{...good.sources[0], traces: -1}]}, {...good, sources: [{...good.sources[0], error_traces: 3}]}, {...good, sources: [{...good.sources[0], unknown_error_traces: 2}]}, {...good, sources: [{...good.sources[0], unknown_error_traces: undefined}]}, {...good, sources: [{...good.sources[0], guide: 'https://evil.example/'}]}, {...good, sources: [{...good.sources[0], guide: 'javascript:alert(1)'}]}, {...good, scanned: {traces: 2}}, {...good, import_jobs: {jobs: [{id: 'x'}]}}]) assert.throws(() => validateIntegrations(broken), /invalid_response/);
});
