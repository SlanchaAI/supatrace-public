import {planCustomerImport} from '../src/import-planning.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
import {loadAccountRuns,queryAccountRuns} from '../public/app/run-data.js';

const html=readFileSync(new URL('../public/app/index.html',import.meta.url),'utf8');
const source=readFileSync(new URL('../public/app/app.js',import.meta.url),'utf8');
class Element {
 constructor(tag='div'){this.tagName=tag;this.children=[];this.dataset={};this.value='';this.hidden=false;this.disabled=false;this.attrs={};this._text='';const classes=new Set();this.classList={add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x),toggle:(x,on)=>on?classes.add(x):classes.delete(x)};}
 set textContent(value){this._text=String(value);this.children=[];}get textContent(){return this._text+this.children.map(child=>typeof child==='string'?child:child.textContent).join('');}
 set innerHTML(value){throw Error('Unsafe innerHTML assignment: '+value);}
 append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this._text='';this.children=[...nodes];}
 setAttribute(key,value){this.attrs[key]=String(value);}getAttribute(key){return this.attrs[key]??null;}removeAttribute(key){delete this.attrs[key];if(key==='href')delete this.href;}
 get options(){return this.children.filter(child=>child.tagName==='option');}querySelectorAll(){return [];}querySelector(){return new Element('h1');}addEventListener(){}focus(){}remove(){}matches(){return false;}
}
function app(fetcher=async()=>{throw Error('Unexpected fetch');},options={}){
 const nodes=new Map();for(const match of html.matchAll(/<([a-z][\w-]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)){const node=new Element(match[1]);node.hidden=/\bhidden(?:\s|>)/.test(match[0]);node.disabled=/\bdisabled(?:\s|>)/.test(match[0]);nodes.set(match[2],node);}
 const get=id=>{assert.ok(nodes.has(id),'App requested missing HTML element '+id);return nodes.get(id);};
 const document={getElementById:get,createElement:tag=>new Element(tag),querySelectorAll:()=>[],querySelector:()=>null,addEventListener(){},body:new Element('body')};
 const listeners=new Map(),assigned=[],calls=[];let randomCalls=0;
 const location={hash:'#usage',origin:'https://supatrace.dev',assign(url){assigned.push(url);},replace(){}};
 const context={document,window:{matchMedia:()=>({matches:false,addEventListener(){}})},location,fetch:async(url,init)=>{calls.push({url,init,body:init.body&&JSON.parse(init.body)});return fetcher(url,init);},Response,URL,URLSearchParams,TextEncoder,Uint8Array,AbortController,crypto:{subtle:webcrypto.subtle,getRandomValues(array){randomCalls++;if(options.noRandom)throw Error('Unavailable');return webcrypto.getRandomValues(array);}},Blob,loadAccountRuns,queryAccountRuns,setTimeout:()=>0,clearTimeout(){},addEventListener:(name,listener)=>listeners.set(name,listener)};
 let executable=source.replace(/^import[^\n]+\n/gm,'');executable=executable.slice(0,executable.lastIndexOf('\nshowView();'));
 executable+='\nactiveProject="proj_dddddddddddddddddddddddddddddddd";globalThis.testApp={usage,loadCommercial,loadBillingStatus,showView};';
 Object.assign(context,{rememberSetupCode(){},pendingSetupCode:()=>null,clearSetupCode(){},clearFirstTraceStorage(){}});runInNewContext(executable,context);
 return {a:context.testApp,get,calls,assigned,listeners,randomCalls:()=>randomCalls,setHash:hash=>{location.hash=hash;},choose:id=>{get('commercial-plan').value=id;get('commercial-plan').onchange();},submit:()=>get('commercial-form').onsubmit({preventDefault(){}})};
}

const project='proj_'+ 'd'.repeat(32);
function fill(f){for(const [id,value]of Object.entries({'import-origin':'https://cloud.langfuse.com','import-source':'synthetic-source','import-environment':'synthetic-prod','import-namespace':'explicit-fixture','import-from':'2026-10-01T00:00','import-to':'2026-10-02T00:00','import-rows':'100','import-pages':'2','import-page-size':'50','import-bytes':'100000'}))f.get(id).value=value;}
const submit=f=>f.get('import-form').onsubmit({preventDefault(){}});
async function until(predicate){const stop=Date.now()+2000;while(!predicate()&&Date.now()<stop)await new Promise(resolve=>setTimeout(resolve,1));assert.ok(predicate());}
test('actual Agents import form sends bounded explicit scope and displays no-start server plan',async()=>{const f=app(async(url,init)=>{assert.equal(url,'/api/imports/plan?project='+project);const data=JSON.parse(init.body);assert.equal(data.environment,'synthetic-prod');assert.equal(data.from,'2026-10-01T00:00:00.000Z');assert.equal(data.maxRetries,0);assert.equal(Object.hasOwn(data,'destinationProject'),false);assert.equal(Object.hasOwn(data,'secretKey'),false);return new Response(JSON.stringify(planCustomerImport(data,project)));});fill(f);await submit(f);assert.match(f.get('import-result').textContent,/planned_not_authorized_not_started/);assert.match(f.get('import-result').textContent,/secure_source_credential_binding/);assert.equal(f.get('import-start').disabled,true);assert.equal(f.get('import-plan-button').disabled,false);assert.equal(f.calls.length,1);});
test('scope editing invalidates an in-flight plan response',async()=>{let resolve;const f=app(()=>new Promise(done=>resolve=done));fill(f);const work=submit(f);await until(()=>f.calls.length===1);f.get('import-form').oninput();resolve(new Response(JSON.stringify(planCustomerImport(f.calls[0].body,project))));await work;assert.match(f.get('import-result').textContent,/Review the changed scope again/);assert.doesNotMatch(f.get('import-result').textContent,/fingerprint/);assert.equal(f.get('import-start').disabled,true);});
test('unexpected execution-ready or wrong-project result cannot enable Start',async()=>{for(const wrongProject of [false,true]){const f=app(async(url,init)=>{const result=planCustomerImport(JSON.parse(init.body),project);if(wrongProject)result.plan.scope.destinationProject='proj_'+ 'e'.repeat(32);else result.capabilities.execution_available=true;return new Response(JSON.stringify(result));});fill(f);await submit(f);assert.match(f.get('import-result').textContent,/cannot start/);assert.equal(f.get('import-start').disabled,true);}});
test('server errors are fixed safe text rather than echoed source or credential content',async()=>{const f=app(async()=>new Response(JSON.stringify({error:'private-provider-content-must-not-display'}),{status:503}));fill(f);await submit(f);assert.doesNotMatch(f.get('import-result').textContent,/private-provider/);assert.match(f.get('import-result').textContent,/Nothing was connected or started/);assert.equal(f.get('import-start').disabled,true);});
