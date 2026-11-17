// Browser proof for #113 in the local harness: the warning banner before an idle pause, the paused banner with
// a refused upload behind it, and the owner's one-click resume. The store clock is moved; nothing else is faked.
import test from 'node:test';
import assert from 'node:assert/strict';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';
import {seedLocalWorkspace} from '../scripts/dev.mjs';
test('idle Free project: warning banner, paused banner, refused upload, one-click resume', {timeout: 90000}, async () => {
  const live = await start(), browser = await launch(), context = await browser.newContext({viewport: {width: 1280, height: 900}});
  const errors = [], shots = process.env.SUPATRACE_PROOF_DIR, DAY = 86400; await context.route(/^(?!http:\/\/127\.0\.0\.1)/, route => route.abort());
  try {
    await seedLocalWorkspace(live); const root = () => live.store._get({pk: 'TENANT#github-4242', sk: 'META'}), last = (await root()).last_accepted_at;
    assert.ok(Number.isSafeInteger(last));   // the seeded uploads were accepted, which is the activity stamp
    const clock = days => { live.store.now = () => last + Math.round(days * DAY); };
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    const open = async () => { await context.clearCookies(); await live.signIn(context); await page.goto('about:blank'); await page.goto(live.origin + '/app/#usage', {waitUntil: 'networkidle'}); await page.locator('#usage-monthly').filter({hasText: 'spans this month'}).waitFor(); };
    const shot = async name => { if (shots) await page.screenshot({path: shots + '/' + name + '.png', fullPage: true}); };
    const day = seconds => new Date(seconds * 1000).toLocaleDateString('en-US', {year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC'});
    // Active: no banner, and Usage states the rule and the date.
    clock(1); await open(); assert.equal(await page.locator('#pause-banner').isVisible(), false);
    assert.equal(await page.locator('#usage-lifecycle').innerText(), `A Free project pauses after 30 days with no accepted trace. Without a new trace, this one pauses on ${day(last + 30 * DAY)} (UTC).`);
    // Three days before: a warning on every view, nothing to click yet.
    clock(28); await open();
    assert.equal(await page.locator('#pause-banner').innerText(), `No trace has been accepted recently. This Free project pauses on ${day(last + 30 * DAY)} (UTC) unless a trace is uploaded before then. A paused project keeps its traces and resumes in one click.`);
    assert.equal(await page.locator('#pause-banner').getAttribute('data-state'), 'pausing_soon'); assert.equal(await page.locator('#project-resume').isVisible(), false); await shot('1-pausing-soon');
    // Paused: uploads are refused, stored data is untouched, the owner sees Resume.
    clock(31); await open(); const before = await root();
    assert.match(await page.locator('#pause-text').innerText(), /^This project is paused: no trace was accepted for 30 days\. New uploads are refused until it is resumed\. Nothing was deleted; the plan’s retention period still decides which traces are listed\.$/);
    assert.equal(await page.locator('#pause-banner').getAttribute('data-state'), 'paused'); assert.equal(await page.locator('#project-resume').isVisible(), true);
    assert.equal(await page.locator('#usage-lifecycle').innerText(), 'A Free project pauses after 30 days with no accepted trace. This project is paused; its stored traces are kept.');
    await assert.rejects(live.store.reserveBatch('github-4242', {batch_id: 'paused1', run_id: 'run-paused', request_hash: 'a'.repeat(64), byte_count: 10, event_count: 1}), error => error.status === 403 && error.code === 'project_paused');
    assert.deepEqual(await root(), before); await shot('2-paused');
    await page.goto(live.origin + '/app/#traces'); assert.equal(await page.locator('#pause-banner').isVisible(), true);   // on every view
    await page.goto(live.origin + '/app/#usage');
    // One click.
    // The resume click clears the usage card while it reloads, which also hides the banner. Wait for the repaint, not the clear (#192).
    await page.locator('#project-resume').click(); await page.locator('#usage-lifecycle').filter({hasText: 'Without a new trace'}).waitFor();
    assert.equal(await page.locator('#pause-banner').isVisible(), false);
    assert.equal((await root()).resumed_at, last + 31 * DAY); assert.equal((await root()).used_bytes, before.used_bytes);
    assert.equal(await page.locator('#usage-lifecycle').innerText(), `A Free project pauses after 30 days with no accepted trace. Without a new trace, this one pauses on ${day(last + 61 * DAY)} (UTC).`);
    await live.store.reserveBatch('github-4242', {batch_id: 'resumed1', run_id: 'run-resumed', request_hash: 'b'.repeat(64), byte_count: 10, event_count: 1}); await shot('3-resumed');
    assert.deepEqual(errors, []);
  } finally { await context.close(); await browser.close(); await live.close(); }
});
