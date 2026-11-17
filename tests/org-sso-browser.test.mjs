import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {start as startHarness} from './harness.mjs';
// This file drives a paid feature, so its fixture organizations are on Enterprise. tests/entitlements*.test.mjs cover the gates.
const start = (options = {}) => startHarness({plan: 'enterprise', ...options});
import {launch} from './browser.mjs';
import {digest} from '../src/aws-auth.mjs';

// Issue #124: the owner sets up SAML for the organization in the dashboard, verifies a domain, requires SSO and creates a SCIM token.
test('owner configures SSO, verifies a domain by DNS TXT, requires SSO and creates a SCIM token that works', {timeout: 120000}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'supatrace-sso-ui-')); execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '2', '-nodes', '-subj', '/CN=ui-idp'], {stdio: 'ignore'});
  const cert = readFileSync(join(dir, 'c.pem'), 'utf8'); rmSync(dir, {recursive: true, force: true});
  const dns = new Map(), live = await start({configureEnvironment: env => { env.resolveTxt = async name => { if (!dns.has(name)) throw new Error('ENOTFOUND'); return [[dns.get(name)]]; }; }}), browser = await launch(), context = await browser.newContext({viewport: {width: 1280, height: 900}});
  try {
    await context.route(/^(?!http:\/\/127\.0\.0\.1)/, r => r.abort()); const tenant = await live.signIn(context, 4242), page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
    const shot = async name => { const out = process.env.SUPATRACE_SSO_SCREENSHOT_DIR; if (out) { mkdirSync(out, {recursive: true}); await page.screenshot({path: `${out}/${name}.png`, fullPage: true}); } };
    await page.goto(live.origin + '/app/#members'); await page.locator('#shell:not([hidden])').waitFor(); assert.equal(await page.locator('#sso-controls').count(), 0, 'no SSO card before the organization is shared');
    await page.locator('#share-workspace input').fill('Acme'); await page.locator('#share-workspace button').click(); await page.locator('#sso-controls').waitFor();
    assert.equal(await page.locator('#sso-acs').innerText(), 'https://supatrace.dev/api/auth/sso/callback'); assert.equal(await page.locator('#sso-enforce').isVisible(), false); assert.equal(await page.locator('#sso-scim').isVisible(), false);
    await page.locator('#sso-form [name=idp_sso_url]').fill('https://idp.acme.example/sso'); await page.locator('#sso-form [name=idp_issuer]').fill('https://idp.acme.example/saml'); await page.locator('#sso-form [name=idp_cert]').fill('not a certificate');
    await page.locator('#sso-form [name=domains]').fill('acme.example'); await page.locator('#sso-form [name=default_role]').selectOption('developer'); await page.locator('#sso-form button').click();
    await page.waitForFunction(() => /not an X\.509 certificate/.test(document.querySelector('#sso-status').textContent));
    await page.locator('#sso-form [name=idp_cert]').fill(cert); await page.locator('#sso-form button').click(); await page.waitForFunction(() => document.querySelector('#sso-status').textContent === 'SSO settings saved.');
    assert.match(await page.locator('#sso-cert').innerText(), /SHA-256 fingerprint: ([0-9A-F]{2}:){31}[0-9A-F]{2}/); assert.equal(await page.locator('#sso-form [name=idp_cert]').inputValue(), '');
    const row = await page.locator('.sso-domain').innerText(), record = row.match(/TXT record (\S+) with value (\S+)/); assert.equal(record[1], '_supatrace.acme.example');
    await page.locator('.sso-domain button').click(); await page.waitForFunction(() => /TXT record was not found yet/.test(document.querySelector('#sso-status').textContent)); await shot('sso-unverified');
    dns.set(record[1], record[2]); await page.locator('.sso-domain button').click(); await page.waitForFunction(() => document.querySelector('#sso-status').textContent === 'acme.example is verified.');
    assert.match(await page.locator('.sso-domain').innerText(), /acme\.example: verified/);
    await page.locator('#sso-enforce [name=enforce]').check(); await page.locator('#sso-enforce button').click(); await page.waitForFunction(() => document.querySelector('#sso-status').textContent === 'SSO is now required for members.');
    await page.locator('#scim-new').click(); await page.locator('#scim-created:not([hidden])').waitFor(); const token = await page.locator('#scim-token').innerText(); assert.match(token, /^stscim_[A-Za-z0-9_-]{43}$/); await shot('sso-configured');
    const scim = await fetch(live.origin + '/api/scim/v2/Users', {method: 'POST', headers: {authorization: 'Bearer ' + token, 'content-type': 'application/scim+json'}, body: JSON.stringify({userName: 'grace@acme.example'})}); assert.equal(scim.status, 201);
    await page.reload(); await page.locator('#member-list').waitFor(); assert.match(await page.locator('#member-list').innerText(), new RegExp('sso-' + digest('grace@acme.example') + ' · Developer'));
    assert.equal(await page.locator('#sso-enforce [name=enforce]').isChecked(), true); assert.match(await page.locator('#scim-state').innerText(), /A SCIM token is set/); assert.equal(await page.locator('#scim-created').isVisible(), false, 'the token is not shown again');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    // The signed-out sign-in page now offers SSO and sends this domain to the organization's identity provider.
    const guest = await browser.newContext(); await guest.route(/^(?!http:\/\/127\.0\.0\.1)/, r => r.abort()); const sign = await guest.newPage();
    await sign.goto(live.origin + '/app/'); await sign.getByRole('button', {name: 'Continue with SSO'}).click(); await sign.locator('#sso-email').fill('grace@acme.example');
    const [request] = await Promise.all([sign.waitForRequest(r => r.url().startsWith('https://idp.acme.example/sso')), sign.getByRole('button', {name: 'Sign in', exact: true}).click()]);
    assert.ok(new URL(request.url()).searchParams.get('SAMLRequest')); await guest.close();
    assert.deepEqual(errors, []); assert.equal(tenant, 'github-4242');
  } finally { await context.close(); await browser.close(); await live.close(); }
});
