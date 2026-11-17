import {createHash} from 'node:crypto';
import {HttpError} from './http.mjs';

// The existing AWS tenant is the alpha's one account workspace, not a new quota
// per project. This projection preserves existing S3/index/counter ownership.
const githubTenant=/^github-[1-9][0-9]{0,15}$/;
const hashedTenant=/^(google|email|chatgpt|sso)-[a-f0-9]{64}$/;
// A created organization is one more tenant partition. Its id is random, so no sign-in provider can produce it.
const organizationTenant=/^org-[a-f0-9]{32}$/;
export const isOrganizationId=value=>typeof value==='string'&&organizationTenant.test(value);
export function alphaProject(tenantId){
  const github=typeof tenantId==='string'&&githubTenant.test(tenantId)&&Number.isSafeInteger(Number(tenantId.slice(7)));
  const hashed=typeof tenantId==='string'&&hashedTenant.exec(tenantId);
  const organization=isOrganizationId(tenantId);
  if(!github&&!hashed&&!organization)throw new HttpError(400,'invalid_tenant');
  return {id:'proj_'+createHash('sha256').update('supatrace-alpha-project:'+tenantId).digest('hex').slice(0,32),
    name:'Default project',scope:'account_workspace',accounting_scope:github?'github_account':organization?'organization':hashed[1]+'_account',additional_projects_available:false};
}
export function requireAlphaProject(tenantId,requested){
  const project=alphaProject(tenantId);
  if(requested!==null&&requested!==undefined&&requested!==project.id)throw new HttpError(403,'project_unavailable');
  return project;
}

// Additional projects share their organization's plan and quota; only data and environment namespaces differ.
export const projectId=value=>typeof value==='string'&&/^proj_[a-f0-9]{32}$/.test(value);
export const projectPrefix=(owner,id)=>id&&id!==alphaProject(owner).id?'PROJECT#'+id+'#':'';
export async function requireProject(store,owner,requested){
 const legacy=alphaProject(owner);
 if(requested===null||requested===undefined||requested===legacy.id){
  const row=typeof store._get==='function'?await store._get({pk:'TENANT#'+owner,sk:'PROJECT_META#'+legacy.id}):null;
  return {...legacy,...(row?{name:row.name}:{}),additional_projects_available:true};
 }
 if(!projectId(requested)||typeof store._get!=='function')throw new HttpError(403,'project_unavailable');
 const row=await store._get({pk:'TENANT#'+owner,sk:'PROJECT_META#'+requested});
 if(!row||row.id!==requested)throw new HttpError(403,'project_unavailable');
 return {...legacy,id:row.id,name:row.name,additional_projects_available:true};
}
