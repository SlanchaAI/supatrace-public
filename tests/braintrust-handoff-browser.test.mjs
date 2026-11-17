// Synthetic loopback only. No user browser profile, source account or saved file.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';
import {runPrivateBraintrustImport} from '../src/importers/private-braintrust-runtime.mjs';
import {spec, row, fakeOptions} from './braintrust-fixtures.mjs';

function upload(config) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [new URL('connector_upload_driver.py', import.meta.url).pathname], {stdio: ['pipe', 'pipe', 'pipe']});
    let output = '', error = ''; child.stdout.on('data', x => output += x); child.stderr.on('data', x => error += x);
    child.on('error', reject); child.on('close', code => code ? reject(Error(error)) : resolve(JSON.parse(output))); child.stdin.end(JSON.stringify(config));
  });
}
for (const viewport of [{width: 1280, height: 900}, {width: 320, height: 740}]) test('Braintrust dashboard spec -> runner -> upload -> visible trace -> saved export at ' + viewport.width, {timeout: 60000}, async () => {
  const live = await start(), browser = await launch(), dir = mkdtempSync(join(tmpdir(), 'braintrust-ui-proof-'));
  const context = await browser.newContext({viewport, acceptDownloads: true});
  await context.route(/^(?!http:\/\/127\.0\.0\.1)/, route => route.abort());
  // Explicitly test the supported fallback in this disposable test browser only.
  await context.addInitScript(() => {Object.defineProperty(window, 'showSaveFilePicker', {value: undefined});});
  const errors = [], page = await context.newPage(); page.on('pageerror', e => errors.push(String(e)));
  try {
    const tenant = await live.signIn(context), key = await live.writeKey(tenant);
    await page.goto(live.origin + '/app/#agents', {waitUntil: 'networkidle'});
    await page.locator('#shell:not([hidden])').waitFor();
    const cookies = await context.cookies();
    const before = await fetch(live.origin + '/api/me', {headers: {cookie: cookies.map(c => c.name + '=' + c.value).join('; ')}});
    assert.equal(before.status, 200);
    const project = (await before.json()).project_id;
    await page.fill('#braintrust-source', spec.sourceProject);
    await page.fill('#braintrust-namespace', spec.namespace);
    await page.fill('#braintrust-roots', spec.rootSpanIds.join('\n'));
    const providerCalls = []; page.on('request', r => {if (/braintrust\.dev|imports\//.test(r.url())) providerCalls.push(r.url());});
    await page.getByRole('button', {name: 'Review Braintrust scope'}).click();
    assert.equal(await page.locator('#braintrust-download').isDisabled(), true);
    assert.equal(JSON.parse(await page.locator('#braintrust-spec').textContent()).content, 'metadata');
    // Small-screen path also exercises explicit full-content opt-in.
    if (viewport.width === 320) {
      await page.check('#braintrust-content'); assert.equal(await page.locator('#braintrust-output').isHidden(), true);
      await page.getByRole('button', {name: 'Review Braintrust scope'}).click();
      assert.match(await page.locator('#braintrust-command').textContent(), /--include-content$/);
    }
    await page.check('#braintrust-reviewed');
    const download = page.waitForEvent('download'); await page.locator('#braintrust-download').click();
    const savedSpec = await download, path = join(dir, savedSpec.suggestedFilename()); await savedSpec.saveAs(path);
    const scope = JSON.parse(readFileSync(path, 'utf8')); assert.equal(scope.destinationProject, project);
    assert.deepEqual(providerCalls, [], 'preparing and downloading the spec never calls a provider or job route');
    const width = await page.evaluate(() => ({scroll: document.documentElement.scrollWidth, viewport: innerWidth}));
    assert.ok(width.scroll <= width.viewport, JSON.stringify(width));
    if (process.env.SUPATRACE_BRAINTRUST_SCREENSHOT_DIR) await page.screenshot({path: join(process.env.SUPATRACE_BRAINTRUST_SCREENSHOT_DIR, 'braintrust-handoff-' + viewport.width + '.png'), fullPage: true});

    const rows = [row(), row('child')], fake = fakeOptions([{data: {data: [rows[1]]}, headers: {'x-bt-cursor': 'next'}}, {data: {data: [rows[0]]}}]);
    const directory = join(dir, 'private'), {stageReceipt} = await runPrivateBraintrustImport(scope, {...fake.options, directory});
    const uploadScope = {origin: 'https://supatrace.dev', project_id: project, fingerprint: stageReceipt.fingerprint, conversion_hash: stageReceipt.conversionHash, manifest_hash: stageReceipt.manifestHash, max_batches: 1000, max_requests: 1000, max_total_bytes: 20 * 1024 * 1024, total_timeout_ms: 30000};
    const config = {directory, scope: uploadScope, local_origin: live.origin, key};
    assert.equal((await upload(config)).all_batches_acknowledged, true);
    assert.equal((await upload(config)).transport_requests_attempted, 0);
    await page.goto(live.origin + '/app/#traces', {waitUntil: 'networkidle'});
    await page.reload({waitUntil: 'networkidle'});
    await page.locator('#runs .trace-open').first().click();
    await page.locator('#events li').first().waitFor();
    const exported = page.waitForEvent('download'); await page.locator('#export').click();
    const result = await exported, exportPath = join(dir, 'synthetic-export.json'); await result.saveAs(exportPath);
    const trace = JSON.parse(readFileSync(exportPath, 'utf8'));
    assert.equal(trace.events.length, 2);
    assert.equal(trace.events.filter(e => e.data.span.parentSpanId === 'root').length, 1);
    if (scope.content === 'include') assert.deepEqual(trace.events.map(e => e.data.original).sort((a, b) => a.id.localeCompare(b.id)), rows.sort((a, b) => a.id.localeCompare(b.id)));
    else assert.doesNotMatch(JSON.stringify(trace), /PRIVATE_PROMPT_MUST_NOT_PERSIST/);
    assert.deepEqual(errors, []);
  } finally {await context.close(); await browser.close(); await live.close(); rmSync(dir, {recursive: true, force: true});}
});
