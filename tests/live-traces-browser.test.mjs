// Short rendered check of live trace-list updates against the local harness: an accepted
// upload appears without a click, and the list stays put under a reader's focus. The long
// recovery scenarios are in tests/live-traces-recovery-browser.test.mjs. Hosted proof is separate.
import test,{before,after} from 'node:test';import assert from 'node:assert/strict';
import {start} from './harness.mjs';import {launch} from './browser.mjs';
let browser;before(async()=>{browser=await launch();});after(async()=>{await browser?.close();});
async function nav(page,name){const toggle=page.locator('#menu-toggle');if(await toggle.isVisible()&&await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();await page.locator(`#rail a[data-nav="${name}"]`).click();}
const batch=(run,id)=>({version:1,batch_id:'live-'+id,run_id:run,events:[{id,time:'2026-11-14T00:00:00Z',kind:'note',name:'Synthetic',data:{}}]});
test('an accepted upload appears without Refresh, and focus in the rows holds the list',{timeout:120000},async()=>{
 const live=await start(),context=await browser.newContext({viewport:{width:1280,height:900}});await context.route(/^(?!http:\/\/127\.0\.0\.1)/,route=>route.abort());
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(String(error)));
 try{
  const tenant=await live.signIn(context),key=await live.writeKey(tenant);
  await page.goto(live.origin+'/app/',{waitUntil:'networkidle'});await nav(page,'traces');
  await page.locator('#page-note').filter({hasText:'0 traces'}).waitFor();await page.locator('#live-note').filter({hasText:'Live updates on'}).waitFor();
  const before=await page.locator('#usage').textContent();
  await live.upload(key,batch('live-run-one','one'));
  await page.getByRole('button',{name:'Open trace live-run-one',exact:true}).waitFor({timeout:30000});assert.equal(await page.locator('#runs tr.run').count(),1);
  await page.waitForFunction(previous=>document.getElementById('usage').textContent!==previous,before,{timeout:30000});
  assert.equal(await page.locator('#usage').textContent(),await page.locator('#usage-page').textContent());
  assert.match(await page.locator('#usage-monthly').textContent(),/1 of 50,000 spans this month/);
  await page.getByRole('button',{name:'Open trace live-run-one',exact:true}).focus();await live.upload(key,batch('live-run-two','two'));
  await page.locator('#live-note').filter({hasText:'New traces may be available: Refresh to check.'}).waitFor({timeout:30000});assert.equal(await page.locator('#runs tr.run').count(),1);
  await page.locator('#refresh').click();await page.getByRole('button',{name:'Open trace live-run-two',exact:true}).waitFor();await page.locator('#live-note').filter({hasText:'Live updates on'}).waitFor();
  assert.deepEqual(errors,[]);
 }finally{await context.close();await live.close();}
});

for(const width of [1440,390])test(`trace list and detail share explicit span timing at ${width}px`,async()=>{
 const live=await start(),context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage();
 try{
  const tenant=await live.signIn(context),key=await live.writeKey(tenant);
  await live.upload(key,{version:1,batch_id:'root-duration',run_id:'root-duration',events:[
   {id:'root',time:'2026-11-14T00:00:00.000Z',kind:'note',name:'Root',data:{span_id:'root',startTime:'2026-11-14T00:00:00.000Z',endTime:'2026-11-14T00:00:00.080Z'}},
   {id:'child',time:'2026-11-14T00:00:00.025Z',kind:'note',name:'Child',data:{span_id:'child',parent_span_id:'root',duration_ms:10}}
  ]});
  await page.goto(live.origin+'/app/#traces',{waitUntil:'networkidle'});
  const row=page.locator('#runs tr.run').filter({hasText:'root-duration'});await row.waitFor();assert.match(await row.textContent(),/80ms/);assert.doesNotMatch(await row.textContent(),/25ms/);
  await page.getByRole('button',{name:'Open trace root-duration',exact:true}).click();await page.locator('#events-note').filter({hasText:'All 2 events loaded'}).waitFor();
  assert.match(await page.locator('#detail').textContent(),/80\s*ms/);
 }finally{await context.close();await live.close();}
});
