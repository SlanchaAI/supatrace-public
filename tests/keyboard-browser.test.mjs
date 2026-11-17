// Rendered keyboard acceptance fixture. NOT part of npm test; run only where
// browser execution is authorized. Synthetic loopback is not hosted acceptance.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';
let browser;
before(async()=>{browser=await launch();});
after(async()=>{await browser?.close();});
async function focused(page,selector){await page.waitForFunction(selector=>document.querySelector(selector)===document.activeElement,selector);}
async function nav(page,name){const toggle=page.locator('#menu-toggle');if(await toggle.isVisible()&&await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();await page.locator(`#rail a[data-nav="${name}"]`).click();await page.locator(`#view-${name}:not([hidden])`).waitFor();}
for(const viewport of [{width:1280,height:800},{width:390,height:844},{width:320,height:740}])test(`keyboard recovery and nonmodal trace navigation at ${viewport.width}px`,{timeout:60000},async()=>{
 const live=await start(),context=await browser.newContext({viewport});
 await context.route(/^(?!http:\/\/127\.0\.0\.1)/,route=>route.abort());
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(String(error)));
 try{
  const tenant=await live.signIn(context);await live.seedRuns(tenant,3);await page.goto(live.origin+'/app/',{waitUntil:'networkidle'});await page.locator('#recent button').first().waitFor();
  await page.locator('#recent button').first().focus();await page.keyboard.press('Enter');await focused(page,'#run-title');await page.locator('#events-note').filter({hasText:/All|No events/}).waitFor();
  assert.equal(await page.locator('#detail').getAttribute('aria-labelledby'),'run-title');assert.equal(await page.locator('#detail').getAttribute('aria-modal'),null);
  // Wait past hashchange/load completion: neither may steal focus to the list.
  await focused(page,'#run-title');await page.keyboard.press('Tab');await focused(page,'#export');
  await page.locator('#redact-open').click();await focused(page,'#redact-paths');await page.fill('#redact-literals','synthetic rule');await page.keyboard.press('Escape');await focused(page,'#redact-open');assert.equal(await page.locator('#redaction-panel').isVisible(),false);assert.equal(await page.locator('#redact-literals').inputValue(),'');
  await page.keyboard.press('Escape');assert.equal(await page.locator('#detail').isVisible(),false);assert.equal(await page.locator('#runs .trace-open').evaluateAll(nodes=>nodes.some(node=>node===document.activeElement)),true);
  await nav(page,'agents');await focused(page,'#view-agents h1');
  await page.locator('#skip-workspace').focus();await page.keyboard.press('Enter');await focused(page,'#workspace');assert.equal(new URL(page.url()).hash,'#agents');
  await nav(page,'settings');await focused(page,'#view-settings h1');await page.goBack();await focused(page,'#view-agents h1');await page.goForward();await focused(page,'#view-settings h1');
  await nav(page,'traces');await page.locator('#runs .trace-open').first().click();await focused(page,'#run-title');await nav(page,'traces');assert.equal(await page.locator('#detail').isVisible(),false);await focused(page,'#view-traces h1');
  if(viewport.width<=800){
   await page.locator('#menu-toggle').click();await focused(page,'#close-menu');assert.equal(await page.locator('#app-frame').evaluate(node=>node.inert),true);assert.equal(await page.locator('#skip-workspace').evaluate(node=>node.inert),true);
   await page.keyboard.press('Shift+Tab');await focused(page,'#rail a[data-nav="settings"]');await page.keyboard.press('Tab');await focused(page,'#close-menu');await page.keyboard.press('Escape');await focused(page,'#menu-toggle');assert.equal(await page.locator('#app-frame').evaluate(node=>node.inert),false);
   // CSS may blur the now-display:none control before matchMedia dispatches.
   // Exercise both closed and open drawer transitions repeatedly, without sleeps.
   for(let repeat=0;repeat<3;repeat++){
    await page.setViewportSize({width:1280,height:800});await focused(page,'#rail a[data-nav="traces"]');
    await page.setViewportSize(viewport);await focused(page,'#menu-toggle');
    await page.locator('#menu-toggle').click();await focused(page,'#close-menu');
    await page.setViewportSize({width:1280,height:800});await focused(page,'#rail a[data-nav="traces"]');
    await page.setViewportSize(viewport);await focused(page,'#menu-toggle');
   }
   await page.locator('#logout').focus();await page.setViewportSize({width:1280,height:800});await focused(page,'#logout');await page.setViewportSize(viewport);await focused(page,'#logout');
  }else{
   // Filter replacement removes the old opener; Close must use a visible fallback.
   await page.locator('#runs .trace-open').first().click();await page.fill('#trace-search','no-synthetic-match');await page.locator('#filters button[type="submit"]').click();await page.locator('#page-note').filter({hasText:'0 traces'}).waitFor();await page.locator('#close-detail').click();await focused(page,'#view-traces h1');
  }
  assert.deepEqual(errors,[]);
 }finally{await context.close();await live.close();}
});
