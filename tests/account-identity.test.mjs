import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {handle} from '../src/aws-api.mjs';
import {digest} from '../src/aws-auth.mjs';
import {DynamoMetadataStore} from '../src/dynamodb-store.mjs';
import {MemoryDynamo,commandClasses} from './memory-dynamo.mjs';
import {alphaProject} from '../src/alpha-projects.mjs';
const origin='https://supatrace.dev',token='i'.repeat(43),other='j'.repeat(43);
async function fixture(provider='google'){
 const client=new MemoryDynamo(),store=new DynamoMetadataStore({client,commands:commandClasses(),tableName:'synthetic'});
 const row=provider==='email'?await store.createVerifiedEmailAccount('own@example.com','synthetic-password-hash-only'):provider==='google'?await store.getOrCreateGoogleTenant('synthetic-subject'):await store.getOrCreateTenant(42);
 const foreign=await store.getOrCreateGoogleTenant('different-synthetic-subject');
 await store.createSession(digest(token),row.tenant_id);await store.createSession(digest(other),foreign.tenant_id);
 const env={ENABLED:true,APP_ORIGIN:origin,GITHUB_CLIENT_ID:'synthetic',GITHUB_CLIENT_SECRET:'synthetic-only',store,objects:{}};
 const read=(path='/api/me',session=token)=>handle(new Request(origin+path,{headers:session?{cookie:'__Host-supatrace='+session}:{}}),env);
 return {client,store,row,foreign,env,read};
}
for(const provider of ['github','google'])test('authenticated '+provider+' identity projects the stored provider without leaking tenant fields',async()=>{
 const f=await fixture(provider),get=f.store.getTenant.bind(f.store);
 f.store.getTenant=async id=>({...await get(id),email:'private@example.invalid',google_subject:'private-subject',mfa_secret:'private-mfa-secret',recovery_hashes:['private-recovery'],password_hash:'private-hash',session_token:'private-session'});
 const response=await f.read(),value=await response.json();assert.equal(response.status,200);
 assert.deepEqual(value,{tenant_id:f.row.tenant_id,project_id:alphaProject(f.row.tenant_id).id,auth_provider:provider,mfa:false,mfa_enabled:false});
 assert.doesNotMatch(JSON.stringify(value),/private|subject|email|secret|hash|token/);assert.equal(response.headers.get('cache-control'),'no-store');
});
test('provider projection does not infer or echo missing, unknown or mismatched provider fields',async()=>{
 const f=await fixture(),base=f.row;
 for(const row of [null,{...base,provider:undefined},{...base,provider:'private-unknown-provider'},{...base,provider:'github'},{...base,tenant_id:f.foreign.tenant_id}, {...base,provider:{toString:()=> 'google'}}]){
  f.store.getTenant=async()=>row;const response=await f.read();assert.equal(response.status,200);const value=await response.json();assert.equal(value.auth_provider,null);assert.equal(value.tenant_id,base.tenant_id);assert.doesNotMatch(JSON.stringify(value),/private-unknown/);
 }
});
test('identity remains session scoped; no session, write key, foreign project or client-selected provider can change it',async()=>{
 const f=await fixture();assert.equal((await f.read('/api/me',null)).status,401);
 const keyResponse=await handle(new Request(origin+'/api/me',{headers:{'x-supatrace-key':token}}),f.env);assert.equal(keyResponse.status,401);
 assert.equal((await f.read('/api/me?project='+alphaProject(f.foreign.tenant_id).id)).status,403);
 const value=await(await f.read('/api/me?provider=github&tenant_id='+f.foreign.tenant_id)).json();assert.equal(value.auth_provider,'google');assert.equal(value.tenant_id,f.row.tenant_id);
 const foreign=await(await f.read('/api/me',other)).json();assert.equal(foreign.tenant_id,f.foreign.tenant_id);assert.notEqual(foreign.project_id,value.project_id);
});
test('existing MFA flag semantics remain unchanged and provider display does not enable authentication features',async()=>{
 const f=await fixture(),base=await f.store.getTenant(f.row.tenant_id);f.store.getTenant=async()=>({...base,mfa_secret:'synthetic-only'});
 for(const enabled of [false,true]){f.env.MFA_ENABLED=enabled;const value=await(await f.read()).json();assert.equal(value.mfa_enabled,enabled);assert.equal(value.mfa,enabled);assert.equal(value.auth_provider,'google');}
 const flags=await(await f.read('/api/auth/providers',null)).json();assert.equal(flags.google,false);assert.equal(flags.email,false);assert.equal(flags.sso,false);assert.equal(flags.chatgpt,false);
});
const source=readFileSync(new URL('../public/app/app.js',import.meta.url),'utf8'),html=readFileSync(new URL('../public/app/index.html',import.meta.url),'utf8');
function ui(){
 const nodes=new Map(['copy-account-id','copy-project-id','provider-line','account-sign-in-note','who','account-line','project-name','project-line','account-reload','download-account','discard-account','workspace-export-reviewed','status','billing-portal'].map(id=>[id,{textContent:''}]));
 const start=source.indexOf('function renderAccountIdentity('),end=source.indexOf('function dash(',start);assert.ok(start>=0&&end>start);
 let langsmithInvalidations=0,braintrustInvalidations=0,consentInvalidations=0,keyAttemptClears=0,billingCancels=0,usageStops=0;
 const context={cancelBillingRedirect(){billingCancels++;},stopUsage(){usageStops++;},importConsent:{invalidate(){consentInvalidations++;}},workspaceExportScope:{project:'pinned-project'},syncExportControls(){},braintrustImport:{invalidate(){braintrustInvalidations++;}},langsmithImport:{invalidate(){langsmithInvalidations++;}},setCheckoutAccount(){},clearKeyAttempt(){keyAttemptClears++;},cancelCommercialCheckout(){},paintCommercialControls(){},checkoutRecoveryKey:null,activeEnvironment:'default',activeProject:'pinned-project',accountDownloadDraft:{synthetic:true},$:id=>{assert.ok(nodes.has(id));return nodes.get(id);}};
 const clearStart=source.indexOf('function clearAccountDownload('),clearEnd=source.indexOf("$('export-account').onclick",clearStart);assert.ok(clearStart>=0&&clearEnd>clearStart);
 runInNewContext(source.slice(clearStart,clearEnd)+source.slice(start,end)+';globalThis.ui={renderAccountIdentity,clearAccountIdentity,invalidateAccountIdentity};',context);
 return {...context.ui,billingCancels:()=>billingCancels,usageStops:()=>usageStops,consentInvalidations:()=>consentInvalidations,braintrustInvalidations:()=>braintrustInvalidations,langsmithInvalidations:()=>langsmithInvalidations,keyAttemptClears:()=>keyAttemptClears,text:id=>nodes.get(id).textContent,hidden:id=>nodes.get(id).hidden,context};
}
test('actual identity renderer shows explicit provider, account and workspace without interpreting markup',()=>{
 const f=ui(),project={id:'proj_'+'a'.repeat(32),name:'<img src=x onerror=alert(1)>'};
 f.renderAccountIdentity({auth_provider:'google',tenant_id:'google-synthetic'},project);
 assert.equal(f.text('provider-line'),'Sign-in provider: Google');assert.equal(f.text('account-line'),'Account');
 assert.equal(f.text('project-line'),'Workspace: '+project.name);assert.equal(f.text('who'),'Signed in with Google');
 assert.doesNotMatch(source.slice(source.indexOf('function renderAccountIdentity('),source.indexOf('function dash(')),/innerHTML|insertAdjacentHTML|fetch|localStorage|sessionStorage/);
});
test('unknown and prototype-looking providers stay unknown rather than guessing from an account id',()=>{
 const f=ui();for(const provider of [undefined,null,'constructor','__proto__','<script>','unknown',{}]){
  f.renderAccountIdentity({auth_provider:provider,tenant_id:'google-synthetic'},{id:'project',name:'Default project'});
  assert.equal(f.text('account-sign-in-note'),'This account signs in with SSO or another method. Use the same sign-in method and account. Ask your sign-in provider to restore access if needed.');
  assert.match(f.text('provider-line'),/Sign-in provider: not shown/);assert.doesNotMatch(f.text('provider-line'),/Sign-in provider: Google|constructor|script/);
 }
});
test('provider/account changes replace old identity and confirmed logout clears all rendered identity fields',()=>{
 const f=ui();f.renderAccountIdentity({auth_provider:'google',tenant_id:'old-account'},{id:'old-project',name:'Old'});
 f.renderAccountIdentity({auth_provider:'github',tenant_id:'new-account'},{id:'new-project',name:'New'});
 for(const id of ['provider-line','account-sign-in-note','who','account-line','project-name','project-line'])assert.doesNotMatch(f.text(id),/old-account|old-project|Old|Google/);
 f.clearAccountIdentity();assert.equal(f.billingCancels(),1);assert.equal(f.hidden('billing-portal'),true);assert.equal(f.context.billingReady,false);assert.equal(f.consentInvalidations(),1);assert.equal(f.context.workspaceExportScope,null);assert.equal(f.langsmithInvalidations(),1);assert.equal(f.braintrustInvalidations(),1);for(const id of ['provider-line','account-sign-in-note','who','account-line','project-name','project-line'])assert.equal(f.text(id),'');
 assert.match(source,/await api\('auth\/logout',\{\}\);activeProject=null;resetKeyState\(\);clearAccountIdentity\(\);location.replace/);
 assert.match(source,/renderAccountIdentity\(me,chosen\)/);
});
test('one account recovery block stays inside authenticated Settings without direct sign-in links',()=>{
 const settings=html.slice(html.indexOf('<section id="view-settings"'));assert.match(settings,/<p id="provider-line" role="status"><\/p>/);
 assert.equal(settings.split('id="account-recovery"').length-1,1);assert.match(settings,/id="account-sign-in-note"/);
 assert.match(settings,/original email and sign-in method, or a method already linked to it/);
 assert.match(settings,/A different email or an unlinked provider opens a different account\. Data is never merged/);
 assert.match(settings,/two-factor recovery codes are the only way back in/);assert.match(settings,/Two-factor authentication cannot be reset by email/);
 assert.doesNotMatch(settings,/Find an existing workspace|href="\/api\/auth\/(google|login|chatgpt|sso)|onclick=|account\/link/);
});

test('page suspension and session/project mismatch invalidate identity without switching the pinned project',()=>{
 const f=ui();f.renderAccountIdentity({auth_provider:'google',tenant_id:'old-account'},{id:'old-project',name:'Old'});f.invalidateAccountIdentity();
 assert.equal(f.billingCancels(),1);assert.equal(f.usageStops(),1);assert.equal(f.consentInvalidations(),1);assert.equal(f.langsmithInvalidations(),1);assert.equal(f.braintrustInvalidations(),1);assert.equal(f.keyAttemptClears(),1);assert.match(f.text('provider-line'),/needs rechecking/);assert.equal(f.text('who'),'Account needs rechecking');assert.equal(f.hidden('account-reload'),false);
 for(const id of ['account-sign-in-note','account-line','project-name','project-line'])assert.equal(f.text(id),'');assert.equal(f.context.activeProject,'pinned-project');assert.equal(f.context.accountDownloadDraft,null);assert.equal(f.hidden('download-account'),true);assert.equal(f.hidden('discard-account'),true);
 assert.match(source,/addEventListener\?\.\('pagehide',\(\)=>\{invalidateAccountIdentity\(\)/);
 assert.match(source,/error.message==='sign_in_required'\|\|error.message==='project_unavailable'\|\|path.startsWith\('billing\/'\)&&\['workspace_owner_required','billing_scope_changed'\].includes\(error.message\)\)\)invalidateAccountIdentity\(\)/);
 assert.match(source,/\$\('account-reload'\)\.onclick=\(\)=>location.reload\(\)/);
 f.clearAccountIdentity();assert.equal(f.hidden('account-reload'),true);
});

test('only a signed-in email account receives its own address',async()=>{
 const f=await fixture('email'),value=await(await f.read()).json();assert.equal(value.email,'own@example.com');assert.equal(value.auth_provider,'email');
 const foreign=await(await f.read('/api/me',other)).json();assert.equal(foreign.email,undefined);
 assert.equal((await f.read('/api/me?project='+alphaProject(f.foreign.tenant_id).id)).status,403);
 const view=ui();view.renderAccountIdentity(value,{id:value.project_id,name:'Default'});assert.equal(view.text('who'),'Signed in as own@example.com');assert.equal(view.text('account-line'),'Account: own@example.com');
});
