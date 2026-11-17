// Rendered synthetic loopback checks, never a hosted or native mobile acceptance claim.
import test, {before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync} from 'node:fs';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';
let browser;
before(async()=>{browser=await launch();});after(async()=>{await browser?.close();});
async function nav(page,name){const toggle=page.locator('#menu-toggle');if(await toggle.isVisible()&&await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();await page.locator(`#rail a[data-nav="${name}"]`).click();}
for(const viewport of [{width:1280,height:800},{width:390,height:844},{width:320,height:740}]){
 test(`local redaction review/download, isolation and interruptions at ${viewport.width}px`,{timeout:60000},async()=>{
  const live=await start(),context=await browser.newContext({viewport,acceptDownloads:true});
  await context.route(/^(?!http:\/\/127\.0\.0\.1)/,route=>route.abort());
  // Exercise the unchanged original Blob path without launching a native file picker.
  await context.addInitScript(()=>{Object.defineProperty(window,'showSaveFilePicker',{value:undefined,configurable:true});window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective));});
  const errors=[],requests=[],downloads=[],page=await context.newPage();page.on('pageerror',e=>errors.push(String(e)));page.on('request',r=>{if(r.url().includes('/api/'))requests.push(r);});page.on('download',file=>downloads.push(file));
  try{
   const tenant=await live.signIn(context),key=await live.writeKey(tenant),secret='SYNTHETIC-LOCAL-TOKEN',events=[{id:'private-1',time:'2026-10-25T00:00:00Z',kind:'note',name:'review '+secret,data:{key:secret,safe:'keep',html:'</pre><img src=x onerror=alert(1)>',observation:{id:'source-1',traceId:'source-trace',parentObservationId:null}}},{id:'private-2',time:'2026-10-25T00:00:00Z',kind:'response',name:'done',data:{nested:[{authorization:'Bearer '+secret}],observation:{id:'source-2',traceId:'source-trace',parentObservationId:'source-1'},reference:'private-run'}}];
   for(let i=0;i<events.length;i++)await live.upload(key,{version:1,batch_id:'private-'+i,run_id:'private-run',events:[events[i]]});
   await page.goto(live.origin+'/app/',{waitUntil:'networkidle'});await nav(page,'traces');await page.getByRole('button',{name:'Open trace private-run',exact:true}).click();await page.locator('#events li').first().waitFor();
   await page.click('#redact-open');assert.equal(await page.locator('#redact-paths').evaluate(n=>n===document.activeElement),true);assert.equal(await page.locator('#redact-download').isDisabled(),true);
   await page.click('#redact-preview');await page.getByText('Choose at least one field path or exact text to mask.').waitFor();assert.equal(downloads.length,0);
   await page.fill('#redact-paths','/events/*/data/key');await page.fill('#redact-literals',secret);await page.click('#redact-preview');await page.waitForFunction(()=>document.getElementById('redact-status').textContent.startsWith('Preview ready:'));
   const preview=JSON.parse(await page.locator('#redact-output').textContent());assert.equal(preview.redacted_copy,true);assert.equal(preview.events.length,2);assert.doesNotMatch(JSON.stringify(preview),new RegExp(secret));assert.equal(preview.events[0].data.safe,'keep');assert.match(preview.redaction_notice,/does not guarantee anonymity/);assert.equal(await page.locator('#redact-output img').count(),0);assert.equal(await page.locator('#redact-download').isDisabled(),true);assert.equal(downloads.length,0);
   await page.check('#redact-reviewed');const redacted=page.waitForEvent('download');await page.click('#redact-download');const copy=await redacted;assert.equal(copy.suggestedFilename(),'supatrace-run-redacted.json');assert.deepEqual(JSON.parse(readFileSync(await copy.path(),'utf8')),preview);
   // Identifier masking must expose the actual relationship loss in both artifacts.
   await page.fill('#redact-paths','/run_id\n/events/*/id\n/events/*/data/observation/id');await page.click('#redact-preview');await page.waitForFunction(()=>document.getElementById('redact-status').textContent.startsWith('Preview ready:'));
   const idPreview=JSON.parse(await page.locator('#redact-output').textContent());assert.equal(idPreview.run_id,'[REDACTED]');assert.deepEqual(idPreview.events.map(e=>e.id),['[REDACTED]','[REDACTED]']);assert.equal(idPreview.events[1].data.observation.parentObservationId,'source-1');assert.equal(idPreview.events[1].data.reference,'private-run');
   assert.equal(idPreview.redaction_identifiers.changed_fields,5);assert.equal(idPreview.redaction_identifiers.unchanged_value_occurrences,2);assert.equal(idPreview.redaction_identifiers.collapsed_values,5);assert.match(await page.locator('#redact-status').textContent(),/5 fields changed.*2 unchanged occurrences.*5 distinct values collapse.*Links may be broken/);assert.equal(await page.locator('#redact-download').isDisabled(),true);
   await page.check('#redact-reviewed');const idDownload=page.waitForEvent('download');await page.click('#redact-download');const idFile=await idDownload;assert.equal(idFile.suggestedFilename(),'supatrace-run-redacted.json');assert.deepEqual(JSON.parse(readFileSync(await idFile.path(),'utf8')),idPreview);
   const widths=await page.evaluate(()=>({width:document.documentElement.scrollWidth,inner:innerWidth}));assert.ok(widths.width<=widths.inner,'no horizontal overflow');
   const out=process.env.SUPATRACE_REDACTION_SCREENSHOT_DIR;if(out){mkdirSync(out,{recursive:true});await page.screenshot({path:`${out}/redaction-${viewport.width}.png`,fullPage:true});}
   await page.fill('#redact-literals','changed rule');assert.equal(await page.locator('#redact-download').isDisabled(),true);assert.equal(await page.locator('#redact-output').isVisible(),false);
   live.rateLimitEvents(1);await page.click('#redact-preview');await page.waitForFunction(()=>document.getElementById('redact-status').textContent.startsWith('Preview paused'));assert.equal(await page.locator('#export').isDisabled(),true);await page.click('#redact-cancel');await page.locator('#redact-cancel').waitFor({state:'hidden'});assert.match(await page.locator('#redact-status').textContent(),/cancelled/);assert.equal(downloads.length,2);
   await page.click('#redact-close');assert.equal(await page.locator('#redact-literals').inputValue(),'');assert.equal(await page.locator('#redact-paths').inputValue(),'');assert.equal(await page.locator('#redact-open').evaluate(n=>n===document.activeElement),true);
   const original=page.waitForEvent('download');await page.click('#export');const raw=await original;assert.equal(raw.suggestedFilename(),'supatrace-run.json');assert.deepEqual(JSON.parse(readFileSync(await raw.path(),'utf8')),{version:1,run_id:'private-run',events});
   await page.click('#redact-open');await page.click('#redact-data');await page.click('#redact-preview');await page.waitForFunction(()=>document.getElementById('redact-status').textContent.startsWith('Preview ready:'));await page.check('#redact-reviewed');await nav(page,'home');await nav(page,'traces');assert.equal(await page.locator('#detail').isVisible(),false);
   await page.getByRole('button',{name:'Open trace private-run',exact:true}).click();await page.click('#redact-open');assert.equal(await page.locator('#redact-paths').inputValue(),'');assert.equal(await page.locator('#redact-output').textContent(),'');assert.equal(await page.locator('#redact-download').isDisabled(),true);
   // Hash Back/Forward also clears the pending preview and never restores a reviewed copy.
   await page.fill('#redact-literals',secret);live.rateLimitEvents(1);await page.click('#redact-preview');await page.waitForFunction(()=>document.getElementById('redact-status').textContent.startsWith('Preview paused'));await nav(page,'home');await page.goBack();await page.locator('#view-traces:not([hidden])').waitFor();assert.equal(await page.locator('#detail').isVisible(),false);assert.equal(await page.locator('#redact-literals').inputValue(),'');assert.equal(downloads.length,3);
   for(const request of requests){const r=request;assert.ok((r.method()==='GET'||r.method()==='POST'&&new URL(r.url()).pathname==='/api/audit/events'&&/^\{"action":"export\.started","kind":"trace","run_id":"[A-Za-z0-9_.:-]+"\}$/.test(r.postData())),'only reads, plus the fixed export-started audit report');assert.equal((request.url()+(request.postData()||'')).includes(secret),false,'rules and copy never transmitted');}
   assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>window.__csp),[]);
  }finally{await context.close();await live.close();}
 });
}

for(const width of [1280,320])test(`redacted download API failures preserve reviewed bytes and recover explicitly at ${width}px`,{timeout:60000},async()=>{
 const live=await start(),context=await browser.newContext({viewport:{width,height:844},acceptDownloads:true});
 await context.route(/^(?!http:\/\/127\.0\.0\.1)/,route=>route.abort());
 await context.addInitScript(()=>{
  const OriginalBlob=window.Blob,create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL),click=HTMLAnchorElement.prototype.click;
  window.__downloadFailure=null;window.__redactedRevoked=[];
  window.Blob=class extends OriginalBlob{constructor(...args){if(window.__downloadFailure==='blob')throw Error('SYNTHETIC_PRIVATE_BLOB_ERROR');super(...args);}};
  URL.createObjectURL=blob=>{if(window.__downloadFailure==='url')throw Error('SYNTHETIC_PRIVATE_URL_ERROR');return create(blob);};
  URL.revokeObjectURL=value=>{window.__redactedRevoked.push(value);return revoke(value);};
  HTMLAnchorElement.prototype.click=function(){if(this.download==='supatrace-run-redacted.json'&&window.__downloadFailure==='dispatch')throw Error('SYNTHETIC_PRIVATE_DISPATCH_ERROR');return click.call(this);};
 });
 const page=await context.newPage(),errors=[],requests=[],downloads=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().includes('/api/'))requests.push(r);});page.on('download',file=>downloads.push(file));
 try{
  const tenant=await live.signIn(context),key=await live.writeKey(tenant),event={id:'redacted-recovery',time:'2026-11-06T00:00:00Z',kind:'note',name:'Synthetic reviewed copy',data:{secret:'SYNTHETIC_PRIVATE_INPUT',kept:[0,false,null,'café']}};
  await live.upload(key,{version:1,batch_id:'redacted-recovery',run_id:'redacted-recovery',events:[event]});
  await page.goto(live.origin+'/app/#traces',{waitUntil:'networkidle'});await page.getByRole('button',{name:'Open trace redacted-recovery',exact:true}).click();
  await page.locator('#events li').first().waitFor();await page.click('#redact-open');await page.fill('#redact-paths','/events/*/data/secret');await page.click('#redact-preview');
  await page.waitForFunction(()=>document.getElementById('redact-status').textContent.startsWith('Preview ready:'));await page.check('#redact-reviewed');
  const reviewed=await page.locator('#redact-output').textContent(),before=requests.length;let revoked=0;
  assert.doesNotMatch(reviewed,/SYNTHETIC_PRIVATE_INPUT/);
  for(const [i,phase]of ['blob','url','dispatch'].entries()){
   await page.evaluate(value=>window.__downloadFailure=value,phase);await page.click('#redact-download');
   assert.match(await page.locator('#redact-status').textContent(),/could not be confirmed.*Check your browser/);
   assert.doesNotMatch(await page.locator('#redact-status').textContent(),/SYNTHETIC_PRIVATE|Download requested|saved|complete/i);
   assert.equal(downloads.length,i);assert.equal(await page.locator('#redact-reviewed').isChecked(),true);assert.equal(await page.locator('#redact-download').isEnabled(),true);
   assert.equal(await page.locator('#redact-output').textContent(),reviewed);assert.equal(requests.length,before);
   if(phase==='dispatch'){revoked++;await page.waitForFunction(expected=>window.__redactedRevoked.length===expected,revoked);}
   await page.evaluate(()=>window.__downloadFailure=null);const saved=page.waitForEvent('download');await page.click('#redact-download');const file=await saved;
   assert.equal(readFileSync(await file.path(),'utf8'),reviewed);assert.equal(file.suggestedFilename(),'supatrace-run-redacted.json');
   assert.match(await page.locator('#redact-status').textContent(),/Download requested; check your browser/);
   revoked++;await page.waitForFunction(expected=>window.__redactedRevoked.length===expected,revoked);
   assert.equal(downloads.length,i+1);assert.equal(requests.length,before);
  }
  assert.deepEqual(errors,[]);assert.ok(requests.every(r=>(r.method()==='GET'||r.method()==='POST'&&new URL(r.url()).pathname==='/api/audit/events'&&/^\{"action":"export\.started","kind":"trace","run_id":"[A-Za-z0-9_.:-]+"\}$/.test(r.postData()))));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 }finally{await context.close();await live.close();}
});
