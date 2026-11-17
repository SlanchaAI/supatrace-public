import test from 'node:test';
import assert from 'node:assert/strict';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';

// Issue #92: Members is a top-level rail entry, reachable before sharing is enabled; the enable flow is inline.
for(const width of [1280,390])test(`Members is reachable from the rail before sharing is on and enables sharing inline at ${width}px`,{timeout:60000},async()=>{
 const live=await start(),browser=await launch(),context=await browser.newContext({viewport:{width,height:844}});
 try{
  await context.route(/^(?!http:\/\/127\.0\.0\.1)/,r=>r.abort());const tenant=await live.signIn(context,4242),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(live.origin+'/app/#home');await page.locator('#shell:not([hidden])').waitFor();
  const toggle=page.locator('#menu-toggle');if(await toggle.isVisible()&&await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();
  const link=page.locator('#rail a[data-nav="members"]');assert.equal(await link.innerText(),'Members');await link.click();
  await page.locator('#view-members:not([hidden])').waitFor();assert.equal(await link.getAttribute('aria-current'),'page');assert.equal(new URL(page.url()).hash,'#members');
  assert.equal(await page.locator('#view-settings').isVisible(),false);
  assert.match(await page.locator('#members-role').innerText(),/You are the owner\. Team sharing is off\./);
  assert.equal(await page.locator('#share-workspace').isVisible(),true);assert.equal(await page.locator('#team-members').isVisible(),false);assert.equal(await page.locator('#members-readonly').isVisible(),false);
  await page.locator('#share-workspace input').fill('Launch team');await page.locator('#share-workspace button').click();
  await page.locator('#team-members:not([hidden])').waitFor();
  assert.equal(await page.locator('#view-members').isVisible(),true,'enabling sharing stays on Members');assert.equal(await page.locator('#share-workspace').isVisible(),false);
  assert.equal(await page.locator('#members-title').innerText(),'Launch team');assert.match(await page.locator('#member-list').innerText(),new RegExp(tenant+' · Owner'));
  assert.equal(await page.locator('#invite-member').isVisible(),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true,'Members fits the viewport');
  if(process.env.SUPATRACE_MEMBERS_SCREENSHOT_DIR)await page.screenshot({path:process.env.SUPATRACE_MEMBERS_SCREENSHOT_DIR+'/members-'+width+'.png',fullPage:true});
  assert.deepEqual(errors,[]);
 }finally{await context.close();await browser.close();await live.close();}
});
