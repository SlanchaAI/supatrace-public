import test from 'node:test';
import assert from 'node:assert/strict';
import {mountImportConsent} from '../public/app/import-consent.js';
import {pullFixture,credentials,spec} from './server-pull-fixture.mjs';
async function fixture(t){
 const f=await pullFixture(),nodes=new Map(),listeners=new Map(),get=id=>{if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',disabled:false,hidden:false,checked:false});return nodes.get(id);};let project=f.input.scope.destinationProject,respond=null,pace=null,time=Date.now();const calls=[],waits=[];
 const document={getElementById:get,hidden:false,addEventListener:(name,fn)=>listeners.set(name,fn)};
 const ui=mountImportConsent({document,getProject:()=>project,now:()=>time,wait:async(ms,signal)=>{waits.push(ms);f.tick(2);if(pace)await pace(signal);if(signal.aborted)throw Error();},request:async(path,body,signal)=>{calls.push({path,body,signal});if(respond)return respond(path,body,signal);const result=await f.api(path.slice('imports/'.length),body,{signal});if(result.status!==200)throw Error(result.body.error);return result.body;}});t.after(()=>ui.invalidate());
 const load=()=>ui.setPlan(f.input,{serverPull:true}),click=id=>get(id).onclick(),confirm=async()=>{load();await click('import-consent-review');get('import-consent-accept').checked=true;get('import-consent-accept').onchange();await click('import-consent-confirm');};
 return {...f,get,ui,calls,waits,load,click,confirm,expire:()=>{time+=3600001;},respond:fn=>{respond=fn;},pace:fn=>{pace=fn;},hidden:()=>{document.hidden=true;listeners.get('visibilitychange')();},project:value=>{project=value;},keys:()=>{get('import-public-key').value=credentials.publicKey;get('import-secret-key').value=credentials.secretKey;}};
}
test('one Start and one pasted key automatically complete multiple pages and all bounded storage phases',async t=>{
 const f=await fixture(t);let page=0;f.provider(async url=>Response.json(url.endsWith('/projects')?{data:[{id:spec.sourceProject}]}:{data:[f.row('obs'+page)],meta:{cursor:page++===0?'next':null}}));await f.confirm();f.keys();await f.click('import-start');
 assert.equal(f.stored().phase,'complete');assert.equal(f.fetches(),4);assert.equal(f.get('import-secret-key').value,'');assert.equal(f.get('import-public-key').value,'');assert.equal(f.get('import-start').disabled,true);assert.match(f.get('import-consent-status').textContent,/Import stored and read back/);
 assert.equal(f.calls.filter(c=>c.path==='imports/pull/start').length,1);const advances=f.calls.filter(c=>c.path==='imports/pull/advance');assert.equal(advances.length,10);assert.deepEqual(advances.slice(0,2).map(c=>c.body.credentials),[credentials,credentials]);assert(advances.slice(2).every(c=>c.body.credentials===null));assert(f.waits.every(ms=>ms===1500));assert.equal(f.get('import-pull-pause').hidden,true);
});
test('pause after source capture clears credentials; explicit status and Resume finish without another source call',async t=>{
 const f=await fixture(t);await f.confirm();f.keys();f.pace(()=>{if(f.stored().phase==='ready')f.click('import-pull-pause');});await f.click('import-start');assert.equal(f.stored().phase,'ready');assert.equal(f.get('import-start').disabled,true);assert.match(f.get('import-consent-status').textContent,/paused.*Keys were cleared/);const count=f.calls.length;await f.click('import-start');assert.equal(f.calls.length,count);
 f.pace(null);await f.click('import-pull-status');assert.equal(f.get('import-start').disabled,false);await f.click('import-start');assert.equal(f.stored().phase,'complete');assert.equal(f.fetches(),2);assert.equal(f.get('import-secret-key').value,'');
});
test('paused source pagination requires fresh key entry and does not advance automatically on visibility return',async t=>{
 const f=await fixture(t);let page=0;f.provider(async url=>Response.json(url.endsWith('/projects')?{data:[{id:spec.sourceProject}]}:{data:[f.row('obs'+page)],meta:{cursor:page++===0?'next':null}}));await f.confirm();f.keys();f.pace(()=>{if(f.stored().checkpoint.pages.length===1)f.click('import-pull-pause');});await f.click('import-start');assert.equal(f.fetches(),2);f.pace(null);await f.click('import-pull-status');await f.click('import-start');assert.match(f.get('import-consent-status').textContent,/Enter both/);assert.equal(f.fetches(),2);f.keys();await f.click('import-start');assert.equal(f.fetches(),4);assert.equal(f.stored().phase,'complete');
});
test('reloading UI after partial progress resumes the same durable operation',async t=>{
 const f=await fixture(t);await f.confirm();f.keys();f.pace(()=>{if(f.stored().phase==='object_ready')f.ui.invalidate();});await f.click('import-start');assert.equal(f.stored().phase,'object_ready');f.pace(null);await f.confirm();await f.click('import-pull-status');await f.click('import-start');assert.equal(f.stored().phase,'complete');assert.equal(f.fetches(),2);
});
test('stale scope discards Start result and clears both key inputs',async t=>{
 const f=await fixture(t);await f.confirm();let finish;f.respond(()=>new Promise(done=>{finish=done;}));f.keys();const work=f.click('import-start');f.keys();f.ui.invalidate();finish({status:'capturing'});await work;assert.equal(f.get('import-start').disabled,true);assert.equal(f.get('import-public-key').value,'');assert.equal(f.get('import-secret-key').value,'');assert.equal(f.get('import-pull-controls').hidden,true);assert.equal(f.calls.filter(c=>c.path==='imports/pull/advance').length,0);
});
test('repeated clicks are single flight and unknown Start outcome requires durable status without automatic retry',async t=>{
 const f=await fixture(t);await f.confirm();let reject;f.respond(()=>new Promise((_,fail)=>{reject=fail;}));f.keys();const work=f.click('import-start');await f.click('import-start');assert.equal(f.calls.filter(c=>c.path==='imports/pull/start').length,1);reject(Error(credentials.secretKey));await work;assert.match(f.get('import-consent-status').textContent,/not confirmed.*durable status/);assert.equal(f.get('import-start').disabled,true);assert.equal(f.calls.filter(c=>c.path==='imports/pull/start').length,1);assert.equal(f.get('import-consent-status').textContent.includes(credentials.secretKey),false);
});
test('failed advance clears keys, stops orchestration and cannot auto-retry its uncertain effect',async t=>{
 const f=await fixture(t);await f.confirm();f.keys();f.provider(async()=>{throw Error(credentials.secretKey);});await f.click('import-start');assert.equal(f.get('import-secret-key').value,'');assert.equal(f.get('import-public-key').value,'');assert.equal(f.calls.filter(c=>c.path==='imports/pull/advance').length,1);assert.equal(f.get('import-start').disabled,true);const count=f.calls.length;await f.click('import-start');assert.equal(f.calls.length,count);
});
test('Pause settles an ignored pending browser response and prevents late follow-on requests',async t=>{
 const f=await fixture(t);await f.confirm();let finish;f.respond(()=>new Promise(done=>{finish=done;}));f.keys();const work=f.click('import-start');await f.click('import-pull-pause');await work;assert.equal(f.get('import-secret-key').value,'');assert.equal(f.calls.at(-1).signal.aborted,true);finish({status:'capturing'});await Promise.resolve();assert.equal(f.calls.filter(c=>c.path==='imports/pull/advance').length,0);assert.equal(f.get('import-start').disabled,true);
});
test('hidden page, scope changes and account changes stop between paced steps',async t=>{
 for(const mode of ['hidden','scope','account']){const f=await fixture(t);await f.confirm();f.keys();f.pace(()=>{if(mode==='hidden')f.hidden();else if(mode==='scope')f.ui.invalidate();else f.project(null);});await f.click('import-start');assert.equal(f.fetches(),0);assert.equal(f.get('import-secret-key').value,'');assert.equal(f.get('import-start').disabled,true);}
});
test('account changed during status cannot render the earlier job or retain credentials',async t=>{
 const f=await fixture(t);await f.confirm();let finish;f.respond(()=>new Promise(done=>{finish=done;}));const work=f.click('import-pull-status');f.keys();f.project(null);finish({status:'ready'});await work;assert.equal(f.get('import-start').disabled,true);assert.equal(f.get('import-secret-key').value,'');assert.equal(f.get('import-consent-output').hidden,true);
});
test('empty source renders no matching observations without storage or trace-success claims',async t=>{
 const f=await fixture(t);f.provider(async url=>Response.json(url.endsWith('/projects')?{data:[{id:spec.sourceProject}]}:{data:[],meta:{cursor:null}}));await f.confirm();f.keys();await f.click('import-start');assert.equal(f.stored().phase,'empty');assert.match(f.get('import-consent-status').textContent,/No matching observations/);assert.doesNotMatch(f.get('import-consent-status').textContent,/Import stored and read back|Open Traces/);assert.equal(f.get('import-start').disabled,true);assert.equal(f.puts(),0);
});

test('consent expiry between paced steps stops automatically and clears credentials',async t=>{
 const f=await fixture(t);await f.confirm();f.keys();f.pace(()=>f.expire());await f.click('import-start');assert.equal(f.fetches(),0);assert.equal(f.get('import-secret-key').value,'');assert.equal(f.get('import-start').disabled,true);assert.equal(f.calls.filter(c=>c.path==='imports/pull/advance').length,0);
});
test('uncertain destination effect halts the active flow; explicit status/resume reconciles without replay',async t=>{
 const f=await fixture(t);await f.confirm();let writes=0;const reserve=f.store.reserveBatch;f.store.reserveBatch=async function(...args){writes++;await reserve.apply(this,args);throw Error('lost reservation response');};f.keys();await f.click('import-start');assert.equal(f.stored().phase,'reserve_consumed');assert.equal(writes,1);assert.equal(f.calls.filter(c=>c.path==='imports/pull/advance').length,2);assert.equal(f.get('import-start').disabled,true);assert.equal(f.get('import-secret-key').value,'');
 f.tick(31);await f.click('import-pull-status');await f.click('import-start');assert.equal(f.stored().phase,'complete');assert.equal(writes,1);assert.equal(f.fetches(),2);
});

test('reordered durable sanitization disclosure remains reviewable; changed policy is rejected',async t=>{
 for(const changed of [false,true]){
  const f=await fixture(t);f.respond(async(path,body,signal)=>{
   const result=await f.api(path.slice('imports/'.length),body,{signal});assert.equal(result.status,200);
   if(path.endsWith('/review')){const d=result.body.disclosure;d.sanitization=Object.fromEntries(Object.entries(d.sanitization).reverse());if(changed)d.sanitization.removed_fields.pop();}
   return result.body;
  });
  f.load();await f.click('import-consent-review');assert.equal(f.get('import-consent-accept').disabled,changed);assert.equal(f.fetches(),0);
  if(!changed){f.get('import-consent-accept').checked=true;f.get('import-consent-accept').onchange();await f.click('import-consent-confirm');assert.equal(f.get('import-start').disabled,false);}
 }
});
