import test from 'node:test';
import assert from 'node:assert/strict';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';
import {composeServerPullController} from '../src/import-composition.mjs';
for(const width of [1280,390])test('actual Agents server-pull journey and reload recovery at '+width+'px',{timeout:60000},async()=>{
 const browser=await launch();let fetches=0;const live=await start({configureEnvironment:env=>Object.assign(env,composeServerPullController(JSON.stringify({mode:'bounded-server-pull-v1',origin:'https://supatrace.dev'}),{store:env.store,objects:env.objects,origins:['https://supatrace.dev'],fetchImpl:async url=>{fetches++;return Response.json(url.endsWith('/projects')?{data:[{id:'synthetic-pull'}]}:{data:[{id:'one',traceId:'trace-one',projectId:'synthetic-pull',environment:'synthetic',startTime:'2026-10-01T12:00:00Z',input:'SYNTHETIC_INPUT'}],meta:{cursor:null}});}}))}),context=await browser.newContext({viewport:{width,height:1000}}),outside=[],errors=[];
 await context.route(/^(?!http:\/\/127\.0\.0\.1)/,route=>{outside.push(route.request().url());return route.abort();});
 try{
  await live.signIn(context);const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  const plan=async()=>{const values={'import-source':'synthetic-pull','import-trace':'trace-one','import-environment':'synthetic','import-namespace':'browser-pull','import-from':'2026-10-01T00:00','import-to':'2026-10-02T00:00','import-rows':'10','import-pages':'2','import-page-size':'5','import-bytes':'100000'};for(const [id,value]of Object.entries(values))await page.fill('#'+id,value);await page.click('#import-plan-button');await page.waitForFunction(()=>!document.querySelector('#import-consent-review').disabled);await page.click('#import-consent-review');await page.waitForFunction(()=>!document.querySelector('#import-consent-accept').disabled);await page.check('#import-consent-accept');await page.click('#import-consent-confirm');await page.waitForFunction(()=>!document.querySelector('#import-start').disabled);};
  await page.goto(live.origin+'/app/#agents');await page.locator('#shell:not([hidden])').waitFor();await plan();assert.equal(fetches,0);
  await page.fill('#import-public-key','synthetic-public-key');await page.fill('#import-secret-key','synthetic-secret-key');await page.click('#import-start');await page.waitForFunction(()=>document.querySelector('#import-consent-status').textContent.includes('Durable step: ready'));
  await page.click('#import-pull-pause');await page.waitForFunction(()=>document.querySelector('#import-pull-pause').hidden);assert.equal(await page.inputValue('#import-secret-key'),'');assert.equal(fetches,2);
  await page.reload();await page.locator('#shell:not([hidden])').waitFor();await plan();await page.click('#import-pull-status');await page.waitForFunction(()=>document.querySelector('#import-consent-status').textContent.includes('Durable step: ready'));
  await page.click('#import-start');await page.waitForFunction(()=>document.querySelector('#import-consent-status').textContent.includes('Import stored and read back'));
  assert.equal(await page.locator('#import-start').isDisabled(),true);assert.equal(fetches,2);assert.equal(await page.evaluate(()=>JSON.stringify({...localStorage}).includes('synthetic-secret-key')||JSON.stringify({...sessionStorage}).includes('synthetic-secret-key')),false);
  await page.fill('#import-secret-key','synthetic-secret-key');await page.fill('#import-trace','trace-two');assert.equal(await page.inputValue('#import-secret-key'),'');assert.equal(await page.locator('#import-start').isDisabled(),true);assert.equal(await page.locator('#import-pull-controls').isHidden(),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(outside,[]);assert.deepEqual(errors,[]);
 }finally{await context.close();await browser.close();await live.close();}
});
