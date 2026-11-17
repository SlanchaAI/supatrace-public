// Paint the span waterfall above the raw event list. The raw JSON stays the source of
// truth: every row only points at events the list already shows.
import {buildSpans} from './span-data.js';
import {PRICES_AS_OF} from './model-prices.js';
export const WATERFALL_ROWS=2000;
const whole=value=>value.toLocaleString('en-US');
export function formatDuration(ms){if(!Number.isFinite(ms)||ms<0)return '—';if(ms<1000)return Math.round(ms)+' ms';if(ms<60000)return (ms/1000).toFixed(ms<10000?2:1)+' s';return Math.floor(ms/60000)+' min '+Math.round(ms%60000/1000)+' s';}
export function formatCost(usd){if(usd===null||!Number.isFinite(usd))return '—';if(usd===0)return '$0';if(usd<0.0001)return '<$0.0001';return '$'+usd.toFixed(usd<1?4:2);}
export function mountSpanView({document,root,onSelect=()=>{}}){
 const make=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
 const clear=()=>{root.replaceChildren();root.hidden=true;};
 function render(events,{complete=false}={}){
  let view;try{view=buildSpans(events);}catch{clear();return null;}
  if(!view.spans.length){clear();return view;}
  const {totals}=view,summary=make('dl','span-totals');
  const stat=(name,value,id)=>{const box=make('div'),term=make('dt','',name),detail=make('dd','',value);if(id)detail.dataset.total=id;box.append(term,detail);summary.append(box);};
  stat('Duration',formatDuration(view.duration_ms),'duration');
  stat('Tokens in',whole(totals.input_tokens),'input');stat('Tokens out',whole(totals.output_tokens),'output');
  stat('Estimated cost',totals.total_tokens===0&&totals.reported_cost_spans===0?'—':formatCost(totals.cost_usd),'cost');
  stat('Errors',whole(totals.errors),'errors');
  const notes=[];
  if(!complete)notes.push('Totals cover the '+whole(events.length)+' events loaded so far.');
  if(view.inferred)notes.push('Spans without a span ID are paired by event order (request with the next response, tool call with its result); nesting is not inferred.');
  if(totals.unfinished)notes.push(whole(totals.unfinished)+' span'+(totals.unfinished===1?' has':'s have')+' no closing event in the loaded data.');
  if(totals.unpriced_spans)notes.push(whole(totals.unpriced_spans)+' span'+(totals.unpriced_spans===1?'':'s')+' with tokens '+(totals.unpriced_spans===1?'uses a model':'use models')+' missing from the price table; the estimate leaves '+(totals.unpriced_spans===1?'it':'them')+' out.');
  if(totals.reported_cost_spans)notes.push(whole(totals.reported_cost_spans)+' span'+(totals.reported_cost_spans===1?' uses':'s use')+' the cost reported by the instrumentation.');
  if(totals.total_tokens)notes.push('Cost'+(totals.reported_cost_spans?' for the rest':'')+' is an estimate from public list prices as of '+PRICES_AS_OF+', base input and output tokens only. It is not a bill.');
  if(view.spans.length>WATERFALL_ROWS)notes.push('Showing the first '+whole(WATERFALL_ROWS)+' of '+whole(view.spans.length)+' spans. Totals cover all of them.');
  const note=make('p','hint span-note',notes.join(' ')),list=make('ol','waterfall');list.setAttribute('aria-label','Span waterfall');
  const scale=view.duration_ms>0?view.duration_ms:1;
  for(const span of view.spans.slice(0,WATERFALL_ROWS)){
   const item=make('li','span-row'+(span.status==='error'?' error':'')),open=make('button','span-open');open.type='button';
   item.dataset.span=span.id;item.dataset.type=span.type;item.style?.setProperty('--depth',String(Math.min(span.depth,12)));
   const head=make('span','span-head');head.append(make('span','span-type',span.type),make('span','span-name',span.name));
   const facts=[];if(span.model)facts.push(span.model);
   if(span.input_tokens!==null||span.output_tokens!==null)facts.push(whole(span.input_tokens??0)+' in / '+whole(span.output_tokens??0)+' out');
   if(span.cost_usd!==null)facts.push(formatCost(span.cost_usd)+(span.cost_reported?' reported':''));
   facts.push(span.unfinished?'no closing event':formatDuration(span.duration_ms));if(span.status==='error')facts.push('error');
   const track=make('span','span-track'),bar=make('span','span-bar');
   bar.style?.setProperty('--at',(span.offset_ms/scale*100).toFixed(3)+'%');bar.style?.setProperty('--size',(span.duration_ms/scale*100).toFixed(3)+'%');track.append(bar);
   open.append(head,make('span','span-facts',facts.join(' · ')),track);
   open.setAttribute('aria-label',span.type+' span '+span.name+', '+facts.join(', ')+'. Show raw event.');
   open.onclick=()=>onSelect(span.events[0],span);
   item.append(open);list.append(item);
  }
  root.replaceChildren(make('h3','',"Spans"),summary,note,list);root.hidden=false;
  return view;
 }
 return {render,clear};
}
