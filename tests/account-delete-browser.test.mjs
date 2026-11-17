import test from 'node:test';
import assert from 'node:assert/strict';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';
test('Settings closes a synthetic account through the real route and returns to sign-in without startup errors',async()=>{
 const live=await start(),browser=await launch(),context=await browser.newContext(),page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 try{
  const tenant=await live.signIn(context);
  await page.goto(live.origin+'/app/#settings');await page.locator('#shell:not([hidden])').waitFor();
  await page.locator('#account-delete-confirm').fill('DELETE');
  await page.locator('#account-delete-form button').click();
  await page.waitForURL(/account_deleted=1/);await page.locator('#signed-out:not([hidden])').waitFor({state:'visible'});
  assert.ok((await live.store.getTenant(tenant)).deleted_at);assert.deepEqual(errors,[]);
 }finally{await context.close();await browser.close();await live.close();}
});
