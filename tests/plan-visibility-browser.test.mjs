import test from 'node:test';
import assert from 'node:assert/strict';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';
for(const width of [1440,390]) for(const plan of ['free','pro','enterprise']) test(`${plan} plan visibility and audit settle at ${width}`,async()=>{
 const live=await start({plan}),browser=await launch(),context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 try{
  await live.signIn(context);await page.goto(live.origin+'/app/#members',{waitUntil:'networkidle'});
  await page.locator('#share-workspace input').fill('Review team');await page.locator('#share-workspace button').click();await page.locator('#team-members:not([hidden])').waitFor();
  await page.evaluate(()=>location.hash='billing');
  await page.locator('#plan-entitlements').waitFor();
  assert.equal(await page.locator('#plan-billing-mode').textContent(),'Payments are processed by Stripe.');
  assert.doesNotMatch(await page.locator('#view-billing').innerText(), /No live payment|not live yet/i);
  assert.equal(await page.locator('#retention-form').count(),plan==='enterprise'?1:0);
  assert.equal(await page.locator('#view-billing a').filter({hasText:'Upgrade in Billing'}).count(),0);
  assert.equal(await page.locator('#cost-control').isVisible(),plan!=='free');
  await page.evaluate(()=>location.hash='members');
  await page.locator('#sso-controls').waitFor({state:'attached'});
  assert.equal(await page.locator('#sso-form').isVisible(),plan==='enterprise');
  assert.equal(await page.locator('#org-security').isVisible(),plan==='enterprise');
  await page.evaluate(()=>location.hash='audit');
  if(plan==='free'){
   await page.waitForFunction(()=>document.getElementById('view-home').hidden===false);
   assert.equal(await page.locator('#rail [data-nav=audit]').isVisible(),false);
   assert.equal(await page.locator('#view-audit').isVisible(),false);
  }else{
   await page.locator('#audit-status').filter({hasText:/event.*shown|No events/}).waitFor();
   assert.equal(await page.locator('#audit-export-plan').count(),plan==='pro'?1:0);
   assert.equal(await page.locator('#audit-export-json').isVisible(),plan==='enterprise');
   assert.doesNotMatch(await page.locator('#view-audit').textContent(),/Loading…/);
  }
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
 }finally{await context.close();await browser.close();await live.close();}
});

test('audit entitlement failure shows a retry and recovers paid events',async()=>{
 const live=await start({plan:'pro'}),browser=await launch(),context=await browser.newContext(),page=await context.newPage();
 let failing=true;
 try {
  await live.signIn(context);
  await context.route('**/api/entitlements*',route=>failing?route.fulfill({status:503,contentType:'application/json',body:'{"error":"unavailable"}'}):route.continue());
  await page.goto(live.origin+'/app/#audit');
  await page.locator('#audit-plan-status').filter({hasText:'Audit access could not be checked. Try again.'}).waitFor();
  assert.equal(await page.locator('#audit-plan-retry').isVisible(),true);
  failing=false;await page.locator('#audit-plan-retry').click();
  await page.locator('#audit-status').filter({hasText:/event.*shown|No events/}).waitFor();
  assert.equal(await page.locator('#audit-plan-retry').isVisible(),false);
  assert.equal(await page.locator('#audit-export-plan').count(),1);
 }finally {await context.close();await browser.close();await live.close();}
});

for(const width of [1440,390]) test(`Free audit deep links redirect at ${width}`,async()=>{
 const live=await start(),browser=await launch(),context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage();
 try {
  await live.signIn(context);
  await page.goto(live.origin+'/app/#audit?from=2026-01-01',{waitUntil:'networkidle'});
  await page.waitForURL('**/#home');
  for(const hash of ['audit/older','audit?actor=fake-review']) {
   await page.evaluate(hash=>location.hash=hash,hash);
   await page.waitForFunction(()=>document.getElementById('view-home').hidden===false);
   assert.equal(await page.locator('#view-audit').isVisible(),false);
  }
  assert.equal(await page.locator('#rail [data-nav=audit]').isVisible(),false);
 } finally {await context.close();await browser.close();await live.close();}
});

for(const width of [1440,390]) test(`Billing guidance remains conditional when payment actions are unavailable at ${width}`,async()=>{
 const live=await start(),browser=await launch(),context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage();
 try {
  await live.signIn(context);
  await context.route('**/api/billing/catalog*',async route=>{
   const response=await route.fetch(),catalog=await response.json();
   await route.fulfill({response,json:{...catalog,mode:'unavailable',test_mode:false,checkout_available:false,portal_available:false,plans:catalog.plans.map(plan=>({...plan,action:['base','pro'].includes(plan.id)?'unavailable':plan.action}))}});
  });
  await page.goto(live.origin+'/app/#billing',{waitUntil:'networkidle'});
  await page.locator('#plan-billing').waitFor();
  assert.equal(await page.getByRole('button',{name:'Manage subscription',exact:true}).isVisible(),false);
  assert.equal(await page.getByRole('button',{name:'Checkout not available yet',exact:true}).count(),2);
  assert.equal(await page.locator('#billing-management').textContent(),'Payment methods and invoices are available through Manage subscription when shown. Payments are processed by Stripe.');
  assert.equal(await page.locator('#plan-billing-mode').textContent(),'Payments are processed by Stripe.');
 } finally {await context.close();await browser.close();await live.close();}
});
