import {retryAfterMs} from './capture-retry.mjs';
import {convert,hash,LIMITS} from './langfuse.mjs';
import {normalizeTimestamp,compareTimestamps} from './timestamps.mjs';
import {LANGFUSE_SANITIZATION_POLICY,sanitizationDisclosure,sanitizeLangfusePage,assertSanitizedLangfuseRow,pseudonymizeLangfuseId} from './langfuse-sanitization.mjs';
const fields='core,basic,time,io,metadata,model,usage,prompt,metrics,trace_context';
const clone=v=>JSON.parse(JSON.stringify(v));
const containsCredential=(v,credential)=>JSON.stringify(v).includes(JSON.stringify(credential).slice(1,-1));
const fail=code=>{throw new Error(code);};
export function planCapture(spec){
 if(!spec||Object.keys(spec).some(k=>!['origin','sourceProject','environment','traceId','destinationProject','namespace','from','to','maxRows','maxPages','pageSize','maxBytes','maxRetries','sanitizationPolicy'].includes(k)))fail('invalid_spec');
 const selectedSanitization=Object.hasOwn(spec,'sanitizationPolicy'),sanitizationPolicy=selectedSanitization?spec.sanitizationPolicy:undefined;
 if('sanitizationPolicy' in Object(spec)&&!selectedSanitization||selectedSanitization&&sanitizationPolicy!==LANGFUSE_SANITIZATION_POLICY)fail('invalid_sanitization_policy');
 let u;try{u=new URL(spec.origin);}catch{fail('invalid_origin');}
 if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/')fail('https_origin_required');
 for(const k of ['sourceProject','destinationProject','namespace'])if(typeof spec[k]!=='string'||!spec[k].trim()||spec[k].length>200)fail('explicit_scope_required');
 if(Object.hasOwn(spec,'environment')&&(typeof spec.environment!=='string'||!spec.environment||spec.environment!==spec.environment.trim()||spec.environment.length>200||/[\u0000-\u001f\u007f]/.test(spec.environment)))fail('explicit_environment_required');
 const selectedTrace=Object.hasOwn(spec,'traceId'),traceId=selectedTrace?spec.traceId:undefined;
 if('traceId' in Object(spec)&&!selectedTrace)fail('explicit_trace_required');
 if(selectedTrace&&(typeof traceId!=='string'||!traceId||traceId!==traceId.trim()||traceId.length>200||/[\u0000-\u001f\u007f]/.test(traceId)||Buffer.from(traceId,'utf8').toString('utf8')!==traceId))fail('explicit_trace_required');
 if(normalizeTimestamp(spec.from)===null||normalizeTimestamp(spec.to)===null||compareTimestamps(spec.from,spec.to)>=0)fail('invalid_window');
 for(const [k,max] of [['maxRows',100000],['maxPages',1000],['pageSize',1000],['maxBytes',LIMITS.inputBytes]])if(!Number.isInteger(spec[k])||spec[k]<1||spec[k]>max)fail('explicit_bounds_required');
 if(!Number.isInteger(spec.maxRetries)||spec.maxRetries<0||spec.maxRetries>5)fail('retry_bound_required');
 const scope={...spec,...(selectedTrace?{traceId}:{}),...(selectedSanitization?{sanitizationPolicy}:{}),origin:u.origin},sanitization=scope.sanitizationPolicy?sanitizationDisclosure():null;return {schema_version:1,kind:'langfuse-read-only-capture',scope,fields,fingerprint:hash({scope,fields,...(sanitization?{sanitization}:{})}),...(sanitization?{sanitization}:{}),approvalRequired:['read-source','stage-destination'],warnings:['Observation rows only; no scores API, trace objects or attachment fetching.','Metadata values may be truncated by provider; no completeness claim.','Window is startTime inclusive/exclusive; live data may change and late arrivals require overlap reconciliation.','Destination is a declared binding only; this module never uploads or stages.',...(selectedTrace?['Observation request is pinned to the exact trace ID inside this bounded window; provider enforcement and trace completeness are not certified.']:[])]};
}
export function createCaptureCheckpoint(spec){
 const manifest=planCapture(spec),sanitized=!!manifest.scope.sanitizationPolicy;
 return {schema_version:sanitized?2:1,fingerprint:manifest.fingerprint,...(sanitized?{sanitizationPolicy:LANGFUSE_SANITIZATION_POLICY,sourceBytes:0}:{}),pages:[],complete:false};
}
export function validateCaptureCheckpoint(state,spec,credential=null){
 const manifest=planCapture(spec),sanitized=!!manifest.scope.sanitizationPolicy;
 if(!state||state.schema_version!==(sanitized?2:1)||state.fingerprint!==manifest.fingerprint||!Array.isArray(state.pages)||typeof state.complete!=='boolean')fail('checkpoint_scope_mismatch');
 if(sanitized&&(Object.keys(state).sort().join()!=='complete,fingerprint,pages,sanitizationPolicy,schema_version,sourceBytes'||state.sanitizationPolicy!==LANGFUSE_SANITIZATION_POLICY||!Number.isSafeInteger(state.sourceBytes)||state.sourceBytes<0||state.sourceBytes>spec.maxBytes||state.pages.length>0&&state.sourceBytes===0))fail('checkpoint_sanitization_mismatch');
 return validateState(state,manifest.scope,credential);
}
function validateRow(row,spec,sanitized=false){
 if(!sanitized&&row?.projectId!==spec.sourceProject)fail('source_project_mismatch');
 if(sanitized)assertSanitizedLangfuseRow(row,spec);
 if(spec.environment!==undefined&&row.environment!==spec.environment)fail('source_environment_mismatch');
 const selected=spec.traceId===undefined?undefined:sanitized?pseudonymizeLangfuseId(spec.traceId,'trace',spec):spec.traceId;
 if(selected!==undefined&&row.traceId!==selected)fail('source_trace_mismatch');
 if(normalizeTimestamp(row.startTime)===null||compareTimestamps(row.startTime,spec.from)<0||compareTimestamps(row.startTime,spec.to)>=0)fail('row_outside_window');
}
function validateState(state,spec,credential=null){
  const sanitized=!!spec.sanitizationPolicy;
  let rows=0;const cursors=new Set();
  for(let i=0;i<state.pages.length;i++){
   const p=state.pages[i];if(!p||!Array.isArray(p.data)||!p.meta||p.data.length>spec.pageSize)fail('invalid_page');
   if(sanitized&&(Object.keys(p).sort().join()!=='data,meta'||Object.keys(p.meta).join()!=='cursor'))fail('checkpoint_unsanitized');
   const c=p.meta.cursor;if(c!=null&&(typeof c!=='string'||!c||c.length>8192||cursors.has(c)))fail('invalid_or_repeated_cursor');if(c!=null)cursors.add(c);
   if(i<state.pages.length-1&&c==null)fail('checkpoint_after_terminal');
   for(const row of p.data)validateRow(row,spec,sanitized);rows+=p.data.length;
  }
  if(rows>spec.maxRows||state.pages.length>spec.maxPages||Buffer.byteLength(JSON.stringify({pages:state.pages}))>spec.maxBytes)fail('capture_bound_exceeded');
  const terminal=state.pages.length>0&&state.pages.at(-1).meta.cursor==null;if(state.complete!==terminal)fail('checkpoint_terminal_mismatch');if(credential&&containsCredential(state,credential))fail('credential_in_capture_rejected');return rows;
}
// transport is mandatory and injected: {status, body:string}; no default network implementation.
// Callers own secure memory/transport handling and private atomic checkpoint persistence.
export async function captureLangfuse(spec,{credential,transport,approve,checkpoint=null,saveCheckpoint=async()=>{},maxPagesPerCall=1000,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
 const manifest=planCapture(spec);spec=clone(manifest.scope);
 if(typeof credential!=='string'||!credential||credential.length>8192||/[\r\n]/.test(credential))fail('runtime_credential_required');
 if(typeof transport!=='function'||typeof approve!=='function')fail('injected_transport_and_approval_required');
 if(containsCredential(manifest,credential))fail('credential_in_scope_rejected');
 if(await approve({action:'read-source',manifest:clone(manifest)})!==true)fail('source_approval_required');
 const safe=v=>{if(containsCredential(v,credential))fail('credential_in_capture_rejected');return clone(v);};
 let state=checkpoint?clone(checkpoint):createCaptureCheckpoint(spec);

 if(!Number.isInteger(maxPagesPerCall)||maxPagesPerCall<1||maxPagesPerCall>1000)fail('invalid_page_budget');
 let pagesRead=0,rows=validateCaptureCheckpoint(state,spec,credential);
 while(!state.complete){
  if(pagesRead>=maxPagesPerCall)return {manifest,state:safe(state),outcome:'paused',conversion:null};
  if(state.pages.length>=spec.maxPages||rows>=spec.maxRows) return {manifest,state:safe(state),outcome:'bounded-incomplete',conversion:null};
  const url=new URL('/api/public/v2/observations',manifest.scope.origin);url.search=new URLSearchParams({fromStartTime:spec.from,toStartTime:spec.to,fields,limit:String(Math.min(spec.pageSize,spec.maxRows-rows))});
  if(spec.environment!==undefined)url.searchParams.set('environment',spec.environment);
  if(spec.traceId!==undefined)url.searchParams.set('traceId',spec.traceId);
  const cursor=state.pages.at(-1)?.meta.cursor;if(cursor)url.searchParams.set('cursor',cursor);
  let response;
  for(let attempt=0;;attempt++){
   try{response=await transport({method:'GET',url:url.href,headers:{Authorization:credential},redirect:'error'});}catch(error){if(error?.nonRetryable===true)throw error;response={status:0};}
   if(response?.status===200)break;
   if(![0,429,500,502,503,504].includes(response?.status)||attempt>=spec.maxRetries)fail('source_request_failed');
   let delay=Math.min(1000*2**attempt,16000);const retry=response?.headers?.['retry-after']??response?.headers?.['Retry-After'];if(response?.status===429||response?.status===503&&retry!=null){if(typeof retry!=='string')throw new Error('langfuse_rate_limit_requires_review');delay=retryAfterMs(retry);}await sleep(delay);
  }
  if(typeof response.body!=='string'||Buffer.byteLength(response.body)>spec.maxBytes)fail('response_bound_exceeded');
  let page;try{page=JSON.parse(response.body);}catch{fail('invalid_source_json');}
  safe(page);
  if(page?.data?.length>Math.min(spec.pageSize,spec.maxRows-rows))fail('response_row_limit_exceeded');
  let sourceBytes;
  if(spec.sanitizationPolicy){
   if(!Array.isArray(page?.data)||!page.meta||typeof page.meta!=='object'||Array.isArray(page.meta))fail('invalid_page');
   for(const row of page.data)validateRow(row,spec); // Validate exact source scope before removing identifiers.
   sourceBytes=state.sourceBytes+Buffer.byteLength(response.body);
   if(sourceBytes>spec.maxBytes)fail('capture_bound_exceeded');
   page=sanitizeLangfusePage(page,spec);
  }
  const next={...state,...(sourceBytes===undefined?{}:{sourceBytes}),pages:[...state.pages,page],complete:page?.meta?.cursor==null};
  rows=validateCaptureCheckpoint(next,spec,credential);state=next;
  await saveCheckpoint(safe(state));pagesRead++;
 }
 const conversion=convert(JSON.stringify({pages:state.pages}),{namespace:spec.namespace});
 return {manifest,state:safe(state),outcome:conversion.report.rejected.length?'conversion-rejected':'captured',conversion};
}
export async function approveCapturedStage(result,approve){
 result=clone(result);
 if(result?.outcome!=='captured'||!result.state?.complete||result.conversion?.report?.rejected?.length)fail('complete_clean_capture_required');
 // No mutable caller result can bypass validation: reconstruct from scope and captured pages.
 const plan=planCapture(result.manifest.scope);if(plan.fingerprint!==result.state.fingerprint||plan.fingerprint!==result.manifest.fingerprint)fail('checkpoint_scope_mismatch');
 validateCaptureCheckpoint(result.state,plan.scope);
 const conversion=convert(JSON.stringify({pages:result.state.pages}),{namespace:plan.scope.namespace});
 if(conversion.report.rejected.length||hash(conversion)!==hash(result.conversion))fail('conversion_changed');
 const receipt={action:'stage-destination',fingerprint:plan.fingerprint,destinationProject:plan.scope.destinationProject,batches:conversion.batches.length,conversionHash:hash(conversion)};
 if(typeof approve!=='function'||await approve(clone({...receipt,...(plan.scope.traceId!==undefined?{traceId:plan.scope.traceId}:{})}))!==true)fail('destination_approval_required');
 return {...receipt,approved:true}; // Receipt only: caller still invokes existing stage-only spool with approved binding.
}
export function reconcileCaptures(before,after){
 if(before.manifest.fingerprint!==after.manifest.fingerprint)fail('reconciliation_scope_mismatch');
 const map=r=>new Map(r.conversion.batches.map(b=>[b.batch_id,hash(b)]));const old=map(before),now=map(after);
 return {unchanged:[...now].filter(([k,v])=>old.get(k)===v).length,added:[...now.keys()].filter(k=>!old.has(k)).length,changed:[...now].filter(([k,v])=>old.has(k)&&old.get(k)!==v).map(([k])=>k),missing:[...old.keys()].filter(k=>!now.has(k)),policy:'changed-history-blocked; missing is not deletion authorization'};
}
