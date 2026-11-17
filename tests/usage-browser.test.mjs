// Synthetic loopback browser coverage; not hosted or real provider acceptance.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';
let browser;before(async()=>{browser=await launch();});after(async()=>{await browser?.close();});
const data=()=>({storage:{used_bytes:5,limit_bytes:100,remaining_bytes:95,accounting:'cumulative_reserved_bytes'},account_plan:{name:'Synthetic alpha',billing_status:'not_configured',paid_active:false,paid_activation_enabled:false},billing:{sandbox:true,portal_available:true,purchases_enabled:false,paid_access:false},commercial:{available:true,mode:'sandbox_preview',policy_version:'synthetic-v1',policy_hash:'a'.repeat(64),terms_url:'https://supatrace.dev/terms.html',plans:[{id:'synthetic-pro',name:'Synthetic Pro',price_id:'price_syntheticOne',unit_amount:200,currency:'usd',interval:'month',storage_limit_bytes:200000}],paid_access:false,purchases_enabled:false}});
async function until(predicate){const deadline=Date.now()+5000;while(!predicate()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(predicate(),'Expected pending usage route to register');}
async function nav(page,name){const toggle=page.locator('#menu-toggle');if(await toggle.isVisible()&&await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();await page.locator(`#rail a[data-nav="${name}"]`).click();}
for(const viewport of [{width:1280,height:800},{width:390,height:844},{width:320,height:740}])test(`usage refresh/cancel/retry surfaces at ${viewport.width}px`,{timeout:60000},async()=>{
 const live=await start(),context=await browser.newContext({viewport}),releases=[];let mode='ready',reads=0;
 await context.route(/^(?!http:\/\/127\.0\.0\.1)/,route=>route.abort());await context.route('**/api/billing/catalog*',route=>route.fulfill({status:503,json:{error:'synthetic_catalog_unavailable'}}));const page=await context.newPage(),errors=[],posts=[];page.on('pageerror',e=>errors.push(String(e)));page.on('request',r=>{if(r.method()==='POST')posts.push(r.url());});
 await page.route('**/api/usage?*',async route=>{reads++;const current=mode;if(current==='pending')await new Promise(resolve=>releases.push(resolve));const value=data();if(current==='malformed')value.storage.remaining_bytes=96;try{await route.fulfill({status:current==='failed'?503:200,contentType:'application/json',body:JSON.stringify(current==='failed'?{error:'SYNTHETIC-PRIVATE-ERROR'}:value)});}catch{/* A cancelled request can finish after the browser abort. */}});
 try{
  await live.signIn(context);await page.goto(live.origin+'/app/',{waitUntil:'networkidle'});await page.locator('#usage').filter({hasText:'5 of 100'}).waitFor();
  mode='pending';const before=reads;await page.locator('#usage-refresh-home').click();await until(()=>releases.length===1);await page.waitForFunction(()=>document.getElementById('usage-cancel-home').hidden===false);assert.equal(reads,before+1);assert.equal(await page.locator('#usage-refresh-home').isDisabled(),true);assert.equal(await page.locator('#usage').getAttribute('aria-busy'),'true');
  await page.locator('#usage-cancel-home').click();await page.locator('#usage').filter({hasText:'cancelled'}).waitFor();mode='ready';releases.splice(0).forEach(resolve=>resolve());await page.locator('#usage-refresh-home').click();await page.locator('#usage').filter({hasText:'5 of 100'}).waitFor();
  await nav(page,'billing');await page.selectOption('#commercial-plan','synthetic-pro');assert.equal(await page.locator('#commercial-checkout').isEnabled(),true);
  mode='pending';await page.locator('#billing-refresh').click();await until(()=>releases.length===1);await page.locator('#plan-page').filter({hasText:'Checking'}).waitFor();assert.equal(await page.locator('#commercial-checkout').isDisabled(),true);assert.equal(await page.locator('#billing-portal').isVisible(),false);assert.equal(await page.locator('#plan-meta').textContent(),'');await page.locator('#billing-cancel').click();releases.splice(0).forEach(resolve=>resolve());
  for(const next of ['failed','malformed']){mode=next;await page.locator('#billing-refresh').click();await page.locator('#billing-note').filter({hasText:'status unavailable'}).waitFor();assert.equal(await page.locator('#billing-refresh').textContent(),'Retry billing');assert.equal(await page.locator('#billing-refresh').isEnabled(),true);assert.match(await page.locator('#billing-note').textContent(),/status unavailable/);assert.equal(await page.getByText('SYNTHETIC-PRIVATE-ERROR').count(),0);assert.equal(await page.locator('#commercial-selector').isVisible(),false);}
  mode='ready';await page.locator('#billing-refresh').click();await page.locator('#plan-page').filter({hasText:'Synthetic alpha'}).waitFor();assert.equal(await page.locator('#usage-page').getAttribute('aria-busy'),'false');assert.equal(await page.locator('#usage').textContent(),await page.locator('#usage-page').textContent());assert.equal(await page.locator('#commercial-checkout').isEnabled(),true);
  const fits=await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);assert.equal(fits,true);assert.deepEqual(posts,[]);assert.deepEqual(errors,[]);
 }finally{releases.splice(0).forEach(resolve=>resolve());await context.close();await live.close();}
});

for(const viewport of [{width:1280,height:800},{width:390,height:844},{width:320,height:740}])test(`sandbox Checkout reload and return recovery at ${viewport.width}px`,{timeout:60000},async()=>{
 const live=await start(),context=await browser.newContext({viewport}),page=await context.newPage(),posts=[],errors=[];
 let mode='uncertain';page.on('pageerror',error=>errors.push(String(error)));
 await context.route('**/api/billing/catalog*',route=>route.fulfill({status:503,json:{error:'synthetic_catalog_unavailable'}}));
 // Synthetic provider page only; every external request is fulfilled locally or aborted.
 await context.route(/^(?!http:\/\/127\.0\.0\.1)/,route=>route.request().url()==='https://checkout.stripe.com/c/pay/cs_test_SyntheticReload'?route.fulfill({contentType:'text/html',body:'<!doctype html><title>Synthetic Checkout</title><p>Synthetic provider placeholder</p>'}):route.abort());
 await page.route('**/api/usage?*',route=>route.fulfill({contentType:'application/json',body:JSON.stringify(data())}));
 await page.route('**/api/billing/checkout?*',route=>{
  posts.push({url:route.request().url(),body:route.request().postDataJSON()});
  const status=mode==='uncertain'?503:mode==='blocked'?409:201;
  const value=mode==='uncertain'?{error:'billing_operation_unavailable'}:mode==='blocked'?{error:'checkout_intent_expired_requires_reconciliation'}:{session_id:'cs_test_SyntheticReload',url:'https://checkout.stripe.com/c/pay/cs_test_SyntheticReload',livemode:false,status:'open',purchases_enabled:false};
  return route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
 });
 try{
  await live.signIn(context);await page.goto(live.origin+'/app/#billing',{waitUntil:'networkidle'});
  await page.selectOption('#commercial-plan','synthetic-pro');await page.locator('#commercial-checkout').click();
  await page.locator('#checkout-note').filter({hasText:'outcome could not be confirmed'}).waitFor();assert.equal(posts.length,1);assert.match(posts[0].url,/project=proj_[a-f0-9]{32}$/);
  await page.evaluate(()=>{dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));});
  await page.locator('#checkout-note').filter({hasText:'Reload this page to verify'}).waitFor();assert.equal(await page.locator('#commercial-checkout').isDisabled(),true);assert.equal(posts.length,1);
  await page.reload({waitUntil:'networkidle'});await page.locator('#checkout-note').filter({hasText:'Recovered this tab'}).waitFor();
  assert.equal(posts.length,1);assert.equal(await page.locator('#commercial-plan').inputValue(),'synthetic-pro');assert.equal(await page.locator('#commercial-plan').isDisabled(),true);
  assert.match(await page.locator('#usage-page').textContent(),/5 of 100 bytes/);assert.equal(await page.locator('#plan-page').textContent(),'Synthetic alpha.');
  mode='open';await page.locator('#commercial-checkout').click();await page.waitForURL('https://checkout.stripe.com/c/pay/cs_test_SyntheticReload');assert.equal(posts.length,2);assert.deepEqual(posts[1],posts[0]);
  await page.goto(live.origin+'/app/?billing=cancelled',{waitUntil:'networkidle'});await page.locator('#checkout-note').filter({hasText:'Recovered this tab'}).waitFor();
  assert.match(page.url(),/#billing$/);assert.equal(posts.length,2);
  await nav(page,'traces');await page.reload({waitUntil:'networkidle'});assert.match(page.url(),/#traces$/);await nav(page,'billing');assert.equal(await page.locator('#commercial-checkout').isEnabled(),true);
  const saved=await page.evaluate(()=>Object.entries(sessionStorage).filter(([key])=>key.startsWith('supatrace.sandbox-checkout.v1:')));
  assert.equal(saved.length,1);assert.equal(JSON.parse(saved[0][1]).request_id,posts[0].body.request_id);assert.doesNotMatch(saved[0][1],/cs_test_|checkout\.stripe\.com|secret|payment_status/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await mkdir('test-artifacts/ui',{recursive:true});await page.screenshot({path:`test-artifacts/ui/billing-recovery-${viewport.width}.png`,fullPage:true});
  mode='blocked';await page.locator('#commercial-checkout').click();await page.locator('#checkout-note').filter({hasText:'needs reconciliation'}).waitFor();assert.equal(posts.length,3);assert.deepEqual(posts[2],posts[0]);
  await page.reload({waitUntil:'networkidle'});await page.locator('#checkout-note').filter({hasText:'saved sandbox request needs reconciliation'}).waitFor();assert.equal(await page.locator('#commercial-checkout').isDisabled(),true);assert.equal(posts.length,3);
  await live.signIn(context,4343);await page.reload({waitUntil:'networkidle'});await page.locator('#commercial-plan').waitFor();assert.equal(await page.locator('#commercial-plan').inputValue(),'');assert.equal(await page.locator('#commercial-plan').isEnabled(),true);assert.equal(posts.length,3);assert.deepEqual(errors,[]);
 }finally{await context.close();await live.close();}
});
