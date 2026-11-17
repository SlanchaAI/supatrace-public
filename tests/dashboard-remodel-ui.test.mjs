// Rendered acceptance for the warm-paper app. Uses only the synthetic loopback harness.
// Run: PLAYWRIGHT_CHROMIUM_PATH=/path/to/chromium node --test tests/dashboard-remodel-ui.test.mjs
// Optional screenshots: SUPATRACE_DASHBOARD_SCREENSHOT_DIR=/output/directory
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync} from 'node:fs';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';

let browser;
const out = process.env.SUPATRACE_DASHBOARD_SCREENSHOT_DIR;
const captures = [];
if (out) mkdirSync(out, {recursive:true});
before(async () => {browser = await launch();});
after(async () => {
  await browser?.close();
  if (out) writeFileSync(`${out}/manifest.json`, JSON.stringify({source:'synthetic-loopback-fixture',hosted_acceptance:false,captures},null,2));
});
async function capture(page, label, viewport) {
  if (!out) return;
  const file = `${label}-${viewport.width}.png`;
  await page.screenshot({path:`${out}/${file}`, fullPage:true});
  captures.push({file, viewport, source:'synthetic-loopback-fixture'});
}
async function fits(page, label) {
  const result = await page.evaluate(() => ({width:document.documentElement.scrollWidth,inner:innerWidth}));
  assert.ok(result.width <= result.inner, `${label} horizontal overflow: ${result.width}/${result.inner}`);
}
async function nav(page, view) {
  const toggle = page.locator('#menu-toggle');
  if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await page.locator(`#rail a[data-nav="${view}"]`).click();
  await page.locator(`#view-${view}:not([hidden])`).waitFor();
}
for (const viewport of [{width:1280,height:800},{width:390,height:844},{width:320,height:740}]) {
  test(`warm-paper app remains usable at ${viewport.width}px`, {timeout:60000}, async () => {
    const live = await start();
    const context = await browser.newContext({viewport, acceptDownloads:true});
    await context.route(/^(?!http:\/\/127\.0\.0\.1)/, route => route.abort());
    const errors = [];
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(String(error)));
    try {
      await page.goto(live.origin + '/app/', {waitUntil:'networkidle'});
      await page.locator('#signin:not([hidden])').waitFor();
      assert.equal(await page.locator('body').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(246, 243, 232)');
      assert.equal(await page.getByRole('link',{name:'Continue with GitHub',exact:true}).evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(35, 41, 34)');
      await fits(page, 'signed out');
      await capture(page,'signed-out',viewport);
      const tenant = await live.signIn(context);
      await live.seedRuns(tenant,3);
      // Real provider namespaces contain long, unbroken IDs. Short run-001
      // fixtures alone cannot detect the whole-page overflow seen in production.
      const longIds = ['lf-result.' + 'a'.repeat(88), 'wv.' + 'b'.repeat(93), 'lf.' + 'c'.repeat(93)];
      const writeKey = await live.writeKey(tenant);
      for (const [index,runId] of longIds.entries()) await live.upload(writeKey, {
        version:1, batch_id:'responsive-' + index, run_id:runId,
        events:[{id:'responsive-event-' + index,time:new Date(Date.now() + index * 1000).toISOString(),kind:'note',name:'Synthetic responsive fixture',data:{synthetic:true}}]
      });
      await page.reload({waitUntil:'networkidle'});
      await page.waitForFunction(() => !/Checking/.test(document.getElementById('usage').textContent));
      await page.locator('#recent .run').first().waitFor();
      assert.equal(await page.locator('#recent .run>span:first-child').count(),5);
      assert.equal(await page.locator('#recent').evaluate((node,ids) => ids.every(id => [...node.querySelectorAll('button>span:first-child')].some(span => span.textContent === id)),longIds),true,'long IDs retain their full accessible text');
      await fits(page,'home with long provider IDs');
      assert.equal(await page.locator('#recent .run>span:first-child').first().evaluate(node => getComputedStyle(node).textOverflow),'ellipsis');
      const cardHeights = await page.locator('#view-home .cards>.card').evaluateAll(nodes => nodes.filter(n => !n.hidden).map(n => n.getBoundingClientRect().height));
      assert.ok(cardHeights[0] < cardHeights[2] && cardHeights[1] < cardHeights[2], 'Storage and Plan cards are not stretched by the trace list');
      assert.equal(await page.locator('#first-trace').isVisible(), false, 'existing accounts do not get a forced onboarding block');
      if (viewport.width > 800) {
        assert.equal(await page.locator('#rail a[data-nav="traces"] span').evaluate(node => getComputedStyle(node).opacity), '1');
        assert.equal(await page.locator('#rail a[data-nav="traces"] span').evaluate(node => getComputedStyle(node).position), 'static');
      } else {
        await page.locator('#menu-toggle').click();
        assert.equal(await page.locator('#menu-toggle').getAttribute('aria-expanded'),'true');
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#menu-toggle').getAttribute('aria-expanded'),'false');
        assert.equal(await page.locator('#menu-toggle').evaluate(node => node === document.activeElement),true);
      }
      for (const view of ['home','traces','agents','keys','usage','billing','members','audit','settings']) {
        await nav(page,view);
        await fits(page,view);
        await capture(page,view,viewport);
      }
      await nav(page,'agents');
      assert.equal(await page.locator('#import-start').isDisabled(),true);
      assert.match(await page.locator('#import-start-reason').innerText(),/Review an import plan with an exact trace/);
      await page.locator('#import-plan-button').click();
      assert.match(await page.locator('#import-result').innerText(),/Source project ID.*Exact source environment.*Import namespace.*From.*To/);
      for(const provider of ['langsmith','braintrust']){await page.locator('#'+provider+'-form button[type=submit]').click();assert.match(await page.locator('#'+provider+'-status').innerText(),/Source project UUID.*Stable import namespace.*Completed/);}
      await nav(page,'settings');assert.equal(await page.locator('#create-project input').getAttribute('placeholder'),'My project');assert.equal(await page.locator('#create-project').getByLabel('Project name').count(),1);await nav(page,'agents');
      // Exercise both the initial status and real planner JSON with long IDs.
      // This synthetic plan performs no provider/credential/upload action.
      const sourceProject='synthetic-'+ 'p'.repeat(100),environment='synthetic-'+ 'e'.repeat(100);
      await page.fill('#import-source',sourceProject);await page.fill('#import-environment',environment);
      await page.fill('#import-namespace','synthetic-'+ 'n'.repeat(100));
      await page.fill('#import-from','2026-10-01T00:00');await page.fill('#import-to','2026-10-02T00:00');
      await page.locator('#import-plan-button').click();
      await page.locator('#import-result').filter({hasText:'planned_not_authorized_not_started'}).waitFor();
      const plan=JSON.parse(await page.locator('#import-result').textContent());
      assert.equal(plan.scope.sourceProject,sourceProject);assert.equal(plan.scope.environment,environment);
      assert.deepEqual(plan.side_effects,{provider_requests:0,credential_reads:0,staged_batches:0,uploaded_batches:0,persisted_jobs:0});
      assert.equal(await page.locator('#import-result').evaluate(node=>getComputedStyle(node).whiteSpace),'pre-wrap');
      const outside=await page.locator('#import-form').evaluate(form=>{const box=form.getBoundingClientRect();return [...form.querySelectorAll('label,input,select,button')].filter(node=>{const item=node.getBoundingClientRect();return item.left<box.left-1||item.right>box.right+1;}).map(node=>node.id||node.tagName);});
      assert.deepEqual(outside,[],'import fields and controls remain within the form');
      await fits(page,'agents with long import plan');await capture(page,'agents-import-plan',viewport);
      await page.fill('#import-source','changed-synthetic-source');await fits(page,'agents changed import scope');
      await nav(page,'usage');
      assert.equal(await page.locator('#commercial-selector').isVisible(),false);
      await nav(page,'traces');
      const exportDetails=page.getByText('Export limits and details',{exact:true}).locator('..');assert.equal(await exportDetails.getAttribute('open'),null);assert.match(await exportDetails.textContent(),/20 MiB/);
      await page.locator('#runs .trace-open').first().click();
      await page.locator('#events li').first().waitFor();
      await fits(page,'trace detail');
      await capture(page,'trace-detail',viewport);
      await page.locator('#close-detail').click();
      assert.equal(await page.locator('#detail').isVisible(),false);
      assert.equal(await page.locator('#list').isVisible(),true);
      await nav(page,'home');
      await nav(page,'traces');
      assert.equal(await page.locator('#detail').isVisible(),false,'repeated navigation stays closed');
      assert.deepEqual(errors,[]);
    } finally {await context.close();await live.close();}
  });
}

for (const viewport of [{width:1280,height:900},{width:390,height:844},{width:320,height:740}]) {
  test(`classic S is visible and does not disturb navigation at ${viewport.width}px`, {timeout:60000}, async () => {
    const live = await start();
    const context = await browser.newContext({viewport});
    await context.route(/^(?!http:\/\/127\.0\.0\.1)/, route => route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.addInitScript(() => {window.__logoCsp = [];document.addEventListener('securitypolicyviolation', event => window.__logoCsp.push(event.violatedDirective));});
    try {
      await page.goto(live.origin + '/', {waitUntil:'networkidle'});
      const logo = page.locator('.wordmark .brand-mark');
      assert.equal(await logo.isVisible(), true);
      assert.equal(await logo.evaluate(node => node.complete && node.naturalHeight > 0), true);
      const box = await logo.boundingBox();
      assert.ok(box.width >= 20 && box.height >= 37, 'the mark has a visible, unsquashed size');
      const wordmark = await page.locator('.wordmark').boundingBox(), nav = await page.locator('.site-header nav').boundingBox();
      assert.ok(wordmark.x + wordmark.width <= nav.x, 'logo and navigation do not overlap');
      await fits(page, 'landing with classic S');
      assert.equal(await page.getByRole('link', {name:'SupaTrace home',exact:true}).count(), 1);
      await capture(page, 'classic-s-landing', viewport);
      assert.deepEqual(await page.evaluate(() => window.__logoCsp), [], 'landing assets obey CSP before navigation');
      await page.getByRole('link', {name:'Get started',exact:true}).click();
      assert.equal(new URL(page.url()).hash, '#signin');
      await page.getByRole('link', {name:'SupaTrace home',exact:true}).click();
      assert.equal(new URL(page.url()).hash, '');
      await page.goBack();
      await page.waitForURL(url => url.hash === '#signin');
      assert.equal(new URL(page.url()).hash, '#signin');
      assert.deepEqual(await page.evaluate(() => window.__logoCsp), [], 'returned landing document obeys CSP');
      await live.signIn(context);
      await page.goto(live.origin + '/app/', {waitUntil:'networkidle'});
      await page.locator('#shell:not([hidden])').waitFor();
      const mobile = viewport.width <= 800;
      if (mobile) await page.locator('#menu-toggle').click();
      const appLogo = page.locator('#rail .mark img');
      assert.equal(await appLogo.isVisible(), true);
      assert.equal(await appLogo.evaluate(node => node.complete && node.naturalHeight > 0), true);
      await fits(page, 'workspace with classic S');
      await capture(page, 'classic-s-workspace', viewport);
      if (mobile) {
        await page.locator('#close-menu').click();
        // Off-canvas CSS leaves a box, so isVisible() alone is not a viewport check.
        const closedLogo = await appLogo.boundingBox();
        assert.ok(closedLogo && closedLogo.x + closedLogo.width <= 0, 'closed menu keeps the logo outside the viewport');
        assert.equal(await page.locator('#rail').evaluate(node => node.inert), true);
        assert.equal(await page.locator('#menu-toggle').getAttribute('aria-expanded'), 'false');
        await page.locator('#menu-toggle').click();
        const reopenedLogo = await appLogo.boundingBox();
        assert.ok(reopenedLogo && reopenedLogo.x >= 0 && reopenedLogo.x + reopenedLogo.width <= viewport.width, 'reopened logo fits the viewport');
        assert.equal(await page.locator('#rail').evaluate(node => node.inert), false);
      }
      await page.locator('#rail .mark').click();
      assert.equal(new URL(page.url()).hash, '#home');
      assert.deepEqual(await page.evaluate(() => window.__logoCsp), []);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
      await live.close();
    }
  });
}
