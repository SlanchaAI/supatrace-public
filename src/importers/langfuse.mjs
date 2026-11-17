import {normalizeTimestamp} from './timestamps.mjs';
import {createHash} from 'node:crypto';
export const LIMITS={inputBytes:20*1024*1024,rows:100000,eventBytes:32768,batchBytes:524288,batchEvents:100};
export const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const hash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const bytes=v=>Buffer.byteLength(JSON.stringify(v));
const time=v=>normalizeTimestamp(v)!==null;
export function convert(raw,{namespace}={}){
 if(typeof namespace!=='string'||!namespace.trim()||namespace.length>200)throw new Error('namespace_required');
 if(typeof raw!=='string'||Buffer.byteLength(raw)>LIMITS.inputBytes)throw new Error('input_too_large');
 const input=JSON.parse(raw);const stack=[[input,0]];while(stack.length){const [value,depth]=stack.pop();if(depth>28)throw new Error('input_nesting_too_deep');if(typeof value==='number'&&(!Number.isFinite(value)||(Number.isInteger(value)&&!Number.isSafeInteger(value))))throw new Error('unsafe_number_encode_as_string');if(value&&typeof value==='object')for(const child of Object.values(value))stack.push([child,depth+1]);}const pages=Array.isArray(input?.pages)?input.pages:[input];
 if(!pages.length)throw new Error('empty_pages');let rows=[];
 for(let i=0;i<pages.length;i++){const p=pages[i];if(!p||!Array.isArray(p.data)||!p.meta)throw new Error('expected_v2_page_with_cursor');if(i<pages.length-1&&(typeof p.meta.cursor!=='string'||!p.meta.cursor))throw new Error('page_sequence_invalid');if(i===pages.length-1&&p.meta.cursor!=null)throw new Error('incomplete_pagination');rows.push(...p.data);if(rows.length>LIMITS.rows)throw new Error('too_many_rows');}
 const report={format:'langfuse-observations-v2-file',namespace,inputRows:rows.length,duplicateRows:0,acceptedRows:0,acceptedTraces:0,rejected:[],warnings:['File pagination markers do not prove source completeness. Bounded exports may omit earlier/later observations; no capture completeness or anonymity claim.','Source rows preserved verbatim as JSON values; raw byte formatting/object key order is not preserved.','One observation per stable-ID batch enables overlap deduplication. Existing backend batch-key ordering does not guarantee chronological multi-observation export; timestamps and original source fields remain intact.','Observation types are represented as note/error events, not native SupaTrace span semantics. No trace-level legacy metadata, scores or attachments inferred.'],losses:['Original JSON formatting/key order not preserved','API page envelope metadata is not emitted as trace events','Native span-tree/type semantics are not implemented; original observation fields remain in data'],idMap:[]};
 const groups=new Map();
 for(let index=0;index<rows.length;index++){const row=rows[index];if(!row||typeof row!=='object'||Array.isArray(row)||typeof row.traceId!=='string'||!row.traceId||typeof row.id!=='string'||!row.id){report.rejected.push({rowIndex:index,reason:'missing_trace_or_observation_id'});continue;}if(!groups.has(row.traceId))groups.set(row.traceId,{rows:new Map(),issues:[]});const g=groups.get(row.traceId);if(g.rows.has(row.id)){if(hash(g.rows.get(row.id))!==hash(row))g.issues.push('conflicting_duplicate_observation');else report.duplicateRows++;}else g.rows.set(row.id,row);}
 const batches=[];
 for(const [traceId,g] of [...groups].sort(([a],[b])=>a.localeCompare(b))){const run='lf.'+hash([namespace,traceId]);const events=[];const warnings=[];
 for(const row of g.rows.values()){
  if(!time(row.startTime)){g.issues.push('invalid_start_time');continue;}
  if(row.parentObservationId!=null&&typeof row.parentObservationId!=='string'){g.issues.push('invalid_parent_id');continue;}
  if(row.parentObservationId&&!g.rows.has(row.parentObservationId))warnings.push({observationId:row.id,reason:'parent_not_present',parentObservationId:row.parentObservationId});
  const data={source:'langfuse-observations-v2',namespace,observation:row};
  if(bytes(data)>LIMITS.eventBytes){g.issues.push('event_data_exceeds_32KiB');continue;}
  const event={id:'lf.'+hash([namespace,traceId,row.id]),time:new Date(row.startTime).toISOString(),kind:row.level==='ERROR'?'error':'note',name:'Imported Langfuse observation',data};events.push(event);
 }
 if(g.issues.length){report.rejected.push({sourceTraceId:traceId,reason:'whole_trace_rejected',issues:[...new Set(g.issues)],rows:g.rows.size});continue;}
 events.sort((a,b)=>a.time.localeCompare(b.time)||a.id.localeCompare(b.id));const built=events.map(event=>({version:1,run_id:run,batch_id:'lf.'+hash([namespace,traceId,event.data.observation.id]),events:[event]}));
 batches.push(...built);report.acceptedRows+=events.length;report.acceptedTraces++;report.idMap.push({sourceTraceId:traceId,runId:run});report.warnings.push(...warnings);
 }
 report.outputBatches=batches.length;report.sourceRowsNotImported=rows.length-report.acceptedRows-report.duplicateRows;return {batches:batches.map(canonical),report};
}
