import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';
import {alphaProject} from '../src/alpha-projects.mjs';
import {seedLocalWorkspace} from '../scripts/dev.mjs';
const digest=value=>createHash('sha256').update(value).digest('hex');
async function post(page,live,path,data){const raw=JSON.stringify(data),r=await page.evaluate(async({path,raw,hash})=>{const response=await fetch('/api/'+path,{method:'POST',headers:{'content-type':'application/json','x-amz-content-sha256':hash},body:raw});return {ok:response.ok,text:await response.text()};},{path,raw,hash:digest(raw)});assert.equal(r.ok,true,r.text);return JSON.parse(r.text);}
async function ready(page){await page.locator('#shell:not([hidden])').waitFor();await page.locator('#project-list li').first().waitFor({state:'attached'});}
async function bareReload(page,live){await page.evaluate(()=>history.replaceState(null,'','/app/#traces'));await page.reload();await ready(page);}

test('second project and environment persist on bare reload with their trace; sign-out and account change clear scope',{timeout:120000},async()=>{
 const live=await start({plan:'base'}),browser=await launch(),context=await browser.newContext();
 try{
  await context.route(/^(?!http:\/\/127\.0\.0\.1)/,r=>r.abort());const tenant=await live.signIn(context),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(live.origin+'/app/#settings');await ready(page);
  await page.locator('#create-project [name=name]').fill('Staging');await page.locator('#create-project button').click();await page.waitForURL(u=>u.searchParams.has('project')&&u.searchParams.get('project')!==alphaProject(tenant).id);await ready(page);
  const project=await page.locator('#project-select').inputValue();
  await post(page,live,'environments?project='+project,{id:'dev',name:'Development'});
  const key='st_sec_'+randomBytes(32).toString('base64url');await post(page,live,'keys/create?project='+project+'&environment=dev',{key_hash:digest(key),key_type:'secret',expires_in:86400});
  const events=[{id:'second-event',time:'2026-11-17T00:00:00Z',kind:'note',name:'Second project trace',data:{project:'Staging'}}],raw=JSON.stringify({version:1,batch_id:'second-batch',run_id:'second-project-trace',events});
  const uploaded=await fetch(live.origin+'/api/batches?project='+project+'&environment=dev',{method:'POST',headers:{'content-type':'application/json','x-supatrace-key':key,'x-amz-content-sha256':digest(raw)},body:raw});assert.equal(uploaded.status,201,await uploaded.text());
  // Switch away and back through the real selectors, then remove URL scope.
  await page.locator('#project-select').selectOption(alphaProject(tenant).id);await page.waitForURL(u=>u.searchParams.get('project')===alphaProject(tenant).id);await ready(page);
  await page.locator('#project-select').selectOption(project);await page.waitForURL(u=>u.searchParams.get('project')===project);await ready(page);
  await page.locator('#environment-select').selectOption('dev');await page.waitForURL(u=>u.searchParams.get('environment')==='dev');await ready(page);
  await bareReload(page,live);assert.equal(await page.locator('#project-select').inputValue(),project);assert.equal(await page.locator('#environment-select').inputValue(),'dev');
  await page.getByRole('button',{name:'Open trace second-project-trace',exact:true}).click();await page.locator('#events li').first().waitFor();assert.match(await page.locator('#events').textContent(),/Second project trace/);
  // Simulate a session changing account while the old account's URL remains.
  const other=await live.signIn(context,9999);await page.reload();await ready(page);assert.equal(await page.locator('#workspace-select').inputValue(),other);assert.equal(await page.locator('#project-select').inputValue(),alphaProject(other).id);assert.equal(await page.locator('#environment-select').inputValue(),'default');
  assert.equal(await page.evaluate(account=>localStorage.getItem('supatrace.scope:'+account),tenant),null);assert.equal(await page.getByRole('button',{name:'Open trace second-project-trace',exact:true}).count(),0);
  await page.locator('#logout').click();await page.locator('#signin:not([hidden])').waitFor();assert.equal(await page.evaluate(account=>localStorage.getItem('supatrace.scope:'+account),other),null);
  await live.signIn(context);await page.reload();await ready(page);assert.equal(await page.locator('#project-select').inputValue(),alphaProject(tenant).id);assert.equal(await page.locator('#environment-select').inputValue(),'default');assert.deepEqual(errors,[]);
 }finally{await context.close();await browser.close();await live.close();}
});

test('workspace choice persists; deleted environment/project/workspace choices fall back to loaded defaults',{timeout:120000},async()=>{
 const live=await start(),browser=await launch(),context=await browser.newContext();
 try{
  await seedLocalWorkspace(live);await context.route(/^(?!http:\/\/127\.0\.0\.1)/,r=>r.abort());const tenant=await live.signIn(context,5252),page=await context.newPage();
  await page.goto(live.origin+'/app/#traces');await ready(page);await page.locator('#workspace-select').selectOption('github-4242');await page.waitForURL(u=>u.searchParams.get('workspace')==='github-4242');await ready(page);
  await page.locator('#environment-select').selectOption('development');await page.waitForURL(u=>u.searchParams.get('environment')==='development');await ready(page);await bareReload(page,live);
  assert.equal(await page.locator('#workspace-select').inputValue(),'github-4242');assert.equal(await page.locator('#environment-select').inputValue(),'development');
  await page.route(url=>url.pathname==='/api/environments',async route=>{const response=await route.fetch(),body=await response.json();body.environments=body.environments.filter(e=>e.id!=='development');await route.fulfill({response,json:body});});
  await bareReload(page,live);assert.equal(await page.locator('#environment-select').inputValue(),'default');await page.unrouteAll();
  for(const choice of [{workspace:tenant,project:'proj_'+'a'.repeat(32),environment:'development'},{workspace:'org-'+'b'.repeat(32),project:alphaProject('github-4242').id,environment:'development'}]){
   await page.evaluate(({tenant,choice})=>localStorage.setItem('supatrace.scope:'+tenant,JSON.stringify(choice)),{tenant,choice});await bareReload(page,live);
   assert.equal(await page.locator('#workspace-select').inputValue(),tenant);assert.equal(await page.locator('#project-select').inputValue(),alphaProject(tenant).id);assert.equal(await page.locator('#environment-select').inputValue(),'default');
  }
 }finally{await context.close();await browser.close();await live.close();}
});

test('deleting the last accessible shared environment restores personal Default before scoped reads',{timeout:120000},async()=>{
 const live=await start({plan:'pro'}),browser=await launch(),owner=await browser.newContext(),member=await browser.newContext();
 try{
  for(const context of [owner,member])await context.route(/^(?!http:\/\/127\.0\.0\.1)/,r=>r.abort());
  const workspace=await live.signIn(owner),account=await live.signIn(member,5252),op=await owner.newPage(),page=await member.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await op.goto(live.origin+'/app/#members');await ready(op);
  await post(op,live,'workspaces',{name:'Limited team'});
  await post(op,live,'environments',{id:'dev',name:'Development'});
  const invite=await post(op,live,'workspaces/invite',{recipient_id:account,role:'developer',environments:['dev']});
  await page.goto(live.origin+'/app/#members');await ready(page);
  await post(page,live,'workspaces/accept',{workspace_id:workspace,token:invite.token});
  await page.reload();await ready(page);
  await page.locator('#workspace-select').selectOption(workspace);await page.waitForURL(u=>u.searchParams.get('workspace')===workspace);await ready(page);
  assert.equal(await page.locator('#environment-select').inputValue(),'dev');
  await post(op,live,'environments/delete',{id:'dev',confirm:'dev'});
  // Membership and project still exist, but the member's allowed environment is gone.
  const lists=await page.evaluate(async workspace=>({projects:await (await fetch('/api/projects')).json(),environments:await (await fetch('/api/environments?workspace='+workspace)).json()}),workspace);
  assert.ok(lists.projects.projects.some(p=>p.workspace_id===workspace));assert.deepEqual(lists.environments.environments,[]);
  const reads=[];page.on('request',request=>{const url=new URL(request.url());if(['/api/environments','/api/runs/page','/api/keys'].includes(url.pathname))reads.push(url);});
  for(const bare of [true,false]){
   if(bare)await page.evaluate(()=>history.replaceState(null,'','/app/#traces'));
   else await page.evaluate(workspace=>history.replaceState(null,'','/app/?workspace='+workspace+'&environment=dev#traces'),workspace);
   const keys=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/keys'&&response.ok());
   await page.reload();await ready(page);await keys;
   assert.equal(await page.locator('#workspace-select').inputValue(),account);assert.equal(await page.locator('#project-select').inputValue(),alphaProject(account).id);assert.equal(await page.locator('#environment-select').inputValue(),'default');
   assert.deepEqual(await page.evaluate(account=>JSON.parse(localStorage.getItem('supatrace.scope:'+account)),account),{workspace:account,project:alphaProject(account).id,environment:'default'});
  }
  assert.ok(reads.some(u=>u.pathname==='/api/environments'&&u.searchParams.get('workspace')===workspace));
  assert.ok(reads.some(u=>u.pathname==='/api/environments'&&u.searchParams.get('project')===alphaProject(account).id));
  assert.ok(reads.some(u=>u.pathname==='/api/runs/page'));
  assert.ok(reads.filter(u=>u.pathname!=='/api/environments').every(u=>u.searchParams.get('workspace')!==workspace));assert.deepEqual(errors,[]);
 }finally{await owner.close();await member.close();await browser.close();await live.close();}
});
