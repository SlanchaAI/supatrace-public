import {cookie,digest} from './aws-auth.mjs';
import {HttpError,json,boundedText,requireOrigin} from './http.mjs';
import {ImportJobLedger} from './import-job-ledger.mjs';
export const importJobControlAvailable = env => env.importJobControl?.enabled===true&&env.importJobControl?.mode==='control-only';
export async function importJobApi(request,env,tenant) {
  if(request.method==='POST')requireOrigin(request,env.APP_ORIGIN);
  if(!importJobControlAvailable(env))throw new HttpError(503,'import_job_control_unavailable');
  const path=new URL(request.url).pathname,match=/^\/api\/imports\/jobs\/(ij_[a-f0-9]{64})(?:\/(cancel|reconcile))?$/.exec(path);
  const token=cookie(request,'__Host-supatrace');
  if(typeof env.store.getImportSessionStamp!=='function'||!/^[-A-Za-z0-9_]{43}$/.test(token??''))throw new HttpError(401,'sign_in_required');
  const parentSession=await env.store.getImportSessionStamp(digest(token));
  if(!parentSession||parentSession.tenant_id!==tenant)throw new HttpError(401,'sign_in_required');
  const ledger=new ImportJobLedger(env.store,{objects:env.objects,parentSession});
  if(request.method==='GET'&&match&&!match[2])return json(await ledger.status(tenant,match[1]));
  if(request.method!=='POST')throw new HttpError(404,'not_found');
  let data;try{data=JSON.parse(await boundedText(request,8192));}catch(e){if(e instanceof HttpError)throw e;throw new HttpError(400,'invalid_import_job');}
  if(path==='/api/imports/jobs') {
    if(!data||Object.getPrototypeOf(data)!==Object.prototype||Object.keys(data).sort().join()!=='fingerprint,plan')throw new HttpError(400,'invalid_import_job');
    return json(await ledger.create(tenant,data.plan,data.fingerprint),202);
  }
  if(!match||!match[2]||!data||Object.getPrototypeOf(data)!==Object.prototype||Object.keys(data).length)throw new HttpError(400,'invalid_import_job');
  return json(await (match[2]==='cancel'?ledger.cancel(tenant,match[1]):ledger.reconcileNext(tenant,match[1])));
}
