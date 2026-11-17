// Identity-free hosted smoke: signed-out pages and provider discovery on a deployed origin.
// Usage: node scripts/hosted-smoke.mjs https://supatrace.dev test-artifacts/hosted-signedout [label]
// Not an authenticated acceptance. Writes screenshots and receipt.json.
import {mkdirSync,writeFileSync} from 'node:fs';
import {launch} from '../tests/browser.mjs';
const origin=(process.argv[2]||'https://supatrace.dev').replace(/\/$/,''),out=process.argv[3]||'test-artifacts/hosted-signedout',label=process.argv[4]||'unlabeled';
mkdirSync(out,{recursive:true});const receipt={source:'hosted-signed-out',scope:'signed-out pages and provider discovery only; not an authenticated acceptance',origin,label,started:new Date().toISOString(),steps:[]};
const step=(name,ok,detail={})=>{receipt.steps.push({name,ok,...detail});console.log((ok?'PASS ':'FAIL ')+name);if(!ok)process.exitCode=1;};
const browser=await launch();
try{
 let r,p;try{r=await fetch(origin+'/api/auth/providers');p=await r.json();}catch(e){step('providers endpoint',false,{error:String(e)});}
 if(r&&p){step('providers endpoint',r.status===200&&typeof p.github==='boolean',{providers:p});
 const headers=['content-security-policy','x-frame-options','x-content-type-options','referrer-policy'].filter(h=>!r.headers.get(h));
 step('security headers present',headers.length===0,{missing:headers});}
 for(const [name,viewport] of [['desktop',{width:1280,height:800}],['narrow',{width:390,height:844}]]){
  const context=await browser.newContext({viewport}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));const expected401=new Set();page.on('response',x=>{if(x.status()===401&&new URL(x.url()).pathname==='/api/me')expected401.add(x.url());});page.on('console',m=>{if(m.type()==='error'&&!(/status of 401/.test(m.text())&&expected401.size))errors.push(m.text());});
  for(const [slug,path] of [['landing','/'],['app-signed-out','/app/']]){
   const resp=await page.goto(origin+path,{waitUntil:'networkidle'});
   let settled=true;if(slug==='app-signed-out')settled=await page.waitForFunction(()=>!/Checking your session/.test(document.getElementById('status')?.textContent||''),null,{timeout:15000}).then(()=>true,()=>false);
   await page.screenshot({path:`${out}/${slug}-${name}.png`,fullPage:true});
   const landmark=await page.locator(slug==='landing'?'h1':'a[href="/api/auth/login"],a[href*="auth/login"],button').count();
   step(`${slug} loads with content (${name})`,resp.status()===200&&settled&&landmark>0,{status:resp.status(),settled,landmarks:landmark});
  }
  const fit=await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);step(`no horizontal overflow (${name})`,fit);
  step(`no page errors (${name})`,errors.length===0,{errors});await context.close();
 }
}finally{await browser.close();}
receipt.finished=new Date().toISOString();receipt.ok=receipt.steps.every(x=>x.ok);writeFileSync(`${out}/receipt.json`,JSON.stringify(receipt,null,1)+'\n');
