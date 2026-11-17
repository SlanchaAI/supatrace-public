import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';
import {digest} from '../src/aws-auth.mjs';

test('signed-in user creates a personal access token in Settings, uses it on /api/v1 and revokes it', async () => {
  const live = await start(), browser = await launch(), context = await browser.newContext();
  try {
    await context.route(/^(?!http:\/\/127\.0\.0\.1)/, r => r.abort()); const tenant = await live.signIn(context); await live.seedRuns(tenant, 2);
    const page = await context.newPage(), errors = [], posted = []; page.on('pageerror', e => errors.push(e.message)); page.on('request', r => { if (r.method() === 'POST') posted.push({path: new URL(r.url()).pathname, body: r.postData()}); });
    await page.goto(live.origin + '/app/#settings'); await page.locator('#shell:not([hidden])').waitFor();
    await page.locator('#tokens-section').scrollIntoViewIfNeeded(); await page.locator('#tokens-empty:not([hidden])').waitFor();
    const spec = await context.request.get(live.origin + await page.locator('#tokens-section a').first().getAttribute('href')); assert.equal(spec.status(), 200); assert.equal((await spec.json()).openapi, '3.1.0');
    await page.locator('#token-name').fill('CI reader'); await page.locator('#token-days').fill('7'); await page.locator('#token-form button[type=submit]').click();
    await page.locator('#token-created:not([hidden])').waitFor();
    const token = await page.locator('#token-value').innerText(); assert.match(token, /^stpat_[A-Za-z0-9_-]{43}$/);
    assert.match(await page.locator('#token-created').innerText(), /not shown again/);
    // The token never leaves the browser: the server receives only its hash.
    const created = posted.find(r => r.path === '/api/tokens'); assert.ok(created); assert.deepEqual(JSON.parse(created.body), {name: 'CI reader', expires_in_days: 7, token_hash: digest(token)}); assert.ok(posted.every(r => !r.body?.includes(token)));
    await page.locator('#tokens-list li').waitFor(); assert.match(await page.locator('#tokens-list li').innerText(), /CI reader · read-only · expires/);
    if (process.env.SUPATRACE_PROOF_DIR) { mkdirSync(process.env.SUPATRACE_PROOF_DIR, {recursive: true}); await page.locator('#token-value').evaluate(node => { node.textContent = 'stpat_<redacted for screenshot>'; }); await page.locator('#tokens-section').screenshot({path: process.env.SUPATRACE_PROOF_DIR + '/settings-token-created.png'}); }
    const me = await context.request.get(live.origin + '/api/v1/me', {headers: {authorization: 'Bearer ' + token}}); assert.equal(me.status(), 200); assert.equal((await me.json()).account_id, tenant);
    const traces = await context.request.get(live.origin + '/api/v1/traces', {headers: {'x-supatrace-key': token}}); assert.equal((await traces.json()).total, 2);
    // Dismissing clears the token from the page; a reload cannot show it again.
    await page.locator('#token-dismiss').click(); assert.equal(await page.locator('#token-value').innerText(), ''); assert.equal(await page.locator('#token-created').isHidden(), true);
    await page.reload(); await page.locator('#tokens-list li').waitFor(); assert.ok(!(await page.content()).includes(token));
    // Revoke takes two clicks and stops the token at once.
    const revoke = page.locator('#tokens-list button[data-token]'); await revoke.click(); assert.equal(await revoke.innerText(), 'Confirm revoke'); assert.equal((await context.request.get(live.origin + '/api/v1/me', {headers: {authorization: 'Bearer ' + token}})).status(), 200);
    await revoke.click(); await page.locator('#tokens-empty:not([hidden])').waitFor(); assert.equal(await page.locator('#tokens-list li').count(), 0);
    assert.equal((await context.request.get(live.origin + '/api/v1/me', {headers: {authorization: 'Bearer ' + token}})).status(), 401);
    assert.deepEqual(errors, []);
  } finally { await context.close(); await browser.close(); await live.close(); }
});
