// Synthetic loopback requests only; no hosted account, key or provider calls.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';
let browser;before(async()=>{browser=await launch();});after(async()=>{await browser?.close();});
async function until(predicate){const deadline=Date.now()+5000;while(!predicate()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(predicate(),'Expected the synthetic startup request to arrive');}
async function fixture(viewport={width:1280,height:800}){
 const live=await start(),context=await browser.newContext({viewport}),page=await context.newPage(),errors=[],posts=[];
 await context.route(/^(?!http:\/\/127\.0\.0\.1)/,route=>route.abort());
 page.on('pageerror',error=>errors.push(String(error)));page.on('request',r=>{if(r.method()!=='GET')posts.push(r.url());});
 await live.signIn(context);return {live,context,page,errors,posts,close:async()=>{await context.close();await live.close();}};
}
// The reachability probe is a real loopback request while the page clock is faked. A test that lets the probe answer must
// see that answer land in the page before it moves the clock past the probe deadline, or a loaded runner reports the probe
// as unanswered (#197). `watchProbe` runs before the page's scripts; `probeAnswered` returns once the page's own handlers
// for the answer have run (the evaluate round trip drains the page's microtasks).
const watchProbe=page=>page.addInitScript(()=>{const real=globalThis.fetch;globalThis.__probeAnswers=[];globalThis.fetch=function(input,...rest){const sent=real.call(this,input,...rest);if(String(input).includes('/api/auth/providers'))globalThis.__probeAnswers.push(sent.then(()=>true,()=>false));return sent;};});
const probeAnswered=async page=>assert.equal(await page.evaluate(()=>globalThis.__probeAnswers.at(-1)),true,'Expected the reachability probe to be answered');
const ready=async page=>{await page.locator('#shell').waitFor({state:'visible'});await page.locator('#usage').filter({hasText:'reserved'}).waitFor({state:'attached'});};
for(const width of [1280,390,320])test(`503 startup has a keyboard retry and restores the workspace at ${width}px`,{timeout:30000},async()=>{
 const f=await fixture({width,height:800});let failed=true,reads=0;
 await f.page.route('**/api/me',route=>{reads++;return failed?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'temporarily_unavailable'})}):route.continue();});
 try{
  await f.page.goto(f.live.origin+'/app/',{waitUntil:'networkidle'});await f.page.getByRole('button',{name:'Retry sign-in check',exact:true}).waitFor();
  assert.match(await f.page.locator('#status').textContent(),/workspace could not be reached/);assert.doesNotMatch(await f.page.locator('#status').textContent(),/upload|receipt/);assert.equal(await f.page.locator('#shell').isVisible(),false);assert.equal(reads,1);
  assert.equal(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await mkdir('test-artifacts/ui',{recursive:true});await f.page.screenshot({path:`test-artifacts/ui/startup-retry-${width}.png`,fullPage:true});
  failed=false;await f.page.locator('#startup-retry').focus();await f.page.keyboard.press('Enter');await ready(f.page);
  assert.equal(reads,2);assert.equal(await f.page.locator('#startup-actions').isVisible(),false);assert.equal(await f.page.locator('#view-home h1').evaluate(node=>node===document.activeElement),true);assert.deepEqual(f.errors,[]);assert.deepEqual(f.posts,[]);
 }finally{await f.close();}
});
for(const path of ['me','projects'])test(`a stalled ${path} times out and late completion cannot replace the retry`,{timeout:30000},async()=>{
 const f=await fixture();let stalled=true,reads=0,release;const pending=new Promise(resolve=>release=resolve);
 await f.page.clock.install();await watchProbe(f.page);
 await f.page.route('**/api/'+path,async route=>{reads++;if(stalled){await pending;try{await route.fulfill({status:503,contentType:'application/json',body:'{"error":"late-synthetic-error"}'});}catch{}}else await route.continue();});
 try{
  await f.page.goto(f.live.origin+'/app/',{waitUntil:'domcontentloaded'});await f.page.locator('#startup-cancel').waitFor();
  await until(()=>reads>0);await probeAnswered(f.page);
  await f.page.clock.fastForward(15001);await f.page.locator('#status').filter({hasText:'took too long'}).waitFor();
  assert.equal(reads,1);assert.equal(await f.page.locator('#startup-retry').isEnabled(),true);
  stalled=false;await f.page.locator('#startup-retry').click();await ready(f.page);release();await f.page.waitForLoadState('networkidle');
  assert.equal(reads,2);assert.equal(await f.page.locator('#shell').isVisible(),true);assert.doesNotMatch(await f.page.locator('#status').textContent(),/late|unavailable/);assert.deepEqual(f.errors,[]);assert.deepEqual(f.posts,[]);
 }finally{release();await f.close();}
});
test('cancel and page interruption require deliberate retry and ignore the old response',{timeout:30000},async()=>{
 const f=await fixture();let held=true,reads=0;const routes=[];
 await f.page.route('**/api/me',route=>{reads++;if(held){routes.push(route);return;}return route.continue();});
 try{
  await f.page.goto(f.live.origin+'/app/',{waitUntil:'domcontentloaded'});await until(()=>routes.length===1);await f.page.locator('#startup-cancel').click();await f.page.locator('#status').filter({hasText:'cancelled'}).waitFor();assert.equal(await f.page.locator('#startup-retry').evaluate(n=>n===document.activeElement),true);
  await f.page.locator('#startup-retry').click();await until(()=>routes.length===2);await f.page.locator('#startup-cancel').waitFor();
  await f.page.evaluate(()=>{dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));});
  await f.page.locator('#status').filter({hasText:'interrupted'}).waitFor();const before=reads;assert.equal(await f.page.locator('#startup-retry').isEnabled(),true);
  held=false;await f.page.locator('#startup-retry').click();await ready(f.page);assert.equal(reads,before+1);assert.deepEqual(f.errors,[]);assert.deepEqual(f.posts,[]);
 }finally{for(const route of routes)try{await route.abort();}catch{}await f.close();}
});
test('429 respects Retry-After without issuing a request when the cooldown ends',{timeout:30000},async()=>{
 const f=await fixture();let limited=true,reads=0;await f.page.clock.install();
 await f.page.route('**/api/me',route=>{reads++;return limited?route.fulfill({status:429,headers:{'retry-after':'2'},contentType:'application/json',body:'{"error":"rate_limit"}'}):route.continue();});
 try{
  await f.page.goto(f.live.origin+'/app/',{waitUntil:'networkidle'});assert.equal(await f.page.locator('#startup-retry').isDisabled(),true);assert.match(await f.page.locator('#status').textContent(),/Wait 2 seconds/);
  await f.page.clock.fastForward(2001);assert.equal(await f.page.locator('#startup-retry').isEnabled(),true);assert.equal(reads,1);
  limited=false;await f.page.locator('#startup-retry').click();await ready(f.page);assert.equal(reads,2);assert.deepEqual(f.posts,[]);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
test('normal startup and signed-out provider discovery preserve their existing paths',{timeout:30000},async()=>{
 const f=await fixture();try{
  await f.page.goto(f.live.origin+'/app/#settings',{waitUntil:'networkidle'});await ready(f.page);assert.equal(await f.page.locator('#startup-actions').isVisible(),false);assert.match(await f.page.locator('#provider-line').textContent(),/GitHub/);
  await f.context.clearCookies();await f.page.reload({waitUntil:'networkidle'});await f.page.getByRole('link',{name:'Continue with GitHub',exact:true}).waitFor();assert.equal(await f.page.locator('#shell').isVisible(),false);assert.equal(await f.page.locator('#startup-actions').isVisible(),false);assert.deepEqual(f.errors,[]);assert.deepEqual(f.posts,[]);
 }finally{await f.close();}
});
test('stalled provider discovery is bounded and retains the existing sign-in fallback',{timeout:30000},async()=>{
 const f=await fixture();let route;await f.context.clearCookies();await f.page.clock.install();await f.page.route('**/api/auth/providers',r=>{route=r;});
 try{
  await f.page.goto(f.live.origin+'/app/',{waitUntil:'domcontentloaded'});await until(()=>route);
  // Provider discovery is the reachability probe's answer, so the fallback appears at the probe deadline.
  await f.page.clock.fastForward(6001);await f.page.getByRole('link',{name:'Continue with GitHub',exact:true}).waitFor();assert.equal(await f.page.locator('#startup-actions').isVisible(),false);assert.deepEqual(f.posts,[]);assert.deepEqual(f.errors,[]);
 }finally{try{await route?.abort();}catch{}await f.close();}
});
// Version skew: the browser pairs this release's script with a cached page from an older release.
const stalePage=async()=>(await (await import('node:fs/promises')).readFile(new URL('../public/app/index.html',import.meta.url),'utf8')).replace('id="api-key-form"','id="api-key-form-from-an-older-release"');
test('a cached page from an older release is reloaded once and the workspace opens',{timeout:30000},async()=>{
 const f=await fixture(),stale=await stalePage();let loads=0;assert.notEqual(stale.includes('id="api-key-form"'),true);
 await f.page.route(f.live.origin+'/app/',route=>++loads===1?route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:stale}):route.continue());
 try{
  await f.page.goto(f.live.origin+'/app/',{waitUntil:'domcontentloaded'});await ready(f.page);
  assert.equal(loads,2);assert.equal(f.errors.length,1);assert.match(f.errors[0],/TypeError/);
  assert.equal(await f.page.locator('#api-key-form').count(),1);assert.deepEqual(f.posts,[]);
 }finally{await f.close();}
});
test('a page that stays out of date says so instead of hanging on the session check',{timeout:30000},async()=>{
 const f=await fixture(),stale=await stalePage();let loads=0;
 await f.page.route(f.live.origin+'/app/',route=>{loads++;return route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:stale});});
 try{
  await f.page.goto(f.live.origin+'/app/',{waitUntil:'domcontentloaded'});
  await f.page.locator('#status').filter({hasText:'This page is out of date'}).waitFor();
  assert.equal(loads,2,'one automatic reload, then the message');await f.page.waitForTimeout(300);assert.equal(loads,2);
  assert.equal(await f.page.locator('#shell').isVisible(),false);assert.deepEqual(f.posts,[]);
 }finally{await f.close();}
});
// Reachability probe and concurrent startup reads (#95).
test('a dead API is named at the probe deadline while the reads keep waiting, and the final message says both checks failed',{timeout:30000},async()=>{
 const f=await fixture();let dead=true;const seen=[],held=[];await f.page.clock.install();
 await f.page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;if(dead){seen.push(path);held.push(route);return;}return route.continue();});
 try{
  await f.page.goto(f.live.origin+'/app/',{waitUntil:'domcontentloaded'});await f.page.locator('#startup-cancel').waitFor();
  // The identity read, the projects read and the probe all leave together.
  await until(()=>seen.length===3);assert.deepEqual([...seen].sort(),['/api/auth/providers','/api/me','/api/projects']);
  await f.page.clock.fastForward(5000);assert.match(await f.page.locator('#status').textContent(),/Checking your session/);
  await f.page.clock.fastForward(1001);await f.page.locator('#status').filter({hasText:'A reachability check got no response from SupaTrace. Still waiting for the sign-in check'}).waitFor();
  // The probe informs; it does not end the wait. Cancel is still offered and Retry is not yet.
  assert.equal(await f.page.locator('#startup-cancel').isVisible(),true);assert.equal(await f.page.locator('#startup-retry').isVisible(),false);
  await f.page.clock.fastForward(9001);await f.page.locator('#status').filter({hasText:'did not finish in 15 seconds, and a separate reachability check got no response'}).waitFor();
  assert.equal(await f.page.locator('#startup-retry').isEnabled(),true);assert.equal(await f.page.locator('#shell').isVisible(),false);
  dead=false;await f.page.locator('#startup-retry').click();await ready(f.page);assert.deepEqual(f.errors,[]);assert.deepEqual(f.posts,[]);
 }finally{for(const route of held)try{await route.abort();}catch{}await f.close();}
});
test('a dead probe does not stop account reads that answer later',{timeout:30000},async()=>{
 const f=await fixture();const held=[];let probe;await f.page.clock.install();
 await f.page.route('**/api/auth/providers',route=>{probe=route;});await f.page.route('**/api/projects',route=>{held.push(route);});
 try{
  await f.page.goto(f.live.origin+'/app/',{waitUntil:'domcontentloaded'});await until(()=>held.length===1&&probe);
  await f.page.clock.fastForward(6001);await f.page.locator('#status').filter({hasText:'A reachability check got no response'}).waitFor();
  // The projects read answers at seven seconds: the workspace opens.
  await f.page.clock.fastForward(1000);await held[0].continue();await ready(f.page);assert.deepEqual(f.errors,[]);
 }finally{try{await probe?.abort();}catch{}await f.close();}
});
test('a refused connection is reported at once',{timeout:30000},async()=>{
 const f=await fixture();let down=true;await f.page.route('**/api/**',route=>down?route.abort('connectionrefused'):route.continue());
 try{
  await f.page.goto(f.live.origin+'/app/',{waitUntil:'domcontentloaded'});await f.page.locator('#status').filter({hasText:'Your workspace could not be reached'}).waitFor({timeout:5000});
  assert.equal(await f.page.locator('#startup-retry').isEnabled(),true);
  down=false;await f.page.locator('#startup-retry').click();await ready(f.page);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
test('an API that answers the probe but stalls the account read is reported as slow, not unreachable',{timeout:30000},async()=>{
 const f=await fixture();const held=[];await f.page.clock.install();await watchProbe(f.page);await f.page.route('**/api/me',route=>{held.push(route);});
 try{
  await f.page.goto(f.live.origin+'/app/',{waitUntil:'domcontentloaded'});await until(()=>held.length===1);await probeAnswered(f.page);
  await f.page.clock.fastForward(6001);assert.match(await f.page.locator('#status').textContent(),/Checking your session/);
  await f.page.clock.fastForward(9001);await f.page.locator('#status').filter({hasText:'SupaTrace answered a reachability check, but the sign-in check took too long'}).waitFor();
 }finally{for(const route of held)try{await route.abort();}catch{}await f.close();}
});
// Loaded here (a file in the `test:ui` list) instead of appended to the import tail of ui.test.mjs, which every sibling PR edits.
import './sign-in-methods-browser.test.mjs';
