// No credential discovery, default network, upload or live CLI activation.
import {captureLangfuseWithTransport} from './langfuse-transport.mjs';import {planCapture,approveCapturedStage} from './langfuse-capture.mjs';
const clone=v=>JSON.parse(JSON.stringify(v));
export async function runLangfuseWorkflow(spec,dependencies={}){
 const {fetchImpl,credentialProvider,authorize,saveCheckpoint,stage,bounds,checkpoint=null}=dependencies;
 if([fetchImpl,credentialProvider,authorize,saveCheckpoint,stage].some(v=>typeof v!=='function'))throw Error('explicit_runtime_dependencies_required');
 const limits=clone(bounds);const started=performance.now();
 const plan=planCapture(spec),scope=clone(plan.scope);
 async function boundedHook(fn,code){const remaining=limits.totalTimeoutMs-(performance.now()-started),ms=Math.min(limits.requestTimeoutMs,remaining);if(!(ms>0))throw Error(code+'_timeout');const controller=new AbortController();let timer;try{return await Promise.race([Promise.resolve().then(()=>fn(controller.signal)),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error(code+'_timeout'));},ms);})]);}finally{clearTimeout(timer);}}
 const result=await captureLangfuseWithTransport(scope,{fetchImpl,credentialProvider,authorize,saveCheckpoint,bounds:limits,checkpoint});
 if(result.outcome!=='captured')return {outcome:result.outcome,capture:result,staged:false,uploaded:false};
 const approved=await approveCapturedStage(result,async descriptor=>{try{return await boundedHook(signal=>authorize(clone(descriptor),{signal}),'destination_approval');}catch{throw Error('destination_approval_callback_failed');}});
 const payload=clone({destinationProject:scope.destinationProject,fingerprint:plan.fingerprint,conversionHash:approved.conversionHash,batches:result.conversion.batches,report:result.conversion.report});
 try{await boundedHook(signal=>stage(payload,{signal}),'stage_outcome_uncertain');}catch{throw Error('local_stage_outcome_unverified');}
 return {outcome:'stage-callback-completed',capture:result,receipt:{...approved,stageCallbackCompleted:true,persistenceVerified:false},staged:false,stageCallbackCompleted:true,uploaded:false};
}
