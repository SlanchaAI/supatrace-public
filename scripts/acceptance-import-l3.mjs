// L3 rehearsal: the real Agents UI drives in-app Langfuse import (plan, exact review, consent, keys, Start)
// against a fake Langfuse source that the server-side fetch reaches. Real handlers, store, importer and UI.
// Usage: node scripts/acceptance-import-l3.mjs <repoDir=.> <outDir=test-artifacts/langfuse-local>
// Writes receipt.json + screenshots. Source is SYNTHETIC; this is not a real Langfuse Cloud import.
import {mkdirSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const [repoArg = '.', outArg = 'test-artifacts/langfuse-local'] = process.argv.slice(2);
const repo = resolve(repoArg), out = resolve(outArg); mkdirSync(out, {recursive: true});
const imp = p => import(pathToFileURL(join(repo, p)).href);
const {start} = await imp('tests/harness.mjs'), {launch} = await imp('tests/browser.mjs');
const {composeServerPullController} = await imp('src/import-composition.mjs');

const receipt = {kind: 'synthetic-loopback', source_kind: 'fake-langfuse-in-process', started: new Date().toISOString(), steps: []};
let failed = false;
const step = (name, ok, detail = {}) => { receipt.steps.push({name, ok, ...detail}); console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) failed = true; };

const spec = {source: 'synthetic-pull', trace: 'trace-l3', env: 'synthetic', ns: 'l3-rehearsal'};
const row = (id, parent, name) => ({id, traceId: spec.trace, projectId: spec.source, environment: spec.env, parentObservationId: parent, name, type: 'SPAN',
  startTime: '2026-10-01T12:00:00Z', endTime: '2026-10-01T12:00:01Z', input: {text: 'SYNTHETIC_INPUT ' + id}, output: {text: 'SYNTHETIC_OUTPUT ' + id}});
const pages = [[row('root', null, 'parent')], [row('child', 'root', 'child')]];
let sourceCalls = 0;
const provider = async url => {
  sourceCalls++;
  const u = new URL(url);
  if (u.pathname.endsWith('/projects')) return Response.json({data: [{id: spec.source}]});
  const cursor = u.searchParams.get('cursor'), i = cursor ? Number(cursor) : 0;
  return Response.json({data: pages[i], meta: {cursor: i + 1 < pages.length ? String(i + 1) : null}});
};

const live = await start({google: true, configureEnvironment: async env => {
  Object.assign(env, composeServerPullController(JSON.stringify({mode: 'bounded-server-pull-v1', origin: 'https://supatrace.dev'}),
    {store: env.store, objects: env.objects, origins: ['https://supatrace.dev'], fetchImpl: async (url, init) => provider(url, init)}));
}});
const browser = await launch();
const context = await browser.newContext({viewport: {width: 1280, height: 900}});
await context.route(/^(?!http:\/\/127\.0\.0\.1)/, r => r.abort());
const page = await context.newPage(); const errors = [];
page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
try {
  await live.signIn(context, 8181);
  await page.goto(live.origin + '/app/#agents'); await page.locator('#shell:not([hidden])').waitFor();
  const values = {'import-source': spec.source, 'import-trace': spec.trace, 'import-environment': spec.env, 'import-namespace': spec.ns,
    'import-from': '2026-10-01T00:00', 'import-to': '2026-10-02T00:00', 'import-rows': '10', 'import-pages': '3', 'import-page-size': '1', 'import-bytes': '100000'};
  for (const [id, v] of Object.entries(values)) await page.fill('#' + id, v);
  await page.getByRole('button', {name: 'Review import plan', exact: true}).click();
  await page.waitForFunction(() => !document.querySelector('#import-consent-review').disabled, null, {timeout: 20000});
  step('plan accepted, no source call yet', sourceCalls === 0);
  await page.getByRole('button', {name: 'Request exact scope review'}).click();
  await page.waitForFunction(() => !document.querySelector('#import-consent-accept').disabled, null, {timeout: 20000});
  await page.check('#import-consent-accept');
  await page.click('#import-consent-confirm');
  await page.waitForFunction(() => !document.querySelector('#import-start').disabled, null, {timeout: 20000});
  step('exact review + explicit consent enable Start', true);
  await page.screenshot({path: join(out, 'l3-1-consent.png'), fullPage: true});
  await page.fill('#import-public-key', 'synthetic-public-key'); await page.fill('#import-secret-key', 'synthetic-secret-key');
  await page.click('#import-start');
  await page.waitForFunction(() => /Import stored and read back/.test(document.getElementById('import-consent-status')?.textContent || ''), null, {timeout: 120000});
  step('Start completes: stored and read back', true, {sourceCalls});
  const keysCleared = await page.evaluate(() => document.getElementById('import-secret-key').value === '' && document.getElementById('import-public-key').value === '');
  step('keys cleared from the page after Start', keysCleared);
  await page.screenshot({path: join(out, 'l3-2-complete.png'), fullPage: true});

  // Readback through the same API the UI uses, then compare to the source rows.
  const get = async p => page.evaluate(async path => (await (await fetch(path)).json()), p);
  const runs = await get('/api/runs'); const run = (runs.runs || [])[0];
  step('imported run is visible', !!run, {runs: (runs.runs || []).length});
  const events = [];
  const readAll = async runId => { const all = []; let after = null; for (let i = 0; i < 50; i++) { const e = await get('/api/events?run=' + encodeURIComponent(runId) + (after ? '&after=' + encodeURIComponent(after) : '')); all.push(...(e.events || [])); if (!e.next) break; after = e.next; } return all; };
  for (const r of runs.runs || []) events.push(...await readAll(r.id));
  receipt.debug = {runs: (runs.runs || []).map(r => ({id: r.id, events: r.event_count})), sample: events.slice(0, 2).map(e => JSON.stringify(e).slice(0, 400))};
  const src = pages.flat();
  step('destination event count equals source row count', events.length === src.length, {source: src.length, destination: events.length});
  const obs = events.map(e => e.data?.observation).filter(Boolean);
  const byName = n => obs.find(o => o.name === n);
  const idsPresent = src.every(r => !!byName(r.name)) && new Set(obs.map(o => o.id)).size === src.length;
  step('every source observation is present exactly once (importer pseudonymizes ids)', idsPresent, {names: obs.map(o => o.name)});
  const parentLink = !!byName('parent') && !!byName('child') && byName('parent').parentObservationId === null && byName('child').parentObservationId === byName('parent').id;
  step('child.parentObservationId equals the imported parent id (relationship preserved)', parentLink);
  const contentKept = obs.every(o => /SYNTHETIC_INPUT/.test(JSON.stringify(o.input)) && /SYNTHETIC_OUTPUT/.test(JSON.stringify(o.output)));
  step('input and output content carried over as consented', contentKept);
  receipt.source = {count: src.length}; receipt.destination = {count: events.length};
  receipt.relationships_match = parentLink && idsPresent && events.length === src.length;
  receipt.teardown = true; // in-process fake source and in-memory store: nothing to tear down
  // Re-read only: Start is terminal after completion, so replay is covered by server-pull unit tests, not here.
  const runs2 = await get('/api/runs'); const ev2 = {events: []}; for (const r of runs2.runs || []) ev2.events.push(...await readAll(r.id));
  step('re-read is stable (same run and event counts)', (ev2.events || []).length === events.length && (runs2.runs || []).length === (runs.runs || []).length);
  step('no page errors', errors.length === 0, {errors});
} catch (e) {
  step('script error', false, {error: String(e).slice(0, 400)});
} finally {
  await context.close(); await browser.close(); await live.close();
  receipt.finished = new Date().toISOString(); receipt.ok = !failed;
  writeFileSync(join(out, 'receipt.json'), JSON.stringify(receipt, null, 1) + '\n');
  process.exit(failed ? 1 : 0);
}
