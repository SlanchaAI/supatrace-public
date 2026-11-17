import {createHash} from 'node:crypto';
import {HttpError} from './http.mjs';

// The existing AWS tenant is the alpha's one account workspace, not a new quota
// per project. This projection preserves existing S3/index/counter ownership.
const githubTenant=/^github-[1-9][0-9]{0,15}$/;
const hashedTenant=/^(google|email|chatgpt|sso)-[a-f0-9]{64}$/;
export function alphaProject(tenantId){
  const github=typeof tenantId==='string'&&githubTenant.test(tenantId)&&Number.isSafeInteger(Number(tenantId.slice(7)));
  const hashed=typeof tenantId==='string'&&hashedTenant.exec(tenantId);
  if(!github&&!hashed)throw new HttpError(400,'invalid_tenant');
  return {id:'proj_'+createHash('sha256').update('supatrace-alpha-project:'+tenantId).digest('hex').slice(0,32),
    name:'Default project',scope:'account_workspace',accounting_scope:github?'github_account':hashed[1]+'_account',additional_projects_available:false};
}
export function requireAlphaProject(tenantId,requested){
  const project=alphaProject(tenantId);
  if(requested!==null&&requested!==undefined&&requested!==project.id)throw new HttpError(403,'project_unavailable');
  return project;
}
