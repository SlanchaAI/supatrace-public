import test from 'node:test';
import assert from 'node:assert/strict';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';

test('Settings delivers priority support and refresh relocks paid controls after downgrade', {timeout: 45000}, async () => {
  const mail = [], live = await start({plan: 'pro', configureEnvironment: env => {env.EMAIL_FROM = 'support@supatrace.dev'; env.sendEmail = async value => mail.push(value);}}), browser = await launch(), context = await browser.newContext();
  try {
    await context.route(/^(?!http:\/\/127\.0\.0\.1)/, route => route.abort());
    const tenant = await live.signIn(context), page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(live.origin + '/app/#settings'); await page.locator('#support-section').waitFor();
    assert.deepEqual(await page.locator('#support-section a').evaluateAll(links => links.map(link => [link.textContent, link.getAttribute('href')])), [['Docs', '/docs/'], ['Status', '/status/'], ['Email support', 'mailto:support@supatrace.dev']]);
    await page.locator('#support-form input[name=email]').fill('customer@example.test');
    await page.locator('#support-form input[name=subject]').fill('Synthetic browser support'); await page.locator('#support-form textarea').fill('Synthetic delivery proof');
    await page.locator('#support-form input[name=priority]').check(); assert.equal(await page.locator('#support-form input[name=contract]').isDisabled(), true);
    await page.locator('#support-form button').click(); await page.locator('#support-result').filter({hasText: 'Delivered to priority support.'}).waitFor(); assert.equal(mail.length, 1); assert.match(mail[0].subject, /^\[PRIORITY\]/);
    live.store.client.items.get('TENANT#' + tenant + '\0META').plan_id = 'base';
    await page.goto(live.origin + '/app/#billing'); await page.locator('#billing-refresh').click(); await page.waitForFunction(() => document.querySelector('#support-plan').textContent === 'Base support');
    assert.equal(await page.locator('#support-form input[name=priority]').isDisabled(), true); assert.equal(await page.locator('#support-form input[name=priority]').isChecked(), false);
    live.store.client.items.get('TENANT#' + tenant + '\0META').plan_id = 'free'; await page.locator('#billing-refresh').click();
    await page.waitForFunction(() => document.querySelector('#support-form').inert); assert.equal(await page.locator('#support-result').textContent(), 'This support form needs Base or higher. Upgrade in Billing, or email support@supatrace.dev.'); assert.deepEqual(errors, []);
  } finally {await context.close(); await browser.close(); await live.close();}
});

test('organization support uses the selected workspace instead of the personal plan', {timeout: 60000}, async () => {
  const mail = [], live = await start({configureEnvironment: env => {env.EMAIL_FROM = 'support@supatrace.dev'; env.sendEmail = async value => mail.push(value);}}), browser = await launch(), context = await browser.newContext();
  try {
    await context.route(/^(?!http:\/\/127\.0\.0\.1)/, route => route.abort());
    const tenant = await live.signIn(context), page = await context.newPage(), requests = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(live.origin + '/app/#members'); await page.locator('#org-create input').fill('Support scope organization'); await page.locator('#org-create button').click();
    await page.waitForURL(/workspace=org-/); const org = new URL(page.url()).searchParams.get('workspace');
    live.store.client.items.get('TENANT#' + org + '\0META').plan_id = 'pro';
    page.on('request', request => {const url = new URL(request.url()); if (url.pathname === '/api/support') requests.push(url);});
    await page.goto(live.origin + '/app/?workspace=' + org + '#settings'); await page.reload();
    await page.waitForFunction(() => document.querySelector('#support-plan')?.textContent.endsWith('support'));
    assert.equal(await page.locator('#support-plan').textContent(), 'Pro support');
    await page.locator('#support-form input[name=email]').fill('customer@example.test'); await page.locator('#support-form input[name=subject]').fill('Organization delivery'); await page.locator('#support-form textarea').fill('Selected organization only.'); await page.locator('#support-form input[name=priority]').check(); await page.locator('#support-form button').click();
    await page.locator('#support-result').filter({hasText: 'Delivered to priority support.'}).waitFor();
    assert.equal(mail.length, 1); assert.match(mail[0].text, new RegExp('Workspace: ' + org)); assert.ok(requests.length >= 2); assert.ok(requests.every(url => url.searchParams.get('workspace') === org));
    live.store.client.items.get('TENANT#' + tenant + '\0META').plan_id = 'pro'; live.store.client.items.get('TENANT#' + org + '\0META').plan_id = 'base';
    await page.reload(); await page.waitForFunction(() => document.querySelector('#support-plan')?.textContent === 'Base support'); assert.equal(await page.locator('#support-form input[name=priority]').isDisabled(), true); assert.deepEqual(errors, []);
  } finally {await context.close(); await browser.close(); await live.close();}
});
