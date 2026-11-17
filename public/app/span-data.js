// Derive a span waterfall and LLM totals from one trace's accepted events.
// Pure and bounded: no DOM, no network, and the original events are never rewritten.
// Explicit spans come from event data that carries a span id (OTLP ingest or hand-built); everything else is paired
// by event order and reported as inferred, because order alone cannot prove nesting.
import {priceFor} from './model-prices.js';
export const SPAN_LIMITS=Object.freeze({events:10000,depth:32,idChars:128});
const fail=code=>{throw new Error(code);};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const own=(source,key)=>Object.hasOwn(source,key)?source[key]:undefined;
const label=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max?value:null;
// OTel attributes arrive as flat dotted keys; SDK payloads nest. Accept both, own keys only.
function pick(source,path){
 if(Object.hasOwn(source,path))return source[path];
 let at=source;for(const part of path.split('.')){if(!object(at)||!Object.hasOwn(at,part))return undefined;at=at[part];}
 return at;
}
function first(sources,paths,accept){for(const path of paths)for(const source of sources){const value=accept(pick(source,path));if(value!==null)return value;}return null;}
const tokens=value=>{const number=typeof value==='string'&&/^\d{1,15}$/.test(value)?Number(value):value;return Number.isSafeInteger(number)&&number>=0?number:null;};
const SERVED=['gen_ai.response.model','llm.response.model'],MODEL=[...SERVED,'gen_ai.request.model','llm.model_name','llm.request.model','model'];
const INPUT=['usage.input','gen_ai.usage.input_tokens','gen_ai.usage.prompt_tokens','llm.token_count.prompt','llm.usage.prompt_tokens','usage.input_tokens','usage.prompt_tokens'];
const OUTPUT=['usage.output','gen_ai.usage.output_tokens','gen_ai.usage.completion_tokens','llm.token_count.completion','llm.usage.completion_tokens','usage.output_tokens','usage.completion_tokens'];
const CALL=['tool_call_id','call_id','gen_ai.tool.call.id'];
// What the producer says a span is: OTel gen_ai.operation.name or OpenInference span kind.
const DECLARED=['gen_ai.operation.name','openinference.span.kind'];
const amount=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const ROLE=new Map([['chat','llm'],['text_completion','llm'],['generate_content','llm'],['embeddings','llm'],['llm','llm'],['embedding','llm'],['execute_tool','tool'],['tool','tool'],['invoke_agent','agent'],['create_agent','agent'],['agent','agent'],['chain','agent']]);
// ISO text, or OTLP unix nanoseconds as digits. Anything else is ignored, not guessed.
function instant(value){
 if(typeof value==='string'&&/^\d{16,19}$/.test(value))return Number(BigInt(value)/1000000n);
 if(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)){const time=Date.parse(value);return Number.isFinite(time)?time:null;}
 return null;
}
const failed=sources=>sources.some(source=>{const status=pick(source,'otel.status_code')??pick(source,'status.code')??pick(source,'status');return status==='ERROR'||status==='error'||status==='STATUS_CODE_ERROR'||status===2;});

export function buildSpans(events){
 if(!Array.isArray(events)||events.length>SPAN_LIMITS.events)fail('invalid_span_input');
 const spans=[],explicit=new Map(),openCalls=[],openTools=[];let inferred=false;
 const create=(event,index,type)=>{const time=Date.parse(event.time);const span={id:'event:'+event.id,parent:null,name:event.name,type,start:time,end:time,status:null,model:null,input_tokens:null,output_tokens:null,events:[],inferred:false,unfinished:false,order:index,reported_cost:null,role:null,call_events:false,tool_events:false,opened:false,closed:false,from:null,to:null,length:null};spans.push(span);return span;};
 const absorb=(span,event,sources)=>{
  const time=Date.parse(event.time);span.start=Math.min(span.start,time);span.end=Math.max(span.end,time);span.events.push(event.id);
  // The model the provider reports serving wins over the one requested.
  span.model=first(sources,SERVED,value=>label(value,200))??span.model??first(sources,MODEL,value=>label(value,200));
  // A later event of the same span (the response) carries the final usage; it wins.
  const input=first(sources,INPUT,tokens),output=first(sources,OUTPUT,tokens);if(input!==null)span.input_tokens=input;if(output!==null)span.output_tokens=output;
  if(event.kind==='error'||failed(sources))span.status='error';else span.status??='ok';
  if(event.kind==='request'||event.kind==='response')span.call_events=true;if(event.kind==='tool_call'||event.kind==='tool_result')span.tool_events=true;
  if(event.kind==='request'||event.kind==='tool_call')span.opened=true;else if(event.kind!=='note')span.closed=true;
 };
 events.forEach((event,index)=>{
  if(!object(event)||typeof event.id!=='string'||typeof event.name!=='string'||!Number.isFinite(Date.parse(event.time)))fail('invalid_span_input');
  const data=object(event.data)?event.data:null;
  // The OTLP endpoint stores one event per span with a summary under data.span (spanId, parentSpanId,
  // nanosecond times, kind, model, usage.input/output, reported_cost). Hand-built batches put the
  // same facts on data itself, with gen_ai.* attributes. Read whichever this event carries.
  const summary=data&&object(own(data,'span'))&&label(own(data.span,'spanId'),SPAN_LIMITS.idChars)!==null?data.span:null,described=summary??data;
  const sources=summary?[summary]:data?[own(data,'attributes'),data].filter(object):[];
  const spanId=described?label(own(described,'span_id')??own(described,'spanId'),SPAN_LIMITS.idChars):null;
  if(spanId){
   let span=explicit.get(spanId);
   if(!span){span=create(event,index,'span');span.id=spanId;explicit.set(spanId,span);}
   span.parent??=label(own(described,'parent_span_id')??own(described,'parentSpanId'),SPAN_LIMITS.idChars);
   absorb(span,event,sources);
   span.role??=first(sources,summary?['kind',...DECLARED]:DECLARED,value=>typeof value==='string'?ROLE.get(value.toLowerCase())??null:null);
   const start=instant(own(described,'start_time')??own(described,'startTimeUnixNano')??own(described,'startTime')),end=instant(own(described,'end_time')??own(described,'endTimeUnixNano')??own(described,'endTime')),length=amount(own(described,'duration_ms'));
   if(start!==null)span.from=span.from===null?start:Math.min(span.from,start);if(end!==null)span.to=span.to===null?end:Math.max(span.to,end);
   if(length!==null&&length<=86400000)span.length=Math.round(length);
   // A cost the instrumentation itself reported is used as given; the price table is the fallback.
   if(summary)span.reported_cost=amount(own(summary,'reported_cost'))??span.reported_cost;
   return;
  }
  inferred=true;
  if(event.kind==='request'){const span=create(event,index,'llm');span.inferred=span.unfinished=true;absorb(span,event,sources);openCalls.push(span);return;}
  if(event.kind==='tool_call'){const span=create(event,index,'tool');span.inferred=span.unfinished=true;span.call=first(sources,[...CALL,'id'],value=>label(value,200));absorb(span,event,sources);openTools.push(span);return;}
  let target=null;
  if(event.kind==='response')target=openCalls.pop()??null;
  else if(event.kind==='tool_result'){
   const call=first(sources,CALL,value=>label(value,200));
   let at=call===null?-1:openTools.findIndex(span=>span.call===call);
   if(at<0)at=openTools.findIndex(span=>span.name===event.name);
   if(at<0&&openTools.length)at=0;
   if(at>=0)target=openTools.splice(at,1)[0];
  }
  if(target){target.unfinished=false;absorb(target,event,sources);return;}
  const span=create(event,index,'event');span.inferred=true;absorb(span,event,sources);
 });
 // Settle each explicit span once all of its events are in. The span's own boundaries win
 // over event timestamps, which record delivery, not the work. own_usage marks a model call:
 // its tokens are its own even when a nested call reports usage too.
 for(const span of explicit.values()){
  // Use what the span states: start and end, or either one with a duration. Event time fills only what is missing.
  let start,end;
  if(span.from!==null){start=span.from;end=span.to??(span.length===null?Math.max(span.end,start):start+span.length);}
  else if(span.to!==null){end=span.to;start=span.length===null?Math.min(span.start,end):end-span.length;}
  else{start=span.start;end=span.length===null?span.end:start+span.length;}
  if(end<start)end=start;
  span.start=start;span.end=end;
  span.unfinished=span.opened&&!span.closed&&span.to===null&&span.length===null;
  span.type=span.role??(span.call_events?'llm':span.tool_events?'tool':span.model!==null?'llm':'span');
  // A span is a rollup only on evidence: a declared agent or chain, or an undeclared span with no model of its own.
  span.own_usage=span.role==='llm'||span.role===null&&(span.call_events||span.model!==null);
 }
 for(const span of spans){if(span.inferred)span.own_usage=span.type==='llm';for(const key of ['call','role','call_events','tool_events','opened','closed','from','to','length'])delete span[key];}
 // Parents are resolved to span objects, never looked up by display id: an inferred span's
 // id (event:<id>) is customer-influenced text and must not collide with an explicit span_id.
 for(const span of spans){const up=span.parent===null||span.inferred?null:explicit.get(span.parent)??null;span.up=up===span?null:up;}
 // Break cycles and over-deep chains by detaching the offending span to the root.
 for(const span of spans){const seen=new Set([span]);let at=span,steps=0;while(at.up!==null){const up=at.up;if(seen.has(up)||++steps>=SPAN_LIMITS.depth){span.up=null;break;}seen.add(up);at=up;}}
 const children=new Map();for(const span of spans){if(!children.has(span.up))children.set(span.up,[]);children.get(span.up).push(span);}
 for(const list of children.values())list.sort((a,b)=>a.start-b.start||a.order-b.order);
 const rows=[];let traceStart=Infinity,traceEnd=-Infinity;
 // A model call always counts its own usage. A declared agent or chain, or an undeclared span
 // with no model, that reports usage counts only when nothing beneath it does: there it is the sole record, and
 // otherwise it is taken as a rollup of its children so the same tokens are not added twice.
 const walk=(span,depth)=>{
  const row={...span,parent:span.up===null?null:span.up.id,depth};delete row.order;delete row.own_usage;delete row.up;rows.push(row);traceStart=Math.min(traceStart,span.start);traceEnd=Math.max(traceEnd,span.end);
  let nested=false;for(const child of children.get(span)??[])nested=walk(child,depth+1)||nested;
  // A span reports usage when it carries tokens or a cost of its own; OTLP spans can carry either alone.
  const metered=span.input_tokens!==null||span.output_tokens!==null,reports=metered||span.reported_cost!==null;
  row.counted=reports&&(span.own_usage===true||!nested);row.cost_usd=null;row.cost_reported=false;delete row.reported_cost;
  if(row.counted){
   const price=span.model===null?null:priceFor(span.model);
   if(span.reported_cost!==null){row.cost_usd=span.reported_cost;row.cost_reported=true;}
   else if(price&&metered)row.cost_usd=((span.input_tokens??0)*price.input+(span.output_tokens??0)*price.output)/1000000;
  }
  return reports||nested;
 };
 for(const root of children.get(null)??[])walk(root,0);
 const totals={input_tokens:0,output_tokens:0,total_tokens:0,cost_usd:0,llm_spans:0,unpriced_spans:0,reported_cost_spans:0,errors:0,unfinished:0};
 for(const row of rows){
  row.offset_ms=row.start-traceStart;row.duration_ms=row.end-row.start;
  if(row.type==='llm')totals.llm_spans++;if(row.status==='error')totals.errors++;if(row.unfinished)totals.unfinished++;
  if(!row.counted)continue;
  totals.input_tokens+=row.input_tokens??0;totals.output_tokens+=row.output_tokens??0;
  if(row.cost_usd===null){if(row.input_tokens!==null||row.output_tokens!==null)totals.unpriced_spans++;}else{totals.cost_usd+=row.cost_usd;if(row.cost_reported)totals.reported_cost_spans++;}
 }
 totals.total_tokens=totals.input_tokens+totals.output_tokens;
 return {spans:rows,totals,start:rows.length?traceStart:null,end:rows.length?traceEnd:null,duration_ms:rows.length?traceEnd-traceStart:0,inferred};
}
