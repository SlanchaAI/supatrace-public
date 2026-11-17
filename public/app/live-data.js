// Watch one cheap change signal and report when it moves. This module never loads
// the trace list itself: the caller decides what a change is worth. One read at a
// time, no overlap, bounded backoff, and nothing runs while the page is not visible.
export const LIVE_LIMITS=Object.freeze({minMs:2000,maxMs:60000,defaultMs:5000,backoffMs:60000});
const fail=code=>{throw new Error(code);};
const valid=signal=>signal!==null&&typeof signal==='object'&&typeof signal.scope==='string'&&signal.scope.length>0&&Number.isSafeInteger(signal.value)&&signal.value>=0;
export function createLiveWatch({read,onChange,onState=()=>{},intervalMs=LIVE_LIMITS.defaultMs,visible=()=>true,setTimer=setTimeout,clearTimer=clearTimeout}={}){
 if(typeof read!=='function'||typeof onChange!=='function'||typeof onState!=='function'||typeof visible!=='function'||typeof setTimer!=='function'||typeof clearTimer!=='function'||
  !Number.isInteger(intervalMs)||intervalMs<LIVE_LIMITS.minMs||intervalMs>LIVE_LIMITS.maxMs)fail('invalid_live_scope');
 let running=false,generation=0,timer=null,job=null,baseline=null,failures=0,last=null;
 const state=(name,detail={})=>{if(name===last&&name!=='changed')return;last=name;try{onState(name,detail);}catch{/* A painter failure must not stop the watch. */}};
 const schedule=ms=>{timer=setTimer(tick,ms);};
 async function tick(){
  timer=null;if(!running)return;
  const mine=generation;
  if(!visible()){state('paused');schedule(intervalMs);return;}
  const controller=new AbortController();job=controller;let delay=intervalMs;
  try{
   const signal=await read(controller.signal);
   if(!running||mine!==generation)return;
   if(!valid(signal))fail('invalid_live_signal');
   failures=0;
   // A baseline taken without a matching seed says nothing about what the caller already
   // loaded, so it is reported once as a change: one extra reload instead of a missed upload.
   const fresh=baseline===null||baseline.scope!==signal.scope;
   if(fresh||baseline.value!==signal.value){
    baseline={scope:signal.scope,value:signal.value};state('changed');
    try{await onChange(signal);}catch{/* The caller reports its own load failures. */}
    if(!running||mine!==generation)return;
   }
   state('live');
  }catch(error){
   if(!running||mine!==generation)return;
   failures++;
   const asked=error?.status===429&&Number.isFinite(error.retryAfter)&&error.retryAfter>=1&&error.retryAfter<=60?error.retryAfter*1000:0;
   delay=Math.min(LIVE_LIMITS.backoffMs,Math.max(asked,intervalMs*2**Math.min(failures,6)));
   state('retrying',{delay});
  }finally{if(job===controller)job=null;}
  if(running&&mine===generation)schedule(delay);
 }
 return {
  // seed: a signal read before the caller last loaded its data. Starting from it means an
  // upload that landed between that load and this start still reports as a change, and an
  // unchanged account costs no reload. Without a usable seed the first read reports once.
  start(seed=null){if(running)return;running=true;generation++;baseline=valid(seed)?{scope:seed.scope,value:seed.value}:null;failures=0;last=null;state('starting');schedule(0);},
  stop(){if(!running)return;running=false;generation++;if(timer!==null){clearTimer(timer);timer=null;}job?.abort();job=null;state('stopped');},
  // Check now instead of waiting out the interval, for example when the tab becomes visible.
  poke(){if(!running||job!==null)return;if(timer!==null)clearTimer(timer);schedule(0);},
  get running(){return running;}
 };
}
