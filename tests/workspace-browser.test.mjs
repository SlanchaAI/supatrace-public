import test from 'node:test';
import assert from 'node:assert/strict';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';
import {digest} from '../src/aws-auth.mjs';
// Registered through this file so the long test:ui list in package.json does not conflict across PRs.
import './members-nav-browser.test.mjs';
import './audit-log-browser.test.mjs';
import './organizations-browser.test.mjs';
import './roles-browser.test.mjs';
import './org-sso-browser.test.mjs';
import './projects-browser.test.mjs';

test('real UI shares workspace, accepts targeted invitation, creates/switches environments and removes access',async()=>{
 const live=await start(),browser=await launch(),contexts=[];
 try{
  const make=async id=>{const c=await browser.newContext({acceptDownloads:true});contexts.push(c);await c.route(/^(?!http:\/\/127\.0\.0\.1)/,r=>r.abort());const tenant=await live.signIn(c,id);return {c,tenant,p:await c.newPage()};};
  const owner=await make(4242),member=await make(5252),outsider=await make(6262);
  const responses=[];member.p.on('response',async r=>{if(r.url().includes('/api/runs/page'))responses.push({url:r.url(),status:r.status(),body:await r.json()});});const errors=[];owner.p.on('pageerror',e=>errors.push(e.message));member.p.on('pageerror',e=>errors.push(e.message));
  await owner.p.goto(live.origin+'/app/#members');await owner.p.locator('#shell:not([hidden])').waitFor();
  await owner.p.locator('#share-workspace input').fill('Product team');await owner.p.locator('#share-workspace button').click();await owner.p.locator('#team-members:not([hidden])').waitFor();
  await owner.p.locator('#invite-member input').fill(member.tenant);await owner.p.locator('#invite-member select').selectOption('admin');await owner.p.locator('#invite-member button').click();
  const link=owner.p.locator('#invitation-link a');await link.waitFor();const invite=await link.getAttribute('href');
  await outsider.p.goto(invite);await outsider.p.locator('#workspace-notice button').click();await outsider.p.waitForFunction(()=>document.querySelector('#workspace-notice').textContent.includes('not accepted'));
  await member.p.goto(invite);await member.p.locator('#workspace-notice button').click();await member.p.waitForURL(u=>u.searchParams.get('workspace')===owner.tenant);await member.p.locator('#shell:not([hidden])').waitFor();
  assert.equal(await member.p.evaluate(()=>document.documentElement.dataset.workspace),owner.tenant);assert.match(await member.p.locator('#members-role').innerText(),/admin/);assert.equal(await member.p.locator('#members-readonly').isVisible(),true);await member.p.evaluate(()=>{location.hash='settings';});assert.match(await member.p.locator('#workspace-role').innerText(),/admin/);
  await member.p.locator('#create-environment [name=id]').fill('dev');await member.p.locator('#create-environment [name=name]').fill('Development');await member.p.locator('#create-environment button').click();
  await member.p.waitForURL(u=>u.searchParams.get('environment')==='dev');await member.p.locator('#shell:not([hidden])').waitFor();assert.match(await member.p.locator('#connect-command').innerText(),/--environment dev/);
  const token='x'.repeat(43),start=await member.c.request.post(live.origin+'/api/setup/start?project='+await member.p.evaluate(()=>document.documentElement.dataset.project)+'&environment=dev',{data:{key_hash:digest(token)}});const setup=await start.json();
  const approval=await member.p.evaluate(async({workspace,code})=>{const r=await fetch('/api/setup/approve?workspace='+workspace+'&environment=dev',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({user_code:code})});return {status:r.status,body:await r.text()};},{workspace:owner.tenant,code:setup.user_code});assert.equal(approval.status,200,approval.body);
  const batch={version:1,batch_id:'ui-dev',run_id:'ui-dev',events:[{id:'event',time:'2026-11-05T00:00:00Z',kind:'note',name:'Development trace',data:{synthetic:true}}]},raw=JSON.stringify(batch);
  const uploaded=await member.c.request.post(live.origin+'/api/batches?environment=dev',{headers:{'content-type':'application/json','x-supatrace-key':token,'x-amz-content-sha256':digest(raw)},data:raw});assert.equal(uploaded.status(),201);
  await member.p.goto(live.origin+'/app/?workspace='+owner.tenant+'&environment=dev#traces',{waitUntil:'networkidle'});const debug=await member.p.evaluate(async()=>{const r=await fetch('/api/runs/page'+location.search);return {status:r.status,body:await r.text()};});assert.equal(debug.status,200,debug.body);assert.equal(JSON.parse(debug.body).runs.length,1,debug.body);await member.p.locator('#refresh').click();await member.p.waitForFunction(()=>document.querySelector('#runs').textContent.includes('ui-dev'));assert.match(await member.p.locator('#runs').innerText(),/ui-dev/,JSON.stringify({responses,note:await member.p.locator('#page-note').innerText(),status:await member.p.locator('#status').innerText()}));
  await member.p.goto(live.origin+'/app/?workspace='+owner.tenant+'&environment=default#traces',{waitUntil:'networkidle'});await member.p.locator('#shell:not([hidden])').waitFor();assert.doesNotMatch(await member.p.locator('#runs').innerText(),/ui-dev/);
  await owner.p.reload();await owner.p.locator('#member-list').waitFor();await owner.p.locator('#member-list button',{hasText:'Remove'}).click();await owner.p.waitForFunction(()=>document.querySelector('#member-list').textContent.includes('removed'));
  const denied=await member.p.evaluate(async workspace=>(await fetch('/api/runs?workspace='+workspace+'&environment=dev')).status,owner.tenant);assert.equal(denied,403);assert.deepEqual(errors,[]);
 }finally{for(const c of contexts)await c.close();await browser.close();await live.close();}
});
