import {loadStartupIdentity,probeReachable,STARTUP_TIMEOUT_MS} from './startup-data.js';

// This controller owns the signed-out gate only. After identity is confirmed,
// the existing workspace, billing and export lifecycles take over unchanged.
export function mountWorkspaceStartup({request,onReady,mountSignIn}){
 const get=id=>document.getElementById(id),status=get('status'),title=get('startup-title');
 const actions=get('startup-actions'),retry=get('startup-retry'),cancel=get('startup-cancel');
 let job=null,version=0,complete=false,retryAt=0,retryTimer=null;
 function clearTimer(){clearTimeout(retryTimer);retryTimer=null;}
 function refreshRetry(){
  clearTimer();const remaining=retryAt-Date.now();retry.disabled=remaining>0;
  if(remaining>0)retryTimer=setTimeout(refreshRetry,Math.min(remaining,2147483647));
  else if(retryAt){retryAt=0;status.textContent='You can retry the sign-in check now.';}
 }
 function recover(message,{focus=false,delay=0}={}){
  get('signed-out').hidden=true;get('signin').hidden=true;title.hidden=false;
  title.textContent='Open your workspace';status.textContent=message;
  actions.hidden=false;cancel.hidden=true;retry.hidden=false;
  retryAt=delay?Date.now()+delay*1000:0;refreshRetry();
  if(focus&&!retry.disabled)retry.focus();
 }
 function stop(message,focus=false){
  if(!job||complete)return;
  version++;job.abort();job=null;recover(message,{focus});
 }
 function finish(){
  complete=true;job=null;clearTimer();title.hidden=true;actions.hidden=true;
  removeEventListener('pagehide',pause);removeEventListener('pageshow',resume);
 }
 function pause(){clearTimer();stop('The sign-in check was interrupted. Retry to check your current account.');}
 function resume(){if(!complete&&!job&&!retry.hidden)refreshRetry();}
 async function start(){
  if(job||complete||Date.now()<retryAt)return;
  clearTimer();retryAt=0;
  const focus=document.activeElement===retry,attempt=++version,controller=new AbortController();job=controller;
  title.hidden=false;title.textContent='Opening your workspace';
  status.textContent='Checking your session…';get('signed-out').hidden=true;get('signin').hidden=true;
  actions.hidden=false;retry.hidden=true;cancel.hidden=false;
  if(focus)cancel.focus();
  const current=()=>attempt===version&&!controller.signal.aborted;
  // The probe runs beside the account reads and never stops them. Its verdict words the outcome (unreachable or slow),
  // says so on screen while the reads are still waiting, and its answer doubles as the provider list for a signed-out page.
  let reach='pending';
  const probe=probeReachable({signal:controller.signal});
  probe.then(()=>{reach='reachable';},error=>{
   if(error?.message!=='startup_unreachable')return;
   reach='unreachable';
   if(current()&&job===controller)status.textContent='A reachability check got no response from SupaTrace. Still waiting for the sign-in check; you can cancel and retry.';
  });
  let identity;
  try{
   identity=await loadStartupIdentity(request,{signal:controller.signal});
  }catch(error){
   if(!current())return;
   if(error.message==='sign_in_required'){
    // Provider discovery is the probe's own answer: the response and then its body, each bounded by the probe deadline.
    // Without a usable list, the existing fallback stands.
    const providers=await (await probe.catch(()=>null))?.providers;
    if(!current())return;
    mountSignIn(get('signin'),providers||{github:true});
    finish();get('signed-out').hidden=false;get('signin').hidden=false;status.textContent='Please sign in to continue.';
    if(focus)get('signin').querySelector('a,button,input')?.focus();
   }else{
    job=null;
    const delay=error.status===429?(Number.isFinite(error.retryAfter)&&error.retryAfter>0?Math.ceil(error.retryAfter):60):0;
    const message=delay?`The sign-in check reached the request limit. Wait ${delay} seconds before retrying.`:
     error.message==='startup_timeout'?(reach==='reachable'?'SupaTrace answered a reachability check, but the sign-in check took too long. Retry in a moment.':
      reach==='unreachable'?`The sign-in check did not finish in ${STARTUP_TIMEOUT_MS/1000} seconds, and a separate reachability check got no response. SupaTrace may be unreachable from this network or still starting. Check your connection, then retry.`:
      'The sign-in check took too long. Check your connection, then retry.'):
     error.message==='service_not_configured'?'This workspace preview is not accepting traces yet. Sign-in and uploads are disabled while deployment is verified.':
     error.message==='project_unavailable'?'Your workspace could not be verified. Retry to check your current account.':
     'Your workspace could not be reached. Check your connection, then retry the sign-in check.';
    recover(message,{focus:focus||document.activeElement===cancel,delay});
   }
   return;
  }
  if(!current())return;
  finish();await onReady(identity,{focus});
 }
 retry.onclick=()=>void start();
 cancel.onclick=()=>stop('The sign-in check was cancelled. Retry when you’re ready.',true);
 addEventListener('pagehide',pause);addEventListener('pageshow',resume);
 void start();
}
