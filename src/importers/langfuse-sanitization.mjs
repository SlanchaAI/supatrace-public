// Versioned, structural redaction for in-app pull. This is not an anonymity guarantee.
import {hash} from './langfuse.mjs';
export const LANGFUSE_SANITIZATION_POLICY='langfuse-structured-v1';
export const sanitizationDisclosure=()=>({
 policy:LANGFUSE_SANITIZATION_POLICY,
 before_checkpoint:true,
 removed_fields:['projectId','userId','sessionId','experiment_run_name','scope.attributes.public_key','resourceAttributes.service.instance.id'],
 pseudonymized_fields:['top-level observation id','traceId','parentObservationId','observationId','spanId','parentSpanId','dataset_id','dataset_item_id'],
 retained_content:'Input/output, prompts and other unlisted content remain. Review for sensitive text; no anonymity guarantee.',
 control_data:'The private plan retains the approved source binding. Opaque pagination cursors remain only in the private checkpoint.'
});
const fail=code=>{throw new Error(code);};
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const normalized=s=>s.toLowerCase().replace(/[^a-z0-9]/g,'');
const forbidden=(key,path)=>['projectid','userid','sessionid','experimentrunname'].includes(normalized(key.split('.').at(-1)))||['scopeattributespublickey','resourceattributesserviceinstanceid'].some(s=>normalized(path).endsWith(s));
function kind(key,depth){
 const k=normalized(key.split('.').at(-1));
 if(key==='id'&&depth===0||['observationid','parentobservationid','spanid','parentspanid'].includes(k))return 'observation';
 if(k==='traceid')return 'trace';
 if(k==='datasetid')return 'dataset';
 if(k==='datasetitemid')return 'item';
 return null;
}
export function pseudonymizeLangfuseId(value,kind,scope){
 if(typeof value!=='string'||!value||value.length>8192)fail('sanitization_invalid_identifier');
 // Domain separation preserves topology and stable overlap IDs without saving an ID map.
 // These hashes are not secret/salted anonymization and must not be presented as such.
 return 'lf_'+kind+'_'+hash([LANGFUSE_SANITIZATION_POLICY,scope.origin,scope.sourceProject,scope.destinationProject,scope.namespace,kind,value]);
}
const validId=(value,type)=>typeof value==='string'&&new RegExp('^lf_'+type+'_[a-f0-9]{64}$').test(value);
function visit(value,scope,{verify=false,path='',depth=0}={}){
 // convert() counts four additional levels for {pages:[{data:[row]}]}.
 if(depth>24)fail('sanitization_nesting_bound');
 if(typeof value==='number'&&(!Number.isFinite(value)||(Number.isInteger(value)&&!Number.isSafeInteger(value))))fail('sanitization_unsafe_number');
 if(Array.isArray(value))return value.filter(v=>{
  // Reject/remove equivalent OTEL attribute key/value entries, without treating
  // arbitrary content arrays as a supported identity representation.
  if(object(v)&&typeof v.key==='string'&&forbidden(v.key,path+'.'+v.key)){if(verify)fail('checkpoint_unsanitized');return false;}
  return true;
 }).map(v=>visit(v,scope,{verify,path,depth:depth+1}));
 if(!object(value))return value;
 const entries=[];
 for(const [key,child] of Object.entries(value)){
  const next=path?path+'.'+key:key;
  if(forbidden(key,next)){if(verify)fail('checkpoint_unsanitized');continue;}
  if(depth>=24)fail('sanitization_nesting_bound');
  const type=kind(key,depth);
  if(type){
   const optional=normalized(key.split('.').at(-1))!=='id'&&normalized(key.split('.').at(-1))!=='traceid';
   if(optional&&(child===null||child==='')){entries.push([key,child]);continue;}
   if(verify){if(!validId(child,type))fail('checkpoint_unsanitized');entries.push([key,child]);}
   else entries.push([key,pseudonymizeLangfuseId(child,type,scope)]);
  }else entries.push([key,visit(child,scope,{verify,path:next,depth:depth+1})]);
 }
 return Object.fromEntries(entries);
}
export function sanitizeLangfusePage(page,scope){
 // All other envelope/meta values are provider-controlled and not needed for resume.
 return {data:page.data.map(row=>visit(row,scope)),meta:{cursor:page.meta.cursor??null}};
}
export function assertSanitizedLangfuseRow(row,scope){
 if(!object(row)||!validId(row.id,'observation')||!validId(row.traceId,'trace'))fail('checkpoint_unsanitized');
 visit(row,scope,{verify:true});
}
