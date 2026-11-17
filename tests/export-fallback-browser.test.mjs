import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';
let browser;
before(async()=>{browser=await launch();});
after(async()=>{await browser?.close();});
const events=[{id:'original',time:'2026-11-17T00:00:00Z',kind:'note',name:'Original trace',data:{nested:[false,0,null,'café'],kept:'value'}}];
for(const mode of ['real','SecurityError','undefined','AbortError','slow AbortError'])test(`Chromium exports with picker ${mode}`,{timeout:60000},async()=>{
 const live=await start(),context=await browser.newContext({acceptDownloads:true});
 try{
  await context.route(/^(?!http:\/\/127\.0\.0\.1)/,r=>r.abort());const tenant=await live.signIn(context),key=await live.writeKey(tenant);
  await live.upload(key,{version:1,batch_id:'fallback-batch',run_id:'fallback-trace',events});
  if(mode!=='real')await context.addInitScript(mode=>Object.defineProperty(window,'showSaveFilePicker',{configurable:true,value:mode==='undefined'?undefined:async()=>{if(mode==='slow AbortError')await new Promise(resolve=>setTimeout(resolve,800));throw new DOMException('Synthetic picker response',mode==='slow AbortError'?'AbortError':mode);}}),mode);
  const page=await context.newPage(),errors=[];let downloads=0;page.on('pageerror',e=>errors.push(e.message));page.on('download',()=>downloads++);
  await page.goto(live.origin+'/app/#traces');await page.getByRole('button',{name:'Open trace fallback-trace',exact:true}).click();await page.locator('#events li').first().waitFor();
  if(mode==='real')assert.match(await page.evaluate(()=>window.showSaveFilePicker.toString()),/\[native code\]/,'real Chromium picker must be present and untouched');
  if(mode==='slow AbortError'){
   await page.locator('#export').click();await page.locator('#cancel-export').waitFor({state:'hidden'});assert.match(await page.locator('#status').textContent(),/cancelled before completion/);assert.equal(downloads,0);
  }
  {
   const downloaded=page.waitForEvent('download');await (mode==='slow AbortError'?page.getByRole('button',{name:'Download instead',exact:true}):page.locator('#export')).click();const file=await downloaded;
   assert.equal(file.suggestedFilename(),'supatrace-run.json');assert.deepEqual(JSON.parse(readFileSync(await file.path(),'utf8')),{version:1,run_id:'fallback-trace',events});assert.doesNotMatch(await page.locator('#status').textContent(),/cancelled/);
  }
  // Both archive variants keep their explicit review/download step.
  for(const kind of ['account','workspace']){
   if(kind==='workspace')await page.locator('#workspace-export-reviewed').check();
   await page.locator('#export-'+kind).click();await page.locator('#cancel-account-export').waitFor({state:'hidden'});
   if(mode==='slow AbortError'){assert.match(await page.locator('#status').textContent(),/cancelled before completion/);assert.equal(downloads,kind==='account'?1:2);assert.equal(await page.locator('#download-account').isHidden(),true);}
   {
    const button=mode==='slow AbortError'?page.getByRole('button',{name:'Download instead',exact:true}):page.locator('#download-account');
    await button.waitFor();const downloaded=page.waitForEvent('download');await button.click();const file=await downloaded,archive=JSON.parse(readFileSync(await file.path(),'utf8'));
    assert.equal(file.suggestedFilename(),'supatrace-'+kind+'.json');assert.equal(archive.complete,true);assert.deepEqual((kind==='account'?archive:archive.environments[0].archive).runs[0].events,events);assert.doesNotMatch(await page.locator('#status').textContent(),/cancelled/);
   }
  }
  // Reviewed redacted copies already use a plain Blob download in every browser.
  await page.locator('#redact-open').click();await page.locator('#redact-paths').fill('/events/*/data/kept');await page.locator('#redact-preview').click();await page.locator('#redact-reviewed').check();
  const redacted=page.waitForEvent('download');await page.locator('#redact-download').click();const file=await redacted;
  assert.equal(file.suggestedFilename(),'supatrace-run-redacted.json');assert.equal(JSON.parse(readFileSync(await file.path(),'utf8')).events[0].data.kept,'[REDACTED]');assert.deepEqual(errors,[]);
 }finally{await context.close();await live.close();}
});
