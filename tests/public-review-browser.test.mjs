import test from 'node:test';
import assert from 'node:assert/strict';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';
for(const width of [1440,390]) test(`public hero and live-first integrations at ${width}`,async()=>{
 const live=await start(),browser=await launch();
 try {
 const page=await browser.newPage({viewport:{width,height:900}});
 await page.goto(live.origin+'/',{waitUntil:'networkidle'});
 assert.equal(await page.locator('.hero h1').innerText().then(v=>v.replace(/\s+/g,' ')),'Agent traces. Kept simple.');
 assert.equal(await page.locator('.hero .intro').innerText(),'See every step your agent took.');
 assert.equal(await page.locator('.hero a').allTextContents().then(v=>v.join('|')),'Sign in|See docs');
 assert.equal(await page.locator('.product-shot img').getAttribute('alt'),'A SupaTrace trace page showing one run and its steps.');
 assert.equal(await page.locator('.product-shot img').evaluate(img=>img.complete&&img.naturalWidth===1200),true);
 assert.ok(await page.locator('#signin').isVisible());
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.goto(live.origin+'/integrations/',{waitUntil:'networkidle'});
 assert.equal(await page.locator('main h1').innerText(),'What works with SupaTrace.');
 assert.equal(await page.locator('section[aria-labelledby=integrations-live] .tile').count(),2);
 assert.deepEqual(await page.locator('section[aria-labelledby=integrations-beta] .tile h3').allTextContents(),['LangChain','LlamaIndex','OpenAI (Python)','Anthropic','Langfuse SDKs','Langfuse import','Claude Code hooks']);
 assert.equal(await page.locator('details').count(),1);
 assert.equal(await page.locator('details').evaluate(n=>n.open),false);
 await page.locator('summary').click();
 assert.equal(await page.locator('details li').count(),3);
 for(const href of await page.locator('main a').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('href'))))assert.equal((await page.request.get(live.origin+href)).status(),200,href);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 } finally {await browser.close();await live.close();}
});
