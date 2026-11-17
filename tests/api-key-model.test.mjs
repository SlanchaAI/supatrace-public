import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {handle,KEY_USE_STAMP_MS} from '../src/aws-api.mjs';
import {keyBinding} from '../src/aws-auth.mjs';
import {DynamoMetadataStore,digest} from '../src/dynamodb-store.mjs';
import {MemoryDynamo,commandClasses} from './memory-dynamo.mjs';
import {alphaProject} from '../src/alpha-projects.mjs';
import {createFixtureSession} from './fixture-session.mjs';
import {KEY_PREFIX,NO_EXPIRY,ROTATION_OVERLAP,parseKeyToken,keyScopes} from '../src/key-model.mjs';
import {PLANS} from '../src/plans.mjs';
import {planLimits} from '../src/plan-limits.mjs';
import {UPGRADE_PATH} from '../src/entitlements.mjs';

const origin='https://supatrace.dev',START=2000000000;
// The cheapest plan with room for the handful of keys a test holds at once when the cap is not its subject.
const ROOMY=PLANS.plans.find(plan=>plan.api_keys===null||plan.api_keys>=6).id;
// Stable synthetic identities keep bounded-rate-slot collisions reproducible across CI runs.
let minted=0;
const mint=type=>(type==='legacy'?'':KEY_PREFIX[type])+createHash('sha256').update('synthetic-key-'+(++minted)).digest('base64url');
// Accounts are on Free unless a test asks for a plan, as in production. `plan` is stamped on the account rows the way
// a reconciled subscription or an operator would; the remaining options go to the store.
async function fixture({plan=null,...options}={}){
 let clock=START;
 const memory=new MemoryDynamo(),store=new DynamoMetadataStore({client:memory,commands:commandClasses(),tableName:'synthetic',now:()=>clock,...options}),saved=new Map(),tokens={};
 for(const n of [1,2]){const t=await store.getOrCreateTenant(n);tokens[t.tenant_id]=await createFixtureSession(store,t.tenant_id);}
 const setPlan=(actor,id)=>{const key=`TENANT#${actor}\0META`,row=memory.items.get(key);assert.ok(row,'account row');memory.items.set(key,{...row,plan_id:id});};
 if(plan)for(const actor of Object.keys(tokens))setPlan(actor,plan);
 const env={ENABLED:true,APP_ORIGIN:origin,GITHUB_CLIENT_ID:'synthetic',GITHUB_CLIENT_SECRET:'synthetic',store,objects:{putImmutable:async(k,v)=>saved.set(k,v),get:async k=>saved.get(k)}};
 const api=(actor,path,body)=>handle(new Request(new URL('/api/'+path,origin),{method:body===undefined?'GET':'POST',headers:{cookie:'__Host-supatrace='+tokens[actor],origin,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);
 const create=async(type,extra={},actor='github-1',query='')=>{const token=mint(type),r=await api(actor,'keys/create'+query,{key_hash:digest(token),key_type:type,...extra});return {token,response:r,body:await r.clone().json()};};
 const legacy=async(actor='github-1',expected=200)=>{const token=mint('legacy'),r=await handle(new Request(origin+'/api/setup/start?project='+alphaProject(actor).id,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key_hash:digest(token)})}),env);assert.equal(r.status,201);const approved=await api(actor,'setup/approve',{user_code:(await r.json()).user_code});assert.equal(approved.status,expected);return expected===200?token:{token,response:approved,body:await approved.clone().json()};};
 let batches=0;
 const upload=(token,owner='github-1')=>{const raw=JSON.stringify({version:1,batch_id:'batch-'+(++batches),run_id:'run-1',events:[{id:'event',time:'2026-11-05T00:00:00Z',kind:'note',name:'Synthetic',data:{n:batches}}]});return handle(new Request(origin+'/api/batches?project='+alphaProject(owner).id,{method:'POST',headers:{'content-type':'application/json','x-supatrace-key':token,'x-amz-content-sha256':digest(raw)},body:raw}),env);};
 const keyed=(path,token)=>handle(new Request(origin+path,{headers:{'x-supatrace-key':token}}),env);
 const list=async(actor='github-1')=>(await (await api(actor,'keys')).json()).keys;
 return {env,store,memory,tokens,api,create,legacy,upload,keyed,list,setPlan,advance:seconds=>{clock+=seconds;},now:()=>clock};
}

test('token grammar separates legacy, publishable and secret keys by exact shape',()=>{
 assert.deepEqual(parseKeyToken('a'.repeat(43)),{type:'legacy'});
 assert.deepEqual(parseKeyToken('st_pub_'+'a'.repeat(43)),{type:'publishable'});
 assert.deepEqual(parseKeyToken('st_sec_'+'a'.repeat(43)),{type:'secret'});
 for(const bad of ['', 'st_pub_'+'a'.repeat(42),'st_pub_'+'a'.repeat(44),'st_xyz_'+'a'.repeat(43),'ST_PUB_'+'a'.repeat(43),'st_pub_'+'a'.repeat(42)+'!',' st_pub_'+'a'.repeat(43),null,undefined,42])assert.equal(parseKeyToken(bad),null);
 assert.deepEqual([...keyScopes('publishable')],['write']);assert.deepEqual([...keyScopes('legacy')],['write']);assert.deepEqual([...keyScopes('secret')],['read','write']);assert.deepEqual(keyScopes('other'),[]);
});

test('both key types are created without an expiry, listed by hash only, and accepted for ingest',async()=>{
 const f=await fixture();
 for(const type of ['publishable','secret']){
  const {token,response,body}=await f.create(type);
  assert.equal(response.status,201);assert.equal(body.key_type,type);assert.equal(body.no_expiry,true);assert.equal(body.expires_at,NO_EXPIRY);assert.equal(body.id,digest(token));assert.equal(body.scope,type==='secret'?'read_write':'write_only');
  assert.equal((await f.upload(token)).status,201);
 }
 const rows=await f.list();assert.equal(rows.length,2);
 assert.deepEqual(rows.map(row=>[row.key_type,row.scope,row.no_expiry]).sort(),[['publishable','write_only',true],['secret','read_write',true]]);
 // Neither the store nor any response holds key material: only SHA-256 hashes.
 const dump=JSON.stringify([...f.memory.items.values()])+JSON.stringify(rows);assert.doesNotMatch(dump,/st_pub_|st_sec_/);
});

test('an ingest key can never read: every session read route rejects it, and the read scope is refused',async()=>{
 const f=await fixture({plan:ROOMY}),{token}=await f.create('publishable'),legacy=await f.legacy(),project=alphaProject('github-1').id;
 assert.equal((await f.upload(token)).status,201);
 for(const path of ['/api/runs','/api/runs/page','/api/events?run=run-1','/api/keys','/api/workspace','/api/projects','/api/me','/api/usage','/api/imports/capabilities','/api/workspaces','/api/environments','/api/billing/status'])
  for(const key of [token,legacy]){const r=await f.keyed(path+(path.includes('?')?'&':'?')+'project='+project,key);assert.equal(r.status,401,path);assert.doesNotMatch(await r.text(),/run-1|token_hash/);}
 const request=key=>new Request(origin+'/api/batches',{headers:{'x-supatrace-key':key}});
 for(const key of [token,legacy])await assert.rejects(keyBinding(request(key),f.store,'read'),{status:403,code:'key_scope_denied'});
 const secret=(await f.create('secret')).token;
 assert.equal((await keyBinding(request(secret),f.store,'read')).key_type,'secret');
 assert.equal((await keyBinding(request(secret),f.store,'write')).key_type,'secret');
});

test('a key is bound to its prefix: the same secret under another prefix, or no prefix, is rejected',async()=>{
 const f=await fixture({plan:ROOMY}),{token}=await f.create('publishable'),body=token.slice(KEY_PREFIX.publishable.length);
 for(const forged of [KEY_PREFIX.secret+body,body])assert.equal((await f.upload(forged)).status,401);
 // A hash registered as secret for a publishable-shaped token never authenticates as either type.
 const mismatched=mint('publishable');assert.equal((await f.api('github-1','keys/create',{key_hash:digest(mismatched),key_type:'secret'})).status,201);
 assert.equal((await f.upload(mismatched)).status,401);
 const legacy=await f.legacy();for(const forged of [KEY_PREFIX.publishable+legacy,KEY_PREFIX.secret+legacy])assert.equal((await f.upload(forged)).status,401);
});

test('existing 30-day pairing keys keep working until their own expiry and are listed as legacy',async()=>{
 const f=await fixture(),legacy=await f.legacy();
 assert.equal((await f.upload(legacy)).status,201);
 const [row]=await f.list();assert.equal(row.key_type,'legacy');assert.equal(row.scope,'write_only');assert.equal(row.no_expiry,false);assert.equal(row.expires_at,START+2592000);
 f.advance(2592000-1);assert.equal((await f.upload(legacy)).status,201);
 f.advance(1);assert.equal((await f.upload(legacy)).status,401);
 // A key row written before this change has no key_type at all.
 const old=mint('legacy'),hash=digest(old),record={token_hash:hash,tenant_id:'github-1',project_id:alphaProject('github-1').id,scope:'write',expires_at:f.now()+100,revoked:false,slot:9,created_at:f.now()};
 f.memory.items.set(`WRITE#${hash}\0KEY`,{pk:`WRITE#${hash}`,sk:'KEY',...record});
 assert.equal((await f.upload(old)).status,201);f.advance(100);assert.equal((await f.upload(old)).status,401);
});

test('a typed key without expiry outlives the legacy window; an optional expiry is honoured and bounded',async()=>{
 const f=await fixture(),forever=(await f.create('publishable')).token,timed=await f.create('secret',{expires_in:3600});
 assert.equal(timed.body.no_expiry,false);assert.equal(timed.body.expires_at,START+3600);
 f.advance(3599);assert.equal((await f.upload(timed.token)).status,201);
 f.advance(1);assert.equal((await f.upload(timed.token)).status,401);
 // Ten idle years also pause a Free project (#113). Resume it: this test is about the key, which must still work.
 f.advance(10*365*86400);assert.equal((await f.upload(forever)).status,403);await f.store.resumeProject('github-1');assert.equal((await f.upload(forever)).status,201);
 for(const expires_in of [0,3599,31536001,-1,1.5,'3600',true])assert.equal((await f.store.createApiKey('github-1',{key_hash:digest(mint('secret')),key_type:'secret',expires_in}).then(()=>0,e=>e.status)),400);
});

test('rotation issues a same-type replacement and the old key dies after the overlap window',async()=>{
 const f=await fixture(),old=await f.create('publishable'),next=mint('publishable');
 const r=await f.api('github-1','keys/rotate',{id:old.body.id,key_hash:digest(next)});assert.equal(r.status,201);const body=await r.json();
 assert.equal(body.rotated,true);assert.equal(body.key.key_type,'publishable');assert.equal(body.key.no_expiry,true);assert.equal(body.key.scope,'write_only');assert.equal(body.previous.expires_at,START+ROTATION_OVERLAP.default);
 assert.equal((await f.upload(old.token)).status,201);assert.equal((await f.upload(next)).status,201);
 const rows=await f.list(),previous=rows.find(row=>row.id===old.body.id);assert.equal(previous.rotated,true);assert.equal(previous.no_expiry,false);assert.equal(rows.find(row=>row.id===digest(next)).rotated,undefined);
 // Repeating the same request returns the same replacement; a different replacement is refused.
 const again=await f.api('github-1','keys/rotate',{id:old.body.id,key_hash:digest(next)});assert.equal(again.status,201);assert.equal((await again.json()).key.id,digest(next));
 assert.equal((await f.api('github-1','keys/rotate',{id:old.body.id,key_hash:digest(mint('publishable'))})).status,409);
 f.advance(ROTATION_OVERLAP.default-1);assert.equal((await f.upload(old.token)).status,201);
 f.advance(1);assert.equal((await f.upload(old.token)).status,401);assert.equal((await f.upload(next)).status,201);
});

test('rotation never extends an expiry, honours a zero overlap, keeps a chosen lifetime and rejects bad input',async()=>{
 const f=await fixture({plan:ROOMY}),timed=await f.create('secret',{expires_in:7200}),next=mint('secret');
 const r=await f.api('github-1','keys/rotate',{id:timed.body.id,key_hash:digest(next),overlap_seconds:ROTATION_OVERLAP.max});const body=await r.json();
 assert.equal(body.previous.expires_at,START+7200);assert.equal(body.key.key_type,'secret');assert.equal(body.key.expires_at,START+7200);
 const now=await f.create('publishable'),replacement=mint('publishable');
 assert.equal((await f.api('github-1','keys/rotate',{id:now.body.id,key_hash:digest(replacement),overlap_seconds:0})).status,201);
 assert.equal((await f.upload(now.token)).status,401);assert.equal((await f.upload(replacement)).status,201);
 f.advance(60);const live=await f.create('publishable');
 for(const bad of [{overlap_seconds:-1},{overlap_seconds:ROTATION_OVERLAP.max+1},{overlap_seconds:1.5},{overlap_seconds:'60'},{extra:true}])assert.equal((await f.api('github-1','keys/rotate',{id:live.body.id,key_hash:digest(mint('publishable')),...bad})).status,400);
 f.advance(60);assert.equal((await f.api('github-1','keys/rotate',{id:live.body.id,key_hash:live.body.id})).status,400);
 assert.equal((await f.api('github-1','keys/rotate',{id:digest('missing'),key_hash:digest(mint('publishable'))})).status,404);
 // Another account can neither rotate nor learn about the key.
 assert.equal((await f.api('github-2','keys/rotate',{id:live.body.id,key_hash:digest(mint('publishable'))})).status,404);
 assert.equal((await f.upload(live.token)).status,201);
 // Pairing keys are not rotated in place.
 const legacy=await f.legacy();assert.equal((await f.api('github-1','keys/rotate',{id:digest(legacy),key_hash:digest(mint('publishable'))})).status,409);
});

test('revocation stops a typed key at once, frees its slot, and a revoked or rotated-out key cannot be rotated',async()=>{
 const f=await fixture(),key=await f.create('secret');
 assert.equal((await f.upload(key.token)).status,201);
 assert.equal((await f.api('github-1','keys/revoke',{id:key.body.id})).status,200);
 assert.equal((await f.upload(key.token)).status,401);
 assert.equal((await f.api('github-1','keys/rotate',{id:key.body.id,key_hash:digest(mint('secret'))})).status,409);
 assert.equal((await f.list())[0].revoked,true);
 // Revoking the old key during the overlap ends it early; the replacement is unaffected.
 const old=await f.create('publishable'),next=mint('publishable');assert.equal((await f.api('github-1','keys/rotate',{id:old.body.id,key_hash:digest(next)})).status,201);
 assert.equal((await f.api('github-1','keys/revoke',{id:old.body.id})).status,200);assert.equal((await f.upload(old.token)).status,401);assert.equal((await f.upload(next)).status,201);
 // Recreating a revoked key's hash never reactivates it.
 assert.equal((await f.api('github-1','keys/create',{key_hash:key.body.id,key_type:'secret'})).status,409);assert.equal((await f.upload(key.token)).status,401);
});

// What a refusal at the plan's count must say: the plan, its limit, the count in use and the next plan that raises it.
const planRefusal=(planId,used)=>{const limit=planLimits(planId).api_keys,next=PLANS.plans.slice(PLANS.plans.findIndex(plan=>plan.id===planId)+1).find(plan=>plan.api_keys===null||plan.api_keys>limit);return {error:'plan_limit_reached',limit_name:'api_keys',plan:planId,limit,used,...(next?{required_plan:next.id}:{}),upgrade_url:UPGRADE_PATH};};
const assertPlanRefusal=(result,planId,used)=>{
 assert.equal(result.response.status,402);const {message,...rest}=result.body;assert.deepEqual(rest,planRefusal(planId,used));
 assert.equal(typeof message,'string');assert.ok(message.includes(planLimits(planId).name)&&message.includes(String(planLimits(planId).api_keys)),message);
};
test('the plan decides the active-key cap: Free refuses every key type with 402 and the upgrade, a revoke frees a slot, a higher plan raises it',async()=>{
 const free=planLimits('free').api_keys,base=planLimits('base').api_keys;assert.equal(free,PLANS.plans.find(plan=>plan.id==='free').api_keys);assert.ok(free>=2&&base>free);
 const f=await fixture(),first=await f.create('publishable');assert.equal(first.response.status,201);
 // Fill the rest of the Free count with pairing keys: they hold slots like typed keys do.
 for(let held=1;held<free;held++)await f.legacy();
 for(const type of ['publishable','secret'])assertPlanRefusal(await f.create(type),'free',free);
 assertPlanRefusal(await f.legacy('github-1',402),'free',free);
 // Rotation transfers a lease, so a full account can rotate while refusing a net-new key.
 const next=mint('publishable');assert.equal((await f.api('github-1','keys/rotate',{id:first.body.id,key_hash:digest(next)})).status,201);
 assert.equal((await f.upload(first.token)).status,201);assert.equal((await f.upload(next)).status,201);
 assertPlanRefusal(await f.create('publishable'),'free',free);
 assert.equal((await (await f.api('github-1','entitlements')).json()).usage.api_keys,free,'overlap keys are not counted twice in Billing');
 // Revoking the overlapping old key must not release its replacement's lease.
 assert.equal((await f.api('github-1','keys/revoke',{id:first.body.id})).status,200);
 assertPlanRefusal(await f.create('publishable'),'free',free);assert.equal((await f.upload(next)).status,201);
 assert.equal((await f.create('secret',{},'github-2')).response.status,201);
 const pairing=(await f.list()).find(row=>row.key_type==='legacy');assert.equal((await f.api('github-1','keys/revoke',{id:pairing.id})).status,200);
 const secret=await f.create('secret');assert.equal(secret.response.status,201);assertPlanRefusal(await f.create('publishable'),'free',free);
 // A higher plan raises the count to its own number, and refuses there naming the plan after it.
 // Filling Base takes more key requests than the per-minute limiter allows; the limiter is not the subject here.
 f.store.consumeRate=async()=>({allowed:true,hits:1,retry_after:60});
 f.setPlan('github-1','base');
 for(let held=free;held<base;held++)assert.equal((await f.create(held%2?'secret':'publishable')).response.status,201,'key '+(held+1)+' of '+base);
 assertPlanRefusal(await f.create('publishable'),'base',base);assert.equal((await f.list()).filter(row=>!row.revoked).length,base);
 // Back on Free the keys above the count keep working and nothing new is issued.
 f.setPlan('github-1','free');assert.equal((await f.upload(next)).status,201);assertPlanRefusal(await f.create('publishable'),'free',base);
 // An unknown plan id never grants more than Free.
 f.setPlan('github-2','platinum');for(let held=1;held<free;held++)assert.equal((await f.create('publishable',{},'github-2')).response.status,201);
 assertPlanRefusal(await f.create('publishable',{},'github-2'),'free',free);
});

test('rotation at the hard ceiling keeps one lease through overlap, expiry, and old-key revocation',async()=>{
 const ceiling=3;assert.ok(planLimits(ROOMY).api_keys>ceiling);
 const f=await fixture({activeKeys:ceiling,plan:ROOMY}),first=await f.create('publishable');await f.create('secret');await f.legacy();
 assert.equal((await f.create('publishable')).response.status,409);
 const next=mint('publishable');assert.equal((await f.api('github-1','keys/rotate',{id:first.body.id,key_hash:digest(next)})).status,201);
 assert.equal((await f.upload(first.token)).status,201);assert.equal((await f.upload(next)).status,201);
 assert.equal((await f.create('publishable')).response.status,409);
 f.advance(ROTATION_OVERLAP.default);
 assert.equal((await f.upload(first.token)).status,401);assert.equal((await f.upload(next)).status,201);
 await f.store.revokeWriteKey('github-1',first.body.id);
 await assert.rejects(f.store.createApiKey('github-1',{key_hash:digest(mint('publishable')),key_type:'publishable'}),e=>e.code==='active_key_capacity');
 await f.store.revokeWriteKey('github-1',digest(next));
 assert.equal((await f.store.createApiKey('github-1',{key_hash:digest(mint('publishable')),key_type:'publishable'})).no_expiry,true);
 assert.equal((await fixture()).store.limits.activeKeys,Math.max(...PLANS.plans.map(plan=>plan.api_keys)));
});

test('creation is session-only, idempotent for the same request, and strict about its fields',async()=>{
 const f=await fixture(),token=mint('publishable'),body={key_hash:digest(token),key_type:'publishable'};
 const first=await f.api('github-1','keys/create',body),second=await f.api('github-1','keys/create',body);
 assert.equal(first.status,201);assert.deepEqual(await second.json(),await first.json());assert.equal((await f.list()).length,1);
 assert.equal((await f.api('github-1','keys/create',{...body,key_type:'secret'})).status,409);
 assert.equal((await f.api('github-2','keys/create',body)).status,409);
 for(const bad of [{key_hash:'x',key_type:'publishable'},{key_hash:digest('a'),key_type:'legacy'},{key_hash:digest('a'),key_type:'admin'},{key_hash:digest('a')},{key_hash:digest('a'),key_type:'secret',tenant_id:'github-2'},{key_hash:digest('a'),key_type:'secret',scope:'read'}])assert.equal((await f.api('github-1','keys/create',bad)).status,400,JSON.stringify(bad));
 // No session: a key in the header does not authorize issuing keys, and neither does nothing at all.
 const secret=(await f.create('secret')).token;
 for(const headers of [{'x-supatrace-key':secret},{}]){const r=await handle(new Request(origin+'/api/keys/create',{method:'POST',headers:{...headers,origin,'content-type':'application/json'},body:JSON.stringify({key_hash:digest(mint('secret')),key_type:'secret'})}),f.env);assert.equal(r.status,401);}
 // A cross-origin browser request is refused even with a session.
 assert.equal((await handle(new Request(origin+'/api/keys/create',{method:'POST',headers:{cookie:'__Host-supatrace='+f.tokens['github-1'],origin:'https://evil.example','content-type':'application/json'},body:JSON.stringify(body)}),f.env)).status,403);
});

test('last use is stamped at most hourly for typed and legacy keys; a failing stamp does not fail an upload',async()=>{
 const f=await fixture(),key=await f.create('publishable'),legacy=await f.legacy();
 assert.equal((await f.list()).every(row=>row.last_used_at===undefined),true);
 assert.equal((await f.upload(key.token)).status,201);assert.equal((await f.upload(legacy)).status,201);
 assert.deepEqual((await f.list()).map(row=>row.last_used_at),[START,START]);
 f.advance(3599);await f.upload(key.token);assert.equal((await f.list()).find(row=>row.id===key.body.id).last_used_at,START);
 f.advance(1);await f.upload(key.token);assert.equal((await f.list()).find(row=>row.id===key.body.id).last_used_at,START+3600);
 f.store.touchKeyUse=async()=>{throw new Error('synthetic outage');};f.advance(7200);assert.equal((await f.upload(key.token)).status,201);
});
// The base added bearer and Langfuse-style Basic key transport and OTLP ingest. Typed keys must
// work over each of them, with the same type binding, scope and last-use rules as x-supatrace-key.
const otlpBody=()=>JSON.stringify({resourceSpans:[{resource:{attributes:[]},scopeSpans:[{scope:{name:'synthetic'},spans:[{traceId:randomBytes(16).toString('hex'),spanId:randomBytes(8).toString('hex'),name:'chat',kind:1,startTimeUnixNano:'1794614400000000000',endTimeUnixNano:'1794614401000000000',attributes:[]}]}]}]});
const otlp=(f,path,authorization)=>handle(new Request(origin+path,{method:'POST',headers:{'content-type':'application/json',authorization},body:otlpBody()}),f.env);
const basic=secret=>'Basic '+Buffer.from('pk-supatrace:'+secret).toString('base64');
test('typed keys ingest over bearer OTLP and Langfuse-style Basic, bound to their prefix, and stamp last use there too',async()=>{
 const f=await fixture({plan:ROOMY}),pub=await f.create('publishable'),sec=await f.create('secret'),legacy=await f.legacy();
 for(const token of [pub.token,sec.token,legacy]){
  assert.equal((await otlp(f,'/v1/traces','Bearer '+token)).status,200,'bearer OTLP');
  assert.equal((await otlp(f,'/api/public/otel/v1/traces',basic(token))).status,200,'Basic on the Langfuse OTLP route');
 }
 // Last use is recorded by an OTLP upload, not only by /api/batches.
 assert.deepEqual((await f.list()).map(row=>row.last_used_at),[START,START,START]);
 // The same secret under the other prefix, a bare secret, a wrong-case prefix and an unknown key are all refused.
 const bare=pub.token.slice(KEY_PREFIX.publishable.length);
 for(const token of [KEY_PREFIX.secret+bare,bare,'ST_PUB_'+bare,'st_pub_'+'x'.repeat(43),'st_pub_'+bare+'x'])assert.equal((await otlp(f,'/v1/traces','Bearer '+token)).status,401,token.slice(0,8));
 // Basic is honoured only on the Langfuse-compatible routes, for typed keys as for legacy ones.
 assert.equal((await otlp(f,'/v1/traces',basic(pub.token))).status,401);
 // A revoked typed key stops on every transport at once.
 assert.equal((await f.api('github-1','keys/revoke',{id:pub.body.id})).status,200);
 assert.equal((await otlp(f,'/v1/traces','Bearer '+pub.token)).status,401);assert.equal((await otlp(f,'/api/public/otel/v1/traces',basic(pub.token))).status,401);assert.equal((await f.upload(pub.token)).status,401);
});
test('a bearer or Basic ingest key still cannot read: session read routes ignore it',async()=>{
 const f=await fixture(),pub=await f.create('publishable');assert.equal((await f.upload(pub.token)).status,201);
 for(const path of ['/api/runs','/api/runs/page','/api/events?run=run-1','/api/usage','/api/keys'])for(const authorization of ['Bearer '+pub.token,basic(pub.token)]){
  const response=await handle(new Request(origin+path,{headers:{authorization}}),f.env);assert.ok([401,403].includes(response.status),path+' '+response.status);
 }
});
test('the one read a write-only key has: the Langfuse auth check returns its own project id and name, nothing else',async()=>{
 const f=await fixture(),pub=await f.create('publishable'),legacy=await f.legacy(),other=await f.create('publishable',{},'github-2');
 assert.equal((await f.upload(pub.token)).status,201);
 const check=token=>handle(new Request(origin+'/api/public/projects',{headers:{authorization:basic(token)}}),f.env);
 for(const token of [pub.token,legacy]){
  const response=await check(token);assert.equal(response.status,200);const body=await response.json();
  assert.deepEqual(Object.keys(body),['data']);assert.equal(body.data.length,1);assert.deepEqual(Object.keys(body.data[0]).sort(),['id','metadata','name','organization']);
  assert.equal(body.data[0].id,alphaProject('github-1').id);assert.deepEqual(body.data[0].metadata,{});assert.deepEqual(Object.keys(body.data[0].organization).sort(),['id','name']);
  assert.doesNotMatch(JSON.stringify(body),/run-1|batch-|key_hash|used_bytes|github-2/);
 }
 // Another account's key sees only its own project; a revoked or unknown key sees nothing.
 assert.equal((await (await check(other.token)).json()).data[0].id,alphaProject('github-2').id);
 assert.equal((await f.api('github-1','keys/revoke',{id:pub.body.id})).status,200);assert.equal((await check(pub.token)).status,401);assert.equal((await check('st_pub_'+'x'.repeat(43))).status,401);
});
test('a stalled last-use stamp delays the receipt by a bounded wait only, after the batch is accepted',async()=>{
 const f=await fixture(),key=await f.create('publishable');let release;
 f.store.touchKeyUse=()=>new Promise(resolve=>{release=resolve;});
 const started=Date.now(),r=await f.upload(key.token),waited=Date.now()-started;
 assert.equal(r.status,201);assert.equal((await r.json()).accepted,true);
 assert.ok(waited>=KEY_USE_STAMP_MS-20&&waited<KEY_USE_STAMP_MS+2000,'waited '+waited+' ms');
 assert.equal(typeof release,'function');release();
 // A slow stamp that rejects after the receipt is not an unhandled rejection and changes nothing.
 f.store.touchKeyUse=()=>new Promise((_,reject)=>setTimeout(()=>reject(new Error('late synthetic outage')),KEY_USE_STAMP_MS+50));
 assert.equal((await f.upload(key.token)).status,201);await new Promise(resolve=>setTimeout(resolve,150));
 // A prompt stamp does not wait for the bound.
 f.store.touchKeyUse=async()=>true;const quick=Date.now();assert.equal((await f.upload(key.token)).status,201);assert.ok(Date.now()-quick<KEY_USE_STAMP_MS);
});

// Secret-key reads (#105): the `read` scope is real on /api/v1, bound to the key's own workspace and environment.
const v1=(f,path,headers)=>handle(new Request(origin+'/api/v1/'+path,{headers}),f.env);
test('a secret key reads traces and events of its own workspace over /api/v1, by bearer or x-supatrace-key',async()=>{
 const f=await fixture(),secret=await f.create('secret');assert.equal((await f.upload(secret.token)).status,201);
 for(const headers of [{authorization:'Bearer '+secret.token},{'x-supatrace-key':secret.token}]){
  const traces=await v1(f,'traces',headers);assert.equal(traces.status,200);assert.ok(JSON.stringify(await traces.json()).includes('run-1'));
  const events=await v1(f,'traces/run-1/events',headers);assert.equal(events.status,200);assert.equal((await events.json()).events.length,1);
  assert.equal((await v1(f,'traces?workspace=github-1&environment=default',headers)).status,200);
 }
});
test('a secret key is confined: no account routes, no key list, no workspace-wide usage, no other workspace or environment, and no session routes',async()=>{
 const f=await fixture(),secret=await f.create('secret'),headers={authorization:'Bearer '+secret.token};assert.equal((await f.upload(secret.token)).status,201);
 for(const path of ['me','workspaces','projects','keys','usage','usage?workspace=github-1','traces?workspace=github-2','traces?environment=staging','usage?workspace=github-2','traces/run-1/events?workspace=github-2']){
  const response=await v1(f,path,headers);assert.equal(response.status,403,path);assert.equal((await response.json()).error,'key_scope_denied',path);
 }
 for(const path of ['/api/runs','/api/events?run=run-1','/api/usage','/api/keys','/api/tokens']){const response=await handle(new Request(origin+path,{headers}),f.env);assert.ok([401,403].includes(response.status),path+' '+response.status);}
 const posted=await handle(new Request(origin+'/api/v1/traces',{method:'POST',headers}),f.env);assert.equal(posted.status,405);
});
test('only a live secret key reads: ingest and pairing keys, a wrong prefix and a revoked secret key are refused on /api/v1',async()=>{
 const f=await fixture({plan:ROOMY}),pub=await f.create('publishable'),legacy=await f.legacy(),secret=await f.create('secret');
 for(const token of [pub.token,legacy,KEY_PREFIX.secret+pub.token.slice(KEY_PREFIX.publishable.length),KEY_PREFIX.secret+'a'.repeat(43)]){const response=await v1(f,'traces',{authorization:'Bearer '+token});assert.equal(response.status,401,token.slice(0,7));}
 assert.equal((await v1(f,'traces',{authorization:'Bearer '+secret.token})).status,200);
 assert.equal((await f.api('github-1','keys/revoke',{id:digest(secret.token)})).status,200);
 assert.equal((await v1(f,'traces',{authorization:'Bearer '+secret.token})).status,401);
});
test('a secret key of a non-default environment reads that environment only, and never workspace-wide usage',async()=>{
 const f=await fixture();assert.equal((await f.api('github-1','environments',{id:'staging',name:'Staging'})).status,201);
 const staging=await f.create('secret',{},'github-1','?environment=staging'),main=await f.create('secret');assert.equal(staging.response.status,201);
 const raw=JSON.stringify({version:1,batch_id:'batch-staging',run_id:'run-staging',events:[{id:'event',time:'2026-11-05T00:00:00Z',kind:'note',name:'Synthetic',data:{}}]});
 const sent=await handle(new Request(origin+'/api/batches?project='+alphaProject('github-1').id+'&environment=staging',{method:'POST',headers:{'content-type':'application/json','x-supatrace-key':staging.token,'x-amz-content-sha256':digest(raw)},body:raw}),f.env);assert.equal(sent.status,201);
 assert.equal((await f.upload(main.token)).status,201);
 const mine=JSON.stringify(await (await v1(f,'traces',{authorization:'Bearer '+staging.token})).json());assert.ok(mine.includes('run-staging'));assert.ok(!mine.includes('run-1'));
 const other=JSON.stringify(await (await v1(f,'traces',{authorization:'Bearer '+main.token})).json());assert.ok(other.includes('run-1'));assert.ok(!other.includes('run-staging'));
 assert.equal((await v1(f,'traces/run-staging/events',{authorization:'Bearer '+staging.token})).status,200);
 for(const path of ['traces?environment=default','traces/run-1/events?environment=default','usage']){const response=await v1(f,path,{authorization:'Bearer '+staging.token});assert.equal(response.status,403,path);assert.equal((await response.json()).error,'key_scope_denied',path);}
 const cross=await v1(f,'traces/run-1/events',{authorization:'Bearer '+staging.token});assert.ok(cross.status===404||(cross.status===200&&(await cross.json()).events.length===0),'default-environment run is not readable with a staging key: '+cross.status);
});
