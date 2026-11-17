import test from 'node:test';
import assert from 'node:assert/strict';
import {pullFixture,credentials,spec} from './server-pull-fixture.mjs';
import {composeServerPullController} from '../src/import-composition.mjs';
import {planCustomerImport} from '../src/import-planning.mjs';
import {alphaProject} from '../src/alpha-projects.mjs';
import {createFixtureSession} from './fixture-session.mjs';
const origin='https://supatrace.dev',tenant='github-4242',project=alphaProject(tenant).id;
test('explicit composition is required; legacy/unset/invalid config cannot enable pull',async()=>{
 const f=await pullFixture();for(const config of [undefined,'{}','{"mode":"bounded-server-pull-v1","origin":"https://evil.invalid"}',f.config.replace('v1','v2')])assert.deepEqual(composeServerPullController(config,{store:f.store,objects:f.objects,origins:[origin]}),{});
 delete f.env.serverPullController;assert.equal((await f.api('pull/start')).status,503);assert.equal(f.fetches(),0);
});
test('actual composed API plans, reviews, consents, starts, checkpoints, uploads and reads back without keys persisted',async()=>{
 const f=await pullFixture();const planned=await f.api('plan',spec);assert.equal(planned.body.capabilities.server_pull.available,true);
 await f.consent();assert.equal(f.fetches(),0);assert.equal((await f.ok('start')).status,'capturing');assert.equal(f.fetches(),0);
 assert.equal((await f.advance()).status,'ready');assert.equal(f.fetches(),2);
 f.env.serverPullController=f.compose().serverPullController;
 let status;for(let i=0;i<8;i++){status=await f.advance();if(status.status==='complete')break;}
 assert.equal(status.status,'complete');assert.equal(status.stored_bytes_verified,true);assert.equal(status.export_verified,false);assert.equal(status.progress.verified_batches,1);assert.equal(f.fetches(),2);assert.equal(f.puts(),1);
 const serialized=JSON.stringify([...f.client.items.values()])+JSON.stringify([...f.saved.values()])+JSON.stringify(status);
 for(const secret of Object.values(credentials))assert.equal(serialized.includes(secret),false);
 assert.equal((await f.ok('start')).status,'complete');assert.equal(f.fetches(),2);
});
test('unconsented, wrong review, trace, scope, origin and bounds are rejected before source access',async()=>{
 const f=await pullFixture();assert.equal((await f.api('pull/start')).status,404);
 for(const change of [{maxRows:101},{pageSize:51},{maxBytes:131073},{maxRetries:1}]){const p=planCustomerImport({...spec,...change},project,{serverPull:true});assert.equal((await f.api('pull/review',{fingerprint:p.plan.fingerprint,plan:{...spec,...change}})).status,400);}
 const review=await f.ok('review',{...f.fp,plan:spec});assert.equal((await f.api('pull/start')).status,409);
 assert.equal((await f.api('pull/consent',{...f.fp,review_hash:'f'.repeat(64),accept_content:true})).status,409);
 assert.equal((await f.api('pull/consent',{...f.fp,review_hash:review.review_hash,accept_content:false})).status,400);
 assert.equal((await f.api('pull/review',{...f.fp,plan:{...spec,traceId:'other'}})).status,400);
 assert.equal((await f.api('pull/review',{...f.fp,plan:spec},{headers:{origin:'https://evil.invalid'}})).status,401);assert.equal(f.fetches(),0);
});
test('two-page capture resumes from saved cursor and respects one page per request',async()=>{
 const f=await pullFixture();const seen=[];f.provider(async url=>{const u=new URL(url);if(u.pathname.endsWith('/projects'))return Response.json({data:[{id:spec.sourceProject}]});seen.push(u.searchParams.get('cursor'));return Response.json({data:[f.row(u.searchParams.has('cursor')?'two':'one')],meta:{cursor:u.searchParams.has('cursor')?null:'next'}});});await f.consent();await f.ok('start');assert.equal((await f.advance()).status,'capturing');assert.deepEqual(seen,[null]);f.env.serverPullController=f.compose().serverPullController;assert.equal((await f.advance()).status,'ready');assert.deepEqual(seen,[null,'next']);assert.equal(f.stored().checkpoint.pages.length,2);
});
test('duplicate Start and concurrent advance have only one provider caller',async()=>{
 const f=await pullFixture();await f.consent();const starts=await Promise.all([f.api('pull/start'),f.api('pull/start')]);assert(starts.every(r=>r.status===200));let release,entered;const began=new Promise(r=>{entered=r;});f.provider(async url=>{if(url.endsWith('/projects')){entered();await new Promise(r=>{release=r;});return Response.json({data:[{id:spec.sourceProject}]});}return Response.json({data:[f.row()],meta:{cursor:null}});});const first=f.api('pull/advance',{...f.fp,credentials});await began;assert.equal((await f.api('pull/advance',{...f.fp,credentials})).status,409);release();assert.equal((await first).status,200);assert.equal(f.fetches(),2);
});
test('provider failure and echoed credentials never persist or expose diagnostics; explicit retry waits for lease',async()=>{
 const f=await pullFixture();await f.consent();await f.ok('start');f.provider(async()=>{throw Error(credentials.secretKey);});const result=await f.api('pull/advance',{...f.fp,credentials});assert.equal(result.status,503);assert.equal(JSON.stringify(result).includes(credentials.secretKey),false);assert.equal(f.stored().checkpoint.pages.length,0);assert.equal((await f.api('pull/advance',{...f.fp,credentials})).status,409);f.tick(31);
 f.provider(async url=>Response.json(url.endsWith('/projects')?{data:[{id:spec.sourceProject}]}:{data:[{...f.row(),input:credentials.secretKey}],meta:{cursor:null}}));assert.equal((await f.api('pull/advance',{...f.fp,credentials})).status,503);assert.equal(JSON.stringify([...f.client.items.values()]).includes(credentials.secretKey),false);
});
for(const stage of ['reserve','object','ack'])test('uncertain '+stage+' success reconciles without replay',async()=>{
 const f=await pullFixture();await f.consent();await f.ok('start');await f.advance();let calls=0;
 if(stage==='reserve'){const fn=f.store.reserveBatch;f.store.reserveBatch=async function(...args){calls++;await fn.apply(this,args);throw Error('lost response');};}
 if(stage==='object'){await f.advance();const fn=f.objects.putImmutable;f.objects.putImmutable=async(...args)=>{calls++;await fn(...args);throw Error('lost response');};}
 if(stage==='ack'){await f.advance();await f.advance();const fn=f.store.acceptReservedBatch;f.store.acceptReservedBatch=async function(...args){calls++;await fn.apply(this,args);throw Error('lost response');};}
 assert.equal((await f.api('pull/advance',{...f.fp,credentials:null})).status,503);assert.equal(calls,1);assert.equal(f.stored().phase,stage==='reserve'?'reserve_consumed':stage==='object'?'object_consumed':'ack_consumed');f.tick(31);
 assert.equal((await f.api('pull/advance',{...f.fp,credentials:null})).status,200);assert.equal(calls,1);assert.equal(f.fetches(),2);
});
test('uncertain reservation with no receipt remains blocked, never retried',async()=>{
 const f=await pullFixture();await f.consent();await f.ok('start');await f.advance();let calls=0;f.store.reserveBatch=async()=>{calls++;throw Error('lost');};assert.equal((await f.api('pull/advance',{...f.fp,credentials:null})).status,503);f.tick(31);assert.equal((await f.api('pull/advance',{...f.fp,credentials:null})).body.error,'server_pull_reconciliation_required');f.tick(31);await f.api('pull/advance',{...f.fp,credentials:null});assert.equal(calls,1);
});
test('revocation during source read prevents checkpoint/storage and expiry cannot be silently renewed',async()=>{
 const f=await pullFixture();await f.consent();await f.ok('start');let release,entered;const began=new Promise(r=>{entered=r;});f.provider(async url=>{if(url.endsWith('/projects'))return Response.json({data:[{id:spec.sourceProject}]});entered();await new Promise(r=>{release=r;});return Response.json({data:[f.row()],meta:{cursor:null}});});const pending=f.api('pull/advance',{...f.fp,credentials});await began;await f.ok('revoke');release();assert.notEqual((await pending).status,200);assert.equal(f.stored().phase,'revoked');assert.equal(f.stored().checkpoint.pages.length,0);assert.equal(f.puts(),0);
 const g=await pullFixture();await g.consent();g.tick(3601);assert.equal((await g.api('pull/review',{...g.fp,plan:spec})).status,409);assert.equal((await g.api('pull/start')).status,409);
});
test('changed physical session cannot resume original consent',async()=>{
 const f=await pullFixture();await f.consent();await f.ok('start');const other=await createFixtureSession(f.store,tenant);const result=await f.api('pull/status',f.fp,{headers:{origin,cookie:'__Host-supatrace='+other,'content-type':'application/json'}});assert.equal(result.status,409);assert.equal(f.fetches(),0);
});
test('capture page/row/byte bounds and wrong provider trace stop without destination writes',async()=>{
 for(const mode of ['wrong-trace','too-many-rows','too-many-bytes','repeated-cursor']){
  const f=await pullFixture();await f.consent();await f.ok('start');
  f.provider(async url=>Response.json(url.endsWith('/projects')?{data:[{id:spec.sourceProject}]}:{data:mode==='too-many-rows'?Array.from({length:6},(_,i)=>f.row('obs'+i)):[{...f.row(),...(mode==='wrong-trace'?{traceId:'other'}:{}),...(mode==='too-many-bytes'?{input:'x'.repeat(110000)}:{})}],meta:{cursor:mode==='repeated-cursor'?'again':null}}));
  if(mode==='repeated-cursor')await f.advance();assert.equal((await f.api('pull/advance',{...f.fp,credentials})).status,503);assert.equal(f.puts(),0);assert.equal(f.stored().index,0);
 }
});
test('bounded unfinished pagination preserves checkpoint without claiming complete or uploading',async()=>{
 const f=await pullFixture();let cursor=0;f.provider(async url=>Response.json(url.endsWith('/projects')?{data:[{id:spec.sourceProject}]}:{data:[f.row('obs'+cursor)],meta:{cursor:'next'+cursor++}}));await f.consent();await f.ok('start');await f.advance();await f.advance();const calls=f.fetches(),status=await f.advance();assert.equal(status.status,'bounded_incomplete');assert.equal(status.stored_bytes_verified,false);assert.equal(f.fetches(),calls);assert.equal(f.puts(),0);assert.equal(f.stored().checkpoint.pages.length,2);
});
test('unknown object/ACK outcomes with no successful receipt stay blocked with no repeated mutation',async()=>{
 for(const stage of ['object','ack']){
  const f=await pullFixture();await f.consent();await f.ok('start');await f.advance();await f.advance();let calls=0;
  if(stage==='object')f.objects.putImmutable=async()=>{calls++;throw Error('unknown');};else{await f.advance();f.store.acceptReservedBatch=async()=>{calls++;throw Error('unknown');};}
  assert.equal((await f.api('pull/advance',{...f.fp,credentials:null})).status,503);f.tick(31);assert.notEqual((await f.api('pull/advance',{...f.fp,credentials:null})).status,200);f.tick(31);assert.notEqual((await f.api('pull/advance',{...f.fp,credentials:null})).status,200);assert.equal(calls,1);
 }
});
test('interrupted provider response never commits a late checkpoint and next request resumes original state',async()=>{
 const f=await pullFixture();await f.consent();await f.ok('start');let release,entered;const began=new Promise(r=>{entered=r;});f.provider(async url=>{if(url.endsWith('/projects'))return Response.json({data:[{id:spec.sourceProject}]});entered();await new Promise(r=>{release=r;});return Response.json({data:[f.row()],meta:{cursor:null}});});const controller=new AbortController(),work=f.api('pull/advance',{...f.fp,credentials},{signal:controller.signal});await began;controller.abort();release();assert.notEqual((await work).status,200);assert.equal(f.stored().checkpoint.pages.length,0);assert.equal(f.puts(),0);
});
test('checkpoint tampering and accepted-byte mismatch fail closed',async()=>{
 const f=await pullFixture();await f.consent();await f.ok('start');await f.advance();f.stored().checkpoint.pages[0].data[0].traceId='changed';assert.equal((await f.api('pull/status')).status,409);
 const g=await pullFixture();await g.consent();await g.ok('start');await g.advance();await g.advance();await g.advance();await g.advance();for(const k of g.saved.keys())g.saved.set(k,'changed');assert.equal((await g.api('pull/advance',{...g.fp,credentials:null})).body.error,'server_pull_reconciliation_required');
});
for(const phase of ['reserve','ack'])for(const epoch of [0,2])test('atomic '+phase+' transaction rejects global session epoch change after precheck, epoch '+epoch,async()=>{
 const f=await pullFixture({epoch});await f.consent();await f.ok('start');await f.advance();
 if(phase==='ack'){await f.advance();await f.advance();}
 const accountKey={pk:'TENANT#'+tenant,sk:'META'},account=f.client._get(accountKey),beforeBytes=account.used_bytes,send=f.client.send.bind(f.client);let raced=false;
 f.client.send=async command=>{const items=command.input?.TransactItems;
  if(items?.some(item=>phase==='reserve'?item.Put?.Item?.sk?.startsWith('BATCH#'):item.Update?.Key?.sk?.startsWith('BATCH#'))){
   const actions=items.filter(item=>Object.values(item).some(value=>value.Key?.pk===accountKey.pk&&value.Key?.sk==='META'));
   assert.equal(actions.length,1,'exactly one transaction action may target tenant META');assert.equal(actions[0].Update.ExpressionAttributeValues[':pull_epoch'],epoch);assert.equal(actions[0].Update.ExpressionAttributeNames['#pull_epoch'],'session_epoch');
   if(!raced){raced=true;f.client._get(accountKey).session_epoch=epoch+1;}
  }
  return send(command);
 };
 const result=await f.api('pull/advance',{...f.fp,credentials:null});assert.notEqual(result.status,200);assert.equal(raced,true);assert.equal(f.client._get(accountKey).used_bytes,beforeBytes);
 const batches=[...f.client.items.values()].filter(r=>r.pk==='TENANT#'+tenant&&r.sk.startsWith('BATCH#'));
 if(phase==='reserve')assert.equal(batches.length,0);else{assert.equal(batches.length,1);assert.equal(batches[0].status,'pending');assert.equal([...f.client.items.values()].filter(r=>r.sk.startsWith('RUN#')).length,0);}
});
test('empty matching source is a truthful terminal outcome without run, batch or object claims',async()=>{
 const f=await pullFixture();f.provider(async url=>Response.json(url.endsWith('/projects')?{data:[{id:spec.sourceProject}]}:{data:[],meta:{cursor:null}}));await f.consent();await f.ok('start');const result=await f.advance();assert.equal(result.status,'empty');assert.equal(result.run_id,null);assert.equal(result.stored_bytes_verified,false);assert.equal(result.export_verified,false);assert.equal(result.progress.verified_batches,0);assert.equal(f.puts(),0);assert.equal([...f.client.items.values()].some(r=>r.sk.startsWith('RUN#')||r.sk.startsWith('BATCH#')),false);const calls=f.fetches();assert.equal((await f.advance()).status,'empty');assert.equal(f.fetches(),calls);
});
