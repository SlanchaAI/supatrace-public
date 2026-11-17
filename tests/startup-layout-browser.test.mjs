import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {start,CSP} from './harness.mjs';
import {launch} from './browser.mjs';
let live,browser;
before(async()=>{live=await start();browser=await launch();});
after(async()=>{await browser?.close();await live?.close();});

// Inspect character ranges inside each short token, allowing breaks only at
// spaces or path/name separators. Element rectangles alone miss text-node wraps.
function brokenTokens(){
 const broken=[];
 for(const code of document.querySelectorAll('main code')){
  if(code.closest('pre')||!code.getClientRects().length)continue;
  const walker=document.createTreeWalker(code,NodeFilter.SHOW_TEXT);
  while(walker.nextNode()){
   const node=walker.currentNode;
   for(const match of node.textContent.matchAll(/[^\s/.\-_]+/g)){
    if(match[0].length>24)continue;
    const tops=new Set();
    for(let i=0;i<match[0].length;i++){
     const range=document.createRange();range.setStart(node,match.index+i);range.setEnd(node,match.index+i+1);
     for(const rect of range.getClientRects())if(rect.width&&rect.height)tops.add(Math.round(rect.top));
    }
    if(tops.size>1)broken.push({code:code.textContent,token:match[0]});
   }
  }
 }
 return broken;
}
for(const width of [390,1440])test(`signed-out app has only session/provider probes and no console or CSP errors at ${width}`,async()=>{
 const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage(),errors=[],requests=[];
 await context.route(/^(?!http:\/\/127\.0\.0\.1)/,route=>route.abort());
 page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});page.on('pageerror',e=>errors.push(e.message));
 page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/'))requests.push(new URL(r.url()).pathname+new URL(r.url()).search);});
 await page.addInitScript(()=>{globalThis.cspViolations=[];document.addEventListener('securitypolicyviolation',e=>globalThis.cspViolations.push(e.violatedDirective));});
 try{
  const response=await page.goto(live.origin+'/app/',{waitUntil:'networkidle'});
  assert.equal(response.headers()['content-security-policy'],CSP);
  await page.getByRole('link',{name:'Continue with GitHub',exact:true}).waitFor();
  assert.equal(await page.locator('#shell').isVisible(),false);
  assert.deepEqual(requests.sort(),['/api/auth/providers','/api/me?optional=1']);
  assert.equal(await page.locator('style,[style]').count(),0);
  // Exercise the page's SVG icon under the real policy. Fetch the legacy ICO as
  // a resource; navigating it creates a browser-owned image document with styles.
  assert.equal(await page.evaluate(()=>new Promise(resolve=>{const img=new Image();img.onload=()=>resolve(true);img.onerror=()=>resolve(false);img.src='/favicon.svg';})),true);
  const icon=await page.request.get(live.origin+'/favicon.ico');assert.equal(icon.status(),200);assert.equal(icon.headers()['content-type'],'image/x-icon');
  assert.deepEqual(await page.evaluate(()=>globalThis.cspViolations),[]);assert.deepEqual(errors,[]);
 }finally{await context.close();}
});
for(const width of [390,1440])test(`public inline code keeps short tokens intact without page overflow at ${width}`,{timeout:60000},async()=>{
 const sitemap=readFileSync(new URL('../public/sitemap.xml',import.meta.url),'utf8');
 const paths=new Set(['/','/pricing/',...Array.from(sitemap.matchAll(/<loc>([^<]+)<\/loc>/g),m=>new URL(m[1]).pathname).filter(p=>p.startsWith('/docs/'))]);
 const page=await browser.newPage({viewport:{width,height:900}});
 try{
  for(const path of paths){
   await page.goto(live.origin+path,{waitUntil:'networkidle'});
   // Include prose in collapsed documentation sections, too.
   await page.locator('details').evaluateAll(nodes=>nodes.forEach(n=>n.open=true));
   assert.deepEqual(await page.evaluate(brokenTokens),[],path);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,path);
  }
 }finally{await page.close();}
});
test('inline-code range check detects a short token split inside a text node',async()=>{
 const page=await browser.newPage();
 try{
  await page.setContent('<main><code>Authorization</code></main>');
  await page.locator('main').evaluate(n=>{n.style.width='30px';n.style.overflowWrap='anywhere';});
  assert.deepEqual(await page.evaluate(brokenTokens),[{code:'Authorization',token:'Authorization'}]);
 }finally{await page.close();}
});
