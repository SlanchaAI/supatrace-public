import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';

let browser, live;
before(async () => { browser = await launch(); live = await start({google: true, dashboard: true}); });
after(async () => { await browser?.close(); await live?.close(); });
const fits = async page => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), page.url());
const luminance = color => {
  const channels = color.match(/\d+/g).slice(0, 3).map(value => {
    const channel = Number(value) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels.reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
};

async function passwordFits(page, id) {
  const input = page.locator('#' + id), reveal = input.locator('..').getByRole('button');
  const field = await input.boundingBox(), toggle = await reveal.boundingBox();
  assert.ok(toggle.x >= field.x && toggle.x + toggle.width <= field.x + field.width, id + ' reveal inside input');
  assert.ok(toggle.y >= field.y && toggle.y + toggle.height <= field.y + field.height, id + ' reveal vertically inside');
  assert.ok(Number.parseFloat(await input.evaluate(node => getComputedStyle(node).paddingRight)) >= toggle.width + 8);
  const submit = await input.locator('xpath=ancestor::form').locator('button[type=submit]').boundingBox();
  assert.ok(submit.y >= field.y + field.height + 8, 'submit clears password field');
  await input.focus();
  await page.keyboard.press('Tab');
  assert.equal(await reveal.evaluate(node => node === document.activeElement), true, 'reveal follows password in keyboard order');
  await page.keyboard.press('Enter');
  assert.equal(await input.getAttribute('type'), 'text');
  assert.equal(await reveal.getAttribute('aria-label'), 'Hide password');
  await page.keyboard.press('Enter');
  assert.equal(await input.getAttribute('type'), 'password');
  assert.equal(await reveal.getAttribute('aria-label'), 'Show password');
}

for (const viewport of [{width: 1440, height: 900}, {width: 390, height: 844}]) {
  test(`sign-in providers and password controls stay separate at ${viewport.width}`, {timeout: 60000}, async () => {
    const context = await browser.newContext({viewport});
    await context.route(/^(?!http:\/\/127\.0\.0\.1)/, route => route.abort());
    const page = await context.newPage();
    try {
      for (const path of ['/', '/app/']) {
        await page.goto(live.origin + path, {waitUntil: 'networkidle'});
        await page.locator('#google').waitFor();
        assert.equal(await page.locator('[data-view=main] h2').innerText(), 'Sign in');
        await page.getByRole('button', {name: 'Use a password instead'}).click();
        const emailColors = await page.locator('#email').evaluate(node => [getComputedStyle(node, '::placeholder').color, getComputedStyle(node).backgroundColor]);
        const levels = emailColors.map(luminance).sort((a, b) => b - a);
        assert.ok((levels[0] + 0.05) / (levels[1] + 0.05) >= 4.5, 'email placeholder meets text contrast');
        const choices = page.locator('[data-view=main] .choice');
        let bottom;
        for (const choice of await choices.all()) {
          const box = await choice.boundingBox();
          if (bottom !== undefined) assert.ok(box.y - bottom >= 12, '12px provider gap');
          bottom = box.y + box.height;
          const style = await choice.evaluate(node => { const s = getComputedStyle(node); return {background: s.backgroundColor, border: s.borderTopWidth, kind: s.borderTopStyle}; });
          assert.equal(style.border, '1px');
          assert.equal(style.kind, 'solid');
          assert.equal(style.background, await choice.getAttribute('id') === 'github' ? 'rgb(35, 41, 34)' : 'rgb(255, 253, 245)');
        }
        assert.equal(await page.locator('#sign-in-form button[type=submit]').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(255, 253, 245)');
        await passwordFits(page, 'password');
        await fits(page);
        await page.getByRole('button', {name: 'Create a free account', exact: true}).click();
        assert.equal(await page.locator('[data-view=signup] h2').innerText(), 'Create a free account');
        await page.getByRole('button', {name: 'Use a password instead'}).click();
        await passwordFits(page, 'signup-password');
        await fits(page);
        await page.locator('[data-view=signup] .switch button').click();
        await page.getByRole('button', {name: 'Forgot password?'}).click();
        await page.route('**/api/auth/email/reset**', route => route.fulfill({status: 204, body: ''}));
        await page.locator('#forgot-email').fill('visitor@example.com');
        await page.getByRole('button', {name: 'Send reset code', exact: true}).click();
        await page.locator('#reset-code').fill('000000');
        await page.getByRole('button', {name: 'Confirm reset code', exact: true}).click();
        await page.locator('#new-password').waitFor();
        await passwordFits(page, 'new-password');
        await fits(page);
      }
    } finally { await context.close(); }
  });

  test(`public comparison and docs scroll locally at ${viewport.width}`, {timeout: 60000}, async () => {
    const context = await browser.newContext({viewport});
    const page = await context.newPage();
    try {
      for (const path of ['/', '/pricing/', '/docs/', '/docs/quickstart/', '/docs/limits/']) {
        await page.goto(live.origin + path, {waitUntil: 'networkidle'});
        await fits(page);
        if (path === '/pricing/') {
          assert.equal(await page.locator('.compare-cards').isVisible(), viewport.width < 640);
          assert.equal(await page.locator('.compare-desktop').isVisible(), viewport.width >= 640);
          assert.deepEqual(await page.locator('.compare-card h3').allTextContents(), ['Free', 'Base', 'Pro', 'Enterprise']);
          assert.deepEqual(await page.locator('.compare-card dd').allTextContents(), await page.locator('.compare-desktop tbody td').evaluateAll(cells => {
            const rows = [...new Set(cells.map(cell => cell.parentElement))];
            return [0, 1, 2, 3].flatMap(index => rows.map(row => row.querySelectorAll('td')[index].textContent));
          }));
        }
        if (path.startsWith('/docs/')) {
          const regions = page.locator('main pre, main .table-scroll');
          assert.ok(await regions.count() > 0);
          for (const region of await regions.all()) {
            assert.equal(await region.getAttribute('tabindex'), '0');
            assert.equal(await region.getAttribute('role'), 'region');
            assert.match(await region.getAttribute('aria-label'), /scroll horizontally/);
            const style = await region.evaluate(node => { const s = getComputedStyle(node); return {overflow: s.overflowX, cue: s.backgroundImage, width: node.clientWidth, scroll: node.scrollWidth}; });
            assert.equal(style.overflow, 'auto');
            assert.match(style.cue, /linear-gradient/);
            if (style.scroll > style.width) {
              await region.focus();
              await page.keyboard.press('ArrowRight');
              await page.waitForFunction(() => document.activeElement.scrollLeft > 0);
              assert.ok(await region.evaluate(node => node.scrollLeft > 0));
            }
          }
          if (path === '/docs/quickstart/') {
            await page.locator('main a[href="/agent-setup.html"]').first().click();
            await page.waitForURL(live.origin + '/agent-setup.html');
            for (const name of ['connect.py', 'upload.py', 'claude_snapshot.py', 'claude_hook.py']) {
              const link = page.locator(`a[download][href="/agent/${name}"]`);
              assert.equal(await link.count(), 1, name + ' download is reachable from quickstart instructions');
              assert.equal((await page.request.get(live.origin + await link.getAttribute('href'))).status(), 200);
            }
          }
        }
      }
    } finally { await context.close(); }
  });
}

for(const width of [1440,390])test(`authenticated chrome hides IDs and updates page titles at ${width}`,async()=>{
 const context=await browser.newContext({viewport:{width,height:900},permissions:['clipboard-read','clipboard-write']}),page=await context.newPage();
 try{
  const tenant=await live.signIn(context);
  await page.goto(live.origin+'/app/#settings',{waitUntil:'networkidle'});
  assert.equal(await page.locator('#provider-line').textContent(),'Sign-in provider: GitHub');
  assert.equal(await page.locator('#who').textContent(),'Signed in with GitHub');
  assert.doesNotMatch(await page.locator('.top').innerText(),/github-|proj_/);
  await page.locator('#copy-account-id').click();assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),tenant);
  const project=await page.evaluate(()=>document.documentElement.dataset.project);
  await page.locator('#copy-project-id').click();assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),project);
  for(const [route,title] of Object.entries({home:'Home',traces:'Traces',agents:'Agents',keys:'API keys',usage:'Usage',billing:'Billing',members:'Members',audit:'Home',integrations:'Agents',logs:'Traces',settings:'Settings'})){
   await page.evaluate(route=>location.hash=route,route);await page.waitForFunction(title=>document.title===title+' · SupaTrace',title);await fits(page);
  }
  for(const id of ['workspace-select','project-select','environment-select']){
   const fit=await page.locator('#'+id).evaluate(select=>{const ctx=document.createElement('canvas').getContext('2d'),style=getComputedStyle(select);ctx.font=style.font;return {text:select.selectedOptions[0].textContent,width:select.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)-20,textWidth:ctx.measureText(select.selectedOptions[0].textContent).width};});
   assert.ok(fit.width>=fit.textWidth,id+' '+JSON.stringify(fit));
  }
  const toggle=page.locator('#menu-toggle');if(await toggle.isVisible())await toggle.click();
  const org=await page.locator('#org-select').evaluate(select=>{const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d'),style=getComputedStyle(select);ctx.font=style.font;return {text:select.selectedOptions[0].textContent,width:select.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)-20,textWidth:ctx.measureText(select.selectedOptions[0].textContent).width};});
  assert.equal(org.text,'Personal workspace');assert.ok(org.width>=org.textWidth,JSON.stringify(org));
 }finally{await context.close();}
});
