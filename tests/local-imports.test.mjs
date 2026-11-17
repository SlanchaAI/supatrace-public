import test from 'node:test';
import assert from 'node:assert/strict';
import {rmSync} from 'node:fs';
import {start} from './harness.mjs';
import {configureLocalImports} from '../scripts/local-imports.mjs';
import {dispatchKey} from '../src/private-import-dispatch.mjs';
test('first synthetic review pins five-minute consent at click time; Start cannot silently renew it',async()=>{
 let local;const live=await start({localDev:true,configureEnvironment:async env=>{local=env.localImports=await configureLocalImports(env);}});let cookie;
 try{await live.signIn({addCookies:async cookies=>{cookie=cookies.map(c=>c.name+'='+c.value).join('; ');}});const clickTime=live.store.now()+600;live.store.now=()=>clickTime;const post=(path,data)=>fetch(live.origin+path,{method:'POST',headers:{cookie,origin:live.origin,'content-type':'application/json'},body:JSON.stringify(data)}),fingerprint=local.plan.fingerprint;
  assert.equal((await post('/__local__/imports/start',{fingerprint})).status,503);const review=await(await post('/api/imports/review',{fingerprint})).json();assert.equal(review.disclosure.expires_at,clickTime+300);assert.equal((await post('/api/imports/consent',{fingerprint,review_hash:review.review_hash,accept_content:true})).status,200);assert.deepEqual(local.counts(),{sourceRequests:0,destinationRequests:0});
  const response=await post('/__local__/imports/start',{fingerprint});assert.equal(response.status,202);const job=await response.json(),record=await live.store._get(dispatchKey('github-4242',job.job_id));assert.equal(record.binding.expires_at,clickTime+300);assert.equal(job.assignment_state,'pending');await post('/__local__/imports/cancel?job='+job.job_id,{});const again=await(await post('/api/imports/review',{fingerprint})).json();assert.equal(again.review_hash,review.review_hash);
 }finally{await live.close();if(local)rmSync(local.directory,{recursive:true,force:true});}
});
