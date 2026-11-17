// Get-started card: after a publishable ingest key (st_pub_) is created, show runnable snippets with the key
// filled in and wait for the first trace. The snippets call the same /api/batches upload
// every client uses. Only publishable keys are retained in same-tab session storage until dismissal.
const storagePrefix='supatrace-first-trace:';
export function clearFirstTraceStorage(storage){
 try{storage??=globalThis.sessionStorage;for(let i=storage.length-1;i>=0;i--){const name=storage.key(i);if(name?.startsWith(storagePrefix))storage.removeItem(name);}}catch{/* Storage may be unavailable. */}
}
const fail=code=>{throw new Error(code);};
// The card issues a publishable ingest key (st_pub_ and 43 characters). Nothing else is filled into a snippet.
const SAFE=/^st_pub_[A-Za-z0-9_-]{43}$/,PROJECT=/^proj_[a-f0-9]{32}$/,ENVIRONMENT=/^[a-z][a-z0-9-]{0,31}$/,SUFFIX=/^[a-z0-9]{6,16}$/;
// A small synthetic chat call. No single quotes or backslashes, so it can sit inside
// single-quoted shell, Python and JavaScript strings unchanged.
export function sampleBatch({suffix,now}){
 if(!SUFFIX.test(suffix)||!Number.isFinite(now))fail('invalid_snippet_scope');
 const at=ms=>new Date(now+ms).toISOString();
 return {version:1,batch_id:'first-'+suffix,run_id:'first-trace-'+suffix,events:[
  {id:'request',time:at(0),kind:'request',name:'chat gpt-4o-mini',data:{span_id:'chat-1',attributes:{'gen_ai.operation.name':'chat','gen_ai.request.model':'gpt-4o-mini'},input:'Say hello (synthetic sample)'}},
  {id:'response',time:at(640),kind:'response',name:'chat gpt-4o-mini',data:{span_id:'chat-1',attributes:{'gen_ai.usage.input_tokens':9,'gen_ai.usage.output_tokens':12},output:'Hello from your first trace.'}}]};
}
export function buildSnippets({origin,projectId,environmentId='default',key,suffix,now}){
 let base;try{base=new URL(origin);}catch{fail('invalid_snippet_scope');}
 if(!['https:','http:'].includes(base.protocol)||base.origin!==origin||!PROJECT.test(projectId)||!ENVIRONMENT.test(environmentId)||!SAFE.test(key))fail('invalid_snippet_scope');
 const body=JSON.stringify(sampleBatch({suffix,now}));if(/['\\]/.test(body))fail('invalid_snippet_scope');
 const url=origin+'/api/batches?project='+projectId+(environmentId!=='default'?'&environment='+environmentId:'');
 return {
  curl:["BODY='"+body+"'","curl -sS -X POST '"+url+"' \\","  -H 'content-type: application/json' \\","  -H 'x-supatrace-key: "+key+"' \\",
   "  -H \"x-amz-content-sha256: $(printf %s \"$BODY\" | (sha256sum 2>/dev/null || shasum -a 256) | cut -d' ' -f1)\" \\","  --data-binary \"$BODY\""].join('\n'),
  python:['import hashlib, urllib.request',"body = '"+body+"'.encode()",'request = urllib.request.Request(',"    '"+url+"', data=body, method='POST',","    headers={'content-type': 'application/json', 'x-supatrace-key': '"+key+"',","             'x-amz-content-sha256': hashlib.sha256(body).hexdigest()})",'print(urllib.request.urlopen(request).read().decode())'].join('\n'),
  node:["import {createHash} from 'node:crypto';","const body = '"+body+"';","const response = await fetch('"+url+"', {method: 'POST', body,","  headers: {'content-type': 'application/json', 'x-supatrace-key': '"+key+"',","    'x-amz-content-sha256': createHash('sha256').update(body).digest('hex')}});",'console.log(response.status, await response.text());'].join('\n')
 };
}
const HOW={curl:'Paste into a terminal.',python:'Save as first_trace.py and run: python3 first_trace.py',node:'Save as first-trace.mjs and run: node first-trace.mjs (Node 18 or newer)'};
export function mountFirstTrace({document,origin,onOpen=()=>{},copy=null,now=()=>Date.now(),random=()=>Math.random().toString(36).slice(2,10).padEnd(8,'0'),storage}){
 try{storage??=globalThis.sessionStorage;}catch{/* Storage may be disabled. */}
 const $=id=>document.getElementById(id);
 // expected is the run id of the sample in the snippets; empty records whether the account had no traces at the last list load; null until the first load answers.
 let storageKey=null;
 let shown=null,tab='curl',keyAt=null,waiting=false,arrived=null,expected=null,empty=null;
 const paint=()=>{
  $('first-snippets').hidden=!shown;
  $('first-dismiss').hidden=!shown;
  $('first-key').hidden=!!shown;
  if(shown){$('first-snippet').textContent=shown[tab];$('first-how').textContent=HOW[tab];for(const name of Object.keys(HOW)){const button=$('first-tab-'+name);button.setAttribute('aria-selected',String(name===tab));}}
  else{$('first-snippet').textContent='';$('first-how').textContent='';}
  $('first-wait').hidden=!waiting&&!arrived;
  $('first-wait').textContent=arrived?'First trace received '+Math.max(1,Math.round((arrived.at-keyAt)/1000))+' s after the key was shown.':'Waiting for your first trace… It appears here when the upload is accepted.';
  $('first-open').hidden=!arrived;if(arrived)$('first-open').textContent='Open trace '+arrived.id;
 };
 for(const name of Object.keys(HOW))$('first-tab-'+name).onclick=()=>{tab=name;$('first-copy-note').textContent='';paint();};
 $('first-copy').onclick=async()=>{if(!shown)return;try{if(!copy)throw new Error('copy_unavailable');await copy(shown[tab]);$('first-copy-note').textContent='Copied. The snippet contains your key: do not paste it anywhere public.';}catch{$('first-copy-note').textContent='Copy is not available here. Select the snippet text and copy it.';}};
 $('first-open').onclick=()=>{if(arrived)onOpen(arrived.id);};
 const dismiss=()=>{try{if(storageKey)storage?.removeItem(storageKey);}catch{}shown=null;waiting=false;arrived=null;expected=null;keyAt=null;$('first-key-note').textContent='';$('first-trace').hidden=true;paint();};
 $('first-dismiss').onclick=dismiss;
 return {
  restore({account,project_id,environment_id='default'}){
   storageKey=storagePrefix+account+':'+project_id+':'+environment_id;
   try{const saved=JSON.parse(storage?.getItem(storageKey)??'null');if(saved&&saved.project_id===project_id&&saved.environment_id===environment_id&&SAFE.test(saved.key))this.keyCreated(saved);}catch{/* Invalid or unavailable storage does not block key creation. */}
  },
  // A key was just created in this session: fill the snippets. The wait starts only for an
  // account with no traces, which is the only time this card is on screen.
  keyCreated({key,project_id,environment_id,suffix=random(),created_at=now()}){
   try{shown=buildSnippets({origin,projectId:project_id,environmentId:environment_id??'default',key,suffix,now:created_at});}catch{shown=null;expected=null;waiting=false;$('first-key-note').textContent='The key was created, but snippets could not be prepared. Use the API keys page.';paint();return false;}
   expected='first-trace-'+suffix;keyAt=created_at;arrived=null;waiting=empty!==false;$('first-key-note').textContent='Ingest key created and filled into the snippets below. It can only send traces, and it does not expire: revoke it under API keys when you no longer need it. It stays in this tab until you dismiss it or sign out; anyone holding it can write traces to this project.';$('first-copy-note').textContent='';try{if(storageKey)storage?.setItem(storageKey,JSON.stringify({key,project_id,environment_id:environment_id??'default',suffix,created_at}));}catch{}paint();return true;
  },
  // Called after every list load with the unfiltered trace count and a lookup over the whole
  // catalog, so the result does not depend on the list's sort, filters or page. Only the
  // sample this card generated counts as the first trace; someone else's upload does not.
  traces(total,has){
   if(!Number.isSafeInteger(total)||total<0||typeof has!=='function')return;
   // A key made before the first list load waits provisionally: that load settles whether the account was empty.
   if(empty===null&&waiting&&total>0&&has(expected)!==true)waiting=false;
   empty=total===0;
   if(waiting&&expected!==null&&has(expected)===true){arrived={id:expected,at:now()};waiting=false;}
   $('first-trace').hidden=total>0&&!shown&&!waiting&&!arrived;paint();
  },
  get waiting(){return waiting;},
  reset(){shown=null;keyAt=null;waiting=false;arrived=null;expected=null;tab='curl';$('first-key-note').textContent='';$('first-copy-note').textContent='';paint();}
 };
}
