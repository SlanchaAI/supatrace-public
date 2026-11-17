import test from 'node:test';import assert from 'node:assert/strict';
import {buildSpans,SPAN_LIMITS,spanTimings,rootSpanTiming,rootDuration} from '../public/app/span-data.js';
import {priceFor,PRICES_AS_OF,PRICE_SOURCES} from '../public/app/model-prices.js';
import {mountSpanView,formatDuration,formatCost,WATERFALL_ROWS} from '../public/app/span-ui.js';
import {parseBatch} from '../src/trace.mjs';import {planOtlpBatches} from '../src/otlp-ingest.mjs';
import {validateEventPage} from '../public/app/event-data.js';
const at=ms=>new Date(Date.parse('2026-11-14T00:00:00Z')+ms).toISOString();
const event=(id,ms,kind,name,data={})=>({id,time:at(ms),kind,name,data});
// One agent turn as an OTel-style exporter would send it: a root agent span, two chat
// calls and a tool call nested under it, with gen_ai.* usage on the chat spans only.
const nested=()=>[
 event('e1',0,'note','agent run',{span_id:'root',attributes:{'gen_ai.operation.name':'invoke_agent'}}),
 event('e2',10,'request','chat gpt-4o-mini',{span_id:'llm1',parent_span_id:'root',attributes:{'gen_ai.request.model':'gpt-4o-mini'}}),
 event('e3',910,'response','chat gpt-4o-mini',{span_id:'llm1',parent_span_id:'root',attributes:{'gen_ai.response.model':'gpt-4o-mini-2024-07-18','gen_ai.usage.input_tokens':1200,'gen_ai.usage.output_tokens':300}}),
 event('e4',920,'tool_call','search',{span_id:'tool1',parent_span_id:'root',attributes:{'gen_ai.tool.call.id':'call_1'}}),
 event('e5',1420,'tool_result','search',{span_id:'tool1',parent_span_id:'root'}),
 event('e6',1430,'request','chat claude-sonnet-5-5',{span_id:'llm2',parent_span_id:'root',attributes:{'gen_ai.request.model':'claude-sonnet-5-5'}}),
 event('e7',2430,'response','chat claude-sonnet-5-5',{span_id:'llm2',parent_span_id:'root',attributes:{'gen_ai.usage.input_tokens':2000,'gen_ai.usage.output_tokens':500}}),
 event('e8',2500,'note','agent run',{span_id:'root'})
];
test('fixture is a valid intake batch and a valid event page, and is not rewritten',()=>{const events=nested(),before=JSON.stringify(events);assert.doesNotThrow(()=>parseBatch(JSON.stringify({version:1,batch_id:'b',run_id:'r',events})));assert.doesNotThrow(()=>validateEventPage({events,next:null}));buildSpans(events);assert.equal(JSON.stringify(events),before);});
test('nested LLM and tool spans form a waterfall with exact token and cost totals',()=>{
 const view=buildSpans(nested());
 assert.deepEqual(view.spans.map(s=>[s.id,s.depth,s.type,s.offset_ms,s.duration_ms]),[['root',0,'agent',0,2500],['llm1',1,'llm',10,900],['tool1',1,'tool',920,500],['llm2',1,'llm',1430,1000]]);
 assert.equal(view.duration_ms,2500);assert.equal(view.inferred,false);
 const [,llm1,,llm2]=view.spans;
 assert.equal(llm1.model,'gpt-4o-mini-2024-07-18');assert.deepEqual([llm1.input_tokens,llm1.output_tokens],[1200,300]);
 // gpt-4o-mini 0.15/0.60 and claude-sonnet-5-5 2/10 USD per million tokens.
 assert.ok(Math.abs(llm1.cost_usd-(1200*0.15+300*0.6)/1e6)<1e-12);assert.ok(Math.abs(llm2.cost_usd-(2000*2+500*10)/1e6)<1e-12);
 assert.deepEqual({...view.totals,cost_usd:Number(view.totals.cost_usd.toFixed(8))},{input_tokens:3200,output_tokens:800,total_tokens:4000,cost_usd:0.00936,llm_spans:2,unpriced_spans:0,reported_cost_spans:0,errors:0,unfinished:0});
 assert.deepEqual(llm1.events,['e2','e3']);
});
test('a parent that repeats its children\'s usage is not counted twice',()=>{
 const events=nested();events[7].data.attributes={'gen_ai.usage.input_tokens':3200,'gen_ai.usage.output_tokens':800,'gen_ai.request.model':'gpt-4o-mini'};
 const view=buildSpans(events);assert.equal(view.spans[0].counted,false);assert.equal(view.spans[0].cost_usd,null);assert.equal(view.totals.total_tokens,4000);
});
test('events without span ids pair by order and say so; nothing is nested by guesswork',()=>{
 const view=buildSpans([event('a',0,'request','chat',{model:'gpt-4o',usage:{prompt_tokens:10}}),event('b',400,'response','chat',{usage:{prompt_tokens:1000,completion_tokens:'200'}}),
  event('c',410,'tool_call','read',{id:'t1'}),event('d',420,'tool_call','read',{id:'t2'}),event('e',500,'tool_result','read',{tool_call_id:'t2'}),event('f',700,'tool_result','read',{tool_call_id:'t1'}),
  event('g',800,'error','boom',{}),event('h',900,'request','chat',{})]);
 assert.equal(view.inferred,true);assert.ok(view.spans.every(s=>s.depth===0&&s.inferred));
 assert.deepEqual(view.spans.map(s=>[s.type,s.events,s.duration_ms,s.unfinished]),[['llm',['a','b'],400,false],['tool',['c','f'],290,false],['tool',['d','e'],80,false],['event',['g'],0,false],['llm',['h'],0,true]]);
 assert.deepEqual([view.spans[0].input_tokens,view.spans[0].output_tokens],[1000,200]);
 assert.ok(Math.abs(view.totals.cost_usd-(1000*2.5+200*10)/1e6)<1e-12);assert.equal(view.totals.errors,1);assert.equal(view.totals.unfinished,1);
});
test('unknown models stay unpriced and are reported, not estimated',()=>{
 const view=buildSpans([event('a',0,'response','chat',{span_id:'s',attributes:{'gen_ai.request.model':'my-local-llama','gen_ai.usage.input_tokens':5,'gen_ai.usage.output_tokens':5}})]);
 assert.equal(view.spans[0].cost_usd,null);assert.deepEqual([view.totals.unpriced_spans,view.totals.cost_usd,view.totals.total_tokens],[1,0,10]);
});
test('OpenInference and OpenLLMetry attribute names, OTLP nano times and error status are read',()=>{
 const view=buildSpans([event('a',5000,'note','llm',{span_id:'x',startTimeUnixNano:'1794614400000000000',endTimeUnixNano:'1794614402500000000',attributes:{'llm.model_name':'gpt-4.1','llm.token_count.prompt':7,'llm.token_count.completion':3,'otel.status_code':'ERROR'}}),
  event('b',0,'note','llm',{spanId:'y',parentSpanId:'x',duration_ms:250,attributes:{'llm.request.model':'o3','llm.usage.prompt_tokens':1,'llm.usage.completion_tokens':1}})]);
 const [x,y]=view.spans;assert.equal(x.type,'llm');assert.equal(x.status,'error');assert.equal(x.start,1794614400000);assert.equal(x.end,1794614402500);assert.equal(x.duration_ms,2500);assert.deepEqual([x.input_tokens,x.output_tokens],[7,3]);
 assert.equal(y.depth,1);assert.equal(y.duration_ms,250);assert.equal(view.totals.errors,1);
 // Two spans that each name a model are two billed calls, even without a declared operation.
 assert.equal(x.counted,true);assert.equal(y.counted,true);assert.equal(view.totals.total_tokens,12);
});
test('a model call keeps its own usage when a nested call reports too; only non-call parents are treated as rollups',()=>{
 // Two independently billed calls, one nested in the other, plus a child that reports only output tokens.
 const calls=buildSpans([event('a',0,'request','outer',{span_id:'outer',model:'gpt-4o'}),event('b',10,'request','inner',{span_id:'inner',parent_span_id:'outer',model:'gpt-4o'}),
  event('c',20,'response','inner',{span_id:'inner',parent_span_id:'outer',usage:{input_tokens:10,output_tokens:5}}),event('d',25,'response','partial',{span_id:'partial',parent_span_id:'outer',model:'gpt-4o',usage:{output_tokens:1}}),
  event('e',30,'response','outer',{span_id:'outer',usage:{input_tokens:100,output_tokens:20}})]);
 assert.deepEqual(calls.spans.map(s=>[s.id,s.counted]),[['outer',true],['inner',true],['partial',true]]);
 assert.deepEqual([calls.totals.input_tokens,calls.totals.output_tokens],[110,26]);assert.ok(Math.abs(calls.totals.cost_usd-(110*2.5+26*10)/1e6)<1e-12);
 // The producer's declared role decides: a declared chat span counts even on note events; a declared agent or chain is a rollup.
 const declared=buildSpans([event('a',0,'note','agent',{span_id:'agent',attributes:{'gen_ai.operation.name':'invoke_agent','gen_ai.usage.input_tokens':30,'gen_ai.usage.output_tokens':3}}),
  event('b',1,'note','chat',{span_id:'chat',parent_span_id:'agent',attributes:{'gen_ai.operation.name':'chat','gen_ai.usage.input_tokens':20,'gen_ai.usage.output_tokens':2}}),
  event('c',2,'note','sub',{span_id:'sub',parent_span_id:'chat',attributes:{'openinference.span.kind':'LLM','llm.token_count.prompt':10,'llm.token_count.completion':1}}),
  event('d',3,'note','chain',{span_id:'chain',attributes:{'openinference.span.kind':'CHAIN','llm.token_count.prompt':7}})]);
 assert.deepEqual(declared.spans.map(s=>[s.id,s.type,s.counted]),[['agent','agent',false],['chat','llm',true],['sub','llm',true],['chain','agent',true]]);
 assert.deepEqual([declared.totals.input_tokens,declared.totals.output_tokens],[37,3]);
});
test('a span\'s own start and end win over event delivery time',()=>{
 const late=buildSpans([event('a',5000,'note','work',{span_id:'s',start_time:at(0),end_time:at(2500)}),event('b',6000,'note','short',{span_id:'t',parent_span_id:'s',start_time:at(100),duration_ms:400}),
  event('c',7000,'note','end only',{span_id:'u',end_time:at(1000)}),event('d',50,'note','reversed',{span_id:'v',start_time:at(900),end_time:at(100)}),
  event('e',5000,'note','end and duration',{span_id:'w',end_time:at(1000),duration_ms:400})]);
 const by=Object.fromEntries(late.spans.map(s=>[s.id,[s.offset_ms,s.duration_ms]]));
 assert.deepEqual(by,{s:[0,2500],t:[100,400],u:[1000,0],v:[900,0],w:[600,400]});assert.equal(late.duration_ms,2500);
});
test('an explicit span with no closing event is unfinished until its response, error or end time arrives',()=>{
 const open=[event('a',0,'request','chat',{span_id:'c'}),event('b',5,'tool_call','read',{span_id:'t'}),event('n',6,'note','marker',{span_id:'n'})];
 assert.deepEqual(buildSpans(open).spans.map(s=>[s.id,s.unfinished]),[['c',true],['t',true],['n',false]]);assert.equal(buildSpans(open).totals.unfinished,2);
 const closed=buildSpans([...open,event('d',400,'response','chat',{span_id:'c'}),event('e',500,'error','read',{span_id:'t'})]);
 assert.deepEqual(closed.spans.map(s=>[s.id,s.unfinished,s.duration_ms,s.status]),[['c',false,400,'ok'],['t',false,495,'error'],['n',false,0,'ok']]);
 assert.equal(buildSpans([event('a',0,'request','chat',{span_id:'c',end_time:at(300)})]).spans[0].unfinished,false);assert.equal(buildSpans([event('a',0,'tool_call','read',{span_id:'t',duration_ms:20})]).spans[0].unfinished,false);
});
test('an explicit span_id cannot hijack an inferred span\'s identity to double its children',()=>{
 const view=buildSpans([event('a',0,'note','inferred',{}),event('b',1,'note','explicit twin',{span_id:'event:a'}),event('c',2,'response','child',{span_id:'kid',parent_span_id:'event:a',model:'gpt-4o',usage:{input_tokens:10,output_tokens:0}})]);
 assert.equal(view.spans.length,3);assert.equal(view.spans.filter(s=>s.id==='kid').length,1);assert.equal(view.totals.input_tokens,10);
 assert.deepEqual(view.spans.map(s=>[s.name,s.depth]),[['inferred',0],['explicit twin',0],['child',1]]);
});
// The real path: an OTLP/JSON export goes through the ingest planner, and the events it
// would store are what the waterfall reads. No hand-shaped event data in between.
const nano=ms=>String(BigInt(Date.parse('2026-11-14T00:00:00Z')+ms)*1000000n);
const attr=(key,value)=>({key,value:typeof value==='number'?Number.isInteger(value)?{intValue:String(value)}:{doubleValue:value}:{stringValue:value}});
const otlpSpan=(id,parent,name,from,to,attributes,extra={})=>({traceId:'0af7651916cd43dd8448eb211c80319c',spanId:id,...(parent?{parentSpanId:parent}:{}),name,kind:1,startTimeUnixNano:nano(from),endTimeUnixNano:nano(to),attributes,...extra});
test('events stored by the OTLP endpoint render as a nested waterfall with their tokens, cost and errors',()=>{
 const plan=planOtlpBatches({resourceSpans:[{resource:{attributes:[attr('service.name','synthetic-agent')]},scopeSpans:[{scope:{name:'synthetic'},spans:[
  otlpSpan('aaaaaaaaaaaaaaa1',null,'invoke_agent demo',0,2500,[attr('gen_ai.operation.name','invoke_agent')]),
  otlpSpan('aaaaaaaaaaaaaaa2','aaaaaaaaaaaaaaa1','chat gpt-4o-mini',10,910,[attr('gen_ai.operation.name','chat'),attr('gen_ai.request.model','gpt-4o-mini'),attr('gen_ai.usage.input_tokens',1200),attr('gen_ai.usage.output_tokens',300)]),
  otlpSpan('aaaaaaaaaaaaaaa3','aaaaaaaaaaaaaaa1','execute_tool search',920,1420,[attr('gen_ai.operation.name','execute_tool'),attr('gen_ai.tool.name','search')],{status:{code:2,message:'timeout'}}),
  otlpSpan('aaaaaaaaaaaaaaa4','aaaaaaaaaaaaaaa1','chat claude-sonnet-5-5',1430,2430,[attr('gen_ai.operation.name','chat'),attr('gen_ai.request.model','claude-sonnet-5-5'),attr('gen_ai.usage.input_tokens',2000),attr('gen_ai.usage.output_tokens',500)])]}]}]});
 assert.equal(plan.rejected,0);const events=plan.batches.flatMap(item=>item.batch.events);assert.equal(events.length,4);assert.ok(events.every(item=>item.data.source==='otlp'));
 const view=buildSpans(events);assert.equal(view.inferred,false);
 assert.deepEqual(view.spans.map(s=>[s.name,s.depth,s.type,s.offset_ms,s.duration_ms,s.status,s.unfinished]),[['invoke_agent demo',0,'span',0,2500,'ok',false],['chat gpt-4o-mini',1,'llm',10,900,'ok',false],['execute_tool search',1,'tool',920,500,'error',false],['chat claude-sonnet-5-5',1,'llm',1430,1000,'ok',false]]);
 assert.deepEqual([view.totals.input_tokens,view.totals.output_tokens,view.totals.errors,view.totals.unfinished,view.totals.unpriced_spans,view.totals.reported_cost_spans],[3200,800,1,0,0,0]);assert.equal(Number(view.totals.cost_usd.toFixed(8)),0.00936);
});
test('an OTLP span that reports a cost but no tokens still shows and totals that cost; a parent rollup is not added twice',()=>{
 const plan=planOtlpBatches({resourceSpans:[{resource:{attributes:[]},scopeSpans:[{scope:{name:'synthetic'},spans:[
  otlpSpan('bbbbbbbbbbbbbbb1',null,'agent',0,1000,[attr('gen_ai.usage.cost',0.75)]),
  otlpSpan('bbbbbbbbbbbbbbb2','bbbbbbbbbbbbbbb1','chat a',0,400,[attr('gen_ai.request.model','my-local-llama'),attr('gen_ai.usage.cost',0.5)]),
  otlpSpan('bbbbbbbbbbbbbbb3','bbbbbbbbbbbbbbb1','chat b',400,900,[attr('gen_ai.request.model','gpt-4o'),attr('gen_ai.usage.cost',0.25),attr('gen_ai.usage.input_tokens',1000),attr('gen_ai.usage.output_tokens',0)])]}]}]});
 assert.equal(plan.rejected,0);const stored=plan.batches.flatMap(item=>item.batch.events);assert.deepEqual(stored.map(item=>item.data.span.reported_cost),[0.75,0.5,0.25]);assert.equal(stored[1].data.span.usage,undefined);
 const view=buildSpans(stored);
 // The agent's 0.75 is the sum of its two calls: it is shown as a rollup, not added on top.
 assert.deepEqual(view.spans.map(s=>[s.name,s.counted,s.cost_usd,s.cost_reported]),[['agent',false,null,false],['chat a',true,0.5,true],['chat b',true,0.25,true]]);
 assert.deepEqual([view.totals.cost_usd,view.totals.reported_cost_spans,view.totals.unpriced_spans,view.totals.total_tokens],[0.75,2,0,1000]);
 // A lone span with only a cost counts too, and is not called unpriced.
 const lone=buildSpans([stored[0]]);assert.deepEqual([lone.spans[0].counted,lone.totals.cost_usd,lone.totals.unpriced_spans,lone.totals.reported_cost_spans],[true,0.75,0,1]);
});
test('a cost reported by the instrumentation is used as given, ahead of the price table',()=>{
 const view=buildSpans([event('a',0,'response','chat',{source:'otlp',span:{spanId:'s1',startTimeUnixNano:nano(0),endTimeUnixNano:nano(100),kind:'llm',status:'ok',model:'gpt-4o',usage:{input:1000,output:1000},reported_cost:0.5}}),
  event('b',0,'response','chat',{source:'otlp',span:{spanId:'s2',startTimeUnixNano:nano(0),endTimeUnixNano:nano(100),kind:'llm',status:'ok',model:'my-local-llama',usage:{input:1,output:1},reported_cost:0.25}}),
  event('c',0,'response','chat',{source:'otlp',span:{spanId:'s3',startTimeUnixNano:nano(0),endTimeUnixNano:nano(100),kind:'llm',status:'ok',model:'gpt-4o',usage:{input:1000,output:0},reported_cost:-1}})]);
 assert.deepEqual(view.spans.map(s=>[s.cost_usd,s.cost_reported]),[[0.5,true],[0.25,true],[0.0025,false]]);assert.deepEqual([view.totals.reported_cost_spans,view.totals.unpriced_spans],[2,0]);assert.ok(Math.abs(view.totals.cost_usd-0.7525)<1e-12);
 assert.ok(view.spans.every(s=>!('reported_cost' in s)));
});
test('hostile structure is bounded: cycles, self and missing parents, deep chains, bad values',()=>{
 const cyc=buildSpans([event('a',0,'note','a',{span_id:'a',parent_span_id:'b'}),event('b',1,'note','b',{span_id:'b',parent_span_id:'a'}),event('c',2,'note','c',{span_id:'c',parent_span_id:'c'}),event('d',3,'note','d',{span_id:'d',parent_span_id:'gone'})]);
 assert.equal(cyc.spans.length,4);assert.ok(cyc.spans.every(s=>s.depth<=1));
 const deep=buildSpans(Array.from({length:80},(_,i)=>event('e'+i,i,'note','n',{span_id:'s'+i,...(i?{parent_span_id:'s'+(i-1)}:{})})));
 assert.equal(deep.spans.length,80);assert.ok(Math.max(...deep.spans.map(s=>s.depth))<SPAN_LIMITS.depth);
 const odd=buildSpans([event('a',0,'response','x',{span_id:'s',attributes:{'gen_ai.usage.input_tokens':-1,'gen_ai.usage.output_tokens':1.5,'gen_ai.request.model':{}}}),event('b',0,'note','x',{span_id:'x'.repeat(129)}),event('c',0,'note','x','text'),event('d',0,'note','x',null),event('e',0,'note','x',{__proto__:{span_id:'proto'}})]);
 assert.equal(odd.totals.total_tokens,0);assert.equal(odd.spans[0].model,null);assert.equal(odd.spans.filter(s=>s.inferred).length,4);
 for(const bad of [null,{},[null],[{id:'a',name:'a',time:'nope'}],Array.from({length:SPAN_LIMITS.events+1},(_,i)=>event('e'+i,0,'note','n'))])assert.throws(()=>buildSpans(bad),/invalid_span_input/);
 assert.deepEqual(buildSpans([]),{spans:[],totals:{input_tokens:0,output_tokens:0,total_tokens:0,cost_usd:0,llm_spans:0,unpriced_spans:0,reported_cost_spans:0,errors:0,unfinished:0},start:null,end:null,duration_ms:0,inferred:false});
});
test('price lookup: exact id, provider prefix, dated snapshot; never a partial-name guess',()=>{
 assert.deepEqual(priceFor('gpt-4o-mini'),{id:'gpt-4o-mini',input:0.15,output:0.6});assert.equal(priceFor('openai/gpt-4o-2024-08-06').id,'gpt-4o');assert.equal(priceFor('claude-haiku-4-5-20251001').id,'claude-haiku-4-5');assert.equal(priceFor('GPT-5').id,'gpt-5');
 for(const model of ['gpt-4o-mini-custom','gpt','',null,7,'x'.repeat(201),'constructor','__proto__'])assert.equal(priceFor(model),null);
 assert.match(PRICES_AS_OF,/^\d{4}-\d{2}-\d{2}$/);assert.ok(PRICE_SOURCES.every(url=>url.startsWith('https://')));
});
// Minimal DOM: enough to prove what the view writes, not how a browser lays it out.
class Node{constructor(tag){this.tagName=tag;this.children=[];this.dataset={};this.attrs={};this.hidden=false;this.className='';this._text='';this.vars={};this.style={setProperty:(k,v)=>{this.vars[k]=v;}};}
 set textContent(v){this._text=String(v);this.children=[];}get textContent(){return this._text+this.children.map(x=>x.textContent).join(' ');}
 append(...v){this.children.push(...v);}replaceChildren(...v){this._text='';this.children=[...v];}setAttribute(k,v){this.attrs[k]=String(v);}
 find(match,out=[]){for(const child of this.children){if(match(child))out.push(child);child.find(match,out);}return out;}}
const dom=()=>{const root=new Node('section');root.hidden=true;return {root,document:{createElement:tag=>new Node(tag)}};};
test('view shows totals, per-span model/tokens/cost/latency, scaled bars, and opens the raw event',()=>{
 const {root,document}=dom(),picked=[],view=mountSpanView({document,root,onSelect:id=>picked.push(id)});
 view.render(nested(),{complete:true});assert.equal(root.hidden,false);
 const total=id=>root.find(n=>n.dataset.total===id)[0].textContent;
 assert.deepEqual([total('duration'),total('input'),total('output'),total('cost'),total('errors')],['2.50 s','3,200','800','$0.0094','0']);
 const rows=root.find(n=>n.className.startsWith('span-row'));assert.equal(rows.length,4);assert.deepEqual(rows.map(r=>r.vars['--depth']),['0','1','1','1']);
 const facts=rows[1].find(n=>n.className==='span-facts')[0].textContent;assert.equal(facts,'gpt-4o-mini-2024-07-18 · 1,200 in / 300 out · $0.0004 · 900 ms');
 const bar=rows[3].find(n=>n.className==='span-bar')[0];assert.deepEqual([bar.vars['--at'],bar.vars['--size']],['57.200%','40.000%']);
 rows[2].find(n=>n.className==='span-open')[0].onclick();assert.deepEqual(picked,['e4']);
 const note=root.find(n=>n.className==='hint span-note')[0].textContent;assert.match(note,/estimate from public list prices as of \d{4}-\d{2}-\d{2}/);assert.doesNotMatch(note,/loaded so far|paired by event order/);
 view.clear();assert.equal(root.hidden,true);assert.equal(root.children.length,0);
});
test('partial loads, inferred pairing, unpriced models and unfinished spans are disclosed; empty or invalid input hides the view',()=>{
 const {root,document}=dom(),view=mountSpanView({document,root});
 view.render([event('a',0,'request','chat',{model:'my-local-llama',usage:{input_tokens:5,output_tokens:5}}),event('b',1,'request','chat',{})],{complete:false});
 const note=root.find(n=>n.className==='hint span-note')[0].textContent;
 for(const expected of [/Totals cover the 2 events loaded so far/,/paired by event order/,/2 spans have no closing event/,/1 span with tokens uses a model missing from the price table/])assert.match(note,expected);
 assert.equal(root.find(n=>n.dataset.total==='cost')[0].textContent,'$0');
 view.render([],{complete:true});assert.equal(root.hidden,true);
 view.render(nested());assert.equal(root.hidden,false);assert.equal(view.render([{bad:true}]),null);assert.equal(root.hidden,true);
 const many=Array.from({length:WATERFALL_ROWS+5},(_,i)=>event('e'+i,i,'note','n'));view.render(many,{complete:true});
 assert.equal(root.find(n=>n.className.startsWith('span-row')).length,WATERFALL_ROWS);assert.match(root.find(n=>n.className==='hint span-note')[0].textContent,/Showing the first 2,000 of 2,005 spans/);
});
test('view shows a reported cost even when no span has tokens',()=>{
 const {root,document}=dom(),view=mountSpanView({document,root});
 view.render([event('a',0,'response','chat',{source:'otlp',span:{spanId:'s1',startTimeUnixNano:nano(0),endTimeUnixNano:nano(100),kind:'llm',status:'ok',model:'my-local-llama',reported_cost:0.5}})],{complete:true});
 assert.equal(root.find(n=>n.dataset.total==='cost')[0].textContent,'$0.5000');assert.equal(root.find(n=>n.className==='span-facts')[0].textContent,'my-local-llama · $0.5000 reported · 100 ms');
 const note=root.find(n=>n.className==='hint span-note')[0].textContent;assert.match(note,/1 span uses the cost reported by the instrumentation/);assert.doesNotMatch(note,/list prices|missing from the price table/);
});
test('formatting stays honest at the edges',()=>{assert.deepEqual([formatDuration(0),formatDuration(999.4),formatDuration(12345),formatDuration(125000),formatDuration(-1),formatDuration(NaN)],['0 ms','999 ms','12.3 s','2 min 5 s','—','—']);assert.deepEqual([formatCost(0),formatCost(0.00001),formatCost(0.01234),formatCost(12.345),formatCost(null)],['$0','<$0.0001','$0.0123','$12.35','—']);});
test('a Langfuse-ingested generation uses its own startTime and endTime, not the later update delivery time',async()=>{
 const {planLangfuseBatches}=await import('../src/langfuse-ingest.mjs');const t=s=>at(s*1000);
 const plan=planLangfuseBatches({batch:[{id:'e1',type:'trace-create',timestamp:t(0),body:{id:'tr',name:'run',timestamp:t(0)}},
  {id:'e2',type:'generation-create',timestamp:t(0),body:{id:'g1',traceId:'tr',name:'chat',model:'gpt-synthetic',startTime:t(0)}},
  {id:'e3',type:'generation-update',timestamp:t(10),body:{id:'g1',traceId:'tr',endTime:t(1)}}]});
 const built=buildSpans(plan.batches.flatMap(entry=>entry.batch.events)),span=built.spans.find(item=>item.id==='g1');
 assert.ok(span,'the generation is one explicit span');assert.equal(span.duration_ms,1000);
});

const timed=(id,start,end,parent)=>event(id,start??0,'note',id,{span_id:id,...(parent===undefined?{}:{parent_span_id:parent}),...(start===null?{}:{start_time:at(start)}),...(end===null?{}:{end_time:at(end)})});
test('timing identity preserves accepted IDs independently of display limits and aliases',()=>{
 for(const alias of ['span_id','spanId'])for(const nested of [false,true])for(const length of [128,129,200,201,512]){
  const id='r'.repeat(length),data={[alias]:id,startTime:at(0),endTime:at(1000)};
  const events=[event('root',0,'note','root',nested?{span:data}:data),timed('child',100,2500,id)];
  const facts=spanTimings(events);
  assert.equal(facts[0].id,id);assert.deepEqual(rootSpanTiming(facts),{id,start:Date.parse(at(0)),end:Date.parse(at(1000))});
  assert.equal(buildSpans(events).duration_ms,1000);
 }
});
test('long timing IDs join split updates without truncation collisions',()=>{
 const id='r'.repeat(129),other=id+'r';
 const events=[event('start',0,'note','root',{span:{spanId:id,startTime:at(0)}}),
  event('end',4000,'note','root',{span:{spanId:id,endTime:at(1000)}}),
  event('later',100,'note','later',{span:{spanId:other,startTime:at(100),endTime:at(5000)}})];
 for(const ordered of [events,[...events].reverse()]){
  const root=rootSpanTiming(spanTimings(ordered));assert.equal(root.id,id);assert.equal(rootDuration(root),1000);
  assert.equal(buildSpans(ordered).duration_ms,1000);
 }
});
test('trace duration is the root own 1000 ms even when its child ends at 2500 ms',()=>{
 const view=buildSpans([timed('child',100,2500,'root'),timed('root',0,1000,'')]);
 assert.equal(view.duration_ms,1000);assert.equal(view.end-view.start,2500);
 assert.equal(view.spans.find(span=>span.id==='child').duration_ms,2400);
});
test('equal-start roots settle duration before identity or event order',()=>{
 for(const events of [[timed('a',0,2500),timed('b',0,1000)],[timed('b',0,2500),timed('a',0,1000)]]){
  for(const ordered of [events,[...events].reverse()])assert.equal(buildSpans(ordered).duration_ms,1000);
 }
});
for(const alias of ['parent_span_id','parentSpanId'])test(`unsupported ${alias} stays a child for duration selection`,()=>{
 const other=alias==='parent_span_id'?'parentSpanId':'parent_span_id';
 for(const nested of [false,true])for(const parent of ['x'.repeat(129),42])for(const empty of [undefined,'',null]){
  const data={spanId:'child',[alias]:parent,[other]:empty,startTime:at(-100),endTime:at(2500)};
  const child=event('child',-100,'note','child',nested?{span:data}:data),root=timed('root',0,1000);
  for(const events of [[root,child],[root,child,event('update',3000,'note','child',{spanId:'child',endTime:at(3000)})],
   [root,event('partial',-200,'note','child',{spanId:'child',startTime:at(-200)}),child]]){
   assert.equal(buildSpans(events).duration_ms,1000);
  }
  assert.equal(buildSpans([child]).duration_ms,2600,'no root keeps the original range');
 }
});
test('multiple roots select earliest start rather than arrival order or longest duration',()=>{
 const view=buildSpans([timed('later',100,5000),timed('earliest',0,1000),timed('child',200,2500,'earliest')]);
 assert.equal(view.duration_ms,1000);
});
test('missing roots, orphan children and cycles use the original span range',()=>{
 for(const parents of [['missing','missing'],['second','first']]){
  const view=buildSpans([timed('first',0,1000,parents[0]),timed('second',100,2500,parents[1])]);
  assert.equal(view.duration_ms,2500);
 }
});
test('unfinished or invalid earliest root falls back even if a later root is complete',()=>{
 for(const [start,end] of [[0,null],[null,1000],[0,-1]]){
  const view=buildSpans([timed('root',start,end),timed('later',100,500),timed('child',200,2500,'root')]);
  assert.equal(view.duration_ms,2500);
 }
});
test('a zero length root is a usable duration',()=>{
 assert.equal(buildSpans([timed('root',0,0),timed('child',100,2500,'root')]).duration_ms,0);
});
