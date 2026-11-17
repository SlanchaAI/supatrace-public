import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {Client,InMemoryTransport} from '@modelcontextprotocol/client';
import {start} from '../../tests/harness.mjs';
import {alphaProject} from '../../src/alpha-projects.mjs';
import {mcpBridgeStore,bridgeScope,bridgeScopeHash} from '../../src/mcp-bridge-store.mjs';
import {createTraceReader} from '../reader.mjs';
import {createMcpServer} from '../server.mjs';
import {connectBridge} from '../connect.mjs';
import {convertConnectorFile} from '../../src/importers/connector-files.mjs';
import {fixtures as connectorFixtures,marker} from '../../tests/connector-fixtures.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
// Live sessions share 1,000 hash slots, so a random token can land on a slot the fixture's own sessions hold.
// Sign-in retries with a fresh token on that refusal (src/aws-auth.mjs issueSession); a second parent session here does the same.
async function parentSession(store,tenantId,expiresAt){for(;;){const token=randomBytes(32).toString('base64url');try{await store.createSession(hash(token),tenantId,expiresAt);return token;}catch(error){if(error?.code!=='session_slot_collision')throw error;}}}
async function fixture(content='metadata',enabled=true){
 const live=await start({mcp:enabled});let cookies,foreignCookies;
 const tenant=await live.signIn({addCookies:async c=>cookies=c}),foreign=await live.signIn({addCookies:async c=>foreignCookies=c},9999);
 const session=cookies.map(c=>c.name+'='+c.value).join('; '),other=foreignCookies.map(c=>c.name+'='+c.value).join('; ');
 const scope={origin:'https://supatrace.dev',tenantId:tenant,projectId:alphaProject(tenant).id,content,runIds:['bridge-proof']},client='Synthetic SDK client';
 const key=await live.writeKey(tenant),events=[{id:'root',time:'2026-11-01T00:00:00.000Z',kind:'request',name:'PRIVATE_NAME',data:{prompt:'PRIVATE_PROMPT'}},{id:'child',time:'2026-11-01T00:00:01.000Z',kind:'response',name:'PRIVATE_OUTPUT',data:{parent:'root',output:'PRIVATE_ANSWER'}}];
 for(const [i,event]of events.entries())await live.upload(key,{version:1,run_id:'bridge-proof',batch_id:'proof-'+i,events:[event]});
 await live.upload(key,{version:1,run_id:'not-approved',batch_id:'excluded',events:[events[0]]});
 async function api(path,{method='GET',body,cookie=session,origin=scope.origin}={}){return fetch(live.origin+'/api/'+path,{method,headers:{...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{}),...(origin?{origin}:{})},body:body?JSON.stringify(body):undefined});}
 const token=randomBytes(32).toString('base64url'),cap='__Host-supatrace-mcp='+token;
 async function register(){const r=await api('mcp/requests',{method:'POST',cookie:null,body:{tokenHash:hash(token),scope:{...scope,client}}});assert.equal(r.status,201);return r.json();}
 async function approve(code,extra={}){return api('mcp/approve',{method:'POST',body:{code,consent:{confirmed:true,content,scopeHash:bridgeScopeHash({...scope,client})}},...extra});}
 const requests=[],fetchImpl=async(url,init)=>{const u=new URL(url),r=await fetch(live.origin+u.pathname+u.search,init);const bytes=await r.text();requests.push({path:u.pathname,requestCookie:init.headers.cookie,response:bytes});return new Response(bytes,{status:r.status,headers:r.headers});};
 return{live,scope,client,session,other,token,cap,events,api,register,approve,fetchImpl,requests,parentHash:hash(cookies[0].value),close:()=>live.close()};
}
for(const content of ['metadata','include'])test('browser consent -> actual SDK list/inspect/retrieve -> exact scoped stored data ('+content+')',async()=>{
 const e=await fixture(content);let bridge,server,client;
 try{
  let approval;
  bridge=await connectBridge(e.scope,e.client,{fetchImpl:e.fetchImpl,sleep:async()=>{await approval;},notify:info=>{assert.doesNotMatch(JSON.stringify(info),new RegExp(e.token));approval=e.approve(info.code).then(r=>assert.equal(r.status,200));}});
  const reader=createTraceReader(e.scope,{...bridge.dependencies,fetchImpl:e.fetchImpl});
  const [c,s]=InMemoryTransport.createLinkedPair();server=createMcpServer(reader);client=new Client({name:'bridge-acceptance',version:'1'});
  await server.connect(s);await client.connect(c);
  assert.equal((await client.listTools()).tools.length,4);
  const list=await client.callTool({name:'supatrace_list_traces',arguments:{}});assert.equal(list.isError,undefined);assert.equal(list.structuredContent.total,1);assert.equal(list.structuredContent.runs[0].id,'bridge-proof');
  const inspect=await client.callTool({name:'supatrace_inspect_trace',arguments:{runId:'bridge-proof'}});assert.equal(inspect.structuredContent.trace.events.length,2);assert.doesNotMatch(JSON.stringify(inspect),/PRIVATE_/);
  assert.ok(e.requests.filter(r=>r.path.endsWith('/events')).every(r=>!r.response.includes('PRIVATE_')),'metadata projection occurs on server');
  const result=await client.callTool({name:'supatrace_export_trace',arguments:{runId:'bridge-proof',includeContent:content==='include'}});assert.equal(result.isError,undefined);
  const exported=JSON.parse(result.structuredContent.json);assert.equal(result.structuredContent.sha256,hash(result.structuredContent.json));
  assert.deepEqual(exported.events,content==='include'?e.events:e.events.map(({id,time,kind})=>({id,time,kind})));
  assert.ok(e.requests.every(r=>r.requestCookie!==e.session),'browser account cookie is never copied to bridge');
  const denied=await client.callTool({name:'supatrace_inspect_trace',arguments:{runId:'not-approved'}});assert.equal(denied.isError,true);
  await bridge.close();const stopped=await client.callTool({name:'supatrace_list_traces',arguments:{}});assert.equal(stopped.isError,true);
 }finally{await client?.close();await server?.close();await bridge?.close();await e.close();}
});
test('default-off API cannot register or consume grants',async()=>{const e=await fixture('metadata',false);try{assert.equal((await e.api('mcp/requests',{method:'POST',body:{}})).status,404);assert.equal((await e.api('mcp/read/me')).status,404);}finally{await e.close();}});
test('approval requires the intended signed-in account, exact consent and origin; replay cannot renew',async()=>{
 const e=await fixture();try{
  const p=await e.register();assert.equal((await e.api('mcp/poll',{method:'POST',cookie:e.cap,body:{}})).status,200);
  assert.equal((await e.api('mcp/read/me?project='+e.scope.projectId,{cookie:e.cap})).status,401);
  assert.equal((await e.approve(p.code,{cookie:e.other})).status,403);
  assert.equal((await e.approve(p.code,{origin:'https://other.invalid'})).status,403);
  assert.equal((await e.approve(p.code,{body:{code:p.code,consent:{confirmed:false,content:'metadata'}}})).status,400);
  const approved=await e.approve(p.code);assert.equal(approved.status,200);assert.equal((await approved.json()).expiresAt,p.expiresAt);
  assert.equal((await e.approve(p.code)).status,409);
  assert.equal((await e.api('mcp/requests',{method:'POST',cookie:null,body:{tokenHash:hash(e.token),scope:{...e.scope,client:e.client}}})).status,409);
 }finally{await e.close();}
});
test('capability cannot cross project, run, content, origin or ordinary account/write APIs',async()=>{
 const e=await fixture();try{
  const p=await e.register();assert.equal((await e.approve(p.code)).status,200);
  const q='?project='+e.scope.projectId;
  for(const [path,expected]of [['mcp/read/me?project='+alphaProject('github-9999').id,403],['mcp/read/events'+q+'&run=not-approved',403],['mcp/read/events'+q+'&run=bridge-proof&content=include',403],['mcp/read/events'+q+'&run=bridge-proof&project='+e.scope.projectId,400],['me'+q,401],['keys'+q,401],['billing/status'+q,401]])assert.equal((await e.api(path,{cookie:e.cap})).status,expected,path);
  for(const path of ['batches','keys/revoke','auth/logout','mcp/approve'])assert.ok((await e.api(path,{method:'POST',cookie:e.cap,body:{}})).status>=400,path);
  await assert.rejects(mcpBridgeStore(e.live.store).lease(hash(e.token),'https://supatrace.tech'),/mcp_access_unavailable/);
 }finally{await e.close();}
});
for(const end of ['expiry','logout','epoch','revoke','client-stop'])test(end+' ends delegated access at server, independently of local lease',async()=>{
 const e=await fixture();try{
  const p=await e.register();assert.equal((await e.approve(p.code)).status,200);
  const q='mcp/read/me?project='+e.scope.projectId;assert.equal((await e.api(q,{cookie:e.cap})).status,200);
  if(end==='expiry'){const now=e.live.store.now;e.live.store.now=()=>now()+301;}
  if(end==='logout')await e.live.store.deleteSession(e.parentHash);
  if(end==='epoch')await e.live.store.endTenantSessions(e.scope.tenantId);
  if(end==='revoke')assert.equal((await e.api('mcp/revoke',{method:'POST',body:{code:p.code}})).status,200);
  if(end==='client-stop')assert.equal((await e.api('mcp/stop',{method:'POST',cookie:e.cap,body:{}})).status,200);
  assert.equal((await e.api(q,{cookie:e.cap})).status,401);
  assert.equal((await e.api('mcp/poll',{method:'POST',cookie:e.cap,body:{}})).status,401);
 }finally{await e.close();}
});
test('parent session expiry caps grant; source registration never creates a normal session',async()=>{
 const e=await fixture();try{
  const parentNow=e.live.store.now();
  // Existing session cannot be replaced; use a distinct synthetic parent directly.
  const short=await parentSession(e.live.store,e.scope.tenantId,parentNow+60);
  const p=await e.register();const r=await e.approve(p.code,{cookie:'__Host-supatrace='+short});assert.equal(r.status,200);assert.equal((await r.json()).expiresAt,(parentNow+60)*1000);
  assert.equal(await e.live.store.getSession(hash(e.token)),null);
 }finally{await e.close();}
});
test('revocation during storage await blocks a newly returned catalog',async()=>{
 const e=await fixture();try{
  const p=await e.register();assert.equal((await e.approve(p.code)).status,200);let entered,release;
  const ready=new Promise(r=>entered=r),pause=new Promise(r=>release=r),get=e.live.store.getRun.bind(e.live.store);
  e.live.store.getRun=async(...a)=>{entered();await pause;return get(...a);};
  const reading=e.api('mcp/read/runs/page?project='+e.scope.projectId,{cookie:e.cap});await ready;
  assert.equal((await e.api('mcp/revoke',{method:'POST',body:{code:p.code}})).status,200);release();
  const response=await reading;assert.equal(response.status,401);assert.doesNotMatch(await response.text(),/bridge-proof|PRIVATE_/);
 }finally{await e.close();}
});
test('scope is explicit, bounded and cannot contain extra keys or an unbound project',()=>{
 const scope={origin:'https://supatrace.dev',tenantId:'github-1',projectId:alphaProject('github-1').id,content:'metadata',runIds:['one'],client:'Test client'};
 for(const change of [{projectId:null},{projectId:alphaProject('github-2').id},{runIds:[]},{runIds:Array.from({length:21},(_,i)=>'r'+i)},{runIds:['one','one']},{runIds:['../secret']},{client:'<script>'},{token:'private'},{origin:'http://127.0.0.1'}])assert.throws(()=>bridgeScope({...scope,...change}));
});
test('stale approval code and scope hash cannot approve a replacement request',async()=>{
 const e=await fixture();try{
  const db=mcpBridgeStore(e.live.store),old=await e.register();
  const now=e.live.store.now(),short=await parentSession(e.live.store,e.scope.tenantId,now+60);
  assert.equal((await e.approve(old.code,{cookie:'__Host-supatrace='+short})).status,200);
  e.live.store.now=()=>now+61;
  const scope={...e.scope,client:e.client,runIds:['not-approved']},replacement=await db.register(hash(e.token),scope,e.scope.origin);
  assert.notEqual(replacement.code,old.code);
  await assert.rejects(db.approve(old.code,e.scope.origin,e.scope.tenantId,e.parentHash,{confirmed:true,content:'metadata',scopeHash:old.scopeHash}),/mcp_request_unavailable/);
  await assert.rejects(db.approve(replacement.code,e.scope.origin,e.scope.tenantId,e.parentHash,{confirmed:true,content:'metadata',scopeHash:old.scopeHash}),/mcp_consent_required/);
  await assert.rejects(db.revokeByCode(old.code,e.scope.origin,e.scope.tenantId),/mcp_request_unavailable/);
  assert.equal((await db.poll(hash(e.token),e.scope.origin)).approved,false);
 }finally{await e.close();}
});
for(const phase of ['fetch','body'])test('cancellation settles when '+phase+' ignores abort',async()=>{
 const scope={origin:'https://supatrace.dev',tenantId:'github-1',projectId:alphaProject('github-1').id,content:'metadata',runIds:['one']};
 const controller=new AbortController();let entered;const ready=new Promise(r=>entered=r);
 const request=connectBridge(scope,'Test client',{signal:controller.signal,requestTimeoutMs:100,fetchImpl:async()=>{entered();return phase==='fetch'?new Promise(()=>{}):new Response(new ReadableStream({pull(){return new Promise(()=>{});}}),{headers:{'content-type':'application/json'}});}});
 await ready;controller.abort();await assert.rejects(request,/mcp_bridge_unavailable/);
});
test('in-flight read cannot borrow a replacement grant with the same token',async()=>{
 const e=await fixture();try{
  const db=mcpBridgeStore(e.live.store),p=await e.register(),now=e.live.store.now(),short=await parentSession(e.live.store,e.scope.tenantId,now+60);
  assert.equal((await e.approve(p.code,{cookie:'__Host-supatrace='+short})).status,200);
  let entered,release;const ready=new Promise(r=>entered=r),pause=new Promise(r=>release=r),get=e.live.store.getRun.bind(e.live.store);
  e.live.store.getRun=async(...a)=>{entered();await pause;return get(...a);};
  const reading=e.api('mcp/read/runs/page?project='+e.scope.projectId,{cookie:e.cap});await ready;e.live.store.now=()=>now+61;
  const scope={...e.scope,client:e.client,runIds:['not-approved']},replacement=await db.register(hash(e.token),scope,e.scope.origin);
  await db.approve(replacement.code,e.scope.origin,e.scope.tenantId,e.parentHash,{confirmed:true,content:'metadata',scopeHash:replacement.scopeHash});
  release();const response=await reading;assert.equal(response.status,401);assert.doesNotMatch(await response.text(),/bridge-proof/);
 }finally{await e.close();}
});
test('closing embedded bridge aborts an active reader and fences a late response',async()=>{
 const e=await fixture();let bridge,reader,release;try{
  let approval;bridge=await connectBridge(e.scope,e.client,{fetchImpl:e.fetchImpl,sleep:async()=>await approval,notify:info=>approval=e.approve(info.code)});
  let entered;const ready=new Promise(r=>entered=r),pause=new Promise(r=>release=r);
  reader=createTraceReader(e.scope,{...bridge.dependencies,fetchImpl:async(url,init)=>{const response=await e.fetchImpl(url,init);if(url.includes('/runs/page')){entered();await pause;}return response;}});
  const reading=reader.execute('supatrace_list_traces');await ready;const rejected=assert.rejects(reading,/cancelled/);await bridge.close();await rejected;release();
 }finally{release?.();reader?.close();await bridge?.close();await e.close();}
});

for(const provider of ['braintrust','langsmith'])test(provider+' file -> storage -> consent -> official SDK metadata export -> revocation',async()=>{
 const e=await fixture();let bridge,server,client;
 try{
  const converted=convertConnectorFile(JSON.stringify(connectorFixtures[provider]()),{format:provider,namespace:'release-integration',content:'include'});
  assert.deepEqual(converted.report.rejected,[]);assert.equal(converted.batches.length,2);
  const runId=converted.batches[0].run_id;e.scope.runIds=[runId];
  const key=await e.live.writeKey(e.scope.tenantId);
  for(const batch of converted.batches)await e.live.upload(key,batch);
  let approval,code;
  bridge=await connectBridge(e.scope,e.client,{fetchImpl:e.fetchImpl,sleep:async()=>{await approval;},notify:info=>{code=info.code;approval=e.approve(code).then(r=>assert.equal(r.status,200));}});
  const reader=createTraceReader(e.scope,{...bridge.dependencies,fetchImpl:e.fetchImpl});
  const [c,s]=InMemoryTransport.createLinkedPair();server=createMcpServer(reader);client=new Client({name:'connector-release-acceptance',version:'1'});await server.connect(s);await client.connect(c);
  const list=await client.callTool({name:'supatrace_list_traces',arguments:{}});assert.equal(list.structuredContent.total,1);assert.equal(list.structuredContent.runs[0].id,runId);
  const inspected=await client.callTool({name:'supatrace_inspect_trace',arguments:{runId}});assert.equal(inspected.structuredContent.trace.events.length,2);
  const result=await client.callTool({name:'supatrace_export_trace',arguments:{runId,includeContent:false}});assert.equal(result.isError,undefined);
  const expected=[...converted.batches].sort((a,b)=>a.batch_id.localeCompare(b.batch_id)).flatMap(b=>b.events.map(({id,time,kind})=>({id,time,kind})));
  assert.deepEqual(JSON.parse(result.structuredContent.json).events,expected);assert.equal(result.structuredContent.sha256,hash(result.structuredContent.json));
  assert.equal(JSON.stringify(result).includes(marker),false);assert.ok(e.requests.filter(r=>r.path.endsWith('/events')).every(r=>!r.response.includes(marker)));
  assert.equal((await client.callTool({name:'supatrace_inspect_trace',arguments:{runId:'bridge-proof'}})).isError,true);
  assert.equal((await client.callTool({name:'supatrace_export_trace',arguments:{runId,includeContent:true}})).isError,true);
  assert.equal((await e.api('mcp/revoke',{method:'POST',body:{code}})).status,200);
  assert.equal((await client.callTool({name:'supatrace_list_traces',arguments:{}})).isError,true);
 }finally{await client?.close();await server?.close();await bridge?.close();await e.close();}
});
