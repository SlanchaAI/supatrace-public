import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {loadStartupIdentity,startupRead,probeReachable,PROBE_TIMEOUT_MS,STARTUP_TIMEOUT_MS} from '../public/app/startup-data.js';
const project='proj_'+'1'.repeat(32),me={tenant_id:'synthetic-account',project_id:project};
const data={projects:[{id:project,name:'Synthetic project'}]};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('startup requests identity and its projects together, using one cancellation signal',async()=>{
 const calls=[];const result=await loadStartupIdentity(async(path,signal)=>{calls.push({path,signal});return path==='me'?me:data;});
 assert.deepEqual(result,{me,data});assert.deepEqual(calls.map(c=>c.path),['me','projects']);assert.equal(calls[0].signal,calls[1].signal);
 // Both requests are out before either answers: a healthy load is one round trip.
 const open=[],release=[];const pending=loadStartupIdentity(path=>{open.push(path);return new Promise(resolve=>release.push(()=>resolve(path==='me'?me:data)));});
 await tick();assert.deepEqual(open,['me','projects']);release[1]();await tick();release[0]();assert.deepEqual(await pending,{me,data});
 // Once the wait is over the shared signal is aborted, so nothing is left running.
 assert.equal(calls[0].signal.aborted,true);
});
for(const stage of ['me','projects'])test(`startup deadline bounds a stalled ${stage} response and a transport that ignores abort`,async()=>{
 let finish,signal;const calls=[];
 const pending=loadStartupIdentity(async(path,s)=>{calls.push(path);if(path!==stage)return me;signal=s;return new Promise(resolve=>finish=resolve);},{timeoutMs:10});
 await assert.rejects(pending,{message:'startup_timeout'});assert.equal(signal.aborted,true);
 finish(stage==='me'?me:data);await tick();assert.deepEqual(calls,['me','projects']);
});
test('deadline also bounds parsing of a response body that never finishes',async()=>{
 let signal;await assert.rejects(startupRead(async s=>{signal=s;const response={json:()=>new Promise(()=>{})};return await response.json();},{timeoutMs:10}),{message:'startup_timeout'});assert.equal(signal.aborted,true);
});
test('cancellation before dispatch sends nothing, and during the reads stops both',async()=>{
 for(const immediate of [true,false]){
  const controller=new AbortController(),calls=[];let finish;
  const pending=loadStartupIdentity(path=>{calls.push(path);return new Promise(resolve=>finish=resolve);},{signal:controller.signal});
  if(!immediate)await tick();controller.abort();await assert.rejects(pending,{message:'startup_cancelled'});
  finish?.(me);await tick();assert.deepEqual(calls,immediate?[]:['me','projects']);
 }
});
test('service, auth and rate-limit failures keep their status without an automatic retry',async()=>{
 for(const error of [Object.assign(Error('temporarily_unavailable'),{status:503}),Object.assign(Error('sign_in_required'),{status:401}),Object.assign(Error('rate_limit'),{status:429,retryAfter:4})]){
  let calls=0;await assert.rejects(loadStartupIdentity(()=>{calls++;throw error;}),e=>e===error);assert.equal(calls,2,'one attempt: the two reads, no retry');
 }
 // The identity read's error is the one reported, even when the projects read fails first with something else.
 const auth=Object.assign(Error('sign_in_required'),{status:401});let failMe;
 const pending=loadStartupIdentity(path=>path==='me'?new Promise((_,reject)=>failMe=reject):Promise.reject(Object.assign(Error('temporarily_unavailable'),{status:503})));
 await tick();failMe(auth);await assert.rejects(pending,e=>e===auth);
});
test('a different, missing or ambiguous project never becomes the active workspace',async()=>{
 for(const projects of [[],[{id:'other'}],[{id:project},{id:project}],null])await assert.rejects(loadStartupIdentity(async path=>path==='me'?me:{projects}),{message:'project_unavailable'});
 await assert.rejects(loadStartupIdentity(async path=>path==='me'?{}:{projects:[{}]}),{message:'project_unavailable'});
});
test('an independent deliberate retry can complete after a failed read',async()=>{
 let failed=true;const calls=[];const request=async path=>{calls.push(path);if(failed)throw Error('temporarily_unavailable');return path==='me'?me:data;};
 await assert.rejects(loadStartupIdentity(request));failed=false;assert.deepEqual(await loadStartupIdentity(request),{me,data});assert.deepEqual(calls,['me','projects','me','projects']);
});

// Exercise the production API helper: it can invalidate identity before a
// startup controller gets the error, so a controller-only stub misses this race.
const appSource=readFileSync(new URL('../public/app/app.js',import.meta.url),'utf8');
const apiSource=appSource.match(/async function api\([\s\S]*?(?=\nconst messages=)/)?.[0];
assert.ok(apiSource,'Expected the production API helper');
for(const outcome of ['cancel','deadline'])for(const code of ['sign_in_required','project_unavailable'])test(`a late ${code} after startup ${outcome} cannot invalidate the retried identity`,async()=>{
 for(const stalledBody of [false,true]){
  let finish,reads=0,oldSignal,currentError=false,invalidations=0;
  const old=new Promise(resolve=>finish=resolve),status=code==='sign_in_required'?401:403;
  const failure=()=>new Response(JSON.stringify({error:code}),{status});
  const context={activeProject:null,activeEnvironment:'default',activeWorkspace:null,actorTenant:null,identityVerified:false,fetch:async(path,{signal})=>{
   if(++reads===1){oldSignal=signal;return stalledBody?{status,ok:false,headers:new Headers(),json:()=>old}:old;}
   if(currentError)return failure();
   return new Response(JSON.stringify(path==='/api/me'?me:data));
  },invalidateAccountIdentity:()=>{invalidations++;context.identityVerified=false;}};
  runInNewContext(apiSource+';globalThis.request=(path,signal)=>api(path,undefined,signal,null);',context);
  const controller=new AbortController();
  const pending=loadStartupIdentity(context.request,{signal:controller.signal,timeoutMs:outcome==='deadline'?10:15000});
  const rejected=assert.rejects(pending,{message:outcome==='deadline'?'startup_timeout':'startup_cancelled'});
  await tick();if(outcome==='cancel')controller.abort();await rejected;
  assert.equal(oldSignal.aborted,true);
  const fresh=await loadStartupIdentity(context.request);
  context.activeProject=fresh.data.projects[0].id;context.identityVerified=true;
  finish(stalledBody?{error:code}:failure());await tick();
  assert.equal(invalidations,0,'The cancelled request must not clear a newer account identity');
  assert.equal(context.identityVerified,true);assert.equal(reads,4);
  // Current auth failures must still invalidate billing/account recovery scope.
  currentError=true;
  await assert.rejects(loadStartupIdentity(context.request),{message:code,status});
  assert.ok(invalidations>=1,'the failing identity read invalidates; the concurrent projects read may too');assert.equal(context.identityVerified,false);
 }
});

// Reachability probe (#95).
test('the probe is reachable once a response arrives, whatever its status or body, and names a dead route',async()=>{
 const providers={github:true,google:false},seen=[];
 const ok=await probeReachable({fetcher:async(path,init)=>{seen.push([path,init.credentials,init.cache]);return new Response(JSON.stringify(providers));}});
 assert.equal(ok.reachable,true);assert.deepEqual(await ok.providers,providers);assert.deepEqual(seen,[['/api/auth/providers','same-origin','no-store']]);
 // An error status, malformed JSON and a non-object body are all reachable, with no provider list.
 for(const status of [401,429,503]){let signal;const r=await probeReachable({fetcher:async(path,init)=>{signal=init.signal;return new Response('{"error":"x"}',{status});}});assert.equal(r.reachable,true);assert.equal(await r.providers,null);assert.equal(signal.aborted,true,'an error response is dropped, not read');}
 for(const body of ['<html>','[1]','null']){const r=await probeReachable({fetcher:async()=>new Response(body)});assert.equal(r.reachable,true);assert.equal(await r.providers,null);}
 // A network failure, or no response within the probe deadline, is unreachable, and the request is aborted.
 await assert.rejects(probeReachable({fetcher:async()=>{throw new TypeError('Failed to fetch');}}),{message:'startup_unreachable'});
 let signal;await assert.rejects(probeReachable({fetcher:(path,init)=>{signal=init.signal;return new Promise(()=>{});},timeoutMs:10}),{message:'startup_unreachable'});assert.equal(signal.aborted,true);
 const controller=new AbortController(),held=probeReachable({fetcher:(path,init)=>{signal=init.signal;return new Promise(()=>{});},signal:controller.signal});await tick();controller.abort();await assert.rejects(held,{message:'startup_cancelled'});assert.equal(signal.aborted,true);
 const gone=new AbortController();gone.abort();let asked=false;await assert.rejects(probeReachable({fetcher:()=>{asked=true;},signal:gone.signal}),{message:'startup_cancelled'});assert.equal(asked,false);
 await assert.rejects(probeReachable({fetcher:async()=>new Response('{}'),timeoutMs:0}),{message:'invalid_startup_request'});
 assert.ok(PROBE_TIMEOUT_MS<STARTUP_TIMEOUT_MS);
});
test('a stalled probe body stays reachable, and its deadline or the caller\'s cancellation aborts the request itself',async()=>{
 const stalledBody=signals=>async(path,init)=>{signals.push(init.signal);return {ok:true,json:()=>new Promise(()=>{})};};
 const byDeadline=[],first=await probeReachable({fetcher:stalledBody(byDeadline),timeoutMs:10});
 assert.equal(first.reachable,true);assert.equal(byDeadline[0].aborted,false);assert.equal(await first.providers,null);assert.equal(byDeadline[0].aborted,true);
 const byCaller=[],controller=new AbortController(),second=await probeReachable({fetcher:stalledBody(byCaller),signal:controller.signal});
 assert.equal(second.reachable,true);controller.abort();assert.equal(await second.providers,null);assert.equal(byCaller[0].aborted,true);
 // A body that arrives leaves the request alone.
 const fine=[],third=await probeReachable({fetcher:async(path,init)=>{fine.push(init.signal);return new Response('{"github":true}');}});assert.deepEqual(await third.providers,{github:true});assert.equal(fine[0].aborted,false);
});
