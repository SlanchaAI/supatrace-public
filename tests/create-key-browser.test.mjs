import test from 'node:test';
import assert from 'node:assert/strict';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';
import {digest} from '../src/aws-auth.mjs';

test('signed-in owner creates a write key with one click and uploads with it',async()=>{
 const live=await start(),browser=await launch(),context=await browser.newContext();
 try{
  await context.route(/^(?!http:\/\/127\.0\.0\.1)/,r=>r.abort());await live.signIn(context);
  const page=await context.newPage(),errors=[],posted=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')posted.push({path:new URL(r.url()).pathname,body:r.postData()});});
  await page.goto(live.origin+'/app/#agents');await page.locator('#shell:not([hidden])').waitFor();
  await page.locator('#create-key').click();await page.locator('#new-key-config:not([hidden])').waitFor();
  const config=JSON.parse(await page.locator('#new-key-config').innerText());
  assert.equal(config.approved,true);assert.match(config.write_key,/^[A-Za-z0-9_-]{43}$/);assert.match(config.project_id,/^proj_[a-f0-9]{32}$/);
  assert.match(await page.locator('#created-key').innerText(),/shown only once/);assert.match(await page.locator('#new-key-download').getAttribute('href'),/^data:application\/json,/);
  // The raw key never leaves the browser: setup/start receives only its hash.
  const startBody=posted.find(r=>r.path==='/api/setup/start')?.body;assert.ok(startBody);assert.equal(JSON.parse(startBody).key_hash,digest(config.write_key));assert.ok(posted.every(r=>!r.body?.includes(config.write_key)));
  const batch={version:1,batch_id:'one-click-key',run_id:'one-click-key',events:[{id:'e1',time:'2026-11-09T00:00:00Z',kind:'note',name:'Dashboard key upload',data:{synthetic:true}}]},raw=JSON.stringify(batch);
  const uploaded=await context.request.post(live.origin+'/api/batches',{headers:{'content-type':'application/json','x-supatrace-key':config.write_key,'x-amz-content-sha256':digest(raw)},data:raw});
  assert.equal(uploaded.status(),201);assert.equal((await uploaded.json()).project_id,config.project_id);
  const runs=await page.evaluate(async()=>JSON.stringify(await (await fetch('/api/runs')).json()));assert.match(runs,/one-click-key/);
  assert.deepEqual(errors,[]);
 }finally{await context.close();await browser.close();await live.close();}
});
