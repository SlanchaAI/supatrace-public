// Read-only bounded loading. No partial history or raw write-key value is exposed.
export const KEY_HISTORY_LIMITS=Object.freeze({keys:10000,pages:1000,bytes:4*1024*1024,timeoutMs:60000,retries:3});
const fail=code=>{throw new Error(code);};
const cancelled=signal=>{if(signal?.aborted)fail('key_load_cancelled');};
const validCursor=value=>typeof value==='string'&&value.length>0&&value.length<=2048&&/^[A-Za-z0-9_-]+$/.test(value);
function abortable(work,signal){
 cancelled(signal);
 return new Promise((resolve,reject)=>{
  const abort=()=>{signal.removeEventListener('abort',abort);reject(new Error('key_load_cancelled'));};
  signal.addEventListener('abort',abort,{once:true});
  Promise.resolve().then(()=>{cancelled(signal);return work();}).then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
 });
}
function wait(ms,signal){
 return new Promise((resolve,reject)=>{cancelled(signal);const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(new Error('key_load_cancelled'));};const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);signal.addEventListener('abort',abort,{once:true});});
}
// Mirrors src/key-model.mjs. A key value is built only in this browser; the server receives its SHA-256.
export const KEY_PREFIXES=Object.freeze({publishable:'st_pub_',secret:'st_sec_'});
export const KEY_TYPE_LABELS=Object.freeze({legacy:'write only',publishable:'ingest · write only',secret:'secret · read + write'});
export const keyType=key=>Object.hasOwn(KEY_PREFIXES,key?.key_type)?key.key_type:'legacy';
function validKey(key,projectId,environmentId){
 return key&&typeof key==='object'&&!Array.isArray(key)&&Object.keys(key).every(name=>['id','project_id','scope','expires_at','revoked','environment_id','authorization_active','created_at','key_type','no_expiry','last_used_at','rotated'].includes(name))&&
  typeof key.id==='string'&&/^[a-f0-9]{64}$/.test(key.id)&&key.project_id===projectId&&
  (!Object.hasOwn(key,'key_type')||['legacy','publishable','secret'].includes(key.key_type))&&key.scope===(key.key_type==='secret'?'read_write':'write_only')&&
  Number.isSafeInteger(key.expires_at)&&key.expires_at>=0&&key.expires_at<=8640000000000&&typeof key.revoked==='boolean'&&(key.environment_id??'default')===environmentId&&(!Object.hasOwn(key,'authorization_active')||typeof key.authorization_active==='boolean')&&
  (!Object.hasOwn(key,'created_at')||Number.isInteger(key.created_at)&&key.created_at>0)&&
  (!Object.hasOwn(key,'no_expiry')||typeof key.no_expiry==='boolean')&&(!Object.hasOwn(key,'last_used_at')||Number.isSafeInteger(key.last_used_at)&&key.last_used_at>0)&&(!Object.hasOwn(key,'rotated')||key.rotated===true);
}
/** Generate a typed key and its SHA-256 here, so the raw value never leaves this browser except by the user copying it. */
export async function mintApiKey(type,cryptoProvider=globalThis.crypto){
 if(!Object.hasOwn(KEY_PREFIXES,type))fail('invalid_key_type');
 const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
 const key=KEY_PREFIXES[type]+Array.from(cryptoProvider.getRandomValues(new Uint8Array(43)),value=>alphabet[value&63]).join('');
 const key_hash=Array.from(new Uint8Array(await cryptoProvider.subtle.digest('SHA-256',new TextEncoder().encode(key))),value=>value.toString(16).padStart(2,'0')).join('');
 return {key,key_hash,key_type:type};
}
export function writeKeyState(key,now=Date.now()){return key.revoked?'revoked':key.authorization_active===false?'access removed':key.expires_at*1000<=now?'expired':'active';}
export async function loadAccountKeys(fetchPage,{projectId,environmentId='default',signal,onProgress=()=>{},maxKeys=KEY_HISTORY_LIMITS.keys,maxPages=KEY_HISTORY_LIMITS.pages,maxBytes=KEY_HISTORY_LIMITS.bytes,totalTimeoutMs=KEY_HISTORY_LIMITS.timeoutMs,sleep=wait}={}){
 if(!/^[a-z][a-z0-9-]{0,31}$/.test(environmentId)||typeof fetchPage!=='function'||typeof projectId!=='string'||!/^proj_[a-f0-9]{32}$/.test(projectId)||typeof onProgress!=='function'||typeof sleep!=='function'||
  !Number.isInteger(maxKeys)||maxKeys<1||maxKeys>KEY_HISTORY_LIMITS.keys||!Number.isInteger(maxPages)||maxPages<1||maxPages>KEY_HISTORY_LIMITS.pages||
  !Number.isInteger(maxBytes)||maxBytes<1||maxBytes>KEY_HISTORY_LIMITS.bytes||!Number.isInteger(totalTimeoutMs)||totalTimeoutMs<1||totalTimeoutMs>KEY_HISTORY_LIMITS.timeoutMs)fail('invalid_key_load_scope');
 cancelled(signal);const controller=new AbortController(),relay=()=>controller.abort();signal?.addEventListener('abort',relay,{once:true});
 let expired=false;const timer=setTimeout(()=>{expired=true;controller.abort();},totalTimeoutMs);
 const keyRows=[],ids=new Set(),seen=new Set();let after=null,bytes=0,pages=0;
 try{
  while(true){
   cancelled(controller.signal);if(++pages>maxPages)fail('key_history_too_large');let page;
   for(let retries=0;;retries++){
    try{page=await abortable(()=>fetchPage('keys'+(after?'?after='+encodeURIComponent(after):''),controller.signal),controller.signal);break;}
    catch(error){cancelled(controller.signal);if(error.status!==429)throw error;if(retries>=KEY_HISTORY_LIMITS.retries||!Number.isFinite(error.retryAfter)||error.retryAfter<1||error.retryAfter>60)fail('key_load_rate_limited');onProgress({loaded:keyRows.length,paused:true,retryAfter:error.retryAfter});await abortable(()=>sleep(error.retryAfter*1000,controller.signal),controller.signal);}
   }
   cancelled(controller.signal);
   if(!page||environmentId!=='default'&&page.environment_id!==environmentId||!Array.isArray(page.keys)||page.keys.length>100||!Object.hasOwn(page,'next')||page.next!==null&&(!validCursor(page.next)||seen.has(page.next)))fail('invalid_key_page');
   bytes+=new TextEncoder().encode(JSON.stringify(page.keys)).length;if(bytes>maxBytes||keyRows.length+page.keys.length>maxKeys)fail('key_history_too_large');
   for(const key of page.keys){if(!validKey(key,projectId,environmentId)||ids.has(key.id))fail('invalid_key_page');ids.add(key.id);keyRows.push({...key});}
   onProgress({loaded:keyRows.length,complete:page.next===null});if(page.next===null)return keyRows;
   after=page.next;seen.add(after);
  }
 }catch(error){if(expired)fail('key_load_deadline');if(controller.signal.aborted)fail('key_load_cancelled');throw error;}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',relay);}
}
// A timed-out mutation is ambiguous, not a failure receipt. Never retry it here.
export async function confirmKeyRevocation(request,{signal,timeoutMs=30000}={}){
 if(typeof request!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)fail('invalid_key_revoke_scope');
 cancelled(signal);const controller=new AbortController(),relay=()=>controller.abort();signal?.addEventListener('abort',relay,{once:true});const timer=setTimeout(()=>controller.abort(),timeoutMs);
 try{const result=await abortable(()=>request(controller.signal),controller.signal);cancelled(controller.signal);if(result?.revoked!==true)fail('key_revoke_unconfirmed');return result;}
 catch{fail('key_revoke_unconfirmed');}finally{clearTimeout(timer);signal?.removeEventListener('abort',relay);}
}
export function newestKeyId(rows){
 if(!Array.isArray(rows)||rows.length===0)return null;
 const withCreated=rows.filter(row=>Object.hasOwn(row,'created_at'));
 if(withCreated.length===0)return null;
 let newest=withCreated[0];
 for(const row of withCreated){if(row.created_at>newest.created_at)newest=row;}
 return newest.id;
}
