// Real UI/API/store acceptance with synthetic workspaces; no hosted sessions or grants.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';
import {seedLocalWorkspace} from '../scripts/dev.mjs';
let browser;
before(async()=>{browser=await launch();});
after(async()=>{await browser?.close();});
async function nav(page,view){const toggle=page.locator('#menu-toggle');if(await toggle.isVisible()&&await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();await page.locator(`#rail [data-nav="${view}"]`).click();await page.locator(`#view-${view}:not([hidden])`).waitFor();}
async function fits(page){const d=await page.evaluate(()=>({actual:document.documentElement.scrollWidth,width:innerWidth}));assert.ok(d.actual<=d.width,JSON.stringify(d));}
for(const width of [1280,390,320])test(`workspace scope controls follow role and data isolation across views at ${width}px`,{timeout:60000},async()=>{
 const live=await start(),contexts=[];await seedLocalWorkspace(live);
 try{for(const [id,role] of [[4242,'owner'],[5252,'admin'],[6262,'viewer']]){
  const context=await browser.newContext({viewport:{width,height:844}});contexts.push(context);await context.route(/^(?!http:\/\/127\.0\.0\.1)/,r=>r.abort());await live.signIn(context,id);
  const page=await context.newPage(),errors=[],posts=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')posts.push(new URL(r.url()).pathname);});
  await page.goto(live.origin+'/app/?workspace=github-4242&environment=development#home',{waitUntil:'networkidle'});
  assert.equal(await page.locator('#scope-switcher').isVisible(),true);assert.equal(await page.locator('#view-settings #workspace-select').count(),0);assert.equal(await page.getByLabel('Workspace',{exact:true}).inputValue(),'github-4242');assert.equal(await page.getByLabel('Environment',{exact:true}).inputValue(),'development');assert.match(await page.locator('#scope-summary').innerText(),new RegExp(role,'i'));await fits(page);
  await nav(page,'traces');await page.getByRole('button',{name:'Open trace local-run-1',exact:true}).click();await page.locator('#events li').first().waitFor();assert.match(await page.locator('#events').textContent(),/"environment": "development"/);
  await page.getByLabel('Environment',{exact:true}).selectOption('production');await page.waitForURL(u=>u.searchParams.get('environment')==='production');await page.waitForLoadState('networkidle');assert.equal(await page.locator('#detail').isVisible(),false);assert.equal(await page.getByLabel('Environment',{exact:true}).inputValue(),'production');
  await page.getByRole('button',{name:'Open trace local-run-1',exact:true}).click();await page.locator('#events li').first().waitFor();assert.match(await page.locator('#events').textContent(),/"environment": "production"/);assert.doesNotMatch(await page.locator('#events').textContent(),/"environment": "development"/);await page.locator('#close-detail').click();
  await nav(page,'usage');assert.equal(await page.locator('#scope-switcher').isVisible(),true);await nav(page,'settings');assert.equal(await page.locator('#create-environment').isVisible(),role!=='viewer');await nav(page,'members');assert.equal(await page.locator('#team-members').isVisible(),role==='owner');assert.equal(await page.locator('#members-readonly').isVisible(),role!=='owner');await fits(page);
  if(role==='viewer')for(const v of ['agents','keys'])assert.equal(await page.locator(`#rail [data-nav="${v}"]`).isVisible(),false);
  if(role!=='owner'){await page.getByLabel('Workspace',{exact:true}).selectOption('github-'+id);await page.waitForURL(u=>u.searchParams.get('workspace')==='github-'+id&&u.searchParams.get('environment')==='default');await page.waitForLoadState('networkidle');assert.equal(await page.getByLabel('Environment',{exact:true}).inputValue(),'default');assert.match(await page.locator('#scope-summary').textContent(),/Owner/);await nav(page,'traces');assert.match(await page.locator('#page-note').innerText(),/0 traces/);}
  if(role==='owner'&&process.env.SUPATRACE_SCOPE_SCREENSHOT_DIR){mkdirSync(process.env.SUPATRACE_SCOPE_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:process.env.SUPATRACE_SCOPE_SCREENSHOT_DIR+'/scope-'+width+'.png',fullPage:true});}
  assert.deepEqual(posts,[],'scope selection must not create grants or mutate workspace state');assert.deepEqual(errors,[]);
 }}finally{for(const context of contexts)await context.close();await live.close();}
});
for(const width of [1280,390,320])test(`busy export restores both scope selectors and exposes a visible recovery at ${width}px`,{timeout:60000},async()=>{
 const live=await start(),context=await browser.newContext({viewport:{width,height:844}});await seedLocalWorkspace(live);await context.route(/^(?!http:\/\/127\.0\.0\.1)/,r=>r.abort());await live.signIn(context,5252);
 await context.addInitScript(()=>{window.showSaveFilePicker=()=>new Promise(()=>{});});const page=await context.newPage();
 try{
  await page.goto(live.origin+'/app/?workspace=github-4242&environment=development#traces',{waitUntil:'networkidle'});await page.getByRole('button',{name:'Open trace local-run-1',exact:true}).click();await page.locator('#events li').first().waitFor();await page.locator('#export').click();await page.locator('#cancel-export').waitFor();const original=page.url();
  await page.getByLabel('Environment',{exact:true}).selectOption('production');assert.equal(page.url(),original);assert.equal(await page.getByLabel('Environment',{exact:true}).inputValue(),'development');assert.equal(await page.locator('#scope-notice').isVisible(),true);assert.match(await page.locator('#scope-notice').innerText(),/Finish or cancel/);
  await page.getByLabel('Workspace',{exact:true}).selectOption('github-5252');assert.equal(page.url(),original);assert.equal(await page.getByLabel('Workspace',{exact:true}).inputValue(),'github-4242');assert.equal(await page.getByLabel('Environment',{exact:true}).inputValue(),'development');await fits(page);
  await page.locator('#cancel-export').click();await page.locator('#cancel-export').waitFor({state:'hidden'});await page.getByLabel('Environment',{exact:true}).selectOption('production');await page.waitForURL(u=>u.searchParams.get('environment')==='production');await page.waitForLoadState('networkidle');assert.equal(await page.locator('#scope-notice').isVisible(),false);assert.equal(await page.getByLabel('Environment',{exact:true}).inputValue(),'production');
 }finally{await context.close();await live.close();}
});
