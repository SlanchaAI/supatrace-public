import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';

const part = {events: [{target: 'part-one'}], complete: false};
const complete = {events: [{target: 'part-two'}], complete: true};
const json = (body, next) => ({status: 200, contentType: 'application/json', body: JSON.stringify(body), headers: next ? {'x-audit-export-next': next} : {}});
async function fixture(run) {
  const live = await start({plan: 'enterprise'}), browser = await launch(), context = await browser.newContext({acceptDownloads: true});
  try {
    await context.route(/^(?!http:\/\/127\.0\.0\.1)/, route => route.abort());
    await live.signIn(context, 4242); const page = await context.newPage();
    await page.goto(live.origin + '/app/#audit'); await page.locator('#audit-controls').waitFor();
    await page.locator('#audit-filters select').selectOption('key');
    await run(page);
  } finally { await context.close(); await browser.close(); await live.close(); }
}
const download = async (page, selector) => {
  const [file] = await Promise.all([page.waitForEvent('download'), page.locator(selector).click()]);
  return {name: file.suggestedFilename(), body: readFileSync(await file.path(), 'utf8')};
};

test('a failed second audit part retains the exact cursor and query for one explicit retry', {timeout: 20000}, async () => fixture(async page => {
  const urls = []; let afterCalls = 0;
  await page.route('**/api/audit/export?*', async route => {
    const url = new URL(route.request().url()); urls.push(url);
    if (!url.searchParams.has('after')) return route.fulfill(json(part, 'opaque-page-2'));
    if (++afterCalls === 1) return route.fulfill({status: 503, json: {error: 'temporarily_unavailable'}});
    return route.fulfill(json(complete));
  });
  const first = await download(page, '#audit-export-json'); assert.equal(first.name, 'supatrace-audit-log.json'); assert.deepEqual(JSON.parse(first.body), part);
  await page.locator('#audit-export-next').click();
  await page.locator('#audit-export-next:not([hidden])').waitFor({timeout: 2000});
  assert.match(await page.locator('#audit-export-next').innerText(), /Retry part 2 \(JSON\)/);
  assert.equal(urls.length, 2); // No automatic request or restart at part one.
  const second = await download(page, '#audit-export-next');
  assert.equal(second.name, 'supatrace-audit-log-part-2.json'); assert.deepEqual(JSON.parse(second.body), complete);
  assert.equal(urls.length, 3); assert.equal(urls[1].href, urls[2].href);
  assert.equal(urls[2].searchParams.get('after'), 'opaque-page-2'); assert.equal(urls[2].searchParams.get('action'), 'key'); assert.equal(urls[2].searchParams.get('format'), 'json');
  await page.waitForFunction(() => document.querySelector('#audit-export-next').hidden);
  assert.match(await page.locator('#audit-status').innerText(), /last part/);
}));

for (const invalidate of ['filters', 'new export']) {
  test(`a delayed failed continuation cannot return after ${invalidate}`, {timeout: 20000}, async () => fixture(async page => {
    let release, started; const held = new Promise(resolve => { release = resolve; }), seen = new Promise(resolve => { started = resolve; });
    await page.route('**/api/audit/export?*', async route => {
      const url = new URL(route.request().url());
      if (url.searchParams.has('after')) { started(); await held; return route.fulfill({status: 503, json: {error: 'temporarily_unavailable'}}); }
      if (url.searchParams.get('format') === 'csv') return route.fulfill({status: 200, contentType: 'text/csv', body: 'time,actor\r\n'});
      return route.fulfill(json(part, 'stale-cursor'));
    });
    await download(page, '#audit-export-json'); await page.locator('#audit-export-next').click(); await seen;
    if (invalidate === 'filters') {
      await page.locator('#audit-filters select').selectOption('member');
      await page.locator('#audit-filters button').click();
      await page.waitForFunction(() => /events match|events? shown/.test(document.querySelector('#audit-status').textContent));
    } else {
      const csv = await download(page, '#audit-export-csv'); assert.equal(csv.name, 'supatrace-audit-log.csv');
    }
    const currentStatus = await page.locator('#audit-status').innerText();
    const response = page.waitForResponse(r => r.url().includes('/api/audit/export?') && r.url().includes('after=stale-cursor'));
    release(); await response;
    // Read after response handling has settled in the browser, without a timer-based assertion.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('#audit-export-next').isVisible(), false);
    assert.equal(await page.locator('#audit-status').innerText(), currentStatus);
  }));
}
