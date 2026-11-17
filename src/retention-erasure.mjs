import {createHash} from 'node:crypto';
import {alphaProject} from './alpha-projects.mjs';

const checkpoint={pk:'SYS',sk:'RETENTION_SWEEP'};
const hash=value=>createHash('sha256').update(value).digest('hex');
const key=row=>({pk:row.pk,sk:row.sk});
const unchanged=row=>{
 const names={},values={},checks=[];
 for(const [i,[name,value]]of Object.entries(row).entries()){names['#f'+i]=name;values[':v'+i]=value;checks.push('#f'+i+' = :v'+i);}
 return {ConditionExpression:checks.join(' AND '),ExpressionAttributeNames:names,ExpressionAttributeValues:values};
};
function scope(row){
 if(row.status!=='accepted'||row.retention_erased_at!==undefined||!Number.isSafeInteger(row.retention_expires_at))return null;
 if(row.pk!=='TENANT#'+row.tenant_id)return null;
 const match=/^(?:PROJECT#(proj_[a-f0-9]{32})#)?(?:ENV#([a-z][a-z0-9-]{0,31})#)?BATCH#(.+)$/.exec(row.sk);
 if(!match)return null;
 const owner=row.tenant_id,project=match[1],environment=match[2];alphaProject(owner);
 if(project===alphaProject(owner).id||environment==='default'||match[3]!==row.batch_id||!Number.isSafeInteger(row.upload_seq)||row.upload_seq<1||
  !Number.isSafeInteger(row.byte_count)||row.byte_count<1||!Number.isSafeInteger(row.event_count)||row.event_count<1||
  !Number.isSafeInteger(row.retention_days)||row.retention_days<1||typeof row.run_id!=='string'||!row.run_id||!(/^[a-f0-9]{64}$/).test(row.request_hash))throw Error('retention_invalid_batch');
 const expected='v1/'+hash(owner+(project?':project:'+project:'')+(environment?':environment:'+environment:''))+'/'+row.request_hash+'.json';
 if(row.object_key!==expected)throw Error('retention_object_scope_mismatch');
 const tag=(project?'PROJECT#'+project+'#':'')+(environment?'ENV#'+environment+'#':'');
 return {owner,index:{pk:row.pk+'#'+tag+'RUN#'+row.run_id,sk:'BATCH#~'+String(row.upload_seq).padStart(10,'0')+'#'+row.batch_id},run:{pk:row.pk,sk:tag+'RUN#'+row.run_id}};
}
/** Producer: immutable retention stamps on accepted batches. Caller: five-minute erasure schedule.
 * Default dry run never deletes objects or changes catalog/counters. Legacy unstamped data is excluded.
 */
export async function eraseRetention({store,objects,RETENTION_ERASURE_MODE},{deadline=Date.now()+10000,dryRun=RETENTION_ERASURE_MODE!=='execute'}={}){
 const saved=await store._get(checkpoint);let cursor=saved?.cursor,examined=0,eligible=0,deleted=0,bytes=0;
 do{
  const page=await store._send('ScanCommand',{Limit:25,ConsistentRead:true,...(cursor?{ExclusiveStartKey:cursor}:{})});
  for(const row of page.Items??[]){
   if(Date.now()>=deadline)return {processed:deleted,dry_run:dryRun,examined,eligible,bytes};
   examined++;
   if(row.status!=='accepted'||row.retention_erased_at!==undefined||!Number.isSafeInteger(row.retention_expires_at)||row.retention_expires_at>store.now())continue;
   const target=scope(row);if(!target)continue;
   const owner=await store.getTenant(target.owner);if(!owner||owner.deleted_at)continue;
   const current=await store._get(key(row));if(!current||current.retention_erased_at!==undefined||Object.entries(row).some(([name,value])=>JSON.stringify(current[name])!==JSON.stringify(value)))continue;
   const index=await store._get(target.index),run=await store._get(target.run);
   if(!index||['tenant_id','batch_id','request_hash','object_key','byte_count','event_count','retention_expires_at'].some(name=>index[name]!==row[name])||
    !run||run.run_id!==row.run_id||!Number.isSafeInteger(run.batch_count)||run.batch_count<1||
    run.byte_count!==undefined&&(!Number.isSafeInteger(run.byte_count)||run.byte_count<row.byte_count)||
    run.event_count!==undefined&&(!Number.isSafeInteger(run.event_count)||run.event_count<row.event_count))throw Error('retention_catalog_mismatch');
   eligible++;bytes+=row.byte_count;if(dryRun)continue;
   // Keep the accepted batch marker permanently: retries cannot recreate this content-addressed key
   // while an overlapping expired-data worker might still be deleting its versions.
   let versions;
   do{
    if(Date.now()>=deadline)return {processed:deleted,dry_run:dryRun,examined,eligible,bytes};
    const page=await objects.client.send(new objects.commands.ListObjectVersionsCommand({Bucket:objects.bucket,Prefix:row.object_key,MaxKeys:25}));
    versions=[...(page.Versions??[]),...(page.DeleteMarkers??[])];
    for(const version of versions){
     if(version.Key!==row.object_key||!version.VersionId)throw Error('retention_object_scope_mismatch');
     if(Date.now()>=deadline)return {processed:deleted,dry_run:dryRun,examined,eligible,bytes};
     await objects.client.send(new objects.commands.DeleteObjectCommand({Bucket:objects.bucket,Key:version.Key,VersionId:version.VersionId}));
    }
   }while(versions.length);
   const runChange=run.batch_count===1?{Delete:{Key:target.run,...unchanged(run)}}:{Update:{Key:target.run,
    UpdateExpression:'ADD batch_count :minus'+(Number.isSafeInteger(run.byte_count)?', byte_count :bytes':'')+(Number.isSafeInteger(run.event_count)?', event_count :events':''),
    ...unchanged(run),ExpressionAttributeValues:{...unchanged(run).ExpressionAttributeValues,':minus':-1,...(Number.isSafeInteger(run.byte_count)?{':bytes':-row.byte_count}:{}),...(Number.isSafeInteger(run.event_count)?{':events':-row.event_count}:{})}}};
   try{await store._tx([
    {Update:{Key:key(row),UpdateExpression:'SET retention_erased_at = :erased',...unchanged(row),ConditionExpression:unchanged(row).ConditionExpression+' AND attribute_not_exists(retention_erased_at)',ExpressionAttributeValues:{...unchanged(row).ExpressionAttributeValues,':erased':store.now()}}},{Delete:{Key:target.index,...unchanged(index)}},runChange,
    {Update:{Key:{pk:row.pk,sk:'META'},UpdateExpression:'ADD used_bytes :release',ConditionExpression:'attribute_exists(pk) AND attribute_not_exists(deleted_at) AND used_bytes >= :bytes',ExpressionAttributeValues:{':release':-row.byte_count,':bytes':row.byte_count}}},
    {Update:{Key:{pk:'SYS',sk:'CAPACITY'},UpdateExpression:'ADD used_bytes :release',ConditionExpression:'used_bytes >= :bytes',ExpressionAttributeValues:{':release':-row.byte_count,':bytes':row.byte_count}}}
   ]);deleted++;}catch(error){
    if(!['TransactionCanceledException','ConditionalCheckFailedException'].includes(error.name))throw error;
    // A concurrent append or cleanup won. Objects were already expired; retry metadata without double release.
    return {processed:deleted,dry_run:dryRun,examined,eligible,bytes};
   }
  }
  cursor=page.LastEvaluatedKey;
  await store._send('PutCommand',{Item:{...checkpoint,...(cursor?{cursor}:{}),checked_at:store.now(),dry_run:dryRun,eligible,deleted}});
 }while(cursor&&Date.now()<deadline);
 return {processed:deleted,dry_run:dryRun,examined,eligible,bytes};
}
