// First, so every module's requests get the retry for a momentarily busy service (see request-queue.js).
import './request-queue.js';
import {mountSupport} from './support.js';
import {mountImportConsent} from './import-consent.js';
import {mountWorkspaces} from './workspaces.js';
import {saveTraceFile} from './trace-export.js';
import {projectsPanel} from './projects.js';
import {readEventPage} from './event-data.js';
import './access-tokens.js';
import {mountAuditLog} from './audit-log.js';
import {loadAccountUsage} from './usage-data.js';
import './drains.js';
import './mfa-status.js';
import './sign-in-methods.js';
import {loadAccountKeys,writeKeyState,confirmKeyRevocation,newestKeyId,mintApiKey,keyType,KEY_PREFIXES,KEY_TYPE_LABELS} from './key-data.js';
import {parseRedactionRules,redactExport,createRedactionInputBudget} from './redaction.js';
import {saveAccountArchive,prepareAccountArchive} from './account-export.js';
import {saveWorkspaceArchive,prepareWorkspaceArchive} from './workspace-export.js';
import {mountSignIn} from '/signin.js';
import {rememberSetupCode,pendingSetupCode,clearSetupCode,setupReturnUrl} from './setup-code.js';
rememberSetupCode();
if(pendingSetupCode()&&!location.search&&!location.hash)history.replaceState(null,'',setupReturnUrl());
import {loadAccountRuns,queryAccountRuns} from './run-data.js';
import {mountWorkspaceStartup} from './startup-ui.js';
import {mountLangsmithImport} from './langsmith-import.js';
import {mountBraintrustImport} from './braintrust-import.js';
import {createLiveWatch} from './live-data.js';
import {mountFirstTrace,clearFirstTraceStorage} from './first-trace.js';
import './integrations.js';
import './logs.js';
import './entitlements.js';
import './account-delete.js';
import './plan-billing.js';
import {mountSpanView} from './span-ui.js';
const $=id=>document.getElementById(id);
// Version skew guard. When this script runs against a page cached from another release, a missing element stops
// evaluation with a TypeError and the session check never starts. Load the matching page once; if that was just
// tried, say so instead of leaving the session check on screen. The guard only covers evaluation of this module:
// a module script runs before the load event, and its failure is reported before that event too.
const pageSkew=event=>{
 if(!(event.error instanceof TypeError))return;
 try{const last=Number(sessionStorage.getItem('supatrace-skew-reload'));if(!(Date.now()-last<60000)){sessionStorage.setItem('supatrace-skew-reload',String(Date.now()));location.reload();return;}}catch{/* No session storage: show the message. */}
 const status=$('status');if(status)status.textContent='This page is out of date. Reload it to finish updating. If that does not help, clear the cached files for this site.';
};
addEventListener('error',pageSkew);addEventListener('load',()=>removeEventListener('error',pageSkew),{once:true});
let activeWorkspaceName='Selected workspace',workspaceExportScope=null;
let actorTenant=null,actorDefaultProject=null,activeWorkspace=new URLSearchParams(location.search||'').get('workspace'),activeEnvironment=new URLSearchParams(location.search||'').get('environment')??'default',activeRole='owner';
let keySigningOut=false,keySuspended=false,keyAttempt=null,langsmithImport=null,braintrustImport=null,importConsent=null;
let usageJob=null,usageBlocked=false,usageStarted=false,usageResumeNeeded=false,usagePhase='idle',usageProject=null;
let keyCatalog=null,keyProject=null,keyPhase='idle',keyLoadVersion=0,keyLoadAbort=null,keyExpiryTimer=null,keyView=null,keySessionVersion=0,keyRevocation=null,keyRotation=null,apiKeyAttempt=null,apiKeyBusy=false,apiKeyShownFor=null;const keyRotationAttempts=new Map();const keyConfirmedRevoked=new Set();
let redactionJob=null,redactionDraft=null,redactionVersion=0;
let accountDownloadDraft=null;
let billingVersion=0,billingAbort=null,billingReady=false,billingBusy=false,billingTestPlans=false,enforcedPlanName=null;
const views=['home','traces','agents','keys','usage','billing','settings'];
let displayedView=null,detailReturnFocus=null,pageResumeFocus=null;
let next=null,offset=0,sort='started',dir='desc',selected=null,busy=false,refreshBusy=false,usageVersion=0,runsVersion=0,activeProject=null,exportJob=null,loaded=[],detailJob=null,detailVersion=0,detailCursor=null,detailBusy=false,detailComplete=false,detailEvents=0,detailBytes=0,detailSeen=new Set(),detailRows=[],statusFailure=null,liveSignal=null,catalogMark=null,firstTrace=null;
async function api(path,body,signal,project=activeProject,environment=activeEnvironment,workspace=activeWorkspace){if(project&&/^(environments(?:\/.*)?|workspace|entitlements|integrations|logs)(?:\?|$)/.test(path))path+=(path.includes('?')?'&':'?')+'project='+encodeURIComponent(project);if(project&&/^(support|usage|runs(?:\/page)?|events|keys(?:\/(?:revoke|create|rotate))?|setup\/(?:start|approve)|imports\/(?:capabilities|plan|start|review|consent|revoke)|billing\/(?:checkout|portal|status|spend-cap|resume))(?:\?|$)/.test(path))path+=(path.includes('?')?'&':'?')+'project='+encodeURIComponent(project);if(['support','usage','runs','runs/page','events','keys','keys/revoke','keys/create','keys/rotate','setup/start','setup/approve','workspaces','workspace','environments','entitlements','integrations','logs'].includes(path.split('?')[0])||['imports/','billing/','workspaces/','environments/','audit'].some(p=>path.startsWith(p))){if(workspace&&workspace!==actorTenant)path+=(path.includes('?')?'&':'?')+'workspace='+encodeURIComponent(workspace);if(environment!=='default')path+=(path.includes('?')?'&':'?')+'environment='+encodeURIComponent(environment);} const raw=body===undefined?undefined:JSON.stringify(body);const headers={};if(raw!==undefined){headers['Content-Type']='application/json';headers['x-amz-content-sha256']=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw))),v=>v.toString(16).padStart(2,'0')).join('');}const r=await fetch('/api/'+path,{method:body===undefined?'GET':'POST',headers,body:raw,credentials:'same-origin',cache:'no-store',signal,...(path.split('?')[0]==='billing/checkout'?{redirect:'error'}:{})});if(r.status===204)return {};const value=await r.json().catch(error=>{if(!r.ok)return {};throw error;});if(!r.ok){const error=new Error(r.status===429?'rate_limit':value?.error||'Request failed');error.status=r.status;error.limitName=value?.limit_name;error.retryAfter=Number(r.headers.get('retry-after'));if((value?.error==='plan_upgrade_required'||value?.error==='plan_limit_reached')&&typeof value.message==='string'&&value.message)error.detail=value.message+' Upgrade in Billing.';if(activeProject&&!signal?.aborted&&(error.message==='sign_in_required'||error.message==='project_unavailable'||path.startsWith('billing/')&&['workspace_owner_required','billing_scope_changed'].includes(error.message)))invalidateAccountIdentity();throw error;}if(/^(runs(?:\/page)?|events|keys)(?:\?|$)/.test(path)&&(environment!=='default'?value?.environment_id!==environment:value?.environment_id!==undefined&&value.environment_id!=='default'))throw Error('environment_unavailable');return value;}
const messages={export_cancelled:'Export cancelled. No file was downloaded.',export_rate_limited:'Export could not resume after repeated rate limits. Try again later.',sign_in_required:'Please sign in to continue.',mfa_required:'Enter the current authentication code, or sign in again, before changing two-factor authentication.',service_not_configured:'This workspace preview is not accepting traces yet. Sign-in and uploads are disabled while deployment is verified.',temporarily_unavailable:'The service is temporarily unavailable. Your local upload stays pending until it receives a matching receipt.',origin_required:'The browser could not prove this request came from Supatrace. Refresh the page and try again.',invalid_code:'That setup code is not valid. Approve only a code your own agent just showed you.',setup_expired:'That setup code has expired. Start the agent connection again.',code_unavailable:'That code belongs to a different account.',invalid_write_key:'This agent key is not active.',payload_hash_required:'The upload did not include a matching content hash.',idempotency_conflict:'That batch was already uploaded with different content.',google_sign_in_unavailable:'Google sign-in is not turned on for this workspace.',key_not_found:'That agent key is not on this account.',key_scope_denied:'This key is not allowed to do that.',key_inactive:'That key is no longer active.',key_already_rotated:'That key was already rotated.',key_not_rotatable:'Pairing keys cannot be rotated. Create an API key, then revoke this one.',project_unavailable:'This account does not have a workspace project yet.',invalid_query:'That filter is not valid.'};
Object.assign(messages,{monthly_span_allowance_exceeded:'This month\u2019s span allowance for your plan is used up. It resets at the start of next month (UTC). Check Usage for the date. Billing shows the plans with a higher allowance.',spend_cap_reached:'The spend cap is on and this month\u2019s included spans are used up, so uploads stop instead of adding overage. The workspace owner can turn the cap off under Billing.',spend_cap_not_configurable:'This plan always stops at its allowance; there is no spend cap to change.',spend_cap_conflict:'The plan changed while saving. Refresh billing and try again.',project_paused:'This project is paused because no trace was accepted for 30 days. The workspace owner can resume it under Usage; stored traces are kept.',stored_bytes_allowance_exceeded:'Your plan\u2019s stored-data allowance is used up. It does not reset monthly. Check Usage. Billing shows the plans with more stored data.',storage_capacity:'Storage capacity is full. Keep the unchanged local batch; repeated retries will not add capacity. This alpha quota does not reset monthly.',storage_capacity_or_unknown_tenant:'Upload capacity is unavailable. Keep the unchanged local batch and check Usage and the setup guide before retrying.',active_key_capacity:'This account already has 10 active write keys. Revoke an unused key before approving another.',rate_limit:'The request limit was reached. Wait before trying again.',identity_provider_unavailable:'Sign-in could not finish. Start a fresh sign-in with the same provider.',invalid_query:'That filter is not valid. Check the run ID and date range, or clear the filters.','Export too large for this browser':'This browser cannot download this trace in memory. Use a browser with Save File support for a streaming export; no file was downloaded.'});
messages.plan_upgrade_required='This needs a higher plan. Billing shows what each plan includes.';messages.plan_limit_reached='This organization has reached its plan limit. Billing shows what each plan includes; nothing existing was changed.';
messages.import_runtime_unavailable='Automatic import cannot start: secure source connection and private job execution are not configured. No provider request or upload was started.';
messages.invalid_import_plan='Check the exact source project, environment, UTC window and import limits. No connection or import was started.';
messages.account_export_unavailable='Account export is unavailable in this browser. No download was started.';
messages.account_export_too_large='This account exceeds the standard download limit of 20 MiB or 100,000 events. Use Save File support for a streaming archive. No download was started.';
messages.account_download_failed='The account download could not be prepared or started. No complete download was confirmed. Retry Export account.';
messages.account_export_incomplete='The account catalog is incomplete or outside export bounds. No complete archive was committed.';
messages.account_export_changed='The account changed or event counts did not reconcile. The archive was not committed. Pause uploads and retry.';
messages.account_export_rate_limited='Archive read stopped at the request limit. No complete archive was confirmed. Check any selected file before retrying to a new file.';
messages.account_export_read_deadline='An archive read took too long. No complete archive was confirmed. Check any selected file before retrying to a new file.';
messages.account_export_read_failed='An archive read could not finish. No complete archive was confirmed. Check any selected file before retrying to a new file.';
messages.export_file_cancelled='Export cancelled before completion. The selected file was not committed; an empty new file may remain.';
messages.export_file_unconfirmed='Export could not be confirmed complete. Do not use the selected file as a complete export; retry to a new file.';
messages.export_read_deadline='The next trace batch took too long. No complete export was confirmed. Retry the export.';
messages.invalid_export_page='The export response was incomplete or repeated a page. No file was downloaded. Try again.';
function explain(e,scope){if(e.detail&&(e.message==='plan_upgrade_required'||e.message==='plan_limit_reached'))return e.detail;if((scope==='runs'||scope==='detail')&&(e.message==='temporarily_unavailable'||!messages[e.message]))return 'Could not retrieve traces. Try again. Your stored traces were not changed.';if(e.message==='invalid_code'&&e.mfa)return 'That authentication code is not valid.';if(e.message==='rate_limit'&&Number.isFinite(e.retryAfter)&&e.retryAfter>0)return `The request limit was reached. Wait ${Math.ceil(e.retryAfter)} seconds, then try again.`;return messages[e.message]||'The request could not finish. Refresh to try again. Keep any local upload files until the server acknowledges them.';}
function toast(text){const node=document.createElement('p');node.className='toast';node.textContent=text;$('toasts').append(node);setTimeout(()=>node.remove(),4200);}
function keyRecovery(node,error){if(error.limitName==='api_keys'||error.message==='active_key_capacity'){const link=document.createElement('a');link.href='#keys';link.textContent='Open API keys to revoke an unused key';node.append(' ',link);}}
function report(e,scope='general'){const text=explain(e,scope);statusFailure={scope};$('status').textContent=text;keyRecovery($('status'),e);toast(text);}
function clearFailure(scope){if(statusFailure&&(!scope||statusFailure.scope===scope)){$('status').textContent='';statusFailure=null;}}
function renderAccountIdentity(me,project){
 activeWorkspaceName=project.workspace_name??project.name;
 setCheckoutAccount(me.tenant_id,project.id);
 const labels={github:'GitHub',google:'Google',email:'Email and password',sso:'SSO',chatgpt:'ChatGPT (experimental)'};
 const provider=typeof me.auth_provider==='string'&&Object.hasOwn(labels,me.auth_provider)?labels[me.auth_provider]:null;
 $('account-reload').hidden=true;
 $('provider-line').textContent=provider?'Sign-in provider: '+provider:'Sign-in provider unavailable. Do not infer it from an account ID.';
 const label=me.auth_provider==='email'&&typeof me.email==='string'?me.email:me.tenant_id;
 $('who').textContent=provider?provider+' account · '+label:'Signed in as '+label;
 $('account-line').textContent=label===me.tenant_id?'Account ID: '+label:'Account: '+label;
 for(const id of ['who','account-line'])$(id).title=label===me.tenant_id?'':me.tenant_id;
 $('project-name').textContent=(project.shared?project.workspace_name:project.name)+(activeEnvironment!=='default'?' / '+activeEnvironment:'')+' · '+project.id;
 $('project-line').textContent='Workspace: '+project.name+' · '+project.id;
}
function clearAccountIdentity(){cancelBillingRedirect();billingReady=false;$('billing-portal').hidden=true;$('billing-portal').disabled=true;importConsent?.invalidate('Account or session needs rechecking. Stored consent is not revoked by leaving this page.');workspaceExportScope=null;syncExportControls();langsmithImport?.invalidate('Workspace needs rechecking. Reload and review the scope again.');braintrustImport?.invalidate('Workspace needs rechecking. Reload and review the scope again.');cancelCommercialCheckout();checkoutRecoveryKey=null;paintCommercialControls();for(const id of ['provider-line','who','account-line','project-name','project-line']){$(id).textContent='';$(id).title='';}$('account-reload').hidden=true;}
function invalidateAccountIdentity(){clearAccountDownload();clearKeyAttempt();if(!activeProject)return;clearAccountIdentity();stopUsage('Account identity or workspace permission changed. Reload the page before checking usage and billing.');$('who').textContent='Account needs rechecking';$('provider-line').textContent='Account identity needs rechecking. Reload this page to confirm the current provider and workspace.';$('account-reload').hidden=false;}
function dash(value){return value==null||value===''?'—':String(value);}
function duration(ms){if(ms==null)return '—';if(ms<1000)return ms+'ms';return (ms/1000).toFixed(1)+'s';}
function agentLabel(run){return run.agents?.[0]?run.agents[0].slice(0,10):'—';}
function cell(className,text){const node=document.createElement('td');if(className)node.className=className;node.textContent=text;return node;}
function focusView(view){const heading=$('view-'+view).querySelector('h1');heading.tabIndex=-1;heading.focus();}
function showView({focus=false,forceFocus=false}={}){clearFailure();const name=(location.hash||'#home').replace('#','').split(/[\/?]/)[0];const view=views.includes(name)?name:'home',changed=view!==displayedView;displayedView=view;if(view!==keyView){keyView=view;stopKeyLoad();if(activeProject&&view==='keys')void keys();}for(const section of document.querySelectorAll('#workspace > section'))section.hidden=section.dataset.view!==view;for(const link of document.querySelectorAll('#rail a[data-nav]')){if(link.dataset.nav===view)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');}if(view!=='traces'||focus&&forceFocus)closeDetail();if(view!=='agents')cancelImportPlan();if(view!=='billing'){cancelCommercialCheckout();cancelBillingRedirect();}if(focus&&(changed||forceFocus))focusView(view);prefillSetupCode(view);}
function prefillSetupCode(view){if(view!=='agents')return;const match=/[?&]code=([A-Za-z0-9_-]{12})(?:&|$)/.exec(location.hash||'');const code=match?.[1]??pendingSetupCode()?.code;if(!code)return;const input=$('code');if(!input)return;input.value=code;input.focus();if(typeof history!=='undefined'&&history.replaceState)history.replaceState(null,'',location.pathname+location.search+'#agents');}
const narrow=window.matchMedia('(max-width: 800px)');
// A CSS breakpoint can blur a now-hidden button before the media change runs.
// Retain only that lost focus; an ordinary blur or a new focus clears/replaces it.
let responsiveFocusTarget=null;
document.addEventListener('focusin',event=>{responsiveFocusTarget=event.target;});
document.addEventListener('focusout',event=>{if(event.relatedTarget||availableFocus(event.target))responsiveFocusTarget=null;});
function availableFocus(node){return !!node&&node!==document.body&&node!==document.documentElement&&!node.disabled&&!node.closest('[hidden],[inert]')&&node.isConnected&&node.getClientRects().length>0;}
function menu(open,restore=true){const shown=narrow.matches&&open;$('rail').classList.toggle('open',shown);$('rail').inert=narrow.matches&&!shown;$('app-frame').inert=shown;$('skip-workspace').inert=shown;$('backdrop').hidden=!shown;$('menu-toggle').setAttribute('aria-expanded',String(shown));$('menu-toggle').setAttribute('aria-label',shown?'Close menu':'Open menu');if(shown)$('close-menu').focus();else if(restore&&narrow.matches)$('menu-toggle').focus();}
function updateUsageControls(){
 const pending=usagePhase==='loading',disabled=pending||keySigningOut||keySuspended;
 for(const suffix of ['','-home']){$('usage-refresh'+suffix).disabled=disabled;$('usage-refresh'+suffix).textContent=usagePhase==='error'?'Retry usage':'Refresh usage';$('usage-cancel'+suffix).hidden=!usageJob;}
 for(const id of ['usage','usage-page','billing-summary'])$(id).setAttribute('aria-busy',String(pending));
 $('billing-refresh').disabled=disabled;$('billing-refresh').textContent=usagePhase==='error'?'Retry billing':'Refresh billing';$('billing-cancel').hidden=!usageJob;
}
function stopUsage(message='Usage refresh cancelled. Refresh usage to check current values.',phase='stale'){
 usageVersion++;usageJob?.abort();usageJob=null;usagePhase=phase;usageBlocked=true;
 billingVersion++;billingAbort?.abort();billingAbort=null;billingBusy=false;billingReady=false;$('billing-portal').hidden=true;$('billing-portal').disabled=true;
 cancelCommercialCheckout();$('commercial-selector').hidden=true;paintCommercialControls();
 for(const id of ['usage','usage-page'])$(id).textContent=message;
 $('usage-monthly').textContent=phase==='loading'?'Checking this month\u2019s allowance…':'Monthly allowance is not current. Refresh usage to check again.';$('usage-plan-limits').textContent='';$('usage-history').textContent='';$('usage-banner').hidden=true;$('usage-banner').textContent='';$('pause-banner').hidden=true;$('pause-text').textContent='';$('project-resume').hidden=true;$('usage-lifecycle').textContent='';$('spend-cap-toggle').hidden=true;$('spend-cap-state').textContent=phase==='loading'?'Checking spend cap…':'Spend cap is not current. Refresh billing to check again.';$('spend-cap-detail').textContent='';$('usage-retention').textContent=phase==='loading'?'Checking retention…':'Retention is not current. Refresh usage to check again.';
 for(const id of ['usage-explanation-home','usage-explanation'])$(id).textContent=phase==='loading'?'Quota details will appear after a complete refresh.':'Quota details are not current. Refresh usage to check again.';
 for(const id of ['account-plan','plan-page'])$(id).textContent=phase==='loading'?'Checking account plan…':'Account plan unavailable. Refresh usage to check again.';
 $('plan-meta').textContent='';$('billing-scope').textContent=phase==='loading'?'Checking workspace scope…':'Workspace billing needs a fresh check.';$('billing-management').textContent='Refresh billing to check payment availability. No billing change was requested.';$('billing-availability').hidden=false;$('billing-availability-note').textContent=phase==='loading'?'Checking the server-provided plan catalog…':'Plan availability is unknown. Retry billing before choosing a plan.';$('billing-note').textContent=phase==='loading'?'Checking billing status. Billing actions are paused.':'Billing status unavailable. Actions are paused; this refresh did not request a billing change.';updateUsageControls();
}
// Reserved bytes move when an upload starts; accepted_uploads moves when one is accepted. Both only grow, so their sum changes on either.
function liveSignalOf(project,workspace,environment,storage){return {scope:project+'|'+(workspace??'')+'|'+environment,value:storage.used_bytes+(storage.accepted_uploads??0)};}
// In-app usage banner at 80% and 100% of the month's included spans. Derived from the validated counts on every
// refresh, so it shows even if the notification row could not be written.
function paintUsageBanner(monthly,count){
 const banner=$('usage-banner'),used=monthly?.spans_used??0,limit=monthly?.spans_limit??0,level=!monthly?0:used>=limit?100:used*100>=limit*80?80:0;
 banner.hidden=level===0;banner.dataset.level=String(level);if(!level){banner.textContent='';return;}
 const resets=new Date(monthly.resets_at).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric',timeZone:'UTC'}),capOff=monthly.spend_cap?.enabled===false;
 banner.textContent=level===80?`You have used ${count(used)} of the ${count(limit)} spans included this month (${Math.floor(used*100/limit)}%). The count resets ${resets} (UTC).`
  :capOff?`This month\u2019s ${count(limit)} included spans are used up. The spend cap is off, so uploads continue and further spans are metered as overage until ${resets} (UTC).`
  :`This month\u2019s ${count(limit)} included spans are used up. New uploads are rejected until ${resets} (UTC).`+(monthly.spend_cap?.configurable?' The workspace owner can turn the spend cap off under Billing.':'');
}
// Idle pause (#113). The state is derived by the server from the last accepted upload; the banner is on every view.
let resumeBusy=false;
function paintLifecycle(lifecycle){
 const banner=$('pause-banner'),button=$('project-resume'),day=value=>new Date(value).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric',timeZone:'UTC'}),owner=activeRole==='owner'&&activeEnvironment==='default';
 $('usage-lifecycle').textContent=!lifecycle?'':!lifecycle.pauses_when_idle?'This plan does not pause idle projects.':`Free projects pause after ${lifecycle.idle_days} days with no accepted trace. `+(lifecycle.state==='paused'?'This project is paused; its stored traces are kept.':`${lifecycle.last_upload_at?'Last accepted trace: '+day(lifecycle.last_upload_at)+'. ':''}Without a new trace it pauses on ${day(lifecycle.pauses_at)} (UTC).`);
 const show=!!lifecycle&&lifecycle.pauses_when_idle&&lifecycle.state!=='active';banner.hidden=!show;banner.dataset.state=show?lifecycle.state:'';button.hidden=!(show&&lifecycle.state==='paused'&&owner);button.disabled=resumeBusy;
 $('pause-text').textContent=!show?'':lifecycle.state==='paused'?`This project is paused: no trace was accepted for ${lifecycle.idle_days} days. New uploads are refused until it is resumed. Nothing was deleted; the plan\u2019s retention period still decides which traces are listed.`+(owner?'':activeRole==='owner'?' Switch to the Default environment to resume it.':' Ask the workspace owner to resume it.')
  :`No trace has been accepted recently. This Free project pauses on ${day(lifecycle.pauses_at)} (UTC) unless a trace is uploaded before then. A paused project keeps its traces and resumes in one click.`;
}
$('project-resume').onclick=async()=>{
 if(resumeBusy)return;resumeBusy=true;$('project-resume').disabled=true;
 try{await api('billing/resume',{});}catch(error){$('pause-text').textContent=messages[error.message]||'The project was not resumed. Refresh usage and try again.';resumeBusy=false;$('project-resume').disabled=false;return;}
 resumeBusy=false;await usage();
};
// Cost control card on Billing. The toggle exists only where the plan has overage and for the owner on Default.
let spendCapState=null,spendCapBusy=false;
function paintSpendCap(monthly){
 spendCapState=monthly?.spend_cap??null;const cap=spendCapState,toggle=$('spend-cap-toggle'),owner=activeRole==='owner'&&activeEnvironment==='default';
 toggle.hidden=!(cap?.configurable&&owner);toggle.disabled=spendCapBusy;
 if(!cap){$('spend-cap-state').textContent=monthly?'This server does not report a spend cap.':'Spend cap has not been checked.';$('spend-cap-detail').textContent='';return;}
 if(!cap.configurable){$('spend-cap-state').textContent=`${monthly.plan_name} plan: uploads always stop at the monthly allowance. Nothing is billed for usage.`;$('spend-cap-detail').textContent='A spend cap you can switch off comes with plans that have metered overage.';return;}
 $('spend-cap-state').textContent=cap.enabled?'Spend cap is on. Uploads stop when the included spans are used up, so there is no overage.':'Spend cap is off. Uploads continue past the included spans and the extra spans are metered as overage.';
 $('spend-cap-detail').textContent=`Overage rate: $${cap.overage_usd_per_million_spans} per million spans. `+(cap.overage_spans?`${cap.overage_spans.toLocaleString('en-US')} spans over the allowance this month. `:'')+'Billing is in test mode: no real charge is made.'+(owner?'':' Only the workspace owner can change this, on the Default environment.');
 toggle.textContent=cap.enabled?'Turn spend cap off':'Turn spend cap on';
}
$('spend-cap-toggle').onclick=async()=>{
 if(spendCapBusy||!spendCapState?.configurable)return;const next=!spendCapState.enabled;
 if(!next&&!globalThis.confirm?.('Turn the spend cap off? Uploads will continue past the included spans and the extra spans will be metered as overage.'))return;
 spendCapBusy=true;$('spend-cap-toggle').disabled=true;$('spend-cap-state').textContent='Saving spend cap…';
 try{await api('billing/spend-cap',{enabled:next});}catch(error){$('spend-cap-state').textContent=messages[error.message]||'Spend cap was not changed. Refresh billing and try again.';spendCapBusy=false;$('spend-cap-toggle').disabled=false;return;}
 spendCapBusy=false;await usage();
};
// "X of Y spans this month, resets <date>". Values come only from the validated server response.
function paintMonthlyAllowance(monthly,count){
 $('usage-retention').textContent=monthly?.retention_enforced?`${monthly.retention_days}-day retention on the ${monthly.plan_name} plan${monthly.proposal?' (proposed)':''}. Traces uploaded from now on stop being listed, opened and exported ${monthly.retention_days} days after upload. Traces stored before this was introduced have no expiry. ${monthly.retention_physical?'Expired data is hidden immediately; scheduled cleanup removes stored payloads and releases storage.':'Expired data is hidden, not yet deleted, and still counts toward reserved bytes.'}`:'This server does not report a retention period. No expiry is applied.';
 paintUsageBanner(monthly,count);paintSpendCap(monthly);
 $('usage-history').textContent=monthly?.history.length?'Earlier months: '+monthly.history.slice(-3).reverse().map(row=>new Date(row.period+'-01T00:00:00Z').toLocaleDateString('en-US',{year:'numeric',month:'short',timeZone:'UTC'})+' '+count(row.accepted_spans)+' spans accepted').join('; ')+'.':'';
 if(!monthly){$('usage-monthly').textContent='This server does not report a monthly allowance yet. The reserved-byte limit above applies.';$('usage-plan-limits').textContent='';return;}
 const resets=new Date(monthly.resets_at).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric',timeZone:'UTC'});
 $('usage-monthly').textContent=`${count(monthly.spans_used)} of ${count(monthly.spans_limit)} spans this month. Resets ${resets} (UTC).`+(monthly.spans_remaining===0?(monthly.spend_cap?.enabled===false?' The included spans are used up; the spend cap is off, so uploads continue and are metered as overage.':' The allowance is used up; new uploads are rejected until the reset.'):'');
 $('usage-plan-limits').textContent=`${monthly.plan_name} plan${monthly.proposal?' (proposed allowance, not a final offer)':''}: ${count(monthly.spans_limit)} spans per calendar month. A span is one trace event; it counts when its upload is reserved, including uploads still pending. ${monthly.spend_cap?.enabled===false?'The spend cap is off: uploads past the allowance continue and are metered as overage (test mode, no real charge).':'Uploads over the allowance are rejected, never billed.'} Billing shows the plans with a higher allowance.`;
}
async function usage(){
 if(!activeProject||keySigningOut||keySuspended)return false;
 if(usageProject&&usageProject!==activeProject)loadCommercial(null);usageProject=activeProject;usageStarted=true;stopUsage('Checking upload quota…','loading');const version=usageVersion,project=activeProject,workspace=activeWorkspace??actorTenant??undefined,environment=activeEnvironment,job=new AbortController();usageJob=job;updateUsageControls();
 try{
  const {storage,account_plan,billing,commercial,monthly,lifecycle}=await loadAccountUsage((path,signal,pinned)=>api(path,undefined,signal,pinned,environment,workspace),{projectId:project,workspaceId:workspace,environmentId:environment,signal:job.signal});
  if(version!==usageVersion||project!==activeProject||job.signal.aborted||keySigningOut||keySuspended)return false;
  liveSignal=liveSignalOf(project,workspace,environment,storage);
  const count=value=>value.toLocaleString('en-US');
  const line=`${count(storage.used_bytes)} of ${count(storage.limit_bytes)} bytes reserved. ${count(storage.remaining_bytes)} bytes remaining.`;
  // Stripe test mode with plan assignment: the enforced plan is the one in the monthly allowance, moved by the test subscription.
  const plan=billing.test_plan_limits===true&&monthly?`${monthly.plan_name} plan (Stripe test mode). Limits follow the test subscription; no real payment is taken.`:account_plan.paid_active===true?`${account_plan.name}. Verified live billing controls are active.`:account_plan.billing_status==='blocked'?`${account_plan.name}. New uploads are blocked pending billing reconciliation.`:monthly?`${monthly.plan_name} plan. `+(activeRole==='owner'?'Plans and upgrade are at the top of Billing.':'The organization owner manages the plan.'):`${account_plan.name}.`;
  enforcedPlanName=monthly?.plan_name??null;paintMonthlyAllowance(monthly,count);paintLifecycle(lifecycle??null);
  $('usage').textContent=line;$('usage-page').textContent=line;$('account-plan').textContent=plan;$('plan-page').textContent=plan;
  const scope=activeWorkspaceName+' · '+project+'. One quota is shared by all workspace environments; viewing '+environment+'.';
  const accounting=storage.accounting==='cumulative_reserved_bytes'?'Reserved bytes include accepted and pending uploads. This cumulative quota does not reset monthly.':'The server did not provide accounting details. Do not assume a monthly reset or that pending uploads use no capacity.';
  $('usage-explanation-home').textContent=storage.accounting==='cumulative_reserved_bytes'?'All environments share accepted and pending reservations; no monthly reset.':'All environments share this quota. Refresh Usage for accounting details.';
  $('usage-explanation').textContent=scope+' '+accounting+' '+(storage.remaining_bytes===0?'No capacity remains for new reservations. Keep local pending files and ask the workspace owner to reconcile quota and account state before another upload.':'New reservations must fit the remaining capacity. Keep pending files until the server acknowledges the exact batch.')+' Removing local files or revoking a key does not confirm that reserved space was freed. Retention and space-reclamation actions are not available here.';
  $('billing-scope').textContent=activeWorkspaceName+' · '+project+'. '+(activeRole==='owner'?'Owner':'Member')+' access · Viewing '+environment+'.';
  usageBlocked=false;usagePhase='ready';loadCommercial(commercial);$('plan-meta').textContent='Billing status: '+({not_configured:'Not activated',active:'Paid access active',free:'Free account controls',blocked:'Reconciliation required'}[account_plan.billing_status])+'. Paid activation '+(account_plan.paid_activation_enabled?'on':'off')+'.';await loadBillingStatus(billing,{signal:job.signal,project,workspace,environment});return true;
 }catch(error){
  if(version!==usageVersion||project!==activeProject||job.signal.aborted||keySigningOut||keySuspended)return false;
  const message=error.message==='usage_deadline'?'Checking usage took too long. Retry usage to check again.':error.message==='usage_scope_mismatch'?'Usage did not match this workspace or environment. Reload the page before checking again.':error.message==='invalid_usage'?'Usage response was incomplete or inconsistent. Retry usage to check again.':error.status===429?'Usage hit the request limit. Wait, then retry usage.':'Usage unavailable. Retry usage to check again.';
  stopUsage(message,'error');return false;
 }finally{if(usageJob===job){usageJob=null;if(project!==activeProject)stopUsage('Account changed. Refresh usage to check the current account.');else updateUsageControls();}}
}
for(const suffix of ['','-home']){$('usage-refresh'+suffix).onclick=()=>{if(!usageJob&&usagePhase!=='loading')return usage();};$('usage-cancel'+suffix).onclick=()=>stopUsage();}
// Billing reuses the validated, scope-pinned Usage read. No second plan store.
$('billing-refresh').onclick=()=>{if(!usageJob&&usagePhase!=='loading')return usage();};
$('billing-cancel').onclick=()=>stopUsage();
function paintBillingAvailability(){
 const owner=activeRole==='owner',isDefault=activeEnvironment==='default';
 $('billing-availability').hidden=!!commercialPolicy;
 $('billing-availability-note').textContent=!owner?'Ask the workspace owner about plans and payments. Only the owner can manage workspace billing.':!isDefault?'Switch to Default using the Environment selector above to check available plans for this workspace.':'Plans, prices and upgrade are in the Plans card at the top of this page.';
 $('billing-management').textContent=!owner?'Only the workspace owner can open billing controls. Your personal workspace billing is separate.':!isDefault?'Billing is managed from Default. Switching environments does not create a separate subscription or quota.':billingReady?(billingTestPlans?'The Stripe test-mode portal can change or cancel the test subscription and shows its invoices. It cannot take a real payment.':'Sandbox history is read-only. It cannot update payment methods, cancel subscriptions or enable paid access.'):'Payment methods and invoices are not available here. No live payment or subscription-management action can be started from this page.';
}
function cancelBillingRedirect(){
 billingVersion++;billingAbort?.abort();billingAbort=null;billingBusy=false;
 $('billing-portal').disabled=!billingReady;$('billing-action-cancel').hidden=!checkoutBusy;
}
$('billing-action-cancel').onclick=()=>{const portal=billingBusy;cancelCommercialCheckout();cancelBillingRedirect();if(portal)$('billing-note').textContent='Opening sandbox history was cancelled. No billing change was requested. You can retry opening sandbox history.';};
// Test-mode plan assignment: what the reconciled Stripe TEST subscription did to this account's plan limits.
function testPlanNote(preview){
 // The plan in force is the account's (from the Usage read), never inferred from the subscription preview: the
 // preview lapses on its own lease while the account keeps its plan until the next reconciled event.
 const plan=enforcedPlanName??'its current',paid=enforcedPlanName!==null&&enforcedPlanName!=='Free';
 return 'Stripe test mode: this workspace has '+plan+' plan limits. '+(preview.status==='active'?'The test subscription is active.':preview.reason==='sandbox_risk_review_required'?'The test subscription is under review; limits stay as they are until it is resolved.':paid?'The subscription preview has lapsed; the limits stay until the next subscription event is reconciled.':'There is no current paid test subscription.')+' No real payment is taken. Usage shows the limits in force.';
}
async function loadBillingStatus(provided,{signal,project=activeProject,workspace=activeWorkspace,environment=activeEnvironment}={}){
 billingReady=false;$('billing-portal').hidden=true;$('billing-portal').disabled=true;paintBillingAvailability();
 if(activeRole!=='owner'||activeEnvironment!=='default'){$('billing-note').textContent=activeRole==='owner'?'Use the Environment selector above to switch to Default for workspace billing. All environments share the same quota.':'Billing is managed by the workspace owner. All environments share the workspace quota.';return;}
 if(!$('account-reload').hidden){$('billing-note').textContent='Reload this page to verify the account before opening billing controls.';return;}
 const version=++billingVersion;
 try{
  const state=provided||await api('billing/status',undefined,signal,project,environment,workspace);
  if(version!==billingVersion||signal?.aborted)return;
  billingReady=state.sandbox===true&&state.portal_available===true&&state.purchases_enabled===false&&state.paid_access===false;
  $('billing-portal').hidden=!billingReady;$('billing-portal').disabled=!billingReady;
  billingTestPlans=state.test_plan_limits===true;$('billing-portal').textContent=billingTestPlans?'Manage test subscription':'Open sandbox billing history';
  $('billing-note').textContent=billingReady?(billingTestPlans?'Stripe test mode: change or cancel the test subscription in the billing portal. No real payment is taken.':'Sandbox only: open a read-only billing portal. This does not activate paid access or change your storage limit.'):state.commercial_controls===true&&state.sandbox===false?(state.paid_access===true?'Verified live billing controls are active. The live billing portal is not configured.':state.reason==='commercial_free_account'?'Approved free account controls are active. No paid access is enabled.':'New uploads are blocked pending billing reconciliation. Stored traces remain accessible.'):state.reason==='billing_runtime_unavailable'?'Billing is temporarily unavailable. No paid access or charges are enabled.':'Billing is not activated. No paid access or charges are enabled.';
  paintBillingAvailability();
  if(state.entitlement_preview_available===true){const preview=await api('billing/sandbox-entitlement',undefined,signal,project,environment,workspace);if(version===billingVersion&&!signal?.aborted)$('billing-note').textContent=preview.quota_enforced===true?testPlanNote(preview):'Sandbox reconciliation: '+preview.status+'. Paid access and upload quota are unchanged.';}
 }catch{if(version===billingVersion&&!signal?.aborted){billingReady=false;$('billing-portal').hidden=true;$('billing-portal').disabled=true;$('billing-note').textContent='Billing status is unavailable. Refresh billing to check again; no payment was confirmed.';paintBillingAvailability();}}
}
$('billing-portal').onclick=async()=>{
 if(usageBlocked||keySigningOut||keySuspended||!checkoutIdentityReady()||activeRole!=='owner'||activeEnvironment!=='default'||!billingReady||billingBusy||location.hash!=='#billing')return;
 cancelCommercialCheckout();billingBusy=true;const version=billingVersion,job=new AbortController();billingAbort=job;$('billing-portal').disabled=true;$('billing-action-cancel').hidden=false;
 try{const result=await api('billing/portal',{},job.signal);if(version!==billingVersion||job.signal.aborted||!checkoutIdentityReady()||location.hash!=='#billing')return;const url=new URL(result.url),local=result.local_simulation===true&&location.hostname==='127.0.0.1'&&url.origin===location.origin&&url.pathname==='/__local__/portal'&&!url.search&&!url.hash;if(result.sandbox!==true||(billingTestPlans?typeof result.read_only!=='boolean':result.read_only!==true)||result.purchases_enabled!==false||(url.origin!=='https://billing.stripe.com'&&!local)||url.username||url.password)throw Error('billing_portal_invalid');location.assign(url.href);}
 catch(e){if(e.name!=='AbortError'&&version===billingVersion)$('billing-note').textContent='Could not open the sandbox billing portal. Your account access was not changed. Refresh billing to check availability and retry.';}
 finally{if(billingAbort===job){billingAbort=null;billingBusy=false;$('billing-portal').disabled=!billingReady;$('billing-action-cancel').hidden=!checkoutBusy;}}
};
// This projection is display-only. The server owns approval, prices, intents and quota.
let commercialPolicy=null,commercialFingerprint='',checkoutVersion=0,checkoutAbort=null,checkoutBusy=false,checkoutIntent=null;
let checkoutRecoveryKey=null,checkoutRecoveryProject=null,checkoutRecoveryLoaded=false,checkoutRecoveryBlocked=false;
const checkoutRecoveryPrefix='supatrace.sandbox-checkout.v1:';
function setCheckoutAccount(tenant,project){
 const key=typeof tenant==='string'&&tenant.length>0&&tenant.length<=256&&typeof project==='string'&&/^proj_[a-f0-9]{32}$/.test(project)?checkoutRecoveryPrefix+JSON.stringify([tenant,project]):null;
 if(key===checkoutRecoveryKey)return;
 cancelCommercialCheckout();checkoutIntent=null;checkoutRecoveryKey=key;checkoutRecoveryProject=project;checkoutRecoveryLoaded=false;checkoutRecoveryBlocked=false;checkoutNote('');
}
function checkoutRecoveryFailure(){
 checkoutRecoveryBlocked=true;
 checkoutNote('This tab could not safely read or save its sandbox Checkout request. No new request will be sent. Reload to retry; if it persists, ask the workspace operator to reconcile any existing attempt. Paid access and your quota are unchanged.');
}
function persistCheckoutIntent(){
 if(!checkoutRecoveryKey||!checkoutIntent){checkoutRecoveryFailure();return false;}
 try{
  // Tab-local request metadata only. Never store a Checkout URL, session secret,
  // credential or payment result. This record grants no server authority.
  const value=JSON.stringify({version:1,scope:checkoutRecoveryKey,plan_id:checkoutIntent.plan_id,policy_version:checkoutIntent.policy_version,request_id:checkoutIntent.request_id,fingerprint:checkoutIntent.fingerprint,status:checkoutIntent.status});
  sessionStorage.setItem(checkoutRecoveryKey,value);
  if(sessionStorage.getItem(checkoutRecoveryKey)!==value)throw Error('checkout_storage_unconfirmed');
  return true;
 }catch{checkoutRecoveryFailure();return false;}
}
function restoreCheckoutIntent(){
 if(checkoutRecoveryLoaded||!checkoutRecoveryKey||!commercialPolicy)return;
 checkoutRecoveryLoaded=true;
 try{
  const raw=sessionStorage.getItem(checkoutRecoveryKey);if(raw===null)return;
  if(typeof raw!=='string'||raw.length>32768)throw Error('checkout_storage_invalid');
  const saved=JSON.parse(raw);
  if(!saved||Array.isArray(saved)||Object.keys(saved).sort().join(',')!=='fingerprint,plan_id,policy_version,request_id,scope,status,version'||saved.version!==1||saved.scope!==checkoutRecoveryKey||typeof saved.plan_id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(saved.plan_id)||typeof saved.policy_version!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(saved.policy_version)||typeof saved.request_id!=='string'||!/^checkout_test_[a-f0-9]{32}$/.test(saved.request_id)||typeof saved.fingerprint!=='string'||saved.fingerprint.length>30000||!['pending','uncertain','ready','blocked'].includes(saved.status))throw Error('checkout_storage_invalid');
  const matches=saved.fingerprint===commercialFingerprint&&saved.policy_version===commercialPolicy.policy_version&&commercialPolicy.plans.some(plan=>plan.id===saved.plan_id);
  checkoutIntent={plan_id:saved.plan_id,policy_version:saved.policy_version,request_id:saved.request_id,fingerprint:saved.fingerprint,status:saved.status==='blocked'||!matches?'blocked':'uncertain'};
  checkoutNote(checkoutIntent.status==='blocked'?'The saved sandbox request needs reconciliation before another selection. Its policy changed or an earlier attempt was blocked. Ask the workspace operator to reconcile it. Paid access and your quota are unchanged.':'Recovered this tab’s sandbox Checkout request. Retry sends the same request for this account and plan; it does not start another purchase. The server may require reconciliation if the attempt expired or completed. '+(commercialPolicy?.test_plan_limits===true?'Recovering it changes nothing; the plan in force is shown under Current workspace plan.':'Paid access and your quota are unchanged.'));
  if(!matches)persistCheckoutIntent();
 }catch{checkoutRecoveryFailure();}
}
function showCheckoutReturn(){
 const params=new URLSearchParams(location.search||'');
 if(params.getAll('billing').length!==1||!['success','cancelled'].includes(params.get('billing')))return;
 // An explicit in-app destination wins on subsequent reloads or shared links.
 if(location.hash&&!['#billing','#usage'].includes(location.hash))return;
 location.hash='#billing';
 checkoutNote('Returned from Checkout. This return link does not confirm payment or change access. Review the current billing status below; any saved sandbox request remains subject to server reconciliation.');
}
function commercialProjection(value){
 if(!value||value.available!==true||value.mode!=='sandbox_preview'||value.paid_access!==false||value.purchases_enabled!==false||typeof value.policy_version!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.policy_version)||typeof value.policy_hash!=='string'||!/^[a-f0-9]{64}$/.test(value.policy_hash)||!Array.isArray(value.plans)||value.plans.length<1||value.plans.length>20)return null;
 let terms;try{if(typeof value.terms_url!=='string'||value.terms_url.length>2048||/\s/.test(value.terms_url))return null;terms=new URL(value.terms_url);}catch{return null;}
 if(!['https://supatrace.dev','https://supatrace.tech'].includes(terms.origin)||terms.username||terms.password)return null;
 const ids=new Set(),prices=new Set(),plans=[],testPlans=value.test_plan_limits===true;
 for(const plan of value.plans){
  if(!plan||typeof plan.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(plan.id)||ids.has(plan.id)||typeof plan.name!=='string'||!plan.name.trim()||plan.name.length>120||/[\x00-\x1f\x7f]/.test(plan.name)||typeof plan.price_id!=='string'||!/^price_[A-Za-z0-9]{1,180}$/.test(plan.price_id)||prices.has(plan.price_id)||!Number.isSafeInteger(plan.unit_amount)||plan.unit_amount<0||plan.currency!=='usd'||plan.interval!=='month'||!Number.isSafeInteger(plan.storage_limit_bytes)||plan.storage_limit_bytes<=0)return null;
  // Stripe test mode with plan assignment: every plan must carry the limits the account would get.
  const limits=plan.limits;if(testPlans&&(!limits||['spans_per_month','stored_bytes','retention_days'].some(key=>!Number.isSafeInteger(limits[key])||limits[key]<=0)))return null;
  ids.add(plan.id);prices.add(plan.price_id);plans.push({id:plan.id,name:plan.name,price_id:plan.price_id,unit_amount:plan.unit_amount,currency:plan.currency,interval:plan.interval,storage_limit_bytes:plan.storage_limit_bytes,...(testPlans?{limits:{spans_per_month:limits.spans_per_month,stored_bytes:limits.stored_bytes,retention_days:limits.retention_days}}:{})});
 }
 return {policy_version:value.policy_version,policy_hash:value.policy_hash,terms_url:terms.href,plans,...(testPlans?{test_plan_limits:true}:{})};
}
function checkoutNote(message){$('checkout-note').textContent=message;$('checkout-note').hidden=!message;}
function checkoutIdentityReady(){return !!checkoutRecoveryKey&&checkoutRecoveryProject===activeProject;}
function checkoutIdentityNote(){checkoutNote('Reload this page to verify the current account before retrying sandbox Checkout. This tab’s saved request is retained; no new request was sent and your quota is unchanged.');}
function checkoutMatchesPolicy(){return !!commercialPolicy&&checkoutIntent?.fingerprint===commercialFingerprint;}
function paintCommercialControls(){
 const plan=commercialPolicy?.plans.find(plan=>plan.id===$('commercial-plan').value);
 const price=plan?new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(plan.unit_amount/100):'',testPlans=commercialPolicy?.test_plan_limits===true;
 $('commercial-plan-detail').textContent=!plan?'':testPlans?`${price} per month in Stripe test mode (not charged): ${plan.limits.spans_per_month.toLocaleString('en-US')} spans per month, ${(plan.limits.stored_bytes/1e9).toLocaleString('en-US')} GB stored, ${plan.limits.retention_days}-day retention. These limits apply once the test subscription is active.`:`${price} per month. Preview cumulative reservation limit: ${plan.storage_limit_bytes.toLocaleString('en-US')} bytes. Your current quota is unchanged.`;
 $('commercial-heading').textContent=testPlans?'Upgrade (Stripe test mode)':'Sandbox plan preview';
 $('commercial-disclaimer').textContent=testPlans?'Stripe test mode. Checkout takes a test card and no real payment. When the test subscription is active, this workspace gets that plan\u2019s limits. Payments are not live; live activation is a separate decision.':'Test Checkout only. No real purchase, paid access or storage quota change is enabled. Values below are server-provided preview values, not an active subscription.';
 const identityReady=checkoutIdentityReady(),blocked=!identityReady||checkoutRecoveryBlocked||checkoutIntent&&(checkoutIntent.status==='blocked'||!checkoutMatchesPolicy());
 $('commercial-plan').disabled=usageBlocked||keySigningOut||keySuspended||!commercialPolicy||!!checkoutIntent||checkoutRecoveryBlocked||!identityReady;
 $('commercial-checkout').disabled=usageBlocked||keySigningOut||keySuspended||!commercialPolicy||!plan||checkoutBusy||!!blocked||checkoutIntent?.status==='ready';
 $('commercial-checkout').textContent=checkoutBusy?'Opening sandbox Checkout…':!identityReady?'Reload to verify account':blocked?'Reconciliation required':checkoutIntent?.status==='ready'?'Sandbox Checkout opened':checkoutIntent?'Retry same sandbox request':commercialPolicy?.test_plan_limits===true?'Upgrade with test Checkout':'Open sandbox Checkout';
 $('commercial-form').setAttribute('aria-busy',String(checkoutBusy));$('billing-action-cancel').hidden=!checkoutBusy&&!billingBusy;
}
function cancelCommercialCheckout(){
 checkoutVersion++;checkoutAbort?.abort();checkoutAbort=null;checkoutBusy=false;
 if(checkoutIntent?.status==='pending'){checkoutIntent.status='uncertain';checkoutNote('The sandbox request was interrupted. It may still exist on the server. Return to Billing to retry the same request, or have it reconciled before choosing another plan. No paid access or storage quota was activated.');persistCheckoutIntent();}
 paintCommercialControls();
}
function loadCommercial(provided){
 const next=activeRole==='owner'&&activeEnvironment==='default'?commercialProjection(provided):null,fingerprint=next?JSON.stringify(next):'';
 if(fingerprint!==commercialFingerprint){
  cancelCommercialCheckout();commercialPolicy=next;commercialFingerprint=fingerprint;
  if(checkoutIntent){checkoutIntent.status='blocked';checkoutNote('Plan information changed or became unavailable while a sandbox request remained open. Reconciliation is required before another selection. No paid access or storage quota was activated.');persistCheckoutIntent();}
 }
 restoreCheckoutIntent();
 $('commercial-selector').hidden=!commercialPolicy;paintBillingAvailability();
 const select=$('commercial-plan'),chosen=checkoutIntent?.plan_id||select.value;
 select.replaceChildren();const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='Choose a sandbox plan';select.append(placeholder);
 if(commercialPolicy){
  for(const plan of commercialPolicy.plans){const option=document.createElement('option');option.value=plan.id;option.textContent=plan.name;select.append(option);}
  select.value=commercialPolicy.plans.some(plan=>plan.id===chosen)?chosen:'';
  $('commercial-terms').href=commercialPolicy.terms_url;
  $('commercial-policy').textContent='Server policy version: '+commercialPolicy.policy_version+'. This preview does not establish commercial or provider approval.';
 }else{select.value='';$('commercial-terms').removeAttribute('href');$('commercial-policy').textContent='';}
 if(commercialPolicy&&!checkoutIdentityReady())checkoutIdentityNote();
 paintCommercialControls();
}
function checkoutRedirect(result){
 if(!result||result.status!=='open'||result.purchases_enabled!==false||result.livemode!==false||typeof result.session_id!=='string'||!/^cs_test_[A-Za-z0-9]{1,240}$/.test(result.session_id)||typeof result.url!=='string'||result.url.length>4096||/\s/.test(result.url))throw Error('checkout_response_invalid');
 const url=new URL(result.url);
 const local=result.local_simulation===true&&location.hostname==='127.0.0.1'&&url.origin===location.origin&&url.pathname==='/__local__/checkout'&&!url.hash&&[...url.searchParams.keys()].join()==='session'&&url.searchParams.get('session')===result.session_id;
 if((url.origin!=='https://checkout.stripe.com'&&!local)||url.username||url.password)throw Error('checkout_response_invalid');
 return url.href;
}
$('commercial-plan').onchange=()=>{if(checkoutIntent)$('commercial-plan').value=checkoutIntent.plan_id;paintCommercialControls();};
$('commercial-form').onsubmit=async event=>{
 event.preventDefault();
 if(usageBlocked||keySigningOut||keySuspended||activeRole!=='owner'||activeEnvironment!=='default'||!commercialPolicy||checkoutBusy||checkoutRecoveryBlocked||location.hash!=='#billing')return;
 if(!checkoutIdentityReady()){checkoutIdentityNote();paintCommercialControls();return;}
 const plan=commercialPolicy.plans.find(plan=>plan.id===$('commercial-plan').value);
 if(!plan||checkoutIntent&&(checkoutIntent.status==='blocked'||checkoutIntent.status==='ready'||!checkoutMatchesPolicy()||checkoutIntent.plan_id!==plan.id))return;
 if(!checkoutIntent){
  let random;try{random=Array.from(crypto.getRandomValues(new Uint8Array(16)),v=>v.toString(16).padStart(2,'0')).join('');}catch{checkoutNote('Secure request identifiers are unavailable. Sandbox Checkout has not started.');return;}
  checkoutIntent={plan_id:plan.id,policy_version:commercialPolicy.policy_version,request_id:'checkout_test_'+random,fingerprint:commercialFingerprint,status:'pending'};
 }
 if(billingBusy){billingVersion++;billingAbort?.abort();billingAbort=null;billingBusy=false;$('billing-portal').disabled=!billingReady;}
 checkoutIntent.status='pending';if(!persistCheckoutIntent()){paintCommercialControls();return;}checkoutBusy=true;const version=++checkoutVersion,job=new AbortController();checkoutAbort=job;
 checkoutNote(commercialPolicy?.test_plan_limits===true?'Opening a Stripe test-mode Checkout request. No real payment is taken.':'Opening a sandbox Checkout request. No real purchase, paid access or storage quota change is enabled.');paintCommercialControls();
 try{
  const result=await api('billing/checkout',{plan_id:checkoutIntent.plan_id,policy_version:checkoutIntent.policy_version,request_id:checkoutIntent.request_id},job.signal);
  if(version!==checkoutVersion||job.signal.aborted||location.hash!=='#billing'||!checkoutMatchesPolicy())return;
  const url=checkoutRedirect(result);checkoutIntent.status='ready';if(!persistCheckoutIntent())return;checkoutNote(commercialPolicy?.test_plan_limits===true?'Stripe test-mode Checkout is opening. Completing it with a test card moves this workspace to the chosen plan\u2019s limits; no real payment is taken.':'Sandbox Checkout is opening. Completing or cancelling it does not activate paid access or change your storage quota.');location.assign(url);
 }catch(error){
  if(version!==checkoutVersion||job.signal.aborted)return;
  const reconciliation=error.status===409||/reconcil|resolution|existing.*intent|intent.*existing/.test(error.message);
  checkoutIntent.status=reconciliation?'blocked':'uncertain';
  checkoutNote(reconciliation?'A sandbox request or account state needs reconciliation before Checkout can continue. This can include an unresolved request from before a reload. No new request will be created here; ask the workspace operator to reconcile it. Paid access and your quota remain unchanged.':'The sandbox Checkout outcome could not be confirmed. A request may already exist. Retry keeps the same request identifier; do not start another plan until this request is reconciled. No paid access or storage quota was activated.');
  persistCheckoutIntent();
 }finally{if(checkoutAbort===job){checkoutAbort=null;checkoutBusy=false;if(checkoutIntent?.status==='pending'){checkoutIntent.status='uncertain';checkoutNote('The sandbox response arrived after navigation and was ignored. The request may still exist. Retry the same request from Billing or have it reconciled before another selection. No paid access or storage quota was activated.');}paintCommercialControls();}}
};

function keyListNote(message){$('keys-note').textContent=message;}
function updateKeyControls(){
 const pending=!!keyLoadAbort||!!keyRevocation||!!keyRotation||keySigningOut||keySuspended;
 $('keys-refresh').disabled=pending;$('keys-cancel').hidden=!keyLoadAbort;$('keys-panel').setAttribute('aria-busy',String(!!keyLoadAbort||!!keyRevocation||keySigningOut&&!!activeProject));
 for(const button of $('keys').querySelectorAll('button'))button.disabled=pending||keyPhase!=='ready';
}
function stopKeyLoad(message='Key refresh cancelled. Refresh to check the current state.'){
 keyLoadVersion++;keyLoadAbort?.abort();keyLoadAbort=null;
 if(keyPhase==='loading'){keyPhase='stale';keyListNote(message);$('setup-state').textContent='Key status is not current. Refresh API keys before continuing.';updateKeyControls();}
}
function resetKeyState(){
 stopKeyLoad();keySessionVersion++;keyRevocation?.controller.abort();keyRevocation=null;clearTimeout(keyExpiryTimer);keyExpiryTimer=null;keyCatalog=null;keyProject=null;keyConfirmedRevoked.clear();keyRotation=null;keyRotationAttempts.clear();if(apiKeyShownFor!==keyIdentity())clearApiKeyValue();keyPhase='idle';
 $('keys').replaceChildren();const select=$('agent-filter');for(const option of [...select.options].slice(1))option.remove();select.value='';keyListNote('Key status has not been checked.');$('setup-state').textContent='Checking agent keys…';updateKeyControls();
}
function suspendKeyState(message){
 keySuspended=true;clearApiKeyValue();stopKeyLoad(message);keySessionVersion++;keyRevocation?.controller.abort();keyRevocation=null;clearTimeout(keyExpiryTimer);keyExpiryTimer=null;keyPhase='stale';keyListNote(message);$('setup-state').textContent='Key status is not current. Refresh API keys before continuing.';updateKeyControls();updateUsageControls();
}
function paintKeys(keyRows){
 clearTimeout(keyExpiryTimer);keyExpiryTimer=null;$('keys').replaceChildren();
 const select=$('agent-filter'),chosen=select.value;
 for(const option of [...select.options].slice(1))option.remove();
 const newest=newestKeyId(keyRows);
 for(const key of keyRows){
  const option=document.createElement('option');option.value=key.id;option.textContent=key.id.slice(0,10);select.append(option);
  const row=document.createElement('tr');row.className='key';
  const type=keyType(key),live=writeKeyState(key),state=live==='active'&&key.rotated?'rotating out':live,expiry=cell('',key.no_expiry?'Never':new Date(key.expires_at*1000).toLocaleString());if(!key.no_expiry)expiry.title=new Date(key.expires_at*1000).toISOString();
  const created=cell('',key.created_at?new Date(key.created_at*1000).toLocaleString():'—');
  if(key.created_at){created.title=new Date(key.created_at*1000).toISOString();}
  if(key.id===newest){const label=document.createTextNode(' (newest)');created.append(label);}
  const used=cell('',key.last_used_at?new Date(key.last_used_at*1000).toLocaleString():'—');used.title=key.last_used_at?'Updated at most once an hour. '+new Date(key.last_used_at*1000).toISOString():'No accepted upload recorded for this key.';
  row.append(cell('mono',key.id.slice(0,10)),cell('',KEY_TYPE_LABELS[type]),created,expiry,cell('',state),used);
  const action=document.createElement('td');
  if(!key.revoked){const b=document.createElement('button');b.type='button';b.className='quiet';b.textContent=keyRevocation?.id===key.id?'Revoking…':'Revoke';b.setAttribute('aria-label','Revoke key '+key.id.slice(0,10));b.onclick=()=>revokeKey(key.id);action.append(b);}
  // A rotation that committed but whose response was lost leaves this row rotated while the replacement is still
  // held here unseen. Offer to finish it: the same request is replayed and the server returns the same replacement.
  const unfinished=key.rotated===true&&keyRotationAttempts.has(key.id);
  if(type!=='legacy'&&live==='active'&&(!key.rotated||unfinished)){const b=document.createElement('button');b.type='button';b.className='quiet';b.textContent=keyRotation?.id===key.id?'Rotating…':unfinished?'Finish rotation':'Rotate';b.setAttribute('aria-label',(unfinished?'Finish rotating key ':'Rotate key ')+key.id.slice(0,10));b.onclick=()=>rotateKey(key.id);action.append(b);}
  row.append(action);$('keys').append(row);
 }
 if(!keyRows.length){const row=document.createElement('tr'),td=document.createElement('td');td.colSpan=7;td.className='empty';td.textContent='No agent keys yet.';row.append(td);$('keys').append(row);}
 select.value=[...select.options].some(option=>option.value===chosen)?chosen:'';
 if(keyPhase==='ready')$('setup-state').textContent=keyRows.some(key=>writeKeyState(key)==='active')?'An active write-only key is approved. This does not confirm agent connection or an accepted upload. Explicitly upload a reviewed batch next.':'No active write-only key. Start with Agents to approve a new key.';
 else $('setup-state').textContent='Key status is not current. Refresh API keys before continuing.';
 updateKeyControls();
 const nextExpiry=Math.min(...keyRows.filter(key=>!key.revoked&&writeKeyState(key)==='active').map(key=>key.expires_at*1000));
 if(Number.isFinite(nextExpiry)){const project=keyProject,version=keySessionVersion;keyExpiryTimer=setTimeout(()=>{if(version===keySessionVersion&&project===activeProject&&keyCatalog)paintKeys(keyCatalog);},Math.max(1,Math.min(nextExpiry-Date.now(),2147483647)));}
}
async function keys(){if(activeRole==='viewer')return true;
 if(!activeProject||keySigningOut||keySuspended)return false;
 if(keyProject!==activeProject){resetKeyState();keyProject=activeProject;}
 if(keyRevocation||keyRotation)return false;
 stopKeyLoad();const project=activeProject,version=keyLoadVersion,job=new AbortController();keyLoadAbort=job;keyPhase='loading';
 keyListNote(keyCatalog?'Refreshing keys. Previous list is shown; actions are paused.':'Loading keys…');$('setup-state').textContent='Checking agent keys…';updateKeyControls();
 try{
  const keyRows=await loadAccountKeys((path,signal)=>api(path,undefined,signal,project),{projectId:project,environmentId:activeEnvironment,signal:job.signal,onProgress:p=>{if(version===keyLoadVersion)keyListNote(p.paused?`Key refresh paused by the request limit. Retrying in ${p.retryAfter} seconds; you can cancel.`:`Loading keys… ${p.loaded} checked. No partial list is shown.`);}});
  if(version!==keyLoadVersion||project!==activeProject||job.signal.aborted)return false;
  keyCatalog=keyRows.map(key=>keyConfirmedRevoked.has(key.id)?{...key,revoked:true}:key);keyPhase='ready';keyLoadAbort=null;paintKeys(keyCatalog);keyListNote(`${keyCatalog.length} key${keyCatalog.length===1?'':'s'} checked. Approval is not proof of connection or upload. Expiry uses this browser’s clock.`);$('keys-refresh').textContent='Refresh keys';return true;
 }catch(error){
  if(version!==keyLoadVersion||project!==activeProject||job.signal.aborted)return false;
  keyPhase='error';const message={invalid_key_page:'The key history was incomplete or changed unexpectedly.',key_history_too_large:'Key history exceeds this browser’s safe display limits.',key_load_deadline:'Checking keys took too long.',key_load_rate_limited:'Key refresh could not resume after request limits.'}[error.message]||'Could not check current key status.';
  keyListNote(message+' '+(keyCatalog?'Previous list is shown with actions paused. ':'No partial list is shown. ')+'Retry to check again.');$('setup-state').textContent='Key status is unavailable. Retry from API keys; connection and upload are not confirmed.';$('keys-refresh').textContent='Retry keys';return false;
 }finally{if(version===keyLoadVersion){keyLoadAbort=null;updateKeyControls();}}
}
async function revokeKey(id){
 if(keySigningOut||keySuspended||keyRevocation||keyRotation||keyPhase!=='ready'||keyProject!==activeProject||!keyCatalog?.some(key=>key.id===id&&!key.revoked))return;
 stopKeyLoad();const operation={id,project:activeProject,session:keySessionVersion,controller:new AbortController()};keyRevocation=operation;keyPhase='revoking';keyListNote('Revocation requested. Waiting for server confirmation…');paintKeys(keyCatalog);
 try{
  const result=await confirmKeyRevocation(signal=>api('keys/revoke',{id},signal,operation.project),{signal:operation.controller.signal});
  if(operation.session!==keySessionVersion||operation.project!==activeProject||operation.controller.signal.aborted)return;
  if(result?.revoked!==true)throw new Error('unconfirmed_revoke');
  keyConfirmedRevoked.add(id);keyCatalog=keyCatalog.map(key=>key.id===id?{...key,revoked:true}:key);keyRevocation=null;keyPhase='stale';paintKeys(keyCatalog);keyListNote('Revocation confirmed. Refresh to check all key states.');
  if((location.hash||'#home')==='#keys'){toast('Key revoked.');const refreshed=await keys();if(!refreshed&&operation.session===keySessionVersion&&operation.project===activeProject)keyListNote('Revocation confirmed. '+$('keys-note').textContent);}
 }catch(error){
  if(operation.session===keySessionVersion&&operation.project===activeProject&&!operation.controller.signal.aborted){keyPhase='error';keyListNote('Revocation could not be confirmed. The request may have succeeded. Refresh keys before retrying; no automatic retry was sent.');$('keys-refresh').textContent='Refresh keys';$('setup-state').textContent='Key status needs confirmation. Refresh API keys before continuing.';}
 }finally{if(keyRevocation===operation){keyRevocation=null;if(keyCatalog&&keyProject===activeProject)paintKeys(keyCatalog);else updateKeyControls();}}
}
function clearApiKeyValue(){apiKeyAttempt=null;apiKeyShownFor=null;$('api-key-value').textContent='';$('api-key-value').hidden=true;$('api-key-result').textContent='';}
function showApiKey(value,message){apiKeyShownFor=keyIdentity();$('api-key-value').textContent=value;$('api-key-value').hidden=false;$('api-key-result').textContent=message;}
const keyTypeName=type=>type==='secret'?'Secret key':'Ingest key';
// Rotation issues a replacement of the same type; the server keeps the old key valid for the overlap window only.
async function rotateKey(id){
 const row=keyCatalog?.find(key=>key.id===id);
 if(keySigningOut||keySuspended||keyRevocation||keyRotation||apiKeyBusy||keyPhase!=='ready'||keyProject!==activeProject||!row||keyType(row)==='legacy'||row.rotated&&!keyRotationAttempts.has(id)||writeKeyState(row)!=='active')return;
 stopKeyLoad();const operation={id,project:activeProject,session:keySessionVersion};keyRotation=operation;const current=()=>operation.session===keySessionVersion&&operation.project===activeProject&&!keySigningOut&&!keySuspended;
 $('api-key-value').textContent='';$('api-key-value').hidden=true;$('api-key-result').textContent='Rotating key. Waiting for server confirmation…';paintKeys(keyCatalog);
 try{
  // A retry reuses the same replacement, so an unconfirmed first attempt cannot leave two replacements behind.
  const attempt=keyRotationAttempts.get(id)||await mintApiKey(keyType(row));keyRotationAttempts.set(id,attempt);if(!current())return;
  const result=await api('keys/rotate',{id,key_hash:attempt.key_hash},undefined,operation.project);if(!current())return;
  if(result?.rotated!==true||result.key?.id!==attempt.key_hash||result.key.key_type!==attempt.key_type||!Number.isSafeInteger(result.previous?.expires_at))throw new Error('key_rotation_unconfirmed');
  keyRotationAttempts.delete(id);keyRotation=null;showApiKey(attempt.key,keyTypeName(attempt.key_type)+' rotated. Copy the replacement now; it is shown only once. The old key keeps working until '+new Date(result.previous.expires_at*1000).toLocaleString()+', then stops.');toast('Key rotated.');await keys();
 }catch(error){
  if(current())$('api-key-result').textContent=(error.status?explain(error)+' ':'')+'Rotation was not confirmed and no replacement is shown. Refresh keys, then choose Rotate again, or Finish rotation if the key now shows as rotated: the retry reuses the same replacement. If the old key has already stopped, revoke the replacement you never saw and create a new key.';
 }finally{if(keyRotation===operation){keyRotation=null;if(keyCatalog&&keyProject===activeProject)paintKeys(keyCatalog);else updateKeyControls();}}
}
$('api-key-form').onsubmit=async event=>{
 event.preventDefault();if(keySigningOut||keySuspended||apiKeyBusy||keyRotation||!activeProject)return;
 const type=$('api-key-type').value,lifetime=$('api-key-expiry').value,identity=keyIdentity()+'|'+type+'|'+lifetime,button=$('api-key-create');
 if(!Object.hasOwn(KEY_PREFIXES,type)||!['','2592000','7776000','31536000'].includes(lifetime))return;
 if(apiKeyAttempt?.identity!==identity)apiKeyAttempt=null;
 apiKeyBusy=true;button.disabled=true;$('api-key-value').textContent='';$('api-key-value').hidden=true;$('api-key-result').textContent=apiKeyAttempt?'Retrying the same key request…':'Creating an API key…';
 let attempt=apiKeyAttempt;const current=()=>apiKeyAttempt===attempt&&keyIdentity()+'|'+type+'|'+lifetime===identity&&!keySigningOut&&!keySuspended;
 try{
  if(!attempt){attempt=apiKeyAttempt={identity,...await mintApiKey(type)};}if(!current())return;
  const created=await api('keys/create',{key_hash:attempt.key_hash,key_type:type,...(lifetime?{expires_in:Number(lifetime)}:{})});if(!current())return;
  if(created?.id!==attempt.key_hash||created.key_type!==type||!/^proj_[a-f0-9]{32}$/.test(created.project_id||''))throw new Error('Request failed');
  apiKeyAttempt=null;showApiKey(attempt.key,keyTypeName(type)+' created. Copy it now; it is shown only once and cannot be recovered. '+(type==='secret'?'Keep it on servers only.':'It can only send traces.')+(created.no_expiry?' It does not expire.':' It expires '+new Date(created.expires_at*1000).toLocaleString()+'.'));toast('API key created.');await keys();
 }catch(error){if(attempt&&!current())return;if(error.status&&error.status!==429&&error.status<500)apiKeyAttempt=null;$('api-key-result').textContent=(error.message==='active_key_capacity'?'This project already has the maximum number of active keys. Revoke one first.':explain(error))+(apiKeyAttempt?' Retry to send the same request again.':'');keyRecovery($('api-key-result'),error);}
 finally{apiKeyBusy=false;button.disabled=false;}
};
$('keys-refresh').onclick=()=>keys();
$('keys-cancel').onclick=()=>stopKeyLoad();
document.addEventListener('visibilitychange',()=>{if(!document.hidden){liveWatch?.poke();if(livePending&&liveRetry===null)liveReload();}if(!document.hidden&&!keySigningOut&&!keySuspended&&keyCatalog&&keyProject===activeProject)paintKeys(keyCatalog);});
function query(){const params=new URLSearchParams({limit:'25',offset:String(offset),sort,dir});const q=$('trace-search').value.trim();const agent=$('agent-filter').value;if(q)params.set('q',q);if(agent)params.set('agent',agent);if($('from').value)params.set('from',new Date($('from').value).toISOString());if($('to').value)params.set('to',new Date($('to').value).toISOString());return 'runs?'+params.toString();}
function filtered(){return !!($('trace-search').value.trim()||$('agent-filter').value||$('from').value||$('to').value);}
function renderRuns(){
 $('runs').replaceChildren();
 for(const button of document.querySelectorAll('.sort'))button.removeAttribute('aria-sort');
 const active=document.querySelector(`.sort[data-sort="${sort}"]`);if(active)active.setAttribute('aria-sort',dir==='asc'?'ascending':'descending');
 for(const run of loaded){
  const row=document.createElement('tr');row.className='run';row.dataset.run=run.id;if(run.id===selected)row.setAttribute('aria-current','true');
  const status=document.createElement('td');if(run.status){const badge=document.createElement('span');badge.className='badge '+run.status;badge.textContent=run.status;status.append(badge);}else status.textContent='—';
  const idCell=document.createElement('td'),open=document.createElement('button');idCell.className='id';open.type='button';open.className='trace-open';open.textContent=run.id;open.setAttribute('aria-label','Open trace '+run.id);open.onclick=()=>show(run.id);idCell.append(open);
  // Mark traces in their last week of retention. The date is the server's stamp, not a browser estimate.
  // The expiry note appears in the last quarter of a trace's retention, and never earlier than 7 days before it expires.
  const left=run.expires_at?Date.parse(run.expires_at)-Date.now():NaN,kept=run.expires_at?Date.parse(run.expires_at)-Date.parse(run.created_at):NaN;if(left>0&&left<=Math.min(7*86400000,kept>0?kept/4:7*86400000)){const note=document.createElement('span');note.className='hint expiring';note.textContent=' Expires '+new Date(run.expires_at).toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'})+' (UTC)';idCell.append(note);}
  row.append(idCell,cell('',run.started_at?new Date(run.started_at).toLocaleString():new Date(run.created_at).toLocaleString()),cell('mono',agentLabel(run)),cell('',duration(run.duration_ms)),cell('',dash(run.event_count)),status);
  row.onclick=event=>{if(!event.target.closest('button'))show(run.id);};$('runs').append(row);
 }
 if(!loaded.length){const row=document.createElement('tr'),td=document.createElement('td');td.colSpan=6;td.className='empty';if(filtered())td.textContent='No traces match these filters. Clear filters to see your other traces.';else{const link=document.createElement('a');link.href='/agent-setup.html';link.textContent='setup guide';td.append('No traces yet. Follow the ',link,' to approve an agent and send the reviewed example.');}row.append(td);$('runs').append(row);}
}
function renderRecent(){const box=$('recent');box.replaceChildren();const rows=loaded.slice(0,5);if(!rows.length){box.textContent='No traces yet.';return;}for(const run of rows){const b=document.createElement('button');b.type='button';b.className='run';b.append(cellText(run.id),cellText(run.started_at?new Date(run.started_at).toLocaleString():''));b.onclick=()=>{location.hash='traces';show(run.id);};box.append(b);}}
function cellText(text){const s=document.createElement('span');s.textContent=text;return s;}
async function runs(){const version=++runsVersion,requestedOffset=offset,requested=query(),isFiltered=filtered(),requestedView=location.hash;busy=true;clearFailure('runs');$('refresh').disabled=true;$('more').disabled=true;$('page-note').textContent='Loading traces…';let failed=false;try{const data=await accountRunPage(requested,version);if(version!==runsVersion)return;loaded=data.runs;next=data.next;renderRuns();if(runCatalog)firstTrace?.traces(runCatalog.length,id=>runCatalog.some(run=>run.id===id));clearFailure('runs');if(requestedOffset===0&&sort==='started'&&dir==='desc'&&!isFiltered){renderRecent();if(!firstTrace)$('first-trace').hidden=data.total>0;}$('more').hidden=!next;$('prev').hidden=requestedOffset===0;const end=requestedOffset+loaded.length;$('page-note').textContent=data.total?`${requestedOffset+1}–${end} of ${data.total}${data.truncated?' listed':''}`:'0 traces';$('list-limit').hidden=!data.truncated;$('list-limit').textContent=data.truncated?'This list is limited to the first 800 run IDs in key order. Totals, filters and sorting cover only that subset.':'';}catch(e){if(version===runsVersion){failed=true;$('page-note').textContent=loaded.length?'Could not load traces. Previous results are still shown.':'Could not load traces. Refresh to try again.';if(location.hash===requestedView)report(e,'runs');}}finally{if(version===runsVersion){busy=false;$('refresh').disabled=refreshBusy;$('more').disabled=failed||!next;$('prev').disabled=failed;}}return !failed;}

let runCatalog=null,runCatalogPromise=null,runCatalogController=null;
function clearRunCatalog(){runCatalogController?.abort();runCatalogController=null;runCatalogPromise=null;runCatalog=null;}
async function accountRunPage(requested,version){
 if(!runCatalog){
  if(!runCatalogPromise){
   // liveSignal is the newest usage counter seen. catalogMark is the one seen before the last scan that
   // succeeded: it moves only on success, so a failed scan never looks like a loaded list to the live watch.
   const controller=new AbortController(),mark=liveSignal;runCatalogController=controller;
   const pending=loadAccountRuns((path,signal)=>api(path,undefined,signal),{projectId:activeProject,signal:controller.signal,
    onProgress:progress=>{if(runCatalogController===controller&&!progress.complete)$('page-note').textContent='Loading account traces… '+progress.loaded.toLocaleString('en-US')+' checked.';}});
   runCatalogPromise=pending;
   pending.then(rows=>{if(runCatalogController===controller){runCatalog=rows;catalogMark=mark;}},()=>{});
  }
  const pending=runCatalogPromise;
  try{await pending;}finally{if(runCatalogPromise===pending)runCatalogPromise=null;}
 }
 if(!runCatalog)throw new Error('run_load_cancelled');
 return queryAccountRuns(runCatalog,new URLSearchParams(requested.slice(requested.indexOf('?')+1)));
}
// Get started: one click creates a publishable ingest key through the typed key route of the API keys page, then the
// card shows snippets with it and waits for the first accepted upload.
let firstKeyAttempt=null;
firstTrace=typeof mountFirstTrace==='function'?mountFirstTrace({document,origin:location.origin,copy:globalThis.navigator?.clipboard?text=>globalThis.navigator.clipboard.writeText(text):null,onOpen:id=>show(id)}):null;
$('first-key').onclick=async()=>{
 if(!firstTrace||keySigningOut||keySuspended)return;
 if(activeRole==='viewer'){$('first-key-note').textContent='Viewers cannot create keys. Ask the workspace owner for an ingest key.';return;}
 const button=$('first-key'),identity=keyIdentity();if(firstKeyAttempt?.identity!==identity)firstKeyAttempt=null;
 button.disabled=true;$('first-key-note').textContent=firstKeyAttempt?'Retrying the same key request…':'Creating an ingest key…';
 let attempt=firstKeyAttempt;const current=()=>firstKeyAttempt===attempt&&keyIdentity()===identity&&!keySigningOut&&!keySuspended;
 try{
  // A publishable ingest key (st_pub_) with no expiry, through the typed key route the API keys page uses. The browser
  // makes the key and sends only its SHA-256; a retry after a lost response re-sends the same hash, which the server repeats.
  if(!attempt)attempt=firstKeyAttempt={identity,...await mintApiKey('publishable')};if(!current())return;
  const created=await api('keys/create',{key_hash:attempt.key_hash,key_type:'publishable'});if(!current())return;
  if(created?.id!==attempt.key_hash||created.key_type!=='publishable'||created.no_expiry!==true||!/^proj_[a-f0-9]{32}$/.test(created.project_id||''))throw new Error('Request failed');
  firstKeyAttempt=null;firstTrace.keyCreated({key:attempt.key,project_id:created.project_id,environment_id:activeEnvironment});toast('Ingest key created.');await keys();
 }catch(error){
  if(attempt&&!current())return;if(error.status&&error.status!==429&&error.status<500)firstKeyAttempt=null;
  $('first-key-note').textContent=(error.message==='active_key_capacity'?'This project already has the maximum number of active keys. Revoke one under API keys first.':explain(error))+(firstKeyAttempt?' Select the button again to retry the same request.':'');keyRecovery($('first-key-note'),error);
 }
 finally{button.disabled=false;}
};
// Leaving the page, signing out or losing the identity drops a pending Home key request, so a late answer cannot put the key back on screen.
globalThis.addEventListener?.('pagehide',()=>{firstKeyAttempt=null;firstTrace?.reset();});
// Live list. One small usage read every ten seconds; the full trace catalog is reloaded only
// when the account's upload counters move, and never under an export, the reader's focus or a hidden tab.
// livePending stays set until a reload succeeds, and a retry stays scheduled while it is set,
// so a failed or deferred reload is not lost.
const LIVE_MS=10000;
let liveWaiting=false,liveRetry=null,liveState='stopped',liveLoadedAt=0,liveLoadMs=0,livePending=false,liveConfirm=false,liveFailures=0,liveSeq=0;
const liveText={starting:'Live updates on. Checking for new traces every 10 seconds.',live:'Live updates on. Checking for new traces every 10 seconds.',paused:'Live updates wait while this tab is hidden.',retrying:'Live updates are retrying. Refresh still works.',stopped:'Live updates off. Use Refresh to check for new traces.'};
function paintLive(state=liveState){if(state==='changed')return;liveState=state;$('live-note').textContent=liveWaiting&&state!=='stopped'?'Storage or upload activity changed since this list loaded. New traces may be available: Refresh to check.':liveText[state]||'';}
function liveLater(ms){if(liveRetry!==null)clearTimeout(liveRetry);liveRetry=setTimeout(()=>{liveRetry=null;liveReload();},ms);}
function liveSettled(){if(liveRetry!==null){clearTimeout(liveRetry);liveRetry=null;}liveWaiting=livePending=liveConfirm=false;liveFailures=0;}
function stopLive(){liveSettled();liveWatch?.stop();}
// liveSeq numbers the changes seen, so a list load can tell whether one arrived after it began.
function liveChanged(){liveSeq++;livePending=true;liveConfirm=true;liveFailures=0;return liveReload();}
async function liveReload(){
 if(!livePending||keySigningOut||keySuspended||!activeProject||!liveWatch?.running)return;
 // Hidden tabs do no catalog work; the visibility listener picks the pending reload up again.
 if(document.hidden===true)return;
 // An export compares catalog reads, and a reader's focus is inside the rows: leave both alone and say so.
 if(exportJob||redactionJob||accountDownloadDraft||$('runs').contains?.(document.activeElement)===true){liveWaiting=true;paintLive();return;}
 // A load is running, or the last reload was slow: try again shortly instead of stacking catalog scans.
 if(busy||refreshBusy||Date.now()-liveLoadedAt<Math.max(5000,liveLoadMs*3)){liveLater(5000);return;}
 const started=Date.now();clearRunCatalog();const loadedOk=await runs();liveLoadedAt=Date.now();liveLoadMs=liveLoadedAt-started;
 if(!liveWatch?.running)return;
 // A failed reload keeps the change pending and keeps retrying, backing off to once a minute.
 // After several failures the page also says so, since Refresh may be quicker than waiting.
 if(loadedOk===false){if(++liveFailures>5){liveWaiting=true;paintLive();}liveLater(Math.min(60000,5000*2**Math.min(liveFailures,6)));return;}
 liveFailures=0;liveWaiting=false;
 // Bytes are reserved before a batch is accepted. One more reload after a pause makes sure an
 // upload first seen as a reservation still ends up in the list.
 if(liveConfirm){liveConfirm=false;liveLater(5000);}else livePending=false;
 paintLive();
}
const liveWatch=typeof createLiveWatch==='function'?createLiveWatch({onChange:liveChanged,onState:paintLive,intervalMs:LIVE_MS,visible:()=>document.hidden!==true,
 read:async signal=>{
  const project=activeProject,workspace=activeWorkspace??actorTenant??undefined,environment=activeEnvironment;
  if(!project||keySigningOut||keySuspended)throw new Error('live_unavailable');
  const {storage}=await loadAccountUsage((path,readSignal,pinned)=>api(path,undefined,readSignal,pinned,environment,workspace),{projectId:project,workspaceId:workspace,environmentId:environment,signal});
  return liveSignal=liveSignalOf(project,workspace,environment,storage);
 }}):null;
$('live-toggle').onchange=()=>{if(!liveWatch)return;if($('live-toggle').checked){if(!keySigningOut&&!keySuspended&&activeProject)liveWatch.start(catalogMark);}else stopLive();};
globalThis.addEventListener?.('pagehide',stopLive);
Object.assign(messages,{invalid_run_page:'The trace list was incomplete or changed unexpectedly. Refresh to try again. No partial total is shown.',run_catalog_too_large:'This account is too large to list completely in this browser. No partial total or search result is shown.',run_load_deadline:'Loading all account traces took too long. Refresh to try again.',run_load_rate_limited:'Loading traces paused at the request limit. Refresh to try again.',run_load_cancelled:'Loading traces was cancelled.'});
globalThis.addEventListener?.('pagehide',clearRunCatalog);
// The waterfall is a second view of the loaded events. Selecting a span opens its raw JSON below.
const spanView=typeof mountSpanView==='function'?mountSpanView({document,root:$('span-view'),onSelect:id=>{for(const row of $('events').children){if(row.dataset?.event!==id)continue;const raw=row.querySelector?.('details');if(raw){raw.open=true;raw.scrollIntoView?.({block:'nearest'});raw.querySelector?.('summary')?.focus?.();}break;}}}):null;
function detailCount(){return `${detailEvents} event${detailEvents===1?'':'s'}`;}
function renderEvents(events,more,append=false,total=detailEvents){
 const rows=[];
 for(const event of events){const li=document.createElement('li'),d=document.createElement('details'),s=document.createElement('summary'),pre=document.createElement('pre');const time=document.createElement('span');time.className='time';time.textContent=new Date(event.time).toLocaleTimeString();const kind=document.createElement('span');kind.className='kind';kind.textContent=event.kind;const name=document.createElement('span');name.className='name';name.textContent=event.name;s.append(time,kind,name);pre.textContent=JSON.stringify(event,null,2);d.append(s,pre);li.dataset.event=event.id;li.append(d);rows.push(li);}
 if(append)$('events').append(...rows);else $('events').replaceChildren(...rows);
 const count=`${total} event${total===1?'':'s'}`;$('events-note').textContent=more?`Showing ${count}. More batches are available.`:total?`All ${count} loaded.`:'No events.';$('events-more').hidden=!more;$('events-more').textContent='Load next batch';
}
function requireExport(signal){if(signal.aborted)throw new Error('export_cancelled');}
function exportWait(ms,signal){
 return new Promise((resolve,reject)=>{
  requireExport(signal);
  const cancel=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);reject(new Error('export_cancelled'));};
  const timer=setTimeout(()=>{signal.removeEventListener('abort',cancel);resolve();},ms);
  signal.addEventListener('abort',cancel,{once:true});
 });
}
async function allEvents(id,signal,sink=null,project=activeProject,{environmentId=activeEnvironment,workspaceId=activeWorkspace,label='Export',onPause=message=>{$('status').textContent=message;}}={}){
 let after='',events=[],pages=0,bytes=0,count=0,batches=0;const seen=new Set(['']);
 do{
  let page,retries=0;
  while(true){
   requireExport(signal);
   try{page=await readEventPage(readSignal=>api('events?run='+encodeURIComponent(id)+'&after='+encodeURIComponent(after),undefined,readSignal,project,environmentId,workspaceId),{signal});break;}
   catch(error){
    requireExport(signal);
    if(error.message==='invalid_event_page')throw new Error('invalid_export_page');if(error.message==='event_read_deadline')throw new Error('export_read_deadline');
    if(error.status!==429)throw error;
    if(retries++>=5||!Number.isFinite(error.retryAfter)||error.retryAfter<1||error.retryAfter>60)throw new Error('export_rate_limited');
    onPause(`${label} paused by the request limit. Retrieved ${count} events; retrying in ${error.retryAfter} seconds. You can cancel.`);
    await exportWait(error.retryAfter*1000,signal);
   }
  }
  requireExport(signal);
  if(!page||!Array.isArray(page.events)||!Object.prototype.hasOwnProperty.call(page,'next')||(page.next!==null&&(typeof page.next!=='string'||!page.next||seen.has(page.next))))throw new Error('invalid_export_page');
  bytes+=new TextEncoder().encode(JSON.stringify(page.events)).length;
  if((!sink&&(bytes>20*1024*1024||count+page.events.length>100000))||++pages>100000)throw new Error('Export too large for this browser');
  if(page.events.length)batches++;count+=page.events.length;if(!Number.isSafeInteger(count))throw new Error('invalid_export_page');
  if(sink){await sink(page.events);requireExport(signal);}else events.push(...page.events);after=page.next;if(after)seen.add(after);
 }while(after);
 return sink?{events:count,pages,batches}:events;
}
async function saveRunFile(id,signal,pick,project=activeProject,environment=activeEnvironment,workspace=activeWorkspace){
 $('status').textContent='Exporting original trace… Choose a file if prompted.';
 return saveTraceFile({runId:id,projectId:project,environmentId:environment,signal,pick,readEvents:(run,readSignal,sink,boundProject)=>allEvents(run,readSignal,sink,boundProject,{environmentId:environment,workspaceId:workspace}),onCommit:()=>{$('cancel-export').disabled=true;$('status').textContent='Saving completed export…';}});
}
function cancelDetailLoad(message='Loading cancelled. Retry to continue from the last accepted batch.'){
 if(!detailJob)return;detailVersion++;detailJob.abort();detailJob=null;detailBusy=false;$('detail').setAttribute('aria-busy','false');$('events-cancel').hidden=true;
 if(selected&&!detailComplete){$('events-note').textContent=(detailEvents?`Showing ${detailCount()}. `:'')+message;$('events-more').hidden=false;$('events-more').disabled=false;$('events-more').textContent=detailEvents?'Retry next batch':'Retry loading events';}
}
async function loadNextEvents(){
 if(!selected||detailBusy||detailComplete||keySigningOut||keySuspended)return;
 const id=selected,project=activeProject,version=detailVersion,after=detailCursor,job=new AbortController();detailJob=job;detailBusy=true;$('detail').setAttribute('aria-busy','true');$('events-cancel').hidden=false;$('events-more').disabled=true;clearFailure('detail');
 try{
  const page=await readEventPage(signal=>api('events?run='+encodeURIComponent(id)+(after?'&after='+encodeURIComponent(after):''),undefined,signal,project),{signal:job.signal});
  if(selected!==id||version!==detailVersion||project!==activeProject||job.signal.aborted||keySigningOut||keySuspended)return;
  if(page.next!==null&&(page.next===after||detailSeen.has(page.next)))throw new Error('invalid_event_page');
  if(detailEvents+page.events.length>10000||detailBytes+page.bytes>20*1024*1024){$('events-note').textContent=`Showing ${detailCount()}. Browser inspection limit reached. Export JSON may retrieve more events, with streaming Save File support where available.`;$('events-more').hidden=true;detailComplete=true;return;}
  // Prepare and insert the whole valid page before committing its cursor/counts.
  renderEvents(page.events,page.next!==null,after!==null,detailEvents+page.events.length);
  detailSeen.add(after);detailCursor=page.next;detailComplete=page.next===null;detailEvents+=page.events.length;detailBytes+=page.bytes;clearFailure('detail');
  detailRows.push(...page.events);spanView?.render(detailRows,{complete:detailComplete});
 }catch(error){
  if(selected===id&&version===detailVersion&&project===activeProject&&!job.signal.aborted&&!keySigningOut&&!keySuspended){const why=error.message==='event_read_deadline'?'The next batch took too long.':error.message==='invalid_event_page'?'The next batch was incomplete or invalid.':'Could not load the next batch.';$('events-note').textContent=(detailEvents?`Showing ${detailCount()}. `:'')+why+' Retry to continue.';$('events-more').hidden=false;$('events-more').textContent=detailEvents?'Retry next batch':'Retry loading events';report(error,'detail');}
 }finally{if(version===detailVersion){detailBusy=false;detailJob=null;$('events-more').disabled=false;$('events-cancel').hidden=true;$('detail').setAttribute('aria-busy','false');if(project!==activeProject){$('events-note').textContent='Account changed. Reopen this trace in the current project.';$('events-more').hidden=true;}}}
}
async function show(id){
 if(keySigningOut||keySuspended)return;
 if(!$('detail').contains?.(document.activeElement))detailReturnFocus=document.activeElement;
 closeRedaction();menu(false,false);if(location.hash!=='#traces')location.hash='traces';showView();if(selected!==id)exportJob?.abort();detailJob?.abort();detailVersion++;detailBusy=false;detailComplete=false;detailCursor=null;detailEvents=0;detailBytes=0;detailSeen=new Set();detailRows=[];spanView?.clear();clearFailure();selected=id;for(const row of $('runs').querySelectorAll('.run'))row.dataset.run===id?row.setAttribute('aria-current','true'):row.removeAttribute('aria-current');$('detail').hidden=false;$('workspace').classList.add('open');$('run-title').textContent=id;$('events').replaceChildren();$('events-note').textContent='Loading…';$('events-more').hidden=true;$('run-title').focus();await loadNextEvents();
}
function closeDetail({restoreFocus=false}={}){
 const prior=selected,opener=detailReturnFocus;detailReturnFocus=null;clearAccountDownload();closeRedaction();exportJob?.abort();detailJob?.abort();detailVersion++;detailJob=null;detailBusy=false;detailCursor=null;selected=null;detailRows=[];spanView?.clear();$('events-cancel').hidden=true;$('detail').setAttribute('aria-busy','false');$('detail').hidden=true;$('workspace').classList.remove('open');
 let currentOpener;for(const row of $('runs').querySelectorAll('.run')){row.removeAttribute('aria-current');if(row.dataset.run===prior)currentOpener=row.querySelector('.trace-open');}
 if(restoreFocus){const target=availableFocus(opener)?opener:availableFocus(currentOpener)?currentOpener:null;if(target)target.focus();else focusView(displayedView||'traces');}
}
$('events-more').onclick=loadNextEvents;
$('events-cancel').onclick=()=>cancelDetailLoad();
$('close-detail').onclick=()=>closeDetail({restoreFocus:true});
$('export').onclick=async()=>{
 if(!selected||exportJob||redactionJob)return;
 closeRedaction();const id=selected,project=activeProject,environment=activeEnvironment,workspace=activeWorkspace,job=new AbortController();exportJob=job;syncExportControls();$('cancel-export').hidden=false;reportExport('trace',id);
 try{
  if(typeof window.showSaveFilePicker==='function'){const count=await saveRunFile(id,job.signal,window.showSaveFilePicker.bind(window),project,environment,workspace);$('status').textContent=`Export saved: ${count} events.`;toast('Export complete.');return;}
  const events=await allEvents(id,job.signal,null,project,{environmentId:environment,workspaceId:workspace});requireExport(job.signal);
  const blob=new Blob([JSON.stringify({version:1,run_id:id,...(environment!=='default'?{project_id:project,environment_id:environment}:{}),events})],{type:'application/json'}),href=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=href;a.download='supatrace-run.json';a.click();setTimeout(()=>URL.revokeObjectURL(href),1000);$('status').textContent='Export download started. Check your browser downloads to confirm the file was saved.';toast('Download started.');
 }catch(e){if(selected===id)report(e.message?.startsWith('export_file_')?e:job.signal.aborted?new Error('export_cancelled'):e);}
 finally{exportJob=null;syncExportControls();$('cancel-export').disabled=false;$('cancel-export').hidden=true;}
};
$('cancel-export').onclick=()=>exportJob?.abort();
// Exports are assembled in this browser from ordinary reads, so the browser tells the audit log one has started. The report never blocks or fails the export.
function reportExport(kind,runId){void api('audit/events',{action:'export.started',kind,...(runId?{run_id:runId}:{})}).catch(()=>{});}
function clearAccountDownload(){$('workspace-export-reviewed').checked=false;if(accountDownloadDraft&&/^(Account|Workspace) archive ready:/.test($('status').textContent))$('status').textContent='';accountDownloadDraft=null;$('download-account').hidden=true;$('discard-account').hidden=true;syncExportControls();}
$('export-account').onclick=async()=>{
 if(!activeProject||exportJob||redactionJob||keySigningOut||keySuspended)return;
 clearAccountDownload();closeRedaction();const project=activeProject,environment=activeEnvironment,workspace=activeWorkspace,job=new AbortController(),streaming=typeof window.showSaveFilePicker==='function';exportJob=job;syncExportControls();$('cancel-account-export').hidden=false;reportExport('account');
 try{
  const options={projectId:project,environmentId:environment,signal:job.signal,loadCatalog:signal=>loadAccountRuns((path,sig)=>api(path,undefined,sig,project,environment,workspace),{projectId:project,signal}),writeRun:(id,signal,sink)=>allEvents(id,signal,sink,project,{environmentId:environment,workspaceId:workspace}),onProgress:p=>{$('status').textContent=`Exporting account: ${p.runs_completed}/${p.runs_total} traces, ${p.events} events. Pause uploads until preparation finishes.`;},onCommit:()=>{$('cancel-account-export').disabled=true;$('status').textContent=streaming?'Saving completed account archive…':'Preparing completed account download…';}};
  if(streaming){const result=await saveAccountArchive({...options,pick:window.showSaveFilePicker.bind(window)});$('status').textContent=`Account archive saved: ${result.runs} traces, ${result.events} events. Observed read, not a point-in-time snapshot.`;toast('Account archive saved.');}
  else{
   const result=await prepareAccountArchive(options);requireExport(job.signal);if(project!==activeProject||keySigningOut||keySuspended||location.hash!=='#traces')throw new Error('export_cancelled');
   accountDownloadDraft={...result,project,workspace,environment};$('download-account').hidden=false;$('discard-account').hidden=false;$('status').textContent=`Account archive ready: ${result.runs} traces, ${result.events} events, ${result.bytes.toLocaleString('en-US')} bytes. Choose Download prepared archive. Observed read, not a point-in-time snapshot.`;
  }
 }catch(error){report(error);}finally{exportJob=null;syncExportControls();$('cancel-account-export').disabled=false;$('cancel-account-export').hidden=true;if(accountDownloadDraft)$('download-account').focus();}
};
$('workspace-export-reviewed').onchange=syncExportControls;
$('export-workspace').onclick=async()=>{
 const scope=workspaceExportScope;
 if(!scope||!$('workspace-export-reviewed').checked||scope.project!==activeProject||scope.workspace!==activeWorkspace||exportJob||redactionJob||keySigningOut||keySuspended)return;
 const project=scope.project,workspace=scope.workspace,environmentIds=[...scope.environmentIds],job=new AbortController(),streaming=typeof window.showSaveFilePicker==='function';
 clearAccountDownload();closeRedaction();exportJob=job;syncExportControls();$('cancel-account-export').hidden=false;reportExport('workspace');
 try{
  const options={workspaceId:workspace,projectId:project,environmentIds,signal:job.signal,
   loadEnvironments:async signal=>(await api('environments',undefined,signal,project,'default',workspace)).environments,
   loadCatalog:(environment,signal)=>loadAccountRuns((path,sig)=>api(path,undefined,sig,project,environment,workspace),{projectId:project,signal}),
   writeRun:(environment,id,signal,sink)=>allEvents(id,signal,sink,project,{environmentId:environment,workspaceId:workspace}),
   onProgress:p=>{$('status').textContent=`Exporting workspace: ${p.environments_completed}/${p.environments_total} environments, ${p.runs_completed} traces, ${p.events} events. Pause uploads until preparation finishes.`;},
   onCommit:()=>{$('cancel-account-export').disabled=true;$('status').textContent=streaming?'Saving completed workspace archive…':'Preparing completed workspace download…';}};
  if(streaming){const result=await saveWorkspaceArchive({...options,pick:window.showSaveFilePicker.bind(window)});$('status').textContent=`Workspace archive saved: ${result.environments} environments, ${result.runs} traces, ${result.events} events. Observed read, not a point-in-time snapshot.`;toast('Workspace archive saved.');}
  else{const result=await prepareWorkspaceArchive(options);requireExport(job.signal);if(project!==activeProject||workspace!==activeWorkspace||keySigningOut||keySuspended||location.hash!=='#traces')throw Error('export_cancelled');
   accountDownloadDraft={...result,project,workspace,kind:'workspace'};$('download-account').hidden=false;$('discard-account').hidden=false;$('status').textContent=`Workspace archive ready: ${result.environments} environments, ${result.runs} traces, ${result.events} events, ${result.bytes.toLocaleString('en-US')} bytes. Choose Download prepared archive. Observed read, not a point-in-time snapshot.`;}
 }catch(error){report(error);}finally{exportJob=null;syncExportControls();$('cancel-account-export').disabled=false;$('cancel-account-export').hidden=true;if(accountDownloadDraft)$('download-account').focus();}
};
$('cancel-account-export').onclick=()=>exportJob?.abort();
$('discard-account').onclick=()=>{clearAccountDownload();$('status').textContent='Prepared account archive discarded. No download was started.';$('export-account').focus();};
$('download-account').onclick=()=>{
 const draft=accountDownloadDraft;if(!draft||exportJob||redactionJob||keySigningOut||keySuspended||draft.project!==activeProject||draft.workspace!==undefined&&draft.workspace!==activeWorkspace||draft.kind!=='workspace'&&draft.environment!==undefined&&draft.environment!==activeEnvironment||location.hash!=='#traces'){clearAccountDownload();return;}
 let href;const revoke=()=>{if(href)try{URL.revokeObjectURL(href);}catch{}};try{href=URL.createObjectURL(draft.blob);const a=document.createElement('a');a.href=href;a.download=draft.kind==='workspace'?'supatrace-workspace.json':'supatrace-account.json';a.click();clearAccountDownload();setTimeout(revoke,60000);$('status').textContent=`${draft.kind==='workspace'?'Workspace':'Account'} download started: ${draft.runs} traces, ${draft.events} events. Check your browser downloads to confirm the file was saved.`;$('export-account').focus();}
 catch{revoke();clearAccountDownload();report(new Error('account_download_failed'));}
};
function syncExportControls(){const pending=!!exportJob||!!redactionJob;for(const id of ['export','export-account','redact-open','redact-preview','download-account','discard-account'])$(id).disabled=pending;$('workspace-export-reviewed').disabled=pending||!workspaceExportScope;$('export-workspace').disabled=pending||!workspaceExportScope||!$('workspace-export-reviewed').checked;}
function invalidateRedaction(){
 redactionVersion++;redactionDraft=null;$('redact-output').textContent='';$('redact-output').hidden=true;$('redact-reviewed').checked=false;$('redact-reviewed').disabled=true;$('redact-download').disabled=true;
}
function closeRedaction(){
 redactionJob?.abort();invalidateRedaction();$('redaction-panel').hidden=true;$('detail').classList.remove('redacting');$('redact-paths').value='';$('redact-literals').value='';$('redact-status').textContent='';
}
function redactionRulesChanged(){redactionJob?.abort();invalidateRedaction();$('redact-status').textContent='Rules changed. Generate and review a new preview before downloading.';}
$('redact-open').onclick=()=>{if(!selected||exportJob||redactionJob)return;closeRedaction();$('redaction-panel').hidden=false;$('detail').classList.add('redacting');$('redact-paths').focus();};
function redactionReturnTarget(){return $('redact-open').disabled?$('run-title'):$('redact-open');}
function dismissRedaction(){closeRedaction();redactionReturnTarget().focus();}
$('redact-close').onclick=dismissRedaction;
for(const id of ['redact-paths','redact-literals'])$(id).addEventListener('input',redactionRulesChanged);
function addRedactionPath(path){const paths=$('redact-paths').value.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);if(!paths.includes(path))paths.push(path);$('redact-paths').value=paths.join('\n');redactionRulesChanged();}
$('redact-data').onclick=()=>addRedactionPath('/events/*/data');
$('redact-names').onclick=()=>addRedactionPath('/events/*/name');
$('redact-preview').onclick=async()=>{
 if(!selected||exportJob||redactionJob)return;
 let rules;try{rules=parseRedactionRules({pathsText:$('redact-paths').value,literalsText:$('redact-literals').value});}catch(error){invalidateRedaction();$('redact-status').textContent=error.message;return;}
 invalidateRedaction();const id=selected,project=activeProject,version=redactionVersion,job=new AbortController();redactionJob=job;syncExportControls();$('redact-cancel').hidden=false;$('redact-status').textContent='Reading stored batches for a local preview…';
 try{
  const events=[],checkPage=createRedactionInputBudget(id);
  await allEvents(id,job.signal,page=>{checkPage(page);events.push(...page);},project,{label:'Preview',onPause:message=>{if(version===redactionVersion)$('redact-status').textContent=message;}});requireExport(job.signal);
  const result=redactExport({version:1,run_id:id,...(activeEnvironment!=='default'?{project_id:project,environment_id:activeEnvironment}:{}),events},rules);
  if(version!==redactionVersion||selected!==id||activeProject!==project||job.signal.aborted)return;
  redactionDraft={run:id,project,version,json:result.json};$('redact-output').textContent=result.json;$('redact-output').hidden=false;$('redact-reviewed').disabled=false;
  $('redact-status').textContent=`Preview ready: ${result.summary.masked_fields} fields and ${result.summary.literal_matches} exact-text matches masked. ${result.summary.unmatched_paths.length} paths did not match. Review the entire copy; unselected content and object keys may remain.`;
  const ids=result.summary.identifiers;$('redact-status').textContent+=` Identifier check: ${ids.changed_fields} fields changed, including ${ids.omitted_fields} omitted; ${ids.unchanged_value_occurrences} unchanged occurrences of those original values remain; ${ids.collapsed_values} distinct values collapse to a shared replacement. Links may be broken. This checks string and numeric values under common identifier field names only, not every schema or free-text reference.`;
  if(result.summary.unmatched_paths.length)$('redact-status').textContent+=' Unmatched paths: '+result.summary.unmatched_paths.join(', ');
 }catch(error){if(version===redactionVersion&&selected===id)$('redact-status').textContent=job.signal.aborted?'Preview cancelled. No file was downloaded.':error.name==='RedactionError'?error.message:explain(error);}
 finally{if(redactionJob===job){redactionJob=null;syncExportControls();$('redact-cancel').hidden=true;}}
};
$('redact-cancel').onclick=()=>{redactionJob?.abort();invalidateRedaction();$('redact-status').textContent='Preview cancelled. No file was downloaded.';};
function reviewedRedaction(){return $('redact-reviewed').checked&&redactionDraft&&redactionDraft.run===selected&&redactionDraft.project===activeProject&&redactionDraft.version===redactionVersion&&!$('redaction-panel').hidden&&!exportJob&&!redactionJob;}
$('redact-reviewed').onchange=()=>{$('redact-download').disabled=!reviewedRedaction();};
$('redact-download').onclick=()=>{
 if(!reviewedRedaction())return;
 let href;
 try{
  const blob=new Blob([redactionDraft.json],{type:'application/json'});href=URL.createObjectURL(blob);const link=document.createElement('a');link.href=href;link.download='supatrace-run-redacted.json';link.click();
  $('redact-status').textContent='Download requested; check your browser’s downloads. Original stored data is unchanged. Review the file before any sharing.';
 }catch{
  $('redact-status').textContent='The redacted download could not be confirmed. Check your browser’s downloads before explicitly retrying this reviewed copy. Original stored data is unchanged.';
 }finally{
  if(href){const release=()=>{try{URL.revokeObjectURL(href);}catch{/* Cleanup cannot confirm or undo a browser download. */}};try{setTimeout(release,1000);}catch{release();}}
 }
};
let importPlanVersion=0,importPlanAbort=null;
function cancelImportPlan(){importPlanVersion++;importPlanAbort?.abort();importPlanAbort=null;importConsent?.invalidate();$('import-plan-button').disabled=false;}
// Keep native validity rules, and also name invalid fields in the page.
$('import-form').oninput=()=>{cancelImportPlan();$('import-result').textContent='Review the changed scope again. Any active import was paused. Start or resume only after reviewing the new scope.';};
$('import-form').onsubmit=async event=>{
 event.preventDefault();cancelImportPlan();const version=importPlanVersion,project=activeProject,job=new AbortController();importPlanAbort=job;$('import-plan-button').disabled=true;$('import-result').textContent='Validating import scope only…';
 const data={provider:'langfuse',origin:$('import-origin').value,sourceProject:$('import-source').value,environment:$('import-environment').value,namespace:$('import-namespace').value,from:$('import-from').value+'Z',to:$('import-to').value+'Z',maxRows:Number($('import-rows').value),maxPages:Number($('import-pages').value),pageSize:Number($('import-page-size').value),maxBytes:Number($('import-bytes').value),maxRetries:0};
 try{if($('import-trace').value)data.traceId=$('import-trace').value;if(!project)throw new Error('project_unavailable');data.from=new Date(data.from).toISOString();data.to=new Date(data.to).toISOString();let result=await api('imports/plan',data,job.signal,project);if(job.signal.aborted||version!==importPlanVersion)return;if(result?.capabilities?.server_pull?.available===true&&result.capabilities.server_pull.mode==='bounded-server-pull-v1'){result=await api('imports/pull/plan',data,job.signal,project);if(job.signal.aborted||version!==importPlanVersion)return;}if(result?.status!=='planned_not_authorized_not_started'||result.capabilities?.project_id!==project||result.capabilities.execution_available!==false||result.plan?.scope?.destinationProject!==project)throw new Error('import_runtime_unavailable');$('import-result').textContent=JSON.stringify({status:result.status,destination_project:project,scope:result.plan.scope,fields:result.plan.fields,fingerprint:result.plan.fingerprint,warnings:result.plan.warnings,missing:result.capabilities.missing,side_effects:result.side_effects},null,2);importConsent?.setPlan(result.plan,{serverPull:result.capabilities.server_pull?.available===true&&result.capabilities.server_pull?.mode==='bounded-server-pull-v1'});}
 catch(error){if(!job.signal.aborted&&version===importPlanVersion){$('import-result').textContent=messages[error.message]||'The import plan could not be validated. Nothing was connected or started.';}}
 finally{if(version===importPlanVersion){importPlanAbort=null;$('import-plan-button').disabled=false;}}
};


globalThis.addEventListener?.('pageshow',()=>{if(pageResumeFocus){const target=pageResumeFocus==='redact-open'?redactionReturnTarget():pageResumeFocus==='menu-toggle'&&!narrow.matches?$('rail').querySelector('[aria-current="page"]'):$(pageResumeFocus);pageResumeFocus=null;if(availableFocus(target))target.focus();}if(keySuspended&&!keySigningOut){keySuspended=false;updateUsageControls();if(activeProject&&$('live-toggle').checked)liveWatch?.start(catalogMark);if(activeProject){const recheck=usageResumeNeeded,version=usageVersion,project=activeProject;usageResumeNeeded=false;void (async()=>{await keys();if(recheck&&version===usageVersion&&project===activeProject)await usage();})();}}});
globalThis.addEventListener?.('pagehide',()=>{invalidateAccountIdentity();pageResumeFocus=$('rail').classList.contains('open')&&$('rail').contains?.(document.activeElement)?'menu-toggle':!$('redaction-panel').hidden&&$('redaction-panel').contains?.(document.activeElement)?'redact-open':null;menu(false,false);usageResumeNeeded=usageStarted;stopUsage('Page paused. Refresh usage to check current values.');suspendKeyState(keyRevocation?'Revocation was interrupted and may have succeeded. Refresh keys to confirm.':'Page paused. Refresh keys to check current status.');closeRedaction();exportJob?.abort();cancelDetailLoad('Page paused. Retry to continue from the last accepted batch.');cancelImportPlan();cancelCommercialCheckout();});
$('filters').onsubmit=event=>{event.preventDefault();offset=0;runs();};
$('clear-filters').onclick=()=>{$('trace-search').value='';$('agent-filter').value='';$('from').value='';$('to').value='';offset=0;runs();};
for(const button of document.querySelectorAll('.sort'))button.onclick=()=>{const key=button.dataset.sort;if(sort===key)dir=dir==='asc'?'desc':'asc';else{sort=key;dir=key==='started'?'desc':'asc';}offset=0;runs();};
$('more').onclick=()=>{if(!next)return;offset=Number(next);runs();};
$('prev').onclick=()=>{offset=Math.max(0,offset-25);runs();};
$('refresh').onclick=async()=>{if(refreshBusy)return;refreshBusy=true;$('refresh').disabled=true;try{stopUsage('Refreshing traces and keys before checking usage. Billing actions are paused.','loading');clearRunCatalog();offset=0;
 // A pending live change is settled only by a list that loaded and began after that change was seen.
 // A failed Refresh, or a change that arrived while this scan was running, stays pending and is retried.
 const seen=liveSeq,listed=await runs();if(listed!==false&&liveSeq===seen){liveSettled();paintLive();}else if(livePending&&liveRetry===null)liveLater(5000);
 await keys().catch(e=>report(e));await usage();}finally{refreshBusy=false;$('refresh').disabled=busy;}};
$('approve').onsubmit=async event=>{event.preventDefault();const b=event.target.querySelector('button');b.disabled=true;try{await api('setup/approve',{user_code:$('code').value.trim()});$('approval').textContent='Approved. Your agent can now complete the one-time exchange.';toast('Agent approved.');clearSetupCode();$('code').value='';await keys();}catch(e){$('approval').textContent=explain(e);keyRecovery($('approval'),e);toast(explain(e));}finally{b.disabled=false;}};
// Owner shortcut for the device pairing: the browser makes the key, so the server still only sees its hash.
// One attempt per signed-in identity. A retry after a lost response re-sends the same approval, which the server repeats without minting another key.
function keyIdentity(){return actorTenant+'|'+activeProject+'|'+activeEnvironment;}
// Also clears the get-started card: it holds a second copy of a created key, and every caller
// of this function (sign-out, identity invalidation, a changed account) means that key must leave the page.
function clearKeyAttempt(){clearApiKeyValue();firstTrace?.reset();firstKeyAttempt=null;keyAttempt=null;$('created-key').textContent='';$('new-key-config').textContent='';$('new-key-config').hidden=true;$('new-key-download').removeAttribute('href');$('new-key-download').hidden=true;}
$('create-key').onclick=async()=>{if(keySigningOut||keySuspended)return;const b=$('create-key');if(keyAttempt&&keyAttempt.identity!==keyIdentity())clearKeyAttempt();b.disabled=true;$('created-key').textContent=keyAttempt?'Retrying the same write key request...':'Creating a write key...';let attempt=keyAttempt;const live=()=>keyAttempt===attempt&&attempt.identity===keyIdentity();try{if(!attempt){const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';attempt=keyAttempt={identity:keyIdentity(),key:Array.from(crypto.getRandomValues(new Uint8Array(43)),v=>alphabet[v&63]).join('')};}if(!attempt.key_hash){const key_hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(attempt.key))),v=>v.toString(16).padStart(2,'0')).join('');if(!live())return;attempt.key_hash=key_hash;}if(!attempt.user_code){const start=await api('setup/start',{key_hash:attempt.key_hash});if(!live())return;attempt.user_code=start.user_code;}const approved=await api('setup/approve',{user_code:attempt.user_code});if(!live())return;if(approved?.approved!==true||!/^proj_[a-f0-9]{32}$/.test(approved.project_id||''))throw Error('Request failed');keyAttempt=null;const config=JSON.stringify({origin:location.origin,write_key:attempt.key,approved:true,project_id:approved.project_id,...(approved.environment_id?{environment_id:approved.environment_id}:{})},null,1);$('new-key-config').textContent=config;$('new-key-config').hidden=false;$('new-key-download').setAttribute('href','data:application/json,'+encodeURIComponent(config));$('new-key-download').hidden=false;$('created-key').textContent='Write key created. Save supatrace-access.json now; the key is shown only once. Then run: python3 upload.py ./first-trace.json --config ./supatrace-access.json';toast('Write key created.');await keys();}catch(e){if(attempt&&!live())return;if(e.status===410)keyAttempt=null;$('created-key').textContent=explain(e);keyRecovery($('created-key'),e);}finally{b.disabled=false;}};
async function logout(){if(keySigningOut)return;keySigningOut=true;stopLive();clearKeyAttempt();clearSetupCode();clearFirstTraceStorage();const recheckUsage=usageStarted;closeDetail();stopUsage('Signing out. Usage and billing actions are paused.');suspendKeyState('Signing out. Key actions are paused.');closeRedaction();cancelImportPlan();langsmithImport?.invalidate('Signing out. Review the scope again after sign-in.');braintrustImport?.invalidate('Signing out. Review the scope again after sign-in.');cancelCommercialCheckout();exportJob?.abort();clearRunCatalog();try{await api('auth/logout',{});activeProject=null;resetKeyState();clearAccountIdentity();location.replace('/app/');}catch(e){keySigningOut=false;keySuspended=false;updateUsageControls();report(e);if(activeProject&&$('live-toggle').checked)liveWatch?.start(catalogMark);const version=usageVersion,project=activeProject;await keys();if(recheckUsage&&version===usageVersion&&project===activeProject)await usage();}}
$('logout').onclick=logout;$('logout-settings').onclick=logout;
$('account-reload').onclick=()=>location.reload();
$('menu-toggle').onclick=()=>menu(!$('rail').classList.contains('open'));
$('close-menu').onclick=()=>menu(false);
$('backdrop').onclick=()=>menu(false);
document.addEventListener('keydown',event=>{
 if(event.defaultPrevented||event.isComposing)return;
 if($('rail').classList.contains('open')){
  if(event.key==='Escape'){event.preventDefault();menu(false);return;}
  if(event.key==='Tab'){const links=[...$('rail').querySelectorAll('a,button')].filter(availableFocus),first=links[0],last=links.at(-1);if(!first)return;const active=document.activeElement;if(event.shiftKey&&(active===first||!$('rail').contains(active))){event.preventDefault();last.focus();}else if(!event.shiftKey&&(active===last||!$('rail').contains(active))){event.preventDefault();first.focus();}}
  return;
 }
 if(event.key==='Escape'&&!$('detail').hidden&&$('detail').contains(document.activeElement)){
  event.preventDefault();if(!$('redaction-panel').hidden)dismissRedaction();else closeDetail({restoreFocus:true});
 }
});
$('rail').addEventListener('click',event=>{const link=event.target.closest('a[href^="#"]');if(!link)return;event.preventDefault();location.hash=link.getAttribute('href');menu(false,false);showView({focus:true,forceFocus:true});});
$('skip-workspace').onclick=event=>{event.preventDefault();$('workspace').focus();};
for(const section of document.querySelectorAll('#workspace > section'))if(section.dataset.view&&!views.includes(section.dataset.view))views.push(section.dataset.view); // views added by self-mounting modules (integrations.js)
narrow.addEventListener('change',()=>{const current=document.activeElement,active=(current===document.body||current===document.documentElement)&&responsiveFocusTarget?.isConnected&&!responsiveFocusTarget.getClientRects().length?responsiveFocusTarget:current,inside=$('rail').contains?.(active);responsiveFocusTarget=null;menu(false,false);if(narrow.matches&&inside)$('menu-toggle').focus();else if(!narrow.matches&&(active===$('close-menu')||active===$('menu-toggle')))$('rail').querySelector('[aria-current="page"]')?.focus();else if(narrow.matches&&!$('detail').hidden&&$('list').contains?.(active))$('run-title').focus();});menu(false,false);
addEventListener('hashchange',()=>{menu(false,false);showView({focus:true});});
// Views added by their own modules register here, away from the shared view list, so that list never conflicts.
views.splice(views.indexOf('settings'),0,'members');
views.splice(views.indexOf('settings'),0,'audit');
Object.assign(messages,{mfa_enrollment_required:'This organization requires two-factor authentication. Turn it on in Settings, then try again.',mfa_required_by_organization:'Your organization requires two-factor authentication. Turn that rule off on the Members page before turning two-factor authentication off.'});
Object.assign(messages,{sso_required:'This organization requires single sign-on. Sign out and use Continue with SSO with your work email.'});
function showMfa(enrolled){$('mfa-enroll').hidden=enrolled;$('mfa-reenroll').hidden=!enrolled;$('mfa-disable').hidden=!enrolled;$('mfa-note').textContent=enrolled?'Two-factor authentication is on.':'Two-factor authentication is off.';$('mfa-code-form').hidden=true;$('mfa-confirm-form').hidden=true;}
function showSecret(result){$('mfa-secret').hidden=false;$('mfa-secret').textContent='Authenticator secret '+result.secret;$('mfa-confirm-form').hidden=false;$('mfa-new').value='';}
async function startEnroll(code){try{const result=await api('auth/mfa/enroll',code?{code}:{});$('mfa-code-form').hidden=true;showSecret(result);}catch(e){if(e.message==='mfa_required'||e.message==='invalid_code'){$('mfa-code-form').hidden=false;$('mfa-code-form').dataset.action='reenroll';$('mfa-note').textContent=explain({message:e.message,mfa:true});return;}report(e);}}
$('mfa-enroll').onclick=()=>startEnroll();
$('mfa-reenroll').onclick=()=>startEnroll();
$('mfa-code-form').onsubmit=async event=>{event.preventDefault();const action=$('mfa-code-form').dataset.action;const code=$('mfa-current').value;try{if(action==='disable'){await api('auth/mfa/disable',{code});$('mfa-secret').hidden=true;$('mfa-recovery').textContent='';showMfa(false);}else await startEnroll(code);}catch(err){$('mfa-note').textContent=explain({message:err.message,mfa:true});}};
$('mfa-disable').onclick=async()=>{try{await api('auth/mfa/disable',{});$('mfa-secret').hidden=true;$('mfa-recovery').textContent='';showMfa(false);}catch(e){if(e.message==='mfa_required'||e.message==='invalid_code'){$('mfa-code-form').hidden=false;$('mfa-code-form').dataset.action='disable';$('mfa-note').textContent=explain({message:e.message,mfa:true});return;}report(e);}};
$('mfa-confirm-form').onsubmit=async event=>{event.preventDefault();try{const result=await api('auth/mfa/confirm',{code:$('mfa-new').value});$('mfa-recovery').textContent='Recovery codes '+result.recovery_codes.join(' ');$('mfa-secret').hidden=true;showMfa(true);toast('Two-factor authentication is on.');}catch(err){$('mfa-note').textContent=explain({message:err.message,mfa:true});}};
showView();
for(const [formId,resultId] of [['import-form','import-result'],['langsmith-form','langsmith-status'],['braintrust-form','braintrust-status']]){
 const form=$(formId),result=$(resultId);if(!form||!result)continue;
 form.addEventListener('invalid',event=>{
  event.preventDefault();
  const fields=[...form.querySelectorAll('input,select,textarea')].filter(input=>!input.validity.valid);
  result.textContent='Complete the required fields: '+fields.map(input=>input.labels?.[0]?.textContent.trim()||input.name||input.id).join(', ')+'. Nothing was connected or started.';
 },true);
}
importConsent=mountImportConsent({document,getProject:()=>keySigningOut||keySuspended||activeEnvironment!=='default'||activeWorkspace!==actorTenant||activeProject!==actorDefaultProject||!$('account-reload').hidden?null:activeProject,request:(path,data,signal)=>api(path,data,signal)});
langsmithImport=mountLangsmithImport({document,getProject:()=>keySigningOut||keySuspended||activeEnvironment!=='default'||activeWorkspace!==actorTenant||activeProject!==actorDefaultProject||!$('account-reload').hidden?null:activeProject});
braintrustImport=mountBraintrustImport({document,getProject:()=>keySigningOut||keySuspended||activeEnvironment!=='default'||activeWorkspace!==actorTenant||activeProject!==actorDefaultProject||!$('account-reload').hidden?null:activeProject});
mountWorkspaceStartup({request:(path,signal)=>api(path,undefined,signal,null),mountSignIn,onReady:async({me,data},{focus})=>{
 actorTenant=me.tenant_id;actorDefaultProject=me.project_id;const requestedProject=new URLSearchParams(location.search||'').get('project');const chosen=activeWorkspace?data.projects.find(p=>(p.workspace_id??me.tenant_id)===activeWorkspace&&(!requestedProject||p.id===requestedProject)):requestedProject?data.projects.find(p=>p.id===requestedProject):data.projects.find(p=>p.id===me.project_id);if(!chosen)throw Error('workspace_unavailable');if(chosen.sso_required===true&&(chosen.workspace_id??me.tenant_id)!==me.tenant_id){location.replace('/app/?sso_org='+encodeURIComponent(chosen.workspace_name??'That organization')+'#home');await new Promise(()=>{});}
 if(chosen.mfa_required===true&&(chosen.workspace_id??me.tenant_id)!==me.tenant_id){location.replace('/app/?mfa_org='+encodeURIComponent(chosen.workspace_name??'That organization')+'#settings');await new Promise(()=>{});}
 activeWorkspace=chosen.workspace_id??me.tenant_id;activeRole=chosen.role??'owner';activeProject=chosen.id;
 firstTrace?.restore({account:actorTenant,project_id:activeProject,environment_id:activeEnvironment});
 // The organization on screen, for the modules that talk to the API themselves (it may have been chosen by ?project=, not ?workspace=).
 if(document.documentElement?.dataset){document.documentElement.dataset.workspace=activeWorkspace;document.documentElement.dataset.project=activeProject;}
 $('connect-command').textContent='python3 connect.py --project '+activeProject+(activeEnvironment!=='default'?' --environment '+activeEnvironment:'')+' --config ./supatrace-access.json';renderAccountIdentity(me,chosen);
 await projectsPanel?.refresh(data);
 await mountWorkspaces({request:api,me,projects:data.projects,selected:chosen,environment:activeEnvironment,beforeSwitch:()=>!exportJob&&!redactionJob&&!billingBusy&&!keyRevocation});
 await mountSupport({document,request:api});
 mountAuditLog({document,request:path=>api(path),workspace:activeWorkspace,ownWorkspace:actorTenant,role:activeRole});
 workspaceExportScope={project:activeProject,workspace:activeWorkspace,environmentIds:[...$('environment-select').options].map(o=>o.value)};
 $('workspace-export-scope').textContent='Included environments: '+[...$('environment-select').options].map(o=>o.textContent+' ('+o.value+')').join(', ')+'.';syncExportControls();
 if(activeEnvironment!=='default'||activeWorkspace!==actorTenant||activeProject!==actorDefaultProject){$('import-plan-button').disabled=true;$('import-result').textContent='Provider API handoffs currently require your personal Default project and Default environment. Environment-scoped agent uploads remain available.';}
 if(activeRole==='viewer'){for(const name of ['agents','keys']){$('rail').querySelector('[data-nav="'+name+'"]').hidden=true;}if(['#agents','#keys'].includes(location.hash))location.hash='#traces';}
showCheckoutReturn();$('status').textContent='';$('signed-out').hidden=true;document.body.classList.add('signed-in');$('shell').hidden=false;$('mfa-section').hidden=me.mfa_enabled!==true;if(me.mfa_enabled===true)showMfa(me.mfa===true);showView({focus,forceFocus:focus});await usage();await runs();if($('live-toggle').checked)liveWatch?.start(catalogMark);if(activeRole!=='viewer')await keys();
}});
