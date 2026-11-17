import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';
import {totp} from '../src/dashboard-auth.mjs';

async function settings(live, browser) {
  const context = await browser.newContext(); await context.route(/^(?!http:\/\/127\.0\.0\.1)/, r => r.abort()); await live.signIn(context);
  const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(live.origin + '/app/#settings'); await page.locator('#shell:not([hidden])').waitFor(); await page.locator('#security-summary:not([hidden])').waitFor();
  return {context, page, errors};
}

test('with the switch on, Settings leads to two-factor enrollment and reflects it once enrolled', {timeout: 60000}, async () => {
  const live = await start({mfa: true}), browser = await launch();
  try {
    const {context, page, errors} = await settings(live, browser);
    // The summary sits right under Account, above everything else in Settings.
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#view-settings .settings > .setting')].slice(0, 2).map(node => node.querySelector('h2').textContent)), ['Account', 'Account security']);
    assert.equal(await page.locator('#security-summary').getAttribute('data-mfa'), 'off'); assert.equal(await page.locator('#security-mfa').innerText(), 'Two-factor authentication is off for this account.');
    const go = page.locator('#security-mfa-go'); assert.equal(await go.innerText(), 'Set up two-factor authentication');
    assert.match(await page.locator('#mfa-help').innerText(), /authenticator app.*eight one-time recovery codes.*no email reset/);
    if (process.env.SUPATRACE_PROOF_DIR) { mkdirSync(process.env.SUPATRACE_PROOF_DIR, {recursive: true}); await page.screenshot({path: process.env.SUPATRACE_PROOF_DIR + '/settings-security-summary-off.png', fullPage: true}); }
    await go.click(); assert.equal(await page.evaluate(() => document.activeElement?.id), 'mfa-enroll', 'the button lands on the real control');
    assert.equal(await page.locator('#mfa-enroll').evaluate(node => { const box = node.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight; }), true, 'and brings it into view');
    // Enroll through the existing controls.
    await page.locator('#mfa-enroll').click(); await page.locator('#mfa-confirm-form:not([hidden])').waitFor();
    const secret = (await page.locator('#mfa-secret').innerText()).replace('Authenticator secret ', '').trim(); assert.match(secret, /^[A-Z2-7]{16,}$/);
    await page.locator('#mfa-new').fill(totp(secret)); await page.locator('#mfa-confirm-form button[type=submit]').click();
    await page.waitForFunction(() => document.getElementById('security-summary').dataset.mfa === 'on');
    assert.equal(await page.locator('#security-mfa').innerText(), 'Two-factor authentication is on for this account.'); assert.equal(await go.innerText(), 'Manage two-factor authentication');
    assert.match(await page.locator('#mfa-recovery').innerText(), /^Recovery codes /);
    await go.click(); assert.equal(await page.evaluate(() => document.activeElement?.id), 'mfa-reenroll');
    // Still true after a reload: the state comes from the server, not from this page.
    await page.reload(); await page.locator('#security-summary[data-mfa="on"]').waitFor();
    assert.deepEqual(errors, []); await context.close();
  } finally { await browser.close(); await live.close(); }
});

test('with the switch off, Settings says two-factor authentication is not available and offers no control', async () => {
  const live = await start(), browser = await launch();
  try {
    const {context, page, errors} = await settings(live, browser);
    assert.equal(await page.locator('#security-summary').getAttribute('data-mfa'), 'unavailable');
    assert.equal(await page.locator('#security-mfa').innerText(), 'Two-factor authentication is not available on this deployment.');
    assert.equal(await page.locator('#security-mfa-go').isHidden(), true); assert.equal(await page.locator('#mfa-section').isHidden(), true); assert.equal(await page.locator('#mfa-enroll').isVisible(), false);
    assert.equal((await (await page.request.get(live.origin + '/api/auth/providers')).json()).mfa_enabled, false);
    assert.deepEqual(errors, []); await context.close();
  } finally { await browser.close(); await live.close(); }
});
