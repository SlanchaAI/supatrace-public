import {supportInfo,submitSupport} from './support.mjs';
import {apiDiagnostic} from './api-diagnostic.mjs';
import {serverPullAvailable,SERVER_PULL_LIMITS} from './server-pull-import.mjs';
import {importStartAvailable} from './import-start.mjs';
import {importConsentReviewAvailable} from './import-consent-review.mjs';
import {importJobApi,importJobControlAvailable} from './import-job-api.mjs';
import {deleteAccount} from './account-deletion.mjs';
import {identityApi} from './identity-links.mjs';
import {integrationsApi} from './integrations.mjs';
import {Workspaces,workspaceApi,workspaceSession,environmentStore,environmentId,authorizeIssuedKey} from './workspaces.mjs';
import {mcpBridgeApi} from './mcp-bridge-api.mjs';
import {importCapabilities,planCustomerImport} from './import-planning.mjs';
import {commercialPlanProjection,commercialBillingState} from './commercial-policy.mjs';
import {fulfillCommercialAccount,enrollCommercialAccount} from './commercial-fulfillment.mjs';
import {checkout as billingCheckout,webhook as billingWebhook,portal as billingPortal,billingStatus,sandboxEntitlement} from './stripe-billing.mjs';
import {accountRunsPage} from './run-page.mjs';
import {parseBatch,IntakeError} from './trace.mjs';
import {otlpTraces} from './otlp-ingest.mjs';
import {drainApi,listDrains,enqueueDrainDeliveries,deliverDrains,DRAIN_LIMITS} from './drains.mjs';
import {langfuseIngestion,langfuseFailure} from './langfuse-ingest.mjs';
import {accessTokenActor,accessTokenApi,managementRoute} from './access-tokens.mjs';
import {MANAGEMENT_OPENAPI} from './management-openapi.mjs';
import {json,boundedText,requireOrigin,HttpError,securityHeaders} from './http.mjs';
import {keyScopeLabel,storedKeyType,NO_EXPIRY,parseKeyToken} from './key-model.mjs';
import {sessionRow,writer,writeBinding,keyBinding,writeToken,login,googleLogin,callback,devSession,cookie,digest,setCookie} from './aws-auth.mjs';
import {providerFlags,chatgptLogin,chatgptCallback,ssoStart,ssoCallback,emailSignUp,emailVerify,emailConfirm,emailSignIn,emailReset,emailResetConfirm,emailResetPassword,mfaVerify,mfaRecovery,mfaEnroll,mfaConfirm,mfaDisable} from './dashboard-auth.mjs';
import {accountPlanConfiguration} from './plans.mjs';
import {recordUsageAlert} from './usage-alerts.mjs';
import {notifyProjectPaused} from './project-pause.mjs';
import {IDLE_PAUSE,RESUME_PATH,projectLifecycle,retentionDays} from './plan-limits.mjs';
import {requireAlphaProject,requireProject} from './alpha-projects.mjs';
import {auditApi,recordAudit} from './audit.mjs';
import {ingestAttempt,ingestFailure,recordIngest,ingestLogApi} from './ingest-log.mjs';
import {authorizeRoute,can} from './roles.mjs';
import {scimApi,deploymentDomains} from './org-sso.mjs';
import {mfaEnabled} from './dashboard-auth.mjs';
import {envForRequest,originsAreProduction} from './origins.mjs';
import {entitlementsFor,entitlementDetails,hasFeature,requireFeature} from './entitlements.mjs';
import {planBillingAvailable,planCatalog,subscribe as planSubscribe,manage as planManage,changePlan,syncPlan,planWebhook} from './plan-billing.mjs';
import {prepareOverage} from './plan-overage.mjs';
const sorts=new Set(['started','agent','duration','events','status']);
function authRecovery(request,error){
 if(request.method!=='GET'||!request.headers.get('accept')?.includes('text/html'))return null;
 const path=new URL(request.url).pathname;
 const provider=path==='/api/auth/google/callback'?'google':path==='/api/auth/callback'?'github':null;
 if(!provider)return null;
 const reasons={identity_provider_unavailable:'provider_unavailable',invalid_oauth_state:'restart_required',expired_oauth_state:'restart_required',identity_not_verified:'not_verified',google_sign_in_unavailable:'provider_unavailable',github_sign_in_unavailable:'provider_unavailable'};
 const reason=reasons[error.code]||'unavailable';
 const headers=new Headers(securityHeaders({Location:'/app/?auth_error='+reason+'&provider='+provider}));
 headers.append('Set-Cookie',setCookie('__Host-supatrace-oauth','',0));
 return new Response(null,{status:303,headers});
}
function runsQuery(url){
 const limit=url.searchParams.has('limit')?Number(url.searchParams.get('limit')):25;
 const offset=url.searchParams.has('offset')?Number(url.searchParams.get('offset')):0;
 if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0||offset>100000)throw new HttpError(400,'invalid_query');
 const sort=url.searchParams.get('sort')||'started',dir=url.searchParams.get('dir')||'desc';
 if(!sorts.has(sort)||(dir!=='asc'&&dir!=='desc'))throw new HttpError(400,'invalid_query');
 const q=url.searchParams.get('q')||'',agent=url.searchParams.get('agent')||'';
 if(q.length>128||/[^\w.:-]/.test(q)||(agent&&!/^[a-f0-9]{64}$/.test(agent)))throw new HttpError(400,'invalid_query');
 const bound=name=>{const value=url.searchParams.get(name)||'';if(!value)return null;const ms=Date.parse(value);if(!Number.isFinite(ms))throw new HttpError(400,'invalid_query');return ms;};
 return {limit,offset,sort,dir,q,agent,from:bound('from'),to:bound('to')};
}
function runView(row){
 const created=Number.isFinite(row.created_at)?row.created_at:0;
 const started=Number.isFinite(row.started_at)?row.started_at:null;
 const ended=Number.isFinite(row.ended_at)?row.ended_at:null;
 const agents=Array.isArray(row.writers)?row.writers.filter(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)):[];
 const events=Number.isSafeInteger(row.event_count)?row.event_count:null;
 return {id:row.run_id||row.id,created_at:new Date(created*1000).toISOString(),started_at:started==null?null:new Date(started).toISOString(),ended_at:ended==null?null:new Date(ended).toISOString(),duration_ms:started==null||ended==null?null:Math.max(0,ended-started),event_count:events,batch_count:Number.isSafeInteger(row.batch_count)?row.batch_count:null,byte_count:Number.isSafeInteger(row.byte_count)?row.byte_count:null,agents,status:row.has_error===true?'error':row.has_error===false?'ok':null,
  // When this run stops being listed and exported. null: stored before retention stamping, no expiry applies.
  expires_at:Number.isSafeInteger(row.retention_expires_at)&&row.retention_expires_at>0?new Date(row.retention_expires_at*1000).toISOString():null};
}
function runStart(run){return run.started_at?Date.parse(run.started_at):Date.parse(run.created_at);}
async function runPage(store,tenant,url){
 const query=runsQuery(url);
 const rows=[];let cursor,truncated=false;
 for(let page=0;page<8;page++){
  const result=await store.listRuns(tenant,{cursor,limit:100});
  rows.push(...result.items);
  if(!result.next){truncated=false;break;}
  cursor=result.next;truncated=page===7;
 }
 let runs=rows.map(runView).filter(run=>{
  if(query.q&&!run.id.includes(query.q))return false;
  if(query.agent&&!run.agents.includes(query.agent))return false;
  const start=runStart(run);
  if(query.from!=null&&start<query.from)return false;
  if(query.to!=null&&start>query.to)return false;
  return true;
 });
 const value=run=>{if(query.sort==='agent')return run.agents[0]||'';if(query.sort==='duration')return run.duration_ms??-1;if(query.sort==='events')return run.event_count??-1;if(query.sort==='status')return run.status||'';return runStart(run);};
 runs.sort((a,b)=>{const left=value(a),right=value(b);const order=left<right?-1:left>right?1:0;return (query.dir==='asc'?order:-order)||(a.id<b.id?-1:a.id>b.id?1:0);});
 const page=runs.slice(query.offset,query.offset+query.limit);
 return {runs:page,total:runs.length,offset:query.offset,limit:query.limit,truncated,next:query.offset+query.limit<runs.length?String(query.offset+query.limit):null};
}
const devOn=env=>env.DEV_AUTH===true&&typeof env.APP_ORIGIN==='string'&&/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(env.APP_ORIGIN);
const ready=env=>env.ENABLED===true&&!!env.store&&!!env.objects&&!!env.GITHUB_CLIENT_ID&&!!env.GITHUB_CLIENT_SECRET&&(originsAreProduction(env)||devOn(env));
// Only the plan-allowance and spend-cap rejections carry a body beyond the code, and only these own-account fields.
const ALLOWANCE_CODES=new Set(['monthly_span_allowance_exceeded','stored_bytes_allowance_exceeded','spend_cap_reached','project_paused']);
function allowanceDetails(error){
 const d=error?.details;if(!ALLOWANCE_CODES.has(error?.code)||!d||typeof d!=='object')return {};
 const out={};for(const key of ['message','plan','period','unit','limit','used','requested','resets_at','upgrade_url','cost_control_url','paused_at','resume_url'])if(typeof d[key]==='string'||Number.isSafeInteger(d[key]))out[key]=d[key];return out;
}
// Idle-pause state for the dashboard. Paid plans and commercially managed accounts never pause.
function lifecycleView(life){
 const iso=seconds=>new Date(seconds*1000).toISOString();
 return {lifecycle:life.exempt?{state:'active',pauses_when_idle:false}:{state:life.state,pauses_when_idle:true,idle_days:IDLE_PAUSE.days,warn_days:IDLE_PAUSE.warn_days,last_upload_at:life.last_accepted_at===null?null:iso(life.last_accepted_at),pauses_at:iso(life.pauses_at),resume_url:RESUME_PATH}};
}
function planAllowance(usage,account,projectsUsed=1,physical=false){
 // Retention in force: the plan's days, or the organization's own choice on a plan with custom retention.
 const {period}=usage,plan={...usage.plan,retention_days:retentionDays(account,usage.plan)},iso=seconds=>new Date(seconds*1000).toISOString();
 return {plan_limits:{plan_id:plan.id,name:plan.name,spans_per_month:plan.spans_per_month,stored_bytes:plan.stored_bytes,retention_days:plan.retention_days,projects:plan.projects,hard_stop:usage.spend_cap.enabled,version:usage.limits_version,status:usage.limits_status},
  monthly:{period:period.id,starts_at:iso(period.starts_at),resets_at:iso(period.resets_at),spans_used:usage.spans_used,spans_limit:plan.spans_per_month,spans_remaining:Math.max(0,plan.spans_per_month-usage.spans_used),bytes_ingested:usage.bytes_ingested,batches:usage.batches},
  projects:{used:projectsUsed,limit:plan.projects},
  // enabled: uploads stop at the included spans. configurable: the plan has overage, so the owner may turn the cap off.
  spend_cap:{enabled:usage.spend_cap.enabled,configurable:usage.spend_cap.configurable,default_enabled:usage.spend_cap.default_enabled,overage_usd_per_million_spans:plan.overage_usd_per_million_spans,overage_spans:Math.max(0,usage.spans_used-plan.spans_per_month)},
  // Reads hide expired data immediately. Physical removal follows the bounded five-minute sweep.
  retention:{days:plan.retention_days,enforcement:physical?'scheduled_physical_expiry':'hidden_after_expiry',physical_deletion:physical,applies_to:'data_accepted_after_retention_stamping'}};
}
// Last use is display metadata. The batch is already durable when this runs, so the receipt waits at most
// KEY_USE_STAMP_MS for the stamp and ignores its outcome. A stamp that misses the window may or may not land;
// the next upload tries again.
export const KEY_USE_STAMP_MS=250;
async function stampKeyUse(store,binding){
 if(typeof store.touchKeyUse!=='function')return;
 let timer;
 try{await Promise.race([Promise.resolve().then(()=>store.touchKeyUse(binding)).catch(()=>{}),new Promise(resolve=>{timer=setTimeout(resolve,KEY_USE_STAMP_MS);})]);}
 finally{clearTimeout(timer);}
}
function rateLimited(rate){
 const seconds=Number.isFinite(rate.retry_after)&&rate.retry_after>0?Math.ceil(rate.retry_after):60;
 const response=json({error:'rate_limit'},429);response.headers.set('Retry-After',String(seconds));return response;
}
// One write-key scope for every ingest route: key → tenant, issuer still authorised, environment bound to the key, per-workspace upload rate.
// `attempt` is the request's ingest-log tally: it is bound as soon as the key names a workspace, so a refusal after that point is recorded.
async function writeScope(request,env,url,{keyEnvironment=false,basic=false,attempt=null}={}){
 const binding=await writeBinding(request,env.store,{basic});attempt?.bind(binding);
 const tenant=binding.tenant_id,legacy=requireAlphaProject(tenant,null),requested=url.searchParams.get('project')??binding.project_id,project=requested==null||requested===legacy.id?legacy:await requireProject(env.store,tenant,requested);if(project.id!==(binding.project_id??legacy.id))throw new HttpError(403,'project_unavailable');
 const keyAccess=await authorizeIssuedKey(env.store,binding);
 const destination=keyEnvironment&&!url.searchParams.has('environment')?(binding.environment_id??'default'):environmentId(url.searchParams.get('environment')??'default');if(destination!==(binding.environment_id??'default'))throw new HttpError(403,'environment_unavailable');
 await new Workspaces(env.store,null,null,false,null,[],project.id).environment(tenant,destination);const store=environmentStore(env.store,{owner:tenant,project:project.id,environment:destination,keyBinding:binding,keyAccess});
 const limited=await store.consumeRate({scope:'upload',identity:tenant,limit:30,windowSeconds:60});
 return {tenant,project,destination,store,binding,attempt,writer:digest(writeToken(request,{basic})),limited:limited.allowed?null:limited};
}
// Reserve quota, store the exact bytes immutably, then accept. A repeat of an accepted batch is a no-op.
// After an ingest request has stored its batches: attempt queued drain deliveries within a small budget. Never fails the request.
// A request that stored nothing new (a resent batch) still runs the pass, so queued deliveries are retried by any upload.
const drainAfterIngest=async(env,scope)=>{if(scope&&(scope.drains===undefined||scope.drains.length))await deliverDrains(env,scope.tenant,{drains:scope.drains??null});};
async function storeBatch(env,scope,raw,requestHash,batch){
 let record;try{record=await scope.store.reserveBatch(scope.tenant,{batch_id:batch.batch_id,run_id:batch.run_id,request_hash:requestHash,byte_count:Buffer.byteLength(raw),event_count:batch.events.length});}
 // First upload refused by an idle pause: write the pause notice (and email it when the SES path is configured), once per pause.
 catch(error){if(error?.code==='project_paused'&&Number.isSafeInteger(error.details?.paused_instant))await notifyProjectPaused(env,scope.store,scope.tenant,error.details.paused_instant);throw error;}
 // The reservation says when it reached an alert threshold not yet recorded this month. The notification row is
 // written now; any email waits until the batch is accepted and is time-bounded. Best effort, never fatal.
 const alert=record.usageAlert?await recordUsageAlert(env,scope.store,scope.tenant,record.usageAlert):null;
 const fresh=record.status!=='accepted';
 if(fresh){await env.objects.putImmutable(record.object_key,raw,requestHash);
  const times=batch.events.map(event=>Date.parse(event.time));await scope.store.acceptReservedBatch(scope.tenant,batch.batch_id,requestHash,{writer:scope.writer,started_at:Math.min(...times),ended_at:Math.max(...times),has_error:batch.events.some(event=>event.kind==='error')});}
 scope.attempt?.stored(batch,raw,fresh);
 // Every ingest route (batches, OTLP, Langfuse) records the key's last use here.
 await stampKeyUse(scope.store,scope.binding);
 // Drains: queue the delivery once the batch is accepted and before the upload is answered. A resent upload of a recently accepted batch
 // queues it too (idempotently), which covers an earlier attempt that was accepted but failed before queueing.
 scope.drains??=await listDrains(env.store,scope.tenant);
 // Delivery is the trace_drains feature: an organization on a plan without it keeps its drains but nothing is queued for them.
 if(scope.drains.length&&!hasFeature(typeof env.store.planId==='function'?await env.store.planId(scope.tenant):null,'trace_drains'))scope.drains=[];
 if(scope.drains.length&&(fresh||env.store.now()-record.created_at<DRAIN_LIMITS.requeueSeconds))await enqueueDrainDeliveries(env.store,scope.drains,{tenant:scope.tenant,project:scope.project.id,environment:scope.destination,record,batch});
 // The alert email, if one is due, goes last: after the batch is accepted and its drain deliveries are queued.
 if(alert?.deliver)await alert.deliver();
}
export async function handle(request,baseEnv){
 try{
 if(!ready(baseEnv))return json({error:'service_not_configured'},503);
 const env=envForRequest(request,baseEnv);
 let url=new URL(request.url),path=url.pathname,store=env.store;
 for(const p of ['workspace','environment','project'])if(url.searchParams.getAll(p).length>1)throw new HttpError(400,'invalid_query');
 // Scope reloads make several dashboard reads. Allow normal setup and shared NAT use; sensitive routes keep tighter budgets.
 const rate=await store.consumeRate({scope:'request',identity:env.sourceIp||'unknown',limit:300,windowSeconds:60});if(!rate.allowed)return rateLimited(rate);
 // OTLP/HTTP receiver. /api/otlp/v1/traces is the same receiver under the /api/ prefix; /api/public/otel/v1/traces is where Langfuse SDKs send OTLP with Basic auth.
 let ingested=null;const afterIngest=async response=>{await drainAfterIngest(env,ingested);return response;};
 // Ingest log: each route below records its outcome for the workspace the key resolved to. `logged` runs one OTLP or Langfuse request.
 let attempt=null;
 const logged=async(route,run)=>{attempt=ingestAttempt(route);let seen=null;const response=await run(result=>{seen=result;});await recordIngest(env.store,attempt,seen??{status:response.status});return response;};
 const ingestScope=basic=>async()=>{const scope=ingested=await writeScope(request,env,url,{keyEnvironment:true,basic,attempt});if(scope.limited){const error=new HttpError(429,'rate_limit');error.retryAfter=Number.isFinite(scope.limited.retry_after)&&scope.limited.retry_after>0?scope.limited.retry_after:60;throw error;}return {store:planned=>storeBatch(env,scope,planned.raw,planned.request_hash,planned.batch)};};
 if(request.method==='POST'&&(path==='/v1/traces'||path==='/api/otlp/v1/traces'))return await afterIngest(await logged('otlp',observe=>otlpTraces(request,{authorize:ingestScope(false),observe})));
 if(request.method==='POST'&&path==='/api/public/otel/v1/traces')return await afterIngest(await logged('otlp',observe=>otlpTraces(request,{authorize:ingestScope(true),observe})));
 // Langfuse-compatible surface: batch ingestion plus the two reads SDKs use to check a connection.
 if(request.method==='POST'&&path==='/api/public/ingestion')return await afterIngest(await logged('langfuse',observe=>langfuseIngestion(request,{authorize:ingestScope(true),observe})));
 if(request.method==='GET'&&path==='/api/public/health')return json({status:'OK',version:'supatrace-langfuse-compat-1'});
 if(request.method==='GET'&&path==='/api/public/projects'){try{const binding=await writeBinding(request,env.store,{basic:true});await authorizeIssuedKey(env.store,binding);const project=await requireProject(env.store,binding.tenant_id,binding.project_id);return json({data:[{id:project.id,name:project.name,organization:{id:project.id,name:'SupaTrace workspace'},metadata:{}}]});}catch(error){return langfuseFailure(error);}}
 if(path.startsWith('/api/public/'))return json({error:'NotFoundError',message:'SupaTrace serves only POST /api/public/ingestion, POST /api/public/otel/v1/traces, GET /api/public/projects and GET /api/public/health of the Langfuse API.',code:'langfuse_endpoint_unsupported'},404);
 // SCIM 2.0 provisioning: authenticated by an organization's SCIM bearer token, never by a session.
 if(path==='/api/scim/v2'||path.startsWith('/api/scim/v2/'))return await scimApi(request,env);
 if(path.startsWith('/api/mcp/'))return await mcpBridgeApi(request,env,{runView});
 // Stripe events. With test-mode plan billing configured they move plans (src/plan-billing.mjs); otherwise the older sandbox capture answers.
 if(request.method==='POST'&&path==='/api/billing/webhook')return planBillingAvailable(env)&&env.planBilling.webhookSecret?await planWebhook(request,env):await billingWebhook(request,env);
 if(request.method==='GET'&&path==='/api/auth/providers')return json(await providerFlags(request,env));
 if(request.method==='GET'&&path==='/api/auth/login')return await login(request,env);
 if(request.method==='GET'&&path==='/api/auth/google')return await googleLogin(request,env);
 if(request.method==='GET'&&path==='/api/auth/chatgpt')return await chatgptLogin(request,env);
 if(request.method==='GET'&&path==='/api/auth/callback')return await callback(request,env,env.fetcher||fetch,'github');
 if(request.method==='GET'&&path==='/api/auth/google/callback')return await callback(request,env,env.fetcher||fetch,'google');
 if(request.method==='GET'&&path==='/api/auth/chatgpt/callback')return await chatgptCallback(request,env,env.fetcher||fetch);
 if(request.method==='GET'&&path==='/api/auth/dev/session'){if(!devOn(env))return json({error:'not_found'},404);return await devSession(request,env);}
 if(request.method==='GET'&&path==='/api/auth/sso')return await ssoStart(request,env);
 if(request.method==='POST'&&path==='/api/auth/sso/callback')return await ssoCallback(request,env);
 if(request.method==='POST'&&path==='/api/auth/email/sign-up')return await emailSignUp(request,env);
 if(request.method==='GET'&&path==='/api/auth/email/verify')return await emailVerify(request,env);
 if(request.method==='POST'&&path==='/api/auth/email/verify')return await emailConfirm(request,env);
 if(request.method==='POST'&&path==='/api/auth/email/sign-in')return await emailSignIn(request,env);
 if(request.method==='POST'&&path==='/api/auth/email/reset')return await emailReset(request,env);
 if(request.method==='POST'&&path==='/api/auth/email/reset/confirm')return await emailResetConfirm(request,env);
 if(request.method==='POST'&&path==='/api/auth/email/reset/password')return await emailResetPassword(request,env);
 if(request.method==='POST'&&path==='/api/auth/mfa')return await mfaVerify(request,env);
 if(request.method==='POST'&&path==='/api/auth/mfa/recovery')return await mfaRecovery(request,env);
 if(request.method==='POST'&&path==='/api/batches'){
 attempt=ingestAttempt('batches');let scope,batch,requestHash;
 try{
 scope=await writeScope(request,env,url,{attempt});if(scope.limited){await recordIngest(env.store,attempt,{status:429,code:'rate_limit'});return rateLimited(scope.limited);}
 const raw=await boundedText(request);requestHash=digest(raw);if(request.headers.get('x-amz-content-sha256')!==requestHash)throw new HttpError(400,'payload_hash_required');
 batch=parseBatch(raw).batch;await storeBatch(env,scope,raw,requestHash,batch);await drainAfterIngest(env,scope);
 }catch(error){await recordIngest(env.store,attempt,ingestFailure(error));throw error;}
 await recordIngest(env.store,attempt,{status:201});
 return json({accepted:true,batch_id:batch.batch_id,request_hash:requestHash,project_id:scope.project.id,...(scope.destination!=='default'?{environment_id:scope.destination}:{})},201);
 }
 if(request.method==='POST'&&path==='/api/setup/start'){const data=JSON.parse(await boundedText(request,4096));return json(await store.createSetup(data.key_hash,url.searchParams.get('project'),environmentId(url.searchParams.get('environment')??'default')),201);}
 if(request.method==='POST'&&path==='/api/setup/poll'){const data=JSON.parse(await boundedText(request,4096));return json(await store.pollSetup(data.device_secret));}
 // Management API: a personal access token authenticates GET requests on an explicit route table that maps onto the handlers below.
 if(request.method==='GET'&&path==='/api/v1/openapi.json')return json(MANAGEMENT_OPENAPI);
 let token=null;
 if(path.startsWith('/api/v1/')){
  const route=managementRoute(request.method,url);
  // A secret key (st_sec_) reads traces and events of its own workspace and environment only, acting as the member who
  // issued it, so a removed member's key stops reading. Usage is workspace-wide (every environment, billing), so it and
  // the account routes stay with personal access tokens.
  if(parseKeyToken(writeToken(request))?.type==='secret'){
   const binding=await keyBinding(request,store,'read');await authorizeIssuedKey(store,binding);
   if(route.custom||!['/api/runs','/api/events'].includes(route.url.pathname))throw new HttpError(403,'key_scope_denied');
   const bound={workspace:binding.tenant_id,project:binding.project_id??alphaProject(binding.tenant_id).id,environment:binding.environment_id??'default'};
   for(const name of Object.keys(bound))if(route.url.searchParams.has(name)&&route.url.searchParams.get(name)!==bound[name])throw new HttpError(403,'key_scope_denied');
   for(const [name,value] of Object.entries(bound))route.url.searchParams.set(name,value);
   token={tenant_id:binding.issued_by??binding.tenant_id,token_hash:binding.token_hash};
  }else token=await accessTokenActor(request,store);
  const allowed=await store.consumeRate({scope:'management',identity:token.token_hash,limit:120,windowSeconds:60});if(!allowed.allowed)return rateLimited(allowed);
  if(route.custom==='me')return json({account_id:token.tenant_id,token:{id:token.token_hash,name:token.name,scope:token.scope,expires_at:new Date(token.expires_at*1000).toISOString()}});
  if(route.custom){const spaces=new Workspaces(store),list=await spaces[route.custom==='workspaces'?'list':'projects'](token.tenant_id);return json(route.custom==='workspaces'?{workspaces:list.map(w=>({id:w.workspace_id??token.tenant_id,name:w.workspace_name??w.name,role:w.role??'owner',shared:w.shared===true}))}:{projects:list.map(w=>({id:w.id,name:w.name,workspace_id:w.workspace_id??token.tenant_id,role:w.role??'owner'}))});}
  url=route.url;path=url.pathname;
 }
 // A session carries its SSO binding (see Workspaces.ssoMissing); a token or key has none.
 const signedIn=token?null:await sessionRow(request,store);
 const actor=token?token.tenant_id:signedIn.tenant_id;
 if(path==='/api/account/delete'){if(token)throw new HttpError(403,'session_required');return await deleteAccount(request,env,actor,signedIn);}
 // Tokens are created and revoked from a signed-in browser session only, never with a token.
 if(path==='/api/tokens'||path==='/api/tokens/revoke'){if(token)throw new HttpError(403,'session_required');return await accessTokenApi(request,env,actor);}
 // Linked sign-in methods are read and changed from a signed-in browser session only.
 if(path==='/api/auth/identities'||path.startsWith('/api/auth/identities/')){if(token)throw new HttpError(403,'session_required');return await identityApi(request,env,actor);}
 if(path==='/api/projects'&&request.method==='POST'||path.startsWith('/api/projects/')||path==='/api/workspaces'||path.startsWith('/api/workspaces/')||path==='/api/environments'||path.startsWith('/api/environments/')||path==='/api/orgs'||path.startsWith('/api/orgs/')){if(token&&path.startsWith('/api/orgs'))throw new HttpError(403,'session_required');return await workspaceApi(request,env,actor);}
 const spaces=new Workspaces(store,null,null,mfaEnabled(env),signedIn?.sso??null,deploymentDomains(env));
 if(request.method==='GET'&&path==='/api/projects')return json({projects:await spaces.projects(actor)});
 const security=path==='/api/me'||path.startsWith('/api/auth/');if(security)requireAlphaProject(actor,url.searchParams.get('project'));
 // Billing belongs to an organization and only its owner reaches it: the account for a personal organization, the owner member for a created one.
 if(path.startsWith('/api/billing/')&&(url.searchParams.get('environment')??'default')!=='default')throw new HttpError(403,'workspace_owner_required');
 const tenant=security?actor:(url.searchParams.get('workspace')??actor),access=await spaces.access(actor,tenant),project=await requireProject(store,tenant,security?null:url.searchParams.get('project'));spaces.project=project.id;
 const destination=await spaces.environment(tenant,security?'default':(url.searchParams.get('environment')??'default'));
 // One table (src/roles.mjs) decides every role and environment check for the routes below. Account routes (/api/me, /api/auth/*) act on the caller only.
 if(!security){authorizeRoute(access,request.method,path,destination);await spaces.requireMfa(actor,access);}
 if(path.startsWith('/api/imports/')&&(tenant!==actor||destination!=='default'||project.id!==requireAlphaProject(tenant,null).id))throw new HttpError(403,'import_scope_unavailable');
 const stamp=request.method==='POST'&&!security&&(access.shared||destination!=='default'||project.id!==requireAlphaProject(tenant,null).id)?await workspaceSession(request,store,actor):null;
 store=environmentStore(store,{owner:tenant,project:project.id,environment:destination,stamp,access,issuer:actor});
 // Audit context for this request. Store changes below add their event to their own transaction.
 const auditContext={workspace:tenant,actor,ip:env.sourceIp};store.audit=auditContext;
 const audited=async(response,action,target=null,detail={})=>{if(response.ok)await recordAudit(store,auditContext,action,target,detail);return response;};
 if(path==='/api/audit'||path.startsWith('/api/audit/')){if(token)throw new HttpError(403,'session_required');return await auditApi(request,env,store,{tenant,actor,access});}
 // Ingest log of the selected workspace and environment: any member reads it, as any member reads the traces (the route
 // table lists it as `read`, `scoped`). Key prefixes are left out for a role that cannot list keys.
 if(request.method==='GET'&&path==='/api/logs')return await ingestLogApi(store,tenant,destination,url,{keys:can(access.role,'keys')});
 // Trace drains belong to the workspace (all environments); owners and admins manage them.
 if(path==='/api/drains'||path.startsWith('/api/drains/')){if(request.method==='POST')requireOrigin(request,env.APP_ORIGIN);return await drainApi(request,env,tenant,actor,store);}
 if(request.method==='GET'&&path==='/api/support')return json(await supportInfo(env,tenant));
 // What the organization's plan allows, with the counts the limits apply to. The dashboard reads every gate from here.
 if(request.method==='GET'&&path==='/api/entitlements'){
  const plan=typeof store.planId==='function'?await store.planId(tenant):null,answer=entitlementsFor(plan),now=store.now();
  answer.limits.retention_days=retentionDays(await store.getTenant(tenant));
  // role and billing_owner tell the dashboard whether this person may manage the plan (the owner, on Default).
  return json({workspace_id:tenant,role:access.role,billing_owner:access.role==='owner'&&destination==='default',...answer,usage:{seats:await spaces.seatsUsed(tenant),environments:(await spaces.environments(tenant)).length,api_keys:(await env.store.listWriteKeys(tenant,{limit:100})).items.filter(k=>!k.revoked&&!k.rotated_to&&k.expires_at>now).length,projects:1+((await env.store._get({pk:'TENANT#'+tenant,sk:'PROJECT_CAPACITY'}))?.count??0)}});
 }
 if(request.method==='GET'&&path==='/api/workspace')return json({workspace_id:tenant,project_id:project.id,name:access.name,role:access.role,environment_id:destination,billing_owner:access.role==='owner'});
 if(request.method==='GET'&&path==='/api/integrations')return await integrationsApi({store,base:env.store,tenant,actor,environment:destination,capabilities:{job_control_available:importJobControlAvailable(env),server_pull_available:serverPullAvailable(env.serverPullController)}});
 if(path==='/api/imports/jobs'||path.startsWith('/api/imports/jobs/'))return await importJobApi(request,env,tenant);

 // Plans, prices and what the owner can do next. Owner-only and Default-only by the /api/billing/ gate above.
 if(request.method==='GET'&&path==='/api/billing/catalog')return json(await planCatalog(env,store,tenant,auditContext));
 if(request.method==='GET'&&path==='/api/billing/sandbox-entitlement')return await sandboxEntitlement(env,tenant,project.id);
 if(request.method==='GET'&&path==='/api/billing/plans')return json(await commercialPlanProjection(env,tenant));
 if(request.method==='GET'&&path==='/api/billing/status')return json(commercialBillingState(billingStatus(env),typeof store.getCommercialQuotaView==='function'?await store.getCommercialQuotaView(tenant):null));
 if(request.method==='GET'&&path==='/api/me'){
 const mfaOn=env.MFA_ENABLED===true||env.MFA_ENABLED==='true';
 const row=typeof store.getTenant==='function'?await store.getTenant(tenant):null;
 // Project/account identity comes from the session. Never echo identity details or
 // secrets from the tenant row. Only the signed-in email account may see its address.
 const providers=['github','google','email','sso','chatgpt'];
 const authProvider=row?.tenant_id===tenant&&providers.includes(row.provider)&&project.accounting_scope===row.provider+'_account'?row.provider:null;
 const mfa=mfaOn&&typeof row?.mfa_secret==='string'&&row.mfa_secret.length>0;
 return json({tenant_id:tenant,project_id:project.id,auth_provider:authProvider,...(actor===tenant&&authProvider==='email'&&typeof row.email==='string'?{email:row.email}:{}),mfa,mfa_enabled:mfaOn});
 }
 if(request.method==='GET'&&path==='/api/usage'){
 const row=await store.getTenant(tenant);
 if(!row||!Number.isSafeInteger(row.used_bytes)||row.used_bytes<0||!Number.isSafeInteger(row.byte_limit)||(row.byte_limit<=0&&row.commercial_managed!==true))throw new HttpError(503,'usage_unavailable');
 // Whitelist own-tenant counters only. Reservations include pending uploads and do not reset monthly.
 // Unenrolled accounts read their stored-byte limit and monthly meters from the plan-limits table.
 const quota=typeof store.getCommercialQuotaView==='function'?await store.getCommercialQuotaView(tenant):null,planUsage=!quota?.enforced&&typeof store.getPlanUsage==='function'?await store.getPlanUsage(tenant):null,meters=planUsage&&typeof store.getUsageMeters==='function'?await store.getUsageMeters(tenant,planUsage.period.id):null,alerts=planUsage&&typeof store.listUsageAlerts==='function'?await store.listUsageAlerts(tenant,planUsage.period.id):null,limit=quota?.enforced?quota.limit_bytes:planUsage?planUsage.stored_limit:row.byte_limit;
 if(row.commercial_managed===true&&!quota)throw new HttpError(503,'commercial_controls_unavailable');
 const commercial=await commercialPlanProjection(env,tenant);let planState=accountPlanConfiguration(env.planCatalog,tenant);
 if(quota?.enforced){const p=store.commercialPolicy.policy,plan=p.plans.find(x=>x.id===quota.plan_id);planState={account_plan:{id:plan?.id||'commercial_blocked',name:plan?.name||'Commercial account awaiting reconciliation',scope:'authenticated_account',organization_id:null,commercial_plan_assignment:'versioned_live_policy',billing_status:quota.status,paid_active:quota.status==='active',paid_activation_enabled:quota.status==='active'},plan_configuration:{version:p.version,status:'versioned_live_policy',target_allowances_active:true,verified_billing_required:true}};}
 return json({quota_scope:{workspace_id:tenant,project_id:project.id,environment_id:destination,shared_across_environments:true},billing:commercialBillingState(billingStatus(env),quota),commercial:{...commercial,entitlement:quota||undefined},storage:{used_bytes:row.used_bytes,accepted_uploads:Number.isSafeInteger(row.upload_seq)&&row.upload_seq>=0?row.upload_seq:0,limit_bytes:limit,remaining_bytes:Math.max(0,limit-row.used_bytes),operational_limit_bytes:quota?.operational_limit_bytes??(planUsage?limit:row.byte_limit),accounting:'cumulative_reserved_bytes',limit_kind:quota?.enforced?'commercial_policy_with_operational_ceiling':planUsage?'plan_stored_bytes_allowance':'current_alpha_operational_ceiling'},...(planUsage?planAllowance(planUsage,row,1+((await env.store._get({pk:'TENANT#'+tenant,sk:'PROJECT_CAPACITY'}))?.count??0),env.RETENTION_ERASURE_MODE==='execute'):{}),...(planUsage?lifecycleView(projectLifecycle(row,typeof store.now==='function'?store.now():Math.floor(Date.now()/1000),planUsage.plan)):{}),
  // Recorded 80%/100% notifications for this month. The banner itself is derived from the live counts.
  ...(alerts?{alerts:alerts.map(a=>({kind:a.kind,level:a.level,period:a.period,used:a.used,limit:a.limit,email:a.email_status,created_at:new Date(a.created_at*1000).toISOString()}))}:{}),
  // Per-account meters by UTC calendar month. reserved_* are what the allowance counts and include uploads that are
  // pending or never finished; accepted_* are stored batches only and are what the Stripe test meter reports.
  // `stored_bytes` is the cumulative reserved total, not a monthly figure.
  ...(meters?{meters:{unit:'span',span_definition:'one_trace_event',period_kind:'calendar_month_utc',
  // The current month comes from the same snapshot as `monthly`, so the two can never disagree in one response.
  current:{period:planUsage.period.id,reserved_spans:planUsage.spans_used,accepted_spans:planUsage.accepted_spans,reserved_bytes:planUsage.bytes_ingested,accepted_bytes:planUsage.accepted_bytes,accepted_batches:planUsage.accepted_batches,stored_bytes:row.used_bytes},history:meters.history,stripe_test_meter:meters.reporting}}:{}),...planState});
 }
 if(request.method==='GET'&&path==='/api/imports/capabilities')return json({...importCapabilities(project.id),job_control_available:importJobControlAvailable(env)});
 if(request.method==='GET'&&path==='/api/runs/page')return json({...await accountRunsPage(store,tenant,url,{projectId:project.id,runView}),...(destination!=='default'?{environment_id:destination}:{})});
 if(request.method==='GET'&&path==='/api/runs') return json({...await runPage(store,tenant,url),...(destination!=='default'?{environment_id:destination}:{})});
 if(request.method==='GET'&&path==='/api/events'){
 const run=url.searchParams.get('run');if(!run||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(run))throw new HttpError(400,'invalid_run');
 const page=await store.listAcceptedBatchIndexes(tenant,run,{cursor:url.searchParams.get('after')||undefined,limit:1});const events=[];for(const row of page.items){const raw=await env.objects.get(row.object_key);if(digest(raw)!==row.request_hash)throw new HttpError(503,'stored_content_mismatch');const parsed=JSON.parse(raw);if(parsed.run_id!==run)throw new HttpError(503,'stored_run_mismatch');events.push(...parsed.events);}return json({events,next:page.next,...(destination!=='default'?{environment_id:destination}:{})});
 }
 if(request.method==='GET'&&path==='/api/keys'){const page=await store.listWriteKeys(tenant,{cursor:url.searchParams.get('after')||undefined,limit:100});return json({keys:page.items.map(k=>({id:k.token_hash,project_id:project.id,key_type:storedKeyType(k),scope:keyScopeLabel(storedKeyType(k)),environment_id:k.environment_id??'default',authorization_active:k.authorization_active!==false,expires_at:k.expires_at,no_expiry:k.expires_at>=NO_EXPIRY,revoked:!!k.revoked,created_at:k.created_at,...(Number.isSafeInteger(k.last_used_at)?{last_used_at:k.last_used_at}:{}),...(k.rotated_to?{rotated:true}:{})})),next:page.next,...(destination!=='default'?{environment_id:destination}:{})});}
 if(request.method==='POST'){
 requireOrigin(request,env.APP_ORIGIN);
 if(path==='/api/auth/logout'){const token=cookie(request,'__Host-supatrace');await store.deleteSession(digest(token));const headers=new Headers(securityHeaders());headers.append('Set-Cookie',setCookie('__Host-supatrace','',0));return new Response(null,{status:204,headers});}
 if(path==='/api/auth/mfa/enroll')return await mfaEnroll(request,env,tenant);
 if(path==='/api/auth/mfa/confirm')return await audited(await mfaConfirm(request,env,tenant),'settings.mfa_enabled',tenant);
 if(path==='/api/auth/mfa/disable'){
  // An account whose own organization requires two-factor authentication keeps it on: turning it off would shut the owner out of the page that turns it back on. Lift the rule first.
  if(mfaEnabled(env)&&(await store._get({pk:'TENANT#'+tenant,sk:'WORKSPACE#META'}))?.require_mfa===true)throw new HttpError(409,'mfa_required_by_organization');
  const enrolled=!!(await store.getTenant(tenant))?.mfa_secret,response=await mfaDisable(request,env,tenant);return enrolled?await audited(response,'settings.mfa_disabled',tenant):response;}
 // Support accepts 2,500 message characters; JSON escapes can take six bytes each.
 const data=JSON.parse(await boundedText(request,path==='/api/support'?20*1024:4096));
 if(path==='/api/support')return await audited(await submitSupport(env,{tenant,actor,project:project.id,environment:destination},data),'support.request');
 if(path==='/api/imports/plan'){const result=planCustomerImport(data,project.id);if(serverPullAvailable(env.serverPullController))result.capabilities.server_pull={available:true,mode:'bounded-server-pull-v1',limits:SERVER_PULL_LIMITS};return json(result);}
 if(path.startsWith('/api/imports/pull/')){if(!serverPullAvailable(env.serverPullController))throw new HttpError(503,'server_pull_unavailable');const action=path.slice('/api/imports/pull/'.length);if(action==='plan'){const result=planCustomerImport(data,project.id,{serverPull:true});result.capabilities.server_pull={available:true,mode:'bounded-server-pull-v1',limits:SERVER_PULL_LIMITS};return json(result);}const methods={review:'review',consent:'confirm',revoke:'revoke',start:'start',status:'status',advance:'advance'};if(!Object.hasOwn(methods,action))throw new HttpError(404,'not_found');return json(await env.serverPullController[methods[action]](request,data));}
 if(['/api/imports/review','/api/imports/consent','/api/imports/revoke'].includes(path)){if(!importConsentReviewAvailable(env.importConsentReviewController))throw new HttpError(503,'import_consent_unavailable');const action=path==='/api/imports/review'?'review':path==='/api/imports/consent'?'confirm':'revoke';return json(await env.importConsentReviewController[action](request,data));}
 if(path==='/api/imports/start'){if(!data||Object.getPrototypeOf(data)!==Object.prototype||Object.keys(data).some(key=>key!=='fingerprint')||!(/^[a-f0-9]{64}$/).test(data.fingerprint||''))throw new HttpError(400,'invalid_import_plan');if(!importStartAvailable(env.importStartController))throw new HttpError(503,'import_runtime_unavailable');return json(await env.importStartController.start(request,data),202);}
 if(path==='/api/billing/resume'){
  // One-click resume of an idle-paused project. Owner-only and default-environment-only by the /api/billing/ gate above.
  if(!data||Object.getPrototypeOf(data)!==Object.prototype||Object.keys(data).length||typeof store.resumeProject!=='function')throw new HttpError(400,'invalid_resume_request');
  const result=await store.resumeProject(tenant);return json({resumed:result.resumed,...lifecycleView(result.lifecycle)});
 }
 // Stripe test-mode plan billing: Checkout for Base or Pro, the customer portal, and a re-read of the subscription.
 if(path==='/api/billing/subscribe'){const limited=await store.consumeRate({scope:'checkout',identity:tenant,limit:10,windowSeconds:60});if(!limited.allowed)return rateLimited(limited);return await audited(json(await planSubscribe(env,store,tenant,actor,data)),'billing.checkout_started',null,{plan:data?.plan});}
 if(path==='/api/billing/manage')return await audited(json(await planManage(env,store,tenant,actor,data)),'billing.portal_opened');
 if(path==='/api/billing/change'){const limited=await store.consumeRate({scope:'planchange',identity:tenant,limit:5,windowSeconds:60});if(!limited.allowed)return rateLimited(limited);return json(await changePlan(env,store,tenant,actor,data));}
 if(path==='/api/billing/sync'){if(!data||Object.getPrototypeOf(data)!==Object.prototype||Object.keys(data).length)throw new HttpError(400,'invalid_billing_request');const limited=await store.consumeRate({scope:'plansync',identity:tenant,limit:20,windowSeconds:60});if(!limited.allowed)return rateLimited(limited);return json(await syncPlan(env,store,tenant,auditContext));}
 // Enterprise custom retention. Owner-only and Default-only by the /api/billing/ gate above. Body is exactly {days: integer|null}.
 if(path==='/api/billing/retention'){if(!data||Object.getPrototypeOf(data)!==Object.prototype||Object.keys(data).join()!=='days'||typeof store.setRetention!=='function')throw new HttpError(400,'invalid_retention');return json(await store.setRetention(tenant,data.days));}
 if(path==='/api/billing/spend-cap'){
  // Owner-only and default-environment-only by the /api/billing/ gate above. Body is exactly {enabled:boolean}.
  if(!data||Object.getPrototypeOf(data)!==Object.prototype||Object.keys(data).join()!=='enabled'||typeof data.enabled!=='boolean'||typeof store.setSpendCap!=='function')throw new HttpError(400,'invalid_spend_cap');
  requireFeature((await store.getTenant(tenant))?.plan_id,'spend_cap');
  const binding=data.enabled?null:await prepareOverage(env,store,tenant);
  return json({spend_cap:await store.setSpendCap(tenant,data.enabled,binding)});
 }
 // The request's own store: its writes carry the session fence and, for a created organization, the owner-membership fence.
 if(path==='/api/billing/controls/enroll')return await audited(await enrollCommercialAccount({...env,store},tenant,data),'billing.controls_enrolled');
 if(path==='/api/billing/reconcile')return await audited(await fulfillCommercialAccount({...env,store},tenant,data),'billing.reconciled');
 if(path==='/api/billing/portal')return await audited(await billingPortal(request,env,tenant,data),'billing.portal_opened');
 if(path==='/api/billing/checkout')return await audited(await billingCheckout(request,env,tenant,data),'billing.checkout_started');
 if(path==='/api/setup/approve')return json(await store.approveSetup(tenant,data.user_code));
 if(path==='/api/keys/revoke'){await store.revokeWriteKey(tenant,data.id);return json({revoked:true});}
 // Typed keys (#105). The browser generates the key and sends only its SHA-256; the session, not the request body, names the tenant.
 if(path==='/api/keys/create'||path==='/api/keys/rotate'){
 const create=path==='/api/keys/create',fields=create?['key_hash','key_type','expires_in']:['id','key_hash','overlap_seconds'];
 if(!data||Object.getPrototypeOf(data)!==Object.prototype||Object.keys(data).some(key=>!fields.includes(key)))throw new HttpError(400,'invalid_key_request');
 const limited=await store.consumeRate({scope:'keyissue',identity:tenant,limit:10,windowSeconds:60});if(!limited.allowed)return rateLimited(limited);
 const scope=row=>({...row,scope:keyScopeLabel(row.key_type)});
 if(create)return json(scope(await store.createApiKey(tenant,data)),201);
 const result=await store.rotateApiKey(tenant,data);return json({...result,key:scope(result.key)},201);
 }
 }
 return json({error:'not_found'},404);
 }catch(e){const recovery=authRecovery(request,e);if(recovery)return recovery;if(e instanceof SyntaxError)return json({error:'invalid_json'},400);if(e instanceof IntakeError)return json({error:e.code},400);if(e instanceof HttpError||Number.isInteger(e.status)){const response=json({error:e.code||'request_failed',...allowanceDetails(e),...entitlementDetails(e)},e.status);if(Number.isFinite(e.retryAfter)&&e.retryAfter>0)response.headers.set('Retry-After',String(Math.ceil(e.retryAfter)));return response;}apiDiagnostic(e,'api',baseEnv.apiDiagnostic);return json({error:'temporarily_unavailable'},503);}
}
