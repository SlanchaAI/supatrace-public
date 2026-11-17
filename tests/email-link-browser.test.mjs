// Real loopback API, synthetic challenges, one browser worker. No external mail or identity calls.
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';
import {digest} from '../src/aws-auth.mjs';

const token = 'L'.repeat(43), email = 'link-browser@example.com';
const invalidMessage = 'This sign-in link was already used or has expired. Request a new one below.';
let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });
async function fixture(viewport = {width: 1280, height: 800}) {
  const mailbox = [], live = await start({configureEnvironment: env => Object.assign(env, {EMAIL_FROM: 'member@example.com', sendEmail: async mail => { mailbox.push(mail); }})});
  await live.store.createAuthChallenge('LINK', digest(token), {email}, 900);
  const context = await browser.newContext({viewport}), page = await context.newPage(), errors = [];
  await context.route(/^(?!http:\/\/127\.0\.0\.1)/, route => route.abort());
  page.on('pageerror', error => errors.push(error.message));
  return {live, context, page, mailbox, close: async () => { await context.close(); await live.close(); assert.deepEqual(errors, []); }};
}
async function inViewport(page, locator) {
  const box = await locator.boundingBox(), viewport = page.viewportSize();
  assert.ok(box && box.y >= 0 && box.y + box.height <= viewport.height && box.x >= 0 && box.x + box.width <= viewport.width, 'control is inside first viewport');
}

for (const viewport of [{width: 1280, height: 800}, {width: 390, height: 844}]) {
  for (const path of ['/app/', '/']) for (const discovery of ['healthy', '500', 'hang']) test(`link confirmation is immediate and works with ${discovery} discovery on ${path} at ${viewport.width}px`, {timeout: 30000}, async () => {
    const f = await fixture(viewport);
    if (discovery !== 'healthy') await f.page.route('**/api/auth/providers', route => discovery === '500' ? route.fulfill({status: 500, json: {error: 'synthetic'}}) : undefined);
    try {
      await f.page.goto(f.live.origin + path + '?link=' + token + '&keep=1', {waitUntil: 'domcontentloaded'});
      const button = f.page.getByRole('button', {name: 'Continue to SupaTrace', exact: true});
      await button.waitFor({timeout: 2500}); await inViewport(f.page, button);
      assert.equal(await button.evaluate(node => node === document.activeElement), true);
      const url = new URL(f.page.url()); assert.equal(url.searchParams.has('link'), false); assert.equal(url.searchParams.get('keep'), '1');
      assert.equal((await f.page.locator('#signin').innerText()).includes(email), false);
      assert.ok(await f.live.store.peekAuthChallenge('LINK', digest(token)), 'rendering never consumes');
      await button.click(); await f.page.locator('#shell:not([hidden])').waitFor();
      assert.equal(await f.live.store.peekAuthChallenge('LINK', digest(token)), null);
      assert.equal((await f.live.store.getEmailAccount(email)).verified, true);
    } finally { await f.close(); }
  });
}

for (const path of ['/app/', '/']) test(`invalid link recovers visibly on ${path}`, async () => {
  const f = await fixture();
  try {
    await f.page.goto(f.live.origin + path + '?auth_error=link_invalid&keep=1', {waitUntil: 'networkidle'});
    const status = f.page.locator('#auth-status'), input = f.page.locator('#link-email');
    assert.equal(await status.innerText(), invalidMessage); await inViewport(f.page, status);
    assert.equal(await input.isVisible(), true); assert.equal(await input.evaluate(node => node === document.activeElement), true);
    assert.equal(new URL(f.page.url()).searchParams.has('auth_error'), false);
    assert.equal(new URL(f.page.url()).searchParams.get('keep'), '1');
  } finally { await f.close(); }
});

test('an existing session cannot bypass the explicit link confirmation', async () => {
  const f = await fixture();
  try {
    await f.live.signIn(f.context);
    await f.page.goto(f.live.origin + '/app/?link=' + token, {waitUntil: 'networkidle'});
    const button = f.page.getByRole('button', {name: 'Continue to SupaTrace', exact: true});
    await button.waitFor({timeout: 2500}); await inViewport(f.page, button);
    assert.equal(await f.page.locator('#shell').isVisible(), false);
    assert.ok(await f.live.store.peekAuthChallenge('LINK', digest(token)));
    await button.click(); await f.page.locator('#shell:not([hidden])').waitFor();
    assert.equal(await f.live.store.peekAuthChallenge('LINK', digest(token)), null);
    assert.equal(await f.page.evaluate(async () => (await (await fetch('/api/me')).json()).tenant_id), 'email-' + digest(email));
  } finally { await f.close(); }
});

for (const error of ['invalid_code', 'expired', 'used', 'rate_limit', 'email_sign_in_unavailable', 'network']) test(`confirm ${error} has an actionable visible message`, async () => {
  const f = await fixture();
  await f.page.route('**/api/auth/email/link/confirm', route => error === 'network' ? route.abort('failed') : route.fulfill({status: error === 'rate_limit' ? 429 : error === 'email_sign_in_unavailable' ? 404 : 400, json: {error}}));
  try {
    await f.page.goto(f.live.origin + '/app/?link=' + token, {waitUntil: 'networkidle'});
    const button = f.page.getByRole('button', {name: 'Continue to SupaTrace', exact: true}); await button.click();
    const status = f.page.locator('#auth-status'); await status.filter({hasText: /.+/}).waitFor(); await inViewport(f.page, status);
    if (['invalid_code', 'expired', 'used'].includes(error)) {
      assert.equal(await status.innerText(), invalidMessage); assert.equal(await f.page.locator('#link-email').isVisible(), true);
      assert.equal(await f.page.locator('#link-email').evaluate(node => node === document.activeElement), true);
    } else {
      assert.equal(await status.innerText(), error === 'network' ? 'Could not reach SupaTrace. Try again.' : error === 'rate_limit' ? 'Too many attempts. Wait and try again.' : 'Email sign-in is not available right now.');
      assert.equal(await button.isEnabled(), true);
      assert.ok(await f.live.store.peekAuthChallenge('LINK', digest(token)));
    }
  } finally { await f.close(); }
});

for (const path of ['/app/', '/']) test(`provider discovery retries once and uses the recovered email flag on ${path}`, async () => {
  const f = await fixture(); let attempts = 0;
  await f.page.route('**/api/auth/providers', route => ++attempts === 1 ? route.fulfill({status: 500, json: {error: 'synthetic'}}) : route.continue());
  try {
    await f.page.goto(f.live.origin + path, {waitUntil: 'networkidle'});
    await f.page.getByRole('button', {name: 'Email me a sign-in link', exact: true}).waitFor();
    assert.equal(attempts, 2);
  } finally { await f.close(); }
});

for (const gesture of ['double click', 'Enter twice']) test(`${gesture} sends one request and safely echoes address with a resend cooldown`, async () => {
  const f = await fixture(); let sends = 0, release;
  const held = new Promise(resolve => { release = resolve; });
  await f.page.route('**/api/auth/email/link', async route => { sends++; await held; await route.continue(); });
  try {
    await f.page.goto(f.live.origin + '/app/', {waitUntil: 'networkidle'});
    const address = 'typed@example.com';
    await f.page.fill('#link-email', address);
    const button = f.page.getByRole('button', {name: 'Email me a sign-in link', exact: true});
    const requested = f.page.waitForRequest(request => request.url().endsWith('/api/auth/email/link'));
    if (gesture === 'double click') await button.evaluate(node => { node.click(); node.click(); });
    else { await f.page.locator('#link-email').press('Enter'); await f.page.locator('#link-email').press('Enter'); }
    await requested;
    while (!sends) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(await button.isDisabled(), true); assert.equal(sends, 1);
    release();
    await f.page.getByRole('heading', {name: 'Check your email', exact: true}).waitFor();
    assert.equal(await f.page.locator('[data-view="linkSent"] .sub').first().textContent(), `We sent a sign-in link to ${address}.`);
    assert.equal(await f.page.locator('[data-view="linkSent"] svg').count(), 0);
    assert.equal(await f.page.getByRole('button', {name: /Resend in/}).isDisabled(), true);
    assert.equal(sends, 1); assert.equal(f.mailbox.length, 1);
  } finally { release(); await f.close(); }
});

test('a failed send to a different address does not inherit the earlier cooldown', async () => {
  const f = await fixture(); let requests = 0;
  await f.page.route('**/api/auth/email/link', route => ++requests === 2 ? route.abort('failed') : route.continue());
  try {
    await f.page.goto(f.live.origin + '/app/', {waitUntil: 'networkidle'});
    const submit = f.page.getByRole('button', {name: 'Email me a sign-in link', exact: true});
    await f.page.fill('#link-email', 'first@example.com'); await submit.click();
    await f.page.getByRole('heading', {name: 'Check your email', exact: true}).waitFor();
    await f.page.getByRole('button', {name: 'Use a different email', exact: true}).click();
    await f.page.fill('#link-email', 'second@example.com'); await submit.click();
    await f.page.locator('#auth-status').filter({hasText: /.+/}).waitFor();
    await submit.click();
    await f.page.getByRole('heading', {name: 'Check your email', exact: true}).waitFor();
    assert.equal(requests, 3); assert.equal(f.mailbox.length, 2);
    assert.equal(await f.page.locator('[data-view="linkSent"] .sub').first().textContent(), 'We sent a sign-in link to second@example.com.');
  } finally { await f.close(); }
});

test('address echo treats HTML metacharacters as text', async () => {
  const f = await fixture();
  await f.page.route('**/api/auth/email/link', route => route.fulfill({json: {ok: true, message: 'Check your email'}}));
  try {
    await f.page.goto(f.live.origin + '/app/', {waitUntil: 'networkidle'});
    // Isolate DOM safety from the stricter browser and server email validators.
    await f.page.locator('#link-email').evaluate(node => { node.type = 'text'; node.value = '<img src=x onerror=alert(1)>@example.com'; });
    await f.page.getByRole('button', {name: 'Email me a sign-in link', exact: true}).click();
    await f.page.getByRole('heading', {name: 'Check your email', exact: true}).waitFor();
    assert.equal(await f.page.locator('[data-view="linkSent"] .sub').first().textContent(), 'We sent a sign-in link to <img src=x onerror=alert(1)>@example.com.');
    assert.equal(await f.page.locator('[data-view="linkSent"] img').count(), 0);
  } finally { await f.close(); }
});

test('published browser defaults resolve in the built static tree', async () => {
  const f = await fixture();
  try {
    for (const path of ['/favicon.ico', '/apple-touch-icon.png', '/robots.txt', '/sitemap.xml']) {
      const response = await f.page.request.get(f.live.origin + path);
      assert.equal(response.status(), 200, path);
    }
  } finally { await f.close(); }
});
