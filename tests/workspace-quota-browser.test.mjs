// Actual local UI/API/store; no hosted sessions, providers, Stripe or grants.
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';
import {seedLocalWorkspace} from '../scripts/dev.mjs';
import './test-mode-upgrade-browser.test.mjs';
import './project-pause-browser.test.mjs';
import {alphaProject} from '../src/alpha-projects.mjs';
import {planLimits} from '../src/plan-limits.mjs';
import {paidOverageFixture} from './overage-fixture.mjs';
// Expected numbers come from the plan table (tests/spend-cap.test.mjs pins the literal allowances).
const FREE = planLimits('free'), PRO = planLimits('pro'), commas = value => value.toLocaleString('en-US'), F = commas(FREE.spans_per_month);
let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });
async function nav(page, view) {
  const toggle = page.locator('#menu-toggle');
  if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await page.locator(`#rail [data-nav="${view}"]`).click();
  await page.locator(`#view-${view}:not([hidden])`).waitFor();
}
for (const width of [1280, 320]) test(`workspace quota and billing guidance remain correct across roles/environments at ${width}px`, {timeout: 60000}, async () => {
  const live = await start(), contexts = [];
  await seedLocalWorkspace(live);
  try {
    for (const [id, role] of [[4242, 'owner'], [5252, 'admin'], [6262, 'viewer']]) {
      const context = await browser.newContext({viewport: {width, height: 844}}); contexts.push(context);
      await context.route(/^(?!http:\/\/127\.0\.0\.1)/, route => route.abort());
      await live.signIn(context, id);
      const page = await context.newPage(), posts = [], errors = [];
      page.on('request', request => { if (request.method() === 'POST') posts.push(request.url()); });
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(live.origin + '/app/?workspace=github-4242&environment=development#usage', {waitUntil: 'networkidle'});
      await page.locator('#usage-page').filter({hasText: 'bytes reserved'}).waitFor();
      const used = await page.locator('#usage-page').innerText(), explanation = await page.locator('#usage-explanation').innerText();
      assert.match(explanation, new RegExp(alphaProject('github-4242').id));
      assert.match(explanation, /shared by all workspace environments; viewing development/);
      assert.match(explanation, /accepted and pending uploads.*does not reset monthly/);
      assert.match(explanation, /revoking a key does not confirm.*space was freed/);
      assert.match(explanation, /Retention and space-reclamation actions are not available here/);
      await nav(page, 'billing');
      assert.match(await page.locator('#billing-note').innerText(), role === 'owner' ? /selector.*Default.*billing/ : /managed by the workspace owner/);
      assert.equal(await page.locator('#billing-portal').isVisible(), false);
      assert.equal(await page.locator('#commercial-selector').isVisible(), false);
      await nav(page, 'home');
      assert.equal(await page.locator('#usage').innerText(), used);
      assert.match(await page.locator('#usage-explanation-home').innerText(), /All environments share accepted and pending reservations; no monthly reset/);
      await page.getByLabel('Environment', {exact: true}).selectOption('production');
      await page.waitForURL(url => url.searchParams.get('environment') === 'production');
      await page.waitForLoadState('networkidle');
      assert.equal(await page.locator('#usage').innerText(), used);
      assert.equal(await page.getByLabel('Environment', {exact: true}).inputValue(), 'production');
      assert.doesNotMatch(await page.locator('#usage-explanation-home').innerText(), /viewing development/);
      if (role !== 'owner') {
        await page.getByLabel('Workspace', {exact: true}).selectOption('github-' + id);
        await page.waitForURL(url => url.searchParams.get('workspace') === 'github-' + id);
        await page.waitForLoadState('networkidle');
        assert.match(await page.locator('#usage').innerText(), /^0 of /);
        assert.match(await page.locator('#project-name').innerText(), new RegExp(alphaProject('github-' + id).id));
        assert.doesNotMatch(await page.locator('#project-name').innerText(), new RegExp(alphaProject('github-4242').id));
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(posts, [], 'quota guidance/switching must not create keys, grants, payments or mutations');
      assert.deepEqual(errors, []);
    }
  } finally { for (const context of contexts) await context.close(); await live.close(); }
});

test('full quota and mismatched scope suppress stale guidance; explicit refresh recovers without mutations', {timeout: 30000}, async () => {
  const live = await start(), context = await browser.newContext(); await seedLocalWorkspace(live);
  await context.route(/^(?!http:\/\/127\.0\.0\.1)/, route => route.abort()); await live.signIn(context);
  const page = await context.newPage(); let wrong = false, posts = 0;
  page.on('request', request => { if (request.method() === 'POST') posts++; });
  await page.route('**/api/usage**', async route => {
    const response = await route.fetch(), body = await response.json();
    if (wrong) body.quota_scope.workspace_id = 'github-999';
    await route.fulfill({response, json: body});
  });
  try {
    // Fill the Free plan stored-byte allowance; the legacy byte_limit attribute no longer decides capacity.
    await live.store._send('UpdateCommand', {Key: {pk: 'TENANT#github-4242', sk: 'META'}, UpdateExpression: 'SET used_bytes = :full', ExpressionAttributeValues: {':full': FREE.stored_bytes}});
    await page.goto(live.origin + '/app/?environment=development#usage', {waitUntil: 'networkidle'});
    await page.locator('#usage-explanation').filter({hasText: 'No capacity remains for new reservations'}).waitFor();
    assert.match(await page.locator('#usage-explanation').innerText(), /Keep local pending files.*reconcile quota and account state/);
    wrong = true; await page.locator('#usage-refresh').click();
    await page.locator('#usage-page').filter({hasText: 'did not match this workspace or environment'}).waitFor();
    assert.doesNotMatch(await page.locator('#usage-explanation').innerText(), /No capacity remains|bytes|proj_/);
    assert.equal(await page.locator('#billing-portal').isVisible(), false);
    wrong = false; await page.locator('#usage-refresh').click();
    await page.locator('#usage-explanation').filter({hasText: 'No capacity remains for new reservations'}).waitFor();
    assert.equal(posts, 0);
  } finally { await context.close(); await live.close(); }
});

test('Usage shows spans this month against the plan allowance with the reset date, and the used-up state', {timeout: 30000}, async () => {
  const live = await start(), context = await browser.newContext({viewport: {width: 1280, height: 844}}); await seedLocalWorkspace(live);
  await context.route(/^(?!http:\/\/127\.0\.0\.1)/, route => route.abort()); await live.signIn(context);
  const page = await context.newPage(), shots = process.env.SUPATRACE_PROOF_DIR;
  try {
    const period = (await live.store.getPlanUsage('github-4242')).period, used = (await live.store.getPlanUsage('github-4242')).spans_used;
    const resets = new Date(period.resets_at * 1000).toLocaleDateString('en-US', {year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC'});
    await page.goto(live.origin + '/app/#usage', {waitUntil: 'networkidle'});
    await page.locator('#usage-monthly').filter({hasText: 'spans this month'}).waitFor();
    assert.equal(await page.locator('#usage-monthly').innerText(), `${used.toLocaleString('en-US')} of ${F} spans this month. Resets ${resets} (UTC).`);
    // The limits are approved, so there is no "proposed" label, and paid plans exist.
    const limitsText = await page.locator('#usage-plan-limits').innerText();
    assert.equal(limitsText.startsWith(`Free plan: ${F} spans per calendar month. `), true, limitsText);
    assert.match(limitsText, /Uploads over the allowance are rejected, never billed\. Billing shows the plans with a higher allowance\.$/); assert.doesNotMatch(limitsText, /proposed|not available yet/);
    assert.equal(await page.locator('#usage-retention').innerText(), `${FREE.retention_days}-day retention on the Free plan. Traces uploaded from now on stop being listed, opened and exported ${FREE.retention_days} days after upload. Traces stored before this was introduced have no expiry. Expired data is hidden, not yet deleted, and still counts toward reserved bytes.`);
    if (shots) await page.screenshot({path: shots + '/usage-monthly-allowance.png', fullPage: true});
    await live.store._send('UpdateCommand', {Key: {pk: 'TENANT#github-4242', sk: 'USAGE#' + period.id}, UpdateExpression: 'SET spans = :full', ExpressionAttributeValues: {':full': FREE.spans_per_month}});
    await page.locator('#usage-refresh').click();
    await page.locator('#usage-monthly').filter({hasText: 'The allowance is used up'}).waitFor();
    assert.equal(await page.locator('#usage-monthly').innerText(), `${F} of ${F} spans this month. Resets ${resets} (UTC). The allowance is used up; new uploads are rejected until the reset.`);
    if (shots) await page.screenshot({path: shots + '/usage-allowance-used-up.png', fullPage: true});
  } finally { await context.close(); await live.close(); }
});

test('usage banner appears at 80% and 100%, and the owner can switch the Pro spend cap in Cost control', {timeout: 45000}, async () => {
  let env;const live = await start({configureEnvironment:value=>{env=value;}}), context = await browser.newContext({viewport: {width: 1280, height: 844}}); await seedLocalWorkspace(live);
  await context.route(/^(?!http:\/\/127\.0\.0\.1)/, route => route.abort()); await live.signIn(context);
  const page = await context.newPage(), shots = process.env.SUPATRACE_PROOF_DIR, period = (await live.store.getPlanUsage('github-4242')).period;
  const set = (key, expression, values) => live.store._send('UpdateCommand', {Key: key, UpdateExpression: expression, ExpressionAttributeValues: values});
  const spans = value => set({pk: 'TENANT#github-4242', sk: 'USAGE#' + period.id}, 'SET spans = :spans', {':spans': value});
  const refresh = async () => { await page.locator('#usage-refresh').click(); await page.locator('#usage-monthly').filter({hasText: 'spans this month'}).waitFor(); };
  try {
    await page.goto(live.origin + '/app/#usage', {waitUntil: 'networkidle'}); await page.locator('#usage-monthly').filter({hasText: 'spans this month'}).waitFor();
    assert.equal(await page.locator('#usage-banner').isVisible(), false);
    const at80 = FREE.spans_per_month * 0.8;
    await spans(at80 - 1); await refresh(); assert.equal(await page.locator('#usage-banner').isVisible(), false);   // one span short of 80%
    await spans(at80); await refresh();
    assert.match(await page.locator('#usage-banner').innerText(), new RegExp(`^You have used ${commas(at80)} of the ${F} spans included this month \\(80%\\)\\. The count resets .* \\(UTC\\)\\.$`));
    assert.equal(await page.locator('#usage-banner').getAttribute('data-level'), '80');
    if (shots) await page.screenshot({path: shots + '/banner-80.png', fullPage: true});
    await spans(FREE.spans_per_month); await refresh();
    assert.match(await page.locator('#usage-banner').innerText(), new RegExp(`^This month’s ${F} included spans are used up\\. New uploads are rejected until .* \\(UTC\\)\\.$`));
    if (shots) await page.screenshot({path: shots + '/banner-100.png', fullPage: true});
    // The banner is on every view, and Free has no cap to change.
    await nav(page, 'billing'); assert.equal(await page.locator('#usage-banner').isVisible(), true);
    assert.equal(await page.locator('#spend-cap-state').innerText(), 'Free plan: uploads always stop at the monthly allowance. Nothing is billed for usage.');
    assert.equal(await page.locator('#spend-cap-toggle').isVisible(), false);
    assert.equal(await page.locator('[data-upgrade-for="spend-cap-toggle"]').innerText(), 'Spend cap control (run past the allowance) needs the Pro plan. This organization is on Free. Upgrade in Billing');
    // Pro: cap on by default; the owner turns it off after confirming, and uploads past the allowance are then allowed.
    // The page is loaded afresh on the new plan, as after a return from Checkout. (The next test covers a plan change
    // picked up by Refresh billing alone.)
    await set({pk: 'TENANT#github-4242', sk: 'META'}, 'SET plan_id = :plan', {':plan': 'pro'}); await spans(PRO.spans_per_month);
    await page.reload({waitUntil: 'networkidle'}); await page.locator('#spend-cap-state').filter({hasText: 'Spend cap is on'}).waitFor();
    assert.equal(await page.locator('[data-upgrade-for="spend-cap-toggle"]').count(), 0); assert.equal(await page.locator('#spend-cap-toggle').evaluate(button => button.inert), false);
    assert.match(await page.locator('#spend-cap-detail').innerText(), new RegExp(`^Overage rate: \\$${PRO.overage_usd_per_million_spans} per million spans\\. Billing is in test mode: no real charge is made\\.$`));
    assert.match(await page.locator('#usage-banner').innerText(), /New uploads are rejected until .* \(UTC\)\. The workspace owner can turn the spend cap off under Billing\.$/);
    if (shots) await page.screenshot({path: shots + '/cost-control-cap-on.png', fullPage: true});
    await assert.rejects(live.store.reserveBatch('github-4242', {batch_id: 'capped', run_id: 'r', request_hash: 'a'.repeat(64), byte_count: 10, event_count: 1}), error => error.code === 'spend_cap_reached');
    page.once('dialog', dialog => dialog.dismiss()); await page.locator('#spend-cap-toggle').click();
    assert.equal((await live.store.getTenant('github-4242')).spend_cap, undefined);
    await paidOverageFixture(live,env);
    page.once('dialog', dialog => { assert.match(dialog.message(), /^Turn the spend cap off\?/); return dialog.accept(); });
    await page.locator('#spend-cap-toggle').click(); await page.locator('#spend-cap-state').filter({hasText: 'Spend cap is off'}).waitFor();
    assert.equal((await live.store.getTenant('github-4242')).spend_cap, false);
    assert.equal(await page.locator('#spend-cap-toggle').innerText(), 'Turn spend cap on');
    assert.match(await page.locator('#usage-banner').innerText(), /The spend cap is off, so uploads continue and further spans are metered as overage until/);
    await live.store.reserveBatch('github-4242', {batch_id: 'overage', run_id: 'r', request_hash: 'b'.repeat(64), byte_count: 10, event_count: 3});
    // Usage must not say uploads are rejected while the cap is off.
    await nav(page, 'usage'); await refresh();
    assert.match(await page.locator('#usage-monthly').innerText(), /The included spans are used up; the spend cap is off, so uploads continue and are metered as overage\.$/);
    assert.match(await page.locator('#usage-plan-limits').innerText(), /The spend cap is off: uploads past the allowance continue and are metered as overage \(test mode, no real charge\)\./);
    assert.doesNotMatch(await page.locator('#view-usage').innerText(), /uploads are rejected|rejected, never billed/);
    await nav(page, 'billing');
    if (shots) await page.screenshot({path: shots + '/cost-control-cap-off.png', fullPage: true});
    await page.locator('#spend-cap-toggle').click(); await page.locator('#spend-cap-state').filter({hasText: 'Spend cap is on'}).waitFor();
    assert.equal((await live.store.getTenant('github-4242')).spend_cap, true);
    assert.match(await page.locator('#spend-cap-detail').innerText(), /3 spans over the allowance this month\./);
  } finally { await context.close(); await live.close(); }
});

test('a plan change picked up by Refresh billing unlocks the Pro spend cap without a page reload', {timeout: 45000}, async () => {
  let env;const live = await start({configureEnvironment:value=>{env=value;}}), context = await browser.newContext({viewport: {width: 1280, height: 844}}); await seedLocalWorkspace(live);
  await context.route(/^(?!http:\/\/127\.0\.0\.1)/, route => route.abort()); await live.signIn(context);
  const page = await context.newPage();
  try {
    await page.goto(live.origin + '/app/#billing', {waitUntil: 'networkidle'});
    await page.locator('#spend-cap-state').filter({hasText: 'Free plan: uploads always stop at the monthly allowance.'}).waitFor();
    // The account moves to Pro while the dashboard is open (an operator assigns it, or another tab upgrades).
    await live.store._send('UpdateCommand', {Key: {pk: 'TENANT#github-4242', sk: 'META'}, UpdateExpression: 'SET plan_id = :plan', ExpressionAttributeValues: {':plan': 'pro'}});
    await page.locator('#billing-refresh').click(); await page.locator('#spend-cap-state').filter({hasText: 'Spend cap is on'}).waitFor();
    // Billing now shows the Pro cap and its switch, so the switch must work and must not carry the Free upgrade note.
    assert.equal(await page.locator('#spend-cap-toggle').innerText(), 'Turn spend cap off');
    await page.locator('#plan-entitlements-title').filter({hasText: 'Pro plan'}).waitFor({timeout: 5000});
    assert.equal(await page.locator('[data-upgrade-for="spend-cap-toggle"]').count(), 0);
    await paidOverageFixture(live,env);
    page.once('dialog', dialog => dialog.accept()); await page.locator('#spend-cap-toggle').click({timeout: 5000});
    await page.locator('#spend-cap-state').filter({hasText: 'Spend cap is off'}).waitFor();
    assert.equal((await live.store.getTenant('github-4242')).spend_cap, false);
  } finally { await context.close(); await live.close(); }
});
