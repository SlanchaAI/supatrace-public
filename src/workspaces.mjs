import {randomBytes, createHash} from 'node:crypto';
import {HttpError, boundedText, json, requireOrigin} from './http.mjs';
import {alphaProject,isOrganizationId,requireProject,projectPrefix} from './alpha-projects.mjs';
import {cookie, digest} from './aws-auth.mjs';
import {auditPut} from './audit.mjs';
import {MEMBER_ROLES,KEY_ISSUER_ROLES,authorizeRoute} from './roles.mjs';
import {orgSsoApi,deploymentDomains} from './org-sso.mjs';
import {ssoBinding} from './dynamodb-store.mjs';
import {requireFeature,requireCount,countLimit,hasFeature,planOf} from './entitlements.mjs';
import {erasureItem} from './account-deletion.mjs';
import {seatAdmission} from './seat-admission.mjs';
import {scopeErasureItem,SCOPE_ERASURE_QUEUE} from './scope-erasure.mjs';
const fail=(status,code)=>{throw new HttpError(status,code);};
const pk=owner=>'TENANT#'+owner;
const key=(owner,sk)=>({pk:pk(owner),sk});
const cleanName=value=>typeof value==='string'&&value.trim().length>=1&&value.trim().length<=60&&!/[\u0000-\u001f\u007f]/.test(value)?value.trim():fail(400,'invalid_workspace_name');
export const environmentId=value=>typeof value==='string'&&/^[a-z][a-z0-9-]{0,31}$/.test(value)?value:fail(400,'invalid_environment');
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join()===keys.sort().join();
const conditional=e=>e?.name==='ConditionalCheckFailedException'||e?.name==='TransactionCanceledException';
const pendingInvitePrefix='WORKSPACE#INVITED#';
const epochExpr='(attribute_not_exists(session_epoch) OR session_epoch = :actorEpoch)';
// The personal owner is the account itself. Everyone else, a created organization's owner included, acts through a
// membership row, and each of their writes is fenced on that row's current role and version.
const fence=access=>access&&!access.personal?access:null;
export const ORGANIZATION_LIMIT=10;
// Custom roles (Enterprise, `custom_roles`): an organization names a role and gives it a permission level (the
// capabilities of Admin, Developer or Read-only) and, optionally, the environments it is limited to. A member is given
// the role as `custom:<id>`. Every permission check still runs on the built-in level the role resolves to, so the one
// route table in src/roles.mjs stays the only place that says who may do what.
export const CUSTOM_ROLE_LIMIT=10;
const CUSTOM=/^custom:[a-f0-9]{12}$/;
export const isCustomRole=value=>typeof value==='string'&&CUSTOM.test(value);
const assignable=value=>MEMBER_ROLES.includes(value)||isCustomRole(value);
const roleKey=(owner,role)=>key(owner,'ROLE#'+role.slice(7));
// The member list is one page of 20, so no plan can hold more seats than this.
export const SEAT_CEILING=20;
// Default plus 19 created environments fit the one-page environment list.
export const ENVIRONMENT_CEILING=20;
const scopeOf=row=>Array.isArray(row?.environments)&&row.environments.length?row.environments:null;
const withoutScope=row=>{const {environments,...rest}=row;return rest;};

// The observed physical session slot and original account epoch fence every workspace mutation.
export async function workspaceSession(request,store,actor){
 const token=cookie(request,'__Host-supatrace');if(!/^[A-Za-z0-9_-]{43}$/.test(token??''))fail(401,'sign_in_required');
 const hash=digest(token),sessionKey={pk:'SESSION#'+Number(BigInt('0x'+hash)%1000n),sk:'SESSION'};
 const row=await store._get(sessionKey),account=await store.getTenant(actor),epoch=account?.session_epoch??0;
 if(!account||Number.isSafeInteger(account.deleted_at)||!row||row.token_hash!==hash||row.tenant_id!==actor||!Number.isSafeInteger(row.expires_at)||row.expires_at<=store.now()||(row.session_epoch??0)!==epoch||!Number.isSafeInteger(epoch)||epoch<0)fail(401,'sign_in_required');
 return {actor,epoch,sessionKey,tokenHash:hash,sso:ssoBinding(row)};
}
function guardedItems(store,items,stamp,member){
 const values={':actorEpoch':stamp.epoch};
 const epoch=stamp.epoch===0?epochExpr:'session_epoch = :actorEpoch';
 const output=structuredClone(items);let found=false;
 for(const item of output){const op=Object.values(item)[0],k=op.Key??op.Item;if(k.pk===pk(stamp.actor)&&k.sk==='META'){
  found=true;op.ConditionExpression=op.ConditionExpression?'('+op.ConditionExpression+') AND '+epoch:epoch;
  op.ExpressionAttributeValues={...op.ExpressionAttributeValues,...values};
 }}
 if(!found)output.push({ConditionCheck:{Key:key(stamp.actor,'META'),ConditionExpression:'attribute_exists(pk) AND '+epoch,ExpressionAttributeValues:values}});
 output.push({ConditionCheck:{Key:stamp.sessionKey,ConditionExpression:'token_hash = :hash AND tenant_id = :actor AND expires_at > :now',ExpressionAttributeValues:{':hash':stamp.tokenHash,':actor':stamp.actor,':now':store.now()}}});
 // A member acting under a custom role acts on the definition that was read: a change to the role fails the write.
 if(member?.roleFence)output.push(member.roleFence);
 if(member)output.push({ConditionCheck:{Key:key(member.owner,'MEMBER#'+stamp.actor),ConditionExpression:'active = :yes AND #version = :version AND #role = :role',ExpressionAttributeNames:{'#version':'version','#role':'role'},ExpressionAttributeValues:{':yes':true,':version':member.version,':role':member.storedRole??member.role}}});
 return output;
}
export class Workspaces {
 // `sso` is the SSO binding of the session making the request ({org, idp_version}), or null: a personal access token,
 // a key, and a session that did not come from an organization's IdP have none.
 // `reserved` lists the email domains of the deployment's IdP: an organization's SSO never counts for those.
 constructor(store,stamp=null,ip=null,mfaOn=false,sso=null,reserved=[],project=null){this.project=project;this.store=store;this.stamp=stamp;this.ip=ip;this.mfaOn=mfaOn===true;this.sso=sso??stamp?.sso??null;this.reserved=reserved;}
 // The organization's plan id (src/entitlements.mjs resolves anything unknown to Free).
 async plan(owner){return typeof this.store.planId==='function'?await this.store.planId(owner):null;}
 // Seats in use: active members, plus the account itself in a personal organization (its owner has no member row).
 // The `members` counter on the workspace row counts every membership row ever made and never goes down, so it is
 // only the hard ceiling; the plan's seat limit counts people who have access now. The count is read before the
 // write, so two acceptances racing for the last seat can both land. The ceiling still holds.
 async seatsUsed(owner){const rows=await this.store._page(pk(owner),'MEMBER#',{limit:SEAT_CEILING});return rows.items.filter(r=>r.active===true).length+(isOrganizationId(owner)?0:1);}
 // Roles other than admin, and environment limits on a member, are the rbac_roles feature.
 async requireRoleFeature(owner,role,limit){if(isCustomRole(role)){requireFeature(await this.plan(owner),'custom_roles');if(!await this.store._get(roleKey(owner,role)))fail(400,'invalid_member_role');return;}if(role!=='admin'||limit)requireFeature(await this.plan(owner),'rbac_roles');}
 // The audit event is one more item in the transaction that makes the change: both commit or neither does.
 audit(workspace,action,target,detail={}){return auditPut(this.store.now(),{workspace,actor:this.stamp?.actor,ip:this.ip},action,target,detail);}
 async tx(items,member=null){if(!this.stamp)fail(401,'sign_in_required');try{return await this.store._tx(guardedItems(this.store,items,this.stamp,member));}catch(e){if(conditional(e))fail(409,'workspace_changed');throw e;}}
 async access(actor,owner=actor){
  alphaProject(actor);alphaProject(owner);
  const account=await this.store.getTenant(actor),target=actor===owner?account:await this.store.getTenant(owner);
  if(Number.isSafeInteger(account?.deleted_at)||Number.isSafeInteger(target?.deleted_at))fail(403,'workspace_unavailable');
  const info=typeof this.store._get==='function'?await this.store._get(key(owner,'WORKSPACE#META')):null;
  // An organization id only acts as itself through a key with no recorded issuer; a deleted organization is closed to that too.
  if(owner===actor&&isOrganizationId(owner)&&Number.isSafeInteger(info?.deleted_at))fail(403,'workspace_unavailable');
  if(owner===actor)return {owner,role:'owner',version:0,name:info?.name??'Personal workspace',shared:!!info,personal:true,environments:null,requireMfa:info?.require_mfa===true,ssoEnforced:false};
  const member=await this.store._get(key(owner,'MEMBER#'+actor));
  // Only a created organization has an owner who is a member row, and the workspace row must name that same account.
  const isOwner=isOrganizationId(owner)&&info?.owner===actor;
  // A deleted organization gives nobody access, its owner included: every route, key and token check comes through here.
  if(Number.isSafeInteger(info?.deleted_at))fail(403,'workspace_unavailable');
  if(!info||member?.active!==true||!(isOwner?member.role==='owner':assignable(member.role))||!Number.isSafeInteger(member.version))fail(403,'workspace_unavailable');
  // A custom role resolves to its permission level. A role that was deleted gives no access; a plan without custom
  // roles (after a downgrade) gives its members read-only access until they are moved to a built-in role.
  let role=member.role,roleName=null,roleFence=null,environments=member.role==='owner'?null:scopeOf(member);
  if(isCustomRole(member.role)){
   const definition=await this.store._get(roleKey(owner,member.role));if(!definition||!MEMBER_ROLES.includes(definition.base)||!Number.isSafeInteger(definition.version))fail(403,'workspace_unavailable');
   role=hasFeature(await this.plan(owner),'custom_roles')?definition.base:'viewer';roleName=definition.name;
   // The role's environment limit and the member's own limit both apply: the member reaches only what both allow.
   const roleScope=scopeOf(definition);if(roleScope)environments=environments?environments.filter(id=>roleScope.includes(id)):roleScope;
   roleFence={ConditionCheck:{Key:roleKey(owner,member.role),ConditionExpression:'#v = :roleVersion',ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':roleVersion':definition.version}}};
  }
  return {owner,role,storedRole:member.role,roleName,roleFence,version:member.version,name:info.name,shared:true,personal:false,environments,requireMfa:info.require_mfa===true,ssoEnforced:member.role!=='owner'&&info.sso_enforced===true,ssoDomains:Array.isArray(info.sso_domains)?info.sso_domains:[],ssoIdpVersion:Number.isSafeInteger(info.sso_idp_version)?info.sso_idp_version:null};
 }
 // Organization setting "require two-factor authentication": checked on every use of the organization's data, not at sign-in.
 // It needs two-factor authentication to be enabled on the deployment; while that is off nobody can enroll, so the rule is not applied.
 async mfaMissing(actor,access){return access.requireMfa===true&&this.mfaOn&&hasFeature(await this.plan(access.owner),'enforce_mfa')&&!((await this.store.getTenant(actor))?.mfa_secret);}
 async requireMfa(actor,access){if(await this.mfaMissing(actor,access))fail(403,'mfa_enrollment_required');await this.requireSso(actor,access);}
 // Organization setting "require SSO": every member except the owner must be signed in through the organization's IdP.
 // That is a property of the session, not of the account: the session must have been created by a SAML response that this
 // organization's IdP signed, under the IdP settings the organization has now (replacing the sign-on URL, issuer or
 // certificate ends the sessions the previous IdP vouched for), for an SSO account whose email is in a domain the
 // organization still has verified and the deployment's IdP has not taken over. A session from the deployment's IdP, another organization's IdP or a linked sign-in
 // method, a personal access token and a key have no such binding and are refused. The owner is the way back in if the IdP breaks.
 async ssoMissing(actor,access){
  if(access.ssoEnforced!==true||!hasFeature(await this.plan(access.owner),'sso_saml'))return false;
  const bound=this.sso;if(!bound||bound.org!==access.owner||access.ssoIdpVersion===null||bound.idp_version!==access.ssoIdpVersion)return true;
  const row=await this.store.getTenant(actor),domain=row?.provider==='sso'&&typeof row.email==='string'?row.email.split('@')[1]:null;
  return !(domain&&access.ssoDomains.includes(domain)&&!this.reserved.includes(domain));
 }
 async requireSso(actor,access){if(await this.ssoMissing(actor,access))fail(403,'sso_required');}
 // A member's environment limit: null means every environment. Each listed environment must exist.
 async scope(owner,value){
  if(value===null||value===undefined)return null;
  if(!Array.isArray(value)||value.length<1||value.length>20||new Set(value).size!==value.length)fail(400,'invalid_member_scope');
  for(const id of value)try{await this.environment(owner,id);}catch{fail(400,'invalid_member_scope');}
  return [...value].sort();
 }
 async list(actor){
  if(typeof this.store._page!=='function'||typeof this.store._get!=='function')return [alphaProject(actor)];
  const rows=await this.store._page(pk(actor),'WORKSPACE#JOIN#',{limit:20}),out=[await this.access(actor)];
  if(rows.next)fail(503,'workspace_list_incomplete');
  for(const r of rows.items){try{out.push(await this.access(actor,r.owner));}catch(e){if(e.code!=='workspace_unavailable')throw e;}}
  const flagged=[];for(const w of out)flagged.push({...alphaProject(w.owner),workspace_id:w.owner,workspace_name:w.name,role:w.role,...(w.roleName?{role_name:w.roleName}:{}),shared:w.shared,personal:w.personal,environments:w.environments,require_mfa:w.requireMfa,mfa_required:await this.mfaMissing(actor,w),sso_required:await this.ssoMissing(actor,w)});
  return flagged;
 }
 // List projects separately from organizations so organization/member counts never duplicate.
 async projects(actor){
  const organizations=await this.list(actor),out=[];
  for(const organization of organizations){
   const owner=organization.workspace_id??actor,rows=await this.store._page(pk(owner),'PROJECT_META#',{limit:100});
   if(rows.next)fail(503,'project_list_incomplete');
   const legacy=await requireProject(this.store,owner,null);out.push({...organization,...legacy});
   for(const row of rows.items)if(row.id!==legacy.id)out.push({...organization,id:row.id,name:row.name,additional_projects_available:true});
  }
  return out;
 }
 async createProject(actor,owner,data){
  const access=await this.access(actor,owner);if(!['owner','admin'].includes(access.role)||access.environments)fail(403,'workspace_admin_required');await this.requireMfa(actor,access);
  if(!exact(data,['name']))fail(400,'invalid_project');const name=cleanName(data.name),plan=await this.plan(owner),meta=key(owner,'PROJECT_CAPACITY'),count=(await this.store._get(meta))?.count??0;
  requireCount(plan,'projects',1+count);const account=await this.store.getTenant(owner);if((account?.plan_id??null)!==plan)fail(409,'workspace_changed');const planCheck={ConditionCheck:{Key:key(owner,'META'),ConditionExpression:account?.plan_id===undefined?'attribute_exists(pk) AND attribute_not_exists(plan_id)':'plan_id = :projectPlan',...(account?.plan_id===undefined?{}:{ExpressionAttributeValues:{':projectPlan':account.plan_id}})}};const cap=countLimit(plan,'projects'),id='proj_'+randomBytes(16).toString('hex');
  await this.tx([{Put:{Item:{...key(owner,'PROJECT_META#'+id),id,name,created_at:this.store.now()},ConditionExpression:'attribute_not_exists(pk)'}},
   {Update:{Key:meta,UpdateExpression:'ADD #n :one',ConditionExpression:'attribute_not_exists(#n) OR #n < :cap',ExpressionAttributeNames:{'#n':'count'},ExpressionAttributeValues:{':one':1,':cap':cap-1}}},planCheck,this.audit(owner,'project.create',id,{name})],fence(access));
  return {id,name,workspace_id:owner};
 }
 async renameProject(actor,owner,data){
  const access=await this.access(actor,owner);if(!['owner','admin'].includes(access.role)||access.environments)fail(403,'workspace_admin_required');await this.requireMfa(actor,access);
  if(!exact(data,['id','name']))fail(400,'invalid_project');const project=await requireProject(this.store,owner,data.id),name=cleanName(data.name),Key=key(owner,'PROJECT_META#'+project.id),old=await this.store._get(Key);
  if(old?.name===name)return {id:project.id,name};
  await this.tx([{Put:{Item:{...Key,id:project.id,name,created_at:old?.created_at??this.store.now()},ConditionExpression:old?'#name = :seen':'attribute_not_exists(pk)',...(old?{ExpressionAttributeNames:{'#name':'name'},ExpressionAttributeValues:{':seen':old.name}}:{})}},this.audit(owner,'project.rename',project.id,{from:project.name,to:name})],fence(access));return {id:project.id,name};
 }
 async deleteProject(actor,owner,data){
  const access=await this.access(actor,owner);authorizeRoute(access,'POST','/api/projects/delete');await this.requireMfa(actor,access);
  if(!exact(data,['id','confirm'])||data.id===alphaProject(owner).id||data.confirm!==data.id)fail(400,'invalid_project');
  const retiredKey=key(owner,'PROJECT_RETIRED#'+data.id),retired=await this.store._get(retiredKey);
  if(retired)return {deleted:true,id:data.id,erasure:retired.erased_at?'complete':'queued',backup_expiry_days:35};
  const project=await requireProject(this.store,owner,data.id);
  await this.tx([{Delete:{Key:key(owner,'PROJECT_META#'+project.id),ConditionExpression:'attribute_exists(pk)'}},
   {Put:{Item:{...retiredKey,id:project.id,name:project.name,deleted_at:this.store.now(),deleted_by:actor},ConditionExpression:'attribute_not_exists(pk)'}},
   {Update:{Key:key(owner,'PROJECT_CAPACITY'),UpdateExpression:'ADD #n :minus',ConditionExpression:'#n >= :one',ExpressionAttributeNames:{'#n':'count'},ExpressionAttributeValues:{':minus':-1,':one':1}}},
   scopeErasureItem(this.store,owner,project.id),this.audit(owner,'project.delete',project.id,{name:project.name})],fence(access));
  return {deleted:true,id:project.id,erasure:'queued',backup_expiry_days:35};
 }
 async create(actor,name){
  name=cleanName(name);const old=await this.store._get(key(actor,'WORKSPACE#META'));
  if(old){if(old.name!==name)fail(409,'workspace_already_shared');return {workspace_id:actor,name:old.name};}
  await this.tx([{Put:{Item:{...key(actor,'WORKSPACE#META'),name,created_at:this.store.now(),owner:actor,members:1,environment_count:1},ConditionExpression:'attribute_not_exists(pk)'}},this.audit(actor,'workspace.sharing_enabled',actor,{name})]);
  return {workspace_id:actor,name};
 }
 async members(actor,owner){const a=await this.access(actor,owner);if(a.role!=='owner')fail(403,'workspace_owner_required');const rows=await this.store._page(pk(owner),'MEMBER#',{limit:20});if(rows.next)fail(503,'workspace_list_incomplete');return [...(a.personal?[{user_id:owner,role:'owner',active:true,version:0}]:[]),...rows.items.map(r=>({user_id:r.user_id,role:r.role,active:r.active,version:r.version,environments:r.role==='owner'?null:scopeOf(r)}))];}
 async invite(actor,owner,data){
  if(!(exact(data,['recipient_id','role'])||exact(data,['recipient_id','role','environments']))||!assignable(data.role))fail(400,'invalid_invitation');
  const access=await this.access(actor,owner);if(access.role!=='owner'||!access.shared)fail(403,'workspace_owner_required');
  const limit=await this.scope(owner,data.environments);await this.requireRoleFeature(owner,data.role,limit);
  // Seats: the owner plus every active member. An invitation is refused while the organization is full.
  requireCount(await this.plan(owner),'seats',await this.seatsUsed(owner));
  alphaProject(data.recipient_id);if(data.recipient_id===owner||!await this.store.getTenant(data.recipient_id))fail(400,'invitation_recipient_unavailable');
  const membership=await this.store._get(key(owner,'MEMBER#'+data.recipient_id));
  if(membership?.active)fail(409,'already_a_member');
  const token=randomBytes(32).toString('base64url'),now=this.store.now(),target=key(owner,'INVITE#'+data.recipient_id);
  // The recipient-side pointer only makes the invitation discoverable; the owner-side row stays the authority.
  await this.tx([{ConditionCheck:{Key:key(owner,'MEMBER#'+data.recipient_id),ConditionExpression:membership?'#v = :v AND active = :no':'attribute_not_exists(pk)',...(membership?{ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':v':membership.version,':no':false}}:{})}},
   {Put:{Item:{...target,recipient_id:data.recipient_id,role:data.role,...(limit?{environments:limit}:{}),membership_version:membership?.version??-1,token_hash:digest(token),expires_at:now+86400,used:false},ConditionExpression:'attribute_not_exists(pk) OR expires_at <= :now OR used = :used OR attribute_not_exists(membership_version) OR membership_version <> :membershipVersion',ExpressionAttributeValues:{':now':now,':used':true,':membershipVersion':membership?.version??-1}}},
   {Put:{Item:{...key(data.recipient_id,pendingInvitePrefix+owner),owner,expires_at:now+86400,ttl:now+86400}}},this.audit(owner,'member.invite',data.recipient_id,{role:data.role,environments:limit?limit.join(' '):'all',expires:new Date((now+86400)*1000).toISOString()})],fence(access));
  return {workspace_id:owner,recipient_id:data.recipient_id,role:data.role,environments:limit,token,expires_at:now+86400};
 }
 // Invitations addressed to the signed-in account only. Pointers are hints: every row is re-read from the
 // inviting workspace and dropped unless it is still unused, unexpired and addressed to this exact account.
 async pendingInvites(actor){
  alphaProject(actor);if(typeof this.store._page!=='function'||typeof this.store._get!=='function')return {invitations:[],truncated:false};
  // Expired pointers linger until the table's TTL removes them, so read past them instead of letting
  // them hide a live invitation. Work is bounded: 10 index pages, 60 authoritative re-reads, 20 results.
  const now=this.store.now(),invitations=[];let cursor=null,checked=0,truncated=false;
  scan:for(let page=0;;page++){
   if(page===10){truncated=true;break;}
   const rows=await this.store._page(pk(actor),pendingInvitePrefix,{limit:100,cursor});
   for(const r of rows.items){
    const owner=r.owner;try{alphaProject(owner);}catch{continue;}
    if(r.sk!==pendingInvitePrefix+owner||owner===actor||!Number.isSafeInteger(r.expires_at)||r.expires_at<=now)continue;
    if(invitations.length===20||checked===60){truncated=true;break scan;}
    checked++;
    const inv=await this.store._get(key(owner,'INVITE#'+actor)),info=await this.store._get(key(owner,'WORKSPACE#META'));
    if(!info||Number.isSafeInteger(info.deleted_at)||!inv||inv.recipient_id!==actor||inv.used!==false||!Number.isSafeInteger(inv.expires_at)||inv.expires_at<=now||!assignable(inv.role))continue;
    const membership=await this.store._get(key(owner,'MEMBER#'+actor));
    if(membership?.active||(membership&&inv.membership_version!==membership.version))continue;
    invitations.push({workspace_id:owner,workspace_name:info.name,role:inv.role,...(scopeOf(inv)?{environments:scopeOf(inv)}:{}),expires_at:inv.expires_at});
   }
   if(!rows.next)break;
   cursor=rows.next;
  }
  return {invitations,truncated};
 }
 // token===undefined is the listed-invitation path: the session proves the addressed account, and the
 // stored hash read here fences the write against a re-issued invitation.
 async accept(actor,owner,token){
  alphaProject(owner);if(token!==undefined&&!/^[A-Za-z0-9_-]{43}$/.test(token??''))fail(400,'invalid_invitation');
  // An invitation to an organization that has since been deleted is dead.
  if(Number.isSafeInteger((await this.store._get(key(owner,'WORKSPACE#META')))?.deleted_at))fail(409,'invitation_unavailable');
  const k=key(owner,'INVITE#'+actor),inv=await this.store._get(k),old=await this.store._get(key(owner,'MEMBER#'+actor));
  const hash=token===undefined?inv?.token_hash:digest(token);
  if(!inv||inv.recipient_id!==actor||typeof hash!=='string'||inv.token_hash!==hash||inv.expires_at<=this.store.now()||inv.used!==false||!assignable(inv.role)||old?.active)fail(409,'invitation_unavailable');
  // The plan is checked again at acceptance: an invitation issued on a higher plan does not carry its role past a downgrade.
  if(!isCustomRole(inv.role))await this.requireRoleFeature(owner,inv.role,scopeOf(inv));
  // An invitation to a custom role is only good while that role exists and the plan has custom roles.
  if(isCustomRole(inv.role)&&(!await this.store._get(roleKey(owner,inv.role))||!hasFeature(await this.plan(owner),'custom_roles')))fail(409,'invitation_unavailable');
  // Legacy invitations may admit a first-time member, but can never restore a removed membership.
  if(old&&inv.membership_version!==old.version)fail(409,'invitation_unavailable');
  const version=(old?.version??-1)+1,joined=await this.store._get(key(actor,'WORKSPACE#JOIN#'+owner));
  const admission=await seatAdmission(this.store,owner,!old);
  requireCount(await this.plan(owner),'seats',admission.active);
  await this.tx([
   {Update:{Key:k,UpdateExpression:'SET used = :yes',ConditionExpression:'recipient_id = :actor AND token_hash = :hash AND used = :no AND expires_at > :now',ExpressionAttributeValues:{':yes':true,':no':false,':hash':hash,':actor':actor,':now':this.store.now()}}},
   {Delete:{Key:key(actor,pendingInvitePrefix+owner)}},
   {Put:{Item:{...key(owner,'MEMBER#'+actor),user_id:actor,role:inv.role,...(scopeOf(inv)?{environments:scopeOf(inv)}:{}),active:true,version},ConditionExpression:old?'#v = :v AND active = :no':'attribute_not_exists(pk)',...(old?{ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':v':old.version,':no':false}}:{})}},
   {Put:{Item:{...key(actor,'WORKSPACE#JOIN#'+owner),owner},ConditionExpression:'attribute_not_exists(pk) OR #owner = :owner',ExpressionAttributeNames:{'#owner':'owner'},ExpressionAttributeValues:{':owner':owner}}},
   admission.item,
   ...(!joined?[{Update:{Key:key(actor,'WORKSPACE#CAPACITY'),UpdateExpression:'ADD #n :one',ConditionExpression:'attribute_not_exists(#n) OR #n < :cap',ExpressionAttributeNames:{'#n':'count'},ExpressionAttributeValues:{':one':1,':cap':19}}}]:[]),
   this.audit(owner,'member.accept',actor,{role:inv.role}),
  ]);return {accepted:true,workspace_id:owner,role:inv.role};
 }
 async changeMember(actor,owner,data){
  if(!(exact(data,['user_id','role','version'])||exact(data,['user_id','role','version','environments']))||!(assignable(data.role)||data.role==='removed')||!Number.isSafeInteger(data.version)||data.version<0)fail(400,'invalid_member');
  const access=await this.access(actor,owner);if(access.role!=='owner'||data.user_id===owner||data.user_id===actor)fail(403,'workspace_owner_required');alphaProject(data.user_id);
  const old=await this.store._get(key(owner,'MEMBER#'+data.user_id));if(!old?.active||old.version!==data.version)fail(409,'workspace_changed');
  if(old.role==='owner')fail(403,'workspace_owner_required');
  // `environments` omitted keeps the member's limit; null clears it; a list replaces it. Any change bumps the version, which ends keys the member issued.
  const before=scopeOf(old),after=data.role==='removed'||!Object.hasOwn(data,'environments')?before:await this.scope(owner,data.environments),next={...old,active:data.role!=='removed',role:data.role==='removed'?old.role:data.role,version:old.version+1};
  if(after)next.environments=after;else delete next.environments;
  if(data.role!=='removed'&&(data.role!==old.role||(after&&(before??[]).join()!==after.join())))await this.requireRoleFeature(owner,data.role,after);
  const show=v=>v?v.join(' '):'all',rescoped=show(before)!==show(after);
  if(data.role!=='removed'&&data.role===old.role&&!rescoped)fail(409,'workspace_changed');
  const items=[{Put:{Item:next,ConditionExpression:'#v = :v AND active = :yes',ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':v':old.version,':yes':true}}},
   data.role==='removed'?this.audit(owner,'member.remove',data.user_id,{role:old.role}):data.role!==old.role?this.audit(owner,'member.role_change',data.user_id,{from:old.role,to:data.role,...(rescoped?{environments:show(after)}:{})}):this.audit(owner,'member.scope_change',data.user_id,{from:show(before),to:show(after)})];
  // Revocation and invitation cancellation are one transaction: old invites cannot restore access.
  if(data.role==='removed')items.push({Delete:{Key:key(owner,'INVITE#'+data.user_id)}},{Delete:{Key:key(data.user_id,pendingInvitePrefix+owner)}});
  await this.tx(items,fence(access));return {changed:true};
 }
 // Organizations. The personal organization is the account's own partition: nothing is written to make it one.
 // A created organization is a new tenant partition whose owner is a membership row, so it can change hands.
 // The highest plan among actively owned workspaces grants the account's creation allowance.
 // Each new workspace still starts Free and bills separately. Fence the winning plan and ownership,
 // so a downgrade or transfer cannot lend its allowance to an overlapping creation.
 async organizationAllowance(actor,incoming=null){
  const rows=await this.store._page(pk(actor),'WORKSPACE#JOIN#',{limit:20});if(rows.next)fail(503,'workspace_list_incomplete');
  let best=null;
  for(const owner of new Set([actor,...rows.items.map(r=>r.owner),...(incoming?[incoming]:[])])){
   const account=await this.store.getTenant(owner);if(!account||Number.isSafeInteger(account.deleted_at))continue;
   if(owner!==actor&&owner!==incoming&&account.owner_account!==actor)continue;
   const plan=planOf(account.plan_id),limit=countLimit(plan.id,'workspaces');
   if(!best||limit>best.limit)best={owner,account,plan:plan.id,limit};
  }
  if(!best)fail(403,'workspace_unavailable');
  const a=best.account,values={},parts=['attribute_exists(pk)','attribute_not_exists(deleted_at)'];
  if(a.plan_id===undefined)parts.push('attribute_not_exists(plan_id)');else {parts.push('plan_id = :allowancePlan');values[':allowancePlan']=a.plan_id;}
  if(best.owner!==actor){parts.push('owner_account = :allowanceOwner');values[':allowanceOwner']=a.owner_account;}
  return {...best,check:{ConditionCheck:{Key:key(best.owner,'META'),ConditionExpression:parts.join(' AND '),...(Object.keys(values).length?{ExpressionAttributeValues:values}:{})}}};
 }
 allowanceItems(items,allowance){
  const check=allowance.check.ConditionCheck,existing=items.find(item=>{const op=Object.values(item)[0],k=op.Key??op.Item;return k.pk===check.Key.pk&&k.sk===check.Key.sk;});
  if(!existing)return [...items,allowance.check];
  const op=Object.values(existing)[0];op.ConditionExpression='('+op.ConditionExpression+') AND '+check.ConditionExpression;
  op.ExpressionAttributeValues={...op.ExpressionAttributeValues,...check.ExpressionAttributeValues};return items;
 }
 async organizations(actor){
  const list=await this.list(actor);
  return {organizations:list.map(w=>({id:w.workspace_id??actor,name:w.workspace_name??w.name,role:w.role??'owner',personal:(w.workspace_id??actor)===actor,shared:w.shared===true,project_id:w.id,environments:w.environments??null,require_mfa:w.require_mfa===true,mfa_required:w.mfa_required===true,sso_required:w.sso_required===true})),limit:(await this.organizationAllowance(actor)).limit};
 }
 async createOrganization(actor,name){
  name=cleanName(name);alphaProject(actor);const id='org-'+randomBytes(16).toString('hex'),now=this.store.now(),joined={':one':1,':cap':19};
  if(typeof this.store.organizationTenantItems!=='function')fail(503,'organizations_unavailable');
  const allowance=await this.organizationAllowance(actor);
  try{await this.tx(this.allowanceItems([
   ...this.store.organizationTenantItems(id,actor),
   {Put:{Item:{...key(id,'WORKSPACE#META'),name,created_at:now,owner:actor,members:1,environment_count:1,organization:true},ConditionExpression:'attribute_not_exists(pk)'}},
   {Put:{Item:{...key(id,'MEMBER#'+actor),user_id:actor,role:'owner',active:true,version:0},ConditionExpression:'attribute_not_exists(pk)'}},
   {Put:{Item:{...key(actor,'WORKSPACE#JOIN#'+id),owner:id},ConditionExpression:'attribute_not_exists(pk)'}},
   {Update:{Key:key(actor,'ORGANIZATION#CAPACITY'),UpdateExpression:'ADD #n :one',ConditionExpression:'attribute_not_exists(#n) OR #n < :cap',ExpressionAttributeNames:{'#n':'count'},ExpressionAttributeValues:{':one':1,':cap':allowance.limit}}},
   {Update:{Key:key(actor,'WORKSPACE#CAPACITY'),UpdateExpression:'ADD #n :one',ConditionExpression:'attribute_not_exists(#n) OR #n < :cap',ExpressionAttributeNames:{'#n':'count'},ExpressionAttributeValues:joined}},
   this.audit(id,'org.create',id,{name}),
  ],allowance));}catch(e){if(e.code!=='workspace_changed')throw e;const made=await this.store._get(key(actor,'ORGANIZATION#CAPACITY'));if(made?.count>=allowance.limit)requireCount(allowance.plan,'workspaces',made.count);fail(409,'workspace_changed');}
  return {id,name,role:'owner',personal:false,shared:true,project_id:alphaProject(id).id};
 }
 async renameOrganization(actor,id,name){
  name=cleanName(name);const access=await this.access(actor,id);if(access.role!=='owner')fail(403,'workspace_owner_required');
  // A personal organization that was never named has no workspace row yet; naming it is the existing enable-sharing write.
  if(!access.shared){await this.create(actor,name);return {id,name};}
  await this.tx([{Update:{Key:key(id,'WORKSPACE#META'),UpdateExpression:'SET #name = :name',ConditionExpression:'attribute_exists(pk)',ExpressionAttributeNames:{'#name':'name'},ExpressionAttributeValues:{':name':name}}},this.audit(id,'org.rename',id,{from:access.name,to:name})],fence(access));
  return {id,name};
 }
 // The membership rows this writes are their own fence: a transaction cannot also condition-check an item it writes.
 async transferOrganization(actor,id,data){
  if(!exact(data,['user_id','version'])||!Number.isSafeInteger(data.version)||data.version<0)fail(400,'invalid_member');alphaProject(data.user_id);
  const access=await this.access(actor,id);if(access.role!=='owner')fail(403,'workspace_owner_required');
  if(access.personal)fail(409,'personal_organization_not_transferable');
  const next=await this.store._get(key(id,'MEMBER#'+data.user_id));if(data.user_id===actor||!next?.active||next.version!==data.version||!assignable(next.role))fail(409,'workspace_changed');
  // The plan-derived allowance follows ownership: the new owner's count goes up, the previous owner's comes down, in this transaction.
  const names={'#v':'version','#r':'role'},mine=await this.store._get(key(id,'MEMBER#'+actor)),count={'#n':'count'};
  const allowance=await this.organizationAllowance(data.user_id,id),used=(await this.store._get(key(data.user_id,'ORGANIZATION#CAPACITY')))?.count??0;requireCount(allowance.plan,'workspaces',used);
  await this.tx(this.allowanceItems([
   {Put:{Item:{...withoutScope(next),role:'owner',version:next.version+1},ConditionExpression:'#v = :v AND active = :yes AND #r = :r',ExpressionAttributeNames:names,ExpressionAttributeValues:{':v':next.version,':yes':true,':r':next.role}}},
   {Put:{Item:{...mine,role:'admin',version:mine.version+1},ConditionExpression:'#v = :v AND active = :yes AND #r = :r',ExpressionAttributeNames:names,ExpressionAttributeValues:{':v':access.version,':yes':true,':r':'owner'}}},
   {Update:{Key:key(id,'WORKSPACE#META'),UpdateExpression:'SET #owner = :next',ConditionExpression:'#owner = :actor',ExpressionAttributeNames:{'#owner':'owner'},ExpressionAttributeValues:{':next':data.user_id,':actor':actor}}},
   {Update:{Key:key(id,'META'),UpdateExpression:'SET owner_account = :next',ConditionExpression:'owner_account = :actor',ExpressionAttributeValues:{':next':data.user_id,':actor':actor}}},
   {Update:{Key:key(data.user_id,'ORGANIZATION#CAPACITY'),UpdateExpression:'ADD #n :one',ConditionExpression:'attribute_not_exists(#n) OR #n < :cap',ExpressionAttributeNames:count,ExpressionAttributeValues:{':one':1,':cap':allowance.limit}}},
   {Update:{Key:key(actor,'ORGANIZATION#CAPACITY'),UpdateExpression:'ADD #n :minus',ConditionExpression:'#n >= :one',ExpressionAttributeNames:count,ExpressionAttributeValues:{':minus':-1,':one':1}}},
   this.audit(id,'org.transfer_ownership',data.user_id,{from:actor}),
  ],allowance));return {transferred:true,owner:data.user_id};
 }
 // Deleting a created organization closes it at once and for good: nobody can open it, its keys, tokens and SCIM stop,
 // its SSO domains are released and the owner's organization count goes down. Stored traces become unreachable; they are
 // not erased from storage by this request. `confirm` must repeat the organization's name. A personal organization is the
 // account itself and is not deleted here. An organization with any billing state is not deleted here either (see below).
 async deleteOrganization(actor,id,data){
  if(!exact(data,['confirm'])||typeof data.confirm!=='string')fail(400,'invalid_organization_delete');
  const access=await this.access(actor,id);if(access.role!=='owner')fail(403,'workspace_owner_required');
  if(access.personal)fail(409,'personal_organization_cannot_be_deleted');
  if(data.confirm.trim()!==access.name)fail(400,'organization_name_mismatch');
  // Nothing that bills may outlive the organization, and this request cannot wind billing down: a Stripe customer can
  // hold a subscription or an open Checkout that is paid later. So an organization with any billing state (a Stripe
  // customer, commercial enrolment, or a binding from the older sandbox) is not deleted here at all.
  const account=await this.store.getTenant(id);
  if(typeof account?.stripe_customer_id==='string'||typeof account?.stripe_subscription_id==='string'||account?.commercial_managed===true||(typeof this.store.hasStripeTestBinding==='function'&&await this.store.hasStripeTestBinding(id)))fail(409,'billing_bound_organization');
  // People who joined it get their slot back: each membership row's pointer and count are released with the deletion.
  const members=await this.store._page(pk(id),'MEMBER#',{limit:SEAT_CEILING}),joined=[];
  for(const row of members.items)if(row.user_id!==actor&&await this.store._get(key(row.user_id,'WORKSPACE#JOIN#'+id)))joined.push(row.user_id);
  const now=this.store.now(),sso=await this.store._get(key(id,'SSO#CONFIG')),verified=Object.entries(sso?.domains??{}).filter(([,state])=>Number.isSafeInteger(state.verified_at)).map(([domain])=>domain);
  await this.tx([
   {Update:{Key:key(id,'WORKSPACE#META'),UpdateExpression:'SET deleted_at = :now, deleted_by = :actor',ConditionExpression:'attribute_exists(pk) AND attribute_not_exists(deleted_at) AND #owner = :actor',ExpressionAttributeNames:{'#owner':'owner'},ExpressionAttributeValues:{':now':now,':actor':actor}}},
   // The account row is conditioned on still having no billing state: a Checkout or enrolment that lands first wins.
   {Update:{Key:key(id,'META'),UpdateExpression:'SET deleted_at = :now',ConditionExpression:'attribute_exists(pk) AND attribute_not_exists(stripe_customer_id) AND attribute_not_exists(stripe_subscription_id) AND attribute_not_exists(commercial_managed)',ExpressionAttributeValues:{':now':now}}},
   // The owner's count of created organizations, their count of joined workspaces, and the service-wide count all go down.
   {Update:{Key:key(actor,'ORGANIZATION#CAPACITY'),UpdateExpression:'ADD #n :minus',ConditionExpression:'#n >= :one',ExpressionAttributeNames:{'#n':'count'},ExpressionAttributeValues:{':minus':-1,':one':1}}},
   {Update:{Key:key(actor,'WORKSPACE#CAPACITY'),UpdateExpression:'ADD #n :minus',ConditionExpression:'#n >= :one',ExpressionAttributeNames:{'#n':'count'},ExpressionAttributeValues:{':minus':-1,':one':1}}},
   {Delete:{Key:key(actor,'WORKSPACE#JOIN#'+id)}},
   ...joined.flatMap(user=>[{Delete:{Key:key(user,'WORKSPACE#JOIN#'+id)}},{Update:{Key:key(user,'WORKSPACE#CAPACITY'),UpdateExpression:'ADD #n :minus',ConditionExpression:'#n >= :one',ExpressionAttributeNames:{'#n':'count'},ExpressionAttributeValues:{':minus':-1,':one':1}}}]),
   ...(typeof this.store.organizationRemovalItems==='function'?this.store.organizationRemovalItems():[]),
   // The email domains it had verified for SSO, and its SCIM token, are released so another organization can claim them.
   ...verified.map(domain=>({Delete:{Key:{pk:'SSODOMAIN#'+domain,sk:'ORG'},ConditionExpression:'attribute_not_exists(pk) OR org = :org',ExpressionAttributeValues:{':org':id}}})),
   ...(typeof sso?.scim_token_hash==='string'?[{Delete:{Key:{pk:'SCIM#'+sso.scim_token_hash,sk:'TOKEN'}}}]:[]),
   await erasureItem(this.store,id),
   this.audit(id,'org.delete',id,{name:access.name}),
  ],fence(access));
  return {deleted:true,id};
 }
 async leaveOrganization(actor,id){
  const access=await this.access(actor,id);if(access.personal)fail(409,'personal_organization_cannot_be_left');
  if(access.role==='owner')fail(409,'organization_owner_must_transfer');
  const mine=await this.store._get(key(id,'MEMBER#'+actor));
  await this.tx([{Put:{Item:{...mine,active:false,version:mine.version+1},ConditionExpression:'#v = :v AND active = :yes',ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':v':access.version,':yes':true}}},this.audit(id,'member.leave',actor,{role:access.role})]);
  return {left:true};
 }
 // Owner only. Turning the rule on needs two-factor authentication enabled on the deployment and on the owner's own account, so the owner cannot lock the organization.
 async setRequireMfa(actor,id,enabled){
  if(typeof enabled!=='boolean')fail(400,'invalid_security_setting');
  const access=await this.access(actor,id);if(access.role!=='owner')fail(403,'workspace_owner_required');
  if(!access.shared)fail(409,'workspace_not_shared');
  if(enabled){requireFeature(await this.plan(id),'enforce_mfa');if(!this.mfaOn)fail(409,'mfa_unavailable');if(!((await this.store.getTenant(actor))?.mfa_secret))fail(409,'mfa_enrollment_required');}
  if(access.requireMfa===enabled)return {organization_id:id,require_mfa:enabled};
  await this.tx([{Update:{Key:key(id,'WORKSPACE#META'),UpdateExpression:'SET require_mfa = :on',ConditionExpression:'attribute_exists(pk)',ExpressionAttributeValues:{':on':enabled}}},this.audit(id,'settings.require_mfa_changed',id,{enabled})],fence(access));
  return {organization_id:id,require_mfa:enabled};
 }
 // ---- Custom role definitions. Owner only. ----
 async roles(actor,owner){const access=await this.access(actor,owner);if(access.role!=='owner')fail(403,'workspace_owner_required');const rows=await this.store._page(pk(owner),'ROLE#',{limit:CUSTOM_ROLE_LIMIT});return {roles:rows.items.map(r=>({id:'custom:'+r.id,name:r.name,base:r.base,environments:scopeOf(r)})),limit:CUSTOM_ROLE_LIMIT};}
 async saveRole(actor,owner,data){
  const update=Object.hasOwn(data??{},'id');
  if(!(exact(data,update?['id','name','base','environments']:['name','base','environments']))||!MEMBER_ROLES.includes(data.base)||(update&&!isCustomRole(data.id)))fail(400,'invalid_role');
  const access=await this.access(actor,owner);if(access.role!=='owner'||!access.shared)fail(403,'workspace_owner_required');
  requireFeature(await this.plan(owner),'custom_roles');
  const name=cleanName(data.name),limit=await this.scope(owner,data.environments),id=update?data.id.slice(7):randomBytes(6).toString('hex'),old=update?await this.store._get(key(owner,'ROLE#'+id)):null;
  if(update&&!old)fail(404,'role_not_found');
  // The version changes with every edit; writes by the role's members are conditioned on the version they were authorised under.
  const row={...key(owner,'ROLE#'+id),id,name,base:data.base,version:(old?.version??0)+1,...(limit?{environments:limit}:{})};
  const existing=await this.store._page(pk(owner),'ROLE#',{limit:CUSTOM_ROLE_LIMIT});
  if(existing.items.some(r=>r.id!==id&&r.name.toLowerCase()===name.toLowerCase()))fail(409,'role_name_taken');
  if(!update&&existing.items.length>=CUSTOM_ROLE_LIMIT)fail(409,'role_limit');
  const detail={name,level:data.base,environments:limit?limit.join(' ').slice(0,160):'all'};
  await this.tx([{Put:{Item:row,ConditionExpression:update?'#v = :seen':'attribute_not_exists(pk)',...(update?{ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':seen':old.version}}:{})}},this.audit(owner,update?'role.update':'role.create','custom:'+id,detail)],fence(access));
  return {id:'custom:'+id,name,base:data.base,environments:limit};
 }
 async deleteRole(actor,owner,data){
  if(!exact(data,['id'])||!isCustomRole(data.id))fail(400,'invalid_role');
  const access=await this.access(actor,owner);if(access.role!=='owner')fail(403,'workspace_owner_required');
  const old=await this.store._get(roleKey(owner,data.id));if(!old)fail(404,'role_not_found');
  // A role still held by an active member is not deleted: that member would lose all access. Move them first.
  const members=await this.store._page(pk(owner),'MEMBER#',{limit:SEAT_CEILING});if(members.items.some(m=>m.active===true&&m.role===data.id))fail(409,'role_in_use');
  await this.tx([{Delete:{Key:roleKey(owner,data.id),ConditionExpression:'attribute_exists(pk)'}},this.audit(owner,'role.delete',data.id,{name:old.name})],fence(access));
  return {deleted:true};
 }
 environmentKey(owner,sk){return key(owner,projectPrefix(owner,this.project)+sk);}
 environmentFence(owner){return projectPrefix(owner,this.project)?[{ConditionCheck:{Key:key(owner,'PROJECT_META#'+this.project),ConditionExpression:'attribute_exists(pk)'}}]:[];}
 async environments(owner,access=null){const allowed=access?.environments;if(allowed){const all=await this.environments(owner);return all.filter(e=>allowed.includes(e.id));}const result=await this.store._page(pk(owner),projectPrefix(owner,this.project)+'ENVIRONMENT#',{limit:20});if(result.next)fail(503,'environment_list_incomplete');return [{id:'default',name:'Default',legacy:true},...result.items.map(r=>({id:r.id,name:r.name,legacy:false}))];}
 async pendingEnvironmentDeletions(owner,access){
  if(!['owner','admin'].includes(access.role)||access.environments)return [];
  const pending=[];let cursor;
  do{const page=await this.store._page(pk(owner),projectPrefix(owner,this.project)+'ENVIRONMENT_CLEANUP#',{limit:100,cursor});pending.push(...page.items.map(r=>({id:r.id,name:r.name})));cursor=page.next;}while(cursor);
  return pending;
 }
 async environment(owner,value='default'){const id=environmentId(value);if(id!=='default'&&!await this.store._get(this.environmentKey(owner,'ENVIRONMENT#'+id)))fail(403,'environment_unavailable');return id;}
 async createEnvironment(actor,access,data){
  authorizeRoute(access,'POST','/api/environments');if(!exact(data,['id','name'])||data.id==='default')fail(400,'invalid_environment');
  const id=environmentId(data.id),name=cleanName(data.name),meta=this.environmentKey(access.owner,'ENVIRONMENT_CAPACITY'),plan=await this.plan(access.owner),allowed=countLimit(plan,'environments')??ENVIRONMENT_CEILING;
  // The plan counts Default plus every created environment.
  requireCount(plan,'environments',1+((await this.store._get(meta))?.count??0));
  // A deleted environment's id is retired: reusing it would bring its old traces back under a new name.
  if(await this.store._get(this.environmentKey(access.owner,'ENVIRONMENT_RETIRED#'+id)))fail(409,'environment_id_retired');
  await this.tx([{Put:{Item:{...this.environmentKey(access.owner,'ENVIRONMENT#'+id),id,name},ConditionExpression:'attribute_not_exists(pk)'}},{ConditionCheck:{Key:this.environmentKey(access.owner,'ENVIRONMENT_RETIRED#'+id),ConditionExpression:'attribute_not_exists(pk)'}},{Update:{Key:meta,UpdateExpression:'ADD #n :one',ConditionExpression:'attribute_not_exists(#n) OR #n < :cap',ExpressionAttributeNames:{'#n':'count'},ExpressionAttributeValues:{':one':1,':cap':Math.min(allowed,ENVIRONMENT_CEILING)-1}}},this.audit(access.owner,'environment.create',id,{name}),...this.environmentFence(access.owner)],fence(access));
  return {id,name};
 }
 // Owners and admins of the whole organization rename or delete a created environment. Default is built in and stays.
 async renameEnvironment(actor,access,data){
  authorizeRoute(access,'POST','/api/environments/rename');if(!exact(data,['id','name'])||data.id==='default')fail(400,'invalid_environment');
  const id=await this.environment(access.owner,data.id),name=cleanName(data.name),old=await this.store._get(this.environmentKey(access.owner,'ENVIRONMENT#'+id));
  if(old.name===name)return {id,name};
  await this.tx([{Update:{Key:this.environmentKey(access.owner,'ENVIRONMENT#'+id),UpdateExpression:'SET #name = :name',ConditionExpression:'attribute_exists(pk) AND #name = :seen',ExpressionAttributeNames:{'#name':'name'},ExpressionAttributeValues:{':name':name,':seen':old.name}}},this.audit(access.owner,'environment.rename',id,{from:old.name,to:name}),...this.environmentFence(access.owner)],fence(access));
  return {id,name};
 }
 // Deleting an environment ends access to it at once: the row goes, so every read, upload and key bound to it is refused
 // (Workspaces.environment), and its keys are then revoked so they free their slots. Its id is retired. Stored traces are
 // erased by the existing scheduled worker after requests drain. `confirm` must repeat the id.
 async deleteEnvironment(actor,access,data){
  authorizeRoute(access,'POST','/api/environments/delete');if(!exact(data,['id','confirm'])||data.id==='default'||data.confirm!==data.id)fail(400,'invalid_environment');
  const id=environmentId(data.id),retiredKey=this.environmentKey(access.owner,'ENVIRONMENT_RETIRED#'+id),pendingKey=this.environmentKey(access.owner,'ENVIRONMENT_CLEANUP#'+id);
  const retired=await this.store._get(retiredKey);
  // Older logical deletions also get a durable physical-erasure job when retried.
  if(retired&&!retired.erased_at&&!await this.store._get({pk:SCOPE_ERASURE_QUEUE,sk:[access.owner,this.project??alphaProject(access.owner).id,id].join('#')})){
   await this.tx([scopeErasureItem(this.store,access.owner,this.project??alphaProject(access.owner).id,id),{ConditionCheck:{Key:retiredKey,ConditionExpression:'deleted_at = :closed',ExpressionAttributeValues:{':closed':retired.deleted_at}}},...this.environmentFence(access.owner)],fence(access));
  }
  if(retired?.keys_revoked_at)return {deleted:true,id,keys_revoked:retired.keys_revoked};
  if(!retired){
   const old=await this.store._get(this.environmentKey(access.owner,'ENVIRONMENT#'+id));if(!old)fail(403,'environment_unavailable');
   const now=this.store.now();
   await this.tx([{Delete:{Key:this.environmentKey(access.owner,'ENVIRONMENT#'+id),ConditionExpression:'attribute_exists(pk)'}},
    {Put:{Item:{...retiredKey,id,name:old.name,deleted_at:now,deleted_by:actor},ConditionExpression:'attribute_not_exists(pk)'}},
    {Put:{Item:{...pendingKey,id,name:old.name},ConditionExpression:'attribute_not_exists(pk)'}},
    {Update:{Key:this.environmentKey(access.owner,'ENVIRONMENT_CAPACITY'),UpdateExpression:'ADD #n :minus',ConditionExpression:'#n >= :one',ExpressionAttributeNames:{'#n':'count'},ExpressionAttributeValues:{':minus':-1,':one':1}}},
    scopeErasureItem(this.store,access.owner,this.project??alphaProject(access.owner).id,id),this.audit(access.owner,'environment.delete',id,{name:old.name}),...this.environmentFence(access.owner)],fence(access));
  }
  // Access ends before cleanup. Keep a visible retry marker until every key has been revoked.
  const scoped=environmentStore(this.store,{owner:access.owner,project:this.project,environment:id,stamp:this.stamp,access});
  let revoked=0,failed=false,cursor;
  try{
   do{const keys=await scoped.listWriteKeys(access.owner,{limit:100,cursor});for(const row of keys.items){
    if(row.revoked){revoked++;continue;}
    try{await scoped.revokeWriteKey(access.owner,row.token_hash);revoked++;}catch{failed=true;}
   }cursor=keys.next;}while(cursor);
  }catch{failed=true;}
  if(failed)fail(503,'environment_key_cleanup_pending');
  await this.tx([{Update:{Key:retiredKey,UpdateExpression:'SET keys_revoked_at = :now, keys_revoked = :count',ConditionExpression:'attribute_exists(pk)',ExpressionAttributeValues:{':now':this.store.now(),':count':revoked}}},{Delete:{Key:pendingKey}}],fence(access));
  return {deleted:true,id,keys_revoked:revoked};
 }
}

// Data keys are namespaced; quota/account/security rows are deliberately shared.
export function environmentStore(base,{owner,project=null,environment='default',stamp=null,access=null,issuer=null,keyBinding=null,keyAccess=null}={}){
 environmentId(environment);alphaProject(owner);const scoped=Object.create(base),projectTag=projectPrefix(owner,project),tag=projectTag+(environment==='default'?'':'ENV#'+environment+'#'),tenantPk=pk(owner);
 const mapKey=k=>{if(!k)return k;let {pk:p,sk:s}=k;if(tag){
  if(p===tenantPk&&/^(BATCH#|RUN#)/.test(s))s=tag+s;
  else if(p.startsWith(tenantPk+'#RUN#'))p=tenantPk+'#'+tag+p.slice(tenantPk.length+1);
 }return {...k,pk:p,sk:s};};
 scoped.projectId=project??alphaProject(owner).id;scoped.environmentId=environment;scoped.keyIssuer=issuer;scoped.keyIssuerVersion=access&&!access.personal?access.version:null;
 scoped._get=k=>base._get(mapKey(k));
 scoped._page=(p,s,opts)=>{const mapped=mapKey({pk:p,sk:s});return base._page(mapped.pk,mapped.sk,opts);};
 scoped._tx=items=>{const mapped=items.map(item=>{const [type,v]=Object.entries(item)[0];return {[type]:{...v,...(v.Key?{Key:mapKey(v.Key)}:{}),...(v.Item?{Item:mapKey(v.Item)}:{})}};});const guarded=stamp?guardedItems(base,mapped,stamp,fence(access)):mapped;if(projectTag)guarded.push({ConditionCheck:{Key:key(owner,'PROJECT_META#'+project),ConditionExpression:'attribute_exists(pk)'}});
  if(keyBinding){guarded.push({ConditionCheck:{Key:{pk:'WRITE#'+keyBinding.token_hash,sk:'KEY'},ConditionExpression:'token_hash = :hash AND revoked = :no AND expires_at > :now',ExpressionAttributeValues:{':hash':keyBinding.token_hash,':no':false,':now':base.now()}}});
   if(keyAccess?.roleFence)guarded.push(keyAccess.roleFence);
   if(keyAccess)guarded.push({ConditionCheck:{Key:key(owner,'MEMBER#'+keyBinding.issued_by),ConditionExpression:'active = :yes AND #v = :v AND #r = :r',ExpressionAttributeNames:{'#v':'version','#r':'role'},ExpressionAttributeValues:{':yes':true,':v':keyAccess.version,':r':keyAccess.storedRole??keyAccess.role}}});
  }return base._tx(guarded);};
 // Setup/lease/key rows remain globally bounded; list only keys in this environment.
 scoped.listWriteKeys=async(t,opts)=>{const r=await base.listWriteKeys(t,opts),items=[];for(const k of r.items.filter(k=>(k.environment_id??'default')===environment&&(k.project_id??alphaProject(owner).id)===scoped.projectId)){let active=true;try{await authorizeIssuedKey(base,k);}catch{active=false;}items.push({...k,authorization_active:active});}return {...r,items};};
 return scoped;
}
export async function authorizeIssuedKey(store,row){
 const owner=await store.getTenant(row.tenant_id),issuer=row.issued_by?await store.getTenant(row.issued_by):owner;
 if(Number.isSafeInteger(owner?.deleted_at)||Number.isSafeInteger(issuer?.deleted_at))fail(401,'invalid_write_key');
 if(row?.issued_by&&row.issued_by!==row.tenant_id){try{const a=await new Workspaces(store).access(row.issued_by,row.tenant_id);if(!KEY_ISSUER_ROLES.includes(a.role)||row.issued_membership_version!==a.version||(a.environments&&!a.environments.includes(row.environment_id??'default')))fail(401,'invalid_write_key');return a;}catch{fail(401,'invalid_write_key');}}
 return null;
}
export async function workspaceApi(request,env,actor){
 const store=env.store,stamp=await workspaceSession(request,store,actor),mfaOn=env.MFA_ENABLED===true||env.MFA_ENABLED==='true',spaces=new Workspaces(store,stamp,env.sourceIp,mfaOn,null,deploymentDomains(env)),u=new URL(request.url),owner=u.searchParams.get('workspace')??actor;
 const project=await requireProject(store,owner,u.searchParams.get('project'));spaces.project=project.id;
 // Every route that acts on one organization passes the same role table and the organization's two-factor rule.
 const gate=async org=>{const access=await spaces.access(actor,org);authorizeRoute(access,request.method,u.pathname);await spaces.requireMfa(actor,access);return access;};
 if(u.pathname==='/api/orgs/sso'||u.pathname.startsWith('/api/orgs/sso/'))return await orgSsoApi(request,env,actor,spaces,fence);
 if(request.method==='GET'){
  if(u.pathname==='/api/projects')return json({projects:await spaces.projects(actor)});
  if(u.pathname==='/api/workspaces')return json({workspaces:await spaces.list(actor)});
  if(u.pathname==='/api/orgs')return json(await spaces.organizations(actor));
  if(u.pathname==='/api/workspaces/invitations')return json(await spaces.pendingInvites(actor));
  if(u.pathname==='/api/workspaces/members'){await gate(owner);return json({members:await spaces.members(actor,owner)});}
  if(u.pathname==='/api/orgs/roles'){await gate(owner);return json(await spaces.roles(actor,owner));}
  if(u.pathname==='/api/environments'){const access=await gate(owner);return json({environments:await spaces.environments(owner,access),pending_deletions:await spaces.pendingEnvironmentDeletions(owner,access)});}
 }
 if(request.method!=='POST')fail(404,'not_found');requireOrigin(request,env.APP_ORIGIN);
 let d;try{d=JSON.parse(await boundedText(request,2048));}catch{fail(400,'invalid_workspace_request');}
 if(u.pathname==='/api/projects')return json(await spaces.createProject(actor,owner,d),201);
 if(u.pathname==='/api/projects/rename')return json(await spaces.renameProject(actor,owner,d));
 if(u.pathname==='/api/projects/delete')return json(await spaces.deleteProject(actor,owner,d),202);
 if(u.pathname==='/api/workspaces'&&exact(d,['name']))return json(await spaces.create(actor,d.name),201);
 if(u.pathname==='/api/orgs'&&exact(d,['name']))return json(await spaces.createOrganization(actor,d.name),201);
 if(u.pathname==='/api/orgs/security'&&exact(d,['organization_id','require_mfa'])){// The rule itself is behind the rule: an owner who does not meet it cannot lift it.
  await gate(d.organization_id);return json(await spaces.setRequireMfa(actor,d.organization_id,d.require_mfa));}
 if(['/api/orgs/rename','/api/orgs/transfer'].includes(u.pathname)&&typeof d?.organization_id==='string')await gate(d.organization_id);
 if(['/api/workspaces/invite','/api/workspaces/member','/api/environments','/api/environments/rename','/api/environments/delete'].includes(u.pathname))await gate(owner);
 if(u.pathname==='/api/orgs/rename'&&exact(d,['organization_id','name']))return json(await spaces.renameOrganization(actor,d.organization_id,d.name));
 if(u.pathname==='/api/orgs/transfer'&&exact(d,['organization_id','user_id','version']))return json(await spaces.transferOrganization(actor,d.organization_id,{user_id:d.user_id,version:d.version}));
 if(['/api/orgs/roles','/api/orgs/roles/delete'].includes(u.pathname)&&typeof d?.organization_id==='string'){const {organization_id,...rest}=d;await gate(organization_id);return json(u.pathname==='/api/orgs/roles'?await spaces.saveRole(actor,organization_id,rest):await spaces.deleteRole(actor,organization_id,rest),u.pathname==='/api/orgs/roles'&&!Object.hasOwn(rest,'id')?201:200);}
 if(u.pathname==='/api/orgs/delete'&&exact(d,['organization_id','confirm'])){await gate(d.organization_id);return json(await spaces.deleteOrganization(actor,d.organization_id,{confirm:d.confirm}));}
 if(u.pathname==='/api/orgs/leave'&&exact(d,['organization_id']))return json(await spaces.leaveOrganization(actor,d.organization_id));
 if(u.pathname==='/api/workspaces/invite')return json(await spaces.invite(actor,owner,d),201);
 if(u.pathname==='/api/workspaces/accept'&&exact(d,['workspace_id','token']))return json(await spaces.accept(actor,d.workspace_id,d.token));
 if(u.pathname==='/api/workspaces/accept'&&exact(d,['workspace_id']))return json(await spaces.accept(actor,d.workspace_id));
 if(u.pathname==='/api/workspaces/member')return json(await spaces.changeMember(actor,owner,d));
 if(u.pathname==='/api/environments')return json(await spaces.createEnvironment(actor,await spaces.access(actor,owner),d),201);
 if(u.pathname==='/api/environments/rename')return json(await spaces.renameEnvironment(actor,await spaces.access(actor,owner),d));
 if(u.pathname==='/api/environments/delete')return json(await spaces.deleteEnvironment(actor,await spaces.access(actor,owner),d));
 fail(400,'invalid_workspace_request');
}
