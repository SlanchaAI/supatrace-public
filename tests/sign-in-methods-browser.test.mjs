import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';
import {digest} from '../src/aws-auth.mjs';
import {signInIdentity} from '../src/identity-links.mjs';

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
