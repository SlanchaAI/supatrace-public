import test from 'node:test';
import assert from 'node:assert/strict';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';
for(const width of [1280,320])test('file import command stays local, clears on edit and fits '+width,async()=>{
 const live=await start(),browser=await launch(),context=await browser.newContext({viewport:{width,height:800}});
 await context.route(/^(?!http:\/\/127\.0\.0\.1)/,r=>r.abort());
 const page=await context.newPage(),errors=[],api=[];
 page.on('pageerror',e=>errors.push(String(e)));page.on('request',r=>{if(r.url().includes('/api/'))api.push(r.url());});
 try{
  await page.goto(live.origin+'/agent-setup.html#file-imports');
  await page.selectOption('#file-format','otlp');await page.fill('#file-source',"/private/reviewed' file.json");await page.fill('#file-namespace','source-one');await page.fill('#file-project','proj_'+'a'.repeat(32));await page.fill('#file-directory','/private/job');
  assert.equal(await page.isChecked('#file-content'),false);await page.getByRole('button',{name:'Prepare staging command'}).click();
  const command=await page.locator('#file-import-command').textContent();assert.match(command,/'otlp'/);assert.equal(command.includes('--include-content'),false);await page.getByText('Staging command ready.',{exact:false}).waitFor();
  await page.check('#file-content');assert.equal(await page.locator('#file-import-command').isHidden(),true);
  await page.getByRole('button',{name:'Prepare staging command'}).click();assert.match(await page.locator('#file-import-command').textContent(),/--include-content/);
  await page.fill('#file-project','proj_wrong');assert.equal(await page.locator('#file-import-command').textContent(),'');await page.getByRole('button',{name:'Prepare staging command'}).click();await page.getByText('Copy the complete destination project ID from Agents.',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(api,[]);assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>localStorage.length),0);
 }finally{await context.close();await browser.close();await live.close();}
});
