// Usage alerts at 80% and 100% of a plan's included spans for the month.
// A notification row is written once per account, month and level. Email goes out only when
// the existing SES path is configured and the account or organization owner signed in with an email address.
import {emailConfigured} from './dashboard-auth.mjs';
import {hasFeature} from './entitlements.mjs';
const address=/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
export function usageAlertMessage(alert,origin){
 const resets=new Date(alert.resets_at*1000).toISOString().slice(0,10),count=value=>value.toLocaleString('en-US'),billing=origin+'/app/#billing',usage=origin+'/app/#usage';
 if(alert.level===80)return {subject:'SupaTrace: 80% of this month\'s spans used',text:`Your workspace has used ${count(alert.used)} of the ${count(alert.limit)} spans included this month (80%).\n\nThe count resets on ${resets} (UTC).\n\nUsage: ${usage}\n`};
 return {subject:'SupaTrace: this month\'s included spans are used up',text:`Your workspace has used all ${count(alert.limit)} spans included this month.\n\n`+(alert.spend_cap?`New uploads are rejected until ${resets} (UTC). Nothing extra is billed.`:`The spend cap is off, so uploads continue and further spans are metered as overage until ${resets} (UTC).`)+`\n\nBilling and cost control: ${billing}\n`};
}
// An email outage must not hold an upload: the sender gets this long, then the alert is marked failed.
export const ALERT_EMAIL_TIMEOUT_MS=3000;
/**
 * Phase one, before the batch is stored: write the notification row (two DynamoDB calls, no email).
 * Never throws. Returns what happened and, when an email is due, `deliver` to call after the batch is accepted.
 */
export async function recordUsageAlert(env,store,tenantId,alert){
 try{
  if(typeof store.recordUsageAlert!=='function')return {recorded:false,reason:'unsupported'};
  const account=await store.getTenant(tenantId);
  // Organization metadata holds the current owner, not an email identity. Resolve it at delivery preparation.
  const recipient=account?.provider==='organization'&&typeof account.owner_account==='string'?await store.getTenant(account.owner_account):account;
  const to=recipient&&!Number.isSafeInteger(recipient.deleted_at)&&['email','sso'].includes(recipient.provider)&&typeof recipient.email==='string'&&address.test(recipient.email)&&recipient.email.length<=254?recipient.email:null;
  const status=!hasFeature(account?.plan_id,'usage_alerts')?'not_in_plan':!emailConfigured(env)?'not_configured':!to?'no_address':'pending';
  const result=await store.recordUsageAlert(tenantId,alert,{email_status:status});
  if(!result.created)return {recorded:false,reason:'already_recorded'};
  if(status!=='pending')return {recorded:true,email:status};
  return {recorded:true,email:'pending',deliver:async()=>{
   let email='sent',timer;
   try{await Promise.race([Promise.resolve().then(()=>env.sendEmail({to,...usageAlertMessage(alert,env.APP_ORIGIN)})),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),env.alertEmailTimeoutMs??ALERT_EMAIL_TIMEOUT_MS);})]);}catch{email='failed';}finally{clearTimeout(timer);}
   try{await store.setUsageAlertEmail(tenantId,alert.period,alert.level,email);}catch{/* the row stays pending; nothing is resent */}
   return email;
  }};
 }catch{return {recorded:false,reason:'failed'};}
}
/** Both phases in one call. Never throws. */
export async function notifyUsageAlert(env,store,tenantId,alert){
 const {deliver,...result}=await recordUsageAlert(env,store,tenantId,alert);
 return deliver?{...result,email:await deliver()}:result;
}
