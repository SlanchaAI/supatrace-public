import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {start} from './harness.mjs';
import {launch} from './browser.mjs';

// Issue #117: create a second organization, switch between organizations from the rail, rename, transfer and leave.
test('owner creates a second organization, switches from the rail, and each organization keeps its own traces and billing', {timeout: 120000}, async () => {
  const live = await start(), browser = await launch(), contexts = [];
  try {
    const make = async id => { const c = await browser.newContext({viewport: {width: 1280, height: 900}}); contexts.push(c); await c.route(/^(?!http:\/\/127\.0\.0\.1)/, r => r.abort()); const tenant = await live.signIn(c, id); return {c, tenant, p: await c.newPage()}; };
    const owner = await make(4242), member = await make(5252), errors = []; for (const who of [owner, member]) who.p.on('pageerror', e => errors.push(e.message));
    const [run] = await live.seedRuns(owner.tenant, 1), shot = async (page, name) => { const dir = process.env.SUPATRACE_ORG_SCREENSHOT_DIR; if (dir) { mkdirSync(dir, {recursive: true}); await page.screenshot({path: `${dir}/${name}.png`, fullPage: true}); } };
    await owner.p.goto(live.origin + '/app/#members'); await owner.p.locator('#shell:not([hidden])').waitFor();
    // The personal organization is listed without any setup.
    assert.deepEqual(await owner.p.locator('#org-select option').allInnerTexts(), ['Personal workspace (personal)']);
    assert.match(await owner.p.locator('#org-list').innerText(), new RegExp('Personal workspace \\(personal\\) · owner · ' + owner.tenant + ' · current'));
    assert.equal(await owner.p.locator('#org-transfer').isVisible(), false); assert.equal(await owner.p.locator('#org-leave').isVisible(), false);
    await owner.p.locator('#org-create input').fill('Acme Inc'); await owner.p.locator('#org-create button').click();
    await owner.p.waitForURL(u => /^org-[a-f0-9]{32}$/.test(u.searchParams.get('workspace') ?? '')); await owner.p.locator('#shell:not([hidden])').waitFor();
    const org = new URL(owner.p.url()).searchParams.get('workspace');
    assert.deepEqual(await owner.p.locator('#org-select option').allInnerTexts(), ['Personal workspace (personal)', 'Acme Inc']); assert.equal(await owner.p.locator('#org-select').inputValue(), org);
    assert.equal(await owner.p.locator('#members-title').innerText(), 'Acme Inc'); assert.match(await owner.p.locator('#member-list').innerText(), new RegExp(owner.tenant + ' · Owner'));
    await shot(owner.p, 'org-created-members');
    // The new organization has no traces; the personal one still has its own.
    await owner.p.locator('#rail a[data-nav="traces"]').click(); await owner.p.waitForFunction(() => /0 traces/.test(document.querySelector('#page-note').textContent)); assert.doesNotMatch(await owner.p.locator('#runs').innerText(), new RegExp(run));
    await owner.p.locator('#rail a[data-nav="billing"]').click(); await owner.p.locator('#view-billing:not([hidden])').waitFor(); await owner.p.waitForFunction(() => !/Checking/.test(document.getElementById('plan-page').textContent));
    assert.equal(await owner.p.locator('#account-reload').isVisible(), false, 'the owner of a created organization reaches its billing page'); await shot(owner.p, 'org-billing');
    await owner.p.locator('#org-select').selectOption(owner.tenant); await owner.p.waitForURL(u => u.searchParams.get('workspace') === owner.tenant); await owner.p.locator('#shell:not([hidden])').waitFor();
    await owner.p.locator('#rail a[data-nav="traces"]').click(); await owner.p.waitForFunction(id => document.querySelector('#runs').textContent.includes(id), run); await shot(owner.p, 'org-switcher-personal');
    // Invite a member into the organization, rename it, hand it over.
    await owner.p.goto(live.origin + '/app/?workspace=' + org + '#members'); await owner.p.locator('#team-members:not([hidden])').waitFor();
    await owner.p.locator('#invite-member input').fill(member.tenant); await owner.p.locator('#invite-member select').selectOption('admin'); await owner.p.locator('#invite-member button').click(); await owner.p.locator('#invitation-link a').waitFor();
    await member.p.goto(live.origin + '/app/#members'); await member.p.locator('.pending-invite button').click(); await member.p.waitForURL(u => u.searchParams.get('workspace') === org); await member.p.locator('#shell:not([hidden])').waitFor();
    assert.equal(await member.p.locator('#org-leave').isVisible(), true); assert.equal(await member.p.locator('#org-rename').isVisible(), false); assert.equal(await member.p.locator('#org-transfer').isVisible(), false);
    await owner.p.reload(); await owner.p.locator('#org-transfer:not([hidden])').waitFor();
    await owner.p.locator('#org-rename input').fill('Acme Labs'); await owner.p.locator('#org-rename button').click(); await owner.p.waitForFunction(() => document.querySelector('#members-title')?.textContent === 'Acme Labs');
    await owner.p.locator('#org-transfer:not([hidden])').waitFor(); await owner.p.locator('#org-transfer select').selectOption(member.tenant); await owner.p.locator('#org-transfer button').click();
    await owner.p.waitForFunction(() => /Your role: admin/.test(document.querySelector('#members-role')?.textContent ?? '')); assert.equal(await owner.p.locator('#team-members').isVisible(), false);
    await member.p.reload(); await member.p.locator('#team-members:not([hidden])').waitFor(); assert.match(await member.p.locator('#members-role').innerText(), /owner/); assert.match(await member.p.locator('#member-list').innerText(), new RegExp(owner.tenant + ' · Admin')); await shot(member.p, 'org-transferred');
    // The previous owner leaves and lands on their personal organization.
    await owner.p.locator('#org-leave button').click(); await owner.p.waitForURL(u => u.search === ''); await owner.p.locator('#shell:not([hidden])').waitFor();
    assert.deepEqual(await owner.p.locator('#org-select option').allInnerTexts(), ['Personal workspace (personal)']);
    assert.equal(await owner.p.evaluate(async id => (await fetch('/api/runs?workspace=' + id)).status, org), 403);
    assert.deepEqual(errors, []);
  } finally { for (const c of contexts) await c.close(); await browser.close(); await live.close(); }
});
for (const width of [390, 320]) test(`the organization switcher fits and works in the menu at ${width}px`, {timeout: 60000}, async () => {
  const live = await start(), browser = await launch(), context = await browser.newContext({viewport: {width, height: 844}});
  try {
    await context.route(/^(?!http:\/\/127\.0\.0\.1)/, r => r.abort()); await live.signIn(context, 4242); const page = await context.newPage();
    await page.goto(live.origin + '/app/#members'); await page.locator('#shell:not([hidden])').waitFor();
    await page.locator('#org-create input').fill('Mobile org'); await page.locator('#org-create button').click(); await page.waitForURL(u => (u.searchParams.get('workspace') ?? '').startsWith('org-')); await page.locator('#shell:not([hidden])').waitFor();
    await page.locator('#menu-toggle').click(); assert.equal(await page.locator('#org-select').isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    const box = await page.locator('#org-select').boundingBox(); assert.ok(box.height >= 44 && box.x >= 0 && box.x + box.width <= width);
    await page.locator('#org-select').selectOption({index: 0}); await page.waitForURL(u => u.searchParams.get('workspace') === 'github-4242');
  } finally { await context.close(); await browser.close(); await live.close(); }
});

test('an owner deletes a created organization from the Members view by typing its name, and lands back in the personal one', {timeout: 90000}, async () => {
  const live = await start(), browser = await launch(), context = await browser.newContext();
  try {
    await context.route(/^(?!http:\/\/127\.0\.0\.1)/, r => r.abort()); await live.signIn(context);
    const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(live.origin + '/app/#members'); await page.locator('#shell:not([hidden])').waitFor();
    assert.equal(await page.locator('#org-delete').isHidden(), true, 'a personal organization has no delete');
    await page.locator('#org-create input[name=name]').fill('Short Lived'); await page.locator('#org-create button[type=submit]').click();
    await page.waitForURL(/workspace=org-/); await page.locator('#org-delete:not([hidden])').waitFor();
    const org = new URL(page.url()).searchParams.get('workspace');
    // The wrong name is refused and says why.
    await page.locator('#org-delete input[name=confirm]').fill('short lived'); await page.locator('#org-delete button[type=submit]').click();
    await page.waitForFunction(() => /The name does not match this organization/.test(document.getElementById('org-notice').textContent));
    await page.locator('#org-delete input[name=confirm]').fill('Short Lived'); await page.locator('#org-delete button[type=submit]').click();
    await page.waitForURL(url => !url.search.includes('workspace=')); await page.locator('#shell:not([hidden])').waitFor();
    assert.ok(Number.isSafeInteger(live.store.client.items.get('TENANT#' + org + '\0WORKSPACE#META').deleted_at));
    assert.ok(!(await page.locator('#org-select option').allInnerTexts()).some(text => text.includes('Short Lived')), 'it is gone from the switcher');
    assert.deepEqual(errors, []);
  } finally { await context.close(); await browser.close(); await live.close(); }
});


test('workspace creation limit shows upgrade guidance and unlocks through an owned paid plan',async()=>{
 const live=await start({plan:'free'}),browser=await launch(),context=await browser.newContext();try{
  await live.signIn(context,4242);const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(live.origin+'/app/#members');await page.locator('#org-create input').fill('First');await page.locator('#org-create button').click();await page.waitForURL(/workspace=org-/);
  const first=new URL(page.url()).searchParams.get('workspace');await page.locator('#org-create input').fill('Denied');await page.locator('#org-create button').click();
  await page.waitForFunction(()=>document.getElementById('org-notice').textContent.includes('Upgrade in Billing'));assert.equal(new URL(page.url()).searchParams.get('workspace'),first);
  live.store.client.items.get('TENANT#'+first+'\0META').plan_id='base';
  await page.locator('#org-create input').fill('Second');await page.locator('#org-create button').click();await page.waitForURL(u=>u.searchParams.get('workspace')!==first);
  assert.deepEqual(errors,[]);
 }finally{await context.close();await browser.close();await live.close();}
});
