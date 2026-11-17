// Logs view (#88) in a real browser against the real handler: the rail entry, the two streams, filters, Refresh and paging.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';
import {digest} from '../src/aws-auth.mjs';

const batch = run => ({version: 1, batch_id: run + '-b', run_id: run, events: [{id: run + '-e', time: new Date().toISOString(), kind: 'note', name: 'synthetic', data: {}}]});
const send = (live, key, body, hash) => { const raw = JSON.stringify(body); return fetch(live.origin + '/api/batches', {method: 'POST', headers: {'content-type': 'application/json', 'x-supatrace-key': key, 'x-amz-content-sha256': hash ?? digest(raw)}, body: raw}); };

test('the Logs view shows recorded upload attempts with their reason, filters them, refreshes and pages', async () => {
  const live = await start(), browser = await launch(), context = await browser.newContext();
  try {
    await context.route(/^(?!http:\/\/127\.0\.0\.1)/, r => r.abort()); const tenant = await live.signIn(context), key = await live.writeKey(tenant);
    await live.upload(key, batch('app-1')); assert.equal((await send(live, key, batch('app-2'), '0'.repeat(64))).status, 400);
    const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(live.origin + '/app/'); await page.locator('#shell:not([hidden])').waitFor();
    assert.equal(await page.locator('#view-logs').isHidden(), true);
    const nav = page.locator('#rail a[data-nav="logs"]'); assert.equal((await nav.innerText()).trim(), 'Logs'); await nav.click();
    await page.locator('#view-logs:not([hidden])').waitFor(); await page.locator('#logs-rows tr').first().waitFor();
    assert.equal(new URL(page.url()).hash, '#logs'); assert.equal(await nav.getAttribute('aria-current'), 'page'); assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Logs', 'the heading takes focus like the other views');
    // The default list is refusals: the hash mismatch, with its code, explanation and the key prefix.
    const rows = page.locator('#logs-rows tr'); assert.equal(await rows.count(), 1);
    assert.match(await rows.first().innerText(), /Batch upload\s+Rejected · HTTP 400\s+payload_hash_required The x-amz-content-sha256 header was missing or did not match the request body\./);
    assert.ok((await rows.first().innerText()).includes(digest(key).slice(0, 12) + '…')); assert.ok(!(await page.locator('#view-logs').innerText()).includes(key));
    assert.equal(await rows.first().getAttribute('data-reason'), 'payload_hash_required');
    assert.match(await page.locator('#logs-status').innerText(), /^1 rejected or partly stored attempt shown, newest first\.$/);
    assert.match(await page.locator('#logs-note').innerText(), /kept for 7 days.*without a key.*not recorded here.*up to 30 a minute.*a row can be missing/);
    if (process.env.SUPATRACE_PROOF_DIR) { mkdirSync(process.env.SUPATRACE_PROOF_DIR, {recursive: true}); await page.screenshot({path: process.env.SUPATRACE_PROOF_DIR + '/logs-view.png', fullPage: true}); }
    // Refresh reads new rows.
    assert.equal((await send(live, key, {...batch('app-3'), surprise: 1})).status, 400); await page.locator('#logs-refresh').click();
    await page.waitForFunction(() => document.querySelectorAll('#logs-rows tr').length === 2); assert.equal(await rows.first().getAttribute('data-reason'), 'unknown_field');
    // Filters: by reason code, by route, and the accepted stream.
    await page.locator('#logs-filters [name="reason"]').fill('payload_hash_required'); await page.locator('#logs-filters button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#logs-rows tr').length === 1); assert.equal(await rows.first().getAttribute('data-reason'), 'payload_hash_required');
    await page.locator('#logs-filters [name="reason"]').fill(''); await page.locator('#logs-filters [name="route"]').selectOption('otlp'); await page.locator('#logs-filters button[type="submit"]').click();
    await page.waitForFunction(() => /^No recorded rejected or partly stored attempt matches these filters among the rows read\.$/.test(document.getElementById('logs-status').textContent)); assert.equal(await rows.count(), 0);
    await page.locator('#logs-filters [name="route"]').selectOption(''); await page.locator('#logs-filters [name="stream"]').selectOption('accepted'); await page.locator('#logs-filters button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('#logs-rows tr')?.dataset.outcome === 'accepted');
    assert.match(await rows.first().innerText(), /Batch upload\s+Accepted · HTTP 201\s+1 event in 1 batch\s+app-1/); assert.match(await page.locator('#logs-status').innerText(), /^1 accepted attempt shown, newest first\.$/);
    // Paging keeps the filters of the rows on screen, and a truncated read is worded as unfinished, not as empty.
    const real = await (await context.request.get(live.origin + '/api/logs?stream=accepted', {headers: {cookie: (await context.cookies()).map(c => c.name + '=' + c.value).join('; ')}})).json(), seen = [];
    await context.route(/\/api\/logs(\?|$)/, r => { const url = new URL(r.request().url()); seen.push(url.search); return r.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(url.searchParams.has('after') ? {...real, attempts: [], next: null, truncated: false} : {...real, next: 'cursor-1', truncated: true})}); });
    await page.locator('#logs-refresh').click(); await page.locator('#logs-more:not([hidden])').waitFor();
    assert.match(await page.locator('#logs-status').innerText(), /stopped at its row limit before reaching the end/);
    await page.locator('#logs-filters [name="route"]').selectOption('langfuse'); await page.locator('#logs-more').click(); await page.locator('#logs-more').waitFor({state: 'hidden'});
    assert.deepEqual(seen, ['?stream=accepted', '?stream=accepted&after=cursor-1']); assert.equal(await rows.count(), 1);
    await context.unroute(/\/api\/logs(\?|$)/);
    // A failed read says so and does not present old rows as current; a malformed body is refused.
    await context.route(/\/api\/logs(\?|$)/, r => r.fulfill({status: 503, contentType: 'application/json', body: '{"error":"unavailable"}'})); await page.locator('#logs-refresh').click();
    await page.waitForFunction(() => /could not be loaded\. Rows below, if any, are from an earlier read/.test(document.getElementById('logs-status').textContent)); await context.unroute(/\/api\/logs(\?|$)/);
    await context.route(/\/api\/logs(\?|$)/, r => r.fulfill({status: 200, contentType: 'application/json', body: '{"attempts":[{"id":"x"}]}'})); await page.locator('#logs-refresh').click();
    await page.waitForFunction(() => /could not be loaded/.test(document.getElementById('logs-status').textContent)); await context.unroute(/\/api\/logs(\?|$)/);
    // A direct link opens the view.
    await page.goto(live.origin + '/app/#logs'); await page.locator('#logs-rows tr').first().waitFor(); assert.equal(await page.locator('#view-logs').isHidden(), false);
    assert.deepEqual(errors, []);
  } finally { await context.close(); await browser.close(); await live.close(); }
});
