// The dashboard reads GET /api/entitlements: paid panels are locked with an upgrade note on a plan that lacks them,
// Billing shows the plan with its limits and features, and both follow the plan when it changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';
import {alphaProject} from '../src/alpha-projects.mjs';

test('legacy project URL resolves plan catalog and entitlements to its organization', {timeout: 60000}, async () => {
  const live = await start(), browser = await launch(), context = await browser.newContext();
  try {
    await context.route(/^(?!http:\/\/127\.0\.0\.1)/, r => r.abort());
    await live.signIn(context); const page = await context.newPage(), requests = [], errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(live.origin + '/app/#members'); await page.locator('#org-create input').fill('Legacy billing organization'); await page.locator('#org-create button').click();
    await page.waitForURL(/workspace=org-/); const org = new URL(page.url()).searchParams.get('workspace');
    live.store.client.items.get('TENANT#' + org + '\0META').plan_id = 'pro';
    page.on('request', r => { const url = new URL(r.url()); if (['/api/billing/catalog', '/api/entitlements'].includes(url.pathname)) requests.push(url); });
    await page.goto(live.origin + '/app/?project=' + alphaProject(org).id + '#billing');
    await page.waitForFunction(() => document.getElementById('plan-entitlements-title')?.textContent === 'Pro plan');
    await page.locator('#plan-billing-plans [data-plan="pro"][data-current="true"]').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.workspace), org);
    assert.ok(requests.some(url => url.pathname === '/api/billing/catalog'));
    assert.ok(requests.some(url => url.pathname === '/api/entitlements'));
    assert.ok(requests.every(url => url.searchParams.get('workspace') === org));
    assert.deepEqual(errors, []);
  } finally { await context.close(); await browser.close(); await live.close(); }
});

test('Free locks drains, roles and the audit log with an upgrade note; Pro unlocks them; a downgrade locks them again', {timeout: 120000}, async () => {
  const live = await start(), browser = await launch(), context = await browser.newContext();
  try {
    await context.route(/^(?!http:\/\/127\.0\.0\.1)/, r => r.abort()); const tenant = await live.signIn(context);
    const plan = value => { const row = live.store.client.items.get('TENANT#' + tenant + '\0META'); if (value) row.plan_id = value; else delete row.plan_id; };
    const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
    const open = async hash => { await page.goto(live.origin + '/app/' + hash); await page.reload(); await page.locator('#shell:not([hidden])').waitFor(); };

    // Free: the plan card names the plan, its limits and which plan unlocks each feature.
    await open('#billing'); await page.locator('#plan-entitlements').waitFor();
    assert.equal(await page.locator('#plan-entitlements-title').innerText(), 'Free plan');
    assert.match(await page.locator('#plan-limits').innerText(), /Spans per month\s+50,000[\s\S]*Retention\s+7 days[\s\S]*Members\s+1 of 2[\s\S]*Environments\s+1 of 2[\s\S]*Active API keys\s+0 of 2/);
    assert.equal(await page.locator('#plan-features li[data-feature=audit_log]').innerText(), 'Audit log: needs Pro');
    assert.equal(await page.locator('#plan-features li[data-feature=sso_saml]').innerText(), 'SAML single sign-on: needs Enterprise');
    assert.equal(await page.locator('#plan-features li[data-enabled=true]').count(), 0);
    if (process.env.SUPATRACE_PROOF_DIR) { mkdirSync(process.env.SUPATRACE_PROOF_DIR, {recursive: true}); await page.locator('#plan-entitlements').screenshot({path: process.env.SUPATRACE_PROOF_DIR + '/billing-plan-free.png'}); }

    // Free: the drain form is locked and says why, with a link to Billing. The server refuses the same request.
    await open('#settings'); await page.locator('#drains-section:not([hidden])').waitFor(); await page.locator('[data-upgrade-for=drain-form]').waitFor();
    assert.equal(await page.locator('[data-upgrade-for=drain-form]').innerText(), 'Trace drains are on the Pro plan. See plans');
    assert.equal(await page.locator('[data-upgrade-for=drain-form] a').getAttribute('href'), '#billing');
    assert.equal(await page.locator('#drain-form').evaluate(form => form.inert), true);
    const refused = await page.evaluate(async () => { const raw = JSON.stringify({url: 'https://hooks.example.com/x'}), hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))), v => v.toString(16).padStart(2, '0')).join(''); const r = await fetch('/api/drains', {method: 'POST', headers: {'Content-Type': 'application/json', 'x-amz-content-sha256': hash}, body: raw}); return [r.status, (await r.json()).error]; });
    assert.deepEqual(refused, [402, 'plan_upgrade_required']);
    if (process.env.SUPATRACE_PROOF_DIR) await page.locator('#drains-section').screenshot({path: process.env.SUPATRACE_PROOF_DIR + '/settings-drains-locked-free.png'});

    // Pro: the same panel is usable and the card shows the feature as included.
    plan('pro'); await open('#settings'); await page.locator('#drains-section:not([hidden])').waitFor(); await page.locator('#drain-form').waitFor();
    await page.waitForFunction(() => document.getElementById('drain-form').inert === false && !document.querySelector('[data-upgrade-for=drain-form]'));
    await page.locator('#drain-url').fill('https://hooks.customer-site.com/supatrace'); await page.locator('#drain-form button[type=submit]').click(); await page.locator('#drains-list li').waitFor();
    await open('#billing'); await page.locator('#plan-entitlements').waitFor();
    assert.equal(await page.locator('#plan-entitlements-title').innerText(), 'Pro plan');
    assert.equal(await page.locator('#plan-features li[data-feature=trace_drains]').innerText(), 'Data export to your systems (trace drains): included');
    assert.equal(await page.locator('#plan-features li[data-feature=scim]').innerText(), 'SCIM provisioning: needs Enterprise');

    // Downgrade: locked again, and the drain that exists is still listed and can be deleted.
    plan(null); await open('#settings'); await page.locator('[data-upgrade-for=drain-form]').waitFor();
    assert.equal(await page.locator('#drain-form').evaluate(form => form.inert), true);
    assert.equal(await page.locator('#drains-list li').count(), 1);
    const remove = page.locator('#drains-list button[data-action=delete]'); await remove.click(); await remove.click(); await page.locator('#drains-empty:not([hidden])').waitFor();
    assert.deepEqual(errors, []);
  } finally { await context.close(); await browser.close(); await live.close(); }
});

test('environments: create, switch, rename and delete from the Members view; the plan limit shows the upgrade sentence', {timeout: 120000}, async () => {
  const live = await start(), browser = await launch(), context = await browser.newContext();
  try {
    await context.route(/^(?!http:\/\/127\.0\.0\.1)/, r => r.abort()); await live.signIn(context);
    const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
    const members = async () => { await page.locator('#shell:not([hidden])').waitFor(); await page.locator('#create-environment').waitFor(); };
    const create = async (id, name) => { await page.locator('#create-environment input[name=id]').fill(id); await page.locator('#create-environment input[name=name]').fill(name); await page.locator('#create-environment button[type=submit]').click(); };
    const options = () => page.locator('#environment-select option').evaluateAll(list => list.map(option => [option.value, option.textContent]));
    await page.goto(live.origin + '/app/#settings'); await members();
    assert.equal(await page.locator('#environment-manage').isHidden(), true, 'nothing to manage while only Default exists');

    // Create: the page moves into the new environment.
    await create('staging', 'Staging'); await page.waitForURL(/environment=staging/); await members();
    assert.deepEqual(await options(), [['default', 'Default'], ['staging', 'Staging']]); assert.equal(await page.locator('#environment-select').inputValue(), 'staging');
    // Free allows Default plus one: the next create is refused with the plan sentence.
    await create('dev', 'Dev'); await page.waitForFunction(() => /Free plan allows 2 environments/.test(document.getElementById('environment-notice').textContent));
    assert.equal(await page.locator('#environment-notice').innerText(), 'The Free plan allows 2 environments. Base allows 3. Upgrade in Billing.');

    // Rename keeps the id and shows the new name everywhere.
    const row = page.locator('#environment-list li[data-environment=staging]'); await row.locator('input[name=name]').fill('Pre-production'); await row.locator('button[type=submit]').click();
    await page.waitForFunction(() => [...document.querySelectorAll('#environment-select option')].some(option => option.textContent === 'Pre-production')); await members();
    assert.deepEqual(await options(), [['default', 'Default'], ['staging', 'Pre-production']]);

    // Switch back to Default and to the environment again.
    await page.locator('#environment-select').selectOption('default'); await page.waitForURL(/environment=default/); await members();
    await page.locator('#environment-select').selectOption('staging'); await page.waitForURL(/environment=staging/); await members();
    if (process.env.SUPATRACE_PROOF_DIR) { mkdirSync(process.env.SUPATRACE_PROOF_DIR, {recursive: true}); await page.locator('#environment-manage').screenshot({path: process.env.SUPATRACE_PROOF_DIR + '/members-environments.png'}); }

    // Delete asks twice, then leaves the deleted environment for Default.
    const remove = page.locator('#environment-list li[data-environment=staging] button[data-action=delete]'); await remove.click();
    assert.equal(await remove.innerText(), 'Confirm delete staging'); assert.match(await page.locator('#environment-manage-notice').innerText(), /ends access to its traces and revokes its keys/);
    await remove.click(); await page.waitForURL(/environment=default/); await members();
    assert.deepEqual(await options(), [['default', 'Default']]); assert.equal(await page.locator('#environment-manage').isHidden(), true);
    // The plan has room again; the retired id is refused.
    await create('staging', 'Again'); await page.waitForFunction(() => /environment_id_retired/.test(document.getElementById('environment-notice').textContent));
    await create('dev', 'Dev'); await page.waitForURL(/environment=dev/);
    assert.deepEqual(errors, []);
  } finally { await context.close(); await browser.close(); await live.close(); }
});

test('Enterprise panels: the owner defines a custom role that then appears where roles are chosen, and sets custom retention; on Pro both are locked', {timeout: 120000}, async () => {
  const live = await start({plan: 'pro'}), browser = await launch(), context = await browser.newContext();
  try {
    await context.route(/^(?!http:\/\/127\.0\.0\.1)/, r => r.abort()); const tenant = await live.signIn(context);
    const plan = value => { live.store.client.items.get('TENANT#' + tenant + '\0META').plan_id = value; };
    const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
    const post = (path, body) => page.evaluate(async ([p, b]) => { const raw = JSON.stringify(b), hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))), v => v.toString(16).padStart(2, '0')).join(''); const r = await fetch('/api/' + p, {method: 'POST', headers: {'Content-Type': 'application/json', 'x-amz-content-sha256': hash}, body: raw}); return r.status; }, [path, body]);
    await page.goto(live.origin + '/app/#members'); await page.locator('#shell:not([hidden])').waitFor();
    assert.equal(await post('workspaces', {name: 'Acme'}), 201); await page.reload(); await page.locator('#role-builder').waitFor({state:'attached'});

    // Pro: the role form and the retention form are locked, each naming Enterprise.
    await page.locator('[data-upgrade-for=role-builder]').waitFor();
    assert.equal(await page.locator('[data-upgrade-for=role-builder]').innerText(), 'Custom roles needs the Enterprise plan. This organization is on Pro. See plans');
    assert.equal(await page.locator('#role-builder').isVisible(), false);
    await page.goto(live.origin + '/app/#billing'); await page.locator('#plan-entitlements').waitFor();
    assert.equal(await page.locator('#retention-form').count(), 0);

    // Enterprise: define a role; it is listed and offered in the invitation form.
    plan('enterprise'); await page.goto(live.origin + '/app/#members'); await page.reload(); await page.locator('#role-builder').waitFor({state:'attached'});
    await page.waitForFunction(() => document.getElementById('role-form').inert === false);
    await page.locator('#role-form input[name=name]').fill('Auditor'); await page.locator('#role-form select[name=base]').selectOption('viewer'); await page.locator('#role-form button[type=submit]').click();
    await page.locator('#role-list li').waitFor();
    assert.match(await page.locator('#role-list li').innerText(), /^Auditor · Read-only level · every environment/);
    assert.deepEqual(await page.locator('#invite-member select[name=role] option').evaluateAll(list => list.map(option => option.textContent)), ['Read-only', 'Developer', 'Admin', 'Auditor (custom)']);
    if (process.env.SUPATRACE_PROOF_DIR) { mkdirSync(process.env.SUPATRACE_PROOF_DIR, {recursive: true}); await page.locator('#role-builder').screenshot({path: process.env.SUPATRACE_PROOF_DIR + '/members-custom-role.png'}); }

    // Enterprise: custom retention is saved and shown.
    await page.goto(live.origin + '/app/#billing'); await page.locator('#plan-entitlements').waitFor(); await page.waitForFunction(() => document.getElementById('retention-form')?.inert === false);
    await page.locator('#retention-form input[name=days]').fill('400'); await page.locator('#retention-form button[type=submit]').click();
    await page.waitForFunction(() => /kept 400 days/.test(document.getElementById('retention-status')?.textContent ?? ''));
    assert.match(await page.locator('#plan-limits').innerText(), /Retention\s+400 days/);
    assert.equal(live.store.client.items.get('TENANT#' + tenant + '\0META').retention_days, 400);
    assert.deepEqual(errors, []);
  } finally { await context.close(); await browser.close(); await live.close(); }
});
