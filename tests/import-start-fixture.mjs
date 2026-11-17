import {privateLauncherFixture} from './private-launcher-fixture.mjs';
import {createPrivateImportConsentStore} from '../src/private-import-consent.mjs';
import {createImportStartController} from '../src/import-start.mjs';
import {createPrivateImportWorker} from '../src/private-import-launcher.mjs';
import {handle} from '../src/aws-api.mjs';
const origin='https://supatrace.dev';
export async function importStartFixture(){
 const f=await privateLauncherFixture();let policy=true,ready=true;
 const request=(data={fingerprint:f.input.fingerprint},changes={})=>new Request(origin+'/api/imports/start',{method:'POST',headers:{origin,cookie:'__Host-supatrace='+f.token,'content-type':'application/json'},body:JSON.stringify(data),...changes});
 const consentOptions={store:f.store,objects:f.objects,origin,runtime:f.runtime,authorize:async d=>policy&&['record-reviewed-private-import-consent','revoke-private-import-consent'].includes(d.action)};
 const consents=createPrivateImportConsentStore(consentOptions);
 const controllerOptions={store:f.store,objects:f.objects,origin,runtime:f.runtime,consents,authorize:f.options.authorize,readiness:async d=>ready&&d.descriptor.worker_id===f.runtime.worker_id};
 const controller=createImportStartController(controllerOptions),env={ENABLED:true,APP_ORIGIN:origin,GITHUB_CLIENT_ID:'synthetic',GITHUB_CLIENT_SECRET:'synthetic',store:f.store,objects:f.objects,importStartController:controller};
 const record=structuredClone(f.approvals.get(f.input.approval_id));
 const register=()=>consents.registerReviewedApproval(request(),record);
 const start=()=>handle(request(),env);
 return {...f,request,record,consents,consentOptions,controller,controllerOptions,env,register,start,
  policy:value=>{policy=value;},ready:value=>{ready=value;},
  jobRows:()=>[...f.client.items.values()].filter(r=>r.sk?.startsWith('IMPORTJOB#')),
  worker:()=>{const {authenticate,...options}=f.options;return createPrivateImportWorker({...options,approvalProvider:consents.provide,authorize:async d=>['consume-private-import-assignment','complete-private-import-assignment','release-private-import-assignment'].includes(d.descriptor.action)?true:options.authorize(d)});}
 };
}
