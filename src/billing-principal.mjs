// Server-derived scope only. No route, commercial policy, credential lookup or access grant.
import {session} from './aws-auth.mjs';
import {Workspaces,workspaceSession,environmentStore} from './workspaces.mjs';
import {requireAlphaProject} from './alpha-projects.mjs';
import {HttpError} from './http.mjs';
const fail=(status,code)=>{throw new HttpError(status,code);};
const keys=['version','workspace_id','project_id','environment_id','origin'];
export function checkoutScope(value,tenant,origin){
 if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).sort().join()!==[...keys].sort().join()||value.version!==1||value.workspace_id!==tenant||value.project_id!==requireAlphaProject(tenant).id||value.environment_id!=='default'||value.origin!==origin||!['https://supatrace.dev','https://supatrace.tech'].includes(origin))fail(409,'billing_scope_mismatch');
 return {version:1,workspace_id:tenant,project_id:value.project_id,environment_id:'default',origin};
}
export async function resolveBillingPrincipal(request,env,tenant){
 const base=env.store,url=new URL(request.url);
 for(const key of ['workspace','project','environment'])if(url.searchParams.getAll(key).length>1)fail(400,'invalid_query');
 const actor=await session(request,base),owner=url.searchParams.get('workspace')??actor;
 // Access boundary: the organization's owner only. No admin, viewer, delegated payer or non-default billing.
 if(owner!==tenant||(url.searchParams.get('environment')??'default')!=='default')fail(403,'workspace_owner_required');
 const project=requireAlphaProject(owner,url.searchParams.get('project'));
 const access=await new Workspaces(base).access(actor,owner);
 if(access.role!=='owner'||access.owner!==owner)fail(403,'workspace_owner_required');
 const stamp=await workspaceSession(request,base,actor);
 const descriptor=Object.freeze(checkoutScope({version:1,workspace_id:owner,project_id:project.id,environment_id:'default',origin:env.APP_ORIGIN},owner,env.APP_ORIGIN));
 async function assertCurrent(){
  if(request.signal.aborted)fail(409,'billing_request_cancelled');
  const account=await base.getTenant(actor);if(!account||account.tenant_id!==actor)fail(401,'sign_in_required');
  const current=await workspaceSession(request,base,actor);
  if(current.epoch!==stamp.epoch||current.tokenHash!==stamp.tokenHash||JSON.stringify(current.sessionKey)!==JSON.stringify(stamp.sessionKey))fail(409,'billing_scope_changed');
  const workspace=await base._get({pk:'TENANT#'+owner,sk:'WORKSPACE#META'});
  if(workspace&&workspace.owner!==actor)fail(409,'billing_scope_changed');
  // A created organization's owner is a member: ownership may have been transferred since this request began.
  if(owner!==actor){let now;try{now=await new Workspaces(base).access(actor,owner);}catch{fail(409,'billing_scope_changed');}if(now.role!=='owner'||now.version!==access.version)fail(409,'billing_scope_changed');}
  if(request.signal.aborted)fail(409,'billing_request_cancelled');
 }
 await assertCurrent();
 // Reuse atomic session/epoch conditions on every durable intent/receipt write.
 return {descriptor,assertCurrent,store:environmentStore(base,{owner,environment:'default',stamp,access,issuer:actor})};
}
export function guardBillingRuntime(c,principal){
 const wrap=fn=>async(...args)=>{await principal.assertCurrent();const value=await fn(...args);await principal.assertCurrent();return value;};
 c.authorize=wrap(c.authorize);
 c.methods=Object.fromEntries(Object.entries(c.methods).map(([name,fn])=>[name,wrap(fn)]));
 return c;
}
