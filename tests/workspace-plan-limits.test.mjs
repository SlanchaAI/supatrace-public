import test from 'node:test';
import assert from 'node:assert/strict';
import {start} from './harness.mjs';
const account=async(live,id)=>{let cookie;const tenant=await live.signIn({addCookies:async c=>{cookie=c.map(x=>x.name+'='+x.value).join('; ');}},id);return {tenant,cookie};};
const request=async(live,who,path,data)=>{const r=await fetch(live.origin+'/api/'+path,{method:data?'POST':'GET',headers:{cookie:who.cookie,origin:live.origin,'content-type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});return {status:r.status,body:await r.json()};};
const row=(live,tenant)=>live.store.client.items.get('TENANT#'+tenant+'\0META');
const create=(live,who)=>request(live,who,'orgs',{name:'Plan workspace'});

test('Free creation cap, owned paid-workspace allowance, downgrade preserves existing workspaces',async()=>{
 const live=await start({plan:'free'});try{
  const who=await account(live,4242),first=await create(live,who);assert.equal(first.status,201);
  const blocked=await create(live,who);assert.equal(blocked.status,402);assert.equal(blocked.body.limit_name,'workspaces');assert.equal(blocked.body.upgrade_url,'/app/#billing');
  row(live,first.body.id).plan_id='pro';assert.equal((await request(live,who,'orgs')).body.limit,5);
  for(let n=1;n<5;n++)assert.equal((await create(live,who)).status,201);
  assert.equal((await create(live,who)).status,402);
  row(live,first.body.id).plan_id='base';assert.equal((await request(live,who,'orgs')).body.limit,3);
  assert.equal((await create(live,who)).status,402);assert.equal((await request(live,who,'orgs')).body.organizations.length,6);
  row(live,first.body.id).plan_id='enterprise';assert.equal((await request(live,who,'orgs')).body.limit,10);assert.equal((await create(live,who)).status,201);
 }finally{await live.close();}
});

test('membership in another owner paid workspace cannot lend its allowance',async()=>{
 const live=await start({plan:'free'});try{
  const owner=await account(live,4242),member=await account(live,5252),org=(await create(live,owner)).body.id;
  row(live,org).plan_id='enterprise';
  const invite=await request(live,owner,'workspaces/invite?workspace='+org,{recipient_id:member.tenant,role:'admin'});assert.equal(invite.status,201);
  assert.equal((await request(live,member,'workspaces/accept',{workspace_id:org,token:invite.body.token})).status,200);
  assert.equal((await request(live,member,'orgs')).body.limit,1);assert.equal((await create(live,member)).status,201);assert.equal((await create(live,member)).status,402);
 }finally{await live.close();}
});

test('a downgrade or ownership transfer racing creation fails its atomic allowance fence',async()=>{
 for(const mutation of ['downgrade','transfer']){
  const live=await start({plan:'free'});try{
   const who=await account(live,4242),org=(await create(live,who)).body.id;row(live,org).plan_id='pro';
   const original=live.store._tx.bind(live.store);let hit=false;
   live.store._tx=async items=>{if(!hit&&items.some(x=>x.Put?.Item?.sk==='WORKSPACE#META'&&x.Put.Item.organization===true)){hit=true;if(mutation==='downgrade')row(live,org).plan_id='free';else row(live,org).owner_account='github-999';}return original(items);};
   assert.equal((await create(live,who)).status,409);assert.equal(hit,true);assert.equal(live.store.client.items.get('TENANT#'+who.tenant+'\0ORGANIZATION#CAPACITY').count,1);
  }finally{await live.close();}
 }
});
