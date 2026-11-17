// Notice for an idle pause (#113). A notification row is written once per pause, the first time an upload is
// refused because of it. Email goes out only when the existing SES path is configured and the account signed in
// with an email address. Nothing here pauses or resumes anything: the pause is derived from the account row.
import {emailConfigured} from './dashboard-auth.mjs';
import {IDLE_PAUSE,RESUME_PATH} from './plan-limits.mjs';
const address=/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
export const PAUSE_EMAIL_TIMEOUT_MS=3000;
export function pauseMessage(origin){
 return {subject:'SupaTrace: your project is paused',text:`Your SupaTrace project was paused because no trace was accepted for ${IDLE_PAUSE.days} days. Free projects pause when idle.\n\nNothing was deleted. New uploads are refused until the workspace owner resumes the project, which takes one click:\n\n${origin}${RESUME_PATH}\n`};
}
/** Never throws: the upload is being refused anyway and the refusal must not turn into a 5xx. */
export async function notifyProjectPaused(env,store,tenantId,pausedAt){
 try{
  if(typeof store.recordPauseNotice!=='function')return {recorded:false,reason:'unsupported'};
  const account=await store.getTenant(tenantId),to=account&&['email','sso'].includes(account.provider)&&typeof account.email==='string'&&address.test(account.email)&&account.email.length<=254?account.email:null;
  const status=!emailConfigured(env)?'not_configured':!to?'no_address':'pending';
  const result=await store.recordPauseNotice(tenantId,pausedAt,{email_status:status});
  if(!result.created)return {recorded:false,reason:'already_recorded'};
  if(status!=='pending')return {recorded:true,email:status};
  let email='sent',timer;
  try{await Promise.race([Promise.resolve().then(()=>env.sendEmail({to,...pauseMessage(env.APP_ORIGIN)})),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),env.alertEmailTimeoutMs??PAUSE_EMAIL_TIMEOUT_MS);})]);}catch{email='failed';}finally{clearTimeout(timer);}
  try{await store.setPauseNoticeEmail(tenantId,pausedAt,email);}catch{/* the row stays pending; nothing is resent */}
  return {recorded:true,email};
 }catch{return {recorded:false,reason:'failed'};}
}
