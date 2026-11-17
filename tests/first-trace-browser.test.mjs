// Rendered check of the get-started path against the local harness: a new account creates
// a key in one click, runs the Node snippet exactly as shown, and the card flips to the
// first trace without Refresh, pairing code or terminal approval. Hosted proof is separate.
import test,{before,after} from 'node:test';import assert from 'node:assert/strict';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {start} from './harness.mjs';import {launch} from './browser.mjs';
let browser;before(async()=>{browser=await launch();});after(async()=>{await browser?.close();});
async function nav(page,name){const toggle=page.locator('#menu-toggle');if(await toggle.isVisible()&&await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();await page.locator(`#rail a[data-nav="${name}"]`).click();}
for(const viewport of [{width:1280,height:900},{width:390,height:844}])test(`new account reaches a visible first trace from the Home card at ${viewport.width}px`,{timeout:240000},async()=>{
 const live=await start(),context=await browser.newContext({viewport});await context.route(/^(?!http:\/\/127\.0\.0\.1)/,route=>route.abort());
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(String(error)));
 try{
  const tenant=await live.signIn(context);await page.goto(live.origin+'/app/',{waitUntil:'networkidle'});await nav(page,'home');
  await page.locator('#first-trace').getByRole('heading',{name:'Send your first trace'}).waitFor();assert.equal(await page.locator('#first-snippets').isVisible(),false);assert.equal(await page.locator('#first-wait').isVisible(),false);
  const started=Date.now();await page.locator('#first-key').click();
  await page.locator('#first-wait').filter({hasText:'Waiting for your first trace'}).waitFor({timeout:20000});await page.locator('#first-key-note').filter({hasText:'until you dismiss'}).waitFor();
  for(const [tab,opening] of [['python',/^import hashlib/],['curl',/^BODY='/],['node',/^import \{createHash\}/]]){await page.locator('#first-tab-'+tab).click();assert.match(await page.locator('#first-snippet').textContent(),opening);assert.equal(await page.locator('#first-tab-'+tab).getAttribute('aria-selected'),'true');}
  const snippet=await page.locator('#first-snippet').textContent();assert.match(snippet,/'x-supatrace-key': 'st_pub_[A-Za-z0-9_-]{43}'/);assert.match(await page.locator('#first-key-note').textContent(),/can only send traces, and it does not expire/);assert.ok(snippet.includes(live.origin+'/api/batches?project=proj_'));
  // Someone else's trace arrives first and the reader re-sorts the list: the card neither claims that trace nor stops watching.
  await live.upload(await live.writeKey(tenant),{version:1,batch_id:'other-batch',run_id:'other-run',events:[{id:'x',time:'2026-11-14T00:00:00Z',kind:'note',name:'Other writer',data:{}}]});
  await nav(page,'traces');await page.getByRole('button',{name:'Open trace other-run',exact:true}).waitFor({timeout:40000});await page.locator('button.sort[data-sort="events"]').click();await page.locator('button.sort[data-sort="events"]').click();
  await nav(page,'home');assert.equal(await page.locator('#first-trace').isVisible(),true);assert.match(await page.locator('#first-wait').textContent(),/^Waiting for your first trace/);assert.equal(await page.locator('#first-open').isVisible(),false);
  const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',snippet],{encoding:'utf8',timeout:20000});assert.match(stdout,/^201 .*"accepted":true/);
  await page.locator('#first-wait').filter({hasText:/^First trace received \d+ s after the key was shown\.$/}).waitFor({timeout:40000});const elapsed=Date.now()-started;assert.ok(elapsed<120000,'first trace visible in under two minutes locally: '+elapsed+' ms');
  assert.equal(await page.locator('#first-trace').isVisible(),true);const open=page.locator('#first-open');assert.match(await open.textContent(),/^Open trace first-trace-[a-z0-9]+$/);
  const size=await page.evaluate(()=>({width:document.documentElement.scrollWidth,inner:innerWidth}));assert.ok(size.width<=size.inner,'no horizontal overflow');
  await open.click();await page.locator('#run-title').filter({hasText:/^first-trace-/}).waitFor();await page.locator('#events-note').filter({hasText:'All 2 events loaded'}).waitFor();
  // The same key is listed on the API keys page: one flow, not a second key system.
  // The same key is a publishable ingest key with no expiry in the server's key list: no 30-day setup-code key was made.
  const listed=await (await context.request.get(live.origin+'/api/keys',{headers:{cookie:(await context.cookies()).map(c=>c.name+'='+c.value).join('; ')}})).json();
  const made=listed.keys.filter(k=>k.key_type==='publishable');assert.equal(made.length,1);assert.equal(made[0].no_expiry,true);assert.equal(made[0].scope,'write_only');assert.equal(made[0].revoked,false);
  assert.ok(snippet.includes("'x-supatrace-key': 'st_pub_"));
  await nav(page,'keys');assert.equal(await page.locator('#keys tr').count()>=1,true);
  // When the session stops being valid, the key leaves the page with it.
  await nav(page,'home');assert.match(await page.locator('#first-snippet').textContent(),/[A-Za-z0-9_-]{43}/);
  await page.route('**/api/usage*',route=>route.fulfill({status:401,contentType:'application/json',body:'{"error":"sign_in_required"}'}),{times:1});await page.locator('#usage-refresh-home').click();
  await page.locator('#first-snippets').waitFor({state:'hidden',timeout:15000});assert.equal(await page.locator('#first-snippet').textContent(),'');
  assert.deepEqual(errors,[]);
 }finally{await context.close();await live.close();}
});
for(const cause of ['identity','pagehide'])test(`a Home key request that answers after ${cause==='identity'?'the account identity was invalidated':'the page was left'} does not put the key on screen`,{timeout:60000},async()=>{
 const live=await start(),context=await browser.newContext({viewport:{width:1280,height:900}});await context.route(/^(?!http:\/\/127\.0\.0\.1)/,route=>route.abort());
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(String(error)));let held=null;
 try{
  await live.signIn(context);await page.goto(live.origin+'/app/',{waitUntil:'networkidle'});await nav(page,'home');await page.locator('#first-key').waitFor();
  await page.route(/\/api\/keys\/create(\?|$)/,route=>{held=route;});
  await page.locator('#first-key').click();const deadline=Date.now()+5000;while(!held&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(held,'the create request left');
  if(cause==='identity'){
   // Another read learns the session is gone while the key request is pending; then the key request's answer arrives.
   await page.route(/\/api\/usage(\?|$)/,route=>route.fulfill({status:401,contentType:'application/json',body:'{"error":"sign_in_required"}'}));
   await page.evaluate(()=>document.getElementById('usage-refresh').click());await page.locator('#account-reload').waitFor({state:'attached'});
   await page.waitForFunction(()=>!document.getElementById('account-reload').hidden);
  }else await page.evaluate(()=>dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));
  await held.continue();await page.waitForLoadState('networkidle');await page.locator('#first-key:not([disabled])').waitFor();
  assert.equal(await page.locator('#first-snippets').isVisible(),false);assert.doesNotMatch(await page.locator('body').innerText(),/st_pub_[A-Za-z0-9_-]{43}/);assert.equal(await page.locator('#first-snippet').textContent(),'');
  assert.deepEqual(errors,[]);
 }finally{await context.close();await live.close();}
});

for(const provider of ['email','GitHub','Google','SSO'])test(`setup code survives ${provider} sign-in and clears after approval or sign-out`,{timeout:60000},async()=>{
 const live=await start(),context=await browser.newContext();const page=await context.newPage();
 try{
  await page.route('**/api/auth/providers',route=>route.fulfill({json:{github:true,google:true,sso:true,email:true}}));
  const code='Abcd1234Efgh';
  await page.goto(live.origin+'/app/#agents?code='+code,{waitUntil:'networkidle'});
  await page.locator('#signin:not([hidden])').waitFor();
  if(provider==='email'){
   await page.route('**/api/auth/email/sign-in',async route=>{await live.signIn(context);await route.fulfill({status:204});});
   await page.fill('#email','synthetic@example.com');await page.fill('#password','Synthetic-only-1!');await page.locator('#sign-in-form button[type=submit]').click();
  }else if(provider==='SSO'){
   await page.route('**/api/auth/sso?*',route=>route.fulfill({json:{url:live.origin+'/fixture-provider'}}));
   await page.route('**/fixture-provider',async route=>{await live.signIn(context);await route.fulfill({status:302,headers:{location:'/app/'}});});
   await page.getByRole('button',{name:'Continue with SSO',exact:true}).click();await page.fill('#sso-email','synthetic@example.com');await page.locator('[data-view=sso] button[type=submit]').click();
  }else{
   await page.route('**/api/auth/'+(provider==='GitHub'?'login':'google'),async route=>{await live.signIn(context);await route.fulfill({status:302,headers:{location:'/app/'}});});
   await page.getByRole('link',{name:'Continue with '+provider,exact:true}).click();
  }
  await page.locator('#view-agents:not([hidden])').waitFor();assert.equal(await page.locator('#code').inputValue(),code);
  await page.route('**/api/setup/approve*',route=>route.fulfill({json:{approved:true}}));await page.locator('#approve button').click();await page.locator('#approval').filter({hasText:'Approved.'}).waitFor();
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('supatrace-setup-code')),null);
  await page.evaluate(()=>sessionStorage.setItem('supatrace-setup-code',JSON.stringify({code:'Abcd1234Efgh',search:''})));
  await page.locator('#logout').click();await page.locator('#signin:not([hidden])').waitFor();assert.equal(await page.evaluate(()=>sessionStorage.getItem('supatrace-setup-code')),null);
 }finally{await context.close();await live.close();}
});
test('publishable first key survives reload and dismissal and sign-out remove stored snippets',{timeout:60000},async()=>{
 const live=await start(),context=await browser.newContext(),page=await context.newPage();
 try{
  await live.signIn(context);await page.goto(live.origin+'/app/',{waitUntil:'networkidle'});await page.locator('#first-key').click();await page.locator('#first-snippets:not([hidden])').waitFor();
  const snippet=await page.locator('#first-snippet').textContent();await page.reload({waitUntil:'networkidle'});await page.locator('#first-snippets:not([hidden])').waitFor();assert.equal(await page.locator('#first-snippet').textContent(),snippet);
  await page.locator('#first-dismiss').click();assert.equal(await page.evaluate(()=>Object.keys(sessionStorage).some(k=>k.startsWith('supatrace-first-trace:'))),false);
  await page.reload({waitUntil:'networkidle'});assert.equal(await page.locator('#first-snippets').isVisible(),false);
  await page.locator('#first-key').click();await page.locator('#first-key-note').filter({hasText:'cannot be shown again'}).waitFor();await page.locator('#first-create').click();await page.locator('#first-snippets:not([hidden])').waitFor();await page.locator('#logout').click();await page.locator('#signin:not([hidden])').waitFor();assert.equal(await page.evaluate(()=>Object.keys(sessionStorage).some(k=>k.startsWith('supatrace-first-trace:'))),false);
 }finally{await context.close();await live.close();}
});
test('email confirmation scrolls and focuses the password then enters the app',{timeout:60000},async()=>{
 const live=await start(),context=await browser.newContext(),page=await context.newPage();
 try{
  await page.route('**/api/auth/providers',route=>route.fulfill({json:{github:true,email:true}}));
  await page.goto(live.origin+'/?email=synthetic%40example.com&token='+'x'.repeat(43),{waitUntil:'networkidle'});
  assert.equal(await page.locator('#confirm-password').evaluate(node=>document.activeElement===node),true);assert.ok((await page.locator('#confirm-password').boundingBox()).y<800);
  await page.route('**/api/auth/email/verify',async route=>{await live.signIn(context);await route.fulfill({status:204});});
  await page.fill('#confirm-password','Synthetic-only-1!');await page.getByRole('button',{name:'Confirm email',exact:true}).click();await page.locator('#shell:not([hidden])').waitFor();assert.equal(new URL(page.url()).pathname,'/app/');
 }finally{await context.close();await live.close();}
});

for(const width of [1440,390])test(`Home keeps an existing ingest key until explicit creation at ${width}px`,{timeout:60000},async()=>{
 const live=await start(),context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage();
 try{
  const tenant=await live.signIn(context);await live.writeKey(tenant);
  let creates=0;page.on('request',request=>{if(request.url().includes('/api/keys/create'))creates++;});
  await page.goto(live.origin+'/app/',{waitUntil:'networkidle'});await page.locator('#first-key').click();
  await page.locator('#first-key-note').filter({hasText:'cannot be shown again'}).waitFor();
  assert.equal(creates,0);assert.equal(await page.locator('#first-snippets').isVisible(),false);
  await page.locator('#first-create').click();await page.locator('#first-snippets:not([hidden])').waitFor();assert.equal(creates,1);
  await page.reload({waitUntil:'networkidle'});await page.locator('#first-snippets:not([hidden])').waitFor();assert.equal(creates,1,'saved snippets reuse the same key');
 }finally{await context.close();await live.close();}
});
