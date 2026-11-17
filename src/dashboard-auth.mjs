import {createHmac,createHash,createPublicKey,randomBytes,scryptSync,timingSafeEqual} from 'node:crypto';
import {isIP} from 'node:net';
import {SAML,ValidateInResponseTo} from '@node-saml/node-saml';
import {orgSsoAvailable,orgSsoForDomain,orgSso,rememberSsoRelay,takeSsoRelay,joinBySso,deploymentDomains} from './org-sso.mjs';
import {HttpError,json,securityHeaders,requireOrigin,boundedText} from './http.mjs';
import {cookie,digest,random,setCookie,establishSession,sessionEpoch} from './aws-auth.mjs';
import {ssoBinding} from './dynamodb-store.mjs';

const emailPattern=/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const codePattern=/^[0-9]{6}$/;
const BASE32='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const RECENT_SECONDS=600;
let dummyHash;

export function hashPassword(password){
 const salt=randomBytes(16).toString('base64url');
 const hash=scryptSync(password,salt,32,{N:16384,r:8,p:1}).toString('base64url');
 return `scrypt$16384$8$1$${salt}$${hash}`;
}
function dummyStored(){return dummyHash||(dummyHash=hashPassword('supatrace-dummy-password'));}
export function checkPassword(password,stored){
 const parts=typeof stored==='string'?stored.split('$'):[];
 const salt=parts[4],hash=parts[5];
 if(parts[0]!=='scrypt'||!salt||!hash)return false;
 const actual=scryptSync(password,salt,32,{N:16384,r:8,p:1});
 const expected=Buffer.from(hash,'base64url');
 return actual.length===expected.length&&timingSafeEqual(actual,expected);
}
function normalizeEmail(value){
 const email=String(value||'').trim().toLowerCase();
 if(!emailPattern.test(email)||email.length>254)throw new HttpError(400,'invalid_email');
 return email;
}
export function passwordProblems(password){
 const value=String(password??'');
 const problems=[];
 if(value.length<8)problems.push('at least 8 characters');
 if(value.length>72)problems.push('72 characters or less');
 if(!/[A-Z]/.test(value))problems.push('an uppercase letter');
 if(!/[a-z]/.test(value))problems.push('a lowercase letter');
 if(!/[0-9]/.test(value))problems.push('a number');
 if(!/[^A-Za-z0-9]/.test(value))problems.push('a special character');
 return problems;
}
function providerUrl(value){
 let url;try{url=new URL(value);}catch{return null;}
 if(url.protocol==='https:')return url;
 if(url.protocol==='http:'&&url.hostname==='127.0.0.1')return url;
 return null;
}
export function legalProviderSubject(value){
 if(typeof value!=='string'||value.length<1||value.length>255)return false;
 for(const char of value){const code=char.codePointAt(0);if(code<=32||code===127)return false;}
 return true;
}
function expandIPv6(address){
 const halves=address.toLowerCase().split('::');
 if(halves.length>2)return null;
 const groups=text=>{
  if(!text)return [];
  const parts=text.split(':');
  const last=parts.at(-1);
  if(last?.includes('.')){
   if(isIP(last)!==4)return null;
   const [a,b,c,d]=last.split('.').map(Number);
   parts.splice(-1,1,((a<<8)|b).toString(16),((c<<8)|d).toString(16));
  }
  return parts;
 };
 const head=groups(halves[0]);
 if(!head)return null;
 const tail=halves.length===2?groups(halves[1]):[];
 if(!tail)return null;
 if(halves.length===1&&head.length!==8)return null;
 const missing=8-head.length-tail.length;
 if(missing<0)return null;
 const parts=halves.length===2?[...head,...Array(missing).fill('0'),...tail]:head;
 if(parts.length!==8||parts.some(part=>!/^[0-9a-f]{1,4}$/.test(part)))return null;
 return parts.map(part=>part.padStart(4,'0')).join(':');
}
/** IPv4 stays the whole address. IPv6 collapses to its /64 so one network cannot mint many identities. */
export function networkIdentity(ip){
 if(typeof ip!=='string'||!ip)return 'unknown';
 const bare=ip.split('%')[0];
 if(isIP(bare)===4)return bare;
 if(isIP(bare)!==6)return 'unknown';
 const expanded=expandIPv6(bare);
 if(!expanded)return 'unknown';
 if(expanded.startsWith('0000:0000:0000:0000:0000:ffff:')){
  const hi=Number.parseInt(expanded.slice(30,34),16),lo=Number.parseInt(expanded.slice(35,39),16);
  return `${hi>>8}.${hi&255}.${lo>>8}.${lo&255}`;
 }
 return expanded.split(':').slice(0,4).join(':');
}
export function chatgptConfigured(env){
 return !!(env.CHATGPT_CLIENT_ID&&env.CHATGPT_CLIENT_SECRET&&providerUrl(env.CHATGPT_AUTHORIZE_URL)&&providerUrl(env.CHATGPT_TOKEN_URL)&&providerUrl(env.CHATGPT_USERINFO_URL));
}
export function emailConfigured(env){
 return typeof env.EMAIL_FROM==='string'&&emailPattern.test(env.EMAIL_FROM)&&typeof env.sendEmail==='function';
}
export function ssoConfigured(env){
 if(typeof env.SSO_EMAIL_DOMAINS!=='string'||!env.SSO_EMAIL_DOMAINS.trim()||!providerUrl(env.SSO_IDP_SSO_URL))return false;
 if(typeof env.SSO_IDP_ISSUER!=='string'||!env.SSO_IDP_ISSUER||env.SSO_IDP_ISSUER.length>1024)return false;
 if(typeof env.SSO_IDP_CERT!=='string'||!env.SSO_IDP_CERT.includes('BEGIN CERTIFICATE'))return false;
 try{createPublicKey(env.SSO_IDP_CERT);return true;}catch{return false;}
}
export function mfaEnabled(env){return env.MFA_ENABLED===true||env.MFA_ENABLED==='true';}
export async function providerFlags(request,env){
 const flags={github:!!(env.GITHUB_CLIENT_ID&&env.GITHUB_CLIENT_SECRET),chatgpt:chatgptConfigured(env),sso:ssoConfigured(env)||await orgSsoAvailable(env.store),email:emailConfigured(env),google:!!(env.GOOGLE_CLIENT_ID&&env.GOOGLE_CLIENT_SECRET),mfa:false,mfa_enabled:mfaEnabled(env)};
 const pending=cookie(request,'__Host-supatrace-mfa');
 if(flags.mfa_enabled&&pending&&/^[A-Za-z0-9_-]{43}$/.test(pending)&&typeof env.store.peekAuthChallenge==='function'){
  flags.mfa=!!await env.store.peekAuthChallenge('MFA',digest(pending));
 }
 return flags;
}
function sameOrigin(request,env){requireOrigin(request,env.APP_ORIGIN);}
async function charge(env,scope,identity,limit,windowSeconds){
 const rate=await env.store.consumeRate({scope,identity,limit,windowSeconds});
 if(!rate.allowed){const error=new HttpError(429,'rate_limit');error.retryAfter=rate.retry_after;throw error;}
}
async function limited(env,scope,limit,email){
 const identities=[networkIdentity(env.sourceIp)];
 if(email)identities.push('email:'+digest(email));
 for(const identity of identities){
  const rate=await env.store.consumeRate({scope,identity,limit,windowSeconds:300});
  if(!rate.allowed){const error=new HttpError(429,'rate_limit');error.retryAfter=rate.retry_after;throw error;}
 }
}
async function send(env,message){
 try{await env.sendEmail(message);}catch{throw new HttpError(503,'email_unavailable');}
}
function code(){return String(randomBytes(4).readUInt32BE(0)%1000000).padStart(6,'0');}
function recoveryCode(){return randomBytes(8).toString('base64url').slice(0,10);}
function sameHex(left,right){
 if(typeof left!=='string'||typeof right!=='string')return false;
 const a=Buffer.from(left),b=Buffer.from(right);
 return a.length===b.length&&a.length>0&&timingSafeEqual(a,b);
}
export function encodeBase32(bytes){
 let bits=0,value=0,out='';
 for(const byte of bytes){value=(value<<8)|byte;bits+=8;while(bits>=5){out+=BASE32[(value>>>(bits-5))&31];bits-=5;}}
 if(bits>0)out+=BASE32[(value<<(5-bits))&31];
 return out;
}
export function decodeBase32(text){
 const clean=String(text||'').toUpperCase().replace(/=+$/,'').replace(/ /g,'');
 if(!/^[A-Z2-7]+$/.test(clean))throw new HttpError(401,'invalid_code');
 let bits=0,value=0;const out=[];
 for(const char of clean){value=(value<<5)|BASE32.indexOf(char);bits+=5;if(bits>=8){out.push((value>>>(bits-8))&255);bits-=8;}}
 return Buffer.from(out);
}
export function totp(secret,when=Date.now()){
 const key=decodeBase32(secret);
 const counter=Math.floor(when/1000/30);
 const buf=Buffer.alloc(8);buf.writeBigUInt64BE(BigInt(counter));
 const hmac=createHmac('sha1',key).update(buf).digest();
 const offset=hmac[hmac.length-1]&15;
 const bin=hmac.readUInt32BE(offset)&0x7fffffff;
 return String(bin%1000000).padStart(6,'0');
}
export function totpMatches(secret,token,when=Date.now()){
 if(!codePattern.test(token||''))return false;
 const given=Buffer.from(token);
 for(const delta of [-30000,0,30000]){
  const expected=Buffer.from(totp(secret,when+delta));
  if(expected.length===given.length&&timingSafeEqual(expected,given))return true;
 }
 return false;
}
function newSecret(){return encodeBase32(randomBytes(20));}

export async function chatgptLogin(request,env){
 if(!chatgptConfigured(env))throw new HttpError(404,'chatgpt_sign_in_unavailable');
 const state=random(),verifier=random();
 const redirectUri=env.APP_ORIGIN+'/api/auth/chatgpt/callback';
 await env.store.createOAuthState(digest(state),verifier,Math.floor(Date.now()/1000)+600,'chatgpt');
 const url=providerUrl(env.CHATGPT_AUTHORIZE_URL);
 url.searchParams.set('client_id',env.CHATGPT_CLIENT_ID);
 url.searchParams.set('redirect_uri',redirectUri);
 url.searchParams.set('response_type','code');
 url.searchParams.set('scope','openid email');
 url.searchParams.set('state',state);
 url.searchParams.set('code_challenge',createHash('sha256').update(verifier).digest('base64url'));
 url.searchParams.set('code_challenge_method','S256');
 const headers=new Headers(securityHeaders({Location:url.href}));
 headers.append('Set-Cookie',setCookie('__Host-supatrace-oauth',state,600));
 return new Response(null,{status:302,headers});
}
export async function chatgptCallback(request,env,fetcher=fetch){
 if(!chatgptConfigured(env))throw new HttpError(404,'chatgpt_sign_in_unavailable');
 const u=new URL(request.url),state=u.searchParams.get('state'),saved=cookie(request,'__Host-supatrace-oauth'),codeValue=u.searchParams.get('code');
 if(u.searchParams.get('error'))throw new HttpError(401,'identity_not_verified');
 if(!/^[A-Za-z0-9_-]{43}$/.test(state||'')||!/^[A-Za-z0-9_-]{43}$/.test(saved||'')||!codeValue||codeValue.length>512||/\s/.test(codeValue)||!timingSafeEqual(Buffer.from(state),Buffer.from(saved)))throw new HttpError(400,'invalid_oauth_state');
 const verifier=await env.store.consumeOAuthState(digest(state),'chatgpt');if(!verifier)throw new HttpError(400,'expired_oauth_state');
 const redirectUri=env.APP_ORIGIN+'/api/auth/chatgpt/callback';
 const body=new URLSearchParams({client_id:env.CHATGPT_CLIENT_ID,client_secret:env.CHATGPT_CLIENT_SECRET,code:codeValue,redirect_uri:redirectUri,grant_type:'authorization_code',code_verifier:verifier});
 const tokenResponse=await fetcher(env.CHATGPT_TOKEN_URL,{method:'POST',redirect:'error',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body});
 if(!tokenResponse.ok)throw new HttpError(502,'identity_provider_unavailable');
 const tokens=await tokenResponse.json();if(typeof tokens.access_token!=='string'||!tokens.access_token)throw new HttpError(401,'identity_not_verified');
 const userResponse=await fetcher(env.CHATGPT_USERINFO_URL,{redirect:'error',headers:{Authorization:'Bearer '+tokens.access_token,Accept:'application/json'}});
 if(!userResponse.ok)throw new HttpError(401,'identity_not_verified');
 const user=await userResponse.json();if(!legalProviderSubject(user.sub||''))throw new HttpError(401,'identity_not_verified');
 const tenantRow=await env.store.getOrCreateChatGptTenant(user.sub);
 return establishSession(env,tenantRow.tenant_id,'redirect');
}

function ssoDomains(env){return env.SSO_EMAIL_DOMAINS.split(',').map(domain=>domain.trim().toLowerCase()).filter(Boolean);}
function samlFor(env,idp={url:env.SSO_IDP_SSO_URL,cert:env.SSO_IDP_CERT,issuer:env.SSO_IDP_ISSUER}){
 return new SAML({
  callbackUrl:env.APP_ORIGIN+'/api/auth/sso/callback',
  entryPoint:idp.url,
  issuer:env.APP_ORIGIN+'/api/auth/sso',
  audience:env.APP_ORIGIN+'/api/auth/sso',
  idpCert:idp.cert,
  idpIssuer:idp.issuer,
  wantAssertionsSigned:true,
  wantAuthnResponseSigned:false,
  validateInResponseTo:ValidateInResponseTo.always,
  acceptedClockSkewMs:0,
  disableRequestedAuthnContext:true,
  cacheProvider:{
   saveAsync:async(key,value)=>{await env.store.saveSamlCache(key,value);return {value,createdAt:Date.now()};},
   getAsync:key=>env.store.readSamlCache(key),
   removeAsync:async key=>key?env.store.deleteSamlCache(key):null,
   consumeAsync:key=>env.store.deleteSamlCache(key)
  }
 });
}
const ssoCookie=(value,age)=>setCookie('supatrace-sso',value,age,{path:'/api/auth/sso/callback',sameSite:'None'});
export async function ssoStart(request,env){
 const email=normalizeEmail(new URL(request.url).searchParams.get('email'));
 const domain=email.split('@')[1],stack=ssoConfigured(env);
 // The deployment's IdP (stack parameters) owns its domains. Any other domain belongs to the organization that verified it.
 const org=deploymentDomains(env).includes(domain)?null:await orgSsoForDomain(env.store,domain);
 if(!org&&!stack)throw new HttpError(404,'sso_sign_in_unavailable');
 if(!org&&!ssoDomains(env).includes(domain))throw new HttpError(404,'sso_domain_unknown');
 const idp=org?{url:org.idp_sso_url,cert:org.idp_cert,issuer:org.idp_issuer}:undefined;
 const relay=random();if(org)await rememberSsoRelay(env.store,relay,org.org);
 let url;
 for(let attempt=0;attempt<3;attempt++){
  try{url=await samlFor(env,idp).getAuthorizeUrlAsync(relay,{});break;}
  catch(error){
   // Only a definite rejected slot reservation is safe to retry. node-saml makes
   // a fresh random request ID per attempt; ambiguous storage failures propagate.
   if(error?.code!=='sso_request_busy'||error.status!==503||attempt===2)throw error;
  }
 }
 const headers=new Headers(securityHeaders({'Content-Type':'application/json'}));
 headers.append('Set-Cookie',ssoCookie(relay,600));
 return new Response(JSON.stringify({url}),{status:200,headers});
}
export async function ssoCallback(request,env){
 if(!ssoConfigured(env)&&!await orgSsoAvailable(env.store))throw new HttpError(404,'sso_sign_in_unavailable');
 const type=request.headers.get('content-type')||'';
 if(!type.startsWith('application/x-www-form-urlencoded'))throw new HttpError(415,'json_required');
 const raw=await request.text();
 if(raw.length>30000)throw new HttpError(401,'identity_not_verified');
 const fields=new URLSearchParams(raw);
 let decoded='';
 try{decoded=Buffer.from(fields.get('SAMLResponse')||'','base64').toString('utf8');}catch{throw new HttpError(401,'identity_not_verified');}
 if(!decoded||decoded.length>30000||/<!DOCTYPE|<!ENTITY/i.test(decoded)||/<!DOCTYPE|<!ENTITY/i.test(raw))throw new HttpError(401,'identity_not_verified');
 const relay=fields.get('RelayState')||'',saved=cookie(request,'supatrace-sso')||'';
 if(!/^[A-Za-z0-9_-]{43}$/.test(relay)||!/^[A-Za-z0-9_-]{43}$/.test(saved)||!timingSafeEqual(Buffer.from(relay),Buffer.from(saved)))throw new HttpError(400,'invalid_oauth_state');
 // A request that began for an organization is checked against that organization's IdP and domains, never the deployment's.
 const boundOrg=await takeSsoRelay(env.store,relay),org=boundOrg?await orgSso(env.store,boundOrg):null;
 if(boundOrg&&!org)throw new HttpError(401,'identity_not_verified');
 if(!org&&!ssoConfigured(env))throw new HttpError(401,'identity_not_verified');
 const idp=org?{url:org.idp_sso_url,cert:org.idp_cert,issuer:org.idp_issuer}:{url:env.SSO_IDP_SSO_URL,cert:env.SSO_IDP_CERT,issuer:env.SSO_IDP_ISSUER};
 let profile;
 try{({profile}=await samlFor(env,idp).validatePostResponseAsync({SAMLResponse:fields.get('SAMLResponse')||'',RelayState:relay}));}
 catch{throw new HttpError(401,'identity_not_verified');}
 if(!profile?.nameID||profile.issuer!==idp.issuer)throw new HttpError(401,'identity_not_verified');
 let email;try{email=normalizeEmail(profile.nameID);}catch{throw new HttpError(401,'identity_not_verified');}
 // An organization's IdP may assert only emails in the organization's verified domains, and never one in a domain of the
 // deployment's IdP, whichever address the request was started for.
 if(!(org?org.domains.filter(domain=>!deploymentDomains(env).includes(domain)):ssoDomains(env)).includes(email.split('@')[1]))throw new HttpError(401,'identity_not_verified');
 const tenantRow=await env.store.getOrCreateSsoTenant(email);
 // Just-in-time: a person their organization's IdP vouches for becomes a member with the organization's default role.
 if(org)await joinBySso(env,org,tenantRow.tenant_id);
 // The session remembers which organization's IdP vouched for it and at which version of that organization's IdP settings.
 // "Require SSO" accepts only a session bound to that organization and its current settings (src/workspaces.mjs).
 return establishSession(env,tenantRow.tenant_id,'redirect',[ssoCookie('',0)],false,undefined,org?{org:org.org,idp_version:org.idp_version}:null);
}

export async function emailSignUp(request,env){
 if(!emailConfigured(env))throw new HttpError(404,'email_sign_in_unavailable');
 sameOrigin(request,env);
 const body=JSON.parse(await boundedText(request,4096));
 const email=normalizeEmail(body.email);
 if(passwordProblems(body.password).length)throw new HttpError(400,'password_rejected');
 await limited(env,'signup',5,email);
 if(await env.store.getEmailAccount(email))throw new HttpError(409,'email_already_registered');
 await charge(env,'signupnet',networkIdentity(env.sourceIp),3,3600);
 await charge(env,'signupdomain',email.split('@')[1],8,3600);
 await charge(env,'signuphour','all',20,3600);
 const token=random();
 await env.store.replaceAuthChallenge('SIGNUP',digest(email),{email,password_hash:hashPassword(body.password),token_hash:digest(token)},600);
 await send(env,{to:email,subject:'Finish signing up for Supatrace',text:`Open this link and enter the password you chose. The link does not create the account or sign you in. It expires in 10 minutes.\n${env.APP_ORIGIN}/?email=${encodeURIComponent(email)}&token=${token}\n`});
 return json({ok:true,message:'Check your email'});
}
export async function emailVerify(request,env){
 if(!emailConfigured(env))throw new HttpError(404,'email_sign_in_unavailable');
 const params=new URL(request.url).searchParams;
 const location=new URL('/',env.APP_ORIGIN);
 const email=params.get('email')||'';
 const token=params.get('token')||'';
 if(email&&email.length<=254)location.searchParams.set('email',email);
 if(/^[A-Za-z0-9_-]{43}$/.test(token))location.searchParams.set('token',token);
 const headers=new Headers(securityHeaders({Location:location.href}));
 return new Response(null,{status:302,headers});
}
export async function emailConfirm(request,env){
 if(!emailConfigured(env))throw new HttpError(404,'email_sign_in_unavailable');
 sameOrigin(request,env);
 const body=JSON.parse(await boundedText(request,4096));
 const email=normalizeEmail(body.email);
 const token=body.token||'';
 if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw new HttpError(400,'invalid_code');
 await limited(env,'confirm',5,email);
 const row=await env.store.peekAuthChallenge('SIGNUP',digest(email));
 if(!row||row.email!==email||!sameHex(row.token_hash,digest(token)))throw new HttpError(400,'invalid_code');
 if(!checkPassword(String(body.password??''),row.password_hash))throw new HttpError(401,'invalid_credentials');
 const account=await env.store.createVerifiedEmailAccount(email,row.password_hash);
 await env.store.consumeAuthChallenge('SIGNUP',digest(email));
 // A new account starts at epoch zero. A concurrent password reset must invalidate this proof.
 return establishSession(env,account.tenant_id,'json',[],false,0);
}
export async function emailSignIn(request,env){
 if(!emailConfigured(env))throw new HttpError(404,'email_sign_in_unavailable');
 sameOrigin(request,env);
 const body=JSON.parse(await boundedText(request,4096));
 const email=normalizeEmail(body.email);
 await limited(env,'email',10,email);
 // Capture revocation before reading credentials; a reset must not upgrade an
 // old password proof to a newer session generation.
 const tenantId='email-'+digest(email),authTenant=await env.store.getTenant(tenantId);
 const account=await env.store.getEmailAccount(email);
 const matches=checkPassword(String(body.password??''),account?.password_hash||dummyStored());
 if(!account||!matches||account.tenant_id!==tenantId||authTenant?.tenant_id!==tenantId)throw new HttpError(401,'invalid_credentials');
 return establishSession(env,account.tenant_id,'json',[],false,sessionEpoch(authTenant));
}
export async function emailReset(request,env){
 if(!emailConfigured(env))throw new HttpError(404,'email_sign_in_unavailable');
 sameOrigin(request,env);
 const body=JSON.parse(await boundedText(request,4096));
 const email=normalizeEmail(body.email);
 await limited(env,'reset',5,email);
 const account=await env.store.getEmailAccount(email);
 if(account?.verified){
  const token=code();
  await env.store.replaceAuthChallenge('RESET',digest(email),{email,stage:'code',code_hash:digest(token)},600);
  await send(env,{to:email,subject:'Supatrace password reset code',text:`Your reset code is ${token}. It expires in 10 minutes.\n`});
 }
 return json({ok:true,message:'Check your email for a reset code'});
}
export async function emailResetConfirm(request,env){
 if(!emailConfigured(env))throw new HttpError(404,'email_sign_in_unavailable');
 sameOrigin(request,env);
 const body=JSON.parse(await boundedText(request,4096));
 const email=normalizeEmail(body.email);
 if(!codePattern.test(body.code||''))throw new HttpError(400,'invalid_code');
 const row=await env.store.peekAuthChallenge('RESET',digest(email));
 if(!row||row.email!==email||row.stage!=='code'||!sameHex(row.code_hash,digest(body.code))){
  if(row?.stage==='code')await env.store.recordChallengeMiss('RESET',digest(email),5);
  throw new HttpError(400,'invalid_code');
 }
 await env.store.consumeAuthChallenge('RESET',digest(email));
 const token=random();
 await env.store.createAuthChallenge('RESET',digest(token),{email,stage:'password'},600);
 const headers=new Headers(securityHeaders({'Content-Type':'application/json'}));
 headers.append('Set-Cookie',setCookie('__Host-supatrace-reset',token,600));
 return new Response(JSON.stringify({ok:true}),{status:200,headers});
}
export async function emailResetPassword(request,env){
 if(!emailConfigured(env))throw new HttpError(404,'email_sign_in_unavailable');
 sameOrigin(request,env);
 const token=cookie(request,'__Host-supatrace-reset')||'';
 if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw new HttpError(401,'sign_in_required');
 const pending=await env.store.peekAuthChallenge('RESET',digest(token));
 if(!pending||pending.stage!=='password')throw new HttpError(400,'invalid_code');
 const body=JSON.parse(await boundedText(request,4096));
 if(passwordProblems(body.password).length)throw new HttpError(400,'password_rejected');
 const row=await env.store.consumeAuthChallenge('RESET',digest(token));
 if(!row||row.stage!=='password')throw new HttpError(400,'invalid_code');
 const account=await env.store.getEmailAccount(row.email);
 if(!account)throw new HttpError(400,'invalid_code');
 await env.store.resetEmailPassword(row.email,account.tenant_id,hashPassword(body.password));
 const headers=new Headers(securityHeaders({'Content-Type':'application/json'}));
 headers.append('Set-Cookie',setCookie('__Host-supatrace-reset','',0));
 return new Response(JSON.stringify({ok:true}),{status:200,headers});
}

async function pendingMfa(request,env){
 const token=cookie(request,'__Host-supatrace-mfa')||'';
 if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw new HttpError(401,'sign_in_required');
 const row=await env.store.peekAuthChallenge('MFA',digest(token));
 if(!row?.tenant_id)throw new HttpError(401,'sign_in_required');
 if(!Number.isSafeInteger(row.session_epoch)||row.session_epoch<0)throw new HttpError(409,'session_changed');
 return {token,row};
}
function requireMfa(env){if(!mfaEnabled(env))throw new HttpError(404,'mfa_unavailable');}
function rejectMfaLock(tenant){
 const until=Number(tenant?.mfa_locked_until)||0,now=Math.floor(Date.now()/1000);
 if(until<=now)return;
 const error=new HttpError(429,'mfa_locked');error.retryAfter=until-now;throw error;
}
/** Five misses lock the account. The lock doubles from 5 minutes and stops at one hour. */
function lockSeconds(failures){
 if(!Number.isInteger(failures)||failures<5||failures%5!==0)return 0;
 const step=failures/5;
 return Math.min(3600,300*2**(step-1));
}
async function recordMfaFailure(env,tenant,token){
 const failures=(Number(tenant?.mfa_failures)||0)+1;
 const seconds=lockSeconds(failures);
 const until=seconds?Math.floor(Date.now()/1000)+seconds:0;
 await env.store.setTenantFields(tenant.tenant_id,'SET mfa_failures = :failures, mfa_locked_until = :until',{':failures':failures,':until':until},sessionEpoch(tenant));
 if(!seconds)return;
 await env.store.consumeAuthChallenge('MFA',digest(token));
 const error=new HttpError(429,'mfa_locked');error.retryAfter=seconds;throw error;
}
async function clearMfaFailures(env,tenantId,epoch){
 await env.store.setTenantFields(tenantId,'SET mfa_failures = :failures, mfa_locked_until = :until',{':failures':0,':until':0},epoch);
}
async function consumeMfa(env,token,row){
 const consumed=await env.store.consumeAuthChallenge('MFA',digest(token));
 if(!consumed||consumed.tenant_id!==row.tenant_id||consumed.session_epoch!==row.session_epoch)throw new HttpError(401,'sign_in_required');
}
async function missMfa(env,token){
 await env.store.recordChallengeMiss('MFA',digest(token),5);
 throw new HttpError(401,'invalid_code');
}
export async function mfaVerify(request,env){
 requireMfa(env);sameOrigin(request,env);await limited(env,'mfa',30);
 const {token,row}=await pendingMfa(request,env);
 const tenant=await env.store.getTenant(row.tenant_id);
 if(sessionEpoch(tenant)!==row.session_epoch)throw new HttpError(409,'session_changed');
 rejectMfaLock(tenant);
 const body=JSON.parse(await boundedText(request,4096));
 if(!tenant?.mfa_secret||!totpMatches(tenant.mfa_secret,body.code||'')){if(tenant?.tenant_id)await recordMfaFailure(env,tenant,token);return missMfa(env,token);}
 await clearMfaFailures(env,row.tenant_id,row.session_epoch);
 await consumeMfa(env,token,row);
 return establishSession(env,row.tenant_id,'json',[setCookie('__Host-supatrace-mfa','',0)],true,row.session_epoch,ssoBinding(row));
}
export async function mfaRecovery(request,env){
 requireMfa(env);sameOrigin(request,env);await limited(env,'mfa',30);
 const {token,row}=await pendingMfa(request,env);
 const tenant=await env.store.getTenant(row.tenant_id);
 if(sessionEpoch(tenant)!==row.session_epoch)throw new HttpError(409,'session_changed');
 rejectMfaLock(tenant);
 const body=JSON.parse(await boundedText(request,4096));
 const given=digest(String(body.code||''));
 const hashes=Array.isArray(tenant?.recovery_hashes)?tenant.recovery_hashes:[];
 if(!hashes.includes(given)){if(tenant?.tenant_id)await recordMfaFailure(env,tenant,token);return missMfa(env,token);}
 await env.store.setTenantFields(row.tenant_id,'SET recovery_hashes = :hashes',{':hashes':hashes.filter(hash=>hash!==given)},row.session_epoch);
 await clearMfaFailures(env,row.tenant_id,row.session_epoch);
 await consumeMfa(env,token,row);
 return establishSession(env,row.tenant_id,'json',[setCookie('__Host-supatrace-mfa','',0)],true,row.session_epoch,ssoBinding(row));
}
async function currentSession(request,env){
 const token=cookie(request,'__Host-supatrace')||'';
 if(!/^[A-Za-z0-9_-]{43}$/.test(token))return null;
 return env.store.getSession(digest(token));
}
async function allowMfaChange(request,env,tenant,body){
 const enrolled=typeof tenant?.mfa_secret==='string'&&tenant.mfa_secret.length>0;
 if(!enrolled)return;
 const session=await currentSession(request,env);
 const now=Math.floor(Date.now()/1000);
 if(session&&session.expires_at>now+86400-RECENT_SECONDS)return;
 if(!body?.code)throw new HttpError(401,'mfa_required');
 if(!totpMatches(tenant.mfa_secret,body.code))throw new HttpError(401,'invalid_code');
}
export async function mfaEnroll(request,env,tenantId){
 requireMfa(env);sameOrigin(request,env);
 const raw=await boundedText(request,4096);
 const body=raw?JSON.parse(raw):{};
 const tenant=await env.store.getTenant(tenantId);
 await allowMfaChange(request,env,tenant,body);
 const secret=newSecret();
 await env.store.setTenantFields(tenantId,'SET mfa_pending = :secret',{':secret':secret});
 return json({secret,otpauth:`otpauth://totp/Supatrace:${encodeURIComponent(tenantId)}?secret=${secret}&issuer=Supatrace&algorithm=SHA1&digits=6&period=30`});
}
export async function mfaConfirm(request,env,tenantId){
 requireMfa(env);sameOrigin(request,env);
 const tenant=await env.store.getTenant(tenantId);
 const body=JSON.parse(await boundedText(request,4096));
 if(!tenant?.mfa_pending||!totpMatches(tenant.mfa_pending,body.code||''))throw new HttpError(401,'invalid_code');
 const codes=Array.from({length:8},recoveryCode);
 await env.store.setTenantFields(tenantId,'SET mfa_secret = :secret, recovery_hashes = :hashes, mfa_pending = :empty',{':secret':tenant.mfa_pending,':hashes':codes.map(digest),':empty':''});
 return json({recovery_codes:codes});
}
export async function mfaDisable(request,env,tenantId){
 requireMfa(env);sameOrigin(request,env);
 const raw=await boundedText(request,4096);
 const body=raw?JSON.parse(raw):{};
 const tenant=await env.store.getTenant(tenantId);
 if(!tenant?.mfa_secret)return json({ok:true,mfa:false});
 await allowMfaChange(request,env,tenant,body);
 await env.store.setTenantFields(tenantId,'SET mfa_secret = :empty, mfa_pending = :empty, recovery_hashes = :none',{':empty':'',':none':[]});
 return json({ok:true,mfa:false});
}
