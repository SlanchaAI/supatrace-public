import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';
import {digest} from '../src/aws-auth.mjs';
import {signInIdentity} from '../src/identity-links.mjs';
import {createFixtureSession} from './fixture-session.mjs';

const github = (id, email) => ({provider: 'github', subject: id, email}), google = (sub, email) => ({provider: 'google', subject: sub, email});
const linkRow = (store, native) => store._get({pk: 'IDENTITY#' + native, sk: 'LINK'});
async function open(live, browser, githubId) {
  const context = await browser.newContext(); await context.route(/^(?!http:\/\/127\.0\.0\.1)/, r => r.abort()); await live.signIn(context, githubId);
  const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(live.origin + '/app/#settings'); await page.locator('#shell:not([hidden])').waitFor(); await page.locator('#identities-section:not([hidden])').waitFor(); await page.locator('#identities-list li').first().waitFor();
  return {context, page, errors};
}

test('Settings lists linked sign-in methods and unlinking takes a confirming click and signs out', async () => {
  const live = await start({google: true}), browser = await launch();
  try {
    // A GitHub account, then a Google sign-in with the same verified address: linked at sign-in.
    assert.equal((await signInIdentity(live.store, github(4242, 'ada@example.com'))).tenant_id, 'github-4242');
    assert.deepEqual(await signInIdentity(live.store, google('g-ada', 'ada@example.com')), {tenant_id: 'github-4242', via: 'verified_email', session_epoch: 0});
    const {context, page, errors} = await open(live, browser, 4242);
    const rows = page.locator('#identities-list li'); assert.equal(await rows.count(), 2);
    assert.match(await rows.nth(0).innerText(), /^GitHub · this account's own sign-in · verified email ada@example\.com$/);
    assert.match(await rows.nth(1).innerText(), /^Google · verified email ada@example\.com · linked .+ at sign-in\s+Unlink$/);
    assert.equal(await rows.nth(0).locator('button').count(), 0, 'the account keeps its own sign-in method'); assert.equal(await page.locator('#identities-choice').isHidden(), true);
    if (process.env.SUPATRACE_PROOF_DIR) { mkdirSync(process.env.SUPATRACE_PROOF_DIR, {recursive: true}); await page.locator('#identities-section').scrollIntoViewIfNeeded(); await page.locator('#identities-section').screenshot({path: process.env.SUPATRACE_PROOF_DIR + '/settings-linked-sign-in-methods.png'}); }
    const unlink = rows.nth(1).locator('button'); await unlink.click();
    assert.equal(await unlink.innerText(), 'Confirm: unlink and sign out everywhere'); assert.match(await page.locator('#identities-status').innerText(), /signs out every session/);
    assert.equal((await linkRow(live.store, 'google-' + digest('g-ada'))).link_state, 'linked', 'one click changes nothing');
    await page.evaluate(()=>{sessionStorage.setItem('supatrace-first-trace:synthetic','{}');sessionStorage.setItem('supatrace-setup-code','{}');});
    await unlink.click(); await page.locator('#signed-out:not([hidden])').waitFor();
    assert.equal(await page.evaluate(()=>Object.keys(sessionStorage).some(k=>k.startsWith('supatrace-first-trace:')||k==='supatrace-setup-code')),false);
    assert.equal((await linkRow(live.store, 'google-' + digest('g-ada'))).link_state, 'separate');
    assert.equal((await signInIdentity(live.store, google('g-ada', 'ada@example.com'))).tenant_id, 'google-' + digest('g-ada'));
    assert.deepEqual(errors, []); await context.close();
  } finally { await browser.close(); await live.close(); }
});

test('two existing accounts with the same verified email get an explicit link-or-keep choice in Settings', async () => {
  const live = await start({google: true}), browser = await launch();
  try {
    // Both accounts exist before either provider reports the address, so nothing is linked at sign-in.
    for (const [id, sub, email] of [[5252, 'g-bo', 'bo@example.com'], [6262, 'g-cy', 'cy@example.com']]) {
      await signInIdentity(live.store, github(id, null)); await signInIdentity(live.store, google(sub, null));
      assert.equal((await signInIdentity(live.store, github(id, email))).via, 'own_account'); assert.equal((await signInIdentity(live.store, google(sub, email))).via, 'own_account');
    }
    // Keep separate.
    const keep = await open(live, browser, 5252); await keep.page.locator('#identities-choice:not([hidden])').waitFor();
    assert.match(await keep.page.locator('#identities-choice-text').innerText(), /Another SupaTrace account signs in with Google and has the same verified email\. The two accounts are separate\./);
    assert.match(await keep.page.locator('#identities-choice-effect').innerText(), /signing in with GitHub will open the Google account instead of this one\. This account's traces, keys and billing stay here and are not copied/);
    await keep.page.locator('#identities-separate').click(); await keep.page.locator('#identities-choice').waitFor({state: 'hidden'});
    assert.match(await keep.page.locator('#identities-status').innerText(), /stay separate/); assert.equal((await linkRow(live.store, 'github-5252')).link_state, 'separate');
    await keep.page.reload(); await keep.page.locator('#identities-list li').first().waitFor(); assert.equal(await keep.page.locator('#identities-choice').isHidden(), true);
    assert.deepEqual(keep.errors, []); await keep.context.close();
    // Link: a first click only arms the button; the second links and signs out.
    const join = await open(live, browser, 6262); await join.page.locator('#identities-choice:not([hidden])').waitFor();
    const button = join.page.locator('#identities-link'); assert.equal(await button.innerText(), 'Open the Google account when I sign in with GitHub'); await button.click();
    assert.equal(await button.innerText(), 'Confirm: link and sign out'); assert.equal(await linkRow(live.store, 'github-6262'), null);
    await button.click(); await join.page.locator('#signed-out:not([hidden])').waitFor();
    const saved = await linkRow(live.store, 'github-6262'); assert.equal(saved.link_state, 'linked'); assert.equal(saved.target_tenant, 'google-' + digest('g-cy'));
    assert.deepEqual(await signInIdentity(live.store, github(6262, 'cy@example.com')), {tenant_id: 'google-' + digest('g-cy'), via: 'link', session_epoch: 0});
    assert.deepEqual(join.errors, []); await join.context.close();
  } finally { await browser.close(); await live.close(); }
});

const emailInstructions = 'This account signs in with your email address. Request a sign-in link from the sign-in page; it works once and expires in 15 minutes.';
for (const width of [1280, 390]) for (const method of ['email-link', 'email-password', 'github', 'google', 'sso', 'chatgpt', 'unknown']) {
  test(`Settings recovery copy and Members labels for ${method} at ${width}px`, {timeout: 60000}, async () => {
    const live = await start({google: true}), browser = await launch(), context = await browser.newContext({viewport: {width, height: 844}});
    try {
      await context.route(/^(?!http:\/\/127\.0\.0\.1)/, route => route.abort());
      const email = 'recovery@example.com';
      const account = method === 'email-link' ? await live.store.createPasswordlessEmailAccount(email)
        : method === 'email-password' ? await live.store.createVerifiedEmailAccount(email, 'synthetic-password-hash-for-copy-test')
        : method === 'google' ? await live.store.getOrCreateGoogleTenant('recovery-copy')
        : method === 'sso' ? await live.store.getOrCreateSsoTenant(email)
        : method === 'chatgpt' ? await live.store.getOrCreateChatGptTenant('recovery-copy')
        : await live.store.getOrCreateTenant(4242);
      if (method === 'unknown') await live.store._send('UpdateCommand', {Key: {pk: 'TENANT#' + account.tenant_id, sk: 'META'}, UpdateExpression: 'SET provider = :provider', ExpressionAttributeValues: {':provider': 'future'}});
      const token = await createFixtureSession(live.store, account.tenant_id);
      await context.addCookies([{name: '__Host-supatrace', value: token, domain: '127.0.0.1', path: '/', secure: true, httpOnly: true, sameSite: 'Lax'}]);
      const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(live.origin + '/app/#settings'); await page.locator('#shell:not([hidden])').waitFor();
      const note = await page.locator('#account-sign-in-note').innerText();
      if (method.startsWith('email-')) assert.equal(note, emailInstructions);
      else if (method === 'sso') assert.equal(note, 'This account signs in with SSO. On the sign-in page, choose SSO and enter your work email. Ask your organization to restore access if needed.');
      else if (method === 'unknown') assert.match(note, /^This account signs in with SSO or another method\./);
      else assert.ok(note.includes('This account signs in with ' + {github: 'GitHub', google: 'Google', chatgpt: 'ChatGPT (experimental)'}[method] + '.'));
      const recovery = await page.locator('#account-recovery').innerText();
      assert.match(recovery, /A different email or an unlinked provider opens a different account\. Data is never merged\./);
      assert.match(recovery, /If you lose your authenticator, two-factor recovery codes are the only way back in\. Two-factor authentication cannot be reset by email\./);
      assert.equal(await page.getByRole('heading', {name: 'Account recovery', exact: true}).count(), 1);
      assert.equal(await page.getByRole('heading', {name: 'Find an existing workspace', exact: true}).count(), 0);
      if (['github', 'google'].includes(method)) {
        await page.locator('#identities-section:not([hidden])').waitFor();
        assert.match(await page.locator('#identities-section').innerText(), /GitHub and Google can open the same account when both verify the same email/);
      } else {
        await page.waitForLoadState('networkidle');
        assert.equal(await page.locator('#identities-section').isHidden(), true);
        assert.doesNotMatch(await page.locator('#view-settings').innerText(), /Linking is available|GitHub and Google can open|first time the second provider/);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.goto(live.origin + '/app/#members'); await page.locator('#org-list li').first().waitFor();
      assert.equal(await page.locator('#org-list').innerText(), (method.startsWith('email-') ? email : 'Personal workspace') + ' · owner · current');
      assert.equal(await page.locator('#org-list li').first().getAttribute('data-org'), account.tenant_id, 'internal selector retains the ID');
      assert.equal((await page.locator('#org-list').innerText()).includes(account.tenant_id), false);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
    } finally { await context.close(); await browser.close(); await live.close(); }
  });
}

test('email recovery remains clear when sign-in methods cannot be loaded', async () => {
  const live = await start(), browser = await launch(), context = await browser.newContext();
  try {
    await context.route(/^(?!http:\/\/127\.0\.0\.1)/, route => route.abort());
    const account = await live.store.createPasswordlessEmailAccount('recovery@example.com'), token = await createFixtureSession(live.store, account.tenant_id);
    await context.addCookies([{name: '__Host-supatrace', value: token, domain: '127.0.0.1', path: '/', secure: true, httpOnly: true, sameSite: 'Lax'}]);
    const page = await context.newPage();
    await page.route('**/api/auth/identities', route => route.fulfill({status: 500, json: {error: 'synthetic'}}));
    await page.goto(live.origin + '/app/#settings'); await page.locator('#shell:not([hidden])').waitFor();
    await page.locator('#identities-status').filter({hasText: 'could not be loaded'}).waitFor();
    assert.equal(await page.locator('#account-sign-in-note').innerText(), emailInstructions);
    assert.doesNotMatch(await page.locator('#view-settings').innerText(), /GitHub and Google can open|Linking is available/);
  } finally { await context.close(); await browser.close(); await live.close(); }
});
