// Rendered check for the static public pages on the synthetic loopback harness.
// Run: PLAYWRIGHT_CHROMIUM_PATH=/path/to/chromium node --test tests/site-pages-browser.test.mjs
// Optional screenshots: SUPATRACE_SITE_SCREENSHOT_DIR=/output/directory
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, readFileSync} from 'node:fs';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';
import {PAGES, NAV} from '../scripts/site-pages.mjs';
import {PLANS} from '../src/plans.mjs';

let browser, live;
const out = process.env.SUPATRACE_SITE_SCREENSHOT_DIR;
if (out) mkdirSync(out, {recursive: true});
before(async () => { browser = await launch(); live = await start(); });
after(async () => { await browser?.close(); await live?.close(); });

async function open(path, viewport) {
  const context = await browser.newContext({viewport});
  await context.route(/^(?!http:\/\/127\.0\.0\.1)/, route => route.abort());
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const response = await page.goto(live.origin + path, {waitUntil: 'networkidle'});
  assert.equal(response.status(), 200, path);
  return {context, page, errors};
}
const fits = async (page, label) => {
  const size = await page.evaluate(() => ({width: document.documentElement.scrollWidth, inner: innerWidth}));
  assert.ok(size.width <= size.inner, `${label} horizontal overflow: ${size.width}/${size.inner}`);
};

for (const viewport of [{width: 1440, height: 900}, {width: 390, height: 844}, {width: 320, height: 740}]) {
  test(`public pages render with shared chrome and no overflow at ${viewport.width}px`, {timeout: 60000}, async () => {
    for (const item of PAGES) {
      const {context, page, errors} = await open(item.path, viewport);
      try {
        assert.equal(await page.locator('body').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(246, 243, 232)', item.path);
        for (const link of NAV) assert.ok(await page.locator(`.site-header nav a[href="${link.href}"]`).isVisible(), item.path + ' nav ' + link.href);
        assert.ok(await page.locator('.site-footer .site-links a').first().isVisible());
        await fits(page, item.path);
        if (out) await page.screenshot({path: `${out}/${item.path.replace(/\W+/g, '-').replace(/^-|-$/g, '') || 'home'}-${viewport.width}.png`, fullPage: true});
        assert.deepEqual(errors, [], item.path);
      } finally { await context.close(); }
    }
  });
}

test('pricing shows the four plans, a working FAQ, and calls to action that reach sign-in, Billing and sales', {timeout: 60000}, async () => {
  const {context, page, errors} = await open('/pricing/', {width: 1440, height: 900});
  try {
    assert.ok(await page.locator('#preview-note').isVisible());
    assert.match(await page.locator('#preview-note').innerText(), /Free plan with no card/);
    assert.deepEqual(await page.locator('.plans .plan h3').allInnerTexts(), PLANS.plans.map(plan => plan.name));
    assert.deepEqual(await page.locator('.plans .plan [data-field=price]').allInnerTexts(), ['$0', '$9.99', '$25.99', 'Custom']);
    assert.deepEqual(await page.locator('.plans .plan a.button').evaluateAll(links => links.map(link => link.getAttribute('href'))), ['/app/', '/app/#billing', '/app/#billing', '/enterprise/#contact']);
    const answer = page.locator('.faq details').nth(0).locator('p');
    assert.equal(await answer.isVisible(), false);
    await page.locator('.faq summary').nth(0).click();
    assert.match(await answer.innerText(), /Stripe collects payment and the plan applies after payment is confirmed/);
    assert.equal(await page.locator('.site-header nav a[aria-current=page]').innerText(), 'Pricing');
    assert.deepEqual(errors, []);
    await page.locator('.plans .plan[data-plan=free] a.button').click();
    await page.waitForURL(live.origin + '/app/');
    await page.locator('#signin a, #signin button').first().waitFor();
  } finally { await context.close(); }
});

test('docs pages share a sidebar and every code block has a working Copy button', {timeout: 60000}, async () => {
  const {context, page, errors} = await open('/docs/quickstart/', {width: 1440, height: 900});
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {origin: live.origin});
    assert.equal(await page.locator('.site-header nav a[aria-current=page]').innerText(), 'Docs');
    assert.equal(await page.locator('.docs-nav a[aria-current=page]').innerText(), 'Quickstart');
    const blocks = await page.locator('main pre').count();
    assert.ok(blocks >= 6);
    assert.equal(await page.locator('main .snippet button.copy').count(), blocks);
    const first = page.locator('main .snippet').first();
    await first.locator('button.copy').click();
    await page.waitForFunction(() => document.querySelector('main .snippet button.copy').textContent === 'Copied');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'export OTEL_EXPORTER_OTLP_ENDPOINT=https://supatrace.dev\nexport OTEL_EXPORTER_OTLP_HEADERS="x-supatrace-key=YOUR_INGEST_KEY"\n');
    await page.locator('.docs-nav a[href="/docs/frameworks/openai/"]').click();
    await page.waitForURL(live.origin + '/docs/frameworks/openai/');
    assert.equal(await page.locator('h1').innerText(), 'OpenAI');
    assert.match(await page.locator('.preview-note').first().innerText(), /not published to npm/);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('the footer hides the build while build.json remains available', async () => {
  const {context, page} = await open('/pricing/', {width: 1440, height: 900});
  try {
    assert.equal(await page.locator('#build').count(), 0);
    assert.equal((await page.request.get(live.origin + '/build.json')).status(), 200);
  } finally { await context.close(); }
});

test('enterprise contact form composes a draft to the live support inbox', {timeout: 60000}, async () => {
  const context = await browser.newContext({viewport: {width: 390, height: 844}});
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  try {
    await context.route('**/enterprise/contact.js', route => route.abort());
    await page.goto(live.origin + '/enterprise/', {waitUntil: 'networkidle'});
    assert.equal(await page.locator('#sales-form button').isDisabled(), true, 'no script, no submit');
    await page.fill('#sales-name', 'x');
    await page.press('#sales-name', 'Enter');
    assert.equal(page.url(), live.origin + '/enterprise/', 'Enter does not submit the fields as a GET');
    await context.unroute('**/enterprise/contact.js');
    errors.length = 0;
    await page.goto(live.origin + '/enterprise/', {waitUntil: 'networkidle'});
    assert.equal(await page.locator('#sales-form button').isEnabled(), true);
    await page.evaluate(() => document.addEventListener('click', event => { if (event.target.href?.startsWith('mailto:')) { window.mailDraft = event.target.href; event.preventDefault(); } }, true));
    await page.locator('#sales-form button').click();
    assert.equal(await page.evaluate(() => window.mailDraft), undefined, 'required fields block an empty draft');
    await page.fill('#sales-name', 'Ada Example');
    await page.fill('#sales-email', 'ada@example.com');
    await page.fill('#sales-company', 'Example & Co');
    await page.fill('#sales-size', '40');
    await page.fill('#sales-message', 'SSO and retention?\nSecond line.');
    await page.locator('#sales-form button').click();
    const draft = new URL(await page.evaluate(() => window.mailDraft));
    assert.equal(draft.pathname, 'support@supatrace.dev');
    assert.equal(draft.searchParams.get('subject'), 'SupaTrace Enterprise: Example & Co');
    assert.equal(draft.searchParams.get('body'), 'Name: Ada Example\nWork email: ada@example.com\nCompany: Example & Co\nTeam size: 40\n\nSSO and retention?\nSecond line.');
    assert.match(await page.locator('#sales-status').innerText(), /Opening a draft/);
    const size = await page.evaluate(() => ({width: document.documentElement.scrollWidth, inner: innerWidth}));
    assert.ok(size.width <= size.inner);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('status runs live checks, says no feed is published, and shows a published feed only while it is fresh', {timeout: 60000}, async () => {
  const plain = await open('/status/', {width: 1440, height: 900});
  try {
    await plain.page.locator('#check-api .status.available').waitFor();
    assert.equal(await plain.page.locator('#check-site .state').innerText(), 'REACHABLE');
    assert.match(await plain.page.locator('#check-site .note').innerText(), /no build marker/);
    assert.match(await plain.page.locator('#checked-at').innerText(), /Checked from your browser at/);
    assert.match(await plain.page.locator('#feed').innerText(), /No monitoring feed is published yet/);
    assert.match(await plain.page.locator('#incidents').innerText(), /No incident history is published/);
    assert.deepEqual(plain.errors, []);
  } finally { await plain.context.close(); }
  const withFeed = async (updated, apiDown) => {
    const context = await browser.newContext({viewport: {width: 390, height: 844}});
    await context.route('**/status.json', route => route.fulfill({contentType: 'application/json', body: JSON.stringify({schema: 1, source: 'test', updated_at: updated, components: [{name: 'Uploads', status: 'operational'}, {name: 'Dashboard', status: 'degraded', note: '<b>slow</b>'}], incidents: [{title: 'Uploads rejected', started_at: updated, body: 'Investigating.'}]})}));
    if (apiDown) await context.route('**/api/auth/providers', route => route.abort());
    const page = await context.newPage();
    await page.goto(live.origin + '/status/', {waitUntil: 'networkidle'});
    await page.locator('#feed .feed-head').waitFor();
    return {context, page};
  };
  const fresh = await withFeed(new Date().toISOString(), true);
  try {
    assert.match(await fresh.page.locator('#feed .feed-head').innerText(), /^DEGRADED Monitoring feed updated/);
    assert.deepEqual(await fresh.page.locator('#feed .components li .status').allInnerTexts(), ['OPERATIONAL', 'DEGRADED']);
    assert.equal(await fresh.page.locator('#feed b').count(), 0, 'feed text is not parsed as HTML');
    assert.match(await fresh.page.locator('#feed').innerText(), /<b>slow<\/b>/);
    assert.match(await fresh.page.locator('#incidents').innerText(), /Uploads rejected[\s\S]*\(ongoing\)[\s\S]*Investigating\./);
    await fresh.page.locator('#check-api .status.down').waitFor();
    assert.equal(await fresh.page.locator('#check-api .state').innerText(), 'UNREACHABLE');
    const size = await fresh.page.evaluate(() => ({width: document.documentElement.scrollWidth, inner: innerWidth}));
    assert.ok(size.width <= size.inner);
  } finally { await fresh.context.close(); }
  // A feed that was fresh at load stops being shown as current once it ages out, without a reload.
  const aging = await browser.newContext({viewport: {width: 1440, height: 900}});
  try {
    const stamped = new Date().toISOString();
    const before = JSON.stringify({schema: 1, source: 'test', updated_at: stamped, components: [{name: 'Uploads', status: 'operational', note: 'ok'}], incidents: []});
    await aging.route('**/status.json', route => route.fulfill({contentType: 'application/json', body: before}));
    const page = await aging.newPage();
    await page.clock.install({time: new Date()});
    await page.goto(live.origin + '/status/', {waitUntil: 'networkidle'});
    await page.locator('#feed .feed-head').waitFor();
    assert.match(await page.locator('#feed .feed-head').innerText(), /^OPERATIONAL Monitoring feed updated/);
    // A refetch that returns the same timestamp and the same length but a different state renders.
    await aging.unroute('**/status.json');
    const after = JSON.stringify({schema: 1, source: 'test', updated_at: stamped, components: [{name: 'Uploads', status: 'outage', note: 'failure'}], incidents: []});
    assert.equal(after.length, before.length, 'same serialized length, different state');
    await aging.route('**/status.json', route => route.fulfill({contentType: 'application/json', body: after}));
    await page.clock.runFor(61 * 1000);
    await page.locator('#feed .feed-head .status.down').waitFor();
    assert.match(await page.locator('#feed .feed-head').innerText(), /^OUTAGE/);
    assert.deepEqual(await page.locator('#feed .components li .status').allInnerTexts(), ['OUTAGE']);
    // From here every refetch hangs: expiry must not depend on a fetch completing.
    await aging.unroute('**/status.json');
    await aging.route('**/status.json', () => {});
    await page.clock.runFor(16 * 60 * 1000);
    // The hung fetch may also have timed out by now; either way nothing is shown as current.
    await page.locator('#feed', {hasText: /out of date|could not be read/}).waitFor();
    assert.equal(await page.locator('#feed .status.available, #feed .status.down').count(), 0, 'no current label after expiry');
    // And when the feed disappears, the page stops showing it at all.
    await aging.unroute('**/status.json');
    await aging.route('**/status.json', route => route.abort());
    await page.clock.runFor(61 * 1000);
    await page.locator('#feed', {hasText: 'could not be read'}).waitFor();
    assert.equal(await page.locator('#feed .components').count(), 0);
  } finally { await aging.close(); }
  // Overlapping refreshes: the response to an older request arrives last and must be ignored.
  const racing = await browser.newContext({viewport: {width: 1440, height: 900}});
  try {
    const stamped = new Date().toISOString(), body = status => JSON.stringify({schema: 1, source: 'test', updated_at: stamped, components: [{name: 'Uploads', status}], incidents: []});
    let calls = 0, releaseOld;
    await racing.route('**/status.json', async route => {
      calls += 1;
      if (calls === 1) return route.fulfill({contentType: 'application/json', body: body('operational')});
      if (calls === 2) { await new Promise(resolve => { releaseOld = resolve; }); return route.fulfill({contentType: 'application/json', body: body('operational')}); }
      return route.fulfill({contentType: 'application/json', body: body('outage')});
    });
    const page = await racing.newPage();
    await page.goto(live.origin + '/status/', {waitUntil: 'networkidle'});
    await page.locator('#feed .feed-head').waitFor();
    const visible = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await visible();
    await page.waitForFunction(() => true);
    while (!releaseOld) await new Promise(resolve => setTimeout(resolve, 20));
    await visible();
    await page.locator('#feed .feed-head .status.down').waitFor();
    releaseOld();
    await page.waitForTimeout(500);
    assert.match(await page.locator('#feed .feed-head').innerText(), /^OUTAGE/, 'the late older response did not replace the newer outage');
    assert.equal(calls, 3);
  } finally { await racing.close(); }
  const stale = await withFeed(new Date(Date.now() - 60 * 60 * 1000).toISOString(), false);
  try {
    assert.match(await stale.page.locator('#feed .feed-head').innerText(), /out of date, so it does not describe the current state/);
    assert.deepEqual(await stale.page.locator('#feed .components li .status').allInnerTexts(), ['LAST KNOWN: OPERATIONAL', 'LAST KNOWN: DEGRADED']);
  } finally { await stale.context.close(); }
});


test('sign-in and sign-up show consent links that open the published legal pages', {timeout: 60000}, async () => {
  const {context, page, errors} = await open('/#signin', {width: 390, height: 844});
  try {
    await page.evaluate(async () => {
      const {mountSignIn} = await import('/signin.js');
      mountSignIn(document.querySelector('#signin'), {github: true, google: true, email: true});
    });
    for (const view of ['main', 'signup']) {
      if (view === 'signup') await page.getByRole('button', {name: 'Create a free account', exact: true}).click();
      const consent = page.locator('[data-view="' + view + '"] .legal');
      assert.equal(await consent.innerText(), 'By continuing you agree to the Terms of Service and Privacy Policy');
      for (const [label, href] of [['Terms of Service', '/terms.html'], ['Privacy Policy', '/privacy.html']]) {
        assert.equal(await consent.getByRole('link', {name: label, exact: true}).getAttribute('href'), href);
      }
    }
    await page.locator('[data-view="signup"] .legal a').first().click();
    await page.waitForURL(live.origin + '/terms.html');
    assert.equal(await page.locator('h1').innerText(), 'Terms of Service');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});


test('live billing copy renders on pricing and terms at desktop and mobile sizes', {timeout: 60000}, async () => {
  for (const viewport of [{width: 1440, height: 900}, {width: 390, height: 844}]) {
    for (const path of ['/pricing/', '/terms.html']) {
      const {context, page, errors} = await open(path, viewport);
      try {
        const content = await page.locator('main').innerText();
        assert.doesNotMatch(content, /test[ -]mode|no real (?:card|charge)|until launch/i);
        if (path === '/pricing/') {
          assert.ok(content.includes('Payments are handled by Stripe.'));
          await page.getByText('Where do I choose a plan?', {exact: true}).click();
          assert.ok(await page.getByText('Choose Base or Pro in Billing. Stripe collects payment and the plan applies after payment is confirmed.', {exact: true}).isVisible());
        } else {
          assert.ok(content.includes('Stripe charges the price shown at Checkout when you authorize a subscription.'));
          assert.ok(content.includes('Subscriptions renew monthly until cancelled.'));
        }
        await fits(page, path);
        assert.deepEqual(errors, []);
        if (out) await page.screenshot({path: `${out}/${path === '/pricing/' ? 'pricing' : 'terms'}-${viewport.width}.png`, fullPage: true});
      } finally { await context.close(); }
    }
  }
});


test('sitemap docs and pricing have truthful overflow cues at mobile and desktop widths', {timeout: 120000}, async () => {
  const sitemap = readFileSync(new URL('../public/sitemap.xml', import.meta.url), 'utf8');
  const paths = new Set(['/pricing/', '/agent-setup.html', ...[...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => new URL(match[1]).pathname).filter(path => path.startsWith('/docs/'))]);
  const contrast = (first, second) => {
    const luminance = color => {
      const channels = color.match(/[\d.]+/g).slice(0, 3).map(value => {
        const channel = Number(value) / 255;
        return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
      });
      return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
    };
    const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
    return (values[0] + .05) / (values[1] + .05);
  };
  for (const viewport of [{width:390,height:844},{width:1440,height:900}]) {
    const context = await browser.newContext({viewport, reducedMotion:'reduce'});
    const page = await context.newPage();
    try {
      for (const path of paths) {
        await page.goto(live.origin + path, {waitUntil:'networkidle'});
        if (!await page.locator('main table, main pre').count()) continue;
        await fits(page, path + ' ' + viewport.width);
        const regions = page.locator('.scroll-shell');
        assert.equal(await regions.count(), await page.locator('main table, main pre').count(), path);
        for (const shell of await regions.all()) {
          if (!await shell.isVisible()) continue;
          const region = shell.locator(':scope > pre, :scope > .table-scroll');
          await region.evaluate(node => {node.scrollLeft = 0;});
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const measure = () => shell.evaluate(node => {
            const region = node.querySelector('pre, .table-scroll');
            const hint = getComputedStyle(node.querySelector('.scroll-hint'));
            return {overflow:region.scrollWidth > region.clientWidth + 1, left:region.scrollLeft,
              rightOpacity:Number(getComputedStyle(node,'::after').opacity), leftOpacity:Number(getComputedStyle(node,'::before').opacity),
              hintVisible:hint.display !== 'none' && Number(hint.opacity) > .5,
              hintColor:hint.color, background:getComputedStyle(document.body).backgroundColor,
              focus:region.tabIndex, role:region.getAttribute('role'), label:region.getAttribute('aria-label'),
              whitespace:region.matches('pre') ? getComputedStyle(region).whiteSpace : null};
          });
          const initial = await measure();
          if (viewport.width < 640 && await shell.locator('.stack-table').count()) assert.equal(initial.overflow, false, path + ' mobile cards fit');
          assert.equal(initial.focus, 0, path); assert.equal(initial.role, 'region', path);
          assert.match(initial.label, /scroll horizontally/, path);
          if (initial.whitespace) assert.equal(initial.whitespace, 'pre', path);
          assert.equal(initial.rightOpacity > .5, initial.overflow, `${path} ${viewport.width} right cue ${JSON.stringify(initial)}`);
          assert.equal(initial.leftOpacity, 0, path + ' left start');
          assert.equal(initial.hintVisible, initial.overflow && viewport.width < 640, path + ' hint');
          if (initial.overflow) {
            if (initial.hintVisible) assert.ok(contrast(initial.hintColor, initial.background) >= 4.5, path + ' hint contrast');
            await region.focus();
            assert.notEqual(await region.evaluate(node => getComputedStyle(node).outlineStyle), 'none');
            const outlineColor = await region.evaluate(node => getComputedStyle(node).outlineColor);
            assert.ok(contrast(outlineColor, initial.background) >= 3, path + ' focus contrast');
            await region.press('ArrowRight');
            await page.waitForFunction(node => node.scrollLeft > 0, await region.elementHandle());
            await region.evaluate(node => {node.scrollLeft = node.scrollWidth;});
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            const end = await measure();
            assert.equal(end.rightOpacity, 0, path + ' right end');
            assert.equal(end.leftOpacity, 1, path + ' left end');
            assert.equal(end.hintVisible, false, path + ' hint end');
          }
        }
      }
    } finally {await context.close();}
  }
});
