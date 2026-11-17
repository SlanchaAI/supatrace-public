// Captures screenshots through the test harness. Usage:
//   node tests/screens.mjs after
import {start} from './harness.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import {launch} from './browser.mjs';
const out = process.env.SUPATRACE_SCREENSHOT_DIR || `test-artifacts/screenshots/${process.argv[2] || 'after'}`;
mkdirSync(out, {recursive: true});
const sizes = {desktop: {width: 1280, height: 800}, mobile: {width: 390, height: 844}};
const captures=[];
const browser = await launch();
const offline = async context => context.route(/^(?!http:\/\/127\.0\.0\.1)/, route => route.abort());
async function snap(name, size, setup, act) {
  const live = await start({google:true});
  const context = await browser.newContext({viewport: sizes[size], acceptDownloads: true});
  await offline(context);
  const path = await setup?.(live, context);
  const page = await context.newPage();
  await page.goto(live.origin + (path || '/app/'), {waitUntil: 'networkidle'});
  if (!path) await page.waitForFunction(() => !/Checking your session/.test(document.getElementById('status').textContent));
  await act?.(page);
  await page.screenshot({path: `${out}/${name}-${size}.png`, fullPage: true});
  captures.push({file:`${name}-${size}.png`,viewport:sizes[size],full_page:true,source:'synthetic-loopback-fixture',signed_in:setup?.signedIn===true});
  await context.close(); await live.close();
}
const signedIn = n => {
  const setup=async(live,context)=>{const tenant=await live.signIn(context);await live.seedRuns(tenant,n);};
  setup.signedIn=true;
  return setup;
};
async function nav(page, name) {
  const link = page.locator(`#rail a[data-nav="${name}"]`);
  const toggle=page.locator('#menu-toggle');
  if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded')!=='true') await toggle.click();
  await link.click();
  await page.locator(`#view-${name}:not([hidden])`).waitFor();
}
async function ready(page) {
  await page.waitForFunction(() => !/Checking/.test(document.getElementById('usage').textContent));
}
for (const size of Object.keys(sizes)) {
  await snap('landing', size, async () => '/');
  await snap('agent-setup', size, async () => '/agent-setup.html');
  await snap('app-signed-out', size);
  await snap('home', size, signedIn(5), async page => { await ready(page); await page.waitForSelector('#recent .run'); });
  await snap('traces', size, signedIn(5), async page => { await ready(page); await nav(page, 'traces'); await page.waitForSelector('#runs .run'); });
  await snap('account-download-ready', size, signedIn(3), async page => { await ready(page); await nav(page,'traces'); await page.evaluate(()=>Object.defineProperty(window,'showSaveFilePicker',{value:undefined,configurable:true})); await page.click('#export-account'); await page.locator('#download-account').waitFor({state:'visible'}); });
  await snap('traces-empty', size, signedIn(0), async page => { await ready(page); await nav(page, 'traces'); await page.waitForFunction(() => /No traces yet/.test(document.getElementById('runs').textContent)); });
  await snap('trace-open', size, signedIn(5), async page => {
    await ready(page);
    await nav(page, 'traces');
    await page.locator('#runs .run').first().click();
    await page.waitForSelector('#events li');
    await page.locator('#events summary').first().click();
  });
  await snap('agents', size, signedIn(1), async page => { await ready(page); await nav(page, 'agents'); await page.waitForSelector('#code'); });
  await snap('keys', size, signedIn(1), async page => { await ready(page); await nav(page, 'keys'); await page.waitForSelector('#keys .key'); });
  await snap('usage', size, signedIn(1), async page => { await ready(page); await nav(page, 'usage'); await page.waitForFunction(() => !/Checking/.test(document.getElementById('usage-page').textContent)); });
  await snap('billing', size, signedIn(1), async page => { await ready(page); await nav(page, 'billing'); await page.waitForFunction(() => !/Checking/.test(document.getElementById('plan-page').textContent)); });
  await snap('settings', size, signedIn(1), async page => { await ready(page); await nav(page, 'settings'); await page.waitForFunction(() => /Account ID:/.test(document.getElementById('account-line').textContent)); });
}
await browser.close();
writeFileSync(`${out}/manifest.json`,JSON.stringify({commit:process.env.GITHUB_SHA||null,source:'Candidate assets with the real API handler and in-memory stores; no live OAuth or customer data',captures},null,2));
writeFileSync(`${out}/README.txt`,'Synthetic candidate UI evidence, not hosted authentication acceptance.\nDesktop viewport: 1280 x 800. Mobile viewport: 390 x 844.\nFull-page images can be taller than the declared viewport.\nHomepage/setup use candidate static assets; signed-in views use seeded local sessions and in-memory trace fixtures. Google buttons are configured test options, not proof of live provider sign-in.\nSee manifest.json for the exact CI commit and per-image metadata.\n');
console.log('saved to', out);
