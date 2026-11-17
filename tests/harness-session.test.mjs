// Fixture sessions use the same bounded allocator as production; never retry uncertain writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {start} from './harness.mjs';
import {digest} from '../src/aws-auth.mjs';
import {first,collisions,free,token,withSessionTokens} from './session-token-fixtures.mjs';
async function fixture(options={}){const live=await start(options);await live.store.getOrCreateTenant(1);await live.store.createSession(digest(token(first)),'github-1');return live;}
test('loopback sign-in recovers confirmed slot collision and preserves the occupied session',async()=>{
 const live=await fixture(),cookies=[];
 try{const tenant=await withSessionTokens([collisions[0],free[0]],()=>live.signIn({addCookies:async v=>cookies.push(...v)},2));assert.equal(tenant,'github-2');assert.equal(cookies.length,1);assert.equal(cookies[0].value,token(free[0]));assert.equal((await live.store.getSession(digest(token(first)))).tenant_id,'github-1');assert.equal((await live.store.getSession(digest(cookies[0].value))).tenant_id,'github-2');assert.equal(await live.store.getSession(digest(token(collisions[0]))),null);}finally{await live.close();}
});
test('loopback sign-in stops after three confirmed collisions and never sets a browser cookie',async()=>{
 const live=await fixture();let cookies=0;
 try{await withSessionTokens(collisions,()=>assert.rejects(live.signIn({addCookies:async()=>{cookies++;}},2),e=>e.status===503&&e.code==='session_unavailable'));assert.equal(cookies,0);assert.equal((await live.store.getSession(digest(token(first)))).tenant_id,'github-1');}finally{await live.close();}
});
test('uncertain fixture write is not retried and sets no cookie even if the session committed',async()=>{
 const live=await start(),create=live.store.createSession.bind(live.store);let calls=0,cookies=0;
 live.store.createSession=async(...args)=>{calls++;await create(...args);throw Error('synthetic_unknown_write');};
 try{await withSessionTokens([free[0]],()=>assert.rejects(live.signIn({addCookies:async()=>{cookies++;}},2),/synthetic_unknown_write/));assert.equal(calls,1);assert.equal(cookies,0);assert.equal((await live.store.getSession(digest(token(free[0])))).tenant_id,'github-2');}finally{await live.close();}
});

test('explicit local preview sign-in uses the same allocator and preserves its one-hour cookie',async()=>{
 const live=await fixture({localDev:true});
 try{const response=await withSessionTokens([collisions[0],free[0]],()=>fetch(live.origin+'/__local__/signin?account=5252',{redirect:'manual'}));assert.equal(response.status,303);assert.equal(response.headers.get('location'),'/app/#home');assert.match(response.headers.get('set-cookie'),/Max-Age=3600/);assert.equal(response.headers.get('set-cookie').split(';')[0],'__Host-supatrace='+token(free[0]));assert.equal((await live.store.getSession(digest(token(first)))).tenant_id,'github-1');assert.equal((await live.store.getSession(digest(token(free[0])))).tenant_id,'github-5252');}finally{await live.close();}
});
