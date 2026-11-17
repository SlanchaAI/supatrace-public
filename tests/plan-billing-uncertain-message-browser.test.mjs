import test from 'node:test';
import assert from 'node:assert/strict';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';
import {PLANS} from '../src/plans.mjs';
import {entitlementsFor} from '../src/entitlements.mjs';

for (const failure of ['gateway', 'abort']) {
  test(`a committed plan change with ${failure} response reports uncertainty without retrying`, {timeout: 60000}, async () => {
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
      await page.route('**/api/billing/change*', async route => {
        const body = route.request().postDataJSON(); writes.push(body); row.plan_id = body.plan;
        return failure === 'abort' ? route.abort('failed') : route.fulfill({status: 502, contentType: 'text/plain', body: 'Synthetic gateway failure'});
      });
      await page.goto(live.origin + '/app/#billing');
      const change = page.locator('#plan-billing-plans [data-plan=pro] button');
      page.once('dialog', dialog => dialog.accept()); await change.click();
      const status = page.locator('#plan-billing-status');
      await status.filter({hasText: 'outcome is unknown'}).waitFor();
      assert.match(await status.innerText(), /last verified subscription/);
      assert.match(await status.innerText(), /Refresh Billing before retrying/);
      assert.doesNotMatch(await status.innerText(), /Nothing was changed/);
      assert.match(await page.locator('#plan-billing-title').innerText(), /on Pro/);
      assert.equal(row.plan_id, 'pro');
      assert.deepEqual(writes, [{plan: 'pro'}]);
      assert.equal(await page.locator('#plan-billing-plans [data-plan=base] button').isEnabled(), true);
      assert.deepEqual(errors, []);
    } finally { await context.close(); await browser.close(); await live.close(); }
  });
}
