// Explicit private-package acceptance only. No service, AWS client or live broker.
import {mkdirSync,lstatSync,realpathSync,openSync,writeSync,fsyncSync,closeSync,constants} from 'node:fs';
import {resolve,dirname,isAbsolute,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {MemoryDynamo,commandClasses} from '../tests/memory-dynamo.mjs';
import {DynamoMetadataStore,digest} from '../src/dynamodb-store.mjs';
import {alphaProject} from '../src/alpha-projects.mjs';
import {planCustomerImport} from '../src/import-planning.mjs';
import {hash} from '../src/trace.mjs';
import {LANGFUSE_HOST_FIELDS} from '../src/private-import-dispatch.mjs';
import {loadPrivateImportWorker,loadPrivateImportLauncher,verifyPrivateImportDistribution} from '../src/private-import-distribution.mjs';
import {createPrivateImportConsentStore} from '../src/private-import-consent.mjs';
import {createPrivateImportAuthenticator} from '../src/private-import-auth.mjs';
import {createImportStartController} from '../src/import-start.mjs';
import {handle} from '../src/aws-api.mjs';
import {inspectPrivateHostReadiness} from '../src/private-host-readiness.mjs';

let phase='arguments';
const refuse=()=>{throw Error('synthetic_acceptance_refused');};
function args(){
 const required=['archive','archive-sha256','manifest-sha256','revision','workspace','python','uid','device','filesystem-type','arch','python-sha256'],mountNames=['mount-point','mount-source','mount-filesystem'],names=[...required,...mountNames],result={};
 for(let i=2;i<process.argv.length;){const flag=process.argv[i++],name=flag?.slice(2);if(flag==='--local-filesystem-only'){if(result.localOnly)refuse();result.localOnly=true;continue;}if(!flag?.startsWith('--')||!names.includes(name)||Object.hasOwn(result,name)||!process.argv[i])refuse();result[name]=process.argv[i++];}
 if(required.some(k=>!Object.hasOwn(result,k))||!['archive','workspace','python'].every(k=>isAbsolute(result[k])&&resolve(result[k])===result[k])||['uid','device','filesystem-type'].some(k=>!/^\d+$/.test(result[k])||!Number.isSafeInteger(Number(result[k]))))refuse();
 if(result.localOnly?mountNames.some(k=>Object.hasOwn(result,k)):mountNames.some(k=>!Object.hasOwn(result,k)))refuse();return result;
}
function save(path,value){const fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);try{const raw=Buffer.from(JSON.stringify(value));let n=0;while(n<raw.length)n+=writeSync(fd,raw,n);fsyncSync(fd);}finally{closeSync(fd);}const dir=openSync(dirname(path),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{fsyncSync(dir);}finally{closeSync(dir);}}
async function main(){
 const input=args(),directory=resolve(fileURLToPath(new URL('../',import.meta.url))),workspace=input.workspace;
 const distribution={directory,archivePath:input.archive,archiveHash:input['archive-sha256'],manifestHash:input['manifest-sha256'],revision:input.revision};
 phase='distribution';const proof=verifyPrivateImportDistribution(distribution);
 // No caller-supplied host, endpoint, identity, credentials, source data or adapters.
 globalThis.fetch=()=>{throw Error('synthetic_network_disabled');};
 const parent=dirname(workspace),p=lstatSync(parent),readinessConfig={uid:Number(input.uid),device:Number(input.device),filesystemType:Number(input['filesystem-type']),architecture:input.arch,pythonExecutable:input.python,pythonHash:input['python-sha256'],mountPoint:input['mount-point'],mountSource:input['mount-source'],mountFilesystem:input['mount-filesystem'],localFilesystemOnly:input.localOnly===true};
 if(realpathSync(parent)!==parent||!p.isDirectory()||p.uid!==process.getuid()||p.mode&0o077||workspace===directory||workspace.startsWith(directory+'/'))refuse();
 phase='readiness';inspectPrivateHostReadiness({...readinessConfig,directory:parent});
 phase='new_workspace';mkdirSync(workspace,{mode:0o700}); // Existing workspaces, completed or uncertain, are never reused.
 save(join(workspace,'synthetic-attempt.json'),{type:'synthetic-only',revision:proof.revision,archive_sha256:proof.artifact_hash,live_authority:false,automatic_replay:false});
 phase='synthetic_records';const tenant='github-4242',project=alphaProject(tenant).id,client=new MemoryDynamo(),store=new DynamoMetadataStore({client,commands:commandClasses(),tableName:'synthetic-only'}),saved=new Map();
 const objects={async putImmutable(k,raw,expected){if(digest(raw)!==expected||saved.has(k)&&saved.get(k)!==raw)refuse();saved.set(k,raw);},async get(k){if(!saved.has(k))refuse();return saved.get(k);}};
 await store.getOrCreateTenant(4242);const token=randomBytes(32).toString('base64url');await store.createSession(digest(token),tenant);const parentSession=await store.getImportSessionStamp(digest(token));
 const writeKey=randomBytes(32).toString('base64url'),setup=await store.createSetup(digest(writeKey),project);await store.approveSetup(tenant,setup.user_code);
 const plan={provider:'langfuse',origin:'https://cloud.langfuse.com',sourceProject:'synthetic-package-project',traceId:'synthetic-package-trace',environment:'synthetic',namespace:'private-package-acceptance',from:'2026-10-01T00:00:00Z',to:'2026-10-02T00:00:00Z',maxRows:10,maxPages:2,pageSize:5,maxBytes:100000,maxRetries:0};
 const baseline={schema_version:1,scope:{tenant_id:tenant,project_id:project,origin:plan.origin,sourceProject:plan.sourceProject,environment:plan.environment},records:[]};
 const runtime={worker_id:digest('synthetic-package-worker'),revision:proof.revision,artifact_hash:proof.artifact_hash,pythonExecutable:input.python,pythonVersion:'3.12',uid:process.getuid(),device:readinessConfig.device};
 const descriptor={worker_id:runtime.worker_id,revision:runtime.revision,artifact_hash:runtime.artifact_hash,source_binding:digest('synthetic-source-binding'),destination_binding:digest('synthetic-destination-binding'),destination_origin:'https://supatrace.dev',legacy_snapshot_hash:hash(baseline),expires_at:store.now()+300};
 const rows=[{id:'root',parentObservationId:null},{id:'child',parentObservationId:'root'}].map(row=>({...row,traceId:'synthetic-package-trace',projectId:plan.sourceProject,environment:plan.environment,startTime:'2026-10-01T12:00:00Z',input:'SYNTHETIC_INPUT',prompt:'SYNTHETIC_PROMPT'}));
 const actions=new Set(['queue-private-import','reserve-private-import','inspect-private-import','cancel-private-import','download-private-import','claim-source-stage','runtime-action','source-lease','source-wire','consume-once-upload','upload-approved-batch','upload-approved-batch-wire','destination-write-lease','reconcile-import-batch','export-import-batch','save-imported-export','verify-saved-import-export','consume-private-import-assignment','complete-private-import-assignment','release-private-import-assignment']);
 const fingerprint=planCustomerImport(plan,project).plan.fingerprint,record={schema_version:1,tenant_id:tenant,parent_session:parentSession,project_id:project,environment_id:'default',plan,fingerprint,descriptor},approvalId=hash(record);
 const env={ENABLED:true,APP_ORIGIN:descriptor.destination_origin,GITHUB_CLIENT_ID:'synthetic-only',GITHUB_CLIENT_SECRET:'synthetic-only',store,objects};let sourceRequests=0,destinationRequests=0,cookiesForwarded=0;
 const request=()=>new Request(descriptor.destination_origin+'/api/imports/start',{method:'POST',headers:{origin:descriptor.destination_origin,cookie:'__Host-supatrace='+token,'content-type':'application/json'},body:JSON.stringify({fingerprint})});
 const ready=()=>{verifyPrivateImportDistribution(distribution);inspectPrivateHostReadiness({...readinessConfig,directory:workspace});return true;};
 const authorize=async({approval_id,descriptor:d})=>{const b=d.binding??d;return approval_id===approvalId&&actions.has(d.action)&&(d.action==='queue-private-import'?d.tenant_id===tenant&&d.fingerprint===fingerprint&&d.fields===LANGFUSE_HOST_FIELDS:b.tenant_id===tenant&&b.fingerprint===fingerprint&&b.source?.fields===LANGFUSE_HOST_FIELDS);};
 phase='host_composition';const consents=createPrivateImportConsentStore({store,objects,origin:descriptor.destination_origin,runtime,authorize:async d=>d.action==='record-reviewed-private-import-consent'&&d.approval_id===approvalId&&hash(d.record)===approvalId});
 const hostOptions={store,objects,directory:workspace,runtime,readiness:async d=>ready()&&d.directory===workspace&&d.uid===runtime.uid&&d.device===runtime.device,
  legacyProvider:async()=>structuredClone(baseline),
  sourceFetch:async(url,init)=>{if(new Headers(init?.headers).has('cookie'))cookiesForwarded++;const u=new URL(url);if(u.origin!==plan.origin||!['/api/public/projects','/api/public/v2/observations'].includes(u.pathname))refuse();sourceRequests++;return new Response(JSON.stringify(u.pathname.endsWith('/projects')?{data:[{id:plan.sourceProject}]}:{data:rows,meta:{cursor:null}}),{headers:{'content-type':'application/json'}});},
  destinationFetch:async(url,init)=>{if(new Headers(init?.headers).has('cookie'))cookiesForwarded++;if(new URL(url).origin!==descriptor.destination_origin||new URL(url).pathname!=='/api/batches')refuse();destinationRequests++;const r=await handle(new Request(url,init),env);Object.defineProperty(r,'url',{value:url});return r;}
 };
 const workerOptions={hostOptions,approvalProvider:consents.provide,authorize,leaseProvider:async d=>({approval_id:d.approval_id,binding_id:d.binding_id,binding_hash:d.binding_hash,lease:d.side==='source'?{origin:plan.origin,projectId:plan.sourceProject,traceId:plan.traceId,publicKey:'synthetic-only-public',secretKey:'synthetic-only-secret',expiresAt:Math.min(d.request.expiresAt,descriptor.expires_at*1000,Date.now()+60000)}:{origin:descriptor.destination_origin,project_id:project,write_key:writeKey,expires_at:Math.min(d.request.expires_at,descriptor.expires_at,store.now()+60)}})};
 const worker=loadPrivateImportWorker({distribution,workerOptions}),launcher=loadPrivateImportLauncher({distribution,launcherOptions:{...workerOptions,authenticate:createPrivateImportAuthenticator({store,origin:descriptor.destination_origin})}});
 env.importStartController=createImportStartController({store,objects,origin:descriptor.destination_origin,runtime,consents,authorize,readiness:async()=>ready()});
 phase='protected_consent';await consents.registerReviewedApproval(request(),record);
 phase='start_api';const start=await handle(request(),env),job=await start.json();if(start.status!==202||job.execution_started!==false||job.assignment_state!=='pending'||sourceRequests||destinationRequests)refuse();
 phase='host_execution';const result=await worker.runNext(),target={approval_id:approvalId,job_id:job.job_id},status=await launcher.status(request(),target),raw=await launcher.download(request(),target),archive=JSON.parse(raw);
 phase='export_verification';const observations=archive.runs.flatMap(run=>run.events.map(e=>e.data.observation));
 if(result.outcome!=='import-export-verified'||result.job_id!==job.job_id||result.assignment_state!=='complete'||status.dispatch.state!=='complete'||archive.event_count!==2||observations.length!==2||observations.find(r=>r.id==='child')?.parentObservationId!=='root'||sourceRequests!==2||destinationRequests!==2||cookiesForwarded)refuse();
 phase='explicit_release';const released=await worker.releaseCompleted(),records=[...client.items.values()],resultAudits=records.filter(r=>r.sk.startsWith('RESULT#')).length,releaseAudits=records.filter(r=>r.sk.startsWith('RELEASE#')).length;
 if(released.assignment_state!=='released'||resultAudits!==1||releaseAudits!==1||JSON.stringify(records).includes(token)||JSON.stringify(records).includes(writeKey))refuse();
 const readiness=inspectPrivateHostReadiness({...readinessConfig,directory:workspace});
 const receipt={schema_version:1,type:'supatrace_private_host_synthetic_receipt',synthetic:true,hosted:false,live_authority:false,aws_requests:0,provider_requests:0,synthetic_source_requests:sourceRequests,synthetic_destination_requests:destinationRequests,protected_consent_verified:hash(await consents.provide({approval_id:approvalId}))===approvalId,start_status:start.status,execution_started_at_start:job.execution_started,assignment_discovery:'pinned-worker-slot',assignment_state:released.assignment_state,result_audits:resultAudits,release_audits:releaseAudits,cookies_forwarded:cookiesForwarded,node_major:22,python_version:'3.12',revision:proof.revision,archive_sha256:proof.artifact_hash,manifest_sha256:proof.manifest_hash,job_id:job.job_id,event_count:2,export_sha256:digest(raw),export_verified:true,readiness,readiness_scope:readiness.mount_verified?'linux-mount-and-runtime-pins':'local-filesystem-only',durability_scope:'memory-store-with-retained-local-files; not restart or host acceptance',automatic_replay:false};
 save(join(workspace,'synthetic-result.json'),receipt);console.log(JSON.stringify(receipt));
}
try{await main();}catch(error){const safe=new Set(['synthetic_mount_records','synthetic_readiness_file','synthetic_interpreter_file','synthetic_mount_file','synthetic_runtime_identity','synthetic_platform_override','synthetic_directory_identity','synthetic_interpreter_pin','synthetic_interpreter_version','synthetic_mount_config','synthetic_mount_identity']);const reason=safe.has(error?.code)?error.code:phase;console.error('Synthetic private-host acceptance incomplete ['+reason+']. Preserve the selected workspace and reconcile; do not reuse or delete it to force a retry. No live authority was configured.');process.exitCode=1;}
