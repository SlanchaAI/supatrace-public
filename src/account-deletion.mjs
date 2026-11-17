import {createHash} from 'node:crypto';
import {HttpError,boundedText,json,requireOrigin} from './http.mjs';
import {Workspaces,workspaceSession} from './workspaces.mjs';
import {alphaProject,projectPrefix} from './alpha-projects.mjs';
import {settleOverage} from './plan-overage.mjs';
import {eraseScopes} from './scope-erasure.mjs';
import {eraseRetention} from './retention-erasure.mjs';

const key=(owner,sk)=>({pk:'TENANT#'+owner,sk});
const fail=(status,code)=>{throw new HttpError(status,code);};
export const ERASURE_QUEUE='ERASURE#JOBS';
// Wait out requests already in flight before physical removal. API requests have a 15-second deadline.
export async function erasureItem(store,owner){
 alphaProject(owner);
 const projects=[alphaProject(owner).id],prefixes=[];
 for(const kind of ['PROJECT_META#','PROJECT_RETIRED#']){let cursor;do{const page=await store._page('TENANT#'+owner,kind,{limit:100,cursor});
  for(const row of page.items){if(typeof row.id!=='string'||!/^proj_[a-f0-9]{32}$/.test(row.id))throw Error('erasure_project_inventory_invalid');projects.push(row.id);}cursor=page.next;
 }while(cursor);}
 for(const project of new Set(projects)){
  const environments=['default'],tag=projectPrefix(owner,project);
  // Retired environments retain objects after their keys have been cleaned up.
  for(const prefix of ['ENVIRONMENT#','ENVIRONMENT_RETIRED#','ENVIRONMENT_CLEANUP#']){
   let cursor;do{const page=await store._page('TENANT#'+owner,tag+prefix,{limit:100,cursor});
    for(const row of page.items){if(typeof row.id!=='string'||!/^([a-z][a-z0-9-]{0,31})$/.test(row.id))throw Error('erasure_environment_inventory_invalid');environments.push(row.id);}cursor=page.next;
   }while(cursor);
  }
  for(const id of new Set(environments))prefixes.push('v1/'+createHash('sha256').update(owner+(tag?':project:'+project:'')+(id==='default'?'':':environment:'+id)).digest('hex')+'/');
 }
 return {Put:{Item:{pk:ERASURE_QUEUE,sk:owner,owner,ready_at:store.now()+600,phase:'billing',prefixes},ConditionExpression:'attribute_not_exists(pk)'}};
}
export async function deleteAccount(request,env,actor,session){
 if(request.method!=='POST')fail(405,'method_not_allowed');
 requireOrigin(request,env.APP_ORIGIN);
 let data;try{data=JSON.parse(await boundedText(request,1024));}catch(error){if(error instanceof SyntaxError)fail(400,'invalid_json');throw error;}
 if(!data||Array.isArray(data)||Object.keys(data).join()!=='confirm'||data.confirm!=='DELETE')fail(400,'account_delete_confirmation_required');
 const store=env.store,stamp=await workspaceSession(request,store,actor);
 if(session.expires_at<=store.now()+86400-600)fail(403,'recent_sign_in_required');
 const row=await store.getTenant(actor);
 if(row?.commercial_managed===true||(typeof store.hasStripeTestBinding==='function'&&await store.hasStripeTestBinding(actor)))fail(409,'legacy_billing_requires_operator_closure');
 const capacity=await store._get(key(actor,'ORGANIZATION#CAPACITY'));
 if((capacity?.count??0)>0)fail(409,'owned_organizations_require_transfer_or_deletion');
 const spaces=new Workspaces(store,stamp);
 await spaces.tx([
  {Update:{Key:key(actor,'META'),UpdateExpression:'SET deleted_at = :now, session_epoch = :next',ConditionExpression:'attribute_exists(pk) AND attribute_not_exists(deleted_at) AND attribute_not_exists(commercial_managed)',ExpressionAttributeValues:{':now':store.now(),':next':stamp.epoch+1}}},
  {ConditionCheck:{Key:key(actor,'ORGANIZATION#CAPACITY'),ConditionExpression:'attribute_not_exists(#n) OR #n = :zero',ExpressionAttributeNames:{'#n':'count'},ExpressionAttributeValues:{':zero':0}}},
  await erasureItem(store,actor)
 ]);
 const response=json({deleted:true,erasure:'queued',backup_expiry_days:35},202);
 response.headers.append('set-cookie','__Host-supatrace=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0');return response;
}

// Match complete ownership values, never substring matches against serialized data.
export function ownedRow(row,owner){
 return row.pk!==ERASURE_QUEUE&&(row.owner===owner||row.org===owner||row.native_id===owner||row.pk==='TENANT#'+owner||row.pk.startsWith('TENANT#'+owner+'#')||row.pk==='AUDIT#'+owner||row.tenant_id===owner||row.target_tenant===owner||row.workspace_id===owner||row.user_id===owner||row.recipient_id===owner||row.issued_by===owner);
}
async function save(store,job){await store._send('PutCommand',{Item:job,ConditionExpression:'#owner = :owner',ExpressionAttributeNames:{'#owner':'owner'},ExpressionAttributeValues:{':owner':job.owner}});}
/** Producer: account closure / organization deletion. Caller: the five-minute EventBridge rule on the API Lambda. */
export async function eraseAccounts(env,{deadline=Date.now()+10000}={}){
 const {store}=env;let cursor,failed;
 do{
  const page=await store._page(ERASURE_QUEUE,'',{limit:25,cursor});
  for(const job of page.items){
   if(Date.now()>=deadline){if(failed)throw failed;return {processed:0};}
   if(job.ready_at>store.now()||(job.retry_at??0)>store.now())continue;
   let result;
   try{result=await eraseAccount(env,job,deadline);}
   catch(error){
    // A refused customer or a corrupt job must not starve unrelated accounts.
    job.retry_at=store.now()+600;await save(store,job);failed??=error;continue;
   }
   // Surface a failed job to Lambda's error alarm, after letting another ready job progress.
   if(failed)throw failed;return result;
  }
  cursor=page.next;
 }while(cursor&&Date.now()<deadline);
 if(failed)throw failed;const scopes=await eraseScopes(env,{deadline});
 return scopes.processed||Date.now()>=deadline?scopes:eraseRetention(env,{deadline});
}
async function eraseAccount(env,job,deadline){
 const {store,objects}=env;
 alphaProject(job.owner);
 const meta=await store.getTenant(job.owner);
 if(!Number.isSafeInteger(meta?.deleted_at))throw Error('erasure_account_not_closed');
 const owner=job.owner;
 if(job.phase==='billing'){
  if(meta.stripe_customer_id){
   if(env.planBilling?.mode!=='test')throw Error('erasure_test_billing_unavailable');
   const stripe=env.planBilling.stripe,customer=await stripe.customers.retrieve(meta.stripe_customer_id);
   if(!customer.deleted){
    if(customer.livemode!==false)throw Error('erasure_live_billing_refused');
    if(meta.overage_price_id&&await settleOverage(env,owner,meta.overage_price_id,deadline)){
     const subscriptions=await stripe.subscriptions.list({customer:customer.id,status:'all',limit:100});
     if(subscriptions.has_more)throw Error('erasure_billing_list_incomplete');
     for(const sub of subscriptions.data){
      if(sub.livemode!==false||sub.customer!==customer.id||sub.metadata?.supatrace_org!==owner)throw Error('erasure_billing_scope_mismatch');
      if(['active','trialing','past_due'].includes(sub.status))await stripe.subscriptions.cancel(sub.id,{invoice_now:true,prorate:true});
     }
    }
    await stripe.customers.del(customer.id);
   }
  }
  job.phase='objects';await save(store,job);
 }
 while(Date.now()<deadline&&job.phase==='objects'){
  if(!job.prefixes.length){job.phase='metadata';await save(store,job);break;}
  const Prefix=job.prefixes[0],versions=await objects.client.send(new objects.commands.ListObjectVersionsCommand({Bucket:objects.bucket,Prefix,MaxKeys:50}));
  const rows=[...(versions.Versions??[]),...(versions.DeleteMarkers??[])];
  for(const row of rows){
   if(!row.Key?.startsWith(Prefix)||!row.VersionId)throw Error('erasure_object_scope_mismatch');
   if(Date.now()>=deadline)return {processed:1,phase:job.phase};
   await objects.client.send(new objects.commands.DeleteObjectCommand({Bucket:objects.bucket,Key:row.Key,VersionId:row.VersionId}));
  }
  if(!rows.length){job.prefixes.shift();await save(store,job);}
 }
 while(Date.now()<deadline&&job.phase==='metadata'){
  const page=await store._send('ScanCommand',{Limit:25,ConsistentRead:true,...(job.cursor?{ExclusiveStartKey:job.cursor}:{})});
  for(const row of page.Items??[]){
   if(Date.now()>=deadline)return {processed:1,phase:job.phase};
   if(!ownedRow(row,owner)||(row.pk==='TENANT#'+owner&&row.sk==='META'))continue;
   // Full-row optimistic comparison prevents removing a reused session slot or a rebound identity.
   const names={},values={},checks=[];
   for(const [i,[name,value]] of Object.entries(row).entries()){names['#f'+i]=name;values[':v'+i]=value;checks.push('#f'+i+' = :v'+i);}
   try{await store._send('DeleteCommand',{Key:{pk:row.pk,sk:row.sk},ConditionExpression:checks.join(' AND '),ExpressionAttributeNames:names,ExpressionAttributeValues:values});}
   catch(error){if(error.name!=='ConditionalCheckFailedException')throw error;throw Error('erasure_row_changed');}
  }
  if(page.LastEvaluatedKey){job.cursor=page.LastEvaluatedKey;await save(store,job);}
  else{
   // Retain only a non-login tombstone. Backups expire after the configured 35-day recovery window.
   const bytes=Number.isSafeInteger(meta.used_bytes)&&meta.used_bytes>0?meta.used_bytes:0;
   await store._tx([
    {Put:{Item:{...key(owner,'META'),tenant_id:owner,deleted_at:meta.deleted_at,session_epoch:meta.session_epoch??0,erased_at:store.now()},ConditionExpression:'deleted_at = :closed AND attribute_not_exists(erased_at)',ExpressionAttributeValues:{':closed':meta.deleted_at}}},
    {Delete:{Key:{pk:ERASURE_QUEUE,sk:owner},ConditionExpression:'#owner = :owner',ExpressionAttributeNames:{'#owner':'owner'},ExpressionAttributeValues:{':owner':owner}}},
    ...(!owner.startsWith('org-')||bytes?[{Update:{Key:{pk:'SYS',sk:'CAPACITY'},UpdateExpression:'ADD '+[...(!owner.startsWith('org-')?['accounts :minus']:[]),...(bytes?['used_bytes :release']:[])].join(', '),ConditionExpression:[...(!owner.startsWith('org-')?['accounts >= :one']:[]),...(bytes?['used_bytes >= :bytes']:[])].join(' AND '),ExpressionAttributeValues:{...(!owner.startsWith('org-')?{':minus':-1,':one':1}:{}),...(bytes?{':release':-bytes,':bytes':bytes}:{})}}}]:[])
   ]);
   return {processed:1,phase:'complete'};
  }
 }
 return {processed:1,phase:job.phase};
}
