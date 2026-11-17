import test from 'node:test';
import assert from 'node:assert/strict';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';
import {alphaProject} from '../src/alpha-projects.mjs';

test('Settings creates and renames a second project in the same organization, switches isolated traces and guards busy operations', {timeout:120000},async()=>{
 const live=await start({plan:'base'}),browser=await launch(),context=await browser.newContext();
 try{
  await context.route(/^(?!http:\/\/127\.0\.0\.1)/,r=>r.abort());const tenant=await live.signIn(context),[run]=await live.seedRuns(tenant,1),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const ready=async()=>{await page.locator('#shell:not([hidden])').waitFor();await page.locator('#project-list li').first().waitFor({state:'attached'});};
  await page.goto(live.origin+'/app/#settings');await ready();assert.equal(await page.locator('#project-select option').count(),1);assert.equal(await page.locator('#rename-project').isVisible(),true);
  await page.locator('#create-project [name=name]').fill('Staging');await page.locator('#create-project button').click();await page.waitForURL(u=>u.searchParams.has('project')&&u.searchParams.get('project')!==alphaProject(tenant).id);await ready();
  const project=new URL(page.url()).searchParams.get('project');assert.equal(new URL(page.url()).searchParams.get('workspace'),tenant);assert.equal(await page.locator('#org-select option').count(),1);assert.equal(await page.locator('#project-select option').count(),2);
  await page.goto(live.origin+'/app/?workspace='+tenant+'&project='+project+'&environment=default#traces');await ready();await page.waitForFunction(()=>/0 traces/.test(document.querySelector('#page-note').textContent));assert.doesNotMatch(await page.locator('#runs').innerText(),new RegExp(run));
  await page.locator('#rail a[data-nav=settings]').click();await page.locator('#rename-project [name=name]').fill('Stage EU');await page.locator('#rename-project button').click();await page.waitForFunction(()=>document.querySelector('#project-select option:checked')?.textContent==='Stage EU');
  await page.evaluate(async()=>{const {setSwitchGuard}=await import('/app/switch-guard.js');setSwitchGuard(()=>false);});const before=page.url();await page.locator('#create-project [name=name]').fill('Blocked');await page.locator('#create-project button').click();await page.waitForFunction(()=>document.querySelector('#projects-status').textContent.includes('Finish or cancel'));assert.equal(page.url(),before);assert.equal(await page.locator('#project-list li').count(),2);
  // Initial selector population and the refusal branch both remain usable.
  await page.locator('#project-select').selectOption(alphaProject(tenant).id);await page.waitForFunction(()=>document.querySelector('#scope-notice').textContent.includes('Finish or cancel'));assert.equal(await page.locator('#project-select').inputValue(),project);assert.equal(await page.locator('#project-select option').count(),2);
  await page.evaluate(async()=>{const {setSwitchGuard}=await import('/app/switch-guard.js');setSwitchGuard(()=>true);});await page.locator('#create-project button').click();await page.waitForURL(u=>u.searchParams.get('project')!==project);await ready();assert.equal(await page.locator('#project-list li').count(),3);
  await page.goto(live.origin+'/app/'+new URL(page.url()).search+'#settings');await ready();await page.locator('#create-project [name=name]').fill('Too many');await page.locator('#create-project button').click();await page.waitForFunction(()=>document.querySelector('#projects-status').textContent.includes('Upgrade in Billing'));assert.equal(await page.locator('#project-list li').count(),3);
  const removed=new URL(page.url()).searchParams.get('project');await page.locator('#delete-project [name=confirm]').fill('wrong');await page.locator('#delete-project button').click();await page.waitForFunction(()=>document.querySelector('#projects-status').textContent.includes('Type the project ID exactly'));assert.equal(await page.locator('#project-list li').count(),3);
  await page.locator('#delete-project [name=confirm]').fill(removed);await page.locator('#delete-project button').click();await page.waitForURL(u=>!u.searchParams.has('project'));await ready();assert.equal(await page.locator('#project-list li').count(),2);await page.locator('#rail a[data-nav=settings]').click();assert.equal(await page.locator('#delete-project').isVisible(),false);
  await page.locator('#project-select').selectOption(alphaProject(tenant).id);await page.waitForURL(u=>u.searchParams.get('project')===alphaProject(tenant).id);await ready();await page.locator('#rail a[data-nav=traces]').click();await page.waitForFunction(run=>document.querySelector('#runs').textContent.includes(run),run);assert.deepEqual(errors,[]);
 }finally{await context.close();await browser.close();await live.close();}
});
