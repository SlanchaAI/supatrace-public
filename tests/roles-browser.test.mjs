import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {start as startHarness} from './harness.mjs';
// This file drives a paid feature, so its fixture organizations are on Enterprise. tests/entitlements*.test.mjs cover the gates.
const start = (options = {}) => startHarness({plan: 'enterprise', ...options});
import {launch} from './browser.mjs';
import {totp} from '../src/dashboard-auth.mjs';

// Issue #129: a limited Developer in the dashboard, the Require two-factor toggle, and the prompt a member without it gets.
test('owner invites a developer limited to one environment, then requires two-factor authentication', {timeout: 120000}, async () => {
  const live = await start({mfa: true}), browser = await launch(), contexts = [];
  try {
    const make = async id => { const c = await browser.newContext({viewport: {width: 1280, height: 900}}); contexts.push(c); await c.route(/^(?!http:\/\/127\.0\.0\.1)/, r => r.abort()); const tenant = await live.signIn(c, id); return {c, tenant, p: await c.newPage()}; };
    const owner = await make(4242), member = await make(5252), errors = []; for (const who of [owner, member]) who.p.on('pageerror', e => errors.push(e.message));
    const shot = async (page, name) => { const dir = process.env.SUPATRACE_ROLES_SCREENSHOT_DIR; if (dir) { mkdirSync(dir, {recursive: true}); await page.screenshot({path: `${dir}/${name}.png`, fullPage: true}); } };
    const api = (page, path, body) => page.evaluate(async ({path, body}) => { const r = await fetch('/api/' + path, body === undefined ? {} : {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)}); return {status: r.status, body: await r.json().catch(() => ({}))}; }, {path, body});
    await owner.p.goto(live.origin + '/app/#members'); await owner.p.locator('#shell:not([hidden])').waitFor();
    await owner.p.locator('#share-workspace input').fill('Team'); await owner.p.locator('#share-workspace button').click(); await owner.p.locator('#team-members:not([hidden])').waitFor();
    assert.equal((await api(owner.p, 'environments', {id: 'dev', name: 'Development'})).status, 201); await owner.p.reload(); await owner.p.locator('#team-members:not([hidden])').waitFor();
    assert.deepEqual(await owner.p.locator('#invite-member [name=role] option').allInnerTexts(), ['Read-only', 'Developer', 'Admin']);
    await owner.p.locator('#invite-member [name=recipient_id]').fill(member.tenant); await owner.p.locator('#invite-member [name=role]').selectOption('developer'); await owner.p.locator('#invite-scope select').selectOption(['dev']);
    await owner.p.locator('#invite-member button').click(); await owner.p.locator('#invitation-link a').waitFor();
    // The developer lands in the one environment they may open, with keys but no environment or member management.
    await member.p.goto(live.origin + '/app/#members'); await member.p.locator('.pending-invite button').click();
    await member.p.waitForURL(u => u.searchParams.get('workspace') === owner.tenant && u.searchParams.get('environment') === 'dev'); await member.p.locator('#shell:not([hidden])').waitFor();
    assert.match(await member.p.locator('#scope-summary').innerText(), /Developer access/); assert.deepEqual(await member.p.locator('#environment-select option').allInnerTexts(), ['Development']);
    assert.equal(await member.p.locator('#rail [data-nav="keys"]').isVisible(), true); assert.equal(await member.p.locator('#team-members').isVisible(), false);
    await member.p.locator('#rail a[data-nav="settings"]').click(); assert.equal(await member.p.locator('#create-environment').isVisible(), false);
    assert.equal((await api(member.p, 'runs?workspace=' + owner.tenant)).body.error, 'environment_unavailable'); assert.equal((await api(member.p, 'runs?workspace=' + owner.tenant + '&environment=dev')).status, 200);
    await owner.p.reload(); await owner.p.locator('#member-list').waitFor(); assert.match(await owner.p.locator('#member-list').innerText(), new RegExp(member.tenant + ' · Developer · limited to dev')); await shot(owner.p, 'roles-members');
    // Require two-factor authentication: the owner must have it first.
    assert.equal(await owner.p.locator('#org-security').isVisible(), true); assert.match(await owner.p.locator('#org-security-note').innerText(), /your own account/);
    await owner.p.locator('#org-security [name=require_mfa]').check(); await owner.p.locator('#org-security button').click(); await owner.p.waitForFunction(() => /mfa_enrollment_required/.test(document.querySelector('#workspace-notice').textContent));
    const secret = (await api(owner.p, 'auth/mfa/enroll', {})).body.secret; assert.equal((await api(owner.p, 'auth/mfa/confirm', {code: totp(secret)})).status, 200);
    await owner.p.reload(); await owner.p.locator('#org-security:not([hidden])').waitFor(); assert.match(await owner.p.locator('#org-security-note').innerText(), /refused until they turn it on/);
    await owner.p.locator('#org-security [name=require_mfa]').check(); await owner.p.locator('#org-security button').click(); await owner.p.waitForFunction(() => /Security setting saved/.test(document.querySelector('#workspace-notice').textContent)); await shot(owner.p, 'roles-require-mfa');
    // The member is sent to their personal organization with the enrollment prompt, and the API refuses them.
    await member.p.reload(); await member.p.waitForURL(u => u.searchParams.has('mfa_org')); await member.p.locator('#shell:not([hidden])').waitFor();
    assert.match(await member.p.locator('#scope-notice').innerText(), /Team requires two-factor authentication\. Turn it on in Settings, then switch back to it\./); assert.equal(await member.p.locator('#view-settings').isVisible(), true);
    assert.ok((await member.p.locator('#org-select option').allInnerTexts()).includes('Team (needs two-factor authentication)')); await shot(member.p, 'roles-mfa-prompt');
    assert.equal((await api(member.p, 'runs?workspace=' + owner.tenant + '&environment=dev')).body.error, 'mfa_enrollment_required');
    const own = (await api(member.p, 'auth/mfa/enroll', {})).body.secret; assert.equal((await api(member.p, 'auth/mfa/confirm', {code: totp(own)})).status, 200);
    await member.p.goto(live.origin + '/app/?workspace=' + owner.tenant + '&environment=dev#traces'); await member.p.locator('#shell:not([hidden])').waitFor(); assert.equal(new URL(member.p.url()).searchParams.get('workspace'), owner.tenant);
    assert.deepEqual(errors, []);
  } finally { for (const c of contexts) await c.close(); await browser.close(); await live.close(); }
});
