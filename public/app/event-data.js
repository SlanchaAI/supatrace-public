// Validate one accepted-batch page without rewriting original event fields.
// This is a parsed-page guard, not a network byte cap or whole-run snapshot.
export const EVENT_READ_LIMITS=Object.freeze({timeoutMs:30000,events:100,bytes:524288,dataBytes:32768,cursorChars:2048});
const fail=code=>{throw new Error(code);};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
export function validateEventPage(page){
 if(!object(page)||!Array.isArray(page.events)||page.events.length>EVENT_READ_LIMITS.events||!Object.hasOwn(page,'next')||page.next!==null&&(typeof page.next!=='string'||!page.next||page.next.length>EVENT_READ_LIMITS.cursorChars||!/^[A-Za-z0-9_-]+$/.test(page.next)))fail('invalid_event_page');
 let bytes;try{bytes=new TextEncoder().encode(JSON.stringify(page.events)).length;}catch{fail('invalid_event_page');}if(bytes>EVENT_READ_LIMITS.bytes)fail('invalid_event_page');
 const seen=new Set();
 for(const event of page.events){
  if(!object(event)||!id(event.id)||seen.has(event.id)||typeof event.time!=='string'||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(event.time)||!Number.isFinite(Date.parse(event.time))||!['request','tool_call','tool_result','response','error','note'].includes(event.kind)||typeof event.name!=='string'||!event.name.trim()||event.name.length>200||!Object.hasOwn(event,'data')||event.data===undefined)fail('invalid_event_page');
  let data;try{data=JSON.stringify(event.data);}catch{fail('invalid_event_page');}if(data===undefined||new TextEncoder().encode(data).length>EVENT_READ_LIMITS.dataBytes)fail('invalid_event_page');seen.add(event.id);
 }
 return {events:page.events,next:page.next,bytes};
}
export async function readEventPage(request,{signal,timeoutMs=EVENT_READ_LIMITS.timeoutMs}={}){
 if(typeof request!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>EVENT_READ_LIMITS.timeoutMs)fail('invalid_event_read_scope');
 if(signal?.aborted)fail('event_read_cancelled');const controller=new AbortController(),relay=()=>controller.abort();signal?.addEventListener('abort',relay,{once:true});let expired=false;
 const timer=setTimeout(()=>{expired=true;controller.abort();},timeoutMs);
 try{
  const page=await new Promise((resolve,reject)=>{
   const abort=()=>{controller.signal.removeEventListener('abort',abort);reject(new Error('event_read_cancelled'));};controller.signal.addEventListener('abort',abort,{once:true});let work;try{work=request(controller.signal);}catch(error){work=Promise.reject(error);}
   Promise.resolve(work).then(value=>{controller.signal.removeEventListener('abort',abort);resolve(value);},error=>{controller.signal.removeEventListener('abort',abort);reject(error);});
  });
  if(controller.signal.aborted)fail('event_read_cancelled');return validateEventPage(page);
 }catch(error){if(expired)fail('event_read_deadline');if(controller.signal.aborted)fail('event_read_cancelled');throw error;}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',relay);}
}
