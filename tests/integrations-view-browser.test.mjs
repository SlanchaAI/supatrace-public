import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';

const batch = (run, kind = 'note') => ({version: 1, batch_id: run + '-b', run_id: run, events: [{id: run + '-e', time: new Date().toISOString(), kind, name: 'synthetic', data: {}}]});

test('the Integrations view lists each source with what has really arrived and links to the public directory', async () => {
  const live = await start(), browser = await launch(), context = await browser.newContext();
  try {
    await context.route(/^(?!http:\/\/127\.0\.0\.1)/, r => r.abort()); const tenant = await live.signIn(context), key = await live.writeKey(tenant);
    for (const run of ['app-1', 'app-2']) await live.upload(key, batch(run)); await live.upload(key, batch('app-3', 'error')); await live.upload(key, batch('otlp.' + 'a'.repeat(32)));
    const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(live.origin + '/app/'); await page.locator('#shell:not([hidden])').waitFor();
    assert.equal(await page.locator('#view-integrations').isHidden(), true);
    const nav = page.locator('#rail a[data-nav="agents"]'); assert.equal((await nav.innerText()).trim(), 'Agents'); await nav.click();
    await page.locator('#view-agents:not([hidden])').waitFor(); await page.locator('#integrations-sources .card[data-source="uploads"]').waitFor();
    assert.equal(new URL(page.url()).hash, '#agents'); assert.equal(await nav.getAttribute('aria-current'), 'page'); assert.equal(await page.locator('#view-home').isHidden(), true);
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Agents', 'the heading takes focus like the other views');
    const card = id => page.locator(`#integrations-sources .card[data-source="${id}"]`);
    assert.match(await card('uploads').innerText(), /SDK and direct uploads\s+3 traces · newest received .+\s+1 trace with an error event · latest received/);
    assert.match(await card('otlp').innerText(), /OpenTelemetry \(OTLP\)\s+1 trace · newest received .+\s+No trace with an error event\./);
    for (const id of ['langfuse', 'import-files', 'claude-hooks']) { assert.match(await card(id).innerText(), /None yet\./); assert.equal(await card(id).getAttribute('data-state'), 'none'); }
    assert.equal(await card('otlp').locator('a').getAttribute('href'), '/docs/frameworks/opentelemetry/#otlp'); assert.equal(await card('otlp').locator('a').getAttribute('aria-label'), 'Setup guide: OpenTelemetry (OTLP)');
    assert.equal(await page.getByRole('link', {name: 'integrations directory', exact: true}).getAttribute('href'), '/integrations/');
    assert.match(await page.locator('#integrations-scan').innerText(), /4 traces in this environment/); assert.match(await page.locator('#integrations-jobs-note').innerText(), /None yet\./);
    if (process.env.SUPATRACE_PROOF_DIR) { mkdirSync(process.env.SUPATRACE_PROOF_DIR, {recursive: true}); await page.screenshot({path: process.env.SUPATRACE_PROOF_DIR + '/integrations-view.png', fullPage: true}); }
    // New data shows after Refresh, and when the view is opened again.
    await live.upload(key, batch('lf.checkout')); await page.locator('#integrations-refresh').click();
    await page.waitForFunction(() => /1 trace ·/.test(document.querySelector('#integrations-sources .card[data-source="langfuse"]')?.textContent ?? ''));
    await page.locator('#rail a[data-nav="traces"]').click(); await page.locator('#view-integrations').waitFor({state: 'hidden'}); await live.upload(key, batch('app-4')); await nav.click();
    await page.waitForFunction(() => /4 traces ·/.test(document.querySelector('#integrations-sources .card[data-source="uploads"]')?.textContent ?? ''));
    // A partial read and unrecorded error state are worded as such, not as "nothing received" or "no errors".
    const real = await (await context.request.get(live.origin + '/api/integrations', {headers: {cookie: (await context.cookies()).map(c => c.name + '=' + c.value).join('; ')}})).json();
    const partial = {...real, scanned: {traces: 800, truncated: true}, sources: real.sources.map(source => source.id === 'uploads' ? {...source, traces: 800, error_traces: 0, unknown_error_traces: 3, last_error_trace_at: null} : {...source, traces: 0, error_traces: 0, unknown_error_traces: 0, first_received_at: null, last_received_at: null, last_error_trace_at: null})};
    await context.route('**/api/integrations', r => r.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(partial)})); await page.locator('#integrations-refresh').click();
    await page.waitForFunction(() => /lower bound/.test(document.getElementById('integrations-scan').textContent));
    assert.match(await card('otlp').innerText(), /No trace from this source among the 800 traces read\./); assert.doesNotMatch(await card('otlp').innerText(), /No retained trace from this source/);
    assert.match(await card('uploads').innerText(), /800 traces · newest among the traces read received .+\s+No error event recorded among the traces read\. Error state was not recorded for 3 older traces\./); assert.doesNotMatch(await card('uploads').innerText(), /No trace with an error event/);
    await context.unroute('**/api/integrations');
    // A failed read says so; it does not leave stale numbers looking current or show zeros.
    await context.route('**/api/integrations', r => r.fulfill({status: 503, contentType: 'application/json', body: '{"error":"unavailable"}'})); await page.locator('#integrations-refresh').click();
    await page.waitForFunction(() => /could not be loaded/.test(document.getElementById('integrations-status').textContent)); await context.unroute('**/api/integrations');
    // A direct link opens the view after sign-in, and the page links out to real pages.
    await page.goto(live.origin + '/app/#integrations'); await page.locator('#integrations-sources .card[data-source="uploads"]').waitFor(); assert.equal(await page.locator('#view-integrations').isHidden(), false);
    assert.equal((await context.request.get(live.origin + '/integrations/')).status(), 200); assert.equal((await context.request.get(live.origin + '/docs/frameworks/opentelemetry/')).status(), 200);
    await page.locator('#rail a[data-nav=agents]').click();
    await page.locator('#view-agents:not([hidden])').waitFor(); assert.equal(new URL(page.url()).hash, '#agents');
    assert.deepEqual(errors, []);
  } finally { await context.close(); await browser.close(); await live.close(); }
});

test('a workspace viewer can open Integrations for the shared workspace and sees no import jobs', async () => {
  // Pro: the scenario invites a Read-only (viewer) member, a role the Free plan does not include.
  const live = await start({plan: 'pro'}), browser = await launch(), owner = await browser.newContext(), member = await browser.newContext();
  try {
    for (const context of [owner, member]) await context.route(/^(?!http:\/\/127\.0\.0\.1)/, r => r.abort());
    const cookies = new Map(), signIn = (context, id) => live.signIn({addCookies: async value => { cookies.set(context, value.map(c => c.name + '=' + c.value).join('; ')); await context.addCookies(value); }}, id);
    const tenant = await signIn(owner, 4242), viewer = await signIn(member, 6262); await live.upload(await live.writeKey(tenant), batch('team-run'));
    const post = async (context, path, data) => { const r = await fetch(live.origin + '/api/' + path, {method: 'POST', headers: {cookie: cookies.get(context), origin: live.origin, 'content-type': 'application/json'}, body: JSON.stringify(data)}); assert.ok(r.ok, path + ' ' + r.status); return r.json(); };
    await post(owner, 'workspaces', {name: 'Shared'}); const invite = await post(owner, 'workspaces/invite', {recipient_id: viewer, role: 'viewer'}); await post(member, 'workspaces/accept', {workspace_id: tenant, token: invite.token});
    const page = await member.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(live.origin + '/app/?workspace=' + tenant + '#integrations'); await page.locator('#shell:not([hidden])').waitFor(); await page.locator('#integrations-sources .card[data-source="uploads"]').waitFor();
    assert.equal(await page.locator('#rail a[data-nav="agents"]').isVisible(), true); assert.equal(await page.locator('#rail a[data-nav="keys"]').isHidden(), true);
    assert.match(await page.locator('#integrations-sources .card[data-source="uploads"]').innerText(), /1 trace ·/);
    assert.match(await page.locator('#integrations-jobs-note').innerText(), /kept for the workspace owner/); assert.equal(await page.locator('#integrations-jobs li').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await owner.close(); await member.close(); await browser.close(); await live.close(); }
});
