// Browser walks of the landing page and /app/ against the live handler.
// playwright-core is a devDependency. The unit suite stays on `npm test`; this file is `npm run test:ui`.
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {readFileSync, readdirSync} from 'node:fs';
import {inflateRawSync} from 'node:zlib';
import {start, CSP} from './harness.mjs';
import {launch} from './browser.mjs';
import {oktaResponse} from './saml-fixture.mjs';
import {hashPassword, totp} from '../src/dashboard-auth.mjs';

const sizes = {desktop: {width: 1280, height: 800}, mobile: {width: 390, height: 844}};
// Expected HTTP failures Chromium logs as console errors (signed-out 401, 503 preview, 403 origin probe, 429 retry).
const expectedFailure = /^Failed to load resource: the server responded with a status of (401|403|429|503)\b/;
let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });

async function open(live, size, path = '/app/', setup, expectedConsoleFailure = expectedFailure) {
  const context = await browser.newContext({viewport: sizes[size], acceptDownloads: true});
  // No request may leave loopback (e.g. GitHub OAuth, supatrace.dev).
  await context.route(/^(?!http:\/\/127\.0\.0\.1)/, route => route.abort());
  await context.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
  });
  const tenant = await setup?.(context);
  const page = await context.newPage();
  const errors = [], requests = [];
  page.on('console', m => { if (m.type() === 'error' && !expectedConsoleFailure.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  page.on('request', r => { if (r.url().includes('/api/')) requests.push(r); });
  await page.goto(live.origin + path, {waitUntil: 'networkidle'});
  return {context, page, errors, requests, tenant,
    async clean() {
      assert.deepEqual(await page.evaluate(() => window.__csp), [], 'CSP violations');
      assert.deepEqual(errors, [], 'console errors');
      await context.close();
    }};
}
const fits = page => page.evaluate(() => ({scroll: document.documentElement.scrollHeight, inner: window.innerHeight}));
async function assertFits(page, label) {
  const {scroll, inner} = await fits(page);
  assert.ok(scroll <= inner, `${label}: page scrolls (${scroll} > ${inner})`);
}
async function assertNoHorizontalOverflow(page,label){const size=await page.evaluate(()=>({width:document.documentElement.scrollWidth,inner:innerWidth}));assert.ok(size.width<=size.inner,label+' has horizontal overflow');}
async function assertSignInPanelFits(page,label){await page.locator('#signin').scrollIntoViewIfNeeded();const box=await page.locator('#signin').boundingBox();assert.ok(box&&box.height<=page.viewportSize().height,label+' panel exceeds the viewport');await assertNoHorizontalOverflow(page,label);}
async function signedIn(live, size, runs) {
  return open(live, size, '/app/', async context => {
    const tenant = await live.signIn(context);
    if (runs) await live.seedRuns(tenant, runs);
    return tenant;
  });
}
// These assertions target the bounded Blob fallback, not the native Save File path.
async function useBlobExport(page) { await page.evaluate(() => Object.defineProperty(window,'showSaveFilePicker',{value:undefined,configurable:true})); }
const settle = page => page.waitForFunction(() => !/Checking/.test(document.getElementById('usage').textContent));
async function nav(page, name) {
  const link = page.locator(`#rail a[data-nav="${name}"]`);
  const toggle=page.locator('#menu-toggle');
  if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded')!=='true') await toggle.click();
  await link.click();
  await page.locator(`#view-${name}:not([hidden])`).waitFor();
  assert.equal(await link.getAttribute('aria-current'),'page');
}

test('static pages keep the CSP-safe shape', () => {
  const template = readFileSync(new URL('../aws/template.yaml', import.meta.url), 'utf8');
  assert.ok(template.includes(`ContentSecurityPolicy: "${CSP}"`), 'harness CSP matches the deployed template');
  const files = ['index.html', 'agent-setup.html', 'app/index.html'].map(f => readFileSync(new URL('../public/' + f, import.meta.url), 'utf8'));
  for (const html of files) {
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)(?!\s+type="application\/ld\+json">)/i, 'no inline scripts (JSON-LD data blocks are not executed)');
    assert.doesNotMatch(html, /<style|\sstyle=|\son[a-z]+=/i, 'no inline styles or handlers');
  }
  const js = readFileSync(new URL('../public/app/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(js, /\.style\b|innerHTML|setAttribute\('style'/, 'app.js sets no inline styles');
  assert.deepEqual(readdirSync(new URL('../agent/', import.meta.url)).filter(name => name.endsWith('.py')).sort(), ['claude_hook.py', 'claude_snapshot.py', 'connect.py', 'private_upload_runtime.py', 'stage_import.py', 'upload.py']);
});

for (const size of Object.keys(sizes)) {
  test(`landing explains setup and signed-out app fits one screen (${size})`, {timeout: 60000}, async () => {
    const live = await start();
    try {
      const landing = await open(live, size, '/');
      await landing.page.waitForSelector('#github');
      for(const link of await landing.page.getByRole('link',{name:'Terms of Service'}).all())assert.equal(await link.getAttribute('href'),'/terms.html');
      for(const link of await landing.page.getByRole('link',{name:'Privacy Policy'}).all())assert.equal(await link.getAttribute('href'),'/privacy.html');
      assert.equal(await landing.page.getByText(/periodic emails/i).count(), 0);
      await assertNoHorizontalOverflow(landing.page,'landing');
      await landing.page.getByRole('heading',{name:/Agent traces.*Kept simple/s}).waitFor();
      assert.ok((await landing.page.getByRole('link',{name:'Get started'}).boundingBox()).y<sizes[size].height,'first action is above the fold');
      await landing.page.getByText('Explicit JSON batches and reviewed Claude Code snapshots. Opt-in Claude hooks are a beta; no silent scanning.',{exact:true}).waitFor();
      assert.equal(await landing.page.getByText('Synthetic example',{exact:true}).count(),0,'illustrative mock removed from landing');
      await assertSignInPanelFits(landing.page,'landing sign-in');
      const github = landing.page.getByRole('link', {name: 'Continue with GitHub'});
      assert.equal(await github.getAttribute('href'), '/api/auth/login');
      assert.equal(await landing.page.locator('#google').count(), 0);
      assert.equal(await landing.page.getByText('Continue with ChatGPT').count(), 0);
      assert.equal(await landing.page.getByText('Continue with SSO').count(), 0);
      assert.equal(await landing.page.locator('#email').count(), 0);
      assert.match((await landing.page.request.get(live.origin + '/')).headers()['content-security-policy'], /script-src 'self'/);
      for (const path of ['/agent-setup.html', '/agent/connect.py', '/agent/upload.py', '/agent/claude_snapshot.py'])
        assert.equal((await landing.page.request.get(live.origin + path)).status(), 200, path);
      await landing.clean();

      const app = await open(live, size);
      await app.page.waitForSelector('#signin:not([hidden])');
      await app.page.waitForSelector('#github');
      assert.equal(await app.page.locator('#signin a[href="/api/auth/google"]').count(), 0, 'unconfigured Google sign-in is not offered');
      assert.equal(await app.page.locator('#view-settings').isVisible(), false, 'account recovery guidance stays hidden while signed out');
      assert.equal(await app.page.locator('#status').textContent(), '');
      assert.equal(await app.page.locator('#workspace').isVisible(), false);
      assert.equal(await app.page.locator('#menu-toggle').isVisible(), false);
      await assertFits(app.page, '/app/ signed out');
      // The sign-in link starts the real GitHub OAuth redirect.
      const login = await fetch(live.origin + '/api/auth/login', {redirect: 'manual'});
      assert.equal(login.status, 302);
      assert.equal(new URL(login.headers.get('location')).origin, 'https://github.com');
      await app.clean();
    } finally { await live.close(); }
  });

  test(`home, traces, filters, and pages (${size})`, {timeout: 60000}, async () => {
    const live = await start();
    try {
      const s = await signedIn(live, size, 50);
      await settle(s.page);
      await s.page.waitForSelector('#rail a[aria-current="page"]');
      assert.equal(await s.page.locator('#view-home h1').textContent(), 'Home');
      assert.match(await s.page.locator('#usage').textContent(), /bytes reserved/);
      assert.match(await s.page.locator('#account-plan').textContent(), /^Free plan\. Plans and upgrade are at the top of Billing\.$/);
      await nav(s.page, 'traces');
      await s.page.waitForSelector('#runs .run');
      assert.equal(await s.page.locator('#runs .run').count(), 25, 'first page');
      assert.deepEqual(await s.page.locator('#runs .run .id .trace-open').allTextContents(), Array.from({length: 25}, (_, i) => `run-${String(49 - i).padStart(3, '0')}`), 'newest first');
      await s.page.click('#more');
      await s.page.waitForFunction(() => document.querySelector('#runs .run .id .trace-open')?.textContent === 'run-024');
      assert.equal(await s.page.locator('#runs .run').count(), 25);
      await s.page.click('#prev');
      await s.page.waitForFunction(() => document.querySelector('#runs .run .id .trace-open')?.textContent === 'run-049');
      await s.page.fill('#trace-search', 'run-001');
      await s.page.click('#filters button');
      await s.page.waitForFunction(() => document.querySelectorAll('#runs .run').length === 1);
      assert.equal(await s.page.locator('#runs .id .trace-open').textContent(), 'run-001');
      await s.page.fill('#trace-search', '');
      await s.page.fill('#from', '2099-01-01T00:00');
      await s.page.click('#filters button');
      await s.page.waitForFunction(() => /No traces match these filters/.test(document.getElementById('runs').textContent));
      await s.page.fill('#from', '');
      await s.page.click('.sort[data-sort="events"]');
      await s.page.waitForFunction(() => document.querySelector('.sort[data-sort="events"]')?.getAttribute('aria-sort') === 'ascending');
      await s.page.waitForFunction(() => document.querySelector('#runs .run .id .trace-open')?.textContent === 'run-000');
      await s.clean();
    } finally { await live.close(); }
  });

  test(`empty traces (${size})`, {timeout: 60000}, async () => {
    const live = await start();
    try {
      const s = await signedIn(live, size, 0);
      await settle(s.page);
      await nav(s.page, 'traces');
      await s.page.waitForFunction(() => /No traces yet.*setup guide/.test(document.getElementById('runs').textContent));
      await s.clean();
    } finally { await live.close(); }
  });

  test(`open trace, export in accepted order, 429 retry (${size})`, {timeout: 60000}, async () => {
    const live = await start();
    try {
      const s = await signedIn(live, size, 3);
      const key = await live.writeKey(s.tenant);
      await nav(s.page, 'traces');
      const ev = (id, n) => ({id, time: `2026-10-24T18:00:0${n}Z`, kind: 'note', name: 'event ' + id, data: {n}});
      await live.upload(key, {version: 1, batch_id: 'b1', run_id: 'run-order', events: [ev('e1', 1), ev('e2', 2)]});
      await live.upload(key, {version: 1, batch_id: 'b2', run_id: 'run-order', events: [ev('e3', 3), ev('e4', 4)]});
      await s.page.click('#refresh');
      await s.page.locator('#runs .run', {hasText: 'run-order'}).click();
      await s.page.waitForSelector('#events li');
      assert.equal(await s.page.locator('#run-title').textContent(), 'run-order');
      assert.equal(await s.page.locator('#export').getAttribute('aria-describedby'),'export-hint');
      assert.match(await s.page.locator('#export-hint').textContent(),/not redacted.*may contain secrets.*Review the complete file.*not original uploaded batch bytes/);
      assert.equal(await s.page.locator('#export-hint').isVisible(),true);
      await assertNoHorizontalOverflow(s.page,'original export warning');
      assert.deepEqual(await s.page.locator('#events .name').allTextContents(), ['event e1', 'event e2']);
      assert.match(await s.page.locator('#events-note').textContent(), /Showing 2 events\. More batches are available\./);
      assert.equal(await s.page.getByRole('button',{name:'Load next batch',exact:true}).isVisible(),true);
      await s.page.locator('#events summary').first().click();
      assert.match(await s.page.locator('#events pre').first().textContent(), /"id": "e1"/);
      if (size === 'mobile') assert.equal(await s.page.locator('#list').isVisible(), false, 'detail replaces list on mobile');

      await s.page.getByRole('button',{name:'Load next batch',exact:true}).click();
      await s.page.waitForFunction(() => document.getElementById('events-note').textContent === 'All 4 events loaded.');
      assert.deepEqual(await s.page.locator('#events .name').allTextContents(), ['event e1','event e2','event e3','event e4']);
      assert.equal(await s.page.locator('#events-more').isVisible(),false);

      await useBlobExport(s.page);
      live.rateLimitEvents(1);
      const download = s.page.waitForEvent('download');
      await s.page.click('#export');
      await s.page.waitForFunction(() => /Export paused by the request limit/.test(document.getElementById('status').textContent));
      const file = await download;
      assert.equal(file.suggestedFilename(), 'supatrace-run.json');
      const exported = JSON.parse(readFileSync(await file.path(), 'utf8'));
      assert.equal(exported.version, 1);
      assert.equal(exported.run_id, 'run-order');
      assert.deepEqual(exported.events.map(e => e.id), ['e1', 'e2', 'e3', 'e4']);
      await s.page.waitForFunction(() => document.getElementById('status').textContent === 'Export download started. Check your browser downloads to confirm the file was saved.');

      await s.page.click('#close-detail');
      assert.equal(await s.page.locator('#detail').isVisible(), false);
      assert.equal(await s.page.locator('#list').isVisible(), true);
      assert.equal(await s.page.locator('#export-account').getAttribute('aria-describedby'),'account-export-note');
      assert.match(await s.page.locator('#account-export-note').textContent(),/not redacted.*may contain secrets.*per-trace redaction does not apply.*not original uploaded batch bytes/);
      assert.equal(await s.page.locator('#account-export-note').isVisible(),false);
      await s.page.getByText('Export limits and details',{exact:true}).click();
      assert.equal(await s.page.locator('#account-export-note').isVisible(),true);
      await assertNoHorizontalOverflow(s.page,'account export warning');
      await s.clean();
    } finally { await live.close(); }
  });

  test(`agents, keys, usage, settings, sign out (${size})`, {timeout: 60000}, async () => {
    const live = await start();
    try {
      const s = await signedIn(live, size, 1);
      await settle(s.page);
      assert.equal(await s.page.locator('#menu-toggle').isVisible(), size === 'mobile');
      if(size==='mobile'){const target=await s.page.locator('#menu-toggle').boundingBox();assert.ok(target&&target.width>=44&&target.height>=44,'menu has a 44px touch target');assert.equal(await s.page.locator('#menu-toggle').getByText('Menu',{exact:true}).isVisible(),true);const icon=await s.page.locator('#menu-toggle svg').boundingBox();assert.ok(icon&&icon.width>=16&&icon.height>=16,'menu icon has a visible size');assert.equal(await s.page.locator('#menu-toggle svg').evaluate(node=>getComputedStyle(node).fill),await s.page.locator('#menu-toggle').evaluate(node=>getComputedStyle(node).color),'menu icon follows the visible button color');assert.equal(await s.page.locator('#logout').evaluate(node=>getComputedStyle(node).whiteSpace),'nowrap');await assertNoHorizontalOverflow(s.page,'mobile workspace header');}
      await nav(s.page, 'settings');
      assert.equal(await s.page.locator('#mfa-section').isVisible(), false);
      assert.equal(await s.page.locator('#mfa-enroll').isVisible(), false);
      assert.match(await s.page.locator('#account-line').textContent(), /Account ID: github-4242/);
      assert.equal(await s.page.locator('#provider-line').textContent(), 'Sign-in provider: GitHub');
      const project = (await s.page.locator('#project-name').textContent()).split(' · ')[1];
      assert.match(project, /^proj_[a-f0-9]{32}$/);
      assert.match(await s.page.locator('#who').textContent(), /GitHub account · github-4242/);
      await nav(s.page, 'usage');
      assert.match(await s.page.locator('#usage-page').textContent(), /bytes reserved/);
      assert.match(await s.page.locator('#plan-page').textContent(), /^Free plan\. Plans and upgrade are at the top of Billing\.$/);
      await nav(s.page, 'keys');
      await s.page.waitForFunction(() => document.querySelectorAll('#keys .key').length === 1);

      const {user_code} = await live.startSetup();
      await nav(s.page, 'agents');
      await s.page.fill('#code', user_code);
      await s.page.click('#approve button');
      await s.page.waitForFunction(() => /^Approved/.test(document.getElementById('approval').textContent));
      await nav(s.page, 'keys');
      await s.page.waitForFunction(() => document.querySelectorAll('#keys .key').length === 2);
      const approve = s.requests.find(r => r.url().includes('/api/setup/approve'));
      assert.equal(approve.headers()['x-amz-content-sha256'], createHash('sha256').update(approve.postData()).digest('hex'));

      await s.page.locator('#keys .key button').first().click();
      await s.page.waitForFunction(() => document.querySelectorAll('#keys .key button').length === 1);
      assert.match(await s.page.locator('#keys').textContent(), /revoked/);
      const revoke = s.requests.find(r => r.url().includes('/api/keys/revoke'));
      assert.equal(revoke.headers()['x-amz-content-sha256'], createHash('sha256').update(revoke.postData()).digest('hex'));

      // Every project-scoped call carries the active project; me/projects/auth do not.
      for (const r of s.requests) {
        const url = new URL(r.url()), path = url.pathname.slice(5);
        if (/^(usage|runs(?:\/page)?|events|keys(\/revoke)?|setup\/approve|environments|logs|support)$/.test(path)) assert.equal(url.searchParams.get('project'), project, path);
        else if (path === 'entitlements') { if (url.searchParams.has('project')) assert.equal(url.searchParams.get('project'), project, path); } // Organization-wide gates may load before project selection.
        else assert.equal(url.searchParams.has('project'), false, path);
      }
      // A cross-origin POST is still refused by the live Origin check.
      const session = (await s.context.cookies()).find(c => c.name === '__Host-supatrace');
      const forged = await fetch(live.origin + '/api/keys/revoke?project=' + project, {method: 'POST', body: '{"id":"x"}',
        headers: {origin: 'https://evil.example', 'content-type': 'application/json', cookie: `${session.name}=${session.value}`}});
      assert.equal(forged.status, 403);
      assert.equal((await forged.json()).error, 'origin_required');

      if (size === 'mobile') {
        await s.page.click('#menu-toggle');
        assert.equal(await s.page.locator('#menu-toggle').getAttribute('aria-expanded'), 'true');
        await s.page.keyboard.press('Escape');
        assert.equal(await s.page.locator('#rail').evaluate(node => node.classList.contains('open')), false);
      }
      await Promise.all([s.page.waitForURL('**/app/'), s.page.click('#logout')]);
      await s.page.waitForSelector('#signin:not([hidden])');
      assert.equal(await s.page.locator('#workspace').isVisible(), false);
      assert.equal((await s.context.cookies()).some(c => c.name === '__Host-supatrace'), false, 'session cookie cleared');
      await s.clean();
    } finally { await live.close(); }
  });

  test(`email confirmation asks for the password and fits (${size})`, {timeout: 60000}, async () => {
    const live = await start({dashboard: true});
    try {
      const token = 'a'.repeat(43);
      const page = await open(live, size, `/?email=${encodeURIComponent('ada@example.com')}&token=${token}`);
      await page.page.waitForSelector('[data-view="confirm"]:not([hidden])');
      assert.equal(await page.page.locator('#confirm-email').inputValue(), 'ada@example.com');
      assert.equal(await page.page.locator('#confirm-password').count(), 1);
      assert.equal(await page.page.locator('[data-view="main"]').getAttribute('hidden'), '');
      await assertSignInPanelFits(page.page, 'homepage confirmation');
      const compact=await open(live,size,'/app/?email=ada%40example.com&token='+ 't'.repeat(43));await compact.page.waitForSelector('#confirm-password');await assertFits(compact.page,'workspace confirmation');await compact.clean();
      await page.clean();
    } finally { await live.close(); }
  });

  test(`503 service not configured message (${size})`, {timeout: 60000}, async () => {
    const live = await start({enabled: false});
    try {
      const s = await open(live, size);
      await s.page.waitForFunction(() => /not accepting traces/.test(document.getElementById('status').textContent));
      assert.equal(await s.page.locator('#signin').isVisible(), false);
      assert.equal(await s.page.locator('#startup-retry').isEnabled(), true);
      await s.page.locator('#startup-retry').click();
      await s.page.locator('#status').filter({hasText:'not accepting traces'}).waitFor();
      assert.equal(await s.page.locator('#shell').isVisible(), false);
      assert.equal(await s.page.locator('#signin').isVisible(), false);
      await assertFits(s.page, '503');
      await s.clean();
    } finally { await live.close(); }
  });
}

// The OS picker itself is not automatable here. This rendered fixture checks
// the actual click/stream/commit integration with a synthetic writable handle;
// the tests above separately exercise real Blob downloads in a no-picker browser.
for (const size of Object.keys(sizes)) {
  test(`Save File export commits complete data and handles cancellation or disk failure (${size})`, {timeout:60000}, async () => {
    const live=await start();
    try {
      const s=await signedIn(live,size,0),key=await live.writeKey(s.tenant);
      const events=[{id:'saved-a',time:'2026-11-04T00:00:00Z',kind:'note',name:'First',data:{parent:'root',nested:[0,false,null,'café']}},{id:'saved-b',time:'2026-11-04T00:00:01Z',kind:'response',name:'Second',data:{parent:'saved-a',kept:true}}];
      for(let i=0;i<events.length;i++)await live.upload(key,{version:1,batch_id:'save-'+i,run_id:'saved-run',events:[events[i]]});
      await nav(s.page,'traces');await s.page.click('#refresh');await s.page.getByRole('button',{name:'Open trace saved-run',exact:true}).click();await s.page.locator('#events li').first().waitFor();
      let downloads=0;s.page.on('download',()=>downloads++);
      for(const outcome of ['success','cancel','write-failure','close-failure']){
        await s.page.evaluate(outcome=>{
          const state={outcome,chunks:[],picked:0,closed:0,aborted:0,activation:false,options:null,writableOptions:null};window.__saveFixture=state;
          Object.defineProperty(window,'showSaveFilePicker',{configurable:true,value:async options=>{
            state.picked++;state.options=options;state.activation=navigator.userActivation.isActive;
            if(outcome==='cancel')throw new DOMException('Synthetic picker cancellation','AbortError');
            return {createWritable:async options=>{state.writableOptions=options;return {
              write:async chunk=>{if(outcome==='write-failure')throw new Error('Synthetic disk failure');state.chunks.push(chunk);},
              close:async()=>{if(outcome==='close-failure')throw new Error('Synthetic close failure');state.closed++;},
              abort:async()=>{state.aborted++;}
            };}};
          }});
        },outcome);
        const before=s.requests.filter(request=>new URL(request.url()).pathname==='/api/events').length;
        if(outcome==='success')live.rateLimitEvents(1);
        await s.page.click('#export');
        if(outcome==='success')await s.page.waitForFunction(()=>/Export paused by the request limit/.test(document.getElementById('status').textContent));
        await s.page.waitForFunction(()=>!document.getElementById('export').disabled&&document.getElementById('cancel-export').hidden);
        const saved=await s.page.evaluate(()=>window.__saveFixture),status=await s.page.locator('#status').textContent();
        assert.equal(saved.picked,1);assert.equal(saved.activation,true,'picker is opened during the user gesture');assert.equal(saved.options.suggestedName,'supatrace-run.json');assert.equal(downloads,0,'Save File never falls through to a Blob download');
        if(outcome==='success'){
          assert.deepEqual(saved.writableOptions,{keepExistingData:false});assert.equal(saved.closed,1);assert.equal(saved.aborted,0);
          assert.deepEqual(JSON.parse(saved.chunks.join('')),{version:1,run_id:'saved-run',events});assert.equal(status,'Export saved: 2 events.');
          assert.equal(s.requests.filter(request=>new URL(request.url()).pathname==='/api/events').length-before,3,'one retry plus both batches');
        }else{
          assert.equal(saved.closed,0);assert.equal(saved.aborted,outcome==='write-failure'?1:0);assert.doesNotMatch(status,/Export saved|Export complete/);
          assert.match(status,outcome==='cancel'?/Export cancelled before completion/:/could not be confirmed complete/);
          if(outcome!=='close-failure')assert.equal(s.requests.filter(request=>new URL(request.url()).pathname==='/api/events').length,before,'picker cancel/early disk failure sends no export reads');
        }
      }
      await s.clean();
    }finally{await live.close();}
  });
}

for (const size of Object.keys(sizes)) {
  test(`configured sign-in panels fit safely (${size})`, {timeout: 60000}, async () => {
    const live = await start({google: true, dashboard: true});
    try {
      const landing = await open(live, size, '/');
      await landing.page.waitForSelector('#google');
      const choices = ['Continue with GitHub', 'Continue with Google', 'Continue with ChatGPT', 'Continue with SSO'];
      assert.deepEqual(await landing.page.locator('#signin [data-view="main"] .choice').allTextContents(), choices);
      assert.equal(await landing.page.locator('#google').getAttribute('href'), '/api/auth/google');
      assert.equal(await landing.page.locator('#email').isVisible(), true);
      assert.equal(await landing.page.getByRole('button', {name: 'Sign in'}).isVisible(), true);
      assert.equal(await landing.page.getByRole('button', {name: 'Forgot password?'}).isVisible(), true);
      for(const link of await landing.page.getByRole('link',{name:'Terms of Service'}).all())assert.equal(await link.getAttribute('href'),'/terms.html');
      await assertSignInPanelFits(landing.page, 'landing with every configured option');
      await landing.page.getByRole('button', {name: 'Create a free account'}).click();
      await landing.page.waitForSelector('#signup-google');
      assert.deepEqual(await landing.page.locator('#signin [data-view="signup"] .choice').allTextContents(), choices);
      assert.equal(await landing.page.locator('#signup-google').getAttribute('href'), '/api/auth/google');
      await assertSignInPanelFits(landing.page, 'sign up');
      await landing.page.getByRole('button', {name: 'Continue with SSO'}).click();
      await landing.page.getByText('Sign in to your enterprise account').waitFor();
      await assertSignInPanelFits(landing.page, 'sso');
      await landing.clean();
      const app = await open(live, size);
      await app.page.waitForSelector('#google');
      assert.deepEqual(await app.page.locator('#signin [data-view="main"] .choice').allTextContents(), choices);
      await assertFits(app.page, '/app/ with every configured option');
      await app.clean();
    } finally { await live.close(); }
  });
}

test('two-factor controls fit when the switch is on', {timeout: 60000}, async () => {
  const live = await start({mfa: true});
  try {
    const s = await signedIn(live, 'desktop', 1);
    await settle(s.page);
    await nav(s.page,'settings');
    assert.equal(await s.page.locator('#mfa-section').isVisible(), true);
    assert.equal(await s.page.locator('#mfa-enroll').isVisible(), true);
    assert.equal(await s.page.locator('#mfa-disable').isVisible(), false);
    await s.clean();
  } finally { await live.close(); }
});

test('a failed OAuth attempt offers a clean fresh sign-in without retaining callback data',async()=>{
 const live=await start({google:true});
 try{const s=await open(live,'mobile','/app/?auth_error=provider_unavailable&provider=google');await s.page.getByText(/Google sign-in could not finish/).waitFor();assert.match(await s.page.locator('#auth-status').textContent(),/fresh sign-in with Google/);assert.equal(await s.page.locator('#google').getAttribute('href'),'/api/auth/google');assert.equal(new URL(s.page.url()).search,'');await s.clean();}finally{await live.close();}
});

test('the guide downloads and approved synthetic first-trace journey agree',async()=>{
 const live=await start();
 try{const s=await signedIn(live,'desktop',0);await settle(s.page);assert.equal(await s.page.locator('#first-trace').isVisible(),true);await nav(s.page,'agents');
  const project=(await s.page.locator('#project-name').textContent()).split(' · ')[1];assert.match(await s.page.locator('#connect-command').textContent(),new RegExp('--project '+project));
  const guide=await open(live,'mobile','/agent-setup.html');for(const name of ['connect.py','upload.py','claude_snapshot.py','claude_hook.py']){const link=guide.page.locator(`a[download][href="/agent/${name}"]`);assert.equal(await link.count(),1);assert.equal((await guide.page.request.get(live.origin+'/agent/'+name)).status(),200);}await assertNoHorizontalOverflow(guide.page,'setup guide');await guide.clean();
  const key='w'.repeat(43),setup=await live.startSetup(key);await s.page.fill('#code',setup.user_code);await s.page.click('#approve button');await s.page.waitForFunction(()=>/^Approved/.test(document.getElementById('approval').textContent));
  const example=JSON.parse(readFileSync(new URL('../public/examples/first-trace.json',import.meta.url),'utf8'));await live.upload(key,example);await nav(s.page,'traces');await s.page.click('#refresh');await s.page.getByRole('button',{name:'Open trace first-trace-example'}).waitFor();
  const openTrace=s.page.getByRole('button',{name:'Open trace first-trace-example'});await openTrace.focus();await s.page.keyboard.press('Enter');await s.page.waitForSelector('#events li');assert.equal(await s.page.locator('#events li').count(),example.events.length);
  await useBlobExport(s.page);const download=s.page.waitForEvent('download');await s.page.click('#export');const file=await download;const exported=JSON.parse(readFileSync(await file.path(),'utf8'));assert.deepEqual(exported.events,example.events);await s.page.click('#close-detail');assert.equal(await openTrace.evaluate(node=>node===document.activeElement),true);await s.clean();
 }finally{await live.close();}
});

// The run id is the button in the id cell: on Free (7-day retention) every row also carries an "Expires" note there.
test('filters distinguish no matches and newest query wins during a shared catalog refresh',async()=>{
 const live=await start();let releaseOld;
 try{const s=await signedIn(live,'desktop',3);await settle(s.page);await nav(s.page,'traces');await s.page.waitForFunction(()=>document.querySelectorAll('#runs .run').length===3);const oldGate=new Promise(done=>{releaseOld=done;});
  await s.page.route('**/api/runs/page?**',async route=>{const response=await route.fetch();await oldGate;await route.fulfill({response});});
  const requested=s.page.waitForRequest(request=>new URL(request.url()).pathname==='/api/runs/page');await s.page.click('#refresh');await requested;
  await s.page.fill('#trace-search','run-000');await s.page.click('#filters button[type=submit]');
  await s.page.fill('#trace-search','run-002');await s.page.click('#filters button[type=submit]');
  const response=s.page.waitForResponse(response=>new URL(response.url()).pathname==='/api/runs/page');releaseOld();await response;await s.page.waitForFunction(()=>document.querySelectorAll('#runs .run').length===1&&document.querySelector('#runs .id .trace-open')?.textContent==='run-002');
  assert.deepEqual(await s.page.locator('#runs .id .trace-open').allTextContents(),['run-002']);
  await s.page.fill('#trace-search','absent');await s.page.click('#filters button[type=submit]');await s.page.getByText(/No traces match these filters/).waitFor();await s.page.click('#clear-filters');await s.page.waitForFunction(()=>document.querySelectorAll('#runs .run').length===3);await s.clean();
 }finally{releaseOld?.();await live.close();}
});

test('expired keys remain honest and account search includes runs beyond the former800 cutoff',async()=>{
 const live=await start();
 try{const s=await open(live,'desktop','/app/',async context=>{const tenant=await live.signIn(context);await live.seedRuns(tenant,801);await context.route('**/api/keys?**',async route=>{const response=await route.fetch(),body=await response.json();body.keys=body.keys.map(key=>({...key,expires_at:1}));await route.fulfill({response,json:body});});return tenant;});await settle(s.page);await nav(s.page,'keys');await s.page.getByRole('cell',{name:'expired',exact:true}).waitFor();assert.equal(await s.page.getByRole('cell',{name:'active',exact:true}).count(),0);await nav(s.page,'traces');await s.page.waitForFunction(()=>/of 801/.test(document.querySelector('#page-note').textContent));assert.equal(await s.page.locator('#list-limit').isVisible(),false);await s.page.fill('#trace-search','run-800');await s.page.click('#filters button[type=submit]');await s.page.waitForFunction(()=>document.querySelectorAll('#runs .run').length===1&&document.querySelector('#runs .id .trace-open')?.textContent==='run-800');assert.match(await s.page.locator('#page-note').textContent(),/of 1/);await s.clean();
 }finally{await live.close();}
});

test('mobile drawer closes and restores focus across Escape, backdrop, navigation and repeats',async()=>{
 const live=await start();
 try{const s=await signedIn(live,'mobile',1);await settle(s.page);const toggle=s.page.locator('#menu-toggle');
  for(const close of ['escape','button','backdrop']){await toggle.click();assert.equal(await toggle.getAttribute('aria-expanded'),'true');assert.equal(await s.page.locator('#rail').evaluate(node=>node.inert),false);if(close==='escape')await s.page.keyboard.press('Escape');else if(close==='button')await s.page.click('#close-menu');else await s.page.locator('#backdrop').click({position:{x:380,y:400}});assert.equal(await toggle.getAttribute('aria-expanded'),'false');assert.equal(await s.page.locator('#rail').evaluate(node=>node.inert),true);assert.equal(await toggle.evaluate(node=>node===document.activeElement),true);}
  for(const name of ['traces','settings','home','settings']){await nav(s.page,name);assert.equal(await toggle.getAttribute('aria-expanded'),'false');assert.equal(await s.page.locator(`#view-${name} h1`).evaluate(node=>node===document.activeElement),true);}
  await s.page.goBack();await s.page.locator('#view-home:not([hidden])').waitFor();await s.page.goForward();await s.page.locator('#view-settings:not([hidden])').waitFor();await s.clean();
 }finally{await live.close();}
});

test('an IdP form post sends the SSO cookie without the test planting it', {timeout: 60000}, async () => {
  const live = await start({dashboard: true});
  const idp = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const html = `<!doctype html><meta charset="utf-8"><title>Identity provider</title><form method="POST" action="${url.searchParams.get('action')}"><input name="SAMLResponse" value="${url.searchParams.get('saml')}"><input name="RelayState" value="${url.searchParams.get('relay')}"><button type="submit">Continue</button></form>`;
    res.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'});
    res.end(html);
  });
  await new Promise(resolve => idp.listen(0, '127.0.0.1', resolve));
  const context = await browser.newContext({viewport: sizes.desktop});
  await context.route(/^(?!http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$))/, route => route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('console', message => { if (message.type() === 'error' && !expectedFailure.test(message.text())) errors.push(message.text()); });
  page.on('pageerror', error => errors.push(String(error)));
  try {
    await page.goto(live.origin + '/', {waitUntil: 'networkidle'});
    await page.getByRole('button', {name: 'Continue with SSO'}).click();
    await page.fill('#sso-email', 'gavin@hooli.com');
    const started = page.waitForURL(/\/fake\/sso\?/);
    await page.locator('[data-view="sso"] button.primary').click();
    await started;
    const redirect = new URL(page.url());
    const relay = redirect.searchParams.get('RelayState');
    const requestXml = inflateRawSync(Buffer.from(redirect.searchParams.get('SAMLRequest'), 'base64')).toString();
    const requestId = requestXml.match(/\bID="([^"]+)"/)[1];
    const stored = (await context.cookies()).find(item => item.name === 'supatrace-sso');
    assert.ok(stored, 'the browser stored supatrace-sso from the start response');
    assert.equal(stored.sameSite, 'None');
    assert.equal(stored.httpOnly, true);
    assert.equal(stored.secure, true);
    assert.equal(stored.path, '/api/auth/sso/callback');
    const soon = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const xml = oktaResponse({privateKey: live.idp.privateKey, cert: live.idp.cert, requestId, nameId: 'gavin@hooli.com', notBefore: new Date().toISOString(), notOnOrAfter: soon});
    const form = new URL(`http://localhost:${idp.address().port}/`);
    form.searchParams.set('action', live.origin + '/api/auth/sso/callback');
    form.searchParams.set('saml', xml);
    form.searchParams.set('relay', relay);
    await page.goto(form.href);
    await Promise.all([
      page.waitForURL(url => url.origin === live.origin && url.pathname === '/app/'),
      page.getByRole('button', {name: 'Continue'}).click()
    ]);
    await page.waitForSelector('#workspace:not([hidden])');
    assert.match(await page.locator('#who').textContent(), /SSO account · sso-/);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    await new Promise(resolve => idp.close(resolve));
    await live.close();
  }
});

for (const size of Object.keys(sizes)) {
 test(`standard account download reconciles all runs, requires a click and recovers safely (${size})`,{timeout:60000},async()=>{
  const live=await start();
  try{
   const s=await signedIn(live,size,0),key=await live.writeKey(s.tenant),expected={};await settle(s.page);
   for(const [id,count] of [['account-first',2],['account-second',1]]){
    expected[id]=[];for(let i=0;i<count;i++){const e={id:id+'-'+i,time:'2026-11-04T00:00:00Z',kind:'note',name:'Synthetic archive',data:{parent:i?id+'-0':null,nested:[0,false,null,'café','</script><img src=x>']}};expected[id].push(e);await live.upload(key,{version:1,batch_id:id+'-batch-'+i,run_id:id,events:[e]});}
   }
   await useBlobExport(s.page);await nav(s.page,'traces');await s.page.click('#refresh');await s.page.waitForFunction(()=>!document.getElementById('refresh').disabled);
   await s.page.fill('#trace-search','account-first');await s.page.click('#filters button[type=submit]');await s.page.waitForFunction(()=>document.querySelectorAll('#runs .run').length===1);
   let downloads=0;s.page.on('download',()=>downloads++);
   // Rate-limit cancellation discards preparation, then a clean attempt succeeds.
   live.rateLimitEvents(1);await s.page.click('#export-account');await s.page.waitForFunction(()=>document.getElementById('status').textContent.startsWith('Export paused'));await s.page.click('#cancel-account-export');await s.page.locator('#cancel-account-export').waitFor({state:'hidden'});assert.equal(downloads,0);assert.equal(await s.page.locator('#download-account').isVisible(),false);
   await s.page.click('#export-account');await s.page.locator('#download-account').waitFor({state:'visible'});assert.equal(downloads,0);assert.equal(await s.page.locator('#download-account').evaluate(n=>n===document.activeElement),true);assert.match(await s.page.locator('#status').textContent(),/2 traces, 3 events/);await assertNoHorizontalOverflow(s.page,'prepared account download');
   if(size==='mobile'){await s.page.setViewportSize({width:320,height:740});await assertNoHorizontalOverflow(s.page,'prepared account download at 320px');}
   const received=s.page.waitForEvent('download');await s.page.click('#download-account');const file=await received;assert.equal(file.suggestedFilename(),'supatrace-account.json');const archive=JSON.parse(readFileSync(await file.path(),'utf8'));assert.equal(archive.complete,true);assert.equal(archive.run_count,2);assert.equal(archive.event_count,3);assert.equal(archive.consistency,'observed_stable_before_after_not_a_snapshot');for(const run of archive.runs)assert.deepEqual(run.events,expected[run.metadata.id]);assert.equal(downloads,1);assert.match(await s.page.locator('#status').textContent(),/Account download started.*Check your browser downloads/);assert.equal(await s.page.locator('#download-account').isVisible(),false);
   // Preparation is discarded on navigation and is not resurrected by Back.
   await s.page.click('#export-account');await s.page.locator('#download-account').waitFor({state:'visible'});await nav(s.page,'home');await s.page.goBack();await s.page.locator('#view-traces:not([hidden])').waitFor();assert.equal(await s.page.locator('#download-account').isVisible(),false);assert.equal(downloads,1);
   // A changed final catalog never exposes a download, and retry starts fresh.
   let scans=0;const drift=async route=>{const response=await route.fetch(),body=await response.json();if(++scans===2)body.runs[0].event_count++;await route.fulfill({response,json:body});};await s.page.route('**/api/runs/page?**',drift);
   await s.page.click('#export-account');await s.page.waitForFunction(()=>!document.getElementById('export-account').disabled);assert.match(await s.page.locator('#status').textContent(),/account changed|counts did not reconcile/);assert.equal(await s.page.locator('#download-account').isVisible(),false);assert.equal(downloads,1);await s.page.unroute('**/api/runs/page?**',drift);
   await s.page.click('#export-account');await s.page.locator('#download-account').waitFor({state:'visible'});await s.page.click('#discard-account');assert.equal(await s.page.locator('#download-account').isVisible(),false);assert.equal(downloads,1);assert.equal(await s.page.locator('#export-account').evaluate(n=>n===document.activeElement),true);
   await s.clean();
  }finally{await live.close();}
 });
}

test('session capacity failure gives a recoverable sign-in message without a cookie', async () => {
  const live = await start({dashboard: true});
  try {
    await live.store.createVerifiedEmailAccount('session@example.com', hashPassword('Synthetic!123'));
    const original = live.store.createSession.bind(live.store); let attempts = 0;
    live.store.createSession = async () => { attempts++; throw Object.assign(new Error('session_slot_collision'), {code: 'session_slot_collision', status: 409, sessionEpoch: 0}); };
    const view = await open(live, 'mobile', '/app/');
    try {
      await view.page.fill('#email', 'session@example.com'); await view.page.fill('#password', 'Synthetic!123');
      const submit = view.page.getByRole('button', {name: 'Sign in', exact: true});
      await submit.click();
      await view.page.getByText('Sign-in is busy. Please try again shortly.').waitFor();
      assert.equal(attempts, 3); assert.equal(await submit.isEnabled(), true);
      assert.equal((await view.context.cookies()).some(value => value.name === '__Host-supatrace'), false);
      live.store.createSession = original;
      await submit.click(); await view.page.locator('#shell:not([hidden])').waitFor();
      assert.equal((await view.context.cookies()).some(value => value.name === '__Host-supatrace'), true);
      await view.clean();
    } catch (error) { await view.context.close(); throw error; }
  } finally { await live.close(); }
});

test('password reset rejects pending MFA and the browser can start a fresh sign-in', async () => {
  const live = await start({dashboard: true, mfa: true});
  const email = 'epoch-browser@example.com', secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const tenantId = 'email-' + createHash('sha256').update(email).digest('hex');
  try {
    await live.store.createVerifiedEmailAccount(email, hashPassword('Old!12345'));
    await live.store.setTenantFields(tenantId, 'SET mfa_secret = :secret', {':secret': secret});
    // This test deliberately produces session_changed (409); other browser tests retain their error filter.
    const view = await open(live, 'mobile', '/app/', undefined, /^Failed to load resource: the server responded with a status of (401|409)\b/);
    try {
      await view.page.fill('#email', email); await view.page.fill('#password', 'Old!12345');
      await view.page.getByRole('button', {name: 'Sign in', exact: true}).click();
      await view.page.locator('#mfa-code').waitFor({state: 'visible'});
      const staleChallenge = (await view.context.cookies()).find(value => value.name === '__Host-supatrace-mfa').value;
      // Synthetic fixture reset while the browser waits for MFA; endpoint interleavings are tested in session-epoch.test.mjs.
      await live.store.resetEmailPassword(email, tenantId, hashPassword('New!67890'));
      await view.page.fill('#mfa-code', totp(secret));
      const rejected = view.page.waitForResponse(response => response.url().endsWith('/api/auth/mfa'));
      await view.page.getByRole('button', {name: 'Verify', exact: true}).click();
      assert.equal((await rejected).status(), 409);
      await view.page.getByText('Your account changed during sign-in. Please sign in again.').waitFor();
      assert.equal((await view.context.cookies()).some(value => value.name === '__Host-supatrace'), false);
      await view.page.getByRole('button', {name: 'Back to sign in', exact: true}).click();
      await view.page.fill('#password', 'New!67890');
      await view.page.getByRole('button', {name: 'Sign in', exact: true}).click();
      await view.page.locator('#mfa-code').waitFor({state: 'visible'});
      assert.notEqual((await view.context.cookies()).find(value => value.name === '__Host-supatrace-mfa').value, staleChallenge);
      await view.page.fill('#mfa-code', totp(secret));
      await view.page.getByRole('button', {name: 'Verify', exact: true}).click();
      await view.page.locator('#shell:not([hidden])').waitFor();
      assert.equal((await view.context.cookies()).some(value => value.name === '__Host-supatrace'), true);
      assert.equal((await view.context.cookies()).some(value => value.name === '__Host-supatrace-mfa'), false);
      assert.equal(await view.page.evaluate(async () => (await fetch('/api/me')).status), 200);
      await view.clean();
    } catch (error) { await view.context.close(); throw error; }
  } finally { await live.close(); }
});

// Registered through this file instead of package.json's one-line `test:ui` list, which conflicts
// with every concurrent merge to the trunk. `npm run test:ui` runs it all the same.
import './access-token-browser.test.mjs';
import './drains-browser.test.mjs';
import './integrations-view-browser.test.mjs';
import './logs-view-browser.test.mjs';
import './mfa-status-browser.test.mjs';
