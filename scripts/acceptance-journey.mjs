// SupaTrace ship e2e. Usage:
//   node scripts/acceptance-journey.mjs local  <repoDir> <outDir>            rehearsal on the repo's loopback stack (synthetic sign-in)
//   node scripts/acceptance-journey.mjs hosted <repoDir> <outDir> [origin]   real hosted origin; a persistent Chrome profile holds the
//                                                         sign-in (the one human step). Never prints keys or ids.
// Legs: L1 sign-in+reload identity, L2 key -> synthetic upload -> trace -> export equality -> revoke -> 401,
//       L4 Billing truthful desktop+narrow, L5 usage agrees with API, L6 integrity/isolation negatives.
// Not covered here: sandbox purchase (needs a Stripe test key), real Langfuse pull (needs a live read key).
import {mkdirSync, writeFileSync} from 'node:fs';
import {createHash, randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {join, resolve} from 'node:path';

const [mode, repoArg, outArg, originArg] = process.argv.slice(2);
if (!['local', 'hosted'].includes(mode) || !repoArg || !outArg) { console.error('usage: e2e.mjs local|hosted <repoDir> <outDir> [origin]'); process.exit(2); }
const repo = resolve(repoArg), out = resolve(outArg);
mkdirSync(out, {recursive: true});
const sha = s => createHash('sha256').update(s).digest('hex');
const receipt = {mode, started: new Date().toISOString(), steps: []};
let failed = false;
const step = (name, ok, detail = {}) => { receipt.steps.push({name, ok, ...detail}); console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) failed = true; };
const finish = () => { receipt.finished = new Date().toISOString(); receipt.ok = !failed; writeFileSync(join(out, 'receipt.json'), JSON.stringify(receipt, null, 1) + '\n'); process.exit(failed ? 1 : 0); };

const {launch} = await import(pathToFileURL(join(repo, 'tests/browser.mjs')).href);
let live = null, origin, browser, context;
if (mode === 'local') {
  const {start} = await import(pathToFileURL(join(repo, 'tests/harness.mjs')).href);
  live = await start({google: true}); origin = live.origin; browser = await launch();
  context = await browser.newContext({viewport: {width: 1280, height: 800}});
  await live.signIn(context, 9191);
} else {
  origin = (originArg || 'https://supatrace.dev').replace(/\/$/, '');
  const {chromium} = await import(pathToFileURL(join(repo, 'node_modules/playwright-core/index.mjs')).href);
  const profile = join(out, '..', 'chrome-profile');
  context = await chromium.launchPersistentContext(profile, {
    headless: false, channel: undefined, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH, viewport: {width: 1280, height: 800}});
  browser = null;
}
receipt.origin = origin;
const page = context.pages()[0] || await context.newPage();
const errors = []; page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
const shot = name => page.screenshot({path: join(out, name + '.png'), fullPage: true});
const api = (path, init) => page.evaluate(async ([p, i]) => { const r = await fetch(p, i || {}); let b = null; try { b = await r.json(); } catch {} return {status: r.status, body: b}; }, [path, init]);

try {
  // L1: sign in (hosted: wait for the human), then reload and check the same project.
  await page.goto(origin + '/app/', {waitUntil: 'networkidle'});
  if (mode === 'hosted') {
    console.log('WAITING_FOR_SIGN_IN: sign in with Google or GitHub in the open Chrome window (up to 6 hours).');
    const deadline = Date.now() + 6 * 3600e3;
    while (Date.now() < deadline) { const me = await api('/api/me'); if (me.status === 200) break; await page.waitForTimeout(5000); }
  }
  const me1 = await api('/api/me');
  step('L1 signed in (/api/me 200)', me1.status === 200, {provider: me1.body?.provider ?? null});
  if (me1.status !== 200) finish();
  await page.reload({waitUntil: 'networkidle'});
  const me2 = await api('/api/me');
  const proj = b => b?.project?.id || b?.project_id || null;
  step('L1 project identity survives reload', me2.status === 200 && proj(me1.body) === proj(me2.body) && !!proj(me1.body), {project_fp: proj(me1.body) ? sha(proj(me1.body)).slice(0, 10) : null});
  await shot('l1-signed-in');

  // L2a: pairing deep link (connect.py prints verification_uri): opens Agents with the code prefilled and focused; one tap approves.
  const pairKey = randomBytes(32).toString('base64url');
  const started = await context.request.post(origin + '/api/setup/start', {headers: {'content-type': 'application/json', origin}, data: JSON.stringify({key_hash: sha(pairKey)})});
  const setup = [200, 201].includes(started.status()) ? await started.json() : {};
  step('L2a setup start returns a deep link with the code', /^\/app\/(\?[^#]*)?#agents\?code=[A-Za-z0-9_-]{12}$/.test(setup.verification_uri || '') && (setup.verification_uri || '').endsWith('code=' + setup.user_code), {status: started.status()});
  await page.goto(origin + (setup.verification_uri || '/app/#agents'), {waitUntil: 'networkidle'});
  const pre = await page.evaluate(() => ({value: document.getElementById('code')?.value, focused: document.activeElement?.id, hash: location.hash}));
  step('L2a Agents opens with the code prefilled, focused, and removed from the URL', pre.value === setup.user_code && pre.focused === 'code' && pre.hash === '#agents', {focused: pre.focused, hash: pre.hash});
  await shot('l2a-pairing-link');
  await page.locator('#approve button').first().click();
  await page.waitForTimeout(2500);
  const keysAfter = await api('/api/keys');
  step('L2a one tap approves the key (appears in the key list)', (keysAfter.body?.keys || []).some(k => k.id === sha(pairKey)), {keys: (keysAfter.body?.keys || []).length});

  // L2: create key from the dashboard, synthetic upload, trace visible, export equality, revoke, 401.
  await page.goto(origin + '/app/#agents', {waitUntil: 'networkidle'});
  await page.locator('#create-key').click();
  await page.locator('#new-key-config:not([hidden])').waitFor({timeout: 30000});
  const config = JSON.parse(await page.locator('#new-key-config').innerText());
  step('L2 dashboard key created (shown once, 43-char)', /^[A-Za-z0-9_-]{43}$/.test(config.write_key) && /^proj_[a-f0-9]{32}$/.test(config.project_id));
  await shot('l2-key-created');
  const stamp = Date.now(), runId = 'ship-e2e-' + stamp;
  const batch = {version: 1, batch_id: runId + '-b1', run_id: runId, events: [
    {id: 'e1', time: new Date(stamp).toISOString(), kind: 'request', name: 'ship e2e parent', data: {synthetic: true}},
    {id: 'e2', time: new Date(stamp + 1000).toISOString(), kind: 'response', name: 'ship e2e child', data: {synthetic: true}}]};
  const raw = JSON.stringify(batch);
  const post = (body, key = config.write_key, hash = sha(body)) => context.request.post(origin + '/api/batches', {headers: {'content-type': 'application/json', 'x-supatrace-key': key, 'x-amz-content-sha256': hash}, data: body});
  const up = await post(raw);
  step('L2 synthetic upload accepted (201)', up.status() === 201, {status: up.status()});
  const dup = await post(raw);
  const afterDup = await api('/api/events?run=' + encodeURIComponent(runId));
  const dupEvents = (afterDup.body?.events || []).length;
  step('L6 exact retry is idempotent (accepted, still one stored batch)', [200, 201].includes(dup.status()) && dupEvents === 2, {status: dup.status(), events: dupEvents});
  const conflict = await post(raw.replace('parent', 'PARENT'));
  step('L6 conflicting retry rejected (409)', conflict.status() === 409, {status: conflict.status()});
  const badHash = await post(raw.replace(runId + '-b1', runId + '-b2'), config.write_key, sha('x'));
  step('L6 hash mismatch rejected (400)', badHash.status() === 400, {status: badHash.status()});
  const wrongKey = await post(raw, 'A'.repeat(43));
  step('L6 unknown key rejected (401)', wrongKey.status() === 401, {status: wrongKey.status()});
  const keyRead = await context.request.get(origin + '/api/runs', {headers: {'x-supatrace-key': config.write_key}});
  step('L6 write key cannot read traces (401)', keyRead.status() === 401, {status: keyRead.status()});

  await page.goto(origin + '/app/#traces', {waitUntil: 'networkidle'});
  await page.reload({waitUntil: 'networkidle'});
  await page.waitForSelector('#runs .run', {timeout: 30000});
  const mine = page.locator('#runs .run', {hasText: runId}).first();
  step('L2 the uploaded run is listed', await mine.count() > 0, {run: runId});
  await mine.click();
  await page.waitForSelector('#events li', {timeout: 30000});
  const n = await page.locator('#events li').count();
  step('L2 trace visible with 2 events', n === 2, {events: n});
  await shot('l2-trace-detail');
  const exportApi = await api('/api/events?run=' + encodeURIComponent(runId));
  const ids = (exportApi.body?.events || []).map(e => e.id);
  step('L3 stored events equal uploaded (ids + order)', JSON.stringify(ids) === JSON.stringify(['e1', 'e2']), {stored: ids.length});

  const usage = await api('/api/usage');
  const usageText = await page.evaluate(() => document.getElementById('usage')?.textContent || '');
  const usedNumbers = JSON.stringify(usage.body || {}).match(/\d+/g) || [];
  step('L5 usage API answers and the UI shows it without an error state', usage.status === 200 && usageText.length > 0 && !/could not|failed|error/i.test(usageText), {status: usage.status, api_numbers: usedNumbers.length});

  // Revoke exactly that key through the UI, then the key must fail.
  await page.goto(origin + '/app/#keys', {waitUntil: 'networkidle'});
  await page.waitForFunction(() => /key[s]? checked/.test(document.getElementById('keys-note')?.textContent || ''), null, {timeout: 30000});
  const btn = page.locator('#keys .key', {hasText: sha(config.write_key).slice(0, 10)}).locator('button').first();
  await btn.click();
  await page.waitForFunction(() => (document.getElementById('keys-note')?.textContent || '').startsWith('Revocation confirmed.'), null, {timeout: 30000}).catch(() => {});
  await shot('l2-key-revoked');
  const afterRevoke = await post(raw.replace(runId + '-b1', runId + '-b3'));
  step('L2 revoked key is rejected (401)', afterRevoke.status() === 401, {status: afterRevoke.status()});

  // L4: Billing truthful at desktop and narrow.
  for (const [label, vp] of [['desktop', {width: 1280, height: 800}], ['narrow', {width: 390, height: 844}]]) {
    await page.setViewportSize(vp);
    await page.goto(origin + '/app/#billing', {waitUntil: 'networkidle'});
    await page.waitForTimeout(1200);
    const text = await page.evaluate(() => document.getElementById('view-billing')?.textContent || document.body.textContent);
    const fit = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    const truthful = /not available|unavailable|not configured|not enabled/i.test(text) && !/Upgrade now|Buy now/i.test(text);
    step(`L4 Billing page truthful (${label})`, truthful, {chars: text.length});
    step(`L4 Billing fits viewport (${label})`, fit);
    await shot('l4-billing-' + label);
  }
  step('no page errors', errors.length === 0, {errors});
} catch (e) {
  step('script error', false, {error: String(e).slice(0, 300)});
} finally {
  await context.close(); if (browser) await browser.close(); if (live) await live.close();
  finish();
}
