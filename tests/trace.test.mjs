import test from 'node:test'; import assert from 'node:assert/strict'; import {parseBatch,hash} from '../src/trace.mjs';
const batch=()=>({version:1,batch_id:'batch-1',run_id:'run-1',events:[{id:'event-1',time:'2026-10-21T00:00:00Z',kind:'note',name:'Synthetic fixture',data:{message:'safe'}}]});
const run=b=>parseBatch(JSON.stringify(b));
test('valid event round trips without mutating content',()=>{assert.equal(run(batch()).batch.events[0].data.message,'safe');});
test('canonical hash independent of object key order',()=>assert.equal(hash({a:1,b:2}),hash({b:2,a:1})));
test('same batch retry has same identity',()=>assert.deepEqual(run(batch()),run(batch())));
test('changed content differs despite same batch id',()=>{let b=batch();b.events[0].data.message='new';assert.notEqual(run(b).content_hash,run(batch()).content_hash);});
test('rejects tenant supplied by caller',()=>{let b=batch();b.tenant_id='someone-else';assert.throws(()=>run(b),/Unexpected/);});
test('rejects oversized raw body',()=>assert.throws(()=>parseBatch(' '.repeat(524289)),/512/));
test('rejects excessive event count',()=>{let b=batch();b.events=Array(101).fill(b.events[0]);assert.throws(()=>run(b),/1–100/);});
test('rejects duplicate event identifiers',()=>{let b=batch();b.events.push(b.events[0]);assert.throws(()=>run(b),/Duplicate/);});
test('rejects missing timezone',()=>{let b=batch();b.events[0].time='2026-10-21T00:00:00';assert.throws(()=>run(b),/timezone/);});
test('rejects oversized event data',()=>{let b=batch();b.events[0].data='x'.repeat(32769);assert.throws(()=>run(b),/32 KiB/);});
test('preserves hostile text only as data',()=>{let b=batch();b.events[0].data='<script>alert(1)</script>';assert.equal(run(b).batch.events[0].data,b.events[0].data);});
test('rejects unknown kind',()=>{let b=batch();b.events[0].kind='admin';assert.throws(()=>run(b),/kind/);});

test('deep JSON rejected before recursive hash',()=>{let b=batch();b.events[0].data=JSON.parse('['.repeat(1000)+'0'+']'.repeat(1000));assert.throws(()=>run(b),/nesting/);});

test('rejects numeric overflow and unsafe integers instead of changing export data',()=>{for(const literal of ['1e309','9007199254740993']){const raw=JSON.stringify(batch()).replace('{\"message\":\"safe\"}',literal);assert.throws(()=>parseBatch(raw),/encoded as strings/);}});
