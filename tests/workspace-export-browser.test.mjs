// Real UI/API/storage, synthetic data only. Reads only fresh test-owned browser downloads.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {digest} from '../src/aws-auth.mjs';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';
import {seedLocalWorkspace} from '../scripts/dev.mjs';
let browser;
before(async()=>{browser=await launch();});
after(async()=>{await browser?.close();});
async function fixture(width=1280,id=4242,native=false){
 const live=await start();await seedLocalWorkspace(live);
 const context=await browser.newContext({viewport:{width,height:844},acceptDownloads:true});
 await context.route(/^(?!http:\/\/127\.0\.0\.1)/,r=>r.abort());await live.signIn(context,id);
 await context.addInitScript(native?()=>{
  window.fileTest={writes:[],closes:0,aborts:0,release:null,block:false};
  window.showSaveFilePicker=async()=>({createWritable:async()=>({write:async text=>{window.fileTest.writes.push(text);if(window.fileTest.block)await new Promise(resolve=>window.fileTest.release=resolve);},close:async()=>{window.fileTest.closes++;},abort:async()=>{window.fileTest.aborts++;}})});
 }:()=>Object.defineProperty(window,'showSaveFilePicker',{value:undefined,configurable:true}));
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(live.origin+'/app/?workspace=github-4242&environment=development#traces',{waitUntil:'networkidle'});
 return {live,context,page,errors,close:async()=>{await context.close();await live.close();}};
}
async function largeFixture(f){
 // Pro: the seeded demo team (read-only member, three environments, three API keys) is back on Free after seeding and
 // already holds more keys than Free allows; this fixture adds two more keys, so the team is put on the plan it fits.
 f.live.store.client.items.get('TENANT#github-4242\0META').plan_id='pro';
 await f.live.seedRuns('github-4242',801);
 const key=randomBytes(32).toString('base64url'),cookie=(await f.context.cookies()).map(c=>c.name+'='+c.value).join('; '),post=async(path,body)=>{const r=await fetch(f.live.origin+'/api/'+path,{method:'POST',headers:{origin:f.live.origin,cookie,'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok)assert.fail(await r.text());return r.json();};
 const setup=await post('setup/start?environment=development',{key_hash:digest(key)});await post('setup/approve?environment=development',{user_code:setup.user_code});
 const rows=Array.from({length:201},(_,i)=>({id:'span-'+i,time:'2026-11-06T00:00:00Z',kind:'note',name:'Original',data:{environment:'development',parent_id:i?'span-'+(i-1):null,nested:[0,false,null,'café']}}));
 for(let i=0;i<rows.length;i+=100){const raw=JSON.stringify({version:1,batch_id:'large-'+i,run_id:'large-original',events:rows.slice(i,i+100)}),r=await fetch(f.live.origin+'/api/batches?environment=development',{method:'POST',headers:{'content-type':'application/json','x-supatrace-key':key,'x-amz-content-sha256':digest(raw)},body:raw});assert.equal(r.status,201,await r.text());}
 return rows;
}
async function begin(page){await page.locator('#workspace-export-reviewed').check();await page.locator('#export-workspace').click();}
for(const [width,id,role] of [[1280,4242,'owner'],[390,5252,'admin'],[320,6262,'viewer']])test(`explicit whole-workspace download preserves environment identity for ${role} at ${width}px`,{timeout:60000},async()=>{
 const f=await fixture(width,id),{page}=f;try{
  const large=role==='owner'?await largeFixture(f):null;
  if(role==='viewer')await f.live.seedRuns('github-6262',1);
  const expectedRuns=large?808:6,expectedEvents=large?1815:12;
  assert.equal(await page.locator('#export-workspace').isDisabled(),true);
  assert.match(await page.locator('#workspace-export-scope').textContent(),/Default \(default\).*Development \(development\).*Production \(production\)/);
  let reads=[];page.on('request',r=>{if(new URL(r.url()).pathname==='/api/events')reads.push(new URL(r.url()));});
  for(let attempt=0;attempt<2;attempt++){
   await begin(page);await page.locator('#download-account').waitFor();assert.match(await page.locator('#status').textContent(),new RegExp('3 environments, '+expectedRuns+' traces, '+expectedEvents+' events'));
   assert.equal(await page.locator('#workspace-export-reviewed').isChecked(),false,'each attempt requires explicit scope review');
   await page.locator('#workspace-export-reviewed').check();assert.equal(await page.locator('#export-workspace').isDisabled(),false);
   const download=page.waitForEvent('download');await page.locator('#download-account').click();const file=await download;assert.equal(await page.locator('#export-workspace').isDisabled(),true,'cleared consent also updates the button');
   assert.equal(file.suggestedFilename(),'supatrace-workspace.json');const archive=JSON.parse(readFileSync(await file.path(),'utf8'));
   assert.equal(archive.complete,true);assert.equal(archive.workspace_id,'github-4242');assert.equal(archive.environment_count,3);assert.equal(archive.run_count,expectedRuns);assert.equal(archive.event_count,expectedEvents);
   for(const e of archive.environments){assert.equal(e.archive.complete,true);for(const id of ['local-run-1','local-run-2'])assert.equal(e.archive.runs.find(r=>r.metadata.id===id).events[0].data.environment,e.metadata.id);if(!large)assert.equal(e.archive.runs.length,2);if(large&&e.metadata.id==='development')assert.deepEqual(e.archive.runs.find(r=>r.metadata.id==='large-original').events,large);}
  }
  assert.deepEqual(new Set(reads.map(u=>u.searchParams.get('environment')??'default')),new Set(['default','development','production']));
  if(id!==4242)assert.ok(reads.every(u=>u.searchParams.get('workspace')==='github-4242'),'shared workspace never reads member personal data');
  // Regression: non-Default single-trace standard download previously referenced an undefined project.
  await page.getByRole('button',{name:'Open trace local-run-1',exact:true}).click();await page.locator('#events li').first().waitFor();
  const download=page.waitForEvent('download');await page.locator('#export').click();const single=JSON.parse(readFileSync(await (await download).path(),'utf8'));
  assert.equal(single.environment_id,'development');assert.equal(single.events[0].data.environment,'development');assert.match(single.project_id,/^proj_/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
test('new unreviewed environment fails before any trace reads or download',{timeout:60000},async()=>{
 const f=await fixture(),{page}=f;try{
  await page.route(url=>url.pathname==='/api/environments',async route=>{const response=await route.fetch(),body=await response.json();body.environments.push({id:'new',name:'New',legacy:false});await route.fulfill({response,json:body});});
  let events=0,downloads=0;page.on('request',r=>{if(new URL(r.url()).pathname==='/api/events')events++;});page.on('download',()=>downloads++);
  await begin(page);await page.locator('#cancel-account-export').waitFor({state:'hidden'});
  assert.match(await page.locator('#status').textContent(),/changed/);assert.equal(events,0);assert.equal(downloads,0);assert.equal(await page.locator('#download-account').isHidden(),true);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
test('native workspace cancellation aborts temporary output, blocks switching and permits an explicit retry',{timeout:60000},async()=>{
 const f=await fixture(320,5252,true),{page}=f;try{
  await page.evaluate(()=>{window.fileTest.block=true;});await begin(page);await page.waitForFunction(()=>!!window.fileTest.release);
  const url=page.url();await page.getByLabel('Environment',{exact:true}).selectOption('production');assert.equal(page.url(),url);assert.equal(await page.getByLabel('Environment',{exact:true}).inputValue(),'development');
  await page.locator('#cancel-account-export').click();await page.locator('#cancel-account-export').waitFor({state:'hidden'});
  assert.match(await page.locator('#status').textContent(),/cancelled/);assert.deepEqual(await page.evaluate(()=>({closes:window.fileTest.closes,aborts:window.fileTest.aborts})),{closes:0,aborts:1});
  await page.evaluate(()=>{window.fileTest.release();window.fileTest.block=false;window.fileTest.writes=[];});await begin(page);await page.waitForFunction(()=>window.fileTest.closes===1);
  assert.equal(await page.evaluate(()=>JSON.parse(window.fileTest.writes.join('')).event_count),12);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
test('authorization loss in one environment never commits a partial native workspace archive',{timeout:60000},async()=>{
 const f=await fixture(1280,6262,true),{page}=f;try{
  await page.route('**/api/events?**',async route=>{if(new URL(route.request().url()).searchParams.get('environment')==='production')await route.fulfill({status:403,json:{error:'workspace_unavailable'}});else await route.continue();});
  await begin(page);await page.locator('#cancel-account-export').waitFor({state:'hidden'});
  assert.deepEqual(await page.evaluate(()=>({closes:window.fileTest.closes,aborts:window.fileTest.aborts})),{closes:0,aborts:1});
  assert.doesNotMatch(await page.locator('#status').textContent(),/archive saved/);assert.equal(await page.locator('#download-account').isHidden(),true);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
