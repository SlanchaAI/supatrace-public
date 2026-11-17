// Enforced plan limits. Reservation, /api/usage and the dashboard all read this, and it is
// derived from the one approved plan table in plans.mjs (2026-11-16), so the
// public pricing page and enforcement cannot drift.
// Changing an allowance is an edit to PLANS and nowhere else. A "span" is one
// trace event; the allowance counts spans when their batch is reserved, so uploads that are
// pending or never finish count too. Stored bytes are cumulative reserved bytes, which do not reset.
import {PLANS} from './plans.mjs';
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const GB=1000000000,whole=value=>Number.isSafeInteger(value)&&value>0;
// Every plan fixes every enforced number; a count of null is unlimited.
const count=value=>value===null||whole(value);
const enforceable=PLANS.plans.filter(p=>whole(p.included_spans_per_month)&&whole(p.storage_gb)&&whole(p.retention_days)&&count(p.workspaces)&&count(p.projects)&&count(p.environments)&&count(p.seats)&&count(p.api_keys));
if(enforceable.length!==PLANS.plans.length)throw new Error('plan_limits_incomplete');
export const PLAN_LIMITS=freeze({
 // 'approved': these are the approved limits in force.
 version:PLANS.version,status:'approved',period:'calendar_month_utc',default_plan:'free',
 // overage: the plan can go past its included spans (metered). spend_cap_default: whether the cap that stops that is
 // on when the account has not chosen. Plans without overage always stop at the allowance and have nothing to choose.
 plans:Object.fromEntries(enforceable.map(p=>{const overage=p.at_allowance==='metered_overage'&&whole(p.overage_usd_per_million_spans);return [p.id,{id:p.id,name:p.name,spans_per_month:p.included_spans_per_month,stored_bytes:p.storage_gb*GB,retention_days:p.retention_days,workspaces:p.workspaces,projects:p.projects,environments:p.environments,seats:p.seats,api_keys:p.api_keys,overage,overage_usd_per_million_spans:overage?p.overage_usd_per_million_spans:null,spend_cap_default:!overage||p.spend_cap==='on_by_default',hard_stop:!overage}];}))
});
if(!Object.hasOwn(PLAN_LIMITS.plans,PLAN_LIMITS.default_plan))throw new Error('plan_limits_default_missing');
/** Unknown, missing or malformed plan ids always resolve to Free: a bad row never grants more. */
export function planLimits(planId){return typeof planId==='string'&&Object.hasOwn(PLAN_LIMITS.plans,planId)?PLAN_LIMITS.plans[planId]:PLAN_LIMITS.plans[PLAN_LIMITS.default_plan];}
/** Calendar month in UTC containing `seconds` (integer epoch seconds). */
export function usagePeriod(seconds){
 if(!Number.isSafeInteger(seconds)||seconds<0)throw new TypeError('epoch seconds required');
 const date=new Date(seconds*1000),year=date.getUTCFullYear(),month=date.getUTCMonth();
 return {id:year+'-'+String(month+1).padStart(2,'0'),starts_at:Date.UTC(year,month,1)/1000,resets_at:Date.UTC(year,month+1,1)/1000};
}
export const UPGRADE_PATH='/app/#billing';
/**
 * The account's spend cap. On: uploads stop at the included spans. Off: they continue and are metered as overage.
 * Only a plan with overage lets the account choose; anything but an explicit boolean on the row means the plan default.
 */
export function spendCap(account,plan=planLimits(account?.plan_id)){
 return {configurable:plan.overage,default_enabled:plan.spend_cap_default,enabled:plan.overage&&typeof account?.spend_cap==='boolean'?account.spend_cap:plan.spend_cap_default};
}
/** Alert thresholds, percent of included spans. */
export const USAGE_ALERT_LEVELS=Object.freeze([80,100]);
export function usageAlertLevel(used,limit){return used>=limit?100:used*100>=limit*80?80:0;}

/**
 * Idle pause (#113; the 30-day window is a proposal). A project on the default (Free) plan with no accepted
 * upload for `days` is paused: new uploads are refused until the owner resumes it. Nothing is deleted.
 * Paid plans never pause. `introduced_at` is the floor for accounts that predate the feature, so nobody is
 * paused for inactivity that happened before the rule existed.
 */
export const IDLE_PAUSE=Object.freeze({days:30,warn_days:3,introduced_at:Date.UTC(2026,10,14)/1000});
export const RESUME_PATH='/app/#usage';
/**
 * Lifecycle of an account row at `now` (epoch seconds). Activity is the latest of: the last accepted upload,
 * the last resume, a plan change, account creation and the introduction floor.
 */
export function projectLifecycle(account,now,plan=planLimits(account?.plan_id)){
 if(!account||plan.id!==PLAN_LIMITS.default_plan||account.commercial_managed===true)return {state:'active',exempt:true};
 const last_activity_at=Math.max(IDLE_PAUSE.introduced_at,...[account.last_accepted_at,account.resumed_at,account.plan_changed_at,account.created_at].filter(value=>Number.isSafeInteger(value)&&value>=0));
 const pauses_at=last_activity_at+IDLE_PAUSE.days*86400;
 return {state:now>=pauses_at?'paused':now>=pauses_at-IDLE_PAUSE.warn_days*86400?'pausing_soon':'active',exempt:false,last_activity_at,last_accepted_at:Number.isSafeInteger(account.last_accepted_at)?account.last_accepted_at:null,pauses_at};
}

/**
 * Retention in force for an account. A plan with the custom_retention feature may set its own number of days
 * (`retention_days` on the account row, 1 to RETENTION_MAX_DAYS); every other plan, and a row without a valid
 * choice, has the plan's days. It applies to data accepted from then on: stored data keeps the stamp it has.
 */
export const RETENTION_MAX_DAYS=3650;
export function retentionDays(account,plan=planLimits(account?.plan_id)){
 const chosen=account?.retention_days;
 return PLANS.plans.find(p=>p.id===plan.id)?.features.includes('custom_retention')&&Number.isSafeInteger(chosen)&&chosen>=1&&chosen<=RETENTION_MAX_DAYS?chosen:plan.retention_days;
}
