import test from 'node:test';
import assert from 'node:assert/strict';
import {start} from './harness.mjs';

for(const cookie of ['', '__Host-supatrace=invalid','__Host-supatrace='+'z'.repeat(43)])test(`optional session probe handles ${cookie?'invalid or expired':'missing'} session without granting access`,async()=>{
 const live=await start();
 try{
  const response=await fetch(live.origin+'/api/me?optional=1',{headers:{cookie}});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{signed_out:true});
  assert.equal(response.headers.get('cache-control'),'no-store');
  for(const path of ['/api/me','/api/projects','/api/keys','/api/runs'])assert.equal((await fetch(live.origin+path,{headers:{cookie}})).status,401,path);
 }finally{await live.close();}
});
test('optional probe returns the same authenticated identity as the existing me route',async()=>{
 const live=await start();let cookies;
 try{
  await live.signIn({addCookies:async value=>{cookies=value;}});
  const headers={cookie:cookies.map(c=>c.name+'='+c.value).join('; ')};
  const normal=await fetch(live.origin+'/api/me',{headers}),optional=await fetch(live.origin+'/api/me?optional=1',{headers});
  assert.equal(normal.status,200);assert.equal(optional.status,200);
  assert.deepEqual(await optional.json(),await normal.json());
  assert.equal((await fetch(live.origin+'/api/projects',{headers})).status,200);
 }finally{await live.close();}
});
test('optional probe preserves service failures rather than treating them as signed out',async()=>{
 const live=await start({configureEnvironment:env=>{env.store.getSession=async()=>{throw Error('synthetic storage outage');};}});
 try{assert.equal((await fetch(live.origin+'/api/me?optional=1',{headers:{cookie:'__Host-supatrace='+'z'.repeat(43)}})).status,503);}
 finally{await live.close();}
});
