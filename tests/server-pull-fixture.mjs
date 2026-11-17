import assert from 'node:assert/strict';
import {MemoryDynamo,commandClasses} from './memory-dynamo.mjs';
import {DynamoMetadataStore,digest} from '../src/dynamodb-store.mjs';
import {createFixtureSession} from './fixture-session.mjs';
import {composeServerPullController} from '../src/import-composition.mjs';
import {handle} from '../src/aws-api.mjs';
import {planCustomerImport} from '../src/import-planning.mjs';
import {alphaProject} from '../src/alpha-projects.mjs';
const origin='https://supatrace.dev',tenant='github-4242',project=alphaProject(tenant).id;
export const credentials={publicKey:'synthetic-public-key',secretKey:'synthetic-secret-key'};
export const spec={provider:'langfuse',origin:'https://cloud.langfuse.com',sourceProject:'synthetic-pull',traceId:'trace-one',environment:'synthetic',namespace:'server-pull-test',from:'2026-10-01T00:00:00Z',to:'2026-10-02T00:00:00Z',maxRows:10,maxPages:2,pageSize:5,maxBytes:100000,maxRetries:0};
export async function pullFixture({epoch=0}={}){
 let time=Math.floor(Date.now()/1000),fetches=0;const client=new MemoryDynamo(),store=new DynamoMetadataStore({client,commands:commandClasses(),tableName:'synthetic',now:()=>time});await store.getOrCreateTenant(4242);client._get({pk:'TENANT#'+tenant,sk:'META'}).session_epoch=epoch;const token=await createFixtureSession(store,tenant),saved=new Map();let puts=0;
 const objects={putImmutable:async(k,v,h)=>{puts++;assert.equal(digest(v),h);if(saved.has(k))assert.equal(saved.get(k),v);saved.set(k,v);},get:async k=>{if(!saved.has(k))throw Error('missing');return saved.get(k);}};
 const row=(id='obs-one')=>({id,traceId:spec.traceId,projectId:spec.sourceProject,environment:spec.environment,startTime:'2026-10-01T12:00:00Z',input:{text:'SYNTHETIC_INPUT'},prompt:'SYNTHETIC_PROMPT'});
 let provider=async url=>new Response(JSON.stringify(url.endsWith('/projects')?{data:[{id:spec.sourceProject}]}:{data:[row()],meta:{cursor:null}}),{headers:{'content-type':'application/json'}});
 const config=JSON.stringify({mode:'bounded-server-pull-v1',origin}),compose=()=>composeServerPullController(config,{store,objects,origins:[origin],fetchImpl:async(url,init)=>{fetches++;assert.equal(init.redirect,'error');return provider(url,init);}});
 const env={ENABLED:true,APP_ORIGIN:origin,GITHUB_CLIENT_ID:'synthetic',GITHUB_CLIENT_SECRET:'synthetic',store,objects,...compose()};
 const input=planCustomerImport(spec,project,{serverPull:true}).plan,fp={fingerprint:input.fingerprint};
 const api=async(action,data=fp,changes={})=>{const response=await handle(new Request(origin+'/api/imports/'+action,{method:'POST',headers:{origin,cookie:'__Host-supatrace='+token,'content-type':'application/json'},body:JSON.stringify(data),...changes}),env);return {status:response.status,body:await response.json()};};
 const ok=async(action,data)=>{const result=await api('pull/'+action,data);assert.equal(result.status,200,JSON.stringify(result.body));return result.body;};
 const consent=async()=>{const review=await ok('review',{...fp,plan:spec});await ok('consent',{...fp,review_hash:review.review_hash,accept_content:true});return review;};
 const advance=()=>ok('advance',{...fp,credentials});
 const stored=()=>client._get({pk:'TENANT#'+tenant,sk:'SERVERPULL#'+input.fingerprint});
 return {store,client,token,objects,saved,env,config,input,fp,api,ok,consent,advance,stored,compose,row,provider:fn=>{provider=fn;},fetches:()=>fetches,puts:()=>puts,tick:n=>{time+=n;}};
}
