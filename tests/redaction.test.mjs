import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRedactionRules,redactExport,createRedactionInputBudget,REDACTION_MASK,REDACTION_NOTICE,REDACTION_LIMITS} from '../public/app/redaction.js';

const original=()=>({version:1,run_id:'synthetic-run',events:[{id:'e1',time:'2026-10-25T00:00:00Z',kind:'note',name:'Review SYNTHETIC-SECRET',data:{api_key:'SYNTHETIC-SECRET',nested:[{authorization:'Bearer SYNTHETIC-SECRET'},'ordinary'],safe:'keep this'}},{id:'e2',time:'2026-10-25T00:00:00Z',kind:'response',name:'done',data:{api_key:'second-secret',safe:3}}]});
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};

test('explicit wildcard paths mask selected copies and leave frozen originals untouched',()=>{const source=freeze(original()),before=JSON.stringify(source),r=redactExport(source,{paths:['/events/*/data/api_key']});assert.equal(JSON.stringify(source),before);assert.equal(r.copy.events[0].data.api_key,REDACTION_MASK);assert.equal(r.copy.events[1].data.api_key,REDACTION_MASK);assert.equal(r.copy.events[0].data.safe,'keep this');assert.equal(r.summary.masked_fields,2);assert.equal(r.copy.redacted_copy,true);assert.equal(r.copy.redaction_notice,REDACTION_NOTICE);});
test('exact text is case-sensitive literal matching, including punctuation and nested arrays',()=>{const source=original();source.events[0].data.extra=['a.*b a.*b','A.*B'];const r=redactExport(source,{literals:['SYNTHETIC-SECRET','a.*b']});assert.equal(r.copy.events[0].name,'Review '+REDACTION_MASK);assert.equal(r.copy.events[0].data.nested[0].authorization,'Bearer '+REDACTION_MASK);assert.deepEqual(r.copy.events[0].data.extra,[REDACTION_MASK+' '+REDACTION_MASK,'A.*B']);assert.equal(r.summary.literal_matches,5);assert.equal(source.events[0].data.api_key,'SYNTHETIC-SECRET');});
test('JSON Pointer escapes, empty property names and numeric array positions are explicit',()=>{const source=original();source.events[0].data={'a/b':{'~key':7},'':8};const r=redactExport(source,{paths:['/events/0/data/a~1b/~0key','/events/0/data/']});assert.equal(r.copy.events[0].data['a/b']['~key'],REDACTION_MASK);assert.equal(r.copy.events[0].data[''],REDACTION_MASK);assert.equal(r.summary.masked_fields,2);});
test('unmatched or overlapping paths are reported rather than claiming everything was found',()=>{const r=redactExport(original(),{paths:['/events/*/data','/events/*/data/api_key','/missing']});assert.equal(r.summary.masked_fields,2);assert.deepEqual(r.summary.unmatched_paths,['/events/*/data/api_key','/missing']);assert.equal(r.summary.matched_paths,1);});
test('masking strings never interprets HTML or changes object keys',()=>{const source=original();source.events[0].data={'secret-key':'value',html:'</pre><img src=x onerror=alert(1)>',text:'secret-key'};const r=redactExport(source,{literals:['secret-key']});assert.equal(r.copy.events[0].data['secret-key'],'value');assert.equal(r.copy.events[0].data.text,REDACTION_MASK);assert.match(r.json,/<img src=x onerror/);assert.ok(r.copy.redaction_notice.includes('object keys'));});
test('prototype-shaped JSON keys remain data and do not traverse inherited properties',()=>{const source=original();source.events[0].data=JSON.parse('{"__proto__":{"polluted":"private"},"constructor":{"prototype":{"value":"private"}}}');const r=redactExport(source,{paths:['/events/0/data/__proto__/polluted','/events/0/data/constructor/prototype/value','/events/0/data/toString']});assert.equal(r.copy.events[0].data.__proto__.polluted,REDACTION_MASK);assert.equal(r.copy.events[0].data.constructor.prototype.value,REDACTION_MASK);assert.equal({}.polluted,undefined);assert.deepEqual(r.summary.unmatched_paths,['/events/0/data/toString']);});
test('literal replacements are one pass, longest first, and support Unicode',()=>{const source=original();source.events[0].name='abc ab 😂';const r=redactExport(source,{literals:['ab','abc','😂','REDACTED']});assert.equal(r.copy.events[0].name,`${REDACTION_MASK} ${REDACTION_MASK} ${REDACTION_MASK}`);});
test('rules are not copied into output metadata or residual warnings',()=>{const r=redactExport(original(),{literals:['SYNTHETIC-SECRET']});assert.doesNotMatch(r.json,/SYNTHETIC-SECRET/);assert.equal(Object.hasOwn(r.copy,'rules'),false);assert.equal(Object.hasOwn(r.copy,'literals'),false);assert.ok(r.json.includes('not an original or automatically safe trace'));});
test('path-generated mask markers are not expanded again by literal rules',()=>{const r=redactExport(original(),{paths:['/events/*/data'],literals:['REDACTED']});assert.equal(r.copy.events[0].data,REDACTION_MASK);assert.equal(r.copy.events[1].data,REDACTION_MASK);});
test('empty and malformed rules fail before producing a misleading copy',()=>{for(const options of [{},{paths:['no-leading-slash']},{paths:['/bad~2key']},{literals:['']},{paths:Array.from({length:51},(_,i)=>'/'+i)}])assert.throws(()=>redactExport(original(),options));});
test('the form parser preserves literal spaces, deduplicates paths and rejects excess text',()=>{assert.deepEqual(parseRedactionRules({pathsText:' /events/*/name \n/events/*/name',literalsText:' padded \r\nX'}),{paths:['/events/*/name'],literals:[' padded ','X']});assert.throws(()=>parseRedactionRules({literalsText:'x'.repeat(REDACTION_LIMITS.ruleTextBytes+1)}));});
test('the 16 KiB rule boundary uses UTF-8 bytes in both parser and direct transformations',()=>{const encoder=new TextEncoder(),literals=Array.from({length:16},(_,i)=>'é'.repeat(500)+String(i).padStart(2,'0'));literals[15]+='x'.repeat(REDACTION_LIMITS.ruleTextBytes-encoder.encode(literals.join('\n')).byteLength);const text=literals.join('\n');assert.equal(encoder.encode(text).byteLength,REDACTION_LIMITS.ruleTextBytes);assert.ok(text.length<REDACTION_LIMITS.ruleTextBytes);assert.deepEqual(parseRedactionRules({literalsText:text}).literals,literals);assert.doesNotThrow(()=>redactExport(original(),{literals}));assert.throws(()=>parseRedactionRules({literalsText:text+'é'}),/16 KiB of UTF-8/);assert.throws(()=>redactExport(original(),{literals:literals.map((value,i)=>i===15?value+'é':value)}),/16 KiB of UTF-8/);});
test('local copy size/depth limits fail closed without affecting the original export',()=>{const source=original();source.events[0].data.big='x'.repeat(REDACTION_LIMITS.inputBytes);assert.throws(()=>redactExport(source,{paths:['/events/*/data']}),/2 MiB/);assert.equal(source.events[0].data.big.length,REDACTION_LIMITS.inputBytes);const cycle=original();cycle.events[0].data.self=cycle;assert.throws(()=>redactExport(cycle,{paths:['/run_id']}),/acyclic JSON/);});
test('non-JSON values and getters are refused instead of silently changing data',()=>{for(const value of [undefined,Infinity,BigInt(1),new Date()]){const source=original();source.events[0].data.bad=value;assert.throws(()=>redactExport(source,{paths:['/run_id']}));}const source=original();Object.defineProperty(source.events[0].data,'getter',{enumerable:true,get(){throw Error('must not execute');}});assert.throws(()=>redactExport(source,{paths:['/run_id']}),/accessors/);});
test('the incremental input budget counts exact UTF-8 envelope/event bytes before retaining pages',()=>{const source=original();source.run_id='unicode-😂';source.events[0].name='😂é';const budget=createRedactionInputBudget(source.run_id);budget(source.events.slice(0,1));const size=budget(source.events.slice(1));assert.equal(size,new TextEncoder().encode(JSON.stringify(source)).byteLength);const huge={text:'x'.repeat(REDACTION_LIMITS.inputBytes)};assert.throws(()=>budget([huge]),/2 MiB/);assert.equal(budget([]),size,'a refused page is not committed to the budget');});
test('exact 2 MiB UTF-8 input succeeds and one extra byte is refused',()=>{const source={version:1,run_id:'boundary-é',events:[{data:''}]};const base=new TextEncoder().encode(JSON.stringify(source)).length;source.events[0].data='x'.repeat(REDACTION_LIMITS.inputBytes-base);assert.equal(new TextEncoder().encode(JSON.stringify(source)).length,REDACTION_LIMITS.inputBytes);assert.doesNotThrow(()=>redactExport(source,{paths:['/events/*/data']}));source.events[0].data+='x';assert.throws(()=>redactExport(source,{paths:['/events/*/data']}),/2 MiB/);});
test('depth, node and expanded output limits each reject unsafe local work',()=>{const deep=original();let parent=deep.events[0].data;for(let i=0;i<REDACTION_LIMITS.depth;i++)parent=parent.child={};assert.throws(()=>redactExport(deep,{paths:['/events/*/data']}),/too complex/);const wide=original();wide.events[0].data=Array(REDACTION_LIMITS.nodes).fill(null);assert.throws(()=>redactExport(wide,{paths:['/events/*/data']}),/too complex/);const large=original();large.events[0].data={text:'a'.repeat(900000)};assert.throws(()=>redactExport(large,{literals:['a']}),/output limit/);assert.equal(large.events[0].data.text.length,900000);});

const linkedOriginal=()=>({version:1,run_id:'canonical-run',events:[
 {id:'canonical-root',time:'2026-11-04T00:00:00Z',kind:'note',name:'root',data:{observation:{id:'source-root',traceId:'source-trace',parentObservationId:null,input:{token:'synthetic-secret'}}}},
 {id:'canonical-child',time:'2026-11-04T00:00:01Z',kind:'note',name:'child',data:{observation:{id:'source-child',traceId:'source-trace',parentObservationId:'source-root',input:{token:'synthetic-secret'}},references:['source-root','canonical-run'],embedded:'reference source-root',differentCase:'SOURCE-ROOT'}}
]});

test('masking unrelated nested content preserves identifiers, parent links and event order',()=>{
 const source=freeze(linkedOriginal()),before=JSON.stringify(source),r=redactExport(source,{paths:['/events/*/data/observation/input/token']});
 assert.equal(r.copy.run_id,source.run_id);assert.deepEqual(r.copy.events.map(e=>e.id),source.events.map(e=>e.id));
 for(let i=0;i<2;i++)for(const key of ['id','traceId','parentObservationId'])assert.equal(r.copy.events[i].data.observation[key],source.events[i].data.observation[key]);
 assert.deepEqual({...r.summary.identifiers,notice:undefined},{changed_fields:0,omitted_fields:0,unchanged_value_occurrences:0,collapsed_values:0,notice:undefined});assert.equal(JSON.stringify(source),before);
});

test('selected run, event and nested source IDs expose surviving references and collapsed identifiers',()=>{
 const source=freeze(linkedOriginal()),before=JSON.stringify(source),r=redactExport(source,{paths:['/run_id','/events/*/id','/events/*/data/observation/id']});
 assert.equal(r.copy.run_id,REDACTION_MASK);assert.deepEqual(r.copy.events.map(e=>e.id),[REDACTION_MASK,REDACTION_MASK]);assert.equal(r.copy.events[1].data.observation.parentObservationId,'source-root');
 assert.deepEqual(r.copy.events[1].data.references,['source-root','canonical-run']);assert.equal(r.copy.events[1].data.embedded,'reference source-root');
 assert.deepEqual({...r.summary.identifiers,notice:undefined},{changed_fields:5,omitted_fields:0,unchanged_value_occurrences:3,collapsed_values:5,notice:undefined});
 assert.deepEqual(JSON.parse(r.json).redaction_identifiers,r.summary.identifiers);assert.match(r.summary.identifiers.notice,/not pseudonyms/);assert.match(r.summary.identifiers.notice,/not every source schema or free-text reference/);
 assert.doesNotMatch(JSON.stringify(r.summary),/canonical-run|canonical-root|canonical-child|source-root|source-child/);assert.equal(JSON.stringify(source),before);
});

test('exact identifier text is masked consistently in parents, repeated nested values and text without implying preserved topology',()=>{
 const source=freeze(linkedOriginal()),before=JSON.stringify(source),r=redactExport(source,{literals:['source-root','source-child']});
 assert.equal(r.copy.events[0].data.observation.id,REDACTION_MASK);assert.equal(r.copy.events[1].data.observation.id,REDACTION_MASK);assert.equal(r.copy.events[1].data.observation.parentObservationId,REDACTION_MASK);
 assert.equal(r.copy.events[1].data.references[0],REDACTION_MASK);assert.equal(r.copy.events[1].data.embedded,'reference '+REDACTION_MASK);assert.equal(r.copy.events[1].data.differentCase,'SOURCE-ROOT');
 assert.doesNotMatch(r.json,/source-root|source-child/);assert.equal(r.summary.identifiers.changed_fields,3);assert.equal(r.summary.identifiers.collapsed_values,2);assert.equal(r.summary.identifiers.unchanged_value_occurrences,0);assert.equal(r.copy.events[1].id,'canonical-child');assert.equal(JSON.stringify(source),before);
});

test('masking an ancestor reports omitted identifier fields instead of suggesting relationships survived',()=>{
 const source=linkedOriginal(),r=redactExport(source,{paths:['/events/*/data']});
 assert.equal(r.summary.identifiers.changed_fields,5);assert.equal(r.summary.identifiers.omitted_fields,5);assert.equal(r.summary.identifiers.collapsed_values,0);assert.equal(r.summary.identifiers.unchanged_value_occurrences,0);assert.equal(r.copy.events[0].data,REDACTION_MASK);assert.deepEqual(r.copy.events.map(e=>e.id),source.events.map(e=>e.id));
});

test('collapsed identifier reporting includes a pre-existing replacement value and never counts repeated equal IDs as distinct',()=>{
 const source=linkedOriginal();source.events[0].data.observation.id=REDACTION_MASK;source.events[1].data.observation.parentObservationId=REDACTION_MASK;
 const r=redactExport(source,{paths:['/events/1/data/observation/id']});assert.equal(r.summary.identifiers.changed_fields,1);assert.equal(r.summary.identifiers.collapsed_values,2);
 const repeated=redactExport(linkedOriginal(),{paths:['/events/*/data/observation/traceId']});assert.equal(repeated.summary.identifiers.changed_fields,2);assert.equal(repeated.summary.identifiers.collapsed_values,0);
});

test('source-specific identifier fields are not silently claimed as covered',()=>{
 const source=linkedOriginal();source.events[0].data={customIdentity:'source-root'};const r=redactExport(source,{paths:['/events/0/data/customIdentity']});
 assert.equal(r.summary.identifiers.changed_fields,0);assert.match(r.copy.redaction_identifiers.notice,/common identifier field names/);assert.equal(r.copy.events[1].data.observation.parentObservationId,'source-root');
});

test('numeric imported identifiers and references retain their type in impact accounting',()=>{
 const source=original();source.events[0].data={id:123,parent_id:123,reference:'123',emptyParent:null};const r=redactExport(source,{paths:['/events/0/data/id']});
 assert.equal(r.summary.identifiers.changed_fields,1);assert.equal(r.summary.identifiers.unchanged_value_occurrences,1);assert.equal(r.copy.events[0].data.parent_id,123);assert.equal(r.copy.events[0].data.reference,'123');assert.match(r.summary.identifiers.notice,/string and numeric/);
});

test('an original participating in multiple collision groups is counted only once',()=>{
 const source=original();source.events=[{id:'abc'},{id:'xyz'},{id:'abc'},{id:'xyc'}];const r=redactExport(source,{paths:['/events/0/id','/events/1/id'],literals:['ab','xy']});
 assert.deepEqual(r.copy.events.map(e=>e.id),[REDACTION_MASK,REDACTION_MASK,REDACTION_MASK+'c',REDACTION_MASK+'c']);assert.equal(r.summary.identifiers.collapsed_values,3);
});

test('newly generated masks are not called unchanged occurrences of an omitted marker-shaped identifier',()=>{
 const source=original();source.events[0].data={id:REDACTION_MASK};source.events[1].data={private:'other'};const r=redactExport(source,{paths:['/events/0/data','/events/1/data/private']});
 assert.equal(r.summary.identifiers.changed_fields,1);assert.equal(r.summary.identifiers.omitted_fields,1);assert.equal(r.summary.identifiers.unchanged_value_occurrences,0);
});
