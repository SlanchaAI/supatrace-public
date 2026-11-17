// Contract for issue #67 (code part). Fixture-backed: no server, no Docker, no network.
// The worker sandbox allows only localhost:18085, so every Langfuse call here goes through an
// in-process fake passed as `fetchImpl`. Do not edit: the issue's Proof pins this file's sha256.
//
// Interface the change must provide, in scripts/local-langfuse-source.mjs:
//   createLocalSourceFetch({spec, rows, env = process.env, fetchImpl = (...a) => globalThis.fetch(...a), count = () => {}})
// returns `async (url, init) => Response`, the `sourceFetch` that scripts/local-imports.mjs hands to the host.
//   - env.SUPATRACE_LOCAL_LANGFUSE_URL unset or empty: serve the synthetic fixture (`rows`) exactly as
//     local-imports.mjs does today; fetchImpl is never called.
//   - set: it must be an http URL on 127.0.0.1, localhost or [::1], else createLocalSourceFetch throws.
//     Requests keep the cloud origin in the spec (src/importers/langfuse-transport.mjs is not changed);
//     here the origin is swapped for the local base and the request is sent through fetchImpl.
//     The Authorization header and the path and query string pass through unchanged. The Response comes back
//     with the same status and body, but its `url` must equal the URL that was requested (the cloud URL):
//     src/importers/langfuse-transport.mjs refuses a response whose url differs, and a real fetch() reports the
//     local URL, so set it explicitly (Object.defineProperty(response,'url',{value:url}), as destinationFetch does).
//     This holds in the synthetic mode too.
//     count() is called once per request served, in both modes.
//   - both modes refuse (throw, no fetchImpl call): a cookie header, a URL whose origin is not spec.origin,
//     a path other than /api/public/projects and /api/public/v2/observations, and an observations
//     request whose traceId is not spec.traceId.
// scripts/local-imports.mjs must import createLocalSourceFetch and use it as sourceFetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createLocalSourceFetch} from '../../scripts/local-langfuse-source.mjs';

const spec={origin:'https://cloud.langfuse.com',sourceProject:'proj-1',traceId:'trace-1'};
const rows=[{id:'root',parentObservationId:null,traceId:'trace-1'},{id:'child',parentObservationId:'root',traceId:'trace-1'}];
const AUTH='Basic '+Buffer.from('pk-test:sk-test').toString('base64');
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
const asFetched=(res,url)=>{Object.defineProperty(res,'url',{value:String(url),configurable:true});return res;}; // a real fetch() reports the URL it was sent to
// Fake Langfuse v3 public API: basic auth, project lookup, cursor-paged v2 observations.
function fakeLangfuse(){
 const calls=[];
 const fetchImpl=async(url,init={})=>{
  calls.push({url:String(url),authorization:new Headers(init.headers).get('authorization')});
  return asFetched(answer(url,init),url);
 };
 const answer=(url,init)=>{
  if(new Headers(init.headers).get('authorization')!==AUTH)return json({message:'unauthorized'},401);
  const u=new URL(url);
  if(u.pathname==='/api/public/projects')return json({data:[{id:'proj-1'}]});
  if(u.pathname==='/api/public/v2/observations'){
   if(u.searchParams.get('traceId')!=='trace-1')return json({data:[],meta:{cursor:null}});
   const cursor=u.searchParams.get('cursor');
   return cursor==='p2'?json({data:[rows[1]],meta:{cursor:null}}):json({data:[rows[0]],meta:{cursor:'p2'}});
  }
  return json({message:'not found'},404);
 };
 return {calls,fetchImpl};
}
async function readAll(sourceFetch){
 const out=[];let cursor=null;
 do{
  const u=new URL('https://cloud.langfuse.com/api/public/v2/observations');u.searchParams.set('traceId','trace-1');if(cursor)u.searchParams.set('cursor',cursor);
  const res=await sourceFetch(u.toString(),{headers:{authorization:AUTH}});
  assert.equal(res.status,200);assert.equal(res.url,u.toString(),'response.url must equal the requested cloud URL');
  const body=await res.json();
  out.push(...body.data);cursor=body.meta.cursor;
 }while(cursor);
 return out;
}

test('unset env keeps the synthetic path and never calls fetchImpl',async()=>{
 for(const env of [{},{SUPATRACE_LOCAL_LANGFUSE_URL:''}]){
  const fake=fakeLangfuse();
  let counted=0;
  const sourceFetch=createLocalSourceFetch({spec,rows,env,fetchImpl:fake.fetchImpl,count:()=>{counted++;}});
  const project=await(await sourceFetch('https://cloud.langfuse.com/api/public/projects',{headers:{}})).json();
  assert.deepEqual(project.data,[{id:'proj-1'}]);
  const got=await readAll(sourceFetch);
  assert.deepEqual(got.map(r=>r.id).sort(),['child','root']);
  assert.equal(fake.calls.length,0);assert.equal(counted,2);
 }
});

test('set env forwards to the local base through fetchImpl and reads parent and child back',async()=>{
 const fake=fakeLangfuse();let counted=0;
 const sourceFetch=createLocalSourceFetch({spec,rows,env:{SUPATRACE_LOCAL_LANGFUSE_URL:'http://127.0.0.1:3000'},fetchImpl:fake.fetchImpl,count:()=>{counted++;}});
 const got=await readAll(sourceFetch);
 assert.equal(got.length,2);
 const child=got.find(r=>r.id==='child'),root=got.find(r=>r.id==='root');
 assert.equal(child.parentObservationId,root.id);assert.equal(root.parentObservationId,null);
 assert.equal(fake.calls.length,2);assert.equal(counted,2);
 for(const c of fake.calls){assert.ok(c.url.startsWith('http://127.0.0.1:3000/api/public/v2/observations?'),c.url);assert.equal(c.authorization,AUTH);assert.match(c.url,/traceId=trace-1/);}
 assert.match(fake.calls[1].url,/cursor=p2/);
 const project=await sourceFetch('https://cloud.langfuse.com/api/public/projects',{headers:{authorization:AUTH}});
 assert.deepEqual((await project.json()).data,[{id:'proj-1'}]);assert.equal(fake.calls.at(-1).url,'http://127.0.0.1:3000/api/public/projects');
 // init passes through untouched
 let seenInit;const probe=createLocalSourceFetch({spec,rows,env:{SUPATRACE_LOCAL_LANGFUSE_URL:'http://[::1]:3000'},fetchImpl:async(u,i)=>{seenInit=i;return asFetched(json({data:[],meta:{cursor:null}}),u);}});
 const init={headers:{authorization:AUTH},redirect:'error'};
 await probe('https://cloud.langfuse.com/api/public/v2/observations?traceId=trace-1',init);
 assert.equal(seenInit.redirect,'error');assert.equal(new Headers(seenInit.headers).get('authorization'),AUTH);
 // replaying the read returns the same records (no extra records appear)
 const again=await readAll(sourceFetch);
 assert.deepEqual(again,got);
});

test('set env accepts localhost and [::1], refuses any other base at creation',()=>{
 for(const base of ['http://localhost:3000','http://[::1]:3000'])
  assert.doesNotThrow(()=>createLocalSourceFetch({spec,rows,env:{SUPATRACE_LOCAL_LANGFUSE_URL:base},fetchImpl:async()=>json({})}));
 for(const base of ['https://cloud.langfuse.com','http://langfuse.example.com:3000','http://10.0.0.5:3000','https://127.0.0.1:3000','ftp://127.0.0.1','not a url',
  'http://127.0.0.1.evil.com:3000','http://localhost.evil.com:3000','http://127.0.0.1@evil.com:3000','http://127.0.0.2:3000','http://[::ffff:127.0.0.1]:3000','http://0.0.0.0:3000'])
  assert.throws(()=>createLocalSourceFetch({spec,rows,env:{SUPATRACE_LOCAL_LANGFUSE_URL:base},fetchImpl:async()=>json({})}),undefined,base);
});

test('both modes refuse cookies, foreign origins, other paths and other traces without calling fetchImpl',async()=>{
 for(const env of [{},{SUPATRACE_LOCAL_LANGFUSE_URL:'http://127.0.0.1:3000'}]){
  const fake=fakeLangfuse();
  const sourceFetch=createLocalSourceFetch({spec,rows,env,fetchImpl:fake.fetchImpl});
  const good='https://cloud.langfuse.com/api/public/v2/observations?traceId=trace-1';
  await assert.rejects(sourceFetch(good,{headers:{authorization:AUTH,cookie:'s=1'}}));
  await assert.rejects(sourceFetch(good,{headers:new Headers({authorization:AUTH,Cookie:'s=1'})}));
  await assert.rejects(sourceFetch('https://cloud.langfuse.com/api/public/v2/observations',{headers:{authorization:AUTH}}));
  await assert.rejects(sourceFetch('https://evil.example.com/api/public/v2/observations?traceId=trace-1',{headers:{authorization:AUTH}}));
  await assert.rejects(sourceFetch('http://127.0.0.1:3000/api/public/v2/observations?traceId=trace-1',{headers:{authorization:AUTH}}));
  for(const path of ['/api/public/traces','/api/public/v2/observationsX','/api/public/v2/observations/x','/api/public/projects/x','/api/public/v2'])
   await assert.rejects(sourceFetch('https://cloud.langfuse.com'+path+'?traceId=trace-1',{headers:{authorization:AUTH}}),undefined,path);
  await assert.rejects(sourceFetch('https://cloud.langfuse.com/api/public/v2/observations?traceId=other',{headers:{authorization:AUTH}}));
  assert.equal(fake.calls.length,0);
 }
});

test('local-imports.mjs uses createLocalSourceFetch and the transport allowlist is untouched',()=>{
 const host=readFileSync(new URL('../../scripts/local-imports.mjs',import.meta.url),'utf8');
 assert.match(host,/^\s*import\s[^;\n]*createLocalSourceFetch[^;\n]*from\s+['"]\.\/local-langfuse-source\.mjs['"]/m);
 assert.match(host,/^(?!\s*(\/\/|\*))[^\n]*sourceFetch\s*:\s*createLocalSourceFetch\s*\(/m);
 const transport=readFileSync(new URL('../../src/importers/langfuse-transport.mjs',import.meta.url),'utf8');
 assert.match(transport,/LANGFUSE_CLOUD_ORIGINS=Object\.freeze\(\['https:\/\/cloud\.langfuse\.com','https:\/\/us\.cloud\.langfuse\.com','https:\/\/jp\.cloud\.langfuse\.com','https:\/\/hipaa\.cloud\.langfuse\.com'\]\)/);
});
