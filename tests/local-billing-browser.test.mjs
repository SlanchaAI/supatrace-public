import test from 'node:test';
import assert from 'node:assert/strict';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';
import {seedLocalWorkspace} from '../scripts/dev.mjs';
import {configureLocalBilling} from '../scripts/local-billing.mjs';
test('integrated local owner Checkout -> signed capture -> separate worker -> preview, without changing workspace quota',async()=>{
 const live=await start({localDev:true,configureEnvironment:async env=>{env.localBilling=await configureLocalBilling(env);}}),browser=await launch(),context=await browser.newContext();
 const outside=[],errors=[];await context.route(/^(?!http:\/\/127\.0\.0\.1)/,r=>{outside.push(r.request().url());return r.abort();});
 try{
  await seedLocalWorkspace(live);const before=await live.store.getTenant('github-4242');const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(live.origin+'/__local__/signin?account=4242');await page.locator('#shell:not([hidden])').waitFor();await page.goto(live.origin+'/app/#billing');
  await page.locator('#commercial-plan').selectOption('synthetic-paid');await page.locator('#commercial-checkout:not([disabled])').waitFor();await page.locator('#commercial-checkout').click();
  await page.getByRole('button',{name:'Complete synthetic Checkout'}).waitFor();assert.match(page.url(),/127\.0\.0\.1.*\/__local__\/checkout/);await page.getByRole('button',{name:'Complete synthetic Checkout'}).click();
  await page.waitForURL(u=>u.pathname==='/app/');await page.waitForLoadState('networkidle');const diagnostics=await page.evaluate(async()=>({note:document.querySelector('#billing-note')?.textContent,status:document.querySelector('#status')?.textContent,usage:await(await fetch('/api/usage')).json(),preview:await(await fetch('/api/billing/sandbox-entitlement')).json()}));assert.match(diagnostics.note??'',/Sandbox reconciliation: active/,JSON.stringify({diagnostics,errors}));
  const after=await live.store.getTenant('github-4242');assert.equal(after.used_bytes,before.used_bytes);assert.equal(after.byte_limit,before.byte_limit);assert.match(await page.locator('#account-plan').textContent(),/^Free plan\. Plans and upgrade are at the top of Billing\.$/);
  const preview=await page.evaluate(async()=>{const r=await fetch('/api/billing/sandbox-entitlement');return r.json();});assert.equal(preview.status,'active');assert.equal(preview.paid_access,false);assert.equal(preview.quota_enforced,false);
  assert.deepEqual(outside,[]);assert.deepEqual(errors,[]);
 }finally{await context.close();await browser.close();await live.close();}
});
