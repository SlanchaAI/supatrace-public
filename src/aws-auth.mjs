import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {HttpError,securityHeaders} from './http.mjs';
import {alphaProject,requireProject} from './alpha-projects.mjs';
import {recordAudit} from './audit.mjs';
import {parseKeyToken,storedKeyType,keyAllows} from './key-model.mjs';
import {identityLinksAvailable,signInIdentity,verifiedEmail,githubVerifiedEmail} from './identity-links.mjs';
export const digest=v=>createHash('sha256').update(v).digest('hex');
export const random=()=>randomBytes(32).toString('base64url');
const now=()=>Math.floor(Date.now()/1000);
export function cookie(request,name){const matches=(request.headers.get('cookie')||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(name+'='));return matches.length===1?matches[0].slice(name.length+1):null;}
export const setCookie=(name,value,age,options={})=>`${name}=${value}; Path=${options.path||'/'}; HttpOnly; Secure; SameSite=${options.sameSite||'Lax'}; Max-Age=${age}`;
export async function sessionRow(request,store){const token=cookie(request,'__Host-supatrace');if(!/^[A-Za-z0-9_-]{43}$/.test(token||''))throw new HttpError(401,'sign_in_required');const row=await store.getSession(digest(token));if(!row)throw new HttpError(401,'sign_in_required');return row;}
export async function session(request,store){return (await sessionRow(request,store)).tenant_id;}
// The key travels as x-supatrace-key, or as a standard bearer credential where the edge forwards Authorization.
// Langfuse-compatible routes pass basic:true: the HTTP Basic password (the Langfuse secret key) is the key; the username is not a credential.
// A bearer key may be a legacy 43-character key or a typed st_pub_/st_sec_ key; its type and scope are checked in keyBinding.
export function writeToken(request,{basic=false}={}){
 const direct=request.headers.get('x-supatrace-key');if(direct)return direct;
 const authorization=request.headers.get('authorization')||'',bearer=/^Bearer ((?:st_(?:pub|sec)_)?[A-Za-z0-9_-]{43})$/i.exec(authorization);if(bearer)return bearer[1];
 const encoded=basic&&/^Basic ([A-Za-z0-9+/]{1,600}={0,2})$/i.exec(authorization);if(!encoded)return '';
 const pair=Buffer.from(encoded[1],'base64').toString('utf8'),at=pair.indexOf(':');return at<0?'':pair.slice(at+1);
}
// Every key-authenticated route names the scope it needs. A publishable or legacy key holds only `write`.
export async function keyBinding(request,store,scope='write',options){const token=writeToken(request,options),parsed=parseKeyToken(token);if(!parsed)throw new HttpError(401,request.headers.has('x-supatrace-key')||request.headers.has('authorization')?'invalid_write_key':'write_key_required');const row=await store.lookupWriteKey(digest(token));if(!row||storedKeyType(row)!==parsed.type)throw new HttpError(401,'invalid_write_key');if(row.project_id!==undefined&&row.project_id!==alphaProject(row.tenant_id).id)try{await requireProject(store,row.tenant_id,row.project_id);}catch{throw new HttpError(401,'invalid_write_key');}if(!keyAllows(parsed.type,scope))throw new HttpError(403,'key_scope_denied');return row;}
export const writeBinding=(request,store,options)=>keyBinding(request,store,'write',options);
export async function writer(request,store){return (await writeBinding(request,store)).tenant_id;}
export const githubConfigured=env=>!!(env.GITHUB_CLIENT_ID&&env.GITHUB_CLIENT_SECRET);
export const googleConfigured=env=>!!(env.GOOGLE_CLIENT_ID&&env.GOOGLE_CLIENT_SECRET);
const tokenErrors=new Set(['invalid_request','invalid_client','invalid_grant','unauthorized_client','unsupported_grant_type','access_denied','temporarily_unavailable','server_error']);
async function tokenError(response){
 try{
  const reader=response.body?.getReader();if(!reader)return 'provider_rejected';
  const chunks=[];let bytes=0;
  try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>4096){await reader.cancel();return 'provider_rejected';}chunks.push(part.value);}}
  finally{reader.releaseLock();}
  const body=Buffer.concat(chunks).toString('utf8'),value=JSON.parse(body).error;
  return tokenErrors.has(value)?value:'provider_rejected';
 }catch{return 'provider_rejected';}
}
async function exchangeToken(fetcher,url,options,env,provider){
 let response;
 try{response=await fetcher(url,{...options,signal:AbortSignal.timeout(10000)});}
 catch{reportTokenFailure(env,provider,0,'network_unavailable');throw new HttpError(502,'identity_provider_unavailable');}
 if(!response.ok){reportTokenFailure(env,provider,response.status,await tokenError(response));throw new HttpError(502,'identity_provider_unavailable');}
 return response;
}
function reportTokenFailure(env,provider,status,error){
 // Only a fixed event, provider, status and allowlisted category may leave this module.
 // Never include URLs, request/response bodies, descriptions, codes or credentials.
 const event={event:'oauth_token_exchange_failed',provider:provider==='google'?'google':'github',status:Number.isInteger(status)&&status>=100&&status<=599?status:0,error:tokenErrors.has(error)||error==='network_unavailable'?error:'provider_rejected'};
 try{env.authDiagnostic?.(event);}catch{/* Diagnostics must not change sign-in behavior. */}
}
function redirect(location,cookies){const headers=new Headers(securityHeaders({Location:location}));for(const value of cookies)headers.append('Set-Cookie',value);return new Response(null,{status:302,headers});}
async function startOAuth(env,provider){
 const google=provider==='google';
 if(google&&!googleConfigured(env))throw new HttpError(404,'google_sign_in_unavailable');
 if(!google&&!githubConfigured(env))throw new HttpError(404,'github_sign_in_unavailable');
 const state=random(),verifier=random();
 const redirectUri=env.APP_ORIGIN+(google?'/api/auth/google/callback':'/api/auth/callback');
 await env.store.createOAuthState(digest(state),verifier,now()+600,provider);
 const url=new URL(google?'https://accounts.google.com/o/oauth2/v2/auth':'https://github.com/login/oauth/authorize');
 const params={client_id:google?env.GOOGLE_CLIENT_ID:env.GITHUB_CLIENT_ID,redirect_uri:redirectUri,state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',scope:google?'openid email':'user:email'};
 if(google)params.response_type='code';
 url.search=new URLSearchParams(params);
 return redirect(url.href,[setCookie('__Host-supatrace-oauth',state,600)]);
}
export const login=(request,env)=>startOAuth(env,'github');
export const googleLogin=(request,env)=>startOAuth(env,'google');
export async function callback(request,env,fetcher=fetch,provider='github'){
 const u=new URL(request.url),state=u.searchParams.get('state'),saved=cookie(request,'__Host-supatrace-oauth'),code=u.searchParams.get('code');
 if(u.searchParams.get('error'))throw new HttpError(401,'identity_not_verified');
 if(!/^[A-Za-z0-9_-]{43}$/.test(state||'')||!/^[A-Za-z0-9_-]{43}$/.test(saved||'')||!code||code.length>512||/\s/.test(code)||!timingSafeEqual(Buffer.from(state),Buffer.from(saved)))throw new HttpError(400,'invalid_oauth_state');
 const verifier=await env.store.consumeOAuthState(digest(state),provider);if(!verifier)throw new HttpError(400,'expired_oauth_state');
 const redirectUri=env.APP_ORIGIN+(provider==='google'?'/api/auth/google/callback':'/api/auth/callback');
 let tenantRow;
 if(provider==='google'){
  if(!googleConfigured(env))throw new HttpError(404,'google_sign_in_unavailable');
  const body=new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,code,redirect_uri:redirectUri,grant_type:'authorization_code',code_verifier:verifier});
  const tokenResponse=await exchangeToken(fetcher,'https://oauth2.googleapis.com/token',{method:'POST',redirect:'error',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body},env,'google');
  if(!tokenResponse.ok)throw new HttpError(502,'identity_provider_unavailable');const tokens=await tokenResponse.json();if(typeof tokens.access_token!=='string'||!tokens.access_token)throw new HttpError(401,'identity_not_verified');
  const userResponse=await fetcher('https://openidconnect.googleapis.com/v1/userinfo',{redirect:'error',headers:{Authorization:'Bearer '+tokens.access_token,Accept:'application/json'}});
  if(!userResponse.ok)throw new HttpError(401,'identity_not_verified');const user=await userResponse.json();
  tenantRow=identityLinksAvailable(env.store)?await signInIdentity(env.store,{provider:'google',subject:user.sub,email:verifiedEmail(user.email,user.email_verified)}):await env.store.getOrCreateGoogleTenant(user.sub);
 }else{
  if(!githubConfigured(env))throw new HttpError(404,'github_sign_in_unavailable');
  const tokenResponse=await exchangeToken(fetcher,'https://github.com/login/oauth/access_token',{method:'POST',redirect:'error',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({client_id:env.GITHUB_CLIENT_ID,client_secret:env.GITHUB_CLIENT_SECRET,code,redirect_uri:redirectUri,code_verifier:verifier})},env,'github');
  if(!tokenResponse.ok)throw new HttpError(502,'identity_provider_unavailable');const tokens=await tokenResponse.json();if(!tokens.access_token)throw new HttpError(401,'identity_not_verified');
  const userResponse=await fetcher('https://api.github.com/user',{redirect:'error',headers:{Authorization:'Bearer '+tokens.access_token,Accept:'application/vnd.github+json','User-Agent':'Supatrace','X-GitHub-Api-Version':'2022-11-28'}});
  if(!userResponse.ok)throw new HttpError(401,'identity_not_verified');const user=await userResponse.json();if(!Number.isSafeInteger(user.id)||user.id<=0)throw new HttpError(401,'identity_not_verified');
  if(identityLinksAvailable(env.store)){
   // The verified primary address decides account linking. A refused or failed read only means nothing is linked.
   let email=null;
   try{const emailResponse=await fetcher('https://api.github.com/user/emails?per_page=100',{redirect:'error',headers:{Authorization:'Bearer '+tokens.access_token,Accept:'application/vnd.github+json','User-Agent':'Supatrace','X-GitHub-Api-Version':'2022-11-28'}});if(emailResponse.ok)email=githubVerifiedEmail(await emailResponse.json());}catch{email=null;}
   tenantRow=await signInIdentity(env.store,{provider:'github',subject:user.id,email});
  }else tenantRow=await env.store.getOrCreateTenant(user.id);
 }
 // Provider token is used only in this request, never persisted or sent to the frontend.
 // A linked sign-in is issued against the epoch seen when the link was confirmed, so a concurrent unlink refuses it.
 return establishSession(env,tenantRow.tenant_id,'redirect',[],false,tenantRow.session_epoch);
}
export function sessionEpoch(row){
 const epoch=row?.session_epoch??0;
 if(!row||!Number.isSafeInteger(epoch)||epoch<0)throw new HttpError(409,'session_changed');
 return epoch;
}
// `sso` is the organization SSO binding ({org, idp_version}) of a SAML sign-in. It travels through the MFA challenge to the session row.
export async function establishSession(env,tenantId,mode='redirect',extraCookies=[],force=false,expectedEpoch,sso=null){
 if(expectedEpoch!==undefined&&(!Number.isSafeInteger(expectedEpoch)||expectedEpoch<0))throw new HttpError(409,'session_changed');
 let mfa=false;
 if(!force&&mfaSwitch(env)&&typeof env.store.getTenant==='function'){
  const row=await env.store.getTenant(tenantId);
  if(expectedEpoch!==undefined&&sessionEpoch(row)!==expectedEpoch)throw new HttpError(409,'session_changed');
  const enrolled=typeof row?.mfa_secret==='string'&&row.mfa_secret.length>0;
  if(enrolled){rejectMfaLock(row);expectedEpoch=expectedEpoch??sessionEpoch(row);mfa=true;}
 }
 const clearOAuth=setCookie('__Host-supatrace-oauth','',0);
 if(mfa){
  if(typeof env.store.createMfaChallenge!=='function')throw new HttpError(503,'temporarily_unavailable');
  let pending;
  for(let attempt=0;attempt<3;attempt++){
   const candidate=random();
   try{await env.store.createMfaChallenge(digest(candidate),tenantId,expectedEpoch,sso);pending=candidate;break;}
   catch(error){if(error?.status!==409||error.code!=='mfa_slot_collision')throw error;}
  }
  if(!pending)throw new HttpError(503,'temporarily_unavailable');
  const cookies=[setCookie('__Host-supatrace-mfa',pending,300),clearOAuth,...extraCookies];
  if(mode==='redirect')return redirect('/app/',cookies);
  const headers=new Headers(securityHeaders({'Content-Type':'application/json'}));for(const value of cookies)headers.append('Set-Cookie',value);
  return new Response(JSON.stringify({mfa_required:true}),{status:200,headers});
 }
 const token=await issueSession(env.store,tenantId,expectedEpoch,sso);await signInAudit(env,tenantId);
 const cookies=[setCookie('__Host-supatrace',token,86400),clearOAuth,...extraCookies];
 if(mode==='redirect')return redirect('/app/',cookies);
 const headers=new Headers(securityHeaders());for(const value of cookies)headers.append('Set-Cookie',value);
 return new Response(null,{status:204,headers});
}
function mfaSwitch(env){return env.MFA_ENABLED===true||env.MFA_ENABLED==='true';}
// Sign-in is recorded in the signing-in account's own workspace log, right after the session row is written.
// The session transaction keeps its exact two-item shape, which its collision recovery depends on.
const signInAudit=(env,tenantId)=>recordAudit(env.store,{workspace:tenantId,actor:tenantId,ip:env.sourceIp},'auth.sign_in',tenantId);
async function issueSession(store,tenantId,expectedEpoch,sso){
 const expiresAt=now()+86400;
 for(let attempt=0;attempt<3;attempt++){
  const token=random();
  try{await store.createSession(digest(token),tenantId,expiresAt,expectedEpoch,sso);return token;}
  catch(error){
   if(error?.code!=='session_slot_collision'||error.status!==409||!Number.isSafeInteger(error.sessionEpoch)||error.sessionEpoch<0||
      (expectedEpoch!==undefined&&expectedEpoch!==error.sessionEpoch))throw error;
   expectedEpoch=error.sessionEpoch;
  }
 }
 throw new HttpError(503,'session_unavailable');
}
function rejectMfaLock(row){
 const until=Number(row?.mfa_locked_until)||0,now=Math.floor(Date.now()/1000);
 if(until<=now)return;
 const error=new HttpError(429,'mfa_locked');error.retryAfter=until-now;throw error;
}
const devSubject=/^[A-Za-z0-9._~-]{1,64}$/;
/** Local QA only. The production handler never sets DEV_AUTH, and the route is rejected unless the origin is loopback. */
export async function devSession(request,env){
 const url=new URL(request.url),provider=url.searchParams.get('provider')||'github';
 let row;
 if(provider==='github'){const subject=Number(url.searchParams.get('subject')||'9001');if(!Number.isSafeInteger(subject)||subject<1||subject>999999)throw new HttpError(400,'invalid_provider');row=await env.store.getOrCreateTenant(subject);}
 else if(provider==='google'){const subject=url.searchParams.get('subject')||'dev-google-user';if(!devSubject.test(subject))throw new HttpError(400,'invalid_provider');row=await env.store.getOrCreateGoogleTenant(subject);}
 else throw new HttpError(400,'invalid_provider');
 const token=await issueSession(env.store,row.tenant_id);await signInAudit(env,row.tenant_id);
 return redirect('/app/',[setCookie('__Host-supatrace',token,86400)]);
}
