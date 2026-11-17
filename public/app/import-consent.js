// Exact-scope consent; optional capability-gated in-app server pull. Keys exist only during an active visible flow and its in-flight requests.
const expectedFields='core,basic,time,io,metadata,model,usage,prompt,metrics,trace_context';
const keys=(value,list)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join()===list.slice().sort().join();
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const sameJson=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const terminal=value=>['complete','empty','bounded_incomplete','conversion_rejected','revoked'].includes(value);
function waitForNextStep(ms,signal){return new Promise((resolve,reject)=>{let timer;const stop=()=>{clearTimeout(timer);signal.removeEventListener('abort',stop);reject(Error());};if(signal.aborted)return stop();signal.addEventListener('abort',stop,{once:true});timer=setTimeout(()=>{signal.removeEventListener('abort',stop);resolve();},ms);});}
export function mountImportConsent({document,getProject,request,now=Date.now,wait=waitForNextStep}={}){
 const $=id=>document.getElementById(id);let plan=null,review=null,recorded=false,revoked=false,generation=0,active=null,expiryTimer=null,serverPull=false,pullJob=null,flow=null,needsStatus=false;const uncertain=new Set();
 const note=text=>{$('import-consent-status').textContent=text+(uncertain.size?' A previous consent change is unconfirmed. Recreate its exact plan to explicitly confirm or revoke it; do not assume it was undone.':'');};
 const current=()=>plan&&plan.scope.destinationProject===getProject();
 function controls(){
  const valid=current(),fresh=review&&review.disclosure.expires_at*1000>now(),busy=!!active||!!flow;
  $('import-consent-review').disabled=!valid||busy;$('import-consent-accept').disabled=!valid||!fresh||busy||recorded;$('import-consent-confirm').disabled=!valid||!fresh||busy||recorded||!$('import-consent-accept').checked;$('import-consent-revoke').disabled=!valid||busy||revoked;
  $('import-start').disabled=!serverPull||!valid||!fresh||!recorded||busy||needsStatus||terminal(pullJob?.status);$('import-start').textContent=serverPull?(pullJob?'Resume import':'Start import'):'Start import unavailable';
  if($('import-start-reason'))$('import-start-reason').textContent=!plan?'Review an import plan with an exact trace to check server pull availability.':!serverPull?'Server pull is not enabled on this deployment.':!valid?'Review an exact trace in your personal Default project and environment.':busy?'An import request is in progress.':needsStatus?'Check durable import status before resuming.':terminal(pullJob?.status)?'This import has ended. Review a new plan to import again.':!fresh?'Request a current exact scope review.':!recorded?'Confirm consent for this exact plan before starting.':'';
  if($('import-pull-controls'))$('import-pull-controls').hidden=!serverPull;if($('import-pull-status'))$('import-pull-status').disabled=!serverPull||!valid||busy;if($('import-pull-pause'))$('import-pull-pause').hidden=!flow;
  for(const id of ['import-public-key','import-secret-key'])if($(id))$(id).disabled=busy;
 }
 function clearKeys(){for(const id of ['import-public-key','import-secret-key'])if($(id))$(id).value='';}
 function stopFlow(message){const running=flow;if(running){running.credentials=null;running.controller.abort();flow=null;needsStatus=true;}clearKeys();if(message&&running)note(message);controls();}
 function clearReview(){stopFlow();clearTimeout(expiryTimer);expiryTimer=null;review=null;recorded=false;$('import-consent-scope').textContent='';$('import-consent-expiry').textContent='';$('import-consent-accept').checked=false;}
 function invalidate(message='Scope changed. Review the current plan again. This does not revoke stored consent.'){
  generation++;stopFlow();needsStatus=false;pullJob=null;serverPull=false;if(active?.mutating)uncertain.add(active.fingerprint);active?.controller.abort();active=null;plan=null;revoked=false;clearReview();$('import-consent-output').hidden=true;controls();note(message);
 }
 function setPlan(value,options={}){
  invalidate();try{const copy=structuredClone(value),s=copy.scope;if(!hex(copy.fingerprint)||copy.fields!==expectedFields||s?.destinationProject!==getProject()||typeof s.traceId!=='string'||!s.traceId||s.traceId.trim()!==s.traceId||s.traceId.length>200||/[\u0000-\u001f\u007f]/.test(s.traceId))throw Error();plan=copy;serverPull=options.serverPull===true;$('import-consent-output').hidden=false;note('Request the server-owned scope before confirming consent. No import starts here.'+(serverPull?' After consent, paste your read keys once and Start. This visible page advances bounded steps automatically; Pause stops further requests. Keys are never saved.':''));controls();}catch{note('An exact trace and current owned Default project are required for consent review. Start remains unavailable.');}
 }
 function checkedReview(value,selected){
  if(!keys(value,['status','fingerprint','review_hash','disclosure','execution_started'])||value.status!=='scope_review_required'||value.execution_started!==false||value.fingerprint!==selected.fingerprint||!hex(value.review_hash))throw Error();
  const d=value.disclosure,s=selected.scope;if(!keys(d,['source','destination','fields','content','bounds','expires_at',...(serverPull?['sanitization']:[])])||!keys(d.source,['provider','origin','project_id','trace_id','environment','from','to','namespace'])||!keys(d.destination,['origin','project_id','environment_id'])||!keys(d.content,['input_output','prompts'])||!keys(d.bounds,['max_rows','max_pages','page_size','max_bytes','max_retries'])||!Array.isArray(d.fields)||d.fields.join(',')!==expectedFields||d.content.input_output!==true||d.content.prompts!==true||!['https://supatrace.dev','https://supatrace.tech'].includes(d.destination.origin)||d.destination.project_id!==s.destinationProject||d.destination.environment_id!=='default'||!Number.isSafeInteger(d.expires_at)||d.expires_at*1000<=now()||d.expires_at*1000>now()+3600000)throw Error();
  if(serverPull&&(selected.scope.sanitizationPolicy!=='langfuse-structured-v1'||!selected.sanitization||!sameJson(d.sanitization,selected.sanitization)||d.sanitization.policy!==selected.scope.sanitizationPolicy||d.sanitization.before_checkpoint!==true))throw Error();
  for(const [key,expected]of Object.entries({provider:'langfuse',origin:s.origin,project_id:s.sourceProject,trace_id:s.traceId,environment:s.environment,from:s.from,to:s.to,namespace:s.namespace}))if(d.source[key]!==expected)throw Error();
  for(const [key,expected]of Object.entries({max_rows:s.maxRows,max_pages:s.maxPages,page_size:s.pageSize,max_bytes:s.maxBytes,max_retries:s.maxRetries}))if(d.bounds[key]!==expected)throw Error();return structuredClone(value);
 }
 async function perform(kind,body,success,run=null){
  if(active||!current()||flow&&flow!==run)return false;
  const selected=structuredClone(plan),version=generation,project=getProject(),controller=new AbortController(),job={controller,mutating:['consent','revoke'].includes(kind),fingerprint:selected.fingerprint};active=job;controls();let timer,abort;
  const stopped=new Promise((_,reject)=>{abort=()=>reject(Error());controller.signal.addEventListener('abort',abort,{once:true});});
  const stop=()=>controller.abort();run?.controller.signal.addEventListener('abort',stop,{once:true});
  try{
   if(run?.controller.signal.aborted)throw Error();
   const result=await Promise.race([request('imports/'+(serverPull?'pull/':'')+kind,structuredClone(body),controller.signal),stopped,new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error());},10000);timer?.unref?.();})]);
   if(run?.controller.signal.aborted)return false;
   if(version!==generation||!current()||project!==getProject()||controller.signal.aborted){if(job.mutating)uncertain.add(selected.fingerprint);if(version===generation)invalidate('Account or scope changed. Review it again.');return false;}
   success(result,selected);return true;
  }catch{
   if(serverPull)clearKeys();
   if(run?.controller.signal.aborted)return false;
   if(version===generation&&current()&&project===getProject()){if(job.mutating)uncertain.add(selected.fingerprint);if(run)needsStatus=true;note(kind==='review'?'The server could not verify this exact scope. No consent or import was confirmed.':'The change was not confirmed. Wait 30 seconds and check durable status before resuming. No automatic retry or Start will occur.');}
   else if(version===generation)invalidate('Account or scope changed. Review it again.');
   return false;
  }finally{clearTimeout(timer);controller.signal.removeEventListener('abort',abort);run?.controller.signal.removeEventListener('abort',stop);if(active===job){active=null;controls();}}
 }
 $('import-consent-review').onclick=()=>{if(!current()||active||flow)return;clearReview();revoked=false;return perform('review',{fingerprint:plan.fingerprint,...(serverPull?{plan:{provider:'langfuse',...Object.fromEntries(Object.entries(plan.scope).filter(([key])=>key!=='destinationProject'))}}:{})},(value,selected)=>{review=checkedReview(value,selected);$('import-consent-scope').textContent=JSON.stringify(review.disclosure,null,2);$('import-consent-expiry').textContent='Consent expires at '+new Date(review.disclosure.expires_at*1000).toISOString()+' (UTC). Reviewing does not renew it.';note('Review this exact trace and destination. Input/output and prompts are included. Nothing has been confirmed or started by this review.');const version=generation;expiryTimer=setTimeout(()=>{if(version!==generation)return;clearReview();controls();note('This review expired. Requesting it again cannot silently renew server consent. Revocation for the exact plan remains available.');},Math.max(1,review.disclosure.expires_at*1000-now()));expiryTimer?.unref?.();});};
 $('import-consent-accept').onchange=()=>{if(review&&review.disclosure.expires_at*1000<=now())clearReview();controls();};
 $('import-consent-confirm').onclick=()=>{if(!current()||!review||recorded||active||flow||!$('import-consent-accept').checked||review.disclosure.expires_at*1000<=now()){controls();return;}const hash=review.review_hash;return perform('consent',{fingerprint:plan.fingerprint,review_hash:hash,accept_content:true},value=>{if(!keys(value,['status','fingerprint','review_hash','execution_started'])||value.status!=='consent_recorded'||value.execution_started!==false||value.fingerprint!==plan.fingerprint||value.review_hash!==hash||review?.review_hash!==hash||review.disclosure.expires_at*1000<=now())throw Error();recorded=true;uncertain.delete(plan.fingerprint);note(serverPull?'Consent recorded for this exact plan. Paste the Langfuse read keys once, then Start. Keep this page visible while it advances; Pause or leaving stops it. Sanitized source content is checkpointed on the server; unlisted text can remain sensitive. Keys are not saved.':'Consent recorded for this exact plan. No import has started. Start remains unavailable from this page.');});};
 $('import-consent-revoke').onclick=()=>{if(!current()||active||flow||revoked)return;return perform('revoke',{fingerprint:plan.fingerprint},value=>{if(!keys(value,['status','fingerprint','execution_started'])||value.status!=='consent_revoked'||value.fingerprint!==plan.fingerprint||value.execution_started!==false)throw Error();uncertain.delete(plan.fingerprint);clearReview();revoked=true;note('Consent revoked for this exact plan. Stored jobs, files and audit history remain. This does not revoke an underlying provider or write key.');});};

 function showJob(value){
  if(!keys(value,['job_id','run_id','fingerprint','project_id','status','version','progress','execution_started','stored_bytes_verified','export_verified','expires_at','needs_credentials'])||value.fingerprint!==plan.fingerprint||value.project_id!==getProject()||value.job_id!=='sp_'+plan.fingerprint||(value.status==='empty'?value.run_id!==null:!/^lf\.[a-f0-9]{64}$/.test(value.run_id??''))||!['reviewed','consented','capturing','ready','reserve_consumed','object_ready','object_consumed','ack_ready','ack_consumed','verifying','complete','empty','bounded_incomplete','conversion_rejected','revoked'].includes(value.status)||!keys(value.progress,['pages','rows','verified_batches'])||Object.values(value.progress).some(v=>!Number.isSafeInteger(v)||v<0)||typeof value.needs_credentials!=='boolean'||value.needs_credentials!==(value.status==='capturing')||value.stored_bytes_verified!==(value.status==='complete')||value.export_verified!==false||!Number.isSafeInteger(value.version)||value.version<0||!Number.isSafeInteger(value.expires_at)||value.progress.pages>plan.scope.maxPages||value.progress.rows>plan.scope.maxRows||value.progress.verified_batches>value.progress.rows||value.status==='complete'&&value.progress.verified_batches<1||value.status==='empty'&&(value.progress.rows!==0||value.progress.verified_batches!==0)||pullJob&&value.version<pullJob.version)throw Error();
  pullJob=value;
  const message=value.status==='complete'?'Import stored and read back. Open Traces to inspect run '+value.run_id+'. Source completeness and export are not verified.':value.status==='empty'?'No matching observations were returned for this exact scope. No destination trace, batch or object was created. Source completeness is not verified.':value.status==='bounded_incomplete'?'Source bound reached. This capture is incomplete; no batches were uploaded.':value.status==='conversion_rejected'?'Source conversion was rejected; no batches were uploaded.':value.status==='revoked'?'Consent was revoked. Existing data remains.':'Durable step: '+value.status+'. '+(flow?'Import is progressing while this page is visible. Pause stops further requests.':value.needs_credentials?'Enter the Langfuse public and secret read keys, then Resume.':'Resume continues bounded storage steps without provider keys.');
  note(message+' Pages: '+value.progress.pages+'; observations: '+value.progress.rows+'; verified batches: '+value.progress.verified_batches+'.');
 }
 $('import-start').onclick=async()=>{
  if(!serverPull||!current()||!recorded||!review||review.disclosure.expires_at*1000<=now()||active||flow||needsStatus||terminal(pullJob?.status)||document.hidden)return;
  const needsKeys=!pullJob||['reviewed','consented','capturing'].includes(pullJob.status);
  let credentials=needsKeys?{publicKey:$('import-public-key').value,secretKey:$('import-secret-key').value}:null;clearKeys();
  if(needsKeys&&(!/^[-A-Za-z0-9_]{8,256}$/.test(credentials.publicKey)||!/^[-A-Za-z0-9_]{8,512}$/.test(credentials.secretKey))){credentials=null;note('Enter both Langfuse read-key values for this source project. Nothing was sent.');return;}
  const run={controller:new AbortController(),credentials,version:generation,project:getProject()};credentials=null;flow=run;controls();
  const live=()=>flow===run&&!run.controller.signal.aborted&&run.version===generation&&current()&&getProject()===run.project&&!document.hidden&&review&&review.disclosure.expires_at*1000>now();
  try{
   if(!pullJob||['reviewed','consented'].includes(pullJob.status)){if(!await perform('start',{fingerprint:plan.fingerprint},showJob,run))return;}
   let steps=0;
   while(!terminal(pullJob.status)){
    if(!live()||++steps>512)throw Error();
    if(!pullJob.needs_credentials)run.credentials=null;
    if(pullJob.needs_credentials&&!run.credentials)throw Error();
    // At most 40 scheduled requests/minute, below the API's 60/minute limiter.
    // These are new bounded steps, never automatic retries of failed requests.
    await wait(1500,run.controller.signal);if(!live())throw Error();
    if(!await perform('advance',{fingerprint:plan.fingerprint,credentials:pullJob.needs_credentials?run.credentials:null},showJob,run))return;
   }
  }catch{if(flow===run&&!run.controller.signal.aborted){needsStatus=true;note('Import paused. Keys were cleared. Check durable status before explicitly resuming; re-enter keys if source capture is unfinished.');}}
  finally{run.credentials=null;if(flow===run){flow=null;controls();}}
 };
 if($('import-pull-status'))$('import-pull-status').onclick=()=>{if(serverPull&&current()&&!active&&!flow)return perform('status',{fingerprint:plan.fingerprint},value=>{showJob(value);needsStatus=false;});};
 if($('import-pull-pause'))$('import-pull-pause').onclick=()=>stopFlow('Import paused. Keys were cleared. If a request was in flight, wait 30 seconds, then check durable status before resuming.');
 document.addEventListener?.('visibilitychange',()=>{if(document.hidden)stopFlow('Import paused because this page is hidden. Keys were cleared. Check durable status before resuming.');});
 clearKeys();controls();return {setPlan,invalidate};
}
