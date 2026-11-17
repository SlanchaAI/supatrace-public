// Authenticated, stateless planning only. No provider/credential/job/storage hooks.
import {HttpError} from './http.mjs';import {planCapture} from './importers/langfuse-capture.mjs';import {LANGFUSE_CLOUD_ORIGINS} from './importers/langfuse-transport.mjs';
export function importCapabilities(projectId){return {project_id:projectId,planning_available:true,execution_available:false,provider:'langfuse',origins:[...LANGFUSE_CLOUD_ORIGINS],missing:['secure_source_credential_binding','genuine_per_action_authorization','private_job_runner','separate_destination_upload_authorization'],one_click:false};}
import {LANGFUSE_SANITIZATION_POLICY} from './importers/langfuse-sanitization.mjs';
export function planCustomerImport(data,projectId,{serverPull=false}={}){
 const allowed=['provider','origin','sourceProject','environment','traceId','namespace','from','to','maxRows','maxPages','pageSize','maxBytes','maxRetries',...(serverPull?['sanitizationPolicy']:[])];
 if(!data||Object.getPrototypeOf(data)!==Object.prototype||Object.keys(data).some(k=>!allowed.includes(k))||data.provider!=='langfuse'||!LANGFUSE_CLOUD_ORIGINS.includes(data.origin)||!/^proj_[a-f0-9]{32}$/.test(projectId)||!/^[-A-Za-z0-9_]{1,128}$/.test(data.sourceProject||'')||typeof data.environment!=='string'||!data.environment||typeof data.namespace!=='string'||!/^[-A-Za-z0-9_.:]{1,128}$/.test(data.namespace))throw new HttpError(400,'invalid_import_plan');
 if(Object.hasOwn(data??{},'sanitizationPolicy')&&data.sanitizationPolicy!==LANGFUSE_SANITIZATION_POLICY)throw new HttpError(400,'invalid_import_plan');
 let plan;try{const selected=Object.hasOwn(data,'traceId'),traceId=selected?data.traceId:undefined;if('traceId' in data&&!selected)throw Error('invalid_trace');const {provider,...spec}=data;plan=planCapture({...spec,...(selected?{traceId}:{}),destinationProject:projectId,...(serverPull?{sanitizationPolicy:LANGFUSE_SANITIZATION_POLICY}:{})});}catch{throw new HttpError(400,'invalid_import_plan');}
 return {capabilities:importCapabilities(projectId),plan,side_effects:{provider_requests:0,credential_reads:0,staged_batches:0,uploaded_batches:0,persisted_jobs:0},status:'planned_not_authorized_not_started'};
}
