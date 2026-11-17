// Browser display validation only. The server remains authoritative for quota,
// billing policy, entitlements and admission. This never retries a mutation.
export const USAGE_LIMITS=Object.freeze({timeoutMs:30000,responseBytes:65536});
const fail=code=>{throw new Error(code);};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const count=value=>Number.isSafeInteger(value)&&value>=0;
// Additive: older APIs omit monthly/plan_limits. When present they must be complete and consistent.
function monthlyAllowance(value){
 const m=value.monthly,p=value.plan_limits;if(m===undefined&&p===undefined)return null;
 if(!object(m)||!object(p)||typeof m.period!=='string'||!/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(m.period)||!['spans_used','spans_limit','spans_remaining'].every(key=>count(m[key]))||m.spans_limit<1||m.spans_remaining!==Math.max(0,m.spans_limit-m.spans_used)||
  typeof m.resets_at!=='string'||!/^[0-9]{4}-(0[1-9]|1[0-2])-01T00:00:00\.000Z$/.test(m.resets_at)||m.resets_at.slice(0,7)<=m.period||
  typeof p.plan_id!=='string'||!/^[a-z][a-z0-9_-]{0,31}$/.test(p.plan_id)||typeof p.name!=='string'||!p.name.trim()||p.name.length>60||/[\x00-\x1f\x7f]/.test(p.name)||p.spans_per_month!==m.spans_limit||
  !count(p.retention_days)||p.retention_days<1||p.projects!==null&&(!count(p.projects)||p.projects<1)||p.status!==undefined&&!['proposal','approved'].includes(p.status))fail('invalid_usage');
 const r=value.retention;if(r!==undefined&&(!object(r)||r.days!==p.retention_days||!['hidden_after_expiry','scheduled_physical_expiry'].includes(r.enforcement)||typeof r.physical_deletion!=='boolean'||r.physical_deletion!==(r.enforcement==='scheduled_physical_expiry')))fail('invalid_usage');
 // Earlier months' meters. Additive; each row must be a past month with safe counts.
 const meters=value.meters,history=[];if(meters!==undefined){
  if(!object(meters)||!object(meters.current)||meters.current.period!==m.period||meters.current.reserved_spans!==m.spans_used||!count(meters.current.accepted_spans)||!Array.isArray(meters.history)||meters.history.length>24)fail('invalid_usage');
  for(const row of meters.history){if(!object(row)||typeof row.period!=='string'||!/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(row.period)||row.period>=m.period||!count(row.reserved_spans)||!count(row.accepted_spans))fail('invalid_usage');history.push({period:row.period,reserved_spans:row.reserved_spans,accepted_spans:row.accepted_spans});}
 }
 // Spend cap: additive. `enabled` means uploads stop at the included spans; only a plan with overage is configurable.
 const cap=value.spend_cap;let spendCap=null;if(cap!==undefined){
  if(!object(cap)||typeof cap.enabled!=='boolean'||typeof cap.configurable!=='boolean'||typeof cap.default_enabled!=='boolean'||!cap.configurable&&cap.enabled!==true||!count(cap.overage_spans)||cap.overage_spans!==Math.max(0,m.spans_used-m.spans_limit)||
   cap.overage_usd_per_million_spans!==null&&(!count(cap.overage_usd_per_million_spans)||cap.overage_usd_per_million_spans<1)||cap.configurable!==(cap.overage_usd_per_million_spans!==null))fail('invalid_usage');
  spendCap={enabled:cap.enabled,configurable:cap.configurable,default_enabled:cap.default_enabled,overage_spans:cap.overage_spans,overage_usd_per_million_spans:cap.overage_usd_per_million_spans};
 }
 return {spend_cap:spendCap,history,period:m.period,resets_at:m.resets_at,spans_used:m.spans_used,spans_limit:m.spans_limit,spans_remaining:m.spans_remaining,plan_id:p.plan_id,plan_name:p.name,retention_days:p.retention_days,retention_enforced:r!==undefined,retention_physical:r?.physical_deletion===true,projects:p.projects,proposal:p.status!=='approved'};
}
// Additive: idle-pause state (#113). Older APIs omit it. When present it must be complete.
const instant=value=>typeof value==='string'&&/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(value)&&!Number.isNaN(Date.parse(value));
function projectLifecycle(value){
 const l=value.lifecycle;if(l===undefined)return null;
 if(!object(l)||!['active','pausing_soon','paused'].includes(l.state)||typeof l.pauses_when_idle!=='boolean')fail('invalid_usage');
 if(!l.pauses_when_idle){if(l.state!=='active')fail('invalid_usage');return {state:'active',pauses_when_idle:false};}
 if(!count(l.idle_days)||l.idle_days<1||!count(l.warn_days)||!instant(l.pauses_at)||l.last_upload_at!==null&&!instant(l.last_upload_at)||typeof l.resume_url!=='string'||!l.resume_url.startsWith('/app/#')||!/^[a-z]{1,20}$/.test(l.resume_url.slice(6)))fail('invalid_usage');
 return {state:l.state,pauses_when_idle:true,idle_days:l.idle_days,warn_days:l.warn_days,pauses_at:l.pauses_at,last_upload_at:l.last_upload_at,resume_url:l.resume_url};
}
export function validateUsage(value){
 if(!object(value)||!object(value.storage)||!object(value.account_plan))fail('invalid_usage');
 let bytes;try{bytes=new TextEncoder().encode(JSON.stringify(value)).length;}catch{fail('invalid_usage');}if(bytes>USAGE_LIMITS.responseBytes)fail('invalid_usage');
 const storage=value.storage,plan=value.account_plan;
 if(!['used_bytes','limit_bytes','remaining_bytes'].every(key=>count(storage[key]))||storage.remaining_bytes!==Math.max(0,storage.limit_bytes-storage.used_bytes))fail('invalid_usage');
 if(storage.accounting!==undefined&&storage.accounting!=='cumulative_reserved_bytes'||storage.operational_limit_bytes!==undefined&&(!count(storage.operational_limit_bytes)||storage.operational_limit_bytes<storage.limit_bytes))fail('invalid_usage');
 if(storage.accepted_uploads!==undefined&&!count(storage.accepted_uploads))fail('invalid_usage');
 if(storage.limit_kind!==undefined&&!['current_alpha_operational_ceiling','commercial_policy_with_operational_ceiling','plan_stored_bytes_allowance'].includes(storage.limit_kind))fail('invalid_usage');
 const monthly=monthlyAllowance(value),lifecycle=projectLifecycle(value);
 const scope=value.quota_scope;
 if(scope!==undefined&&(!object(scope)||Object.keys(scope).sort().join()!=='environment_id,project_id,shared_across_environments,workspace_id'||
  typeof scope.project_id!=='string'||!/^proj_[a-f0-9]{32}$/.test(scope.project_id)||typeof scope.workspace_id!=='string'||!(/^(?:github-[1-9][0-9]{0,15}|(?:google|email|sso|chatgpt)-[a-f0-9]{64}|org-[a-f0-9]{32})$/).test(scope.workspace_id)||
  typeof scope.environment_id!=='string'||!/^[a-z][a-z0-9-]{0,31}$/.test(scope.environment_id)||scope.shared_across_environments!==true))fail('invalid_usage');
 if(typeof plan.name!=='string'||!plan.name.trim()||plan.name.length>200||/[\x00-\x1f\x7f]/.test(plan.name)||!['not_configured','active','free','blocked'].includes(plan.billing_status)||typeof plan.paid_activation_enabled!=='boolean'||plan.paid_active!==undefined&&typeof plan.paid_active!=='boolean')fail('invalid_usage');
 const active=plan.billing_status==='active';if((plan.paid_active===true)!==active||plan.paid_activation_enabled!==active)fail('invalid_usage');
 const billing=value.billing??{sandbox:false,portal_available:false,purchases_enabled:false,paid_access:false};
 if(!object(billing)||!['sandbox','portal_available','purchases_enabled','paid_access'].every(key=>typeof billing[key]==='boolean')||billing.purchases_enabled!==false||billing.paid_access!==active||billing.portal_available&&(!billing.sandbox||active)||billing.sandbox&&billing.commercial_controls===true)fail('invalid_usage');
 if((billing.commercial_controls===true)!==(plan.billing_status!=='not_configured'))fail('invalid_usage');
 if(active||plan.billing_status==='free'||plan.billing_status==='blocked'){if(billing.sandbox||billing.commercial_controls!==true||billing.portal_available||billing.reason!==({active:'live_portal_transport_not_configured',free:'commercial_free_account',blocked:'commercial_reconciliation_required'})[plan.billing_status])fail('invalid_usage');}
 return {storage:{used_bytes:storage.used_bytes,limit_bytes:storage.limit_bytes,remaining_bytes:storage.remaining_bytes,
  ...(storage.accepted_uploads!==undefined?{accepted_uploads:storage.accepted_uploads}:{}),...(storage.accounting!==undefined?{accounting:storage.accounting}:{}),...(storage.limit_kind!==undefined?{limit_kind:storage.limit_kind}:{}),
  ...(storage.operational_limit_bytes!==undefined?{operational_limit_bytes:storage.operational_limit_bytes}:{})},
  ...(scope!==undefined?{quota_scope:{...scope}}:{}),...(monthly?{monthly}:{}),...(lifecycle?{lifecycle}:{}),account_plan:{name:plan.name,billing_status:plan.billing_status,paid_active:active,paid_activation_enabled:plan.paid_activation_enabled},billing:{...billing},commercial:value.commercial};
}
export async function loadAccountUsage(request,{projectId,workspaceId,environmentId='default',signal,timeoutMs=USAGE_LIMITS.timeoutMs}={}){
 if(typeof request!=='function'||typeof projectId!=='string'||!/^proj_[a-f0-9]{32}$/.test(projectId)||
  workspaceId!==undefined&&(typeof workspaceId!=='string'||!(/^(?:github-[1-9][0-9]{0,15}|(?:google|email|sso|chatgpt)-[a-f0-9]{64}|org-[a-f0-9]{32})$/).test(workspaceId))||
  typeof environmentId!=='string'||!/^[a-z][a-z0-9-]{0,31}$/.test(environmentId)||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>USAGE_LIMITS.timeoutMs)fail('invalid_usage_scope');
 if(signal?.aborted)fail('usage_cancelled');
 const controller=new AbortController(),relay=()=>controller.abort();signal?.addEventListener('abort',relay,{once:true});let expired=false;
 const timer=setTimeout(()=>{expired=true;controller.abort();},timeoutMs);
 try{
  const value=await new Promise((resolve,reject)=>{
   const abort=()=>{controller.signal.removeEventListener('abort',abort);reject(new Error('usage_cancelled'));};controller.signal.addEventListener('abort',abort,{once:true});
   // Start synchronously, matching the existing one-read API flow. The bounded
   // race includes fetch AND response.json, even when either ignores abort.
   let work;try{work=request('usage',controller.signal,projectId);}catch(error){work=Promise.reject(error);}
   Promise.resolve(work).then(value=>{controller.signal.removeEventListener('abort',abort);resolve(value);},error=>{controller.signal.removeEventListener('abort',abort);reject(error);});
  });
  if(controller.signal.aborted)fail('usage_cancelled');const parsed=validateUsage(value),scope=parsed.quota_scope;
  // Older deployed APIs omit this additive field; their existing project gate remains compatible.
  // A declared scope must always match, never silently fall back to plausible counters.
  if(scope&&(scope.project_id!==projectId||scope.environment_id!==environmentId||workspaceId!==undefined&&scope.workspace_id!==workspaceId))fail('usage_scope_mismatch');
  return parsed;
 }catch(error){if(expired)fail('usage_deadline');if(controller.signal.aborted)fail('usage_cancelled');throw error;}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',relay);}
}
