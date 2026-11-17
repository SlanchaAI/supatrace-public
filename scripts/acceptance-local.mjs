// Operator-free acceptance on the real handlers with loopback AWS/Stripe adapters.
// Usage: node scripts/acceptance-local.mjs [outdir]   (default test-artifacts/local)
// J1: fresh sign-in -> empty state -> key + first upload -> trace visible -> detail.
// Billing: the Billing view at desktop and narrow widths (skipped, and recorded as skipped, if the build has no Billing nav).
// Writes screenshots plus receipt.json. Synthetic loopback only; this is not hosted acceptance.
import {mkdirSync,writeFileSync} from 'node:fs';
import {start} from '../tests/harness.mjs';
import {launch} from '../tests/browser.mjs';
import {checkImportReceipt} from './acceptance-j3.mjs';
const out=process.argv[2]||'test-artifacts/local';mkdirSync(out,{recursive:true});
const receipt={source:'synthetic-loopback',started:new Date().toISOString(),steps:[]};
const step=(name,ok,detail={})=>{receipt.steps.push({name,ok,...detail});console.log((ok?'PASS ':'FAIL ')+name);if(!ok)process.exitCode=1;};
const j3Path=process.env.SUPATRACE_IMPORT_RECEIPT||'test-artifacts/langfuse-local/receipt.json';
const j3=checkImportReceipt(j3Path);step(j3.name,j3.ok,j3.ok?{kind:j3.kind,events:j3.events,path:j3.path}:{reason:j3.reason,path:j3Path});
const live=await start({google:true}),browser=await launch();
try{
 for(const [label,viewport] of [['desktop',{width:1280,height:800}],['narrow',{width:390,height:844}]]){
  const context=await browser.newContext({viewport});await context.route(/^(?!http:\/\/127\.0\.0\.1)/,r=>r.abort());
  const tenant=await live.signIn(context,label==='desktop'?7101:7102),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));
  const nav=async name=>{const t=page.locator('#menu-toggle');if(await t.isVisible()&&await t.getAttribute('aria-expanded')!=='true')await t.click();await page.locator(`#rail a[data-nav="${name}"]`).click();await page.locator(`#view-${name}:not([hidden])`).waitFor();};
  await page.goto(live.origin+'/app/',{waitUntil:'networkidle'});
  await page.waitForFunction(()=>!/Checking/.test(document.getElementById('usage').textContent));
  await nav('traces');
  await page.waitForFunction(()=>/No traces yet/.test(document.getElementById('runs').textContent));
  await page.screenshot({path:`${out}/j1-1-empty-${label}.png`,fullPage:true});step(`J1 empty state (${label})`,true);
  const key=await live.writeKey(tenant);
  await live.upload(key,{version:1,batch_id:'acc-b1',run_id:'acc-run',events:[{id:'e1',time:new Date().toISOString(),kind:'request',name:'First trace',data:{text:'hello'}},{id:'e2',time:new Date().toISOString(),kind:'tool_call',name:'Read file',data:{ok:true}}]});
  await page.reload({waitUntil:'networkidle'});await nav('traces');
  await page.waitForSelector('#runs .run',{timeout:10000});
  await page.screenshot({path:`${out}/j1-2-first-trace-${label}.png`,fullPage:true});step(`J1 first trace visible (${label})`,true);
  await page.locator('#runs .run').first().click();await page.waitForSelector('#events li');
  const n=await page.locator('#events li').count();await page.screenshot({path:`${out}/j1-3-detail-${label}.png`,fullPage:true});step(`J1 detail shows 2 events (${label})`,n===2,{events:n});
  const hasBilling=await page.locator('#rail a[data-nav="billing"]').count();
  if(hasBilling){await nav('billing');await page.waitForTimeout(500);const fit=await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);await page.screenshot({path:`${out}/billing-${label}.png`,fullPage:true});step(`Billing view fits (${label})`,fit);}
  else step(`Billing view (${label})`,true,{skipped:'no billing nav in this build (needs #69)'});
  step(`no page errors (${label})`,errors.length===0,{errors});
  await context.close();
 }
}finally{await browser.close();await live.close();}
receipt.finished=new Date().toISOString();writeFileSync(`${out}/receipt.json`,JSON.stringify(receipt,null,1)+'\n');
