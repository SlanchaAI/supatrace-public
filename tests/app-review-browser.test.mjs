import test from 'node:test';
import assert from 'node:assert/strict';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';
for (const width of [1440,390]) test(`app review structure and unavailable importers at ${width}`,async()=>{
 const live=await start(),browser=await launch(),context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 try {
  await live.signIn(context);await page.goto(live.origin+'/app/#integrations',{waitUntil:'networkidle'});
  await page.locator('#integrations-scan').filter({hasText:'0 traces in this environment'}).waitFor();
  assert.equal(new URL(page.url()).hash,'#agents');assert.equal(await page.title(),'Agents · SupaTrace');
  assert.equal(await page.locator('#rail [data-nav=integrations],#rail [data-nav=logs]').count(),0);
  assert.equal(await page.locator('#importers-unavailable').innerText(),'Importers are not available yet.');
  for(const id of ['import-form','braintrust-form','langsmith-form'])assert.equal(await page.locator('#'+id).isVisible(),false);
  await page.evaluate(()=>location.hash='logs');await page.locator('#logs-status').filter({hasText:'No rejected or partly stored attempts match these filters.'}).waitFor();
  assert.equal(new URL(page.url()).hash,'#traces');assert.equal(await page.title(),'Traces · SupaTrace');
  assert.equal(await page.locator('#runs').evaluate(n=>!!(n.compareDocumentPosition(document.getElementById('trace-exports'))&Node.DOCUMENT_POSITION_FOLLOWING)),true);
  const exportWords=await page.locator('#account-export-note,#workspace-export-note,#export-hint').allTextContents();
  assert.ok(exportWords.join(' ').split(/\s+/).length<230);
  await page.evaluate(()=>location.hash='billing');
  await page.locator('#plan-billing[data-plan=free]').waitFor();
  assert.equal(await page.locator('#plan-page').isVisible(),false);
  assert.equal(await page.locator('#billing-controls').isVisible(),false);
  assert.equal(await page.locator('#billing-availability').isVisible(),false);
  assert.equal(await page.locator('#plan-features').isVisible(),false);
  await page.evaluate(()=>location.hash='settings');
  await page.locator('[data-upgrade-for=drain-form]').waitFor();
  assert.equal(await page.locator('#drain-form').isVisible(),false);
  assert.match(await page.locator('#support-section').innerText(),/Do not paste API keys, login details, or private traces\./);
  assert.doesNotMatch(await page.locator('#support-section').innerText(),/\[REDACTED\]/);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
 }finally{await context.close();await browser.close();await live.close();}
});
