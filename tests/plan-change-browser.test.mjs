import test from 'node:test';
import assert from 'node:assert/strict';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';
import {PLANS} from '../src/plans.mjs';
import {entitlementsFor} from '../src/entitlements.mjs';

test('paid plan change confirms price, refreshes gates and keeps the paid plan on failure', {timeout: 60000}, async () => {
  const live = await start(), browser = await launch(), context = await browser.newContext();
  try {
    await context.route(/^(?!http:\/\/127\.0\.0\.1)/, route => route.abort());
    const tenant = await live.signIn(context), row = live.store.client.items.get('TENANT#' + tenant + '\0META');
    row.plan_id = 'base'; const page = await context.newPage(), errors = [], writes = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/billing/catalog*', route => route.fulfill({json: {
      checkout_available: true, current_plan: row.plan_id, current_plan_name: row.plan_id === 'base' ? 'Base' : 'Pro', plan_source: 'subscription', portal_available: true,
      plans: PLANS.plans.map(plan => ({id: plan.id, name: plan.name, price_kind: plan.price_kind, monthly_usd_cents: Math.round(plan.monthly_base_usd * 100), current: plan.id === row.plan_id,
        limits: entitlementsFor(plan.id).limits, features: [], action: plan.id === row.plan_id ? 'none' : ['base', 'pro'].includes(plan.id) ? 'change' : 'none'}))
    }}));
    let fail = false;
    await page.route('**/api/billing/change*', async route => {
      const body = route.request().postDataJSON(); writes.push(body);
      if (fail) return route.fulfill({status: 502, json: {error: 'plan_billing_provider_error'}});
      row.plan_id = body.plan; return route.fulfill({json: {plan: body.plan, changed: true, test_mode: true}});
    });
    await page.goto(live.origin + '/app/#billing');
    const change = id => page.locator('#plan-billing-plans [data-plan=' + id + '] button');
    page.once('dialog', dialog => { assert.match(dialog.message(), /Pro at \$25\.99 \/ month/); return dialog.dismiss(); });
    await change('pro').click(); assert.equal(writes.length, 0);
    page.once('dialog', dialog => dialog.accept()); await change('pro').click();
    await page.locator('#plan-billing-title').filter({hasText: 'on Pro'}).waitFor();
    await page.waitForFunction(() => document.getElementById('plan-entitlements-title')?.textContent === 'Pro plan');
    assert.deepEqual(writes, [{plan: 'pro'}]);
    fail = true; page.once('dialog', dialog => dialog.accept()); await change('base').click();
    await page.locator('#plan-billing-status').filter({hasText: 'Stripe could not confirm'}).waitFor();
    assert.match(await page.locator('#plan-billing-title').innerText(), /on Pro/); assert.equal(await change('base').isEnabled(), true);
    assert.deepEqual(errors, []);
  } finally { await context.close(); await browser.close(); await live.close(); }
});
