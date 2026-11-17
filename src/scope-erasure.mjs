import {createHash} from 'node:crypto';
import {alphaProject,projectPrefix,projectId} from './alpha-projects.mjs';

export const SCOPE_ERASURE_QUEUE='ERASURE#SCOPES';
const key=(owner,sk)=>({pk:'TENANT#'+owner,sk});
export const scopeErasureItem=(store,owner,project,environment=null)=>({Put:{Item:{pk:SCOPE_ERASURE_QUEUE,sk:[owner,project,environment??'*'].join('#'),owner,project,environment,ready_at:store.now()+600,phase:'keys'},ConditionExpression:'attribute_not_exists(pk)'}});
const retired=job=>key(job.owner,job.environment===null?'PROJECT_RETIRED#'+job.project:projectPrefix(job.owner,job.project)+'ENVIRONMENT_RETIRED#'+job.environment);
const prefix=(job,environment)=>'v1/'+createHash('sha256').update(job.owner+(projectPrefix(job.owner,job.project)?':project:'+job.project:'')+(environment==='default'?'':':environment:'+environment)).digest('hex')+'/';
function valid(job){
 alphaProject(job.owner);
 if(!projectId(job.project)||(job.environment===null&&job.project===alphaProject(job.owner).id)||(job.environment!==null&&!/^[a-z][a-z0-9-]{0,31}$/.test(job.environment))||job.environment==='default')throw Error('scope_erasure_invalid_job');
}
export function scopedRow(row,job){
 // Parent erasure already removed every environment's objects; absorb its child jobs before retiring their metadata.
 if(row.pk===SCOPE_ERASURE_QUEUE)return job.environment===null&&row.owner===job.owner&&row.project===job.project&&row.environment!==null;
 const pk='TENANT#'+job.owner,tag=projectPrefix(job.owner,job.project)+(job.environment===null?'':'ENV#'+job.environment+'#');
 if(row.pk===pk&&row.sk.startsWith(tag))return true;
 if(row.pk.startsWith(pk+'#'+tag))return true;
 // Keys, approved setups and ingest logs have explicit scope fields. Account/security rows do not.
 return row.tenant_id===job.owner&&(row.project_id??alphaProject(job.owner).id)===job.project&&(job.environment===null||(row.environment_id??'default')===job.environment)&&row.sk!=='META'&&!row.pk.startsWith('AUDIT#');
}
const unchanged=row=>{
 const names={},values={},checks=[];
 for(const [i,[name,value]]of Object.entries(row).entries()){names['#f'+i]=name;values[':v'+i]=value;checks.push('#f'+i+' = :v'+i);}
 return {ConditionExpression:checks.join(' AND '),ExpressionAttributeNames:names,ExpressionAttributeValues:values};
};
function batchRow(row,job){
 if(row.pk!=='TENANT#'+job.owner)return false;
 const parts=row.sk.slice(projectPrefix(job.owner,job.project).length).split('#');
 return (parts.length===2&&parts[0]==='BATCH')||(parts.length===4&&parts[0]==='ENV'&&parts[2]==='BATCH');
}
async function save(store,job){await store._send('PutCommand',{Item:job,ConditionExpression:'#owner = :owner',ExpressionAttributeNames:{'#owner':'owner'},ExpressionAttributeValues:{':owner':job.owner}});}
/** Producer: project/environment deletion. Caller: existing five-minute account-erasure EventBridge worker. */
export async function eraseScopes(env,{deadline=Date.now()+10000}={}){
 const {store}=env;let cursor,failed;
 do{
  const page=await store._page(SCOPE_ERASURE_QUEUE,'',{limit:25,cursor});
  for(const job of page.items){
   if(Date.now()>=deadline)break;
   if(job.ready_at>store.now()||(job.retry_at??0)>store.now())continue;
   // Full account erasure owns all of this scope once the parent closes.
   if((await store.getTenant(job.owner))?.deleted_at)continue;
   let result;
   try{result=await eraseScope(env,job,deadline);}
   catch(error){job.retry_at=store.now()+600;await save(store,job);failed??=error;continue;}
   if(failed)throw failed;return result;
  }
  cursor=page.next;
 }while(cursor&&Date.now()<deadline);
 if(failed)throw failed;return {processed:0};
}
async function eraseScope({store,objects},job,deadline){
 valid(job);const tombstone=await store._get(retired(job));
 if(!Number.isSafeInteger(tombstone?.deleted_at))throw Error('scope_erasure_not_retired');
 if(job.phase==='keys'){
  const page=await store._page('TENANT#'+job.owner,'KEY#',{limit:25,cursor:job.key_cursor});
  for(const row of page.items){
   if(Date.now()>=deadline)return {processed:1,phase:'keys'};
   if(!scopedRow(row,job)||row.revoked)continue;
   const scoped=Object.create(store);scoped.projectId=job.project;scoped.environmentId=row.environment_id??'default';
   await scoped.revokeWriteKey(job.owner,row.token_hash);
  }
  if(page.next){job.key_cursor=page.next;await save(store,job);return {processed:1,phase:'keys'};}
  const environments=new Set([job.environment??'default']);
  if(job.environment===null){
   for(const kind of ['ENVIRONMENT#','ENVIRONMENT_RETIRED#','ENVIRONMENT_CLEANUP#']){
    let cursor;do{const page=await store._page('TENANT#'+job.owner,projectPrefix(job.owner,job.project)+kind,{limit:100,cursor});
     for(const row of page.items){if(!/^[a-z][a-z0-9-]{0,31}$/.test(row.id??''))throw Error('scope_erasure_environment_invalid');environments.add(row.id);}cursor=page.next;
    }while(cursor);
   }
  }
  job.prefixes=[...environments].map(id=>prefix(job,id));job.phase='objects';delete job.key_cursor;await save(store,job);
 }
 while(job.phase==='objects'&&Date.now()<deadline){
  if(!job.prefixes.length){job.phase='metadata';await save(store,job);break;}
  const Prefix=job.prefixes[0],page=await objects.client.send(new objects.commands.ListObjectVersionsCommand({Bucket:objects.bucket,Prefix,MaxKeys:25}));
  const versions=[...(page.Versions??[]),...(page.DeleteMarkers??[])];
  for(const row of versions){
   if(!row.Key?.startsWith(Prefix)||!row.VersionId)throw Error('scope_erasure_object_scope_mismatch');
   if(Date.now()>=deadline)return {processed:1,phase:job.phase};
   await objects.client.send(new objects.commands.DeleteObjectCommand({Bucket:objects.bucket,Key:row.Key,VersionId:row.VersionId}));
  }
  if(!versions.length){job.prefixes.shift();await save(store,job);}
 }
 while(job.phase==='metadata'&&Date.now()<deadline){
  const page=await store._send('ScanCommand',{Limit:25,ConsistentRead:true,...(job.cursor?{ExclusiveStartKey:job.cursor}:{})});
  for(const row of page.Items??[]){
   if(Date.now()>=deadline)return {processed:1,phase:job.phase};
   if(!scopedRow(row,job))continue;
   const bytes=batchRow(row,job)?row.byte_count:0;
   if(bytes!==0&&(!Number.isSafeInteger(bytes)||bytes<0))throw Error('scope_erasure_invalid_bytes');
   await store._tx([{Delete:{Key:{pk:row.pk,sk:row.sk},...unchanged(row)}},
    bytes?{Update:{Key:key(job.owner,'META'),UpdateExpression:'ADD used_bytes :release',ConditionExpression:'attribute_not_exists(deleted_at) AND used_bytes >= :bytes',ExpressionAttributeValues:{':release':-bytes,':bytes':bytes}}}:{ConditionCheck:{Key:key(job.owner,'META'),ConditionExpression:'attribute_exists(pk) AND attribute_not_exists(deleted_at)'}},
    ...(bytes?[{Update:{Key:{pk:'SYS',sk:'CAPACITY'},UpdateExpression:'ADD used_bytes :release',ConditionExpression:'used_bytes >= :bytes',ExpressionAttributeValues:{':release':-bytes,':bytes':bytes}}}]:[])]);
  }
  if(page.LastEvaluatedKey){job.cursor=page.LastEvaluatedKey;await save(store,job);}
  else{
   await store._tx([{Update:{Key:retired(job),UpdateExpression:'SET erased_at = :now',ConditionExpression:'deleted_at = :closed',ExpressionAttributeValues:{':now':store.now(),':closed':tombstone.deleted_at}}},{Delete:{Key:{pk:job.pk,sk:job.sk}}}]);
   return {processed:1,phase:'complete'};
  }
 }
 return {processed:1,phase:job.phase};
}
