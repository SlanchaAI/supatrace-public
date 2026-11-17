import test from 'node:test';
import assert from 'node:assert/strict';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';
import {PLANS} from '../src/plans.mjs';
import {entitlementsFor} from '../src/entitlements.mjs';

for (const failure of ['gateway', 'connection']) test(`Billing reconciles a completed change after ${failure} failure`, {timeout:60000}, async () => {
  const live=await start({plan:'base'}), browser=await launch(), context=await browser.newContext();
  try {
    await context.route(/^(?!http:\/\/127\.0\.0\.1)/, r=>r.abort());
    const tenant=await live.signIn(context), page=await context.newPage(), errors=[]; let current='base', writes=0, reads=0;
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/api/billing/catalog*',r=>{
      reads++;
      return r.fulfill({json:{current_plan:current,current_plan_name:current==='base'?'Base':'Pro',checkout_available:true,portal_available:false,plans:PLANS.plans.map(p=>({id:p.id,name:p.name,price_kind:p.price_kind,monthly_usd_cents:p.monthly_base_usd*100,current:p.id===current,limits:entitlementsFor(p.id).limits,features:[],action:['base','pro'].includes(p.id)&&p.id!==current?'change':null}))}});
    });
    await page.route('**/api/billing/change*',r=>{
      writes++; current='pro'; live.store.client.items.get('TENANT#'+tenant+'\0META').plan_id='pro';
      return failure==='gateway'?r.fulfill({status:502,body:'Bad Gateway'}):r.abort('failed');
    });
    await page.goto(live.origin+'/app/#billing');
    await page.locator('#plan-billing-title').filter({hasText:'on Base'}).waitFor();
    const before=reads; page.once('dialog',d=>d.accept());
    await page.locator('#plan-billing-plans [data-plan=pro] button[data-action=change]').click();
    await page.locator('#plan-billing-title').filter({hasText:'on Pro'}).waitFor();
    await page.locator('#plan-billing-status').filter({hasText:'Stripe could not confirm the request'}).waitFor();
    assert.ok(reads>before); assert.equal(writes,1);
    assert.doesNotMatch(await page.locator('#plan-billing-status').innerText(),/Nothing was changed/);
    await page.locator('#plan-entitlements-title').filter({hasText:'Pro plan'}).waitFor();
    assert.deepEqual(errors,[]);
  } finally {await context.close();await browser.close();await live.close();}
});
