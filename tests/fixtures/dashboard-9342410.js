import {mountSignIn} from '/signin.js';
const $=id=>document.getElementById(id);
const views=['home','traces','agents','keys','usage','settings'];
let next=null,offset=0,sort='started',dir='desc',selected=null,busy=false,refreshBusy=false,usageVersion=0,runsVersion=0,activeProject=null,exportJob=null,loaded=[],detailJob=null,detailVersion=0,detailCursor=null,detailBusy=false,detailComplete=false,detailEvents=0,detailBytes=0,detailSeen=new Set(),statusFailure=null;
async function api(path,body,signal){if(activeProject&&/^(usage|runs|events|keys(?:\/revoke)?|setup\/approve)(?:\?|$)/.test(path))path+=(path.includes('?')?'&':'?')+'project='+encodeURIComponent(activeProject);const raw=body===undefined?undefined:JSON.stringify(body);const headers={};if(raw!==undefined){headers['Content-Type']='application/json';headers['x-amz-content-sha256']=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw))),v=>v.toString(16).padStart(2,'0')).join('');}const r=await fetch('/api/'+path,{method:body===undefined?'GET':'POST',headers,body:raw,credentials:'same-origin',cache:'no-store',signal});if(r.status===204)return {};const value=await r.json().catch(error=>{if(!r.ok)return {};throw error;});if(!r.ok){const error=new Error(r.status===429?'rate_limit':value?.error||'Request failed');error.status=r.status;error.retryAfter=Number(r.headers.get('retry-after'));throw error;}return value;}
const messages={export_cancelled:'Export cancelled. No file was downloaded.',export_rate_limited:'Export could not resume after repeated rate limits. Try again later.',sign_in_required:'Please sign in to continue.',mfa_required:'Enter the current authentication code, or sign in again, before changing two-factor authentication.',service_not_configured:'This workspace preview is not accepting traces yet. Sign-in and uploads are disabled while deployment is verified.',temporarily_unavailable:'The service is temporarily unavailable. Your local upload stays pending until it receives a matching receipt.',origin_required:'The browser could not prove this request came from Supatrace. Refresh the page and try again.',invalid_code:'That setup code is not valid. Approve only a code your own agent just showed you.',setup_expired:'That setup code has expired. Start the agent connection again.',code_unavailable:'That code belongs to a different account.',invalid_write_key:'This agent key is not active.',payload_hash_required:'The upload did not include a matching content hash.',idempotency_conflict:'That batch was already uploaded with different content.',google_sign_in_unavailable:'Google sign-in is not turned on for this workspace.',key_not_found:'That agent key is not on this account.',project_unavailable:'This account does not have a workspace project yet.',invalid_query:'That filter is not valid.'};
Object.assign(messages,{storage_capacity:'Storage capacity is full. Keep the unchanged local batch; repeated retries will not add capacity. This alpha quota does not reset monthly.',storage_capacity_or_unknown_tenant:'Upload capacity is unavailable. Keep the unchanged local batch and check Usage and the setup guide before retrying.',active_key_capacity:'This account already has 10 active write keys. Revoke an unused key before approving another.',rate_limit:'The request limit was reached. Wait before trying again.',identity_provider_unavailable:'Sign-in could not finish. Start a fresh sign-in with the same provider.',invalid_query:'That filter is not valid. Check the run ID and date range, or clear the filters.','Export too large for this browser':'This trace is too large to export in this browser. No file was downloaded.'});
function explain(e,scope){if((scope==='runs'||scope==='detail')&&(e.message==='temporarily_unavailable'||!messages[e.message]))return 'Could not retrieve traces. Try again. Your stored traces were not changed.';if(e.message==='invalid_code'&&e.mfa)return 'That authentication code is not valid.';if(e.message==='rate_limit'&&Number.isFinite(e.retryAfter)&&e.retryAfter>0)return `The request limit was reached. Wait ${Math.ceil(e.retryAfter)} seconds, then try again.`;return messages[e.message]||'The request could not finish. Refresh to try again. Keep any local upload files until the server acknowledges them.';}
function toast(text){const node=document.createElement('p');node.className='toast';node.textContent=text;$('toasts').append(node);setTimeout(()=>node.remove(),4200);}
function report(e,scope='general'){const text=explain(e,scope);statusFailure={scope};$('status').textContent=text;toast(text);}
function clearFailure(scope){if(statusFailure&&(!scope||statusFailure.scope===scope)){$('status').textContent='';statusFailure=null;}}
function dash(value){return value==null||value===''?'—':String(value);}
function duration(ms){if(ms==null)return '—';if(ms<1000)return ms+'ms';return (ms/1000).toFixed(1)+'s';}
function agentLabel(run){return run.agents?.[0]?run.agents[0].slice(0,10):'—';}
function cell(className,text){const node=document.createElement('td');if(className)node.className=className;node.textContent=text;return node;}
function showView({focus=false}={}){clearFailure();const name=(location.hash||'#home').replace('#','').split('/')[0];const view=views.includes(name)?name:'home';for(const section of document.querySelectorAll('#workspace > section'))section.hidden=section.dataset.view!==view;for(const link of document.querySelectorAll('#rail a[data-nav]')){if(link.dataset.nav===view)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');}if(view!=='traces')closeDetail();if(focus){const heading=$('view-'+view).querySelector('h1');heading.tabIndex=-1;heading.focus({preventScroll:true});}}
const narrow=window.matchMedia('(max-width: 800px)');
function menu(open,restore=true){const shown=narrow.matches&&open;$('rail').classList.toggle('open',shown);$('rail').inert=narrow.matches&&!shown;$('backdrop').hidden=!shown;$('menu-toggle').setAttribute('aria-expanded',String(shown));$('menu-toggle').setAttribute('aria-label',shown?'Close menu':'Open menu');if(shown)$('close-menu').focus({preventScroll:true});else if(restore&&narrow.matches)$('menu-toggle').focus({preventScroll:true});}
async function usage(){
 const version=++usageVersion;
 $('usage').textContent='Checking upload quota…';
 try{
  const {storage,account_plan}=await api('usage');
  if(version!==usageVersion)return;
  const count=value=>value.toLocaleString('en-US');
  const line=`${count(storage.used_bytes)} of ${count(storage.limit_bytes)} bytes reserved. ${count(storage.remaining_bytes)} bytes remaining.`;
  const plan=`${account_plan.name}. Paid plans are not available yet.`;
  $('usage').textContent=line;$('usage-page').textContent=line;
  $('account-plan').textContent=plan;$('plan-page').textContent=plan;
  $('plan-meta').textContent=`Billing ${account_plan.billing_status}. Paid activation ${account_plan.paid_activation_enabled?'on':'off'}.`;
 }catch{if(version===usageVersion){$('usage').textContent='Usage unavailable. Refresh to try again.';$('usage-page').textContent='Usage unavailable. Refresh to try again.';$('account-plan').textContent='Account plan unavailable.';$('plan-page').textContent='Account plan unavailable.';}}
}
function paintKeys(keyRows){
 $('keys').replaceChildren();
 const select=$('agent-filter'),chosen=select.value;
 for(const option of [...select.options].slice(1))option.remove();
 for(const key of keyRows){
  const option=document.createElement('option');option.value=key.id;option.textContent=key.id.slice(0,10);select.append(option);
  const row=document.createElement('tr');row.className='key';
  const expired=key.expires_at*1000<=Date.now();
  row.append(cell('mono',key.id.slice(0,10)),cell('',key.scope==='write_only'?'write only':key.scope),cell('',new Date(key.expires_at*1000).toLocaleDateString()),cell('',key.revoked?'revoked':expired?'expired':'active'));
  const action=document.createElement('td');
  if(!key.revoked){const b=document.createElement('button');b.type='button';b.className='quiet';b.textContent='Revoke';b.onclick=async()=>{b.disabled=true;try{await api('keys/revoke',{id:key.id});toast('Key revoked.');await keys();}catch(e){report(e);b.disabled=false;}};action.append(b);}
  row.append(action);$('keys').append(row);
 }
 if(!keyRows.length){const row=document.createElement('tr'),td=document.createElement('td');td.colSpan=5;td.className='empty';td.textContent='No agent keys yet.';row.append(td);$('keys').append(row);}
 if([...select.options].some(option=>option.value===chosen))select.value=chosen;
 $('setup-state').textContent=keyRows.some(key=>!key.revoked&&key.expires_at*1000>Date.now())?'An active write-only key is approved. Explicitly upload a reviewed batch next.':'No active write-only key yet. Start with Agents.';
}
async function keys(){const keyRows=[];let cursor=null;do{const page=await api('keys'+(cursor?'?after='+encodeURIComponent(cursor):''));keyRows.push(...page.keys);cursor=page.next;if(keyRows.length>10000)throw new Error('Key history is too large to display.');}while(cursor);paintKeys(keyRows);}
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
  row.append(idCell,cell('',run.started_at?new Date(run.started_at).toLocaleString():new Date(run.created_at).toLocaleString()),cell('mono',agentLabel(run)),cell('',duration(run.duration_ms)),cell('',dash(run.event_count)),status);
  row.onclick=event=>{if(!event.target.closest('button'))show(run.id);};$('runs').append(row);
 }
 if(!loaded.length){const row=document.createElement('tr'),td=document.createElement('td');td.colSpan=6;td.className='empty';if(filtered())td.textContent='No traces match these filters. Clear filters to see your other traces.';else{const link=document.createElement('a');link.href='/agent-setup.html';link.textContent='setup guide';td.append('No traces yet. Follow the ',link,' to approve an agent and send the reviewed example.');}row.append(td);$('runs').append(row);}
}
function renderRecent(){const box=$('recent');box.replaceChildren();const rows=loaded.slice(0,5);if(!rows.length){box.textContent='No traces yet.';return;}for(const run of rows){const b=document.createElement('button');b.type='button';b.className='run';b.append(cellText(run.id),cellText(run.started_at?new Date(run.started_at).toLocaleString():''));b.onclick=()=>{location.hash='traces';show(run.id);};box.append(b);}}
function cellText(text){const s=document.createElement('span');s.textContent=text;return s;}
async function runs(){const version=++runsVersion,requestedOffset=offset,requested=query(),isFiltered=filtered(),requestedView=location.hash;busy=true;clearFailure('runs');$('refresh').disabled=true;$('more').disabled=true;$('page-note').textContent='Loading traces…';let failed=false;try{const data=await api(requested);if(version!==runsVersion)return;loaded=data.runs;next=data.next;renderRuns();clearFailure('runs');if(requestedOffset===0&&sort==='started'&&dir==='desc'&&!isFiltered){renderRecent();$('first-trace').hidden=data.total>0;}$('more').hidden=!next;$('prev').hidden=requestedOffset===0;const end=requestedOffset+loaded.length;$('page-note').textContent=data.total?`${requestedOffset+1}–${end} of ${data.total}${data.truncated?' listed':''}`:'0 traces';$('list-limit').hidden=!data.truncated;$('list-limit').textContent=data.truncated?'This list is limited to the first 800 run IDs in key order. Totals, filters and sorting cover only that subset.':'';}catch(e){if(version===runsVersion){failed=true;$('page-note').textContent=loaded.length?'Could not load traces. Previous results are still shown.':'Could not load traces. Refresh to try again.';if(location.hash===requestedView)report(e,'runs');}}finally{if(version===runsVersion){busy=false;$('refresh').disabled=refreshBusy;$('more').disabled=failed||!next;$('prev').disabled=failed;}}}

function detailCount(){return `${detailEvents} event${detailEvents===1?'':'s'}`;}
function renderEvents(events,more,append=false){
 if(!append)$('events').replaceChildren();
 for(const event of events){const li=document.createElement('li'),d=document.createElement('details'),s=document.createElement('summary'),pre=document.createElement('pre');const time=document.createElement('span');time.className='time';time.textContent=new Date(event.time).toLocaleTimeString();const kind=document.createElement('span');kind.className='kind';kind.textContent=event.kind;const name=document.createElement('span');name.className='name';name.textContent=event.name;s.append(time,kind,name);pre.textContent=JSON.stringify(event,null,2);d.append(s,pre);li.append(d);$('events').append(li);}
 $('events-note').textContent=more?`Showing ${detailCount()}. More batches are available.`:detailEvents?`All ${detailCount()} loaded.`:'No events.';$('events-more').hidden=!more;$('events-more').textContent='Load next batch';
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
async function allEvents(id,signal){
 let after='',events=[],pages=0;
 do{
  let page,retries=0;
  while(!page){
   requireExport(signal);
   try{page=await api('events?run='+encodeURIComponent(id)+'&after='+encodeURIComponent(after),undefined,signal);}
   catch(error){
    requireExport(signal);
    if(error.status!==429)throw error;
    if(retries++>=5||!Number.isFinite(error.retryAfter)||error.retryAfter<1||error.retryAfter>60)throw new Error('export_rate_limited');
    $('status').textContent=`Export paused by the request limit. Retaining ${events.length} events; retrying in ${error.retryAfter} seconds. You can cancel.`;
    await exportWait(error.retryAfter*1000,signal);
   }
  }
  requireExport(signal);events.push(...page.events);after=page.next;
  if(events.length>100000||++pages>100000)throw new Error('Export too large for this browser');
 }while(after);
 return events;
}
async function loadNextEvents(){
 if(!selected||detailBusy||detailComplete)return;
 const id=selected,version=detailVersion,after=detailCursor,job=new AbortController();detailJob=job;detailBusy=true;$('events-more').disabled=true;clearFailure('detail');
 try{const d=await api('events?run='+encodeURIComponent(id)+(after?'&after='+encodeURIComponent(after):''),undefined,job.signal);if(selected!==id||version!==detailVersion)return;
 if(!Array.isArray(d.events)||(d.next!=null&&(typeof d.next!=='string'||!d.next||(d.next===after||detailSeen.has(d.next)))))throw new Error('invalid_event_page');
 const bytes=new TextEncoder().encode(JSON.stringify(d.events)).length;
 if(detailEvents+d.events.length>10000||detailBytes+bytes>20*1024*1024){$('events-note').textContent=`Showing ${detailCount()}. Browser inspection limit reached; use Export JSON for the complete run.`;$('events-more').hidden=true;detailComplete=true;return;}
 detailSeen.add(after);detailCursor=d.next||null;detailComplete=!detailCursor;detailEvents+=d.events.length;detailBytes+=bytes;renderEvents(d.events,!!detailCursor,after!==null);clearFailure('detail');
 }catch(e){if(selected===id&&version===detailVersion&&!job.signal.aborted){$('events-note').textContent=detailEvents?`Showing ${detailCount()}. Could not load the next batch; retry to continue.`:'Could not load events. Retry to try again.';$('events-more').hidden=false;$('events-more').textContent=detailEvents?'Retry next batch':'Retry loading events';report(e,'detail');}}
 finally{if(version===detailVersion){detailBusy=false;detailJob=null;$('events-more').disabled=false;}}
}
async function show(id){if(location.hash!=='#traces')location.hash='traces';if(selected!==id)exportJob?.abort();detailJob?.abort();detailVersion++;detailBusy=false;detailComplete=false;detailCursor=null;detailEvents=0;detailBytes=0;detailSeen=new Set();clearFailure();selected=id;for(const row of $('runs').querySelectorAll('.run'))row.dataset.run===id?row.setAttribute('aria-current','true'):row.removeAttribute('aria-current');$('detail').hidden=false;$('workspace').classList.add('open');$('run-title').textContent=id;$('events').replaceChildren();$('events-note').textContent='Loading…';$('events-more').hidden=true;await loadNextEvents();}
function closeDetail({restoreFocus=false}={}){const prior=selected;exportJob?.abort();detailJob?.abort();detailVersion++;detailJob=null;detailBusy=false;detailCursor=null;selected=null;$('detail').hidden=true;$('workspace').classList.remove('open');for(const row of $('runs').querySelectorAll('.run')){row.removeAttribute('aria-current');if(restoreFocus&&row.dataset.run===prior)row.querySelector('.trace-open')?.focus({preventScroll:true});}}
$('events-more').onclick=loadNextEvents;
$('close-detail').onclick=()=>closeDetail({restoreFocus:true});
$('export').onclick=async()=>{
 if(!selected||exportJob)return;
 const id=selected,job=new AbortController();exportJob=job;$('export').disabled=true;$('cancel-export').hidden=false;
 try{
  const events=await allEvents(id,job.signal);requireExport(job.signal);
  const blob=new Blob([JSON.stringify({version:1,run_id:id,events},null,2)],{type:'application/json'}),href=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=href;a.download='supatrace-run.json';a.click();setTimeout(()=>URL.revokeObjectURL(href),1000);$('status').textContent='Export complete.';toast('Export complete.');
 }catch(e){if(selected===id)report(job.signal.aborted?new Error('export_cancelled'):e);}
 finally{exportJob=null;$('export').disabled=false;$('cancel-export').hidden=true;}
};
$('cancel-export').onclick=()=>exportJob?.abort();
globalThis.addEventListener?.('pagehide',()=>{exportJob?.abort();detailJob?.abort();});
$('filters').onsubmit=event=>{event.preventDefault();offset=0;runs();};
$('clear-filters').onclick=()=>{$('trace-search').value='';$('agent-filter').value='';$('from').value='';$('to').value='';offset=0;runs();};
for(const button of document.querySelectorAll('.sort'))button.onclick=()=>{const key=button.dataset.sort;if(sort===key)dir=dir==='asc'?'desc':'asc';else{sort=key;dir=key==='started'?'desc':'asc';}offset=0;runs();};
$('more').onclick=()=>{if(!next)return;offset=Number(next);runs();};
$('prev').onclick=()=>{offset=Math.max(0,offset-25);runs();};
$('refresh').onclick=async()=>{if(refreshBusy)return;refreshBusy=true;$('refresh').disabled=true;try{offset=0;await runs();await keys().catch(e=>report(e));await usage();}finally{refreshBusy=false;$('refresh').disabled=busy;}};
$('approve').onsubmit=async event=>{event.preventDefault();const b=event.target.querySelector('button');b.disabled=true;try{await api('setup/approve',{user_code:$('code').value.trim()});$('approval').textContent='Approved. Your agent can now complete the one-time exchange.';toast('Agent approved.');$('code').value='';await keys();}catch(e){$('approval').textContent=explain(e);toast(explain(e));}finally{b.disabled=false;}};
async function logout(){exportJob?.abort();try{await api('auth/logout',{});location.replace('/app/');}catch(e){report(e);}}
$('logout').onclick=logout;$('logout-settings').onclick=logout;
$('menu-toggle').onclick=()=>menu(!$('rail').classList.contains('open'));
$('close-menu').onclick=()=>menu(false);
$('backdrop').onclick=()=>menu(false);
document.addEventListener('keydown',event=>{if(!$('rail').classList.contains('open'))return;if(event.key==='Escape'){event.preventDefault();menu(false);}if(event.key==='Tab'){const links=[...$('rail').querySelectorAll('a,button')].filter(node=>!node.hidden);const first=links[0],last=links.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}});
$('rail').addEventListener('click',event=>{const link=event.target.closest('a[href^="#"]');if(!link)return;event.preventDefault();location.hash=link.getAttribute('href');menu(false,false);showView({focus:true});});
narrow.addEventListener('change',()=>menu(false,false));menu(false,false);
addEventListener('hashchange',showView);
function showMfa(enrolled){$('mfa-enroll').hidden=enrolled;$('mfa-reenroll').hidden=!enrolled;$('mfa-disable').hidden=!enrolled;$('mfa-note').textContent=enrolled?'Two-factor authentication is on.':'Two-factor authentication is off.';$('mfa-code-form').hidden=true;$('mfa-confirm-form').hidden=true;}
function showSecret(result){$('mfa-secret').hidden=false;$('mfa-secret').textContent='Authenticator secret '+result.secret;$('mfa-confirm-form').hidden=false;$('mfa-new').value='';}
async function startEnroll(code){try{const result=await api('auth/mfa/enroll',code?{code}:{});$('mfa-code-form').hidden=true;showSecret(result);}catch(e){if(e.message==='mfa_required'||e.message==='invalid_code'){$('mfa-code-form').hidden=false;$('mfa-code-form').dataset.action='reenroll';$('mfa-note').textContent=explain({message:e.message,mfa:true});return;}report(e);}}
$('mfa-enroll').onclick=()=>startEnroll();
$('mfa-reenroll').onclick=()=>startEnroll();
$('mfa-code-form').onsubmit=async event=>{event.preventDefault();const action=$('mfa-code-form').dataset.action;const code=$('mfa-current').value;try{if(action==='disable'){await api('auth/mfa/disable',{code});$('mfa-secret').hidden=true;$('mfa-recovery').textContent='';showMfa(false);}else await startEnroll(code);}catch(err){$('mfa-note').textContent=explain({message:err.message,mfa:true});}};
$('mfa-disable').onclick=async()=>{try{await api('auth/mfa/disable',{});$('mfa-secret').hidden=true;$('mfa-recovery').textContent='';showMfa(false);}catch(e){if(e.message==='mfa_required'||e.message==='invalid_code'){$('mfa-code-form').hidden=false;$('mfa-code-form').dataset.action='disable';$('mfa-note').textContent=explain({message:e.message,mfa:true});return;}report(e);}};
$('mfa-confirm-form').onsubmit=async event=>{event.preventDefault();try{const result=await api('auth/mfa/confirm',{code:$('mfa-new').value});$('mfa-recovery').textContent='Recovery codes '+result.recovery_codes.join(' ');$('mfa-secret').hidden=true;showMfa(true);toast('Two-factor authentication is on.');}catch(err){$('mfa-note').textContent=explain({message:err.message,mfa:true});}};
showView();
try{const me=await api('me'),data=await api('projects');if(data.projects?.length!==1||data.projects[0].id!==me.project_id)throw new Error('project_unavailable');activeProject=data.projects[0].id;$('connect-command').textContent='python3 connect.py --project '+activeProject+' --config ./supatrace-access.json';$('project-name').textContent=data.projects[0].name+' · '+activeProject;$('project-line').textContent=data.projects[0].name+' · '+activeProject;$('who').textContent='Signed in as '+me.tenant_id;$('account-line').textContent='Signed in as '+me.tenant_id;$('status').textContent='';$('signed-out').hidden=true;document.body.classList.add('signed-in');$('shell').hidden=false;$('mfa-section').hidden=me.mfa_enabled!==true;if(me.mfa_enabled===true)showMfa(me.mfa===true);showView();await usage();await runs();await keys();}catch(e){const show=e.message==='sign_in_required';$('signed-out').hidden=!show;$('signin').hidden=!show;report(e);if(show){try{mountSignIn($('signin'),await api('auth/providers'));}catch{mountSignIn($('signin'),{github:true});}}}
