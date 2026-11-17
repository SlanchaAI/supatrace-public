// Rendered check of the span waterfall against the local harness: real upload, real
// event pages, real layout. Hosted supatrace.dev proof is separate and not claimed here.
import test,{before,after} from 'node:test';import assert from 'node:assert/strict';
import {start} from './harness.mjs';import {launch} from './browser.mjs';
let browser;before(async()=>{browser=await launch();});after(async()=>{await browser?.close();});
async function nav(page,name){const toggle=page.locator('#menu-toggle');if(await toggle.isVisible()&&await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();await page.locator(`#rail a[data-nav="${name}"]`).click();}
const at=ms=>new Date(Date.parse('2026-11-14T00:00:00Z')+ms).toISOString();
const event=(id,ms,kind,name,data)=>({id,time:at(ms),kind,name,data});
const batches=[[
 event('e1',0,'note','agent run',{span_id:'root'}),
 event('e2',10,'request','chat gpt-4o-mini',{span_id:'llm1',parent_span_id:'root',attributes:{'gen_ai.request.model':'gpt-4o-mini'}}),
 event('e3',910,'response','chat gpt-4o-mini',{span_id:'llm1',parent_span_id:'root',attributes:{'gen_ai.usage.input_tokens':1200,'gen_ai.usage.output_tokens':300}}),
 event('e4',920,'tool_call','search',{span_id:'tool1',parent_span_id:'root'})],[
 event('e5',1420,'error','search',{span_id:'tool1',parent_span_id:'root'}),
 event('e6',1430,'request','chat claude-sonnet-5-5',{span_id:'llm2',parent_span_id:'root',attributes:{'gen_ai.request.model':'claude-sonnet-5-5'}}),
 event('e7',2430,'response','chat claude-sonnet-5-5',{span_id:'llm2',parent_span_id:'root',attributes:{'gen_ai.usage.input_tokens':2000,'gen_ai.usage.output_tokens':500}}),
 event('e8',2500,'note','agent run',{span_id:'root'})]];
for(const viewport of [{width:1280,height:800},{width:390,height:844},{width:320,height:740}])test(`nested LLM and tool spans render as a waterfall with totals at ${viewport.width}px`,{timeout:60000},async()=>{
 const live=await start(),context=await browser.newContext({viewport});await context.route(/^(?!http:\/\/127\.0\.0\.1)/,route=>route.abort());
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(String(error)));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
 try{
  const tenant=await live.signIn(context),key=await live.writeKey(tenant);for(let i=0;i<batches.length;i++)await live.upload(key,{version:1,batch_id:'waterfall-'+i,run_id:'waterfall-run',events:batches[i]});
  await page.goto(live.origin+'/app/',{waitUntil:'networkidle'});await nav(page,'traces');await page.getByRole('button',{name:'Open trace waterfall-run',exact:true}).click();
  await page.locator('#events-note').filter({hasText:'Showing 4 events'}).waitFor();
  // First batch only: the view says its totals are partial.
  await page.locator('#span-view .span-note').filter({hasText:'Totals cover the 4 events loaded so far'}).waitFor();assert.equal(await page.locator('#span-view .span-row').count(),3);
  // The tool call's closing event is on the next page: it must not read as a finished 0 ms span.
  assert.match(await page.locator('#span-view .span-row[data-span="tool1"] .span-facts').textContent(),/no closing event/);assert.match(await page.locator('#span-view .span-note').textContent(),/1 span has no closing event in the loaded data/);
  await page.locator('#events-more').click();await page.locator('#events-note').filter({hasText:'All 8 events loaded'}).waitFor();
  const total=id=>page.locator(`#span-view [data-total="${id}"]`).textContent();
  assert.deepEqual([await total('duration'),await total('input'),await total('output'),await total('cost'),await total('errors')],['2.50 s','3,200','800','$0.0094','1']);
  const settled=await page.locator('#span-view .span-note').textContent();assert.equal(settled.includes('loaded so far'),false);assert.equal(settled.includes('no closing event'),false);assert.match(await page.locator('#span-view .span-row[data-span="tool1"] .span-facts').textContent(),/^500 ms · error$/);
  const rows=page.locator('#span-view .span-row');assert.equal(await rows.count(),4);
  assert.deepEqual(await rows.evaluateAll(list=>list.map(row=>[row.dataset.span,row.dataset.type,row.classList.contains('error')])),[['root','span',false],['llm1','llm',false],['tool1','tool',true],['llm2','llm',false]]);
  assert.match(await rows.nth(1).locator('.span-facts').textContent(),/^gpt-4o-mini · 1,200 in \/ 300 out · \$0\.0004 · 900 ms$/);
  // Geometry: children are indented, bars sit in time order and are sized by duration.
  const box=async(index,selector)=>rows.nth(index).locator(selector).boundingBox();
  const [rootHead,childHead]=[await box(0,'.span-open'),await box(1,'.span-open')];assert.ok(childHead.x>rootHead.x,'child span is indented');
  const [rootBar,first,tool,second]=[await box(0,'.span-bar'),await box(1,'.span-bar'),await box(2,'.span-bar'),await box(3,'.span-bar')];
  const [rootTrack,childTrack]=[await box(0,'.span-track'),await box(3,'.span-track')];
  assert.ok(Math.abs(rootBar.width-rootTrack.width)<=1,'root spans the whole trace');
  assert.ok((first.x-(await box(1,'.span-track')).x)<(tool.x-(await box(2,'.span-track')).x)&&(tool.x-(await box(2,'.span-track')).x)<(second.x-childTrack.x),'bars start in time order');
  assert.ok(Math.abs(second.width/childTrack.width-0.4)<0.02,'1000 ms of 2500 ms is 40% of the track');assert.ok(first.width>tool.width);
  // Raw JSON is one click away and unchanged.
  assert.equal(await page.locator('#events li[data-event="e7"] details').evaluate(node=>node.open),false);
  await rows.nth(3).locator('.span-open').click();assert.equal(await page.locator('#events li[data-event="e6"] details').evaluate(node=>node.open),true);
  assert.deepEqual(JSON.parse(await page.locator('#events li[data-event="e6"] pre').textContent()),batches[1][1]);
  const size=await page.evaluate(()=>({width:document.documentElement.scrollWidth,inner:innerWidth}));assert.ok(size.width<=size.inner,'no horizontal overflow');
  await page.locator('#close-detail').click();assert.equal(await page.locator('#span-view').isHidden(),true);assert.equal(await page.locator('#span-view .span-row').count(),0);
  assert.deepEqual(errors,[]);
 }finally{await context.close();await live.close();}
});

test('OTLP list and detail show root duration when a child outlives it',{timeout:60000},async()=>{
 const live=await start(),context=await browser.newContext({viewport:{width:390,height:844}});
 await context.route(/^(?!http:\/\/127\.0\.0\.1)/,route=>route.abort());
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(String(error)));
 try{
  const tenant=await live.signIn(context),key=await live.writeKey(tenant);
  const traceId='0123456789abcdef0123456789abcdef',root='1111111111111111',run='otlp.'+traceId;
  const nano=ms=>String(BigInt(Date.parse(at(ms)))*1000000n);
  const span=(id,parent,start,end)=>({traceId,spanId:id,...(parent?{parentSpanId:parent}:{}),name:id,startTimeUnixNano:nano(start),endTimeUnixNano:nano(end),attributes:[],status:{code:1}});
  const response=await fetch(live.origin+'/v1/traces',{method:'POST',headers:{'content-type':'application/json','x-supatrace-key':key},body:JSON.stringify({resourceSpans:[{scopeSpans:[{spans:[span(root,null,0,1000),span('2222222222222222',root,100,2500)]}]}]})});
  assert.equal(response.status,200);
  await page.goto(live.origin+'/app/',{waitUntil:'networkidle'});await nav(page,'traces');
  const row=page.locator(`#runs tr[data-run="${run}"]`);await row.waitFor();assert.equal(await row.locator('td').nth(3).textContent(),'1.0s');
  await row.getByRole('button',{name:'Open trace '+run,exact:true}).click();
  await page.locator('#events-note').filter({hasText:'All 2 events loaded'}).waitFor();
  assert.equal(await page.locator('#span-view [data-total="duration"]').textContent(),'1.00 s');
  assert.match(await page.locator(`#span-view .span-row[data-span="${root}"] .span-facts`).textContent(),/1.00 s/);
  assert.match(await page.locator('#span-view .span-row[data-span="2222222222222222"] .span-facts').textContent(),/2.40 s/);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
 }finally{await context.close();await live.close();}
});

test('batch long-ID split updates and equal-start roots agree in list and detail',{timeout:60000},async()=>{
 const live=await start(),context=await browser.newContext({viewport:{width:390,height:844}});
 await context.route(/^(?!http:\/\/127\.0\.0\.1)/,route=>route.abort());
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(String(error)));
 try{
  const tenant=await live.signIn(context),key=await live.writeKey(tenant),id='r'.repeat(30000),run='long-batch';
  await live.upload(key,{version:1,batch_id:'long-start',run_id:run,events:[
   event('start',0,'note','root',{spanId:id,startTime:at(0)}),
   event('later',0,'note','later',{spanId:'a',startTime:at(0),endTime:at(2500)})]});
  await live.upload(key,{version:1,batch_id:'long-end',run_id:run,events:[event('end',4000,'note','root',{spanId:id,endTime:at(1000)})]});
  await page.goto(live.origin+'/app/',{waitUntil:'networkidle'});await nav(page,'traces');
  const row=page.locator(`#runs tr[data-run="${run}"]`);await row.waitFor();assert.equal(await row.locator('td').nth(3).textContent(),'1.0s');
  await row.getByRole('button',{name:'Open trace '+run,exact:true}).click();
  await page.locator('#events-note').filter({hasText:'Showing 2 events'}).waitFor();
  await page.locator('#events-more').click();
  await page.locator('#events-note').filter({hasText:'All 3 events loaded'}).waitFor();
  assert.equal(await page.locator('#span-view [data-total="duration"]').textContent(),'1.00 s');
  assert.deepEqual(errors,[]);
 }finally{await context.close();await live.close();}
});

for(const [width,length] of [[1280,129],[390,200]])test(`Langfuse ${length}-character root ID shows its own duration in list and detail`,{timeout:60000},async()=>{
 const live=await start(),context=await browser.newContext({viewport:{width,height:844}});
 await context.route(/^(?!http:\/\/127\.0\.0\.1)/,route=>route.abort());
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(String(error)));
 try{
  const tenant=await live.signIn(context),key=await live.writeKey(tenant),traceId='long-root',run='lf.'+traceId,id='r'.repeat(length);
  const response=await fetch(live.origin+'/api/public/ingestion',{method:'POST',headers:{'content-type':'application/json','x-supatrace-key':key},body:JSON.stringify({batch:[
   {id:'root',type:'span-create',timestamp:at(0),body:{id,traceId,startTime:at(0),endTime:at(1000)}},
   {id:'child',type:'span-create',timestamp:at(100),body:{id:'child',traceId,parentObservationId:id,startTime:at(100),endTime:at(2500)}}
  ]})});
  assert.equal(response.status,207);assert.deepEqual((await response.json()).errors,[]);
  await page.goto(live.origin+'/app/',{waitUntil:'networkidle'});await nav(page,'traces');
  const row=page.locator(`#runs tr[data-run="${run}"]`);await row.waitFor();assert.equal(await row.locator('td').nth(3).textContent(),'1.0s');
  await row.getByRole('button',{name:'Open trace '+run,exact:true}).click();
  await page.locator('#events-note').filter({hasText:'All 2 events loaded'}).waitFor();
  assert.equal(await page.locator('#span-view [data-total="duration"]').textContent(),'1.00 s');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
 }finally{await context.close();await live.close();}
});

for(const [width,parentObservationId] of [[1280,'x'.repeat(201)],[390,false]])test(`Langfuse unsupported parent keeps list and detail at root duration at ${width}px`,{timeout:60000},async()=>{
 const live=await start(),context=await browser.newContext({viewport:{width,height:844}});
 await context.route(/^(?!http:\/\/127\.0\.0\.1)/,route=>route.abort());
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(String(error)));
 try{
  const tenant=await live.signIn(context),key=await live.writeKey(tenant),run='lf.parent-presence';
  const response=await fetch(live.origin+'/api/public/ingestion',{method:'POST',headers:{'content-type':'application/json','x-supatrace-key':key},body:JSON.stringify({batch:[
   {id:'root',type:'span-create',timestamp:at(0),body:{id:'root',traceId:'parent-presence',startTime:at(0),endTime:at(1000)}},
   {id:'child',type:'span-create',timestamp:at(-100),body:{id:'child',traceId:'parent-presence',parentObservationId,startTime:at(-100),endTime:at(2500)}}
  ]})});
  assert.equal(response.status,207);assert.deepEqual((await response.json()).errors,[]);
  await page.goto(live.origin+'/app/',{waitUntil:'networkidle'});await nav(page,'traces');
  const row=page.locator(`#runs tr[data-run="${run}"]`);await row.waitFor();assert.equal(await row.locator('td').nth(3).textContent(),'1.0s');
  await row.getByRole('button',{name:'Open trace '+run,exact:true}).click();
  await page.locator('#events-note').filter({hasText:'All 2 events loaded'}).waitFor();
  assert.equal(await page.locator('#span-view [data-total="duration"]').textContent(),'1.00 s');
  assert.match(await page.locator('#span-view .span-row[data-span="child"] .span-facts').textContent(),/2.60 s/);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
 }finally{await context.close();await live.close();}
});
