import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {handle} from '../src/aws-api.mjs';
import {DynamoMetadataStore,digest} from '../src/dynamodb-store.mjs';
import {MemoryDynamo,commandClasses} from './memory-dynamo.mjs';
import {alphaProject} from '../src/alpha-projects.mjs';
import {createFixtureSession} from './fixture-session.mjs';
import {first,collisions,free,withSessionTokens} from './session-token-fixtures.mjs';
import {stampPlan} from './harness.mjs';
import {planLimits} from '../src/plan-limits.mjs';
// Registered through this file so the long test list in package.json does not conflict across PRs.
import './audit-log.test.mjs';
import './organizations.test.mjs';
import './roles.test.mjs';
import './org-sso.test.mjs';
import './projects-view.test.mjs';
import './account-deletion.test.mjs';
import './multiple-projects.test.mjs';
const origin='https://supatrace.dev';
// Accounts are on Free unless a test names a plan, as in production. A test that needs a non-admin role or more
// than Free's environments or seats says so with fixture(PAID).
const PAID='pro';
async function fixture(plan){
 const memory=new MemoryDynamo(),store=new DynamoMetadataStore({client:memory,commands:commandClasses(),tableName:'synthetic'}),saved=new Map(),tokens={};if(plan)stampPlan(store,plan);
 for(const n of [1,2,3]){const t=await store.getOrCreateTenant(n),token=await createFixtureSession(store,t.tenant_id);tokens[t.tenant_id]=token;}
 const env={ENABLED:true,APP_ORIGIN:origin,GITHUB_CLIENT_ID:'synthetic',GITHUB_CLIENT_SECRET:'synthetic',store,objects:{putImmutable:async(k,v)=>saved.set(k,v),get:async k=>saved.get(k)}};
 const api=(actor,path,body,scope={})=>{const u=new URL('/api/'+path,origin);for(const [k,v] of Object.entries(scope))u.searchParams.set(k,v);return handle(new Request(u,{method:body===undefined?'GET':'POST',headers:{cookie:'__Host-supatrace='+tokens[actor],origin,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);};
 const shared=async()=>{assert.equal((await api('github-1','workspaces',{name:'Synthetic team'})).status,201);};
 const join=async(actor='github-2',role='admin')=>{await shared();const r=await api('github-1','workspaces/invite',{recipient_id:actor,role});assert.equal(r.status,201);const inv=await r.json();assert.equal((await api(actor,'workspaces/accept',{workspace_id:'github-1',token:inv.token})).status,200);return inv;};
 const key=async(actor,environment='default',workspace='github-1')=>{const token=randomBytes(32).toString('base64url');const r=await handle(new Request(origin+'/api/setup/start?project='+alphaProject(workspace).id+'&environment='+environment,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key_hash:digest(token)})}),env);assert.equal(r.status,201);const setup=await r.json();const approval=await api(actor,'setup/approve',{user_code:setup.user_code},{workspace,environment});assert.equal(approval.status,200,await approval.clone().text());return token;};
 const batch=text=>({version:1,batch_id:'identical-batch',run_id:'identical-run',events:[{id:'event',time:'2026-11-05T00:00:00Z',kind:'note',name:'Synthetic trace',data:{text}}]});
 const upload=async(token,environment='default',data=batch(environment))=>{const raw=JSON.stringify(data);return handle(new Request(origin+'/api/batches?project='+alphaProject('github-1').id+'&environment='+environment,{method:'POST',headers:{'content-type':'application/json','x-supatrace-key':token,'x-amz-content-sha256':digest(raw)},body:raw}),env);};
 return {env,store,memory,saved,api,join,shared,key,batch,upload};
}
test('project and workspace APIs expose distinct project capabilities',async()=>{
 const f=await fixture();
 async function list(path,count){
  const response=await f.api('github-2',path);assert.equal(response.status,200);
  const rows=(await response.json())[path];assert.equal(rows.length,count);
  for(const row of rows){assert.equal(row.additional_projects_available,path==='projects');assert.equal(row.scope,'account_workspace');}
  return rows;
 }
 for(const path of ['projects','workspaces'])assert.equal((await list(path,1))[0].id,alphaProject('github-2').id);
 await f.join();
 for(const path of ['projects','workspaces']){
  const rows=await list(path,2);
  assert.deepEqual(new Set(rows.map(row=>row.id)),new Set([alphaProject('github-1').id,alphaProject('github-2').id]));
 }
 assert.equal((await f.api('github-2','projects',{name:'Second project'})).status,201);
 assert.equal((await f.api('github-2','projects',{name:'Third project'})).status,402);
 assert.equal((await f.api('github-2','projects/'+alphaProject('github-2').id,{name:'Renamed'})).status,400);
 assert.equal((await f.api('github-2','runs',undefined,{project:alphaProject('github-2').id})).status,200);
 const foreign=await f.api('github-2','runs',undefined,{project:alphaProject('github-3').id});
 assert.equal(foreign.status,403);assert.equal((await foreign.json()).error,'project_unavailable');
 await list('projects',3);await list('workspaces',2);
});
test('targeted single-use invitations and actor-bound identity; outsider/viewer permissions',async()=>{
 const f=await fixture(PAID);await f.shared();const inv=await(await f.api('github-1','workspaces/invite',{recipient_id:'github-2',role:'viewer'})).json();
 assert.equal((await f.api('github-3','workspaces/accept',{workspace_id:'github-1',token:inv.token})).status,409);
 assert.equal((await f.api('github-2','workspaces/accept',{workspace_id:'github-1',token:inv.token})).status,200);
 assert.equal((await f.api('github-2','workspaces/accept',{workspace_id:'github-1',token:inv.token})).status,409);
 const projects=await(await f.api('github-2','projects')).json();assert.equal(projects.projects.length,2);assert.equal(projects.projects[1].role,'viewer');
 const scope={workspace:'github-1'};
 assert.equal((await(await f.api('github-2','me',undefined,scope)).json()).tenant_id,'github-2');
 for(const path of ['billing/status','keys','workspaces/members'])assert.equal((await f.api('github-2',path,undefined,scope)).status,403,path);
 assert.equal((await f.api('github-2','environments',{id:'dev',name:'Development'},scope)).status,403);
 assert.equal((await f.api('github-3','runs',undefined,scope)).status,403);
 assert.equal((await f.api('github-2','runs',undefined,scope)).status,200);
});
test('invitation joins use aliases for DynamoDB reserved attribute names',async()=>{
 const f=await fixture(),tx=f.store._tx.bind(f.store);let checked=0;
 f.store._tx=async items=>{
  for(const item of items){const op=Object.values(item)[0];if(op.Item?.sk?.startsWith('WORKSPACE#JOIN#')){
   checked++;const expression=op.ConditionExpression.replace(/#[A-Za-z0-9_]+|:[A-Za-z0-9_]+/g,'');
   assert.doesNotMatch(expression,/\bowner\b/i,'DynamoDB reserves OWNER in expressions');
  }}return tx(items);
 };
 await f.join();assert.equal(checked,1);
 assert.equal((await(await f.api('github-2','projects')).json()).projects.length,2);
});
test('real destination namespaces isolate identical IDs, scoped keys and cursors while sharing quota',async()=>{
 const f=await fixture(PAID);await f.join();const scope={workspace:'github-1'};
 for(const id of ['dev','prod'])assert.equal((await f.api('github-2','environments',{id,name:id},scope)).status,201);
 const keys={};for(const id of ['default','dev','prod'])keys[id]=await f.key('github-2',id);
 for(const id of ['default','dev','prod']){assert.equal((await f.upload(keys[id],id)).status,201);const second=f.batch(id);second.batch_id='second-batch';assert.equal((await f.upload(keys[id],id,second)).status,201);}
 assert.equal((await f.api('github-2','keys/revoke',{id:digest(keys.prod)},{...scope,environment:'dev'})).status,403);assert.equal((await f.upload(keys.prod,'prod')).status,201);
 assert.equal((await f.upload(keys.dev,'prod')).status,403);assert.equal((await f.upload(keys.dev)).status,403);
 for(const id of ['default','dev','prod']){const catalog=await f.api('github-2','runs/page',undefined,{...scope,environment:id});assert.equal(catalog.status,200,await catalog.clone().text());assert.equal((await catalog.json()).runs.length,1,id);const body=await(await f.api('github-2','events?run=identical-run',undefined,{...scope,environment:id})).json();assert.equal(body.events[0].data.text,id);}
 const page=await(await f.api('github-2','events?run=identical-run',undefined,{...scope,environment:'dev'})).json();assert.ok(page.next);assert.equal((await f.api('github-2','events?run=identical-run&after='+page.next,undefined,{...scope,environment:'prod'})).status,400);
 assert.equal(f.saved.size,6);assert.equal(new Set([...f.saved.keys()].map(k=>k.split('/')[1])).size,3);
 const used=[...f.saved.values()].reduce((n,s)=>n+Buffer.byteLength(s),0);assert.equal((await f.store.getTenant('github-1')).used_bytes,used);
 assert.equal([...f.memory.items.values()].filter(r=>r.sk==='META'&&r.tenant_id).length,3);
 assert.equal((await f.api('github-2','billing/status',undefined,scope)).status,403);
});
test('API usage identifies shared workspace quota and retains pending reservations across every environment',async()=>{
 const f=await fixture();await f.join();const scope={workspace:'github-1'};
 assert.equal((await f.api('github-2','environments',{id:'dev',name:'Development'},scope)).status,201);
 const key=await f.key('github-2','dev'),before=await f.store.getTenant('github-1'),put=f.env.objects.putImmutable;
 f.env.objects.putImmutable=async()=>{throw Error('synthetic object write unavailable');};
 const pending=f.batch('pending content'),raw=JSON.stringify(pending);
 assert.equal((await f.upload(key,'dev',pending)).status,503);f.env.objects.putImmutable=put;
 const expected=before.used_bytes+Buffer.byteLength(raw);
 for(const environment of ['default','dev']){
  const response=await f.api('github-2','usage',undefined,{...scope,environment});assert.equal(response.status,200);
  const body=await response.json();assert.deepEqual(body.quota_scope,{workspace_id:'github-1',project_id:alphaProject('github-1').id,environment_id:environment,shared_across_environments:true});
  assert.equal(body.storage.used_bytes,expected);assert.equal(body.storage.remaining_bytes,body.plan_limits.stored_bytes-expected);assert.equal(body.plan_limits.plan_id,'free');assert.equal(body.monthly.spans_used>0,true);
  assert.equal(body.storage.accounting,'cumulative_reserved_bytes');assert.equal(body.billing.paid_access,false);
 }
 assert.equal((await f.api('github-3','usage',undefined,scope)).status,403);
 assert.equal((await f.upload(key,'dev',pending)).status,201);
 assert.equal((await f.store.getTenant('github-1')).used_bytes,expected,'accepting the reserved batch does not reserve again or free capacity');
 assert.equal((await f.upload(key,'dev',pending)).status,201);
 assert.equal((await f.store.getTenant('github-1')).used_bytes,expected,'accepted idempotent retry leaves quota unchanged');
 assert.equal((await f.api('github-1','keys/revoke',{id:digest(key)},{environment:'dev'})).status,200);
 assert.equal((await f.store.getTenant('github-1')).used_bytes,expected,'revocation stops access but does not reclaim reserved bytes');
});
test('role demotion and removal stop existing team keys and access; owner is immutable',async()=>{
 const f=await fixture(PAID);await f.join();const token=await f.key('github-2');assert.equal((await f.upload(token)).status,201);
 let members=await(await f.api('github-1','workspaces/members')).json();let m=members.members.find(r=>r.user_id==='github-2');
 assert.equal((await f.api('github-1','workspaces/member',{user_id:m.user_id,role:'viewer',version:m.version})).status,200);
 assert.equal((await f.upload(token)).status,401);
 assert.equal((await f.api('github-2','environments',{id:'dev',name:'Dev'},{workspace:'github-1'})).status,403);
 assert.equal((await f.api('github-1','workspaces/member',{user_id:'github-1',role:'removed',version:0})).status,403);
 members=await(await f.api('github-1','workspaces/members')).json();m=members.members.find(r=>r.user_id==='github-2');
 assert.equal((await f.api('github-1','workspaces/member',{user_id:m.user_id,role:'removed',version:m.version})).status,200);
 assert.equal((await f.api('github-2','runs',undefined,{workspace:'github-1'})).status,403);
 assert.equal((await(await f.api('github-2','projects')).json()).projects.length,1);
});
test('membership revocation racing key approval cannot mint access',async()=>{
 const f=await fixture();await f.join();const tx=f.store._tx.bind(f.store);let revoke=true;
 f.store._tx=async items=>{if(revoke&&items.some(i=>i.Put?.Item.scope==='write')){revoke=false;const m=(await(await f.api('github-1','workspaces/members')).json()).members.find(r=>r.user_id==='github-2');await f.api('github-1','workspaces/member',{user_id:m.user_id,role:'removed',version:m.version});}return tx(items);};
 await assert.rejects(f.key('github-2'));assert.equal([...f.memory.items.values()].some(r=>r.scope==='write'),false);
});


test('old admin keys never resurrect after removal/rejoin or demotion/promotion',async()=>{
 const f=await fixture(PAID);await f.join();const token=await f.key('github-2');
 async function change(role){const m=(await(await f.api('github-1','workspaces/members')).json()).members.find(r=>r.user_id==='github-2');assert.equal((await f.api('github-1','workspaces/member',{user_id:m.user_id,version:m.version,role})).status,200);}
 await change('removed');assert.equal((await f.upload(token)).status,401);await f.join();assert.equal((await f.upload(token)).status,401);
 const fresh=await f.key('github-2');assert.equal((await f.upload(fresh)).status,201);await change('viewer');await change('admin');assert.equal((await f.upload(fresh)).status,401);
});


test('integrated hosted job controls remain Default-owned and cannot inherit team/environment authority',async()=>{
 const f=await fixture();await f.join();f.env.importJobControl={enabled:true,mode:'control-only'};
 assert.equal((await f.api('github-1','imports/jobs',{})).status,400);
 assert.equal((await f.api('github-2','imports/jobs',{},{workspace:'github-1'})).status,403);
 assert.equal((await f.api('github-1','environments',{id:'dev',name:'Development'})).status,201);
 assert.equal((await f.api('github-1','imports/jobs',{},{environment:'dev'})).status,403);
 assert.equal([...f.memory.items.values()].some(r=>r.sk.startsWith('IMPORTJOB#')),false);
});

test('workspace fixture preserves all three account sessions through a forced occupied-slot collision',async()=>{
 const f=await withSessionTokens([first,collisions[0],free[0],free[1]],()=>fixture());
 for(const actor of ['github-1','github-2','github-3']){const response=await f.api(actor,'me');assert.equal(response.status,200);assert.equal((await response.json()).tenant_id,actor);}
});

// Session issuance uses a wall clock; fixture storage may intentionally freeze time.
test('fixture session expiry follows the frozen store clock across a wall-clock tick',async()=>{
 const time=Math.floor(Date.now()/1000)-2;
 const memory=new MemoryDynamo(),store=new DynamoMetadataStore({client:memory,commands:commandClasses(),tableName:'synthetic',now:()=>time});
 const tenant=await store.getOrCreateTenant(1);
 const token=await createFixtureSession(store,tenant.tenant_id);
 const row=await store.getSession(digest(token));
 assert.equal(row.tenant_id,tenant.tenant_id);
 assert.equal(row.expires_at,time+86400);
});
test('pending invitations are listed only to the addressed account and accepted without the link',async()=>{
 const f=await fixture(PAID);await f.shared();
 const listed=async actor=>{const r=await f.api(actor,'workspaces/invitations');assert.equal(r.status,200);return r.json();};
 assert.deepEqual(await listed('github-2'),{invitations:[],truncated:false});
 const inv=await(await f.api('github-1','workspaces/invite',{recipient_id:'github-2',role:'viewer'})).json();
 const mine=await listed('github-2');
 assert.deepEqual(mine,{invitations:[{workspace_id:'github-1',workspace_name:'Synthetic team',role:'viewer',expires_at:inv.expires_at}],truncated:false});
 assert.doesNotMatch(JSON.stringify(mine),/token/);assert.ok(!JSON.stringify(mine).includes(inv.token));
 // Neither the owner nor an uninvolved account sees another account's invitation, with or without a workspace hint.
 for(const actor of ['github-1','github-3'])assert.deepEqual((await listed(actor)).invitations,[]);
 assert.deepEqual((await(await f.api('github-3','workspaces/invitations',undefined,{workspace:'github-1'})).json()).invitations,[]);
 // Only the addressed account can use the link-free accept; the request shape stays exact.
 assert.equal((await f.api('github-3','workspaces/accept',{workspace_id:'github-1'})).status,409);
 assert.equal((await f.api('github-2','workspaces/accept',{workspace_id:'github-1',token:null})).status,400);
 assert.equal((await f.api('github-2','workspaces/accept',{workspace_id:'github-1',extra:1})).status,400);
 assert.equal((await f.api('github-2','workspaces/accept',{workspace_id:'github-3'})).status,409);
 const accepted=await f.api('github-2','workspaces/accept',{workspace_id:'github-1'});assert.equal(accepted.status,200);
 assert.deepEqual(await accepted.json(),{accepted:true,workspace_id:'github-1',role:'viewer'});
 assert.deepEqual((await listed('github-2')).invitations,[]);
 assert.equal(f.memory._get({pk:'TENANT#github-2',sk:'WORKSPACE#INVITED#github-1'}),null);
 // Single use: neither path can replay it.
 assert.equal((await f.api('github-2','workspaces/accept',{workspace_id:'github-1'})).status,409);
 assert.equal((await f.api('github-2','workspaces/accept',{workspace_id:'github-1',token:inv.token})).status,409);
 assert.equal((await(await f.api('github-2','projects')).json()).projects[1].role,'viewer');
});
test('expired, used, unshared and forged pending invitations are never listed or accepted',async()=>{
 const f=await fixture();await f.shared();const now=f.store.now();
 const listed=async actor=>(await(await f.api(actor,'workspaces/invitations')).json()).invitations;
 await f.api('github-1','workspaces/invite',{recipient_id:'github-2',role:'admin'});assert.equal((await listed('github-2')).length,1);
 // A pointer forged under another account does not expose or grant the invitation.
 f.memory.items.set('TENANT#github-3\0WORKSPACE#INVITED#github-1',{pk:'TENANT#github-3',sk:'WORKSPACE#INVITED#github-1',owner:'github-1',expires_at:now+86400});
 f.memory.items.set('TENANT#github-3\0WORKSPACE#INVITED#github-2',{pk:'TENANT#github-3',sk:'WORKSPACE#INVITED#github-2',owner:'github-1',expires_at:now+86400});
 f.memory.items.set('TENANT#github-3\0WORKSPACE#INVITED#bad',{pk:'TENANT#github-3',sk:'WORKSPACE#INVITED#bad',owner:'not a tenant',expires_at:now+86400});
 assert.deepEqual(await listed('github-3'),[]);assert.equal((await f.api('github-3','workspaces/accept',{workspace_id:'github-1'})).status,409);
 // Expiry, use and the workspace's existence are judged on the inviting workspace's rows at read and accept time.
 const row=f.memory._get({pk:'TENANT#github-1',sk:'INVITE#github-2'}),live={...row},put=change=>f.memory.items.set('TENANT#github-1\0INVITE#github-2',{...live,...change});
 const refused=async()=>{assert.deepEqual(await listed('github-2'),[]);assert.equal((await f.api('github-2','workspaces/accept',{workspace_id:'github-1'})).status,409);};
 put({expires_at:now-1});await refused();
 put({used:true});await refused();
 put({recipient_id:'github-3'});await refused();
 put({role:'owner'});await refused();
 put({});assert.equal((await listed('github-2')).length,1);
 const meta=f.memory._get({pk:'TENANT#github-1',sk:'WORKSPACE#META'});f.memory.items.delete('TENANT#github-1\0WORKSPACE#META');
 assert.deepEqual(await listed('github-2'),[]);assert.notEqual((await f.api('github-2','workspaces/accept',{workspace_id:'github-1'})).status,200);
 f.memory.items.set('TENANT#github-1\0WORKSPACE#META',meta);
 assert.equal((await f.api('github-2','workspaces/accept',{workspace_id:'github-1'})).status,200);
});
test('a link-accepted invitation leaves no pending entry and re-invitation after removal is listed afresh',async()=>{
 const f=await fixture(PAID);const inv=await f.join('github-2','admin');assert.ok(inv.token);
 const listed=async actor=>(await(await f.api(actor,'workspaces/invitations')).json()).invitations;
 assert.deepEqual(await listed('github-2'),[]);
 assert.equal((await f.api('github-1','workspaces/member',{user_id:'github-2',role:'removed',version:0},{workspace:'github-1'})).status,200);
 assert.equal((await f.api('github-1','workspaces/invite',{recipient_id:'github-2',role:'viewer'},{workspace:'github-1'})).status,201);
 assert.deepEqual((await listed('github-2')).map(i=>[i.workspace_id,i.role]),[['github-1','viewer']]);
 assert.equal((await f.api('github-2','workspaces/accept',{workspace_id:'github-1'})).status,200);
 assert.equal((await(await f.api('github-2','projects')).json()).projects[1].role,'viewer');
});
test('expired pointers do not hide a live pending invitation, and the bounded scan reports truncation',async()=>{
 const f=await fixture();await f.shared();const now=f.store.now(),listed=async()=>(await f.api('github-2','workspaces/invitations')).json();
 const pointer=(n,expires)=>f.memory.items.set('TENANT#github-2\0WORKSPACE#INVITED#github-'+n,{pk:'TENANT#github-2',sk:'WORKSPACE#INVITED#github-'+n,owner:'github-'+n,expires_at:expires});
 // 250 expired pointers sort around and after the live one (github-1) across three index pages.
 for(let n=10;n<260;n++)pointer(n,now-1);
 assert.equal((await f.api('github-1','workspaces/invite',{recipient_id:'github-2',role:'admin'})).status,201);
 f.memory.items.delete('TENANT#github-2\0WORKSPACE#INVITED#github-1');pointer(999,now-1);
 f.memory.items.set('TENANT#github-2\0WORKSPACE#INVITED#github-1',{pk:'TENANT#github-2',sk:'WORKSPACE#INVITED#github-1',owner:'github-1',expires_at:now+86400});
 let gets=0;const get=f.store._get.bind(f.store);f.store._get=k=>{if(k.sk==='INVITE#github-2')gets++;return get(k);};
 const found=await listed();assert.deepEqual(found.invitations.map(i=>i.workspace_id),['github-1']);assert.equal(found.truncated,false);
 assert.equal(gets,1,'expired pointers are skipped without an authoritative read');
 // Unexpired pointers with no matching invitation cost a re-read each; the scan stops at its bound and says so.
 for(let n=1000;n<1100;n++)pointer(n,now+86400);gets=0;
 const bounded=await listed();assert.equal(bounded.truncated,true);assert.ok(gets<=60);assert.deepEqual(bounded.invitations.map(i=>i.workspace_id),['github-1']);
});

test('active members cannot receive dormant invitations; removal cancels legacy invitations atomically',async()=>{
 const f=await fixture(PAID);const initial=await f.join();
 assert.equal((await f.api('github-1','workspaces/invite',{recipient_id:'github-2',role:'admin'})).status,409);
 // Simulate an unused invitation created by the old production behavior while membership was active.
 const inviteKey={pk:'TENANT#github-1',sk:'INVITE#github-2'},pointerKey={pk:'TENANT#github-2',sk:'WORKSPACE#INVITED#github-1'};
 const old=f.memory._get(inviteKey);
 f.memory.items.set(inviteKey.pk+'\0'+inviteKey.sk,{...old,used:false});
 f.memory.items.set(pointerKey.pk+'\0'+pointerKey.sk,{...pointerKey,owner:'github-1',expires_at:f.store.now()+86400});
 assert.equal((await f.api('github-1','workspaces/member',{user_id:'github-2',role:'removed',version:0})).status,200);
 assert.equal(f.memory._get(inviteKey),null);assert.equal(f.memory._get(pointerKey),null);
 assert.equal((await f.api('github-2','workspaces/accept',{workspace_id:'github-1',token:initial.token})).status,409);
 assert.equal((await f.api('github-2','workspaces/accept',{workspace_id:'github-1'})).status,409);
 assert.equal((await f.api('github-2','runs',undefined,{workspace:'github-1'})).status,403);
 // A new, explicit owner invitation after removal still works.
 assert.equal((await f.api('github-1','workspaces/invite',{recipient_id:'github-2',role:'viewer'})).status,201);
 assert.equal((await f.api('github-2','workspaces/accept',{workspace_id:'github-1'})).status,200);
});

test('invitation read before membership changes cannot commit against a new inactive version',async()=>{
 const f=await fixture();await f.join();
 assert.equal((await f.api('github-1','workspaces/member',{user_id:'github-2',role:'removed',version:0})).status,200);
 const tx=f.store._tx.bind(f.store);let raced=false;
 f.store._tx=async items=>{
  if(!raced&&items.some(i=>i.Put?.Item.sk==='INVITE#github-2')){
   raced=true;
   const k='TENANT#github-1\0MEMBER#github-2',member=f.memory.items.get(k);
   // Model a complete intervening rejoin/removal: inactive again, but a new membership version.
   f.memory.items.set(k,{...member,version:member.version+2});
  }
  return tx(items);
 };
 assert.equal((await f.api('github-1','workspaces/invite',{recipient_id:'github-2',role:'admin'})).status,409);
 assert.equal(raced,true);
 assert.equal(f.memory._get({pk:'TENANT#github-1',sk:'INVITE#github-2'}),null);
});

test('removal transaction failure preserves both membership and pending invitation',async()=>{
 const f=await fixture();await f.join();
 const k='TENANT#github-1\0INVITE#github-2',old=f.memory.items.get(k);f.memory.items.set(k,{...old,used:false});
 const tx=f.store._tx.bind(f.store);let checked=false;
 f.store._tx=async items=>{
  if(items.some(i=>i.Put?.Item.sk==='MEMBER#github-2'&&i.Put.Item.active===false)){
   checked=true;
   assert.ok(items.some(i=>i.Delete?.Key.sk==='INVITE#github-2'));
   assert.ok(items.some(i=>i.Delete?.Key.sk==='WORKSPACE#INVITED#github-1'));
   const member=items.find(i=>i.Put?.Item.sk==='MEMBER#github-2');
   member.Put.ExpressionAttributeValues[':v']=999;
  }
  return tx(items);
 };
 assert.equal((await f.api('github-1','workspaces/member',{user_id:'github-2',role:'removed',version:0})).status,409);
 assert.equal(checked,true);
 assert.equal(f.memory._get({pk:'TENANT#github-1',sk:'MEMBER#github-2'}).active,true);
 assert.equal(f.memory._get({pk:'TENANT#github-1',sk:'INVITE#github-2'}).used,false);
});

test('pre-deployment removed memberships cannot use legacy or earlier-version invitations',async()=>{
 const f=await fixture(PAID);const initial=await f.join();
 const inviteKey={pk:'TENANT#github-1',sk:'INVITE#github-2'},memberKey={pk:'TENANT#github-1',sk:'MEMBER#github-2'};
 const original=f.memory._get(inviteKey),member=f.memory._get(memberKey);
 // State left by the old release: membership removed, invitation still unused and unexpired.
 f.memory.items.set(memberKey.pk+'\0'+memberKey.sk,{...member,active:false,version:member.version+1});
 const legacy={...original,used:false};delete legacy.membership_version;
 const pointerKey={pk:'TENANT#github-2',sk:'WORKSPACE#INVITED#github-1'};
 f.memory.items.set(pointerKey.pk+'\0'+pointerKey.sk,{...pointerKey,owner:'github-1',expires_at:f.store.now()+86400});
 for(const invitation of [legacy,{...legacy,membership_version:member.version}]){
  f.memory.items.set(inviteKey.pk+'\0'+inviteKey.sk,invitation);
  assert.deepEqual((await(await f.api('github-2','workspaces/invitations')).json()).invitations,[]);
  assert.equal((await f.api('github-2','workspaces/accept',{workspace_id:'github-1',token:initial.token})).status,409);
  assert.equal((await f.api('github-2','workspaces/accept',{workspace_id:'github-1'})).status,409);
  assert.equal((await f.api('github-2','runs',undefined,{workspace:'github-1'})).status,403);
 }
 // The owner can explicitly replace that obsolete invitation without waiting for its expiry.
 assert.equal((await f.api('github-1','workspaces/invite',{recipient_id:'github-2',role:'viewer'})).status,201);
 assert.equal(f.memory._get(inviteKey).membership_version,member.version+1);
 assert.equal((await f.api('github-2','workspaces/accept',{workspace_id:'github-1'})).status,200);
});
test('on Free the same routes refuse what the plan does not include: non-admin roles, a third seat, a third environment',async()=>{
 const f=await fixture(),limits=planLimits('free');await f.shared();assert.deepEqual([limits.seats,limits.environments],[2,2]);
 const refused=async(response,expected)=>{assert.equal(response.status,402);const body=await response.json();assert.deepEqual(Object.fromEntries(Object.keys(expected).map(k=>[k,body[k]])),expected);assert.equal(body.upgrade_url,'/app/#billing');};
 for(const role of ['viewer','developer'])await refused(await f.api('github-1','workspaces/invite',{recipient_id:'github-2',role}),{error:'plan_upgrade_required',feature:'rbac_roles',plan:'free',required_plan:'pro'});
 assert.deepEqual((await(await f.api('github-2','workspaces/invitations')).json()).invitations,[]);
 // An admin fills the second seat; the third member and a demotion to a paid role are refused.
 await f.join('github-2','admin');
 await refused(await f.api('github-1','workspaces/invite',{recipient_id:'github-3',role:'admin'}),{error:'plan_limit_reached',limit_name:'seats',plan:'free',limit:limits.seats,used:limits.seats});
 const m=(await(await f.api('github-1','workspaces/members')).json()).members.find(r=>r.user_id==='github-2');
 await refused(await f.api('github-1','workspaces/member',{user_id:m.user_id,role:'viewer',version:m.version}),{error:'plan_upgrade_required',feature:'rbac_roles',plan:'free'});
 assert.equal((await f.api('github-2','keys',undefined,{workspace:'github-1'})).status,200,'still an admin');
 // Default plus one more environment is the Free allowance.
 assert.equal((await f.api('github-1','environments',{id:'dev',name:'Development'})).status,201);
 await refused(await f.api('github-1','environments',{id:'prod',name:'Production'}),{error:'plan_limit_reached',limit_name:'environments',plan:'free',limit:limits.environments,used:limits.environments});
 // The same account on Pro is allowed all three.
 const p=await fixture(PAID);await p.shared();assert.equal((await p.api('github-1','workspaces/invite',{recipient_id:'github-2',role:'viewer'})).status,201);
 for(const id of ['dev','prod'])assert.equal((await p.api('github-1','environments',{id,name:id})).status,201);
});
