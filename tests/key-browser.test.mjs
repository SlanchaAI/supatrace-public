// Rendered acceptance source; synthetic loopback only, never hosted or real-device proof.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';
let browser;before(async()=>{browser=await launch();});after(async()=>{await browser?.close();});
async function nav(page,name){const toggle=page.locator('#menu-toggle');if(await toggle.isVisible()&&await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();await page.locator(`#rail a[data-nav="${name}"]`).click();}
for(const viewport of [{width:1280,height:800},{width:390,height:844},{width:320,height:740}]){
 test(`key status recovery, cancel, expiry and revoke confirmation at ${viewport.width}px`,{timeout:60000},async()=>{
  const live=await start(),context=await browser.newContext({viewport});await context.route(/^(?!http:\/\/127\.0\.0\.1)/,route=>route.abort());
  let mode='normal',release=null,reads=0;const errors=[],page=await context.newPage();page.on('pageerror',error=>errors.push(String(error)));
  try{
   const tenant=await live.signIn(context);await live.writeKey(tenant);
   await context.route('**/api/keys?*',async route=>{reads++;if(mode==='slow')await new Promise(resolve=>release=resolve);if(mode==='failure'){await route.fulfill({status:503,contentType:'application/json',body:'{"error":"private-server-value"}'});return;}try{const response=await route.fetch();const body=await response.json();if(mode==='expiry')body.keys=body.keys.map(key=>({...key,expires_at:Math.floor(Date.now()/1000)+2}));await route.fulfill({response,json:body});}catch{if(mode!=='normal')throw Error('Unexpected key fixture route failure');}});
   await page.goto(live.origin+'/app/',{waitUntil:'networkidle'});await nav(page,'keys');await page.waitForFunction(()=>document.getElementById('keys-note').textContent.includes('1 key checked'));
   const chosen=await page.locator('#agent-filter option').last().getAttribute('value');await nav(page,'traces');await page.locator('#agent-filter').selectOption(chosen);await nav(page,'keys');await page.waitForFunction(()=>document.getElementById('keys-note').textContent.includes('1 key checked'));
   mode='failure';await page.click('#keys-refresh');await page.waitForFunction(()=>document.getElementById('keys-refresh').textContent==='Retry keys');assert.equal(await page.locator('#keys .key').count(),1);assert.equal(await page.locator('#keys .key button').isDisabled(),true);assert.equal(await page.locator('#agent-filter').inputValue(),chosen);assert.doesNotMatch(await page.locator('#keys-note').textContent(),/private-server-value/);
   mode='normal';await page.click('#keys-refresh');await page.waitForFunction(()=>document.getElementById('keys-note').textContent.includes('1 key checked'));assert.equal(await page.locator('#keys .key button').isDisabled(),false);
   mode='slow';release=null;await page.click('#keys-refresh');while(!release)await new Promise(resolve=>setTimeout(resolve,5));await page.click('#keys-cancel');assert.match(await page.locator('#keys-note').textContent(),/cancelled/);mode='normal';release();await page.click('#keys-refresh');await page.waitForFunction(()=>document.getElementById('keys-note').textContent.includes('1 key checked'));
   mode='slow';release=null;await page.click('#keys-refresh');while(!release)await new Promise(resolve=>setTimeout(resolve,5));await nav(page,'home');mode='normal';release();await nav(page,'keys');await page.waitForFunction(()=>document.getElementById('keys-note').textContent.includes('1 key checked'));
   mode='expiry';await page.click('#keys-refresh');await page.waitForFunction(()=>document.querySelector('#keys .key td:nth-child(5)')?.textContent==='active'&&document.getElementById('keys-refresh').disabled===false);const before=reads;await page.getByRole('cell',{name:'expired',exact:true}).waitFor();assert.equal(reads,before,'expiry rendering issues no network request');
   mode='failure';await page.locator('#keys .key button').click();await page.waitForFunction(()=>document.getElementById('keys-note').textContent.startsWith('Revocation confirmed.'));assert.equal(await page.locator('#keys .key button').count(),0);assert.match(await page.locator('#keys').textContent(),/revoked/);assert.match(await page.locator('#keys-note').textContent(),/Previous list/);
   const width=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,inner:innerWidth}));assert.ok(width.scroll<=width.inner,'no page horizontal overflow');assert.deepEqual(errors,[]);
  }finally{release?.();await context.close();await live.close();}
 });
}
