// Synthetic loopback API + rendered UI. Injected native streams are not OS picker/disk acceptance.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';
let browser;
before(async()=>{browser=await launch();});
after(async()=>{await browser?.close();});
const events=Array.from({length:201},(_,i)=>({id:'span-'+i,time:'2026-11-05T00:00:00Z',kind:'note',name:'Synthetic original',data:{parent_id:i?'span-'+(i-1):null,nested:[false,0,null,'café','</script>']}}));
async function seedTrace(live,tenant){const key=await live.writeKey(tenant);for(let i=0;i<events.length;i+=100)await live.upload(key,{version:1,batch_id:'batch-'+i,run_id:'multi-batch',events:events.slice(i,i+100)});return key;}
async function traces(page){const toggle=page.locator('#menu-toggle');if(await toggle.isVisible()&&await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();await page.locator('#rail a[data-nav="traces"]').click();}

for(const width of [1280,390,320])test(`native account interruption recovers without a false save at ${width}px`,{timeout:60000},async()=>{
 const live=await start(),context=await browser.newContext({viewport:{width,height:844}});
 await context.route(/^(?!http:\/\/127\.0\.0\.1)/,route=>route.abort());
 await context.addInitScript(()=>{
  window.fileTest={mode:'write',attempts:[],release:null};
  Object.defineProperty(window,'showSaveFilePicker',{configurable:true,value:()=>{
   const state=window.fileTest,mode=state.mode,attempt={writes:[],aborts:0,closes:0};state.attempts.push(attempt);
   return Promise.resolve({createWritable:async()=>({
    write:async text=>{attempt.writes.push(text);if(mode==='write'&&attempt.writes.length===1)await new Promise(resolve=>state.release=resolve);},
    abort:async()=>{attempt.aborts++;},
    close:async()=>{attempt.closes++;if(mode==='close')await new Promise(resolve=>state.release=resolve);}
   })});
  }});
 });
 const page=await context.newPage(),errors=[];let downloads=0;
 page.on('pageerror',error=>errors.push(String(error)));page.on('download',()=>downloads++);
 try{
  const tenant=await live.signIn(context);await seedTrace(live,tenant);
  await page.goto(live.origin+'/app/',{waitUntil:'networkidle'});await traces(page);
  await page.locator('#export-account').click();await page.waitForFunction(()=>!!window.fileTest.release);
  assert.equal(await page.locator('#export-account').isDisabled(),true);
  await page.locator('#cancel-account-export').click();await page.locator('#cancel-account-export').waitFor({state:'hidden'});
  assert.match(await page.locator('#status').textContent(),/cancelled before completion/);
  await page.evaluate(()=>{window.fileTest.release();window.fileTest.release=null;window.fileTest.mode='normal';});
  await page.locator('#export-account').click();await page.waitForFunction(()=>document.getElementById('status').textContent.startsWith('Account archive saved:'));
  const first=await page.evaluate(()=>window.fileTest.attempts);
  assert.equal(first[0].aborts,1);assert.equal(first[0].closes,0);assert.equal(first[0].writes.length,1);
  assert.equal(first[1].closes,1);assert.deepEqual(JSON.parse(first[1].writes.join('')).runs[0].events,events);
  // Exercise the actual two-minute deadline without waiting two wall-clock minutes.
  await page.clock.install();await page.evaluate(()=>{window.fileTest.mode='close';});
  await page.locator('#export-account').click();await page.waitForFunction(()=>!!window.fileTest.release);
  assert.equal(await page.locator('#cancel-account-export').isDisabled(),true);
  await page.clock.fastForward(120001);await page.locator('#cancel-account-export').waitFor({state:'hidden'});
  assert.match(await page.locator('#status').textContent(),/could not be confirmed complete/);
  assert.equal(await page.locator('#export-account').isDisabled(),false);
  await page.evaluate(()=>{window.fileTest.release();window.fileTest.release=null;window.fileTest.mode='normal';});
  await page.locator('#export-account').click();await page.waitForFunction(()=>document.getElementById('status').textContent.startsWith('Account archive saved:'));
  const attempts=await page.evaluate(()=>window.fileTest.attempts);
  assert.equal(attempts[2].aborts,0,'uncertain close is not rolled back');assert.equal(attempts[2].closes,1);
  assert.equal(attempts[3].closes,1);assert.deepEqual(JSON.parse(attempts[3].writes.join('')).runs[0].events,events);
  assert.equal(downloads,0,'native failures never silently download');assert.deepEqual(errors,[]);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 }finally{await context.close();await live.close();}
});

test('real account download preserves 802 runs across catalog pages and 1002 original events on repeat',{timeout:120000},async()=>{
 const live=await start(),context=await browser.newContext({viewport:{width:1280,height:844},acceptDownloads:true});
 await context.route(/^(?!http:\/\/127\.0\.0\.1)/,route=>route.abort());
 await context.addInitScript(()=>Object.defineProperty(window,'showSaveFilePicker',{value:undefined,configurable:true}));
 const page=await context.newPage(),expected=new Map([['multi-batch',events]]),errors=[];
 page.on('pageerror',error=>errors.push(String(error)));
 try{
  const tenant=await live.signIn(context),key=await seedTrace(live,tenant);
  for(let i=0;i<801;i++){
   const id='run-'+String(i).padStart(4,'0'),rows=[{...events[0],id:id+'-event',data:{synthetic:true,index:i}}];expected.set(id,rows);
   await live.upload(key,{version:1,batch_id:id+'-batch',run_id:id,events:rows});
  }
  const other=await browser.newContext(),otherTenant=await live.signIn(other,9999);await live.seedRuns(otherTenant,1);await other.close();
  await page.goto(live.origin+'/app/',{waitUntil:'networkidle'});await traces(page);
  await page.fill('#trace-search','multi-batch');await page.locator('#filters button[type=submit]').click();await page.waitForFunction(()=>document.querySelectorAll('#runs .run').length===1);
  const catalogReads=[];page.on('request',request=>{if(new URL(request.url()).pathname==='/api/runs/page')catalogReads.push(request.url());});
  live.rateLimitEvents(1);let previous;
  for(let attempt=0;attempt<2;attempt++){
   await page.locator('#export-account').click();await page.locator('#download-account').waitFor({state:'visible',timeout:90000});
   assert.match(await page.locator('#status').textContent(),/802 traces, 1,?002 events/);
   const received=page.waitForEvent('download');await page.locator('#download-account').click();const file=await received;
   const archive=JSON.parse(readFileSync(await file.path(),'utf8'));
   assert.equal(archive.complete,true);assert.equal(archive.run_count,802);assert.equal(archive.event_count,1002);
   assert.equal(archive.consistency,'observed_stable_before_after_not_a_snapshot');assert.deepEqual(new Set(archive.runs.map(run=>run.metadata.id)),new Set(expected.keys()));
   for(const run of archive.runs){assert.deepEqual(run.events,expected.get(run.metadata.id));assert.equal(run.metadata.event_count,run.events.length);assert.equal(run.metadata.batch_count,run.metadata.id==='multi-batch'?3:1);}
   if(previous)assert.deepEqual(archive.runs,previous.runs,'repeated exports preserve original fields, parent links and tied-time order');previous=archive;
  }
  assert.equal(catalogReads.length,8,'two pages in each of two scans on each attempt');
  assert.deepEqual(errors,[]);
 }finally{await context.close();await live.close();}
});
