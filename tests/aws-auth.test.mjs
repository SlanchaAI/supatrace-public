import test from 'node:test';import assert from 'node:assert/strict';import {callback,login,digest} from '../src/aws-auth.mjs';
import {handle} from '../src/aws-api.mjs';
import {readFileSync} from 'node:fs';
const state='s'.repeat(43),verifier='v'.repeat(43);
function env(){const states=new Map(),sessions=new Map();return {APP_ORIGIN:'https://supatrace.dev',GITHUB_CLIENT_ID:'test-client',GITHUB_CLIENT_SECRET:'synthetic',states,sessions,store:{createOAuthState:async(k,v)=>states.set(k,v),consumeOAuthState:async k=>{const v=states.get(k);states.delete(k);return v},getOrCreateTenant:async id=>({tenant_id:'github-'+id}),createSession:async(k,t)=>sessions.set(k,t)}};}
function req(s=state){return new Request('https://supatrace.dev/api/auth/callback?code=test&state='+encodeURIComponent(s),{headers:{cookie:'__Host-supatrace-oauth='+state}})};
test('login requests PKCE with the read-only email scope and no repository scopes',async()=>{const e=env(),r=await login(new Request('https://supatrace.dev/api/auth/login'),e),url=new URL(r.headers.get('location'));assert.equal(url.searchParams.get('scope'),'user:email');assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.match(r.headers.get('set-cookie'),/HttpOnly; Secure; SameSite=Lax/);assert.equal(e.states.size,1)});
test('callback consumes state once and stores hashed opaque session only',async()=>{const e=env();e.states.set(digest(state),verifier);let calls=0;const fetcher=async(url,options)=>{calls++;if(calls===1){assert.equal(JSON.parse(options.body).code_verifier,verifier);return Response.json({access_token:'synthetic-provider-token'})}return Response.json({id:123,login:'synthetic'})};const r=await callback(req(),e,fetcher);assert.equal(r.status,302);assert.equal([...e.sessions.values()][0],'github-123');assert.equal([...e.sessions.keys()][0].length,64);assert.equal(e.states.size,0);await assert.rejects(callback(req(),e,fetcher),/expired_oauth_state/)});
test('Unicode state rejected before constant-time buffer comparison',async()=>{await assert.rejects(callback(req('é'.repeat(43)),env()),/invalid_oauth_state/)});
test('unverified provider identity cannot create tenant session',async()=>{const e=env();e.states.set(digest(state),verifier);let n=0;await assert.rejects(callback(req(),e,async()=>Response.json(++n===1?{access_token:'synthetic'}:{id:'123'})),/identity_not_verified/);assert.equal(e.sessions.size,0)});

function googleEnv(){const e=env();Object.assign(e,{ENABLED:true,objects:{},GOOGLE_CLIENT_ID:'synthetic-google-client',GOOGLE_CLIENT_SECRET:'never-log-this-secret',diagnostics:[]});e.store.consumeRate=async()=>({allowed:true});e.store.getOrCreateGoogleTenant=async()=>({tenant_id:'google-'+digest('subject')});e.authDiagnostic=entry=>e.diagnostics.push(entry);e.states.set(digest(state),verifier);return e;}
function googleReq({accept='',query='code=never-log-this-code&state='+state}={}){return new Request('https://supatrace.dev/api/auth/google/callback?'+query,{headers:{cookie:'__Host-supatrace-oauth='+state,accept}});}

test('Google token failure records only an allowlisted category and consumes state once',async()=>{
 const e=googleEnv();let calls=0;
 const fetcher=async(url,options)=>{calls++;assert.equal(url,'https://oauth2.googleapis.com/token');assert.equal(options.redirect,'error');const body=new URLSearchParams(options.body);assert.equal(body.get('redirect_uri'),'https://supatrace.dev/api/auth/google/callback');assert.equal(body.get('code_verifier'),verifier);return Response.json({error:'invalid_client',error_description:'never-log-this-secret never-log-this-code',access_token:'never-log-token'},{status:401});};
 await assert.rejects(callback(googleReq(),e,fetcher,'google'),/identity_provider_unavailable/);
 assert.deepEqual(e.diagnostics,[{event:'oauth_token_exchange_failed',provider:'google',status:401,error:'invalid_client'}]);
 assert.equal(e.sessions.size,0);assert.equal(e.states.size,0);
 await assert.rejects(callback(googleReq(),e,fetcher,'google'),/expired_oauth_state/);assert.equal(calls,1);
 assert.doesNotMatch(JSON.stringify(e.diagnostics),/never-log|https:|description|code_verifier/);
});

for(const [label,response,category,status] of [
 ['unknown provider value',()=>Response.json({error:'secret-shaped-value',error_description:'private'},{status:400}),'provider_rejected',400],
 ['invalid grant',()=>Response.json({error:'invalid_grant'},{status:400}),'invalid_grant',400],
 ['server HTML',()=>new Response('<html>private provider body</html>',{status:503}),'provider_rejected',503],
 ['oversized body',()=>Response.json({error:'invalid_client',extra:'x'.repeat(5000)},{status:400}),'provider_rejected',400]
])test('Google diagnostics safely handle '+label,async()=>{const e=googleEnv();await assert.rejects(callback(googleReq(),e,async()=>response(),'google'),/identity_provider_unavailable/);assert.deepEqual(e.diagnostics,[{event:'oauth_token_exchange_failed',provider:'google',status,error:category}]);});

test('network exceptions and diagnostic failures cannot expose exception details',async()=>{const e=googleEnv();await assert.rejects(callback(googleReq(),e,async()=>{throw Error('private code and secret');},'google'),/identity_provider_unavailable/);assert.deepEqual(e.diagnostics,[{event:'oauth_token_exchange_failed',provider:'google',status:0,error:'network_unavailable'}]);const again=googleEnv();again.authDiagnostic=()=>{throw Error('private logger failure');};await assert.rejects(callback(googleReq(),again,async()=>new Response('private',{status:500}),'google'),/identity_provider_unavailable/);});

test('browser OAuth failures redirect to a clean restart page but API callers retain JSON',async()=>{
 for(const accept of ['text/html,application/xhtml+xml','application/json']){const e=googleEnv();e.fetcher=async()=>Response.json({error:'invalid_grant',error_description:'private provider details'},{status:400});const r=await handle(googleReq({accept}),e);if(accept.startsWith('text/html')){assert.equal(r.status,303);assert.equal(r.headers.get('location'),'/app/?auth_error=provider_unavailable&provider=google');assert.match(r.headers.get('set-cookie'),/__Host-supatrace-oauth=;.*Max-Age=0/);}else{assert.equal(r.status,502);assert.deepEqual(await r.json(),{error:'identity_provider_unavailable'});}assert.doesNotMatch(JSON.stringify([...r.headers]),/never-log|invalid_grant|private/);assert.equal(r.headers.get('referrer-policy'),'no-referrer');}
});

test('expired and cancelled Google callbacks provide a fresh-start route without replaying a grant',async()=>{
 for(const [query,reason] of [['code=private&state=bad','restart_required'],['error=access_denied&state='+state,'not_verified']]){const e=googleEnv();e.fetcher=async()=>{throw Error('must not exchange');};const r=await handle(googleReq({accept:'text/html',query}),e);assert.equal(r.status,303);assert.equal(r.headers.get('location'),'/app/?auth_error='+reason+'&provider=google');assert.deepEqual(e.diagnostics,[]);assert.equal(e.sessions.size,0);}
});

test('a fresh Google grant can succeed after a failed exchange without persisting provider tokens',async()=>{const failed=googleEnv();await assert.rejects(callback(googleReq(),failed,async()=>Response.json({error:'invalid_grant'},{status:400}),'google'),/identity_provider_unavailable/);const fresh=googleEnv();let calls=0;const r=await callback(googleReq(),fresh,async()=>++calls===1?Response.json({access_token:'private-provider-token'}):Response.json({sub:'subject'}),'google');assert.equal(r.status,302);assert.equal(r.headers.get('location'),'/app/');assert.equal(fresh.sessions.size,1);assert.equal([...fresh.sessions.keys()][0].length,64);assert.doesNotMatch(JSON.stringify([...r.headers,...fresh.sessions]),/private-provider-token/);assert.deepEqual(fresh.diagnostics,[]);});

test('the configured CloudFront header allowlist preserves browser recovery negotiation',async()=>{
 const template=readFileSync(new URL('../aws/template.yaml',import.meta.url),'utf8'),policy=template.slice(template.indexOf('\n  ApiRequestPolicy:'));
 const names=policy.match(/Headers: \[([^\]]+)\]/)[1].split(',').map(name=>name.trim().toLowerCase());
 assert.match(policy,/CookieBehavior: all/);assert.match(policy,/QueryStringBehavior: all/);
 const incoming=googleReq({accept:'text/html,application/xhtml+xml'}),headers=new Headers();
 for(const name of names){const value=incoming.headers.get(name);if(value!==null)headers.set(name,value);}headers.set('cookie',incoming.headers.get('cookie'));
 const e=googleEnv();e.fetcher=async()=>Response.json({error:'invalid_grant'},{status:400});
 const response=await handle(new Request(incoming.url,{headers}),e);assert.equal(response.status,303);assert.equal(response.headers.get('location'),'/app/?auth_error=provider_unavailable&provider=google');
});
