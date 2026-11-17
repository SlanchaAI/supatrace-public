// Only startup GETs use this deadline. Mutations are never retried here.
export const STARTUP_TIMEOUT_MS=15000;
export async function startupRead(read,{signal,timeoutMs=STARTUP_TIMEOUT_MS}={}){
 if(typeof read!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>STARTUP_TIMEOUT_MS)throw Error('invalid_startup_request');
 if(signal?.aborted)throw Error('startup_cancelled');
 const controller=new AbortController(),relay=()=>controller.abort();
 let expired=false,onAbort;
 signal?.addEventListener('abort',relay,{once:true});
 const timer=setTimeout(()=>{expired=true;controller.abort();},timeoutMs);
 try{
  // Includes response-body parsing, even if a transport ignores cancellation.
  const aborted=new Promise((_,reject)=>{onAbort=()=>reject(Error(expired?'startup_timeout':'startup_cancelled'));controller.signal.addEventListener('abort',onAbort,{once:true});});
  return await Promise.race([aborted,Promise.resolve().then(()=>{if(controller.signal.aborted)throw Error('startup_cancelled');return read(controller.signal);})]);
 }finally{
  clearTimeout(timer);signal?.removeEventListener('abort',relay);controller.signal.removeEventListener('abort',onAbort);
 }
}
// Reachability probe: one cheap unauthenticated GET (the sign-in provider list, which a signed-out page needs anyway)
// with a short deadline of its own. It resolves once response headers arrive, whatever the status and whatever the
// body turns out to be. A failed network request, or no response within PROBE_TIMEOUT_MS, is `startup_unreachable`.
// The body is read separately, under a second deadline of the same length: `providers` resolves to the parsed list, or
// to null when the status is an error or the body is missing, malformed or stalled.
// The probe informs the page; it never stops the account reads. One transport signal covers the request and its body,
// so a deadline or the caller's cancellation at either stage aborts the request itself.
export const PROBE_TIMEOUT_MS=6000;
export async function probeReachable({fetcher=globalThis.fetch,signal,timeoutMs=PROBE_TIMEOUT_MS}={}){
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>STARTUP_TIMEOUT_MS)throw Error('invalid_startup_request');
 if(signal?.aborted)throw Error('startup_cancelled');
 const transport=new AbortController(),relay=()=>transport.abort(),release=()=>signal?.removeEventListener('abort',relay);
 signal?.addEventListener('abort',relay,{once:true});
 // One stage under the deadline. Expiry aborts the transport; so does the caller, through the relay.
 const bounded=work=>new Promise((resolve,reject)=>{
  let expired=false;
  const onAbort=()=>{clearTimeout(timer);reject(Error(expired?'startup_timeout':'startup_cancelled'));};
  const timer=setTimeout(()=>{expired=true;transport.abort();},timeoutMs);
  const settle=done=>value=>{clearTimeout(timer);transport.signal.removeEventListener('abort',onAbort);done(value);};
  if(transport.signal.aborted)return onAbort();
  transport.signal.addEventListener('abort',onAbort,{once:true});
  Promise.resolve().then(work).then(settle(resolve),settle(reject));
 });
 let response;
 try{response=await bounded(()=>fetcher('/api/auth/providers',{credentials:'same-origin',cache:'no-store',signal:transport.signal}));}
 catch(error){release();throw Error(error?.message==='startup_cancelled'?'startup_cancelled':'startup_unreachable');}
 // An error status has no list to read: the rest of the response is dropped.
 if(!response?.ok){transport.abort();release();return {reachable:true,providers:Promise.resolve(null)};}
 const providers=bounded(()=>response.json()).then(value=>value&&typeof value==='object'&&!Array.isArray(value)?value:null,()=>null).finally(release);
 return {reachable:true,providers};
}
// Confirm the session before requesting private projects. A signed-out startup
// costs one identity probe and never sends an unauthorized projects request.
export function loadStartupIdentity(request,options){
 return startupRead(async signal=>{
  const child=new AbortController(),relay=()=>child.abort();signal.addEventListener('abort',relay,{once:true});
  const call=path=>Promise.resolve().then(()=>{if(child.signal.aborted)throw Error('startup_cancelled');return request(path,child.signal);});
  try{
   const me=await call('me');
   if(signal.aborted)throw Error('startup_cancelled');
   if(me?.signed_out===true)throw Error('sign_in_required');
   if(!me||typeof me.project_id!=='string'||!/^proj_[a-f0-9]{32}$/.test(me.project_id))throw Error('project_unavailable');
   const data=await call('projects');
   if(signal.aborted)throw Error('startup_cancelled');
   if(!data||!Array.isArray(data.projects)||data.projects.length<1||data.projects.length>20||!data.projects.some(p=>p.id===me.project_id)||data.projects.some(p=>!/^proj_[a-f0-9]{32}$/.test(p?.id??''))||new Set(data.projects.map(p=>p.id)).size!==data.projects.length)throw Error('project_unavailable');
   return {me,data};
  }finally{child.abort();signal.removeEventListener('abort',relay);}
 },options);
}
