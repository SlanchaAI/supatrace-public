import test from 'node:test';
import assert from 'node:assert/strict';
import {DynamoMetadataStore,digest} from '../src/dynamodb-store.mjs';
import {MemoryDynamo,commandClasses} from './memory-dynamo.mjs';
import {environmentStore} from '../src/workspaces.mjs';
import {eraseRetention} from '../src/retention-erasure.mjs';
import {eraseAccounts} from '../src/account-deletion.mjs';
const owner='github-7',DAY=86400;
async function fixture(){
 let now=1700000000;const client=new MemoryDynamo(),store=new DynamoMetadataStore({client,commands:commandClasses(),tableName:'synthetic',now:()=>now});await store.getOrCreateTenant(7);
 const versions=[],removed=[];class ListObjectVersionsCommand{constructor(input){this.input=input;}}class DeleteObjectCommand{constructor(input){this.input=input;}}
 let beforeDelete=null,failDelete=false;
 const objects={bucket:'synthetic',commands:{ListObjectVersionsCommand,DeleteObjectCommand},client:{send:async command=>{
  if(command instanceof ListObjectVersionsCommand)return {Versions:versions.filter(v=>v.Key.startsWith(command.input.Prefix)&&!v.marker).slice(0,25),DeleteMarkers:versions.filter(v=>v.Key.startsWith(command.input.Prefix)&&v.marker).slice(0,25)};
  if(failDelete)throw Error('synthetic_storage_failure');
  if(beforeDelete){const hook=beforeDelete;beforeDelete=null;await hook();}
  const i=versions.findIndex(v=>v.Key===command.input.Key&&v.VersionId===command.input.VersionId);if(i>=0)removed.push(versions.splice(i,1)[0]);return {};
 }}};
 const upload=async(run,batch,target=store)=>{const raw=JSON.stringify({version:1,batch_id:batch,run_id:run,events:[{id:batch,time:'2026-01-01T00:00:00Z',kind:'note',name:'Synthetic',data:{safe:true}}]}),request_hash=digest(raw),row=await target.reserveBatch(owner,{batch_id:batch,run_id:run,request_hash,byte_count:Buffer.byteLength(raw),event_count:1});versions.push({Key:row.object_key,VersionId:batch+'-v1'},{Key:row.object_key,VersionId:batch+'-v2'},{Key:row.object_key,VersionId:batch+'-marker',marker:true});await target.acceptReservedBatch(owner,batch,request_hash,{writer:digest('writer'),started_at:1,ended_at:2,has_error:false});return row;};
 return {store,client,objects,versions,removed,upload,env:{store,objects,RETENTION_ERASURE_MODE:'execute'},advance:days=>now+=days*DAY,root:()=>client.items.get('TENANT#'+owner+'\0META'),row:sk=>client.items.get('TENANT#'+owner+'\0'+sk),hook:f=>beforeDelete=f,fail:f=>failDelete=f};
}
async function sweep(f,options){let total=0;for(let i=0;i<20;i++){const r=await eraseRetention(f.env,options);total+=r.processed;if(!f.client.items.get('SYS\0RETENTION_SWEEP')?.cursor)return {...r,total};}throw Error('synthetic_sweep_unbounded');}

test('dry run finds expired accepted stamps without deleting payload/catalog or releasing storage',async()=>{
 const f=await fixture(),batch=await f.upload('expired','b1');f.advance(8);const before=structuredClone([...f.client.items.values()]);
 const r=await eraseRetention({...f.env,RETENTION_ERASURE_MODE:undefined});assert.equal(r.dry_run,true);assert.equal(r.eligible,1);assert.equal(r.bytes,batch.byte_count);assert.equal(r.processed,0);assert.equal(f.removed.length,0);
 assert.deepEqual([...f.client.items.values()].filter(v=>v.sk!=='RETENTION_SWEEP'),before);assert.equal(f.versions.length,3);
});
test('real scheduled caller erases all exact versions and catalog, releases bytes once, retains monthly meters and sibling data',async()=>{
 const f=await fixture(),expired=await f.upload('expired','b1');f.advance(8);const kept=await f.upload('retained','b2'),used=f.root().used_bytes;
 const r=await eraseAccounts(f.env);assert.equal(r.processed,1);assert.equal(f.row('BATCH#b1').retention_erased_at,f.store.now());assert.equal(f.row('RUN#expired'),undefined);assert.equal([...f.client.items.values()].filter(r=>r.batch_id==='b1').length,1);
 assert.equal(f.versions.some(v=>v.Key===expired.object_key),false);assert.equal(f.versions.filter(v=>v.Key===kept.object_key).length,3);assert.equal(f.root().used_bytes,used-expired.byte_count);assert.equal(f.client.items.get('SYS\0CAPACITY').used_bytes,used-expired.byte_count);
 const meter=[...f.client.items.values()].find(r=>r.sk.startsWith('USAGE#'));assert.equal(meter.accepted_spans,2);await sweep(f);assert.equal(f.root().used_bytes,kept.byte_count);assert.equal(f.removed.length,3);
});
test('mixed run retains unexpired batch and correct counters, and a concurrent append retries safely',async()=>{
 const f=await fixture(),old=await f.upload('mixed','old');f.advance(8);await f.upload('mixed','new');let original=f.root().used_bytes;
 f.hook(async()=>{await f.upload('mixed','racing');});await eraseRetention(f.env);assert.ok(f.row('BATCH#old'));assert.equal(f.versions.some(v=>v.Key===old.object_key),false);
 await sweep(f);assert.equal(f.row('BATCH#old').retention_erased_at,f.store.now());assert.equal(f.row('RUN#mixed').batch_count,2);assert.equal(f.row('RUN#mixed').event_count,2);assert.equal(f.row('RUN#mixed').byte_count,f.root().used_bytes);assert.ok(f.root().used_bytes>=original-old.byte_count);
});
test('unstamped legacy, pending, not-yet-expired and closed-account batches are never deleted',async()=>{
 const f=await fixture();await f.upload('legacy','legacy');for(const row of f.client.items.values())if(row.batch_id==='legacy'||row.run_id==='legacy'){delete row.retention_expires_at;delete row.retention_days;}
 f.advance(8);await f.upload('new','new');await f.store.reserveBatch(owner,{batch_id:'pending',run_id:'pending',request_hash:digest('pending'),byte_count:7,event_count:1});await sweep(f);assert.equal(f.removed.length,0);assert.ok(f.row('BATCH#legacy'));assert.ok(f.row('BATCH#pending'));
 f.advance(8);f.root().deleted_at=f.store.now();await sweep(f);assert.equal(f.removed.length,0);
});
test('object-key and catalog scope corruption fail closed before any deletion',async()=>{
 for(const mutation of ['object','index','batch','sequence']){const f=await fixture();await f.upload('expired','b1');f.advance(8);
  if(mutation==='object')f.row('BATCH#b1').object_key='v1/'+digest('foreign')+'/'+digest('foreign')+'.json';
  if(mutation==='index')[...f.client.items.values()].find(r=>r.pk.endsWith('#RUN#expired')).tenant_id='github-9';
  if(mutation==='batch')f.row('BATCH#b1').batch_id='foreign';if(mutation==='sequence')f.row('BATCH#b1').upload_seq=0;
  await assert.rejects(()=>eraseRetention(f.env),/retention_/);assert.equal(f.removed.length,0);
 }
});
test('storage failure leaves catalog and capacity intact for retry',async()=>{
 const f=await fixture();await f.upload('expired','b1');f.advance(8);const used=f.root().used_bytes;f.fail(true);await assert.rejects(()=>eraseRetention(f.env),/synthetic_storage_failure/);assert.ok(f.row('BATCH#b1'));assert.equal(f.root().used_bytes,used);f.fail(false);await sweep(f);assert.equal(f.root().used_bytes,0);
});
test('project and environment stamps map to exact isolated catalog and object namespaces',async()=>{
 const f=await fixture(),project='proj_'+ 'a'.repeat(32);await f.store._send('PutCommand',{Item:{pk:'TENANT#'+owner,sk:'PROJECT_META#'+project,id:project}});
 const scoped=environmentStore(f.store,{owner,project,environment:'staging'}),expired=await f.upload('same','same',scoped);f.advance(8);const retained=await f.upload('same','same');await sweep(f);
 assert.equal(f.versions.some(v=>v.Key===expired.object_key),false);assert.equal(f.versions.filter(v=>v.Key===retained.object_key).length,3);assert.equal((await f.store.getRun(owner,'same')).batch_count,1);assert.equal(await scoped.getRun(owner,'same'),null);
});
test('persistent scan cursor reaches expired rows past the first page within bounded invocations',async()=>{
 const f=await fixture();for(let i=0;i<90;i++)await f.store._send('PutCommand',{Item:{pk:'A'+String(i).padStart(3,'0'),sk:'synthetic'}});await f.upload('expired','b1');f.advance(8);await sweep(f);assert.equal(f.row('BATCH#b1').retention_erased_at,f.store.now());assert.ok(f.client.items.get('SYS\0RETENTION_SWEEP'));
});

test('overlapping workers retain accepted tombstone so identical retry cannot recreate an erased object key',async()=>{
 const f=await fixture(),expired=await f.upload('expired','same');f.advance(8);const used=f.root().used_bytes;
 f.hook(async()=>{
  await eraseRetention(f.env);
  const retry=await f.store.reserveBatch(owner,{batch_id:expired.batch_id,run_id:expired.run_id,request_hash:expired.request_hash,byte_count:expired.byte_count,event_count:expired.event_count});
  assert.equal(retry.status,'accepted');assert.equal(retry.retention_erased_at,f.store.now());
  // storeBatch writes payloads only for a fresh reservation; this retry cannot put an object.
  assert.equal(f.versions.length,0);
 });
 await eraseRetention(f.env);await sweep(f);assert.equal(f.root().used_bytes,used-expired.byte_count);assert.equal(f.removed.length,3);assert.equal(f.versions.length,0);
 assert.equal(f.row('BATCH#same').status,'accepted');assert.equal(f.row('BATCH#same').retention_erased_at,f.store.now());
});
