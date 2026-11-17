import {readFileSync} from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
import test from 'node:test';import assert from 'node:assert/strict';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {buildSnippets,sampleBatch,mountFirstTrace,clearFirstTraceStorage} from '../public/app/first-trace.js';
import {parseBatch} from '../src/trace.mjs';import {alphaProject} from '../src/alpha-projects.mjs';import {start} from './harness.mjs';
const key='st_pub_'+'k'.repeat(43),projectId='proj_'+'a'.repeat(32),scope={origin:'https://supatrace.dev',projectId,key,suffix:'abc123',now:Date.parse('2026-11-14T00:00:00Z')};
test('the sample is a valid intake batch that quotes safely into shell, Python and JavaScript strings',()=>{
 const batch=sampleBatch(scope),raw=JSON.stringify(batch);assert.doesNotThrow(()=>parseBatch(raw));assert.doesNotMatch(raw,/['\\]/);
 assert.equal(batch.batch_id,'first-abc123');assert.equal(batch.run_id,'first-trace-abc123');assert.equal(batch.events.length,2);
});
test('snippets carry the exact endpoint, project, environment and key; hostile scope builds nothing',()=>{
 const s=buildSnippets(scope);for(const text of Object.values(s)){assert.ok(text.includes("https://supatrace.dev/api/batches?project="+projectId));assert.ok(text.includes(key));assert.ok(text.includes('x-amz-content-sha256'));assert.equal(text.includes('&environment='),false);}
 assert.ok(buildSnippets({...scope,environmentId:'staging'}).curl.includes('?project='+projectId+'&environment=staging'));
 for(const bad of [{origin:'javascript:alert(1)'},{origin:'https://supatrace.dev/path'},{origin:"https://x.dev';rm -rf"},{projectId:"proj_x'"},{environmentId:"a'b"},{environmentId:'A'},{key:"k'".padEnd(43,'k')},{key:'short'},{key:'$(id)'.padEnd(43,'k')},{suffix:"a'b"},{suffix:''},{now:NaN}])assert.throws(()=>buildSnippets({...scope,...bad}),/invalid_snippet_scope/);
});
// The real proof: each snippet, run exactly as shown, is accepted by the upload API.
test('curl, Python and Node snippets are each accepted by the local server as written',{timeout:60000},async()=>{
 const live=await start();
 try{
  const {tenant_id}=await live.store.getOrCreateTenant(9191),project=alphaProject(tenant_id).id;
  // The key the card issues: a publishable ingest key with no expiry, created through the store method behind POST /api/keys/create.
  const writeKey='st_pub_'+randomBytes(32).toString('base64url'),made=await live.store.createApiKey(tenant_id,{key_hash:createHash('sha256').update(writeKey).digest('hex'),key_type:'publishable'});assert.equal(made.no_expiry,true);
  // A setup-code key (43 characters, no prefix) is not what the card fills in.
  assert.throws(()=>buildSnippets({origin:live.origin,projectId:project,key:'k'.repeat(43),suffix:'abc123',now:Date.now()}),/invalid_snippet_scope/);
  // The server lives in this process, so the snippet must run without blocking the event loop.
  const run=async(name,suffix,command,args)=>{const snippet=buildSnippets({origin:live.origin,projectId:project,key:writeKey,suffix,now:Date.now()})[name];const {stdout}=await promisify(execFile)(command,[...args,snippet],{encoding:'utf8',timeout:20000});assert.match(stdout,/"accepted":true/,name);assert.ok(stdout.includes('first-'+suffix),name);};
  await run('curl','curlaa1','bash',['-c']);await run('python','pyaaaa1','python3',['-c']);await run('node','nodeaa1',process.execPath,['--input-type=module','-e']);
  const listed=await live.store.listRuns(tenant_id,{cursor:null,limit:100});assert.deepEqual(listed.items.map(row=>row.run_id||row.id).sort(),['first-trace-curlaa1','first-trace-nodeaa1','first-trace-pyaaaa1']);
 }finally{await live.close();}
});
// Minimal DOM for the card's state machine.
class Node{constructor(){this.hidden=false;this.textContent='';this.attrs={};this.onclick=null;}setAttribute(k,v){this.attrs[k]=String(v);}}
function card(options={}){const nodes=new Map(),get=id=>{if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id);};let clock=1000;const opened=[];
 const view=mountFirstTrace({document:{getElementById:get},origin:'https://supatrace.dev',onOpen:id=>opened.push(id),now:()=>clock,random:()=>'abc12345',...options});return {view,get,opened,tick:ms=>clock+=ms};}
const none=()=>false;
test('card: no key means no wait; a created key fills snippets and waits; only the generated sample flips it',()=>{
 const c=card();c.view.traces(0,none);assert.equal(c.get('first-trace').hidden,false);assert.equal(c.get('first-wait').hidden,true);assert.equal(c.get('first-snippets').hidden,true);
 assert.equal(c.view.keyCreated({key,project_id:projectId}),true);assert.equal(c.get('first-snippets').hidden,false);assert.ok(c.get('first-snippet').textContent.includes(key));assert.ok(c.get('first-snippet').textContent.includes('first-trace-abc12345'));assert.match(c.get('first-wait').textContent,/^Waiting for your first trace/);assert.equal(c.get('first-wait').hidden,false);assert.equal(c.get('first-open').hidden,true);
 c.get('first-tab-python').onclick();assert.match(c.get('first-snippet').textContent,/^import hashlib/);assert.equal(c.get('first-tab-python').attrs['aria-selected'],'true');assert.equal(c.get('first-tab-curl').attrs['aria-selected'],'false');
 c.view.traces(0,none);assert.equal(c.view.waiting,true);
 // Another writer's trace arrives first: the card stays on screen, still waiting for its own sample.
 c.tick(5000);c.view.traces(1,id=>id==='someone-elses-run');assert.equal(c.view.waiting,true);assert.equal(c.get('first-trace').hidden,false);assert.equal(c.get('first-open').hidden,true);assert.match(c.get('first-wait').textContent,/^Waiting/);
 c.tick(37000);c.view.traces(2,id=>id==='first-trace-abc12345');
 assert.equal(c.get('first-trace').hidden,false);assert.equal(c.get('first-wait').textContent,'First trace received 42 s after the key was shown.');assert.equal(c.get('first-open').textContent,'Open trace first-trace-abc12345');c.get('first-open').onclick();assert.deepEqual(c.opened,['first-trace-abc12345']);
 c.view.traces(3,none);assert.equal(c.get('first-trace').hidden,false);assert.equal(c.get('first-open').textContent,'Open trace first-trace-abc12345');
});
test('card: an account with traces has no card until it creates a key; reset clears the key from the page',async()=>{
 const c=card();c.view.traces(3,()=>true);assert.equal(c.get('first-trace').hidden,true);
 // Key created from the API keys page on an account that already has traces: no wait, snippets stay visible, an old trace is never claimed.
 c.view.keyCreated({key,project_id:projectId});assert.equal(c.view.waiting,false);c.view.traces(3,()=>true);assert.equal(c.get('first-trace').hidden,false);assert.equal(c.get('first-open').hidden,true);
 for(const bad of [[-1,none],[1.5,none],[0,null],['0',none]])assert.doesNotThrow(()=>c.view.traces(...bad));
 const copied=[],d=card({copy:async text=>{copied.push(text);}});d.view.traces(0,none);d.view.keyCreated({key,project_id:projectId,environment_id:'staging'});await d.get('first-copy').onclick();assert.equal(copied.length,1);assert.ok(copied[0].includes('&environment=staging'));assert.match(d.get('first-copy-note').textContent,/^Copied\./);
 d.view.reset();assert.equal(d.get('first-snippet').textContent,'');assert.equal(d.get('first-snippets').hidden,true);assert.equal(d.view.waiting,false);await d.get('first-copy').onclick();assert.equal(copied.length,1);
 // After a reset the old sample no longer counts.
 d.view.traces(1,id=>id==='first-trace-abc12345');assert.equal(d.get('first-open').hidden,true);
 const e=card();e.view.traces(0,none);assert.equal(e.view.keyCreated({key:'bad',project_id:projectId}),false);assert.equal(e.get('first-snippets').hidden,true);assert.equal(e.view.waiting,false);assert.match(e.get('first-key-note').textContent,/snippets could not be prepared/);
 e.view.keyCreated({key,project_id:projectId});await e.get('first-copy').onclick();assert.match(e.get('first-copy-note').textContent,/^Copy is not available/);
});
test('card: a key created before the first list load still waits and flips when the sample arrives',()=>{
 const c=card();assert.equal(c.view.keyCreated({key,project_id:projectId}),true);assert.equal(c.view.waiting,true);
 c.view.traces(0,none);assert.equal(c.view.waiting,true);assert.equal(c.get('first-wait').hidden,false);
 c.tick(4000);c.view.traces(1,id=>id==='first-trace-abc12345');
 assert.equal(c.view.waiting,false);assert.equal(c.get('first-trace').hidden,false);assert.equal(c.get('first-open').hidden,false);assert.equal(c.get('first-open').textContent,'Open trace first-trace-abc12345');
});
test('card: a key created before the first list load stops waiting but retains snippets when that load shows existing traces',()=>{
 const c=card();assert.equal(c.view.keyCreated({key,project_id:projectId}),true);
 c.view.traces(3,id=>id==='older-run');assert.equal(c.view.waiting,false);assert.equal(c.get('first-trace').hidden,false);
});

test('a pending Home key request is dropped when the identity is cleared, the session ends or the page is left',()=>{
 const app=readFileSync(new URL('../public/app/app.js',import.meta.url),'utf8');
 // The cleanup every invalidation and sign-out path runs forgets the pending request, so its late answer fails the handler's current() check.
 assert.match(app,/function clearKeyAttempt\(\)\{clearApiKeyValue\(\);firstTrace\?\.reset\(\);firstKeyAttempt=null;/);
 assert.match(app,/function invalidateAccountIdentity\(\)\{clearAccountDownload\(\);clearKeyAttempt\(\);/);assert.match(app,/async function logout\(\)\{if\(keySigningOut\)return;keySigningOut=true;stopLive\(\);clearKeyAttempt\(\);/);
 assert.match(app,/'pagehide',\(\)=>\{firstKeyAttempt=null;firstTrace\?\.reset\(\);\}/);
 assert.match(app,/const current=\(\)=>firstKeyAttempt===attempt&&keyIdentity\(\)===identity&&!keySigningOut&&!keySuspended;/);
});

function memoryStorage(){const data=new Map();return {get length(){return data.size;},key:i=>[...data.keys()][i],getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};}
test('publishable snippets survive reload only for the account, project and environment; dismissal and sign-out clear them',()=>{
 const storage=memoryStorage(),scope={account:'own-account',project_id:projectId,environment_id:'default'};
 const c=card({storage});c.view.restore(scope);c.view.keyCreated({key,project_id:projectId});const snippet=c.get('first-snippet').textContent;
 assert.equal(storage.length,1);
 for(const other of [{...scope,account:'other'},{...scope,project_id:'proj_'+'b'.repeat(32)},{...scope,environment_id:'staging'}]){const d=card({storage});d.view.restore(other);assert.equal(d.get('first-snippet').textContent,'');}
 c.view.reset();const d=card({storage});d.view.restore(scope);d.view.traces(1,()=>true);assert.equal(d.get('first-snippet').textContent,snippet);assert.equal(d.get('first-trace').hidden,false);
 d.get('first-dismiss').onclick();assert.equal(storage.length,0);assert.equal(d.get('first-snippet').textContent,'');
 d.view.keyCreated({key:'st_sec_'+'k'.repeat(43),project_id:projectId});assert.equal(storage.length,0);
 d.view.keyCreated({key,project_id:projectId});storage.setItem('unrelated','retained');clearFirstTraceStorage(storage);assert.equal(storage.length,1);assert.equal(storage.getItem('unrelated'),'retained');
});
