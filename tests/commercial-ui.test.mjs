import {loadAccountUsage} from '../public/app/usage-data.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
import {loadAccountRuns,queryAccountRuns} from '../public/app/run-data.js';
// app.js imports this to read a 402 body; the vm context below supplies each import the script uses.
import {entitlementMessage} from '../public/app/entitlements.js';

const html=readFileSync(new URL('../public/app/index.html',import.meta.url),'utf8');
const source=readFileSync(new URL('../public/app/app.js',import.meta.url),'utf8');
class Element {
 constructor(tag='div'){this.tagName=tag;this.children=[];this.dataset={};this.value='';this.hidden=false;this.disabled=false;this.attrs={};this._text='';const classes=new Set();this.classList={add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x),toggle:(x,on)=>on?classes.add(x):classes.delete(x)};}
 set textContent(value){this._text=String(value);this.children=[];}get textContent(){return this._text+this.children.map(child=>typeof child==='string'?child:child.textContent).join('');}
 set innerHTML(value){throw Error('Unsafe innerHTML assignment: '+value);}
 append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this._text='';this.children=[...nodes];}
 setAttribute(key,value){this.attrs[key]=String(value);}getAttribute(key){return this.attrs[key]??null;}removeAttribute(key){delete this.attrs[key];if(key==='href')delete this.href;}
 get options(){return this.children.filter(child=>child.tagName==='option');}querySelectorAll(){return [];}querySelector(){return new Element('h1');}addEventListener(){}focus(){}remove(){}matches(){return false;}
}
function app(fetcher=async()=>{throw Error('Unexpected fetch');},options={}){
 const nodes=new Map();for(const match of html.matchAll(/<([a-z][\w-]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)){const node=new Element(match[1]);node.hidden=/\bhidden(?:\s|>)/.test(match[0]);node.disabled=/\bdisabled(?:\s|>)/.test(match[0]);nodes.set(match[2],node);}
 const get=id=>{assert.ok(nodes.has(id),'App requested missing HTML element '+id);return nodes.get(id);};
 const document={getElementById:get,createElement:tag=>new Element(tag),querySelectorAll:()=>[],querySelector:()=>null,addEventListener(){},body:new Element('body')};
 const listeners=new Map(),assigned=[],calls=[];let randomCalls=0;
 const location={hash:'#billing',origin:'https://supatrace.dev',search:options.search||'',assign(url){assigned.push(url);},replace(){}};
 const storage=options.storage||new Map();
 const sessionStorage=options.sessionStorage||{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)};
 const context={sessionStorage,document,window:{matchMedia:()=>({matches:false,addEventListener(){}})},location,fetch:async(url,init)=>{calls.push({url,init,body:init.body&&JSON.parse(init.body)});return fetcher(url,init);},Response,URL,URLSearchParams,TextEncoder,Uint8Array,AbortController,crypto:{subtle:webcrypto.subtle,getRandomValues(array){randomCalls++;if(options.noRandom)throw Error('Unavailable');return webcrypto.getRandomValues(array);}},Blob,loadAccountUsage,loadAccountRuns,queryAccountRuns,entitlementMessage,setTimeout:()=>0,clearTimeout(){},addEventListener:(name,listener)=>listeners.set(name,listener)};
 let executable=source.replace(/^import[^\n]+\n/gm,'');executable=executable.slice(0,executable.lastIndexOf('\nshowView();'));
 executable+='\nactiveProject="proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";setCheckoutAccount("github-synthetic",activeProject);$("account-reload").hidden=true;globalThis.testApp={usage,loadCommercial,loadBillingStatus,showView,setCheckoutAccount,showCheckoutReturn,setScope:(role,environment,workspace)=>{activeRole=role;activeEnvironment=environment;activeWorkspace=workspace;},invalidateAccountIdentity};';
 Object.assign(context,{rememberSetupCode(){},pendingSetupCode:()=>null,clearSetupCode(){},clearFirstTraceStorage(){}});runInNewContext(executable,context);
 return {storage,a:context.testApp,get,calls,assigned,listeners,randomCalls:()=>randomCalls,setHash:hash=>{location.hash=hash;},choose:id=>{get('commercial-plan').value=id;get('commercial-plan').onchange();},submit:()=>get('commercial-form').onsubmit({preventDefault(){}})};
}
const projection=()=>({available:true,mode:'sandbox_preview',policy_version:'synthetic-v1',policy_hash:'a'.repeat(64),terms_url:'https://supatrace.dev/terms.html',plans:[{id:'synthetic-pro',name:'Synthetic Pro',price_id:'price_syntheticOne',unit_amount:200,currency:'usd',interval:'month',storage_limit_bytes:200000},{id:'synthetic-team',name:'Synthetic Team',price_id:'price_syntheticTwo',unit_amount:900,currency:'usd',interval:'month',storage_limit_bytes:900000}],paid_access:false,purchases_enabled:false});
const usage= commercial=>({storage:{used_bytes:5,limit_bytes:100,remaining_bytes:95},account_plan:{name:'Alpha',billing_status:'not_configured',paid_activation_enabled:false},billing:{sandbox:false,portal_available:false,purchases_enabled:false,paid_access:false},commercial});
const response=value=>new Response(JSON.stringify(value));
const checkout=()=>({session_id:'cs_test_Synthetic123',url:'https://checkout.stripe.com/c/pay/cs_test_Synthetic123#synthetic',livemode:false,status:'open',purchases_enabled:false});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
async function until(predicate){const deadline=Date.now()+2000;while(!predicate()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,1));assert.ok(predicate(),'Expected asynchronous request to start');}
function ready(ui,value=projection()){ui.a.loadCommercial(value);ui.choose(value.plans[0].id);}

test('actual Billing HTML is hidden and inaccessible by default, with labelled native controls and no inline code or style',()=>{
 const ui=app();assert.equal(ui.get('commercial-selector').hidden,true);assert.equal(ui.get('commercial-checkout').disabled,true);
 assert.match(html,/<label for="commercial-plan">Sandbox plan<\/label>/);assert.match(html,/id="commercial-form"[^>]+aria-describedby="commercial-disclaimer checkout-note"/);assert.match(html,/id="checkout-note"[^>]+role="status"/);
 assert.doesNotMatch(html,/\bon(?:click|submit|change)\s*=/i);assert.doesNotMatch(html,/<style\b|\bstyle\s*=/i);
});

test('unavailable and every malformed projection fail closed without invented plans or requests',async()=>{
 const cases=[undefined,null,{},false,[],{available:false,reason:'not_approved'}];
 const mutate=fn=>{const value=projection();fn(value);cases.push(value);};
 for(const [key,value] of [['available',false],['mode','live'],['paid_access',true],['purchases_enabled',true],['policy_version',''],['policy_hash','a'.repeat(63)],['policy_hash','g'.repeat(64)],['plans',[]],['plans',null],['terms_url','http://supatrace.dev/terms'],['terms_url','https://supatrace.dev.evil.invalid/terms'],['terms_url','https://supatrace.dev@evil.invalid/terms'],['terms_url','https://synthetic:synthetic@supatrace.dev/terms'],['terms_url','javascript:alert(1)']])mutate(p=>p[key]=value);
 for(const [key,value] of [['id',''],['name',''],['price_id','cus_wrong'],['unit_amount',-1],['unit_amount',1.5],['unit_amount',Number.MAX_SAFE_INTEGER+1],['currency','USD'],['currency','eur'],['currency','jpy'],['interval','year'],['storage_limit_bytes',0],['storage_limit_bytes','100']])mutate(p=>p.plans[0][key]=value);
 mutate(p=>p.plans[1].id=p.plans[0].id);mutate(p=>p.plans[1].price_id=p.plans[0].price_id);mutate(p=>p.plans=Array(21).fill(p.plans[0]));
 for(const value of cases){const ui=app();ui.a.loadCommercial(value);await ui.submit();assert.equal(ui.get('commercial-selector').hidden,true);assert.equal(ui.get('commercial-checkout').disabled,true);assert.equal(ui.calls.length,0);assert.equal(ui.get('commercial-plan').options.length,1);assert.equal(ui.get('commercial-terms').href,undefined);}
});

test('real Usage fetch renders only server projection via textContent, retaining the actual quota and Portal defaults',async()=>{
 const value=projection();value.plans[0].name='<img src=x onerror=alert(1)> Synthetic';const ui=app(async()=>response(usage(value)));await ui.a.usage();
 assert.equal(ui.calls[0].url,'/api/usage?project=proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');assert.equal(ui.get('commercial-selector').hidden,false);assert.equal(ui.get('commercial-checkout').disabled,true);
 assert.equal(ui.get('commercial-plan').options[1].textContent,value.plans[0].name);assert.equal(ui.get('commercial-plan').options[1].children.length,0);
 ui.choose('synthetic-pro');assert.match(ui.get('commercial-plan-detail').textContent,/\$2\.00 per month/);assert.match(ui.get('commercial-plan-detail').textContent,/200,000 bytes/);assert.match(ui.get('usage-page').textContent,/5 of 100 bytes/);assert.equal(ui.get('billing-portal').hidden,true);assert.equal(ui.get('commercial-terms').href,value.terms_url);
 assert.match(ui.get('commercial-policy').textContent,/does not establish commercial or provider approval/);
});

test('actual API posts only plan, policy and secure request ID; double submit cannot create a second request',async()=>{
 const pending=deferred(),ui=app(()=>pending.promise);ready(ui);const first=ui.submit();await ui.submit();await until(()=>ui.calls.length===1);
 const call=ui.calls[0];assert.equal(call.url,'/api/billing/checkout?project=proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');assert.equal(call.init.method,'POST');assert.equal(call.init.credentials,'same-origin');assert.equal(call.init.redirect,'error');assert.deepEqual(Object.keys(call.body).sort(),['plan_id','policy_version','request_id']);assert.match(call.body.request_id,/^checkout_test_[a-f0-9]{32}$/);assert.equal(call.body.plan_id,'synthetic-pro');assert.equal(call.body.policy_version,'synthetic-v1');assert.match(call.init.headers['x-amz-content-sha256'],/^[a-f0-9]{64}$/);assert.equal(ui.randomCalls(),1);assert.equal(ui.get('commercial-plan').disabled,true);
 pending.resolve(response(checkout()));await first;assert.equal(ui.assigned.length,1);assert.equal(ui.get('commercial-checkout').disabled,true);await ui.submit();assert.equal(ui.calls.length,1);
});

test('network/HTTP/invalid JSON failures remain uncertain and replay only the same request ID',async()=>{
 for(const failure of [()=>{throw Error('network');},()=>new Response('{bad json'),()=>new Response(JSON.stringify({error:'temporarily_unavailable'}),{status:503}),()=>new Response(JSON.stringify({error:'invalid_checkout_request'}),{status:400})]){
  let count=0;const ui=app(async()=>++count===1?failure():response(checkout()));ready(ui);await ui.submit();assert.equal(ui.assigned.length,0);assert.match(ui.get('checkout-note').textContent,/outcome could not be confirmed/);assert.equal(ui.get('commercial-checkout').disabled,false);
  ui.choose('synthetic-team');assert.equal(ui.get('commercial-plan').value,'synthetic-pro');await ui.submit();assert.equal(ui.calls.length,2);assert.deepEqual(ui.calls[1].body,ui.calls[0].body);assert.equal(ui.randomCalls(),1);assert.equal(ui.assigned.length,1);
 }
});

test('navigation aborts pending checkout; back/forward retry preserves request and late response cannot navigate',async()=>{
 const old=deferred();let count=0;const ui=app(()=>++count===1?old.promise:response(checkout()));ready(ui);const first=ui.submit();await until(()=>ui.calls.length===1);
 ui.setHash('#traces');ui.a.showView();assert.equal(ui.calls[0].init.signal.aborted,true);assert.match(ui.get('checkout-note').textContent,/may still exist/);ui.setHash('#billing');ui.a.showView();await ui.submit();assert.equal(ui.assigned.length,1);
 old.resolve(response({...checkout(),url:'https://checkout.stripe.com/late'}));await first;assert.equal(ui.assigned.length,1);assert.deepEqual(ui.calls[0].body,ui.calls[1].body);assert.equal(ui.randomCalls(),1);
});

test('changed location before hashchange event still rejects late navigation and allows only same request',async()=>{
 const pending=deferred(),ui=app(()=>pending.promise);ready(ui);const work=ui.submit();await until(()=>ui.calls.length===1);ui.setHash('#keys');pending.resolve(response(checkout()));await work;assert.equal(ui.assigned.length,0);assert.match(ui.get('checkout-note').textContent,/after navigation/);assert.equal(ui.get('commercial-plan').disabled,true);
});

test('pagehide abort and logout abort checkout without turning cancellation into success',async()=>{
 for(const kind of ['pagehide','logout']){const pending=deferred(),ui=app(url=>url.endsWith('auth/logout')?response({}):pending.promise);ready(ui);const work=ui.submit();await until(()=>ui.calls.length===1);if(kind==='pagehide')ui.listeners.get('pagehide')();else await ui.get('logout').onclick();assert.equal(ui.calls[0].init.signal.aborted,true);pending.resolve(response(checkout()));await work;assert.equal(ui.assigned.length,0);assert.match(ui.get('checkout-note').textContent,/interrupted/);}
});

test('policy version/hash/data changes block unresolved intents and ignore previous successful responses',async()=>{
 for(const alter of [p=>p.policy_version='synthetic-v2',p=>p.policy_hash='b'.repeat(64),p=>p.plans[0].unit_amount=201,p=>p.terms_url='https://supatrace.tech/terms.html',p=>p.available=false]){const pending=deferred(),ui=app(()=>pending.promise);ready(ui);const work=ui.submit();await until(()=>ui.calls.length===1);const changed=projection();alter(changed);ui.a.loadCommercial(changed);assert.equal(ui.calls[0].init.signal.aborted,true);assert.equal(ui.get('commercial-checkout').disabled,true);assert.match(ui.get('checkout-note').textContent,/Reconciliation is required/);pending.resolve(response(checkout()));await work;await ui.submit();assert.equal(ui.calls.length,1);assert.equal(ui.assigned.length,0);}
});

test('unchanged refresh preserves an uncertain request; unavailable projection does not hide reconciliation message',async()=>{
 const ui=app(async()=>{throw Error('network');});ready(ui);await ui.submit();ui.a.loadCommercial(projection());await ui.submit();assert.deepEqual(ui.calls[0].body,ui.calls[1].body);assert.equal(ui.randomCalls(),1);ui.a.loadCommercial({available:false});assert.equal(ui.get('commercial-selector').hidden,true);assert.equal(ui.get('checkout-note').hidden,false);assert.match(ui.get('checkout-note').textContent,/Reconciliation/);
});

test('rejects live, foreign, credential-bearing, protocol-relative and malformed checkout responses',async()=>{
 const values=[];for(const [key,value] of [['status','complete'],['status',undefined],['session_id','cs_live_wrong'],['session_id','cs_test_'],['purchases_enabled',true],['purchases_enabled',undefined],['livemode',true],['livemode',undefined],['url','http://checkout.stripe.com/pay'],['url','https://checkout.stripe.com.evil.invalid/pay'],['url','https://checkout.stripe.com@evil.invalid/pay'],['url','https://user:pass@checkout.stripe.com/pay'],['url','//checkout.stripe.com/pay'],['url','javascript:alert(1)'],['url','https://checkout.stripe.com:444/pay'],['url',' https://checkout.stripe.com/pay']])values.push({...checkout(),[key]:value});
 for(const value of values){const ui=app(async()=>response(value));ready(ui);await ui.submit();assert.equal(ui.assigned.length,0);assert.match(ui.get('checkout-note').textContent,/outcome could not be confirmed/);assert.equal(ui.get('commercial-plan').disabled,true);}
});

test('server reconciliation refusal after reload is honest, does not reset intent, and blocks repeated attempts',async()=>{
 for(const error of ['checkout_reconciliation_required','existing_checkout_intent','checkout_conflict']){const ui=app(async()=>new Response(JSON.stringify({error}),{status:409}));ready(ui);await ui.submit();assert.match(ui.get('checkout-note').textContent,/unresolved request from before a reload/);assert.match(ui.get('checkout-note').textContent,/ask the workspace operator/);assert.equal(ui.get('commercial-checkout').disabled,true);ui.a.loadCommercial(projection());await ui.submit();assert.equal(ui.calls.length,1);assert.equal(ui.randomCalls(),1);assert.equal(ui.assigned.length,0);}
});

test('usage races do not overwrite latest policy and current usage failure fails closed',async()=>{
 const reads=[],ui=app(()=>{const item=deferred();reads.push(item);return item.promise;});const older=ui.a.usage(),newer=ui.a.usage();const current=projection();current.policy_version='synthetic-v2';reads[1].resolve(response(usage(current)));await newer;reads[0].resolve(response(usage(projection())));await older;assert.match(ui.get('commercial-policy').textContent,/synthetic-v2/);
 const failure=ui.a.usage();reads[2].resolve(new Response(JSON.stringify({error:'temporarily_unavailable'}),{status:503}));await failure;assert.equal(ui.get('commercial-selector').hidden,true);assert.equal(ui.get('commercial-checkout').disabled,true);
});

test('secure randomness failure and submit outside Billing never send a request',async()=>{
 const ui=app(undefined,{noRandom:true});ready(ui);await ui.submit();assert.equal(ui.calls.length,0);assert.match(ui.get('checkout-note').textContent,/has not started/);
 const hidden=app();ready(hidden);hidden.setHash('#home');await hidden.submit();assert.equal(hidden.calls.length,0);
});

test('Portal still opens through its existing controls alongside a sandbox commercial preview',async()=>{
 const ui=app(async()=>response({url:'https://billing.stripe.com/p/session?secret=synthetic',sandbox:true,read_only:true,purchases_enabled:false}));ready(ui);await ui.a.loadBillingStatus({sandbox:true,portal_available:true,purchases_enabled:false,paid_access:false});await ui.get('billing-portal').onclick();assert.equal(ui.calls[0].url,'/api/billing/portal?project=proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');assert.deepEqual(ui.calls[0].body,{});assert.equal(ui.assigned[0],'https://billing.stripe.com/p/session?secret=synthetic');assert.equal(ui.get('commercial-selector').hidden,false);
});


test('the newer Portal or Checkout action cancels the older billing redirect',async()=>{
 for(const newer of ['portal','checkout']){
  const pending=deferred(),ui=app(url=>url.split('?')[0].endsWith(newer==='portal'?'checkout':'portal')?pending.promise:response(newer==='portal'?{url:'https://billing.stripe.com/p/session?secret=synthetic',sandbox:true,read_only:true,purchases_enabled:false}:checkout()));
  ready(ui);await ui.a.loadBillingStatus({sandbox:true,portal_available:true,purchases_enabled:false,paid_access:false});
  const old=newer==='portal'?ui.submit():ui.get('billing-portal').onclick();await until(()=>ui.calls.length===1);
  if(newer==='portal')await ui.get('billing-portal').onclick();else await ui.submit();
  assert.equal(ui.calls[0].init.signal.aborted,true);assert.equal(ui.assigned.length,1);
  pending.resolve(response(newer==='portal'?checkout():{url:'https://billing.stripe.com/p/late',sandbox:true,read_only:true,purchases_enabled:false}));await old;assert.equal(ui.assigned.length,1);
 }
});

test('live control status is distinct from sandbox Checkout and does not expose an unconfigured Portal',async()=>{const f=app(async()=>new Response(JSON.stringify({sandbox:false,commercial_controls:true,paid_access:true,portal_available:false,purchases_enabled:false,reason:'live_portal_transport_not_configured'})));await f.a.loadBillingStatus();assert.equal(f.get('billing-portal').hidden,true);assert.match(f.get('billing-note').textContent,/live billing controls are active/);assert.doesNotMatch(f.get('billing-note').textContent,/not activated/);});

test('reload recovers pending, uncertain and redirected attempts without sending or minting a request',async()=>{
 for(const outcome of ['pending','uncertain','ready']){
  const storage=new Map(),pending=deferred();
  const first=app(async()=>{
   const saved=JSON.parse([...storage.values()][0]);
   assert.equal(saved.status,'pending','request is saved before transport');
   if(outcome==='pending')return pending.promise;
   if(outcome==='uncertain')throw Error('connection lost');
   return response(checkout());
  },{storage});ready(first);const work=first.submit();await until(()=>first.calls.length===1);
  if(outcome!=='pending')await work;
  const recovered=app(async()=>response(checkout()),{storage});recovered.a.loadCommercial(projection());
  assert.equal(recovered.calls.length,0);assert.equal(recovered.randomCalls(),0);
  assert.equal(recovered.get('commercial-plan').value,'synthetic-pro');assert.equal(recovered.get('commercial-plan').disabled,true);
  assert.match(recovered.get('checkout-note').textContent,/Recovered this tab/);
  await recovered.submit();assert.deepEqual(recovered.calls[0].body,first.calls[0].body);assert.equal(recovered.randomCalls(),0);
  const saved=JSON.parse([...storage.values()][0]);assert.deepEqual(Object.keys(saved).sort(),['fingerprint','plan_id','policy_version','request_id','scope','status','version']);
  assert.doesNotMatch(JSON.stringify(saved),/cs_test_|checkout\.stripe\.com|secret|payment_status/);
  if(outcome==='pending'){first.listeners.get('pagehide')();pending.resolve(response(checkout()));await work;assert.equal(first.assigned.length,0);}
 }
});

test('409 reconciliation and policy changes remain blocked across reloads, even if the policy later returns',async()=>{
 for(const reason of ['server','policy']){
  const storage=new Map(),first=app(async()=>reason==='server'?new Response('{"error":"checkout_intent_expired_requires_reconciliation"}',{status:409}):Promise.reject(Error('lost')),{storage});
  ready(first);await first.submit();const original=first.calls[0].body;
  if(reason==='policy'){
   const changed=projection();changed.policy_hash='b'.repeat(64);
   const next=app(undefined,{storage});next.a.loadCommercial(changed);await next.submit();assert.equal(next.calls.length,0);
  }
  const recovered=app(undefined,{storage});recovered.a.loadCommercial(projection());await recovered.submit();
  assert.equal(recovered.calls.length,0);assert.equal(recovered.randomCalls(),0);assert.equal(recovered.get('commercial-checkout').disabled,true);
  assert.match(recovered.get('checkout-note').textContent,/reconciliation/);
  assert.equal(JSON.parse([...storage.values()][0]).request_id,original.request_id);
 }
});

test('only the verified account and project restore a saved attempt; copied foreign records fail closed',async()=>{
 const storage=new Map(),first=app(async()=>{throw Error('lost');},{storage});ready(first);await first.submit();
 const [key,raw]=[...storage.entries()][0];
 const own=app(undefined,{storage});own.a.setCheckoutAccount('github-other','proj_'+'a'.repeat(32));own.a.loadCommercial(projection());assert.equal(own.get('commercial-plan').disabled,false);assert.equal(own.get('commercial-plan').value,'');assert.equal(own.calls.length,0);
 const foreignKey=key.replace('github-synthetic','github-other');storage.set(foreignKey,raw);
 const foreign=app(undefined,{storage});foreign.a.setCheckoutAccount('github-other','proj_'+'a'.repeat(32));ready(foreign);await foreign.submit();assert.equal(foreign.calls.length,0);assert.equal(foreign.get('commercial-checkout').disabled,true);assert.equal(storage.get(key),raw);assert.equal(storage.get(foreignKey),raw);
 const changedProject=app(undefined,{storage});changedProject.a.setCheckoutAccount('github-synthetic','proj_'+'b'.repeat(32));ready(changedProject);await changedProject.submit();assert.equal(changedProject.calls.length,0);assert.equal(changedProject.get('commercial-checkout').disabled,true);
});

test('corrupt and oversized recovery records are retained for reconciliation and never overwritten by a new request',async()=>{
 const storage=new Map(),first=app(async()=>{throw Error('lost');},{storage});ready(first);await first.submit();const [key,raw]=[...storage.entries()][0];
 const malformed=['{','null','[]','x'.repeat(32769)];
 for(const patch of [{version:2},{status:'paid'},{request_id:'checkout_test_short'},{plan_id:'<script>'},{policy_version:''},{fingerprint:42},{url:'https://checkout.stripe.com/secret'}])malformed.push(JSON.stringify({...JSON.parse(raw),...patch}));
 for(const record of malformed){const damaged=new Map([[key,record]]),ui=app(undefined,{storage:damaged});ready(ui);await ui.submit();assert.equal(ui.calls.length,0);assert.equal(ui.randomCalls(),0);assert.equal(ui.get('commercial-checkout').disabled,true);assert.equal(damaged.get(key),record);assert.match(ui.get('checkout-note').textContent,/could not safely read or save/);}
});

test('unavailable storage, write failures and unconfirmed writes prevent a new Checkout POST',async()=>{
 const unavailable=()=>{throw Error('storage denied');};
 for(const sessionStorage of [{getItem:unavailable,setItem:unavailable},{getItem:()=>null,setItem:unavailable},{getItem:()=>null,setItem(){}}]){
  const ui=app(undefined,{sessionStorage});ready(ui);await ui.submit();assert.equal(ui.calls.length,0);assert.equal(ui.get('commercial-checkout').disabled,true);assert.match(ui.get('checkout-note').textContent,/No new request will be sent/);
 }
});

test('default-off billing never reads tab storage and return hints never confirm payment or automatically retry',async()=>{
 const sessionStorage={getItem(){assert.fail('default-off storage read');},setItem(){assert.fail('default-off storage write');}};
 for(const billing of ['success','cancelled']){
  const ui=app(undefined,{sessionStorage,search:'?billing='+billing+'&session_id=cs_test_UNTRUSTED'});ui.setHash('');ui.a.loadCommercial({available:false});ui.a.showCheckoutReturn();await ui.submit();
  assert.equal(ui.calls.length,0);assert.equal(ui.assigned.length,0);assert.equal(ui.get('commercial-selector').hidden,true);assert.match(ui.get('checkout-note').textContent,/does not confirm payment/);assert.doesNotMatch(ui.get('checkout-note').textContent,/cs_test_UNTRUSTED/);
 }
});


test('Billing owns each management element once; Usage remains capacity and a real Billing link',()=>{
 const billing=html.slice(html.indexOf('<section id="view-billing"'),html.indexOf('<section id="view-settings"'));
 const usageSection=html.slice(html.indexOf('<section id="view-usage"'),html.indexOf('<section id="view-billing"'));
 assert.match(html, /href="#billing" data-nav="billing"/);assert.match(billing, /<h1 id="billing-title">Billing<\/h1>/);
 for(const id of ['billing-controls','plan-page','commercial-selector','billing-refresh','billing-cancel','billing-action-cancel']){assert.equal([...html.matchAll(new RegExp('id="'+id+'"','g'))].length,1);assert.ok(billing.includes('id="'+id+'"'));assert.ok(!usageSection.includes('id="'+id+'"'));}
 assert.match(usageSection, /See plans/);assert.match(usageSection, /This is not a bill/);assert.match(billing, /Payments and invoices/);
});
test('default-off catalog and runtime are actionable without invented plans, cards or invoices',async()=>{
 for(const reason of ['billing_disabled','billing_runtime_unavailable']){
  const value=usage({available:false});value.billing.reason=reason;const ui=app(async()=>response(value));await ui.a.usage();
  assert.equal(ui.get('billing-availability').hidden,false);assert.match(ui.get('billing-availability-note').textContent,/^Plans, prices and upgrade are in the Plans card at the top of this page\.$/);
  assert.match(ui.get('billing-management').textContent,/Payments are processed by Stripe/);assert.equal(ui.get('commercial-selector').hidden,true);assert.equal(ui.get('billing-portal').hidden,true);
  assert.doesNotMatch(ui.get('billing-management').textContent,/on file|paid invoice|subscription active/i);assert.equal(ui.calls.length,1);
 }
});
test('member and nondefault billing expose guidance only, even with a valid catalog in the response',async()=>{
 for(const [role,environment,pattern] of [['viewer','default',/workspace owner/],['admin','default',/workspace owner/],['owner','development',/Environment selector.*Default/]]){
  const ui=app(async()=>response(usage(projection())));ui.a.setScope(role,environment,'github-4242');await ui.a.usage();ui.choose('synthetic-pro');await ui.submit();await ui.get('billing-portal').onclick();
  assert.equal(ui.get('commercial-selector').hidden,true);assert.equal(ui.get('billing-portal').hidden,true);assert.match(ui.get('billing-note').textContent,pattern);assert.equal(ui.calls.length,1);
  assert.equal(new URL(ui.calls[0].url,'https://example.test').searchParams.get('workspace'),'github-4242');
 }
});
test('Billing refresh and cancel fence late responses, clear both pages, and permit explicit read-only retry',async()=>{
 const pending=deferred();let reads=0;const ui=app(async()=>++reads===1?pending.promise:response(usage(null)));const old=ui.get('billing-refresh').onclick();
 assert.equal(ui.get('billing-refresh').disabled,true);assert.equal(ui.get('billing-summary').getAttribute('aria-busy'),'true');await ui.get('billing-refresh').onclick();assert.equal(reads,1);
 ui.get('billing-cancel').onclick();await old;assert.equal(ui.get('billing-summary').getAttribute('aria-busy'),'false');assert.match(ui.get('billing-availability-note').textContent,/unknown.*Retry billing/);
 await ui.get('billing-refresh').onclick();pending.resolve(response({}));await Promise.resolve();assert.match(ui.get('usage-page').textContent,/5 of 100/);assert.match(ui.get('plan-page').textContent,/Alpha/);assert.equal(ui.calls.length,2);
});
test('explicit cancel opening preserves Checkout identity and suppresses late Portal or Checkout navigation',async()=>{
 for(const kind of ['checkout','portal']){
  const pending=deferred(),ui=app(()=>pending.promise);ready(ui);await ui.a.loadBillingStatus({sandbox:true,portal_available:true,purchases_enabled:false,paid_access:false});
  const old=kind==='checkout'?ui.submit():ui.get('billing-portal').onclick();await until(()=>ui.calls.length===1);assert.equal(ui.get('billing-action-cancel').hidden,false);ui.get('billing-action-cancel').onclick();assert.equal(ui.calls[0].init.signal.aborted,true);
  pending.resolve(response(kind==='checkout'?checkout():{url:'https://billing.stripe.com/p/test',sandbox:true,read_only:true,purchases_enabled:false}));await old;assert.equal(ui.assigned.length,0);assert.equal(ui.get('billing-action-cancel').hidden,true);
  if(kind==='checkout'){assert.equal(JSON.parse([...ui.storage.values()][0]).status,'uncertain');assert.match(ui.get('checkout-note').textContent,/Return to Billing/);}else assert.match(ui.get('billing-note').textContent,/cancelled/);
 }
});
test('legacy success/cancel return hashes route to Billing without trusting session or payment claims',()=>{
 for(const result of ['success','cancelled'])for(const hash of ['','#usage','#billing']){
  const ui=app(undefined,{search:'?billing='+result+'&session_id=cs_test_fake&payment_status=paid'});ui.setHash(hash);ui.a.showCheckoutReturn();ui.a.showView();assert.match(ui.get('checkout-note').textContent,/does not confirm payment/);assert.doesNotMatch(ui.get('checkout-note').textContent,/cs_test_fake|payment_status/);assert.equal(ui.calls.length,0);
 }
 const ui=app(undefined,{search:'?billing=success'});ui.setHash('#traces');ui.a.showCheckoutReturn();assert.equal(ui.get('checkout-note').hidden,true);
});
test('permission/session revocation clears stale Billing and Usage and blocks further mutations until identity reload',async()=>{
 for(const [status,error] of [[401,'sign_in_required'],[403,'workspace_owner_required'],[409,'billing_scope_changed']]){
  const ui=app(async url=>url.includes('/usage')?response(usage(projection())):new Response(JSON.stringify({error}),{status}));await ui.a.usage();ui.choose('synthetic-pro');await ui.submit();
  assert.equal(ui.get('commercial-checkout').disabled,true);assert.equal(ui.get('billing-portal').hidden,true);assert.equal(ui.get('plan-meta').textContent,'');assert.match(ui.get('usage-page').textContent,/identity.*permission.*Reload/);assert.match(ui.get('plan-page').textContent,/unavailable/);const count=ui.calls.length;await ui.submit();assert.equal(ui.calls.length,count);
 }
});

test('identity invalidation aborts pending Portal and rejects its late success',async()=>{const pending=deferred(),ui=app(()=>pending.promise);await ui.a.loadBillingStatus({sandbox:true,portal_available:true,purchases_enabled:false,paid_access:false});const old=ui.get('billing-portal').onclick();await until(()=>ui.calls.length===1);ui.a.invalidateAccountIdentity();assert.equal(ui.calls[0].init.signal.aborted,true);pending.resolve(response({url:'https://billing.stripe.com/p/stale',sandbox:true,read_only:true,purchases_enabled:false}));await old;assert.deepEqual(ui.assigned,[]);assert.equal(ui.get('billing-portal').hidden,true);});
