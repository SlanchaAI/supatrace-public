// Long recovery scenarios for live trace-list updates against the local harness: idle
// cost, the acceptance counter, failed and deferred reloads, hidden tabs, page restore,
// failed Refresh and sign-out, and a change that lands during a Refresh scan.
// It takes several minutes, so it runs with `npm run test:ui:live`, not in the CI UI job;
// tests/live-traces-browser.test.mjs is the short check CI runs.
import test,{before,after} from 'node:test';import assert from 'node:assert/strict';
import {start} from './harness.mjs';import {launch} from './browser.mjs';
let browser;before(async()=>{browser=await launch();});after(async()=>{await browser?.close();});
async function nav(page,name){const toggle=page.locator('#menu-toggle');if(await toggle.isVisible()&&await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();await page.locator(`#rail a[data-nav="${name}"]`).click();}
const batch=(run,id)=>({version:1,batch_id:'live-'+id,run_id:run,events:[{id,time:'2026-11-14T00:00:00Z',kind:'note',name:'Synthetic',data:{}}]});
test('live updates recover from failed, deferred, hidden, restored and overlapping states',{timeout:780000},async()=>{
 const live=await start(),context=await browser.newContext({viewport:{width:1280,height:900}});await context.route(/^(?!http:\/\/127\.0\.0\.1)/,route=>route.abort());
 const page=await context.newPage(),errors=[],catalog=[];let failCatalog=0,holdCatalog=null;
 await page.route('**/api/runs/page*',async route=>{if(holdCatalog){const wait=holdCatalog,response=await route.fetch();holdCatalog=null;await wait;await route.fulfill({response});return;}if(failCatalog>0){failCatalog--;await route.fulfill({status:503,contentType:'application/json',body:'{"error":"unavailable"}'});}else await route.continue();});
 const usageNow=()=>page.evaluate(async()=>(await (await fetch('/api/usage',{credentials:'same-origin'})).json()).storage);page.on('pageerror',error=>errors.push(String(error)));page.on('request',request=>{if(request.url().includes('/api/runs/page'))catalog.push(request.url());});
 try{
  const tenant=await live.signIn(context),key=await live.writeKey(tenant);
  await page.goto(live.origin+'/app/',{waitUntil:'networkidle'});await nav(page,'traces');
  await page.locator('#page-note').filter({hasText:'0 traces'}).waitFor();await page.locator('#live-note').filter({hasText:'Live updates on'}).waitFor();
  // Quiet account: the watch polls usage but never rescans the catalog.
  const idle=catalog.length;await page.waitForTimeout(21000);assert.equal(catalog.length,idle,'no catalog reload without a change');
  // The acceptance counter is the signal: it moves once per accepted batch and not on an identical replay.
  const before=await usageNow();assert.equal(before.accepted_uploads,0);
  await live.upload(key,batch('live-run-one','one'));
  await page.getByRole('button',{name:'Open trace live-run-one',exact:true}).waitFor({timeout:30000});assert.equal(await page.locator('#runs tr.run').count(),1);
  await live.upload(key,batch('live-run-one','one'));const after=await usageNow();assert.equal(after.accepted_uploads,1);assert.ok(after.used_bytes>before.used_bytes);
  // One change is followed by one confirming reload, then the list goes quiet again.
  const reloads=catalog.length-idle;await page.waitForTimeout(16000);assert.ok(reloads>=1&&catalog.length-idle>=2,'reload plus confirm');const quiet=catalog.length;await page.waitForTimeout(21000);assert.equal(catalog.length,quiet,'no reload loop');
  // Focus inside the rows: the list stays put and says new data is waiting.
  await page.getByRole('button',{name:'Open trace live-run-one',exact:true}).focus();await live.upload(key,batch('live-run-two','two'));
  await page.locator('#live-note').filter({hasText:'Storage or upload activity changed since this list loaded. New traces may be available: Refresh to check.'}).waitFor({timeout:30000});assert.equal(await page.locator('#runs tr.run').count(),1);
  await page.locator('#refresh').click();await page.getByRole('button',{name:'Open trace live-run-two',exact:true}).waitFor();await page.locator('#live-note').filter({hasText:'Live updates on'}).waitFor();
  // Off means off: no further reads, and the note says to use Refresh.
  await page.locator('#live-toggle').uncheck();await page.locator('#live-note').filter({hasText:'Live updates off'}).waitFor();await page.evaluate(()=>document.activeElement?.blur());
  const settled=catalog.length;await live.upload(key,batch('live-run-three','three'));await page.waitForTimeout(21000);assert.equal(catalog.length,settled);assert.equal(await page.locator('#runs tr.run').count(),2);
  await page.locator('#live-toggle').check();await page.locator('#live-note').filter({hasText:'Live updates on'}).waitFor();
  await page.getByRole('button',{name:'Open trace live-run-three',exact:true}).waitFor({timeout:30000});
  // A failed catalog reload is retried: the change is not lost.
  await page.waitForTimeout(16000);failCatalog=1;await live.upload(key,batch('live-run-four','four'));await page.getByRole('button',{name:'Open trace live-run-four',exact:true}).waitFor({timeout:60000});assert.equal(failCatalog,0,'the failing reload was exercised');assert.equal(await page.locator('#runs tr.run').count(),4);
  // Hidden tab: no usage polls turn into catalog scans; the pending change is shown on return.
  await page.waitForTimeout(16000);await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});
  const hiddenAt=catalog.length;await live.upload(key,batch('live-run-five','five'));await page.waitForTimeout(21000);assert.equal(catalog.length,hiddenAt,'no catalog work while hidden');assert.equal(await page.locator('#runs tr.run').count(),4);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});document.dispatchEvent(new Event('visibilitychange'));});await page.getByRole('button',{name:'Open trace live-run-five',exact:true}).waitFor({timeout:30000});
  // Back/forward cache: pagehide stops the watch and suspends the session view; a persisted pageshow restarts it.
  await page.waitForTimeout(16000);await page.evaluate(()=>{window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));});await page.locator('#live-note').filter({hasText:'Live updates off'}).waitFor();
  await page.evaluate(()=>{window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));});await page.locator('#live-note').filter({hasText:'Live updates on'}).waitFor({timeout:15000});
  await live.upload(key,batch('live-run-six','six'));await page.getByRole('button',{name:'Open trace live-run-six',exact:true}).waitFor({timeout:40000});
  // A Refresh that fails must not swallow a change the watch already saw.
  await page.waitForTimeout(16000);await page.getByRole('button',{name:'Open trace live-run-six',exact:true}).focus();await live.upload(key,batch('live-run-seven','seven'));
  await page.locator('#live-note').filter({hasText:'New traces may be available'}).waitFor({timeout:30000});failCatalog=1;await page.locator('#refresh').click();
  await page.locator('#page-note').filter({hasText:'Could not load traces'}).waitFor({timeout:15000});assert.equal(failCatalog,0);await page.getByRole('button',{name:'Open trace live-run-seven',exact:true}).waitFor({timeout:40000});
  // A sign-out that fails restores the session; live updates must come back with it.
  await page.waitForTimeout(16000);await page.route('**/api/auth/logout',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"unavailable"}'}),{times:1});
  await page.locator('#logout').click();await page.locator('#live-note').filter({hasText:'Live updates on'}).waitFor({timeout:20000});
  await live.upload(key,batch('live-run-eight','eight'));await page.getByRole('button',{name:'Open trace live-run-eight',exact:true}).waitFor({timeout:40000});
  // A change seen while a manual Refresh is still scanning must survive that Refresh. The held
  // response is the catalog as it was before the upload, delivered after the watch saw the change.
  await page.waitForTimeout(16000);await page.evaluate(()=>document.activeElement?.blur());let release;holdCatalog=new Promise(resolve=>release=resolve);
  await page.locator('#refresh').click();await page.waitForTimeout(1500);assert.equal(holdCatalog,null,'the Refresh scan is being held');
  await live.upload(key,batch('live-run-nine','nine'));await page.waitForTimeout(13000);release();
  await page.locator('#refresh:not([disabled])').waitFor({timeout:20000});assert.equal(await page.locator('#runs tr.run').count(),8,'Refresh finished with the older catalog');
  await page.getByRole('button',{name:'Open trace live-run-nine',exact:true}).waitFor({timeout:40000});
  assert.deepEqual(errors,[]);
 }finally{await context.close();await live.close();}
});
test('a failed first usage read does not hide an upload that lands before the first good poll',{timeout:120000},async()=>{
 const live=await start(),context=await browser.newContext({viewport:{width:1280,height:900}});await context.route(/^(?!http:\/\/127\.0\.0\.1)/,route=>route.abort());
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(String(error)));let usageReads=0,release;const held=new Promise(resolve=>release=resolve);
 // Read 1 (startup) fails, so the list loads with no seed. Read 2 (the watch's first poll) is held
 // until an upload is accepted, so the baseline the watch acquires already contains that upload.
 await page.route('**/api/usage*',async route=>{usageReads++;if(usageReads===1){await route.fulfill({status:503,contentType:'application/json',body:'{"error":"unavailable"}'});return;}if(usageReads===2)await held;await route.continue();});
 try{
  const tenant=await live.signIn(context),key=await live.writeKey(tenant);
  await page.goto(live.origin+'/app/',{waitUntil:'domcontentloaded'});await nav(page,'traces');await page.locator('#page-note').filter({hasText:'0 traces'}).waitFor();
  const deadline=Date.now()+15000;while(usageReads<2&&Date.now()<deadline)await page.waitForTimeout(100);assert.ok(usageReads>=2,'the first poll is in flight');
  await live.upload(key,batch('live-run-early','early'));release();
  await page.getByRole('button',{name:'Open trace live-run-early',exact:true}).waitFor({timeout:40000});
  assert.deepEqual(errors,[]);
 }finally{release();await context.close();await live.close();}
});
test('a catalog that fails more than six times in a row is still retried and recovers with no new upload',{timeout:540000},async()=>{
 const live=await start(),context=await browser.newContext({viewport:{width:1280,height:900}});await context.route(/^(?!http:\/\/127\.0\.0\.1)/,route=>route.abort());
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(String(error)));let failing=0,failed=0;
 await page.route('**/api/runs/page*',async route=>{if(failing>0){failing--;failed++;await route.fulfill({status:503,contentType:'application/json',body:'{"error":"unavailable"}'});}else await route.continue();});
 try{
  const tenant=await live.signIn(context),key=await live.writeKey(tenant);
  await page.goto(live.origin+'/app/',{waitUntil:'networkidle'});await nav(page,'traces');await page.locator('#page-note').filter({hasText:'0 traces'}).waitFor();await page.locator('#live-note').filter({hasText:'Live updates on'}).waitFor();
  failing=7;await live.upload(key,batch('live-run-late','late'));
  // Past the sixth failure the page says new traces may be available, and keeps trying once a minute.
  await page.locator('#live-note').filter({hasText:'New traces may be available'}).waitFor({timeout:300000});assert.ok(failed>=6);
  await page.getByRole('button',{name:'Open trace live-run-late',exact:true}).waitFor({timeout:200000});assert.equal(failed,7);assert.equal(failing,0);
  assert.deepEqual(errors,[]);
 }finally{await context.close();await live.close();}
});
test('a failed reload followed by switching live updates off and on still shows the upload',{timeout:150000},async()=>{
 const live=await start(),context=await browser.newContext({viewport:{width:1280,height:900}});await context.route(/^(?!http:\/\/127\.0\.0\.1)/,route=>route.abort());
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(String(error)));let failing=0,failed=0;
 await page.route('**/api/runs/page*',async route=>{if(failing>0){failing--;failed++;await route.fulfill({status:503,contentType:'application/json',body:'{"error":"unavailable"}'});}else await route.continue();});
 try{
  const tenant=await live.signIn(context),key=await live.writeKey(tenant);
  await page.goto(live.origin+'/app/',{waitUntil:'networkidle'});await nav(page,'traces');await page.locator('#page-note').filter({hasText:'0 traces'}).waitFor();await page.locator('#live-note').filter({hasText:'Live updates on'}).waitFor();
  failing=1;await live.upload(key,batch('live-run-restart','restart'));
  const deadline=Date.now()+40000;while(failed<1&&Date.now()<deadline)await page.waitForTimeout(200);assert.equal(failed,1,'the change-triggered reload failed');
  // Restarting drops the pending retry. The seed must still be the last list that loaded, so the unchanged counter reads as a change.
  await page.locator('#live-toggle').uncheck();await page.locator('#live-note').filter({hasText:'Live updates off'}).waitFor();await page.locator('#live-toggle').check();
  await page.getByRole('button',{name:'Open trace live-run-restart',exact:true}).waitFor({timeout:40000});assert.equal(failed,1);
  assert.deepEqual(errors,[]);
 }finally{await context.close();await live.close();}
});
