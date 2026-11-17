// Browser proof for #114 in the local harness: the owner upgrades from Billing with a test Checkout, switches plan
// and cancels in the (simulated) Stripe test portal, and Billing and Usage show the limits in force after each step.
import test from 'node:test';
import assert from 'node:assert/strict';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';
import {seedLocalWorkspace} from '../scripts/dev.mjs';
import {configureLocalBilling} from '../scripts/local-billing.mjs';
import {planLimits} from '../src/plan-limits.mjs';
import {PLANS} from '../src/plans.mjs';
// What Billing and Usage must show comes from the plan table (tests/test-mode-upgrade.test.mjs pins the literal prices).
const commas = value => value.toLocaleString('en-US'), price = id => '$' + PLANS.plans.find(p => p.id === id).monthly_base_usd.toFixed(2);
const detail = id => { const l = planLimits(id); return `${price(id)} per month in Stripe test mode (not charged): ${commas(l.spans_per_month)} spans per month, ${commas(l.stored_bytes / 1e9)} GB stored, ${l.retention_days}-day retention. These limits apply once the test subscription is active.`; };
test('owner upgrades to Base, switches to Pro and cancels from Billing in Stripe test mode', {timeout: 90000}, async () => {
  const live = await start({localDev: true, configureEnvironment: async env => { env.localBilling = await configureLocalBilling(env, {planLimits: true}); }}), browser = await launch(), context = await browser.newContext({viewport: {width: 1280, height: 900}});
  const outside = [], errors = [], shots = process.env.SUPATRACE_PROOF_DIR; await context.route(/^(?!http:\/\/127\.0\.0\.1)/, r => { outside.push(r.request().url()); return r.abort(); });
  try {
    await seedLocalWorkspace(live); const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    const shot = async name => { if (shots) await page.screenshot({path: shots + '/' + name + '.png', fullPage: true}); };
    const note = text => page.locator('#billing-note').filter({hasText: text}).waitFor();
    await page.goto(live.origin + '/__local__/signin?account=4242'); await page.locator('#shell:not([hidden])').waitFor(); await page.goto(live.origin + '/app/#billing');
    await note('this workspace has Free plan limits. There is no current paid test subscription.');
    assert.equal(await page.locator('#commercial-heading').innerText(), 'Upgrade (Stripe test mode)');
    assert.match(await page.locator('#commercial-disclaimer').innerText(), /^Stripe test mode\. Checkout takes a test card and no real payment\..*Payments are not live; live activation is a separate decision\.$/);
    assert.equal(await page.locator('#commercial-selector a[href="/pricing"]').innerText(), 'Compare the plans');
    assert.match(await page.locator('#account-plan').innerText(), /^Free plan \(Stripe test mode\)\./);
    // Checkout offers exactly the self-serve plans; Enterprise is not one of them.
    assert.deepEqual(await page.locator('#commercial-plan option').evaluateAll(options => options.map(o => o.value).filter(Boolean)), ['base', 'pro']);
    await page.locator('#commercial-plan').selectOption('pro'); assert.equal(await page.locator('#commercial-plan-detail').innerText(), detail('pro'));
    await page.locator('#commercial-plan').selectOption('base'); assert.equal(await page.locator('#commercial-plan-detail').innerText(), detail('base'));
    assert.equal(detail('base').startsWith('$9.99 per month in Stripe test mode (not charged): 1,000,000 spans per month, 10 GB stored, 30-day retention.'), true);
    assert.equal(await page.locator('#commercial-checkout').innerText(), 'Upgrade with test Checkout'); await shot('1-billing-free-upgrade');
    await page.locator('#commercial-checkout:not([disabled])').click();
    await page.getByRole('button', {name: 'Complete synthetic Checkout'}).waitFor(); await shot('2-local-checkout');
    await page.getByRole('button', {name: 'Complete synthetic Checkout'}).click(); await page.waitForURL(u => u.pathname === '/app/');
    await page.goto(live.origin + '/app/#usage'); await page.locator('#usage-plan-limits').filter({hasText: 'Base plan'}).waitFor();
    assert.equal((await page.locator('#usage-plan-limits').innerText()).startsWith(`Base plan: ${commas(planLimits('base').spans_per_month)} spans per calendar month. `), true);   // the limits are approved: no "proposed" label await shot('3-usage-base');
    await page.goto(live.origin + '/app/#billing'); await note('this workspace has Base plan limits. The test subscription is active.');
    assert.match(await page.locator('#account-plan').innerText(), /^Base plan \(Stripe test mode\)\. Limits follow the test subscription; no real payment is taken\.$/);
    assert.equal(await page.locator('#billing-portal').innerText(), 'Manage test subscription'); await shot('4-billing-base');
    // The preview ledger lapses on its own lease while the account keeps its plan. Billing must not then say Free.
    const lapsed = async route => { const r = await route.fetch(), body = await r.json(); await route.fulfill({response: r, json: {sandbox: body.sandbox, livemode: false, tenant_id: body.tenant_id, project_id: body.project_id, paid_access: false, purchases_enabled: false, quota_enforced: true, plan_limits: body.plan_limits, status: 'blocked', reason: 'sandbox_entitlement_reconciliation_required'}}); };
    await page.route('**/api/billing/sandbox-entitlement*', lapsed); await page.locator('#billing-refresh').click();
    await note('this workspace has Base plan limits. The subscription preview has lapsed; the limits stay until the next subscription event is reconciled.');
    await page.unroute('**/api/billing/sandbox-entitlement*', lapsed); await page.locator('#billing-refresh').click(); await note('this workspace has Base plan limits. The test subscription is active.');
    // Portal: switch to Pro.
    await page.locator('#billing-portal:not([disabled])').click(); await page.getByRole('button', {name: 'Switch to Pro'}).waitFor(); await shot('5-local-portal');
    await page.getByRole('button', {name: 'Switch to Pro'}).click(); await page.waitForURL(u => u.pathname === '/app/');
    await note('this workspace has Pro plan limits. The test subscription is active.');
    assert.match(await page.locator('#account-plan').innerText(), /^Pro plan \(Stripe test mode\)\./); await shot('6-billing-pro');
    assert.equal((await page.evaluate(async () => (await fetch('/api/usage')).json())).plan_limits.spans_per_month, planLimits('pro').spans_per_month);
    // Portal: cancel. Back to Free.
    await page.locator('#billing-portal:not([disabled])').click(); await page.getByRole('button', {name: 'Cancel subscription'}).waitFor();
    await page.getByRole('button', {name: 'Cancel subscription'}).click(); await page.waitForURL(u => u.pathname === '/app/');
    await note('this workspace has Free plan limits. There is no current paid test subscription.');
    assert.match(await page.locator('#account-plan').innerText(), /^Free plan \(Stripe test mode\)\./); await shot('7-billing-cancelled-free');
    const usage = await page.evaluate(async () => (await fetch('/api/usage')).json()); assert.equal(usage.plan_limits.plan_id, 'free'); assert.equal(usage.plan_limits.spans_per_month, planLimits('free').spans_per_month);
    assert.equal((await live.store._get({pk: 'TENANT#github-4242', sk: 'META'})).plan_id, undefined);
    assert.deepEqual(outside, []); assert.deepEqual(errors, []);
  } finally { await context.close(); await browser.close(); await live.close(); }
});
