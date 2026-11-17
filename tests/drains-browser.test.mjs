import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHmac} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {start as startHarness} from './harness.mjs';
// This file drives a paid feature, so its fixture organizations are on Enterprise. tests/entitlements*.test.mjs cover the gates.
const start = (options = {}) => startHarness({plan: 'enterprise', ...options});
import {launch} from './browser.mjs';

test('an owner adds a drain in Settings, tests it, sees a delivery after an upload and deletes it', async () => {
  const received = [], hook = createServer((req, res) => { const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => { received.push({headers: req.headers, body: Buffer.concat(chunks).toString()}); res.writeHead(204).end(); }); });
  await new Promise(done => hook.listen(0, '127.0.0.1', done));
  // The production transport refuses loopback, so the test delivers the drain's public URL to the local receiver.
  const live = await start({configureEnvironment: async env => { env.drainTransport = async ({body, headers}) => { const r = await fetch('http://127.0.0.1:' + hook.address().port + '/', {method: 'POST', headers, body}); return {ok: r.ok, status: r.status}; }; }});
  const browser = await launch(), context = await browser.newContext();
  try {
    await context.route(/^(?!http:\/\/127\.0\.0\.1)/, r => r.abort()); const tenant = await live.signIn(context), key = await live.writeKey(tenant);
    const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(live.origin + '/app/#settings'); await page.locator('#shell:not([hidden])').waitFor(); await page.locator('#drains-section:not([hidden])').waitFor(); await page.locator('#drains-empty:not([hidden])').waitFor();
    assert.match(await page.locator('#drains-section').innerText(), /X-Supatrace-Signature/);
    // A private address is refused with a plain explanation.
    await page.locator('#drain-url').fill('https://192.168.1.10/hook'); await page.locator('#drain-form button[type=submit]').click();
    await page.waitForFunction(() => /public https/.test(document.getElementById('drains-status').textContent)); assert.equal(await page.locator('#drains-list li').count(), 0);
    await page.locator('#drain-url').fill('https://hooks.customer-site.com/supatrace'); await page.locator('#drain-form button[type=submit]').click();
    await page.locator('#drain-created:not([hidden])').waitFor(); const secret = await page.locator('#drain-secret').innerText(); assert.match(secret, /^whsec_[A-Za-z0-9_-]{43}$/);
    await page.locator('#drains-list li').waitFor(); assert.match(await page.locator('#drains-list li').innerText(), /hooks\.customer-site\.com\/supatrace · delivered 0 · queued 0 · failed 0 · no delivery yet/);
    await page.locator('#drains-list button[data-action=test]').click(); await page.waitForFunction(() => /Test delivered: HTTP 204/.test(document.getElementById('drains-status').textContent));
    assert.equal(JSON.parse(received[0].body).type, 'drain.test');
    await live.upload(key, {version: 1, batch_id: 'ui-drain', run_id: 'ui-drain', events: [{id: 'e1', time: '2026-11-14T00:00:00Z', kind: 'note', name: 'synthetic', data: {}}]});
    const delivery = received[1], [, t, v1] = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(delivery.headers['x-supatrace-signature']); assert.equal(v1, createHmac('sha256', secret).update(t + '.' + delivery.body).digest('hex')); assert.equal(JSON.parse(delivery.body).batch_id, 'ui-drain');
    await page.locator('#drain-dismiss').click(); await page.reload(); await page.locator('#drains-list li').waitFor(); assert.ok(!(await page.content()).includes(secret));
    assert.match(await page.locator('#drains-list li').innerText(), /delivered 1 · queued 0 · failed 0 · last attempt: HTTP 204/);
    if (process.env.SUPATRACE_PROOF_DIR) { mkdirSync(process.env.SUPATRACE_PROOF_DIR, {recursive: true}); await page.locator('#drains-section').scrollIntoViewIfNeeded(); await page.locator('#drains-section').screenshot({path: process.env.SUPATRACE_PROOF_DIR + '/settings-drain-delivered.png'}); }
    const remove = page.locator('#drains-list button[data-action=delete]'); await remove.click(); assert.equal(await remove.innerText(), 'Confirm delete'); await remove.click();
    await page.locator('#drains-empty:not([hidden])').waitFor(); assert.equal(await page.locator('#drains-list li').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); await browser.close(); await live.close(); await new Promise(done => { hook.closeAllConnections?.(); hook.close(done); }); }
});
