// Contract for the static public pages: shared chrome and generated blocks are the
// stamped output of scripts/site-pages.mjs, every internal link resolves, pages stay
// CSP-safe, and the pricing page shows exactly the approved plan table in src/plans.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync, statSync} from 'node:fs';
import {PAGES, NAV, FOOTER, ORIGIN, stamp, pageUrl, format, planCards, planCompare, planOverage, plansToday} from '../scripts/site-pages.mjs';
import {PLAN_LIMITS} from '../src/plan-limits.mjs';
import {PLANS, FEATURES, PLAN_CATALOG, accountPlanConfiguration} from '../src/plans.mjs';

const read = file => readFileSync(pageUrl(file), 'utf8');
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ');
function resolves(href) {
  const path = href.split('#')[0].split('?')[0];
  if (path.startsWith('/api/')) return true;
  const url = pageUrl(path.replace(/^\//, '') + (path.endsWith('/') ? 'index.html' : ''));
  return existsSync(url) && statSync(url).isFile();
}

test('every public page is the stamped output of scripts/site-pages.mjs', () => {
  for (const page of PAGES) {
    const html = read(page.file);
    assert.equal(stamp(html, page), html, page.file + ' is stale; run node scripts/site-pages.mjs --write');
    for (const block of ['site:header', 'site:footer']) assert.ok(html.includes(`<!-- ${block} -->`), page.file + ' carries ' + block);
    for (const item of NAV) assert.ok(html.includes(`href="${item.href}"`), page.file + ' links ' + item.href);
  }
});

test('every internal link and asset on the public pages resolves, and nav targets exist', () => {
  for (const item of [...NAV, ...FOOTER]) assert.ok(resolves(item.href), item.href);
  for (const page of PAGES) {
    const html = read(page.file);
    for (const [, href] of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
      if (/^(https?:|mailto:)/.test(href)) continue;
      if (href.startsWith('#')) { assert.ok(html.includes(`id="${href.slice(1)}"`), page.file + ' anchor ' + href); continue; }
      assert.ok(href.startsWith('/'), page.file + ' uses a root-relative link: ' + href);
      assert.ok(resolves(href), page.file + ' links a missing file: ' + href);
      const [path, anchor] = href.split('#');
      if (anchor && path.endsWith('/') && !path.startsWith('/app/')) assert.ok(read(path.slice(1) + 'index.html').includes(`id="${anchor}"`), page.file + ' anchor ' + href);
    }
  }
});

test('public pages keep the CSP-safe shape and are listed for crawlers', () => {
  const sitemap = read('sitemap.xml'), llms = read('llms.txt');
  for (const page of PAGES) {
    const html = read(page.file);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)(?!\s+type="application\/ld\+json">)/i, page.file + ' has no inline script');
    assert.doesNotMatch(html, /<style|\sstyle=|\son[a-z]+=/i, page.file + ' has no inline style or handler');
    assert.ok(html.includes(`<link rel="canonical" href="${ORIGIN}${page.path}">`), page.file + ' canonical');
    assert.ok(sitemap.includes(`<loc>${ORIGIN}${page.path}</loc>`), page.file + ' in sitemap.xml');
    assert.ok(llms.includes(`(${ORIGIN}${page.path})`), page.file + ' in llms.txt');
  }
});

test('the plan table holds the approved prices, the limits and the feature split, and Enterprise has no self-serve price', () => {
  assert.equal(PLANS.status, 'approved');
  assert.equal(PLANS.approved_on, '2026-11-16');
  assert.ok(Object.isFrozen(PLANS) && Object.isFrozen(PLANS.plans[1]) && Object.isFrozen(PLANS.plans[1].features));
  const pick = plan => [plan.id, plan.monthly_base_usd, plan.checkout, plan.included_spans_per_month, plan.overage_usd_per_million_spans, plan.storage_gb, plan.retention_days, plan.projects, plan.environments, plan.seats, plan.api_keys, plan.at_allowance, plan.spend_cap];
  assert.deepEqual(PLANS.plans.map(pick), [
    ['free', 0, false, 50000, null, 1, 7, 2, 2, 2, 2, 'hard_stop', null],
    ['base', 9.99, true, 1000000, null, 10, 30, 3, 3, 5, 10, 'hard_stop', null],
    ['pro', 25.99, true, 5000000, 5, 50, 90, 10, 10, 10, 25, 'metered_overage', 'on_by_default'],
    ['enterprise', null, false, 50000000, null, 500, 365, 20, 20, 20, 100, 'hard_stop', 'on_by_default']
  ]);
  assert.equal(PLANS.plans[0].card_required, false);
  // Enterprise mirrors Supabase Enterprise: custom price, no checkout.
  assert.deepEqual([PLANS.plans[3].price_kind, PLANS.plans[3].monthly_base_usd, PLANS.plans[3].checkout], ['custom', null, false]);
  // Each plan has every feature of the plan below it, and every flag is a known feature.
  for (const [index, plan] of PLANS.plans.entries()) {
    for (const flag of plan.features) assert.ok(Object.hasOwn(FEATURES, flag), plan.id + ' ' + flag);
    if (index) for (const flag of PLANS.plans[index - 1].features) assert.ok(plan.features.includes(flag), plan.id + ' keeps ' + flag);
  }
  assert.deepEqual(PLANS.plans[0].features, []);
  assert.deepEqual(PLANS.plans[1].features, ['email_support', 'usage_alerts']);
  assert.deepEqual(PLANS.plans[2].features.filter(flag => !PLANS.plans[1].features.includes(flag)), ['spend_cap', 'trace_drains', 'audit_log', 'rbac_roles', 'priority_support']);
  assert.deepEqual(PLANS.plans[3].features.filter(flag => !PLANS.plans[2].features.includes(flag)), ['sso_saml', 'scim', 'audit_log_export', 'custom_roles', 'enforce_mfa', 'custom_retention', 'sla']);
  assert.deepEqual(PLANS.plans[3].features.slice().sort(), Object.keys(FEATURES).sort(), 'Enterprise has every feature');
  // The older reviewed reference catalog and the account projection are untouched.
  assert.equal(PLAN_CATALOG.paid_activation_enabled, false);
  assert.equal(accountPlanConfiguration(undefined, 'github-9').account_plan.paid_active, false);
});

test('the pricing page shows the numbers in src/plans.mjs and nothing else', () => {
  const html = read('pricing/index.html'), shown = text(html);
  // The generated blocks are rendered from the table, so a changed table changes the page.
  for (const block of [planCards(), planCompare(), planOverage()]) assert.ok(html.includes(block));
  const changed = JSON.parse(JSON.stringify(PLANS));
  changed.plans[1].monthly_base_usd = 31;
  assert.ok(planCards(changed).includes('$31') && !html.includes('$31'));
  const cards = [...html.matchAll(/<li class="plan" data-plan="([a-z]+)">([\s\S]*?)<\/div><\/li>/g)];
  assert.deepEqual(cards.map(card => card[1]), PLANS.plans.map(plan => plan.id));
  for (const [, id, body] of cards) {
    const plan = PLANS.plans.find(item => item.id === id), card = text(body);
    assert.ok(card.includes(format.price(plan)), id + ' price');
    // Every card states the count limits the service enforces for that plan, the custom plan included: no card says more than the table.
    for (const fact of [plan.seats + ' members', plan.environments + ' environments', plan.api_keys + ' API keys']) assert.ok(card.includes(fact), id + ' ' + fact);
    assert.doesNotMatch(card, /unlimited/i, id + ' promises nothing unlimited');
    if (plan.price_kind === 'custom') { assert.doesNotMatch(card, /\$\d/, 'no invented enterprise price'); assert.match(body, /href="\/enterprise\/#contact">Contact sales</); continue; }
    for (const fact of [format.spans(plan.included_spans_per_month) + ' spans per month', format.storage(plan.storage_gb) + ' stored', format.retention(plan.retention_days) + ' retention']) assert.ok(card.includes(fact), id + ' ' + fact);
  }
  assert.deepEqual(['$0', '50k', '1 GB', '7 days', '$9.99', '1M', '10 GB', '30 days', '$25.99', '5M', '$5 per 1M spans', '50 GB', '90 days', 'Custom'].filter(value => !shown.includes(value)), []);
  // Every dollar amount on the page comes from the table.
  const allowed = new Set(PLANS.plans.filter(plan => plan.price_kind !== 'custom').flatMap(plan => [plan.monthly_base_usd, plan.overage_usd_per_million_spans]).filter(value => value !== null).map(value => '$' + value));
  for (const [amount] of shown.matchAll(/\$\d[\d,]*(?:\.\d+)?/g)) assert.ok(allowed.has(amount), 'unexpected price ' + amount);
  // Every feature flag has a row in the comparison, with the plans that have it.
  for (const [id, feature] of Object.entries(FEATURES)) {
    const row = new RegExp('<tr><th scope="row">' + feature.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '</th>(.*?)</tr>').exec(html);
    assert.ok(row, 'row for ' + id);
    assert.deepEqual([...row[1].matchAll(/<td data-plan="([a-z]+)">(Yes|No)<\/td>/g)].map(cell => [cell[1], cell[2] === 'Yes']), PLANS.plans.map(plan => [plan.id, plan.features.includes(id)]), id);
  }
});

test('public pages describe the typed key model: ingest keys with no forced expiry, setup-code keys at 30 days (#105)', () => {
  const read = path => readFileSync(new URL('../public/' + path, import.meta.url), 'utf8');
  const keys = read('docs/keys/index.html'), quick = read('docs/quickstart/index.html'), security = read('security/index.html'), limits = read('docs/limits/index.html');
  for (const fact of ['st_pub_', 'st_sec_', 'No expiry by default', 'Setup-code keys expire 30 days after approval', 'Create ingest key and show snippets', '24 hours by default']) assert.ok(keys.includes(fact), 'keys: ' + fact);
  assert.equal(keys.match(/id="types"/g).length, 1);
  for (const fact of ['Create ingest key and show snippets', 'st_pub_', 'It does not expire; revoke or rotate it', 'is a setup-code key']) assert.ok(quick.includes(fact), 'quickstart: ' + fact);
  for (const fact of ['Ingest keys are write-only', 'does not expire unless you set an expiry', 'Keys made with a setup code are also write-only and expire after 30 days']) assert.ok(security.includes(fact), 'security: ' + fact);
  assert.ok(limits.includes('Ingest and secret keys do not expire unless you set an expiry'));
  // No page still says every key expires after 30 days.
  for (const [name, page] of Object.entries({keys, quick, security, limits, home: read('index.html'), llms: read('llms.txt'), pricing: read('pricing/index.html')})) for (const stale of ['write-only, 30 days, revocable', '30-day revocable write keys', 'Keys expire after 30 days', 'Keys expire 30 days after approval', 'write keys, expiring after 30 days']) assert.ok(!page.includes(stale), name + ': ' + stale);
});
test('the pricing page says payments are in test mode, sends buyers to Billing and makes no SLA or compliance claim', () => {
  const html = read('pricing/index.html'), shown = text(html);
  for (const fact of ['Payments are in test mode.', 'no real card is charged', 'Live payments are not on yet', 'Nothing already stored is dropped', '100 events / 512 KiB per batch', 'write-only ingest keys, revocable, with no expiry unless you set one', 'Keys made with a setup code expire after 30 days', 'projects are isolated within each organization']) assert.ok(shown.includes(fact), fact);
  // Base and Pro lead to the signed-in Billing view; the page itself holds no purchase form or Stripe link.
  assert.deepEqual([...html.matchAll(/<a class="button" href="([^"]+)">([^<]+)<\/a>/g)].map(match => [match[1], match[2]]).slice(0, 4), [['/#signin', 'Sign in free'], ['/app/#billing', 'Choose Base'], ['/app/#billing', 'Choose Pro'], ['/enterprise/#contact', 'Contact sales']]);
  assert.doesNotMatch(html, /\/api\/billing|checkout\.stripe|buy\.stripe|<form/i, 'no purchase path on the public page');
  assert.doesNotMatch(shown, /99\.9|SOC 2|HIPAA|money-back|guarantee/i, 'no SLA or compliance claim');
  assert.doesNotMatch(shown, /proposal|proposed|Not yet purchasable|Team\b/i, 'no leftover proposal wording or Team plan');
  assert.ok(read('index.html').includes('id="signin"'), 'the free call to action lands on the sign-in block');
  assert.ok(html.includes('<title>Pricing · SupaTrace</title>'));
  assert.ok(read('enterprise/index.html').includes('id="contact"'), 'the Enterprise call to action lands on the contact block');
  const landing = read('index.html');
  assert.ok(landing.includes('href="/pricing/"'));
});

test('what the pricing page, landing and limits docs say applies today is what the service enforces', () => {
  const free = PLAN_LIMITS.plans[PLAN_LIMITS.default_plan];
  // The enforced Free allowance is the proposed Free plan, so the card and "applies today" agree.
  assert.equal(free.spans_per_month, PLANS.plans[0].included_spans_per_month);
  assert.equal(free.stored_bytes, PLANS.plans[0].storage_gb * 1e9);
  assert.equal(free.hard_stop, true);
  const spans = format.spans(free.spans_per_month), stored = format.storage(free.stored_bytes / 1e9);
  const pricing = read('pricing/index.html');
  assert.ok(pricing.includes(plansToday()));
  assert.ok(text(pricing).includes(`Free allowance, enforced: ${spans} spans per UTC calendar month and ${stored} stored, per organization.`));
  assert.equal(free.retention_days, PLANS.plans[0].retention_days);
  assert.ok(text(pricing).includes(`Retention, enforced: ${format.retention(free.retention_days)} on Free, counted from when a batch is accepted.`));
  assert.ok(text(pricing).includes('scheduled worker erases payload versions and releases stored-byte capacity'));
  assert.ok(text(pricing).includes('Count limits, enforced: members, environments and API keys per organization.'));
  assert.ok(text(pricing).includes('Free 2, Base 3, Pro 10, Enterprise 20'));
  assert.doesNotMatch(text(pricing), /each organization has one project/);
  // docs/retention.md is the source for what retention does and does not do.
  const retention = readFileSync(new URL('../docs/retention.md', import.meta.url), 'utf8');
  assert.match(retention, /RETENTION_ERASURE_MODE=execute/);
  assert.match(retention, /Account and organization deletion/);
  assert.match(retention, /expired data is not\s+listed, opened or exported/);
  for (const file of ['docs/limits/index.html', 'security/index.html', 'enterprise/index.html']) assert.ok(text(read(file)).includes(`${free.retention_days} days on Free`), file + ' states Free retention');
  // Every page that states the Free retention also states the exemption for data stored earlier.
  assert.match(retention, /Rows accepted before retention stamping have no automatic expiry/);
  for (const file of ['docs/limits/index.html', 'security/index.html', 'enterprise/index.html', 'pricing/index.html', 'docs/export/index.html']) assert.match(text(read(file)), /stored before retention existed (does not expire|has no expiry)/, file + ' states the legacy exemption');
  for (const file of ['docs/limits/index.html', 'security/index.html', 'enterprise/index.html', 'pricing/index.html']) assert.doesNotMatch(text(read(file)), /no published retention guarantee|retention and project limits/i, file);
  assert.ok(text(read('index.html')).includes(`Free: ${spans} spans a month, ${stored} stored`));
  assert.ok(text(read('docs/limits/index.html')).includes(`${spans} spans per UTC calendar month and ${stored} stored, per organization`));
  assert.ok(text(read('agent-setup.html')).includes(`${free.spans_per_month.toLocaleString('en-US')} spans per UTC calendar month and ${stored} stored per organization`));
  // The old lifetime cap is gone from every public page.
  for (const file of ['index.html', 'pricing/index.html', 'docs/limits/index.html', 'agent-setup.html', 'llms.txt']) assert.doesNotMatch(read(file), /10 MiB/, file);
});


test('legal pages disclose Free-plan rights and limit the no-training commitment to paid organizations', () => {
  const terms = text(read('terms.html')), privacy = text(read('privacy.html'));
  for (const [file, shown] of [['terms.html', terms], ['privacy.html', privacy], ['aup.html', text(read('aup.html'))]]) {
    assert.ok(shown.includes('Do not submit sensitive or regulated data (including protected health information, payment card data, government IDs, credentials or secrets) to a Free organization.'), file + ': sensitive-data warning');
    assert.ok(shown.includes('Upgrade to a paid plan for the no-training commitment.'), file + ': paid upgrade warning');
  }
  for (const [file, shown] of [['terms.html', terms], ['privacy.html', privacy]]) {
    assert.ok(shown.includes('On paid plans (Base, Pro and Enterprise), we do not use traces from paid organizations to train or improve models.'), file + ': paid-only commitment');
    assert.ok(shown.includes('Upgrading to a paid plan applies the paid-plan commitment to traces accepted after the upgrade.'), file + ': prospective commitment');
    assert.ok(shown.includes('The Free-plan license survives an upgrade or closure for data already used before the upgrade or closure.'), file + ': surviving license');
    assert.ok(shown.includes('Upgrading or closing an organization does not undo prior uses, including model training.'), file + ': prior uses persist');
  }
  assert.ok(terms.includes('On paid plans (Base, Pro and Enterprise), you grant Slancha only the permission needed to host, copy, transmit, index, display, export and delete it to provide the service to you and your authorized users'));
  assert.ok(terms.includes('For Free organizations, you grant Slancha, Inc. a worldwide, royalty-free, non-exclusive license to use traces and usage data submitted to or generated by Free organizations to (a) train and improve machine-learning models, (b) operate, develop and improve SupaTrace and Slancha products, and (c) produce aggregate or de-identified analytics and benchmarks.'));
  assert.ok(terms.includes('We do not sell personal data.'));
  assert.ok(privacy.includes('Free plan: use of traces for model training, product improvement and analytics'));
  assert.ok(privacy.includes('For Free organizations only, Slancha may use the following categories of information submitted to or generated by those organizations:'));
  for (const category of ['Trace content, including prompts, model outputs and tool results.', 'Usage data.', 'Account identifiers as needed for the business purposes below.']) assert.ok(privacy.includes(category), category);
  assert.ok(privacy.includes('The business purposes are (a) training and improving machine-learning models, (b) operating, developing and improving SupaTrace and Slancha products, and (c) producing aggregate or de-identified analytics and benchmarks.'));
  assert.ok(privacy.includes('We do not sell personal data or share it for cross-context behavioral advertising.'));
  assert.ok(privacy.includes('We do not use customer traces for advertising.'));
  // Literal backstops; review checks the meaning of the complete policy.
  for (const page of PAGES) {
    const shown = text(read(page.file)).toLowerCase();
    for (const stale of ['do not use customer traces to train models', 'do not sell personal data or use customer traces to train models', 'do not use customer traces for advertising or model training', 'processes customer trace data only to provide supatrace']) assert.ok(!shown.includes(stale), page.file + ': ' + stale);
  }
});

test('the generated Free pricing card discloses training and analytics uses', () => {
  const note = 'Free plan traces may be used to train and improve models and for aggregate analytics. Paid plans: no training on your traces.';
  for (const [name, html] of [['generator', planCards()], ['pricing page', read('pricing/index.html')]]) {
    const freeCard = html.split('data-plan="free"')[1].split('data-plan="base"')[0];
    assert.ok(text(freeCard).includes(note), name + ': Free card disclosure');
  }
});

test('legal pages are complete, dated and linked from each shared footer and sign-in', () => {
  for (const file of ['terms.html', 'privacy.html', 'aup.html', 'subprocessors.html']) {
    const shown = text(read(file));
    for (const fact of ['Slancha, Inc.', 'support@supatrace.dev', 'November 16, 2026', '2930 Domingo Ave, Berkeley, CA 94705, USA']) assert.ok(shown.includes(fact), file + ': ' + fact);
    // This is a backstop for literal draft markers, not a semantic review of legal text.
    assert.doesNotMatch(shown, /not (?:yet )?published|TBD|\[/i, file);
    for (const page of PAGES) assert.ok(read(page.file).split('<!-- site:footer -->')[1].includes('href="/' + file + '"'), page.file + ' footer links ' + file);
  }
  const signin = read('signin.js');
  assert.ok(signin.includes('By continuing you agree to the '));
  for (const file of ['terms.html', 'privacy.html']) assert.ok(signin.includes("href: '/" + file + "'"));
  assert.equal(PLANS.approval_note, "Plan limits and features");
  const changed = structuredClone(PLANS); changed.plans[3].overage_usd_per_million_spans = 12345;
  for (const render of [planCards, planCompare, planOverage]) assert.ok(!render(changed).includes('$12345'), 'Enterprise internal overage never becomes public');
});
