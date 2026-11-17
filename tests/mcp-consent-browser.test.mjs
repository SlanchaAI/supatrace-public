import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';
import {alphaProject} from '../src/alpha-projects.mjs';
let browser;before(async()=>{browser=await launch();});after(async()=>{await browser?.close();});
for(const [width,content]of [[1280,'metadata'],[320,'include']])test('browser reviews exact MCP scope before approval and revocation at '+width+'px',{timeout:30000},async()=>{
 const live=await start({mcp:true}),context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage(),errors=[],posts=[];
 await context.route(/^(?!http:\/\/127\.0\.0\.1)/,route=>route.abort());
 page.on('pageerror',e=>errors.push(String(e)));page.on('request',r=>{if(r.method()==='POST')posts.push(new URL(r.url()).pathname);});
 try{
  const tenant=await live.signIn(context),projectId=alphaProject(tenant).id,token=randomBytes(32).toString('base64url');
  const body={tokenHash:createHash('sha256').update(token).digest('hex'),scope:{origin:'https://supatrace.dev',tenantId:tenant,projectId,runIds:['proof-one'],content,client:'Local QA client'}};
  const pending=await(await fetch(live.origin+'/api/mcp/requests',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).json();
  await page.goto(live.origin+'/mcp/?code='+pending.code,{waitUntil:'networkidle'});await page.locator('#request').waitFor({state:'visible'});
  assert.equal(await page.locator('#confirmed').isChecked(),false);assert.equal(await page.locator('#content').isChecked(),false);assert.deepEqual(posts,[]);
  assert.match(await page.locator('#scope').innerText(),new RegExp(projectId));assert.match(await page.locator('#scope').innerText(),/proof-one/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.locator('#approve').click();assert.deepEqual(posts,[],'unchecked confirmation cannot submit');
  await page.locator('#confirmed').focus();await page.keyboard.press('Space');
  if(content==='include'){await page.locator('#approve').click();assert.deepEqual(posts,[],'content needs separate opt-in');await page.locator('#content').focus();await page.keyboard.press('Space');}
  await mkdir('test-artifacts/ui',{recursive:true});await page.screenshot({path:'test-artifacts/ui/mcp-consent-'+width+'.png',fullPage:true});
  await page.locator('#approve').focus();await page.keyboard.press('Enter');await page.locator('#status').filter({hasText:'Approved until'}).waitFor();
  assert.deepEqual(posts,['/api/mcp/approve']);assert.equal(await page.locator('#consent').isVisible(),false);
  await page.locator('#revoke').focus();await page.keyboard.press('Enter');await page.locator('#status').filter({hasText:'revoked'}).waitFor();
  assert.deepEqual(posts,['/api/mcp/approve','/api/mcp/revoke']);assert.deepEqual(errors,[]);
  assert.equal((await fetch(live.origin+'/api/mcp/poll',{method:'POST',headers:{'content-type':'application/json',cookie:'__Host-supatrace-mcp='+token},body:'{}'})).status,401);
 }finally{await context.close();await live.close();}
});
test('missing login and disabled bridge never expose an approval action',{timeout:30000},async()=>{
 const live=await start({mcp:false}),context=await browser.newContext(),page=await context.newPage();
 await context.route(/^(?!http:\/\/127\.0\.0\.1)/,route=>route.abort());
 try{await page.goto(live.origin+'/mcp/?code=abcdefghijkl',{waitUntil:'networkidle'});assert.match(await page.locator('#status').innerText(),/not enabled/);assert.equal(await page.locator('#request').isVisible(),false);}
 finally{await context.close();await live.close();}
});
test('signed-out browser cannot inspect or approve a pending request',{timeout:30000},async()=>{
 const live=await start({mcp:true}),context=await browser.newContext(),page=await context.newPage();
 await context.route(/^(?!http:\/\/127\.0\.0\.1)/,route=>route.abort());
 try{
  const tenant=await live.signIn({addCookies:async()=>{}}),token=randomBytes(32).toString('base64url');
  const pending=await(await fetch(live.origin+'/api/mcp/requests',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tokenHash:createHash('sha256').update(token).digest('hex'),scope:{origin:'https://supatrace.dev',tenantId:tenant,projectId:alphaProject(tenant).id,content:'metadata',runIds:['proof'],client:'Local QA client'}})})).json();
  await page.goto(live.origin+'/mcp/?code='+pending.code,{waitUntil:'networkidle'});assert.match(await page.locator('#status').innerText(),/Sign in to the intended/);assert.equal(await page.locator('#request').isVisible(),false);assert.equal(await page.locator('#scope').innerText(),'');
 }finally{await context.close();await live.close();}
});
