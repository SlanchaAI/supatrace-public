import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdirSync} from 'node:fs';
import {start as startHarness} from './harness.mjs';
// This file drives a paid feature, so its fixture organizations are on Enterprise. tests/entitlements*.test.mjs cover the gates.
const start = (options = {}) => startHarness({plan: 'enterprise', ...options});
import {launch} from './browser.mjs';
import {auditPut} from '../src/audit.mjs';

// Issue #125: the owner reads, filters and exports the audit log in the dashboard; other roles get no entry.
test('owner sees the audit log after real actions, filters it and exports CSV and JSON; a viewer has no entry', {timeout: 90000}, async () => {
  const live = await start(), browser = await launch(), contexts = [];
  try {
    const make = async id => { const c = await browser.newContext({acceptDownloads: true, viewport: {width: 1280, height: 900}}); contexts.push(c); await c.route(/^(?!http:\/\/127\.0\.0\.1)/, r => r.abort()); const tenant = await live.signIn(c, id); const p = await c.newPage(); return {c, tenant, p}; };
    const owner = await make(4242), viewer = await make(5252), errors = [];
    for (const who of [owner, viewer]) who.p.on('pageerror', e => errors.push(e.message));
    await owner.p.goto(live.origin + '/app/#members'); await owner.p.locator('#shell:not([hidden])').waitFor();
    await owner.p.locator('#share-workspace input').fill('Product team'); await owner.p.locator('#share-workspace button').click(); await owner.p.locator('#team-members:not([hidden])').waitFor();
    await owner.p.locator('#invite-member input').fill(viewer.tenant); await owner.p.locator('#invite-member button').click(); await owner.p.locator('#invitation-link a').waitFor();
    await viewer.p.goto(live.origin + '/app/#members'); await viewer.p.locator('.pending-invite button').click(); await viewer.p.waitForURL(u => u.searchParams.get('workspace') === owner.tenant); await viewer.p.locator('#shell:not([hidden])').waitFor();
    // The viewer has no Audit log entry, and the view falls back to Home when opened by address.
    assert.equal(await viewer.p.locator('#rail [data-nav="audit"]').isVisible(), false);
    await viewer.p.goto(live.origin + '/app/?workspace=' + owner.tenant + '#audit'); await viewer.p.locator('#shell:not([hidden])').waitFor(); await viewer.p.waitForFunction(() => location.hash === '#home');
    assert.equal(await viewer.p.locator('#audit-controls').count(), 0);

    await owner.p.locator('#rail a[data-nav="audit"]').click(); await owner.p.locator('#view-audit:not([hidden])').waitFor();
    await owner.p.waitForFunction(() => document.querySelectorAll('#audit-rows tr').length === 3);
    const rows = await owner.p.locator('#audit-rows tr').allInnerTexts();
    assert.match(rows[0], /Invitation accepted/); assert.match(rows[1], /Member invited/); assert.match(rows[2], /Team sharing enabled/);
    assert.ok(rows[0].includes(viewer.tenant) && rows[1].includes(owner.tenant) && rows[1].includes('role: viewer'));
    assert.match(await owner.p.locator('#audit-note').innerText(), /kept for 90 days and cannot be edited or turned off/);
    await owner.p.locator('#audit-filters select').selectOption('workspace'); await owner.p.locator('#audit-filters button').click();
    await owner.p.waitForFunction(() => document.querySelectorAll('#audit-rows tr').length === 1); assert.match(await owner.p.locator('#audit-status').innerText(), /^1 event shown/);
    await owner.p.locator('#audit-filters [name=actor]').fill('github-1'); await owner.p.locator('#audit-filters button').click();
    await owner.p.waitForFunction(() => /No events match/.test(document.querySelector('#audit-status').textContent));
    await owner.p.locator('#audit-filters [name=actor]').fill(''); await owner.p.locator('#audit-filters select').selectOption('');
    const [csv] = await Promise.all([owner.p.waitForEvent('download'), owner.p.locator('#audit-export-csv').click()]);
    assert.equal(csv.suggestedFilename(), 'supatrace-audit-log.csv'); const csvText = readFileSync(await csv.path(), 'utf8');
    assert.equal(csvText.split('\r\n')[0], 'time,actor,action,target,ip,source,detail'); assert.equal(csvText.trimEnd().split('\r\n').length, 4);
    const [file] = await Promise.all([owner.p.waitForEvent('download'), owner.p.locator('#audit-export-json').click()]);
    const exported = JSON.parse(readFileSync(await file.path(), 'utf8'));
    assert.deepEqual(exported.events.map(event => event.action), ['audit.export', 'member.accept', 'member.invite', 'workspace.sharing_enabled']);
    assert.doesNotMatch(JSON.stringify(exported), /token|secret|cookie/i);
    await owner.p.locator('#audit-filters button').click(); await owner.p.waitForFunction(() => document.querySelectorAll('#audit-rows tr').length === 5);
    assert.match((await owner.p.locator('#audit-rows tr').allInnerTexts())[0], /Audit log exported/);
    assert.equal(await owner.p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    if (process.env.SUPATRACE_AUDIT_SCREENSHOT_DIR) { mkdirSync(process.env.SUPATRACE_AUDIT_SCREENSHOT_DIR, {recursive: true}); await owner.p.screenshot({path: process.env.SUPATRACE_AUDIT_SCREENSHOT_DIR + '/audit-log-1280.png', fullPage: true}); await owner.p.setViewportSize({width: 390, height: 844}); await owner.p.screenshot({path: process.env.SUPATRACE_AUDIT_SCREENSHOT_DIR + '/audit-log-390.png', fullPage: true}); }
    assert.deepEqual(errors, []);
  } finally { for (const c of contexts) await c.close(); await browser.close(); await live.close(); }
});

test('an export larger than one file continues from the server cursor, part by part, with no gap or repeat', {timeout: 90000}, async () => {
  const live = await start(), browser = await launch(), context = await browser.newContext({acceptDownloads: true});
  try {
    await context.route(/^(?!http:\/\/127\.0\.0\.1)/, r => r.abort()); const tenant = await live.signIn(context, 4242), page = await context.newPage(), now = live.store.now();
    // 5,300 events inside one second: no date filter could split them.
    for (let i = 0; i < 5300; i += 25) await live.store._tx(Array.from({length: 25}, (_, j) => auditPut(now, {workspace: tenant, actor: tenant, ip: '127.0.0.1'}, 'key.create', 'k' + (i + j))));
    await page.goto(live.origin + '/app/#audit'); await page.locator('#audit-controls').waitFor(); await page.waitForFunction(() => document.querySelectorAll('#audit-rows tr').length === 50);
    await page.locator('#audit-filters select').selectOption('key');
    const read = async click => { const [file] = await Promise.all([page.waitForEvent('download'), click()]); return {name: file.suggestedFilename(), body: JSON.parse(readFileSync(await file.path(), 'utf8'))}; };
    assert.equal(await page.locator('#audit-export-next').isVisible(), false);
    const first = await read(() => page.locator('#audit-export-json').click()); assert.equal(first.name, 'supatrace-audit-log.json'); assert.equal(first.body.complete, false); assert.equal(first.body.events.length, 5000);
    await page.locator('#audit-export-next:not([hidden])').waitFor(); assert.equal(await page.locator('#audit-export-next').innerText(), 'Export part 2 (JSON)'); assert.match(await page.locator('#audit-status').innerText(), /Older events remain/);
    const second = await read(() => page.locator('#audit-export-next').click()); assert.equal(second.name, 'supatrace-audit-log-part-2.json'); assert.equal(second.body.complete, true);
    await page.waitForFunction(() => document.querySelector('#audit-export-next').hidden); assert.match(await page.locator('#audit-status').innerText(), /last part/);
    const targets = [...first.body.events, ...second.body.events].map(event => event.target); assert.equal(targets.length, 5300); assert.equal(new Set(targets).size, 5300);
  } finally { await context.close(); await browser.close(); await live.close(); }
});

test('starting a trace export from the dashboard records one client-reported export event', {timeout: 60000}, async () => {
  const live = await start(), browser = await launch(), context = await browser.newContext({acceptDownloads: true});
  try {
    await context.route(/^(?!http:\/\/127\.0\.0\.1)/, r => r.abort()); await context.addInitScript(() => { delete window.showSaveFilePicker; });
    const tenant = await live.signIn(context, 4242), [run] = await live.seedRuns(tenant, 1), page = await context.newPage();
    await page.goto(live.origin + '/app/#traces'); await page.locator('#shell:not([hidden])').waitFor();
    await page.getByRole('button', {name: 'Open trace ' + run, exact: true}).click(); await page.locator('#events li').first().waitFor();
    await Promise.all([page.waitForEvent('download'), page.locator('#export').click()]);
    await page.locator('#rail a[data-nav="audit"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#audit-rows tr').length === 1);
    const text = await page.locator('#audit-rows tr').innerText(); assert.match(text, /Export started \(reported by the browser\)/); assert.ok(text.includes(run) && text.includes('kind: trace'));
  } finally { await context.close(); await browser.close(); await live.close(); }
});
