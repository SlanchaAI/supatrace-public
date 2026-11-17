// Explicit local transformations only. No network, persistence, regex input or secret detection.
export const REDACTION_LIMITS=Object.freeze({inputBytes:2*1024*1024,outputBytes:8*1024*1024,nodes:100000,depth:40,rules:50,ruleChars:1024,ruleTextBytes:16384});
export const REDACTION_MASK='[REDACTED]';
export const REDACTION_NOTICE='Explicit local redacted copy. Only selected paths and exact text were masked. Other fields, names and object keys may still contain sensitive data. Review before sharing; this is not an original or automatically safe trace. Redaction does not guarantee anonymity.';
export const REDACTION_IDENTIFIER_NOTICE='Identifier masks are not pseudonyms. Distinct identifiers can collapse to the same mask, selected fields can lose their references, and unchanged copies of a path-masked value may remain elsewhere. Review identifier values and relationships before sharing. This report checks string and numeric values under common identifier field names, not every source schema or free-text reference.';
export class RedactionError extends Error{constructor(code,message){super(message);this.name='RedactionError';this.code=code;}}
const fail=(code,message)=>{throw new RedactionError(code,message);};
const bytes=value=>new TextEncoder().encode(value).byteLength;

// Stop collecting later pages before retaining an oversized preview input. The
// final transformation checks the same bound again; original export is separate.
export function createRedactionInputBudget(runId){
 let size=bytes(JSON.stringify({version:1,run_id:runId,events:[]})),count=0;
 return events=>{
  let next=size,nextCount=count;
  for(const event of events){next+=bytes(JSON.stringify(event))+(nextCount++?1:0);if(next>REDACTION_LIMITS.inputBytes)fail('copy_too_large','This run exceeds the 2 MiB local redaction limit. Original export is unchanged.');}
  size=next;count=nextCount;return size;
 };
}

function pointer(value){
 if(typeof value!=='string'||!value.startsWith('/')||value.length>REDACTION_LIMITS.ruleChars||/~(?![01])/u.test(value))fail('invalid_path','Use JSON Pointer paths beginning with /; escape ~ as ~0 and / inside a field as ~1.');
 const parts=value.slice(1).split('/').map(part=>part.replace(/~1/g,'/').replace(/~0/g,'~'));
 if(parts.length>REDACTION_LIMITS.depth)fail('invalid_path','The field path is too deep.');
 return parts;
}

function rules(paths,literals){
 if(!Array.isArray(paths)||!Array.isArray(literals))fail('invalid_rules','Redaction rules must be lists.');
 if(paths.some(value=>typeof value!=='string')||literals.some(value=>typeof value!=='string'||value.length===0||value.length>REDACTION_LIMITS.ruleChars))fail('invalid_rules','Each exact-text rule must contain 1–1024 characters.');
 const uniquePaths=[...new Set(paths)],uniqueLiterals=[...new Set(literals)];
 if(!uniquePaths.length&&!uniqueLiterals.length)fail('empty_rules','Choose at least one field path or exact text to mask.');
 if(uniquePaths.length+uniqueLiterals.length>REDACTION_LIMITS.rules||bytes([...uniquePaths,...uniqueLiterals].join('\n'))>REDACTION_LIMITS.ruleTextBytes)fail('too_many_rules','Use at most 50 rules and 16 KiB of UTF-8 rule text.');
 return {paths:uniquePaths.map(path=>({path,parts:pointer(path)})),literals:uniqueLiterals};
}

export function parseRedactionRules({pathsText='',literalsText=''}={}){
 if(typeof pathsText!=='string'||typeof literalsText!=='string'||bytes(pathsText)+bytes(literalsText)>REDACTION_LIMITS.ruleTextBytes)fail('too_many_rules','Use at most 16 KiB of UTF-8 rule text.');
 const paths=pathsText.split(/\r?\n/).map(line=>line.trim()).filter(Boolean),literals=literalsText.split(/\r?\n/).filter(line=>line.length>0);
 const parsed=rules(paths,literals);return {paths:parsed.paths.map(value=>value.path),literals:parsed.literals};
}

function validateJSON(root){
 const stack=[[root,0]],seen=new WeakSet();let nodes=0;
 while(stack.length){
  const [value,depth]=stack.pop();if(++nodes>REDACTION_LIMITS.nodes||depth>REDACTION_LIMITS.depth)fail('copy_too_large','This run is too complex for the bounded local preview. Original export is unchanged.');
  if(value===null||typeof value==='string'||typeof value==='boolean')continue;
  if(typeof value==='number'){if(!Number.isFinite(value)||(Number.isInteger(value)&&!Number.isSafeInteger(value)))fail('invalid_json','The copy must contain finite, JSON-safe numbers.');continue;}
  if(typeof value!=='object'||seen.has(value))fail('invalid_json','The copy must contain plain, acyclic JSON.');
  const proto=Object.getPrototypeOf(value);if(!Array.isArray(value)&&proto!==Object.prototype&&proto!==null)fail('invalid_json','The copy must contain plain JSON objects.');seen.add(value);
  for(const key of Object.keys(value)){const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor||!('value' in descriptor))fail('invalid_json','JSON accessors are not supported.');stack.push([descriptor.value,depth+1]);}
 }
}

function maskPath(root,parts){
 const pending=[[root,0]];let count=0;
 while(pending.length){const [parent,index]=pending.pop();if(parent===null||typeof parent!=='object')continue;const part=parts[index],keys=part==='*'?Object.keys(parent):Object.hasOwn(parent,part)?[part]:[];
  for(const key of keys){if(index===parts.length-1){Object.defineProperty(parent,key,{value:REDACTION_MASK,writable:true,enumerable:true,configurable:true});count++;}else pending.push([parent[key],index+1]);}
 }
 return count;
}

const escapeLiteral=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

// Compare the original with the transformed copy without putting original
// identifiers or paths in the report. The trace envelope and common imported
// source fields are covered; arbitrary source semantics are not inferred.
const identifierKeys=new Set(['id','run_id','runId','trace_id','traceId','span_id','spanId','parent_id','parentId','parent_span_id','parentSpanId','parentObservationId','observation_id','observationId']);
function identifierImpact(source,copy){
 const result={changed_fields:0,omitted_fields:0,unchanged_value_occurrences:0,collapsed_values:0,notice:REDACTION_IDENTIFIER_NOTICE},changedValues=new Set(),replacements=new Map(),unchangedValues=new Map(),pending=[[source,copy]];
 while(pending.length){
  const [before,after]=pending.pop();if(!before||typeof before!=='object')continue;
  for(const key of Object.keys(before)){
   const present=after!==null&&typeof after==='object'&&Object.hasOwn(after,key),next=present?after[key]:undefined,value=before[key];
   const scalar=typeof value==='string'||typeof value==='number';
   if(scalar&&present&&value===next)unchangedValues.set(value,(unchangedValues.get(value)??0)+1);
   if(identifierKeys.has(key)&&scalar&&value!==next){
    result.changed_fields++;changedValues.add(value);if(!present)result.omitted_fields++;
   }
   if(identifierKeys.has(key)&&scalar&&(typeof next==='string'||typeof next==='number')){if(!replacements.has(next))replacements.set(next,new Set());replacements.get(next).add(value);}
   if(value&&typeof value==='object')pending.push([value,next]);
  }
 }
 // Count values that really survived unchanged at the same location, not newly
 // generated mask markers. A match can be a reference or ordinary data.
 for(const value of changedValues)result.unchanged_value_occurrences+=unchangedValues.get(value)??0;
 const collapsed=new Set();for(const originals of replacements.values())if(originals.size>1)for(const value of originals)collapsed.add(value);result.collapsed_values=collapsed.size;
 return result;
}

export function redactExport(source,{paths=[],literals=[]}={}){
 const selected=rules(paths,literals);validateJSON(source);
 if(!source||typeof source!=='object'||Array.isArray(source)||source.version!==1||typeof source.run_id!=='string'||!Array.isArray(source.events))fail('invalid_export','Expected an original version-1 run export.');
 const serialized=JSON.stringify(source);if(bytes(serialized)>REDACTION_LIMITS.inputBytes)fail('copy_too_large','This run exceeds the 2 MiB local redaction limit. Original export is unchanged.');
 const copy=JSON.parse(serialized),summary={masked_fields:0,literal_matches:0,matched_paths:0,unmatched_paths:[],literal_rules:selected.literals.length};
 for(const {path,parts} of selected.paths){const count=maskPath(copy,parts);summary.masked_fields+=count;if(count)summary.matched_paths++;else summary.unmatched_paths.push(path);}
 if(selected.literals.length){
  // All alternatives are escaped literal text; replacements do not get scanned again.
  const pattern=new RegExp([...selected.literals].sort((a,b)=>b.length-a.length).map(escapeLiteral).join('|'),'gu'),stack=[copy];
  while(stack.length){const value=stack.pop();if(!value||typeof value!=='object')continue;for(const key of Object.keys(value)){if(typeof value[key]==='string'&&value[key]!==REDACTION_MASK){const masked=value[key].replace(pattern,()=>{summary.literal_matches++;return REDACTION_MASK;});Object.defineProperty(value,key,{value:masked,writable:true,enumerable:true,configurable:true});}else if(value[key]&&typeof value[key]==='object')stack.push(value[key]);}}
 }
 summary.identifiers=identifierImpact(source,copy);
 copy.redacted_copy=true;copy.redaction_notice=REDACTION_NOTICE;copy.redaction_identifiers=summary.identifiers;
 const json=JSON.stringify(copy,null,2);if(bytes(json)>REDACTION_LIMITS.outputBytes)fail('copy_too_large','This preview exceeds the local output limit. Original export is unchanged.');
 return {copy,json,summary};
}
