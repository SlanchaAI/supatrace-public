import test from 'node:test';
import assert from 'node:assert/strict';
import {start} from './harness.mjs';
import {digest} from '../src/aws-auth.mjs';
import {seedLocalWorkspace} from '../scripts/dev.mjs';
test('one local composition seeds real workspace roles and separate traces; development controls never exist by default',async()=>{
 const live=await start({localDev:true});try{
  const result=await seedLocalWorkspace(live);assert.deepEqual(result.environments,['default','development','production']);
  const login=await fetch(live.origin+'/__local__/signin?account=5252',{redirect:'manual'});assert.equal(login.status,303);assert.equal(login.headers.get('location'),'/app/#home');
  const cookie=login.headers.get('set-cookie').split(';')[0];
  for(const environment of result.environments){const r=await fetch(live.origin+'/api/runs?workspace=github-4242&environment='+environment,{headers:{cookie}});assert.equal(r.status,200);assert.equal((await r.json()).runs.length,2);}
  const billing=await fetch(live.origin+'/api/billing/status?workspace=github-4242',{headers:{cookie}});assert.equal(billing.status,403);
  const owner=await fetch(live.origin+'/__local__/signin?account=4242',{redirect:'manual'}),ownerCookie=owner.headers.get('set-cookie').split(';')[0];
  const create=await fetch(live.origin+'/api/keys/create',{method:'POST',headers:{cookie:ownerCookie,origin:live.origin,'content-type':'application/json'},body:JSON.stringify({key_hash:digest('st_pub_'+'a'.repeat(43)),key_type:'publishable'})});
  assert.equal(create.status,201);assert.equal((await live.store.getTenant('github-4242')).plan_id,undefined);
  const oauth=await fetch(live.origin+'/api/auth/login',{redirect:'manual'});assert.equal(oauth.status,200);assert.doesNotMatch(oauth.headers.get('location')??'',/github.com/);
 }finally{await live.close();}
 const plain=await start();try{assert.equal((await fetch(plain.origin+'/__local__/signin?account=4242',{redirect:'manual'})).status,404);}finally{await plain.close();}
});
