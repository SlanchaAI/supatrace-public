import test from 'node:test';import assert from 'node:assert/strict';
import {createLiveWatch,LIVE_LIMITS} from '../public/app/live-data.js';
// Manual clock: timers run only when the test says so.
function rig(overrides={}){
 const timers=[],states=[],changes=[],reads=[];let next=[],shown=true,id=0;
 const watch=createLiveWatch({read:async signal=>{reads.push(signal);const step=next.shift();if(step instanceof Error)throw step;if(typeof step==='function')return step(signal);return step;},
  onChange:value=>{changes.push(value.value);},onState:(name,detail)=>states.push(detail?.delay?name+':'+detail.delay:name),visible:()=>shown,
  setTimer:(fn,ms)=>{const timer={fn,ms,id:++id};timers.push(timer);return timer;},clearTimer:timer=>{const at=timers.indexOf(timer);if(at>=0)timers.splice(at,1);},...overrides});
 const fire=async()=>{const timer=timers.shift();assert.ok(timer,'expected a pending timer');await timer.fn();return timer.ms;};
 return {watch,timers,states,changes,reads,fire,feed:(...steps)=>next.push(...steps),show:value=>shown=value};
}
const at=(value,scope='proj|ws|default')=>({scope,value});
test('from a seed, only a moved counter reports a change',async()=>{
 const r=rig();r.feed(at(10),at(10),at(25),at(25));r.watch.start(at(10));assert.equal(r.timers[0].ms,0);
 await r.fire();assert.deepEqual(r.changes,[]);await r.fire();assert.deepEqual(r.changes,[]);await r.fire();assert.deepEqual(r.changes,[25]);await r.fire();assert.deepEqual(r.changes,[25]);
 assert.deepEqual(r.states,['starting','live','changed','live']);assert.equal(r.timers.length,1);assert.equal(r.timers[0].ms,LIVE_LIMITS.defaultMs);
});
test('a baseline acquired without a matching seed reports once: unseeded start and scope switch',async()=>{
 const bare=rig();bare.feed(at(10),at(10),at(11));bare.watch.start();await bare.fire();assert.deepEqual(bare.changes,[10]);await bare.fire();assert.deepEqual(bare.changes,[10]);await bare.fire();assert.deepEqual(bare.changes,[10,11]);
 const r=rig();r.feed(at(10),at(999,'other|ws|default'),at(999,'other|ws|default'),at(1000,'other|ws|default'));r.watch.start(at(10));await r.fire();assert.deepEqual(r.changes,[]);await r.fire();assert.deepEqual(r.changes,[999]);await r.fire();assert.deepEqual(r.changes,[999]);await r.fire();assert.deepEqual(r.changes,[999,1000]);
});
test('a seed read before the list was loaded catches an upload that landed before start',async()=>{
 const same=rig();same.feed(at(10),at(11));same.watch.start(at(10));await same.fire();assert.deepEqual(same.changes,[]);await same.fire();assert.deepEqual(same.changes,[11]);
 const moved=rig();moved.feed(at(12));moved.watch.start(at(10));await moved.fire();assert.deepEqual(moved.changes,[12]);
 for(const seed of [at(10,'other|ws|default'),null,{scope:'',value:1},{scope:'s',value:-1},'x']){const r=rig();r.feed(at(12),at(12));r.watch.start(seed);await r.fire();assert.deepEqual(r.changes,[12]);await r.fire();assert.deepEqual(r.changes,[12]);}
});
test('nothing is read while hidden, and poke checks at once when visible again',async()=>{
 const r=rig();r.feed(at(1),at(2));r.watch.start(at(1));await r.fire();r.show(false);await r.fire();await r.fire();assert.equal(r.reads.length,1);assert.equal(r.states.at(-1),'paused');
 r.show(true);r.watch.poke();assert.equal(r.timers.length,1);assert.equal(r.timers[0].ms,0);await r.fire();assert.deepEqual(r.changes,[2]);
});
test('reads never overlap and poke during a read is ignored',async()=>{
 let release;const r=rig();r.feed(()=>new Promise(resolve=>release=resolve));r.watch.start(at(1));const pending=r.fire();await Promise.resolve();
 assert.equal(r.timers.length,0);r.watch.poke();assert.equal(r.timers.length,0);release(at(1));await pending;assert.equal(r.reads.length,1);assert.equal(r.timers.length,1);
});
test('failures back off, honour a bounded Retry-After, and recover',async()=>{
 const r=rig({intervalMs:2000});r.feed(at(1),new Error('down'),new Error('down'),Object.assign(new Error('rate'),{status:429,retryAfter:30}),Object.assign(new Error('rate'),{status:429,retryAfter:9999}),at(1));
 r.watch.start(at(1));await r.fire();await r.fire();assert.equal(r.timers[0].ms,4000);await r.fire();assert.equal(r.timers[0].ms,8000);await r.fire();assert.equal(r.timers[0].ms,30000);await r.fire();assert.equal(r.timers[0].ms,32000);
 await r.fire();assert.equal(r.timers[0].ms,2000);assert.equal(r.states.at(-1),'live');assert.deepEqual(r.changes,[]);
 const many=rig({intervalMs:60000});many.feed(new Error('down'));many.watch.start();await many.fire();assert.equal(many.timers[0].ms,LIVE_LIMITS.backoffMs);
});
test('malformed signals are failures, never changes',async()=>{const r=rig();r.feed(at(1),null,{scope:'',value:1},{scope:'s',value:-1},{scope:'s',value:1.5},{scope:'s',value:'2'},at(1));r.watch.start(at(1));for(let i=0;i<7;i++)await r.fire();assert.deepEqual(r.changes,[]);assert.equal(r.states.filter(s=>s.startsWith('retrying')).length,1);assert.equal(r.states.at(-1),'live');});
test('stop aborts the read in flight, clears the timer and fences a late result; restart rebaselines',async()=>{
 let release;const r=rig();r.feed(at(1),()=>new Promise(resolve=>release=resolve));r.watch.start(at(1));await r.fire();const pending=r.fire();await Promise.resolve();
 r.watch.stop();assert.equal(r.reads[1].aborted,true);assert.equal(r.watch.running,false);release(at(50));await pending;assert.deepEqual(r.changes,[]);assert.equal(r.timers.length,0);assert.equal(r.states.at(-1),'stopped');
 r.feed(at(50),at(51));r.watch.start(at(50));r.watch.start(at(50));assert.equal(r.timers.length,1);await r.fire();assert.deepEqual(r.changes,[]);await r.fire();assert.deepEqual(r.changes,[51]);r.watch.stop();r.watch.stop();assert.equal(r.timers.length,0);
});
test('a failing change handler or painter does not stop the watch',async()=>{
 const r=rig({onChange:()=>{throw new Error('list failed');},onState:()=>{throw new Error('paint failed');}});r.feed(at(1),at(2),at(3));r.watch.start();await r.fire();await r.fire();await r.fire();assert.equal(r.timers.length,1);assert.equal(r.reads.length,3);
});
test('invalid scope builds nothing',()=>{for(const bad of [undefined,{},{read:()=>{}},{read:()=>{},onChange:()=>{},intervalMs:1999},{read:()=>{},onChange:()=>{},intervalMs:60001},{read:()=>{},onChange:()=>{},intervalMs:2500.5},{read:()=>{},onChange:()=>{},visible:true}])assert.throws(()=>createLiveWatch(bad),/invalid_live_scope/);});
