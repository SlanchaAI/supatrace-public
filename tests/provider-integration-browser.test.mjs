// One disposable local workspace; no provider account, real grant or user file.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';
import {runPrivateBraintrustImport} from '../src/importers/private-braintrust-runtime.mjs';
import {runPrivateLangsmithImport} from '../src/importers/private-langsmith-runtime.mjs';
import * as bt from './braintrust-fixtures.mjs';
import * as ls from './langsmith-fixtures.mjs';

function upload(config) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [new URL('connector_upload_driver.py', import.meta.url).pathname], {stdio: ['pipe', 'pipe', 'pipe']});
    let output = '', error = '';
    child.stdout.on('data', part => output += part); child.stderr.on('data', part => error += part);
    child.on('error', reject); child.on('close', code => code ? reject(Error(error)) : resolve(JSON.parse(output)));
    child.stdin.end(JSON.stringify(config));
  });
}
async function prepare(page, provider, spec) {
  for (const [field, value] of Object.entries({source: spec.sourceProject, namespace: spec.namespace})) await page.fill('#' + provider + '-' + field, value);
  if (provider === 'braintrust') await page.fill('#braintrust-roots', spec.rootSpanIds.join('\n'));
  else {
    for (const [field, value] of Object.entries({workspace: spec.sourceWorkspace, from: spec.minStartTime, to: spec.maxStartTime, traces: spec.traceIds.join('\n')})) await page.fill('#langsmith-' + field, value);
  }
  await page.locator('#' + provider + '-form button[type=submit]').click();
  await page.check('#' + provider + '-reviewed');
}
async function saveSpec(page, provider, dir) {
  const pending = page.waitForEvent('download'); await page.locator('#' + provider + '-download').click();
  const download = await pending, path = join(dir, download.suggestedFilename()); await download.saveAs(path);
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('both provider forms preserve independent scopes through one account archive and page suspension', {timeout: 60000}, async () => {
  const live = await start(), browser = await launch(), dir = mkdtempSync(join(tmpdir(), 'provider-integration-'));
  const context = await browser.newContext({viewport: {width: 1280, height: 900}, acceptDownloads: true});
  await context.route(/^(?!http:\/\/127\.0\.0\.1)/, route => route.abort());
  await context.addInitScript(() => Object.defineProperty(window, 'showSaveFilePicker', {value: undefined}));
  const page = await context.newPage(), errors = [], unexpected = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('request', request => {if (/braintrust\.dev|smith\.langchain\.com|\/api\/imports\//.test(request.url())) unexpected.push(request.url());});
  try {
    const tenant = await live.signIn(context), key = await live.writeKey(tenant);
    await page.goto(live.origin + '/app/#agents', {waitUntil: 'networkidle'});
    await page.locator('#shell:not([hidden])').waitFor();
    await prepare(page, 'braintrust', bt.spec); await prepare(page, 'langsmith', ls.spec);
    const braintrustPreview = await page.locator('#braintrust-spec').textContent();
    await page.check('#langsmith-content');
    assert.equal(await page.locator('#langsmith-output').isHidden(), true);
    assert.equal(await page.locator('#braintrust-spec').textContent(), braintrustPreview);
    assert.equal(await page.locator('#braintrust-download').isEnabled(), true);
    await prepare(page, 'langsmith', ls.spec);
    const braintrust = await saveSpec(page, 'braintrust', dir), langsmith = await saveSpec(page, 'langsmith', dir);
    assert.equal(braintrust.content, 'metadata'); assert.equal(langsmith.content, 'include');
    assert.equal(braintrust.destinationProject, langsmith.destinationProject);
    assert.deepEqual(braintrust.rootSpanIds, bt.spec.rootSpanIds); assert.deepEqual(langsmith.traceIds, ls.spec.traceIds);
    assert.deepEqual(unexpected, []);
    if (process.env.SUPATRACE_PROVIDER_SCREENSHOT_DIR) for (const provider of ['braintrust', 'langsmith']) {
      await page.locator('.' + provider + '-card').screenshot({path: join(process.env.SUPATRACE_PROVIDER_SCREENSHOT_DIR, provider + '-integrated.png')});
    }
    const project = braintrust.destinationProject, expected = new Map();
    const btDirectory = join(dir, 'braintrust'), lsDirectory = join(dir, 'langsmith');
    const rows = [ls.row(), ls.row(ls.child)];
    const cases = [
      {directory: btDirectory, spec: braintrust, run: runPrivateBraintrustImport, fake: bt.fakeOptions([{data: {data: [bt.row('child')]}, headers: {'x-bt-cursor': 'next'}}, {data: {data: [bt.row()]}}])},
      {directory: lsDirectory, spec: langsmith, run: runPrivateLangsmithImport, fake: ls.fakeOptions([{items: [rows[1]], next_cursor: 'next'}, {items: [rows[0]], next_cursor: null}])}
    ];
    for (const item of cases) {
      const result = await item.run(item.spec, {...item.fake.options, directory: item.directory});
      const receipt = result.stageReceipt, manifest = JSON.parse(readFileSync(join(item.directory, 'pending/import-manifest.json'), 'utf8'));
      for (const batch of manifest.batches) {
        const source = JSON.parse(readFileSync(join(item.directory, 'converted', batch.batch_id + '.json'), 'utf8'));
        expected.set(source.run_id, [...(expected.get(source.run_id) ?? []), ...source.events]);
      }
      const scope = {origin: 'https://supatrace.dev', project_id: project, fingerprint: receipt.fingerprint, conversion_hash: receipt.conversionHash, manifest_hash: receipt.manifestHash, max_batches: 1000, max_requests: 1000, max_total_bytes: 20 * 1024 * 1024, total_timeout_ms: 30000};
      const config = {directory: item.directory, scope, local_origin: live.origin, key};
      assert.equal((await upload(config)).all_batches_acknowledged, true);
      assert.equal((await upload(config)).transport_requests_attempted, 0);
    }
    // Shared private-workspace code must not permit one provider to resume another.
    const wrongWorkspace = ls.fakeOptions([]);
    await assert.rejects(runPrivateLangsmithImport(langsmith, {...wrongWorkspace.options, directory: btDirectory}), /workspace_scope_mismatch/);
    assert.equal(wrongWorkspace.requests.length, 0);
    await page.goto(live.origin + '/app/#traces', {waitUntil: 'networkidle'});
    await page.locator('#export-account').click(); await page.locator('#download-account').waitFor({state: 'visible'});
    const pending = page.waitForEvent('download'); await page.locator('#download-account').click();
    const archive = JSON.parse(readFileSync(await (await pending).path(), 'utf8'));
    assert.equal(archive.run_count, 2); assert.equal(archive.event_count, 4); assert.equal(archive.project_id, project);
    for (const run of archive.runs) assert.deepEqual(run.events, expected.get(run.metadata.id));
    const all = archive.runs.flatMap(run => run.events);
    assert.equal(all.filter(event => JSON.stringify(event).includes(bt.marker)).length, 2, 'only explicit LangSmith content retains the private marker');
    assert.equal(all.filter(event => event.data.span.parentSpanId === 'root').length, 1);
    assert.equal(all.filter(event => event.data.span.parentSpanId === ls.root).length, 1);
    await page.goto(live.origin + '/app/#agents', {waitUntil: 'networkidle'});
    await prepare(page, 'braintrust', bt.spec); await prepare(page, 'langsmith', ls.spec);
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    for (const provider of ['braintrust', 'langsmith']) {
      assert.equal(await page.locator('#' + provider + '-output').isHidden(), true);
      assert.equal(await page.locator('#' + provider + '-spec').textContent(), '');
      assert.equal(await page.locator('#' + provider + '-download').isDisabled(), true);
      assert.equal(await page.locator('#' + provider + '-copy').isDisabled(), true);
      assert.equal(await page.locator('#' + provider + '-reviewed').isChecked(), false);
    }
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  } finally {await context.close(); await browser.close(); await live.close(); rmSync(dir, {recursive: true, force: true});}
});
