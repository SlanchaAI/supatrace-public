import {mkdtempSync,realpathSync,lstatSync,rmSync,readFileSync,existsSync,writeFileSync,chmodSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {MemoryDynamo,commandClasses} from './memory-dynamo.mjs';
import {DynamoMetadataStore,digest} from '../src/dynamodb-store.mjs';
import {ImportJobLedger} from '../src/import-job-ledger.mjs';
import {createPrivateImportHost} from '../src/private-import-host.mjs';
import {dispatchKey,LANGFUSE_HOST_FIELDS} from '../src/private-import-dispatch.mjs';
import {hash} from '../src/trace.mjs';
import {planCustomerImport} from '../src/import-planning.mjs';
import {alphaProject} from '../src/alpha-projects.mjs';
import {handle} from '../src/aws-api.mjs';
const python=execFileSync('python3',['-c','import sys;print(sys.executable)'],{encoding:'utf8'}).trim(),tenant='github-4242',project=alphaProject(tenant).id;
export async function privateHostFixture(fixtureConfig={}){
 const directory=fixtureConfig.directory??mkdtempSync(join(realpathSync(tmpdir()),'private-host-')),client=new MemoryDynamo(),store=new DynamoMetadataStore({client,commands:commandClasses(),tableName:'synthetic'}),saved=new Map(),objects={putImmutable:async(k,v)=>saved.set(k,v),get:async k=>saved.get(k)};
 await store.getOrCreateTenant(4242);const token=randomBytes(32).toString('base64url');await store.createSession(digest(token),tenant);const parentSession=await store.getImportSessionStamp(digest(token)),key=randomBytes(32).toString('base64url'),setup=await store.createSetup(digest(key),project);await store.approveSetup(tenant,setup.user_code);
 const plan={provider:'langfuse',origin:'https://cloud.langfuse.com',sourceProject:'synthetic-host',environment:'synthetic',namespace:'private-host-integrated',from:'2026-10-01T00:00:00Z',to:'2026-10-02T00:00:00Z',maxRows:10,maxPages:2,pageSize:5,maxBytes:100000,maxRetries:0},planned=planCustomerImport(plan,project).plan;
 const baseline={schema_version:1,scope:{tenant_id:tenant,project_id:project,origin:plan.origin,sourceProject:plan.sourceProject,environment:plan.environment},records:[]};
 const runtime={worker_id:'1'.repeat(64),revision:'a'.repeat(40),artifact_hash:'f'.repeat(64),pythonExecutable:python,pythonVersion:'3.12',uid:process.getuid(),device:lstatSync(directory).dev},descriptor={worker_id:runtime.worker_id,revision:runtime.revision,artifact_hash:runtime.artifact_hash,approval_hash:'4'.repeat(64),source_binding:'2'.repeat(64),destination_binding:'3'.repeat(64),destination_origin:'https://supatrace.dev',legacy_snapshot_hash:hash(baseline),expires_at:store.now()+300};
 const sourceRows=[{id:'root',traceId:'synthetic-trace',parentObservationId:null,projectId:plan.sourceProject,environment:plan.environment,startTime:'2026-10-01T12:00:00Z',input:{text:'SYNTHETIC_EXPLICIT_CONTENT'},prompt:'SYNTHETIC_PROMPT'}];
 let sourceRequests=0,destinationRequests=0,leases=0;const actions=[];
 const env={ENABLED:true,APP_ORIGIN:descriptor.destination_origin,GITHUB_CLIENT_ID:'synthetic',GITHUB_CLIENT_SECRET:'synthetic',store,objects};
 const allowed=new Set(['queue-private-import','reserve-private-import','inspect-private-import','cancel-private-import','claim-source-stage','runtime-action','source-lease','source-wire','consume-once-upload','upload-approved-batch','upload-approved-batch-wire','destination-write-lease','reconcile-import-batch','export-import-batch','save-imported-export','verify-saved-import-export']);
 const options={store,objects,directory,runtime,readiness:async proof=>proof.uid===runtime.uid&&proof.device===runtime.device&&proof.artifact_hash===runtime.artifact_hash,authorize:async d=>{actions.push(d);const b=d.binding??d;return allowed.has(d.action)&&(d.action==='queue-private-import'?d.fingerprint===planCustomerImport(d.plan,project).plan.fingerprint&&d.fields===LANGFUSE_HOST_FIELDS:b.source?.fields===LANGFUSE_HOST_FIELDS);},legacyProvider:async()=>structuredClone(baseline),sourceBroker:async()=>({origin:plan.origin,projectId:plan.sourceProject,publicKey:'synthetic-public-key',secretKey:'synthetic-secret-key',expiresAt:Date.now()+60000}),destinationBroker:async()=>{leases++;return{origin:descriptor.destination_origin,project_id:project,write_key:key,expires_at:Math.min(descriptor.expires_at,Math.floor(Date.now()/1000)+60)};},sourceFetch:async url=>{sourceRequests++;return new Response(JSON.stringify(url.endsWith('/projects')?{data:[{id:plan.sourceProject}]}:{data:sourceRows,meta:{cursor:null}}),{headers:{'content-type':'application/json'}});},destinationFetch:async(url,init)=>{destinationRequests++;const r=await handle(new Request(url,init),env);Object.defineProperty(r,'url',{value:url});return r;}};
 const submit={tenant,parentSession,plan,fingerprint:planned.fingerprint,descriptor};return {directory,client,store,saved,objects,token,key,parentSession,plan,baseline,runtime,descriptor,sourceRows,options,submit,actions,counts:()=>({sourceRequests,destinationRequests,leases}),close:()=>rmSync(directory,{recursive:true,force:true})};
}
