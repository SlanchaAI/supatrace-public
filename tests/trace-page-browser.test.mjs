// Synthetic loopback fixture. Not run while the existing browser-executor
// restriction remains; source/syntax review is not rendered/hosted acceptance.
import test,{before,after} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {start} from './harness.mjs';import {launch} from './browser.mjs';
import {integrateTraceWriter} from './trace-export-integration.mjs';
let browser;before(async()=>{browser=await launch();});after(async()=>{await browser?.close();});
async function nav(page,name){const toggle=page.locator('#menu-toggle');if(await toggle.isVisible()&&await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();await page.locator(`#rail a[data-nav="${name}"]`).click();}
async function fitsViewport(page){const size=await page.evaluate(()=>({width:document.documentElement.scrollWidth,inner:innerWidth}));assert.ok(size.width<=size.inner);}
async function until(predicate){const deadline=Date.now()+5000;while(!predicate()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(predicate(),'Expected intercepted request');}
for(const viewport of [{width:1280,height:800},{width:390,height:844},{width:320,height:740}])test(`atomic multi-batch inspection, cancellation and original export at ${viewport.width}px`,{timeout:60000},async()=>{
 const live=await start(),context=await browser.newContext({viewport,acceptDownloads:true});let mode='missing',release=null;const events=[{id:'first',time:'2026-11-03T00:00:00Z',kind:'note',name:'First',data:{parent:'root',nested:[0,false,null,'café']}},{id:'second',time:'2026-11-03T00:00:01Z',kind:'response',name:'Second',data:{parent:'first',kept:true}}];
 await context.route(/^(?!http:\/\/127\.0\.0\.1)/,route=>route.abort());await context.addInitScript(()=>Object.defineProperty(window,'showSaveFilePicker',{value:undefined,configurable:true}));const page=await context.newPage(),errors=[],urls=[];page.on('pageerror',error=>errors.push(String(error)));
 await page.route('**/api/events?*',async route=>{const url=new URL(route.request().url()),stage=mode;urls.push(url);try{if(stage==='missing'){await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({events:[]})});return;}if(url.searchParams.get('after')&&stage==='malformed'){await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({events:[events[1],null],next:null})});return;}if(url.searchParams.get('after')&&stage==='pending')await new Promise(resolve=>release=resolve);await route.continue();}catch{/* Cancelled route may complete after the request aborts. */}});
 try{
  const tenant=await live.signIn(context),key=await live.writeKey(tenant);for(let i=0;i<2;i++)await live.upload(key,{version:1,batch_id:'trace-page-'+i,run_id:'trace-page-run',events:[events[i]]});
  await page.goto(live.origin+'/app/',{waitUntil:'networkidle'});await nav(page,'traces');await page.getByRole('button',{name:'Open trace trace-page-run',exact:true}).click();await page.locator('#events-note').filter({hasText:'incomplete or invalid'}).waitFor();assert.equal(await page.locator('#events li').count(),0);assert.equal(await page.locator('#events-more').isVisible(),true);
  mode='normal';await page.locator('#events-more').click();await page.locator('#events-note').filter({hasText:'Showing 1 event'}).waitFor();assert.equal(await page.locator('#events li').count(),1);
  mode='malformed';await page.locator('#events-more').click();await page.locator('#events-note').filter({hasText:'incomplete or invalid'}).waitFor();assert.equal(await page.locator('#events li').count(),1);const failedCursor=urls.at(-1).searchParams.get('after');
  mode='pending';release=null;await page.locator('#events-more').click();await until(()=>release!==null);assert.equal(await page.locator('#events-cancel').isVisible(),true);assert.equal(await page.locator('#detail').getAttribute('aria-busy'),'true');await fitsViewport(page);await page.locator('#events-cancel').click();await page.locator('#events-note').filter({hasText:'Loading cancelled'}).waitFor();assert.equal(await page.locator('#events li').count(),1);mode='normal';release();release=null;
  await page.locator('#events-more').click();await page.locator('#events-note').filter({hasText:'All 2 events loaded.'}).waitFor();assert.equal(urls.at(-1).searchParams.get('after'),failedCursor);assert.equal(await page.locator('#events li').count(),2);assert.equal(await page.locator('#events-cancel').isVisible(),false);assert.equal(await page.locator('#detail').getAttribute('aria-busy'),'false');await fitsViewport(page);
  const download=page.waitForEvent('download');await page.locator('#export').click();const file=await download;assert.deepEqual(JSON.parse(readFileSync(await file.path(),'utf8')),{version:1,run_id:'trace-page-run',events});
  await page.locator('#close-detail').click();await page.getByRole('button',{name:'Open trace trace-page-run',exact:true}).click();await page.locator('#events-note').filter({hasText:'Showing 1 event'}).waitFor();mode='pending';release=null;await page.locator('#events-more').click();await until(()=>release!==null);await nav(page,'home');mode='normal';release();release=null;await nav(page,'traces');assert.equal(await page.locator('#detail').isVisible(),false);
  await fitsViewport(page);assert.deepEqual(errors,[]);
 }finally{release?.();await context.close();await live.close();}
});

// Exercise the staged adapter in synthetic responses only. app.js remains
// unchanged in this module PR until the separate integration patch is applied.
for(const width of [1280,390,320])test(`staged trace writer recovers picker/write/close interruption at ${width}px`,{timeout:60000},async()=>{
 const live=await start(),context=await browser.newContext({viewport:{width,height:844}});
 await context.route(/^(?!http:\/\/127\.0\.0\.1)/,route=>route.abort());
 await context.route('**/app/app.js',async route=>{const response=await route.fetch();await route.fulfill({response,body:integrateTraceWriter(await response.text())});});
 await context.addInitScript(()=>{
  window.traceFileTest={mode:'picker',attempts:[],release:null};
  Object.defineProperty(window,'showSaveFilePicker',{configurable:true,value:()=>{
   const state=window.traceFileTest,mode=state.mode,attempt={opens:0,writes:[],aborts:0,closes:0};state.attempts.push(attempt);
   const handle={createWritable:async()=>{attempt.opens++;return {
    write:async text=>{attempt.writes.push(text);if(mode==='write'&&attempt.writes.length===1)await new Promise(resolve=>state.release=resolve);},
    abort:async()=>{attempt.aborts++;},
    close:async()=>{attempt.closes++;if(mode==='close')await new Promise(resolve=>state.release=resolve);}
   };}};
   if(mode==='picker')return new Promise(resolve=>state.release=()=>resolve(handle));return Promise.resolve(handle);
  }});
 });
 const page=await context.newPage(),errors=[],scopes=[];let downloads=0;
 page.on('pageerror',error=>errors.push(String(error)));page.on('download',()=>downloads++);
 page.on('request',request=>{const u=new URL(request.url());if(u.pathname==='/api/events')scopes.push(u.searchParams.get('project'));});
 const originals=Array.from({length:201},(_,i)=>({id:'trace-span-'+i,time:'2026-11-05T00:00:00Z',kind:'note',name:'Synthetic trace original',data:{parent:i?'trace-span-'+(i-1):null,nested:[0,false,null,'café']}}));
 try{
  const tenant=await live.signIn(context),key=await live.writeKey(tenant);
  for(let i=0;i<originals.length;i+=100)await live.upload(key,{version:1,run_id:'native-trace',batch_id:'native-batch-'+i,events:originals.slice(i,i+100)});
  await page.goto(live.origin+'/app/',{waitUntil:'networkidle'});await nav(page,'traces');await page.getByRole('button',{name:'Open trace native-trace',exact:true}).click();await page.locator('#events li').first().waitFor();
  for(const mode of ['picker','write']){
   await page.evaluate(value=>{window.traceFileTest.mode=value;},mode);
   await page.locator('#export').click();await page.waitForFunction(()=>!!window.traceFileTest.release);
   assert.equal(await page.locator('#export').isDisabled(),true);
   await page.locator('#cancel-export').click();await page.locator('#cancel-export').waitFor({state:'hidden'});
   assert.match(await page.locator('#status').textContent(),/cancelled before completion/);
   await page.evaluate(()=>{window.traceFileTest.release();window.traceFileTest.release=null;});
  }
  await page.evaluate(()=>{window.traceFileTest.mode='normal';});live.rateLimitEvents(1);
  await page.locator('#export').click();await page.locator('#status').filter({hasText:'Export saved: 201 events.'}).waitFor();
  let attempts=await page.evaluate(()=>window.traceFileTest.attempts);
  assert.equal(attempts[0].opens,0);assert.equal(attempts[1].writes.length,1);assert.equal(attempts[1].aborts,1);assert.equal(attempts[1].closes,0);
  assert.equal(attempts[2].closes,1);assert.deepEqual(JSON.parse(attempts[2].writes.join('')),{version:1,run_id:'native-trace',events:originals});
  await page.clock.install();await page.evaluate(()=>{window.traceFileTest.mode='close';});
  await page.locator('#export').click();await page.waitForFunction(()=>!!window.traceFileTest.release);
  assert.equal(await page.locator('#cancel-export').isDisabled(),true);
  await page.clock.fastForward(120001);await page.locator('#cancel-export').waitFor({state:'hidden'});
  assert.match(await page.locator('#status').textContent(),/could not be confirmed complete/);assert.equal(await page.locator('#export').isEnabled(),true);
  await page.evaluate(()=>{window.traceFileTest.release();window.traceFileTest.release=null;window.traceFileTest.mode='normal';});
  await page.locator('#export').click();await page.locator('#status').filter({hasText:'Export saved: 201 events.'}).waitFor();
  attempts=await page.evaluate(()=>window.traceFileTest.attempts);
  assert.equal(attempts[3].closes,1);assert.equal(attempts[3].aborts,0);
  assert.equal(attempts[4].closes,1);assert.equal(attempts[4].writes.join(''),attempts[2].writes.join(''));
  // Repeating export must retire the prior success while the new picker waits.
  await page.evaluate(()=>{window.traceFileTest.mode='picker';});await page.locator('#export').click();
  await page.waitForFunction(()=>!!window.traceFileTest.release);
  assert.match(await page.locator('#status').textContent(),/Exporting original trace/);
  assert.doesNotMatch(await page.locator('#status').textContent(),/Export saved/);
  await page.locator('#cancel-export').click();await page.locator('#cancel-export').waitFor({state:'hidden'});
  await page.evaluate(()=>{window.traceFileTest.release();window.traceFileTest.release=null;});
  assert.equal(new Set(scopes).size,1);assert.match(scopes[0],/^proj_[a-f0-9]{32}$/);assert.equal(downloads,0);assert.deepEqual(errors,[]);await fitsViewport(page);
 }finally{await context.close();await live.close();}
});
