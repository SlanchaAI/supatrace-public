import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {handle} from '../src/aws-api.mjs';
import {DynamoMetadataStore,digest} from '../src/dynamodb-store.mjs';
import {MemoryDynamo,commandClasses} from './memory-dynamo.mjs';
import {createFixtureSession} from './fixture-session.mjs';
import {alphaProject} from '../src/alpha-projects.mjs';
import {eraseAccounts,erasureItem} from '../src/account-deletion.mjs';
import {stampPlan} from './harness.mjs';
const origin='https://supatrace.dev',owner='github-1';
async function fixture(plan='base'){
 // Fixed clock and key identities keep bounded-rate-slot collisions out of unrelated isolation checks.
 let now=Date.parse('2026-11-15T20:00:00Z')/1000,minted=0;
 const store=new DynamoMetadataStore({client:new MemoryDynamo(),commands:commandClasses(),tableName:'synthetic',now:()=>now}),saved=new Map();stampPlan(store,plan);
 await store.getOrCreateTenant(1);const token=await createFixtureSession(store,owner);
 const env={ENABLED:true,APP_ORIGIN:origin,GITHUB_CLIENT_ID:'test',GITHUB_CLIENT_SECRET:'test',store,objects:{putImmutable:async(k,v)=>saved.set(k,v),get:async k=>saved.get(k)}};
 const api=(path,body,scope={})=>{const url=new URL('/api/'+path,origin);for(const [k,v] of Object.entries(scope))url.searchParams.set(k,v);return handle(new Request(url,{method:body===undefined?'GET':'POST',headers:{cookie:'__Host-supatrace='+token,origin,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);};
 const create=async name=>{const r=await api('projects',{name});assert.equal(r.status,201,await r.clone().text());return (await r.json()).id;};
 const key=async scope=>{const key='st_sec_'+createHash('sha256').update('synthetic-project-key-'+(++minted)).digest('base64url'),r=await api('keys/create',{key_hash:digest(key),key_type:'secret',expires_in:86400},scope);assert.equal(r.status,201,await r.clone().text());return key;};
 const upload=(key,scope={},label='trace')=>{const url=new URL('/api/batches',origin);for(const [k,v] of Object.entries(scope))url.searchParams.set(k,v);const raw=JSON.stringify({version:1,batch_id:'identical-batch',run_id:'identical-run',events:[{id:'event',time:'2026-11-15T00:00:00Z',kind:'note',name:'Synthetic trace',data:{label}}]});return handle(new Request(url,{method:'POST',headers:{'content-type':'application/json','x-supatrace-key':key,'x-amz-content-sha256':digest(raw)},body:raw}),env);};
 return {store,saved,env,api,create,key,upload,advance:n=>{now+=n;}};
}
test('multiple projects share an organization and enforced limits, including concurrent admission and downgrade',async()=>{
 const f=await fixture(),ids=await Promise.all([f.create('Staging'),f.create('Production')]);assert.equal(new Set(ids).size,2);
 const projects=(await(await f.api('projects')).json()).projects;assert.equal(projects.length,3);assert.ok(projects.every(p=>p.workspace_id===owner));
 assert.equal((await(await f.api('workspaces')).json()).workspaces.length,1);assert.equal((await f.api('projects',{name:'Fourth'})).status,402);
 assert.deepEqual((await(await f.api('usage')).json()).projects,{used:3,limit:3});
 assert.equal((await f.api('projects/rename',{id:ids[0],name:'Stage renamed'})).status,200);
 assert.equal((await f.api('projects/rename',{id:alphaProject(owner).id,name:'Primary'})).status,200);
 assert.equal((await f.api('projects/rename',{id:alphaProject('github-2').id,name:'Foreign'})).status,403);
 const meta=await f.store.getTenant(owner);await f.store._send('PutCommand',{Item:{...meta,plan_id:'free'}});
 assert.equal((await f.api('runs',undefined,{project:ids[0]})).status,200);assert.equal((await f.api('projects',{name:'Downgraded'})).status,402);
 const race=await fixture();await race.create('Second');const replies=await Promise.all([race.api('projects',{name:'Last A'}),race.api('projects',{name:'Last B'})]);assert.deepEqual(replies.map(r=>r.status).sort(),[201,409]);
});
test('identical trace IDs, environments, keys, cursors and ingest logs isolate per project while quota stays shared',async()=>{
 const f=await fixture('pro'),ids=[alphaProject(owner).id,await f.create('Staging')],keys=[];
 for(const [i,project] of ids.entries()){
  assert.equal((await f.api('environments',{id:'dev',name:'Dev '+i},{project})).status,201);
  const scope={project,environment:'dev'},key=await f.key(scope);keys.push(key);
  assert.equal((await f.upload(key,scope,'project-'+i)).status,201);
  assert.equal((await f.upload(key,{},'project-'+i)).status,403,'bound environment cannot silently fall back');
  const page=await(await f.api('runs/page',undefined,scope)).json();assert.equal(page.runs.length,1);
  const events=await(await f.api('events?run=identical-run',undefined,scope)).json();assert.equal(events.events[0].data.label,'project-'+i);
  const rows=(await(await f.api('keys',undefined,scope)).json()).keys;assert.equal(rows.length,1);assert.equal(rows[0].project_id,project);
  const logs=await(await f.api('logs?stream=accepted',undefined,scope)).json();assert.equal(logs.attempts.length,1);
 }
 assert.equal((await f.upload(keys[1],{project:ids[0],environment:'dev'})).status,403);
 assert.equal((await f.api('keys/revoke',{id:digest(keys[1])},{project:ids[0],environment:'dev'})).status,403);
 assert.equal(f.saved.size,2);assert.equal(new Set([...f.saved.keys()].map(k=>k.split('/')[1])).size,2);
 assert.equal((await f.store.getTenant(owner)).used_bytes,[...f.saved.values()].reduce((n,s)=>n+Buffer.byteLength(s),0));
 assert.equal((await(await f.api('projects')).json()).projects.length,2,'project listing excludes nested data rows');
 const job=(await erasureItem(f.store,owner)).Put.Item;assert.equal(job.prefixes.length,4);
 for(const project of ids)assert.ok(job.prefixes.includes('v1/'+createHash('sha256').update(owner+(project===ids[0]?'':':project:'+project)+':environment:dev').digest('hex')+'/'));
});

test('additional-project Default keys infer their binding, rotate inside it and reject foreign setup approval',async()=>{
 const f=await fixture('pro'),project=await f.create('SDK'),scope={project},key=await f.key(scope);
 assert.equal((await f.upload(key)).status,201,'SDK may rely on its bound project');
 assert.equal((await(await f.api('runs/page',undefined,scope)).json()).runs.length,1);
 assert.equal((await(await f.api('runs/page')).json()).runs.length,0);
 const next='st_sec_'+randomBytes(32).toString('base64url');
 assert.equal((await f.api('keys/rotate',{id:digest(key),key_hash:digest(next)},{})).status,403);
 const rotated=await f.api('keys/rotate',{id:digest(key),key_hash:digest(next)},scope);
 assert.equal(rotated.status,201,await rotated.clone().text());
 assert.equal((await f.upload(next)).status,201);
 const started=await f.api('setup/start',{key_hash:digest(randomBytes(32).toString('base64url')),project_id:project},scope);
 assert.equal(started.status,201,await started.clone().text());const setup=await started.json();
 assert.equal((await f.api('setup/approve',{user_code:setup.user_code})).status,403);
 assert.equal((await f.api('setup/approve',{user_code:setup.user_code},scope)).status,200);
});


test('management secret-key reads infer their own project and reject an explicit foreign project',async()=>{
 const f=await fixture('pro'),ids=[alphaProject(owner).id,await f.create('SDK reads')],keys=[];
 for(const [i,project] of ids.entries()){const key=await f.key({project});keys.push(key);assert.equal((await f.upload(key,{},'project-'+i)).status,201);}
 for(const [i,key] of keys.entries())for(const headers of [{authorization:'Bearer '+key},{'x-supatrace-key':key}]){
  const read=path=>handle(new Request(origin+'/api/v1/'+path,{headers}),f.env);
  const runs=await read('traces');assert.equal(runs.status,200);assert.equal((await runs.json()).runs.length,1);
  const events=await read('traces/identical-run/events');assert.equal(events.status,200);assert.equal((await events.json()).events[0].data.label,'project-'+i);
  assert.equal((await read('traces?project='+ids[i])).status,200);
  assert.equal((await read('traces?project='+ids[1-i])).status,403);
  assert.equal((await read('traces/identical-run/events?project='+ids[1-i])).status,403);
 }
});

function versioned(f){
 class ListObjectVersionsCommand{constructor(input){this.input=input;}}
 class DeleteObjectCommand{constructor(input){this.input=input;}}
 const markers=new Set();let failDelete=false;
 Object.assign(f.env.objects,{bucket:'synthetic',commands:{ListObjectVersionsCommand,DeleteObjectCommand},client:{send:async cmd=>{
  if(cmd instanceof ListObjectVersionsCommand)return {Versions:[...f.saved.keys()].filter(Key=>Key.startsWith(cmd.input.Prefix)).map(Key=>({Key,VersionId:'v1'})),DeleteMarkers:[...markers].filter(Key=>Key.startsWith(cmd.input.Prefix)).map(Key=>({Key,VersionId:'marker'}))};
  if(failDelete)throw Error('synthetic_object_outage');
  if(cmd.input.VersionId==='marker')markers.delete(cmd.input.Key);else f.saved.delete(cmd.input.Key);return {};
 }}});return {markers,fail:value=>{failDelete=value;}};
}
test('project DELETE gates, retires every environment and physically erases only that project through the live worker caller',async()=>{
 const f=await fixture('pro'),v=versioned(f),project=await f.create('Remove me'),sibling=await f.create('Keep me');
 for(const id of [project,sibling])for(const environment of ['default','dev']){
  if(environment!=='default')assert.equal((await f.api('environments',{id:environment,name:environment},{project:id})).status,201);
  const scope={project:id,environment},key=await f.key(scope);assert.equal((await f.upload(key,scope,id)).status,201);
 }
 const before=(await f.store.getTenant(owner)).used_bytes,usage=await f.store._get({pk:'TENANT#'+owner,sk:'USAGE#'+new Date(f.store.now()*1000).toISOString().slice(0,7)});
 const erased=[...f.saved.keys()].filter(k=>k.includes(createHash('sha256').update(owner+':project:'+project).digest('hex'))||k.includes(createHash('sha256').update(owner+':project:'+project+':environment:dev').digest('hex')));
 v.markers.add(erased[0]);const released=erased.reduce((n,k)=>n+Buffer.byteLength(f.saved.get(k)),0);
 assert.equal((await f.api('projects/delete',{id:alphaProject(owner).id,confirm:alphaProject(owner).id})).status,400);
 assert.equal((await f.api('projects/delete',{id:project,confirm:'wrong'})).status,400);
 assert.equal((await f.api('projects/delete',{id:project,confirm:project})).status,202);
 assert.equal((await f.api('runs',undefined,{project})).status,403);
 assert.equal((await(await f.api('projects')).json()).projects.length,2);
 assert.equal((await f.api('projects/delete',{id:project,confirm:project})).status,202,'idempotent confirmation');
 assert.equal((await f.store._get({pk:'TENANT#'+owner,sk:'PROJECT_CAPACITY'})).count,1);
 const accountJob=(await erasureItem(f.store,owner)).Put.Item;assert.ok(accountJob.prefixes.some(p=>erased[0].startsWith(p)),'parent closure inventories retired projects');
 assert.equal((await eraseAccounts(f.env)).processed,0);f.advance(601);
 assert.equal((await eraseAccounts(f.env)).phase,'complete');assert.equal(f.saved.size,2);assert.equal(v.markers.size,0);
 assert.equal((await f.store.getTenant(owner)).used_bytes,before-released);assert.equal((await f.store._get({pk:'SYS',sk:'CAPACITY'})).used_bytes,before-released);
 assert.deepEqual(await f.store._get({pk:usage.pk,sk:usage.sk}),usage,'paid usage history survives storage deletion');
 assert.equal((await f.store._get({pk:'TENANT#'+owner,sk:'PROJECT_RETIRED#'+project})).erased_at,f.store.now());
 assert.equal((await(await f.api('runs/page',undefined,{project:sibling,environment:'dev'})).json()).runs.length,1);
 assert.equal((await eraseAccounts(f.env)).processed,0);assert.equal((await f.store.getTenant(owner)).used_bytes,before-released);
 const keys=await f.store._page('TENANT#'+owner,'KEY#',{limit:100});assert.ok(keys.items.every(k=>k.project_id===sibling));
});
test('environment erasure retries storage outage, releases exactly once, preserves sibling environments and retired IDs',async()=>{
 const f=await fixture('pro'),v=versioned(f),project=await f.create('Project');
 for(const environment of ['dev','stage']){await f.api('environments',{id:environment,name:environment},{project});const key=await f.key({project,environment});assert.equal((await f.upload(key,{project,environment})).status,201);}
 const before=(await f.store.getTenant(owner)).used_bytes;
 assert.equal((await f.api('environments/delete',{id:'dev',confirm:'dev'},{project})).status,200);f.advance(601);v.fail(true);
 await assert.rejects(eraseAccounts(f.env),/synthetic_object_outage/);assert.equal((await f.store.getTenant(owner)).used_bytes,before);
 assert.equal((await eraseAccounts(f.env)).processed,0);v.fail(false);f.advance(601);
 assert.equal((await eraseAccounts(f.env)).phase,'complete');assert.equal(f.saved.size,1);assert.ok((await f.store.getTenant(owner)).used_bytes<before);
 assert.equal((await f.api('environments',{id:'dev',name:'Reuse'},{project})).status,409);
 assert.equal((await(await f.api('runs/page',undefined,{project,environment:'stage'})).json()).runs.length,1);
 assert.equal((await f.store._page('ERASURE#SCOPES','',{limit:100})).items.length,0);
});

test('project erasure absorbs pending environment jobs before removing their retirement tombstones',async()=>{
 const f=await fixture('pro');versioned(f);const project=await f.create('Remove after environment'),sibling=await f.create('Keep');
 for(const id of [project,sibling]){
  assert.equal((await f.api('environments',{id:'dev',name:'Dev'},{project:id})).status,201);
  const scope={project:id,environment:'dev'},key=await f.key(scope);assert.equal((await f.upload(key,scope)).status,201);
 }
 assert.equal((await f.api('environments/delete',{id:'dev',confirm:'dev'},{project})).status,200);
 assert.equal((await f.api('projects/delete',{id:project,confirm:project})).status,202);
 f.advance(601);assert.equal((await eraseAccounts(f.env)).phase,'complete');
 assert.equal((await f.store._page('ERASURE#SCOPES','',{limit:100})).items.length,0);
 assert.equal((await eraseAccounts(f.env)).processed,0);assert.equal(f.saved.size,1);
 assert.equal((await(await f.api('runs/page',undefined,{project:sibling,environment:'dev'})).json()).runs.length,1);
});


test('retrying a legacy retired environment queues physical cleanup without replaying a completed deletion',async()=>{
 const f=await fixture('pro');versioned(f);
 assert.equal((await f.api('environments',{id:'legacy',name:'Legacy'})).status,201);
 const key=await f.key({environment:'legacy'});assert.equal((await f.upload(key,{environment:'legacy'})).status,201);
 assert.equal((await f.api('environments/delete',{id:'legacy',confirm:'legacy'})).status,200);
 const job={pk:'ERASURE#SCOPES',sk:[owner,alphaProject(owner).id,'legacy'].join('#')};
 await f.store._send('DeleteCommand',{Key:job});
 assert.equal((await f.api('environments/delete',{id:'legacy',confirm:'legacy'})).status,200);
 assert.ok(await f.store._get(job));f.advance(601);assert.equal((await eraseAccounts(f.env)).phase,'complete');assert.equal(f.saved.size,0);
 assert.equal((await f.api('environments/delete',{id:'legacy',confirm:'legacy'})).status,200);
 assert.equal(await f.store._get(job),null,'completed deletion never requeues');
});


test('Free organization can create a second project; its third is refused with HTTP 402 plan_limit_reached',async()=>{
 const f=await fixture('free');
 const created=await f.api('orgs',{name:'Free acceptance'});assert.equal(created.status,201,await created.clone().text());
 const org=await created.json(),scope={workspace:org.id};
 const second=await f.api('projects',{name:'Second'},scope);assert.equal(second.status,201,await second.clone().text());
 const third=await f.api('projects',{name:'Third'},scope);assert.equal(third.status,402);
 const body=await third.json();assert.equal(body.error,'plan_limit_reached');assert.equal(body.limit_name,'projects');assert.equal(body.limit,2);assert.equal(body.used,2);
 assert.equal((await(await f.api('projects',undefined,scope)).json()).projects.filter(p=>p.workspace_id===org.id).length,2);
});
