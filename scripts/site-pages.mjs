#!/usr/bin/env node
// Shared chrome and generated blocks for the static public pages. There is no build
// step at deploy time: this stamps the checked-in HTML between marker comments, and
// tests/site-pages.test.mjs fails when a page is not the stamped output.
//   node scripts/site-pages.mjs --write    rewrite every page in PAGES
//   node scripts/site-pages.mjs --check    exit 1 when a page is stale
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {PLANS, FEATURES} from '../src/plans.mjs';
import {PLAN_LIMITS} from '../src/plan-limits.mjs';
import {CHANGELOG, LAST_DEPLOY} from './changelog.mjs';
import {otlpExamples} from './otlp-snippets.mjs';

export const ORIGIN = 'https://supatrace.dev';
// Every page that carries the shared header and footer. `path` is the public URL path.
// The docs sidebar, in order. Every entry is a page under public/docs/.
export const DOCS = [
  {group: 'Start', items: [
    {href: '/docs/', label: 'Overview'},
    {href: '/docs/quickstart/', label: 'Quickstart'}
  ]},
  {group: 'Frameworks', items: [
    {href: '/docs/frameworks/openai/', label: 'OpenAI'},
    {href: '/docs/frameworks/anthropic/', label: 'Anthropic'},
    {href: '/docs/frameworks/langchain/', label: 'LangChain'},
    {href: '/docs/frameworks/llamaindex/', label: 'LlamaIndex'},
    {href: '/docs/frameworks/vercel-ai-sdk/', label: 'Vercel AI SDK'},
    {href: '/docs/frameworks/opentelemetry/', label: 'OpenTelemetry'}
  ]},
  {group: 'Reference', items: [
    {href: '/docs/keys/', label: 'Keys'},
    {href: '/docs/management-api/', label: 'Management API'},
    {href: '/docs/limits/', label: 'Limits'},
    {href: '/docs/export/', label: 'Export'},
    {href: '/docs/importers/', label: 'Importers'}
  ]}
];
export const DOC_PAGES = DOCS.flatMap(group => group.items).map(item => ({file: item.href.slice(1) + 'index.html', path: item.href, section: '/docs/'}));
// The public integrations directory. `status` is one of STATUSES and must match what the
// linked doc says; tests/integrations.test.mjs ties each entry to repository evidence.
export const STATUSES = {
  available: 'Usable today on supatrace.dev or through public downloads.',
  beta: 'Implemented with source tests; hosted or real-client acceptance is still open.',
  preview: 'Coming soon: not enabled on the hosted service or not installable yet.',
  planned: 'Not usable today.'
};
const FILE = 'Not available in the hosted service yet. Operator-run source is in the public repository. Use Home snippets or hosted OTLP today.';
export const INTEGRATIONS = [
  {group: 'Frameworks', items: [
    {id: 'langchain', name: 'LangChain', status: 'beta', summary: 'Record model calls as events with the alpha Python package on PyPI (supatrace 0.1.0). Hosted acceptance is still open. Stock OpenTelemetry exporters can send traces to supatrace.dev today.', href: '/docs/frameworks/langchain/'},
    {id: 'llamaindex', name: 'LlamaIndex', status: 'beta', summary: 'Record model calls as events with the alpha Python package on PyPI (supatrace 0.1.0). Hosted acceptance is still open. Stock OpenTelemetry exporters can send traces to supatrace.dev today.', href: '/docs/frameworks/llamaindex/'},
    {id: 'vercel-ai-sdk', name: 'Vercel AI SDK', status: 'preview', summary: 'Record generateText calls as events with the JavaScript SDK in source mode. SDK package coming. AI SDK telemetry can send traces to the hosted OTLP/HTTP receiver today.', href: '/docs/frameworks/vercel-ai-sdk/'}
  ]},
  {group: 'Providers', items: [
    {id: 'openai', name: 'OpenAI (Python)', status: 'beta', summary: 'Record chat completions as events with the alpha Python package on PyPI (supatrace 0.1.0). Hosted acceptance is still open. The JavaScript package is not published to npm.', href: '/docs/frameworks/openai/'},
    {id: 'anthropic', name: 'Anthropic', status: 'beta', summary: 'Record Messages API calls as events with the alpha Python package on PyPI (supatrace 0.1.0). Hosted acceptance is still open.', href: '/docs/frameworks/anthropic/'}
  ]},
  {group: 'Standards', items: [
    {id: 'otlp-ingest', name: 'OpenTelemetry (OTLP ingest)', status: 'available', summary: 'OTLP/HTTP receiver for any OpenTelemetry exporter, protobuf or JSON. Available on supatrace.dev for traces only; no gRPC, metrics or logs.', href: '/docs/frameworks/opentelemetry/#otlp'},
    {id: 'langfuse-sdk', name: 'Langfuse SDKs', status: 'beta', summary: 'Point an app that uses a Langfuse SDK at SupaTrace by changing the host and keys. Ingest only. Hosted routes answer; SDK acceptance is local only, so this remains beta.', href: '/docs/frameworks/opentelemetry/#langfuse-sdk'},
    {id: 'otlp', name: 'OTLP JSON file', status: 'preview', format: 'otlp', summary: 'OTLP HTTP JSON export files (not protobuf or gzip). ' + FILE, href: '/docs/importers/#files'}
  ]},
  {group: 'Import from', items: [
    {id: 'langfuse', name: 'Langfuse', status: 'beta', summary: 'Import one exact trace scope from the workspace with your Langfuse read keys, in bounded steps. Runs only where the server has it enabled.', href: '/docs/importers/#langfuse'},
    {id: 'langsmith', name: 'LangSmith', status: 'preview', format: 'langsmith', summary: 'LangSmith run exports. ' + FILE, href: '/docs/importers/#files'},
    {id: 'langsmith-api', name: 'LangSmith API', status: 'preview', summary: 'Not available in the hosted service yet. Operator-run source is in the public repository. Reads 1 to 25 completed traces you name from the LangSmith API with your own key.', href: '/docs/importers/#api'},
    {id: 'braintrust', name: 'Braintrust', status: 'preview', format: 'braintrust', summary: 'Braintrust span logs. ' + FILE, href: '/docs/importers/#files'},
    {id: 'braintrust-api', name: 'Braintrust API', status: 'preview', summary: 'Not available in the hosted service yet. Operator-run source is in the public repository. Reads 1 to 25 completed traces you name from the Braintrust API with your own key.', href: '/docs/importers/#api'},
    {id: 'weave', name: 'Weave', status: 'preview', format: 'weave', summary: 'Weave call exports. ' + FILE, href: '/docs/importers/#files'},
    {id: 'opik', name: 'Opik', status: 'preview', format: 'opik', summary: 'Opik span exports. ' + FILE, href: '/docs/importers/#files'},
    {id: 'datadog', name: 'Datadog LLM Observability', status: 'preview', format: 'datadog', summary: 'Datadog LLMObs JSON exports. ' + FILE, href: '/docs/importers/#files'},
    {id: 'mlflow', name: 'MLflow', status: 'preview', format: 'mlflow', summary: 'MLflow trace exports. ' + FILE, href: '/docs/importers/#files'},
    {id: 'helicone', name: 'Helicone', status: 'preview', format: 'helicone', summary: 'Helicone request logs. ' + FILE, href: '/docs/importers/#files'}
  ]},
  {group: 'Agents and tools', items: [
    {id: 'claude-snapshot', name: 'Claude Code snapshot', status: 'available', summary: 'Convert one finished Claude Code transcript you select into reviewed batches. Not a live tailer.', href: '/docs/importers/#claude'},
    {id: 'claude-hooks', name: 'Claude Code hooks', status: 'beta', summary: 'Opt-in command hook that records prompt, tool and completion events into a private spool. Metadata only by default.', href: '/docs/importers/#claude'},
    {id: 'mcp', name: 'MCP reader', status: 'preview', summary: 'Not available in the hosted service yet. The reader source is in the public repository. Lets an agent list, search, inspect and export traces within a scope you review. Not a hosted MCP endpoint.', href: '/docs/export/#mcp'}
  ]}
];
export function integrationsList() {
  const items = Object.fromEntries(INTEGRATIONS.flatMap(group => group.items).map(item => [item.id, item]));
  const tile = (id, name, copy) => `<li class="tile" data-integration="${id}" data-status="${items[id].status}"><h3>${name}</h3><p>${copy}</p><a href="${items[id].href}">Read guide<span class="visually-hidden">: ${name}</span></a></li>`;
  return `
<section aria-labelledby="integrations-live"><h2 id="integrations-live">Live</h2><ul class="tiles">
${tile('otlp-ingest', 'OpenTelemetry (OTLP)', 'Send traces with any OTLP/HTTP exporter, protobuf or JSON. Traces only. No gRPC, metrics, or logs.')}
${tile('claude-snapshot', 'Claude Code snapshot', 'Convert one finished transcript you choose into batches. This is not a live tail.')}
</ul></section>
<section aria-labelledby="integrations-beta"><h2 id="integrations-beta">Beta</h2><ul class="tiles">
${tile('langchain', 'LangChain', 'Use the alpha Python SDK on PyPI: supatrace 0.1.0. Hosted acceptance is still open.')}
${tile('llamaindex', 'LlamaIndex', 'Use the alpha Python SDK on PyPI: supatrace 0.1.0. Hosted acceptance is still open.')}
${tile('openai', 'OpenAI (Python)', 'Use the alpha Python SDK on PyPI: supatrace 0.1.0. Hosted acceptance is still open. The JavaScript package is not published to npm.')}
${tile('anthropic', 'Anthropic', 'Use the alpha Python SDK on PyPI: supatrace 0.1.0. Hosted acceptance is still open.')}
${tile('langfuse-sdk', 'Langfuse SDKs', 'Point a Langfuse SDK at SupaTrace by changing the host and keys. This only receives traces.')}
${tile('langfuse', 'Langfuse import', 'Import one exact trace scope from the workspace with your Langfuse read keys.')}
${tile('claude-hooks', 'Claude Code hooks', 'An opt-in hook that records prompt, tool, and completion events into a private spool. Metadata only by default.')}
</ul></section>
<details class="coming-soon"><summary>Coming soon</summary><p>Until these ship, use Home snippets or hosted OTLP.</p><ul class="tiles">
<li class="tile"><h3>JavaScript SDK: Vercel AI SDK and OpenAI</h3><p>The JavaScript supatrace package is not published to npm. Examples run from the public repository. Use hosted OTLP for a first trace; the Python SDK is Beta on PyPI.</p><a href="/docs/frameworks/vercel-ai-sdk/">Read guide</a></li>
<li class="tile"><h3>OTLP JSON file, LangSmith, LangSmith API, Braintrust, Braintrust API, Weave, Opik, Datadog LLM Observability, MLflow, Helicone</h3><p>Not available in the hosted service yet. Operator-run source is in the public repository. LangSmith API and Braintrust API read 1 to 25 completed traces you name.</p><a href="/docs/importers/">Read guide</a></li>
<li class="tile"><h3>MCP reader</h3><p>Not a hosted MCP endpoint.</p><a href="/docs/export/#mcp">Read guide</a></li>
</ul></details>
<p class="actions"><a href="/docs/">See docs</a><a href="/app/">Sign in</a></p>
`;
}
const slug = text => text.toLowerCase().replace(/[^a-z]+/g, '-');

export const REDIRECTS = [
  ...['login', 'signin', 'sign-in'].map(path => ({file: path + '/index.html', target: '/app/'})),
  ...['signup', 'sign-up', 'register'].map(path => ({file: path + '/index.html', target: '/app/?view=signup'})),
  {file: 'docs/opentelemetry/index.html', target: '/docs/frameworks/opentelemetry/'},
  {file: 'docs/setup/index.html', target: '/agent-setup.html'}
];
export function redirectHtml({target}) {
  return `<!doctype html>
<!-- Generated by scripts/site-pages.mjs. -->
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><meta http-equiv="refresh" content="0;url=${esc(target)}">
<title>Continue to SupaTrace</title></head><body><p><a href="${esc(target)}">Continue to SupaTrace</a></p></body></html>
`;
}

export const PAGES = [
  {file: 'index.html', path: '/'},
  {file: 'pricing/index.html', path: '/pricing/'},
  {file: 'integrations/index.html', path: '/integrations/'},
  {file: 'changelog/index.html', path: '/changelog/'},
  {file: 'enterprise/index.html', path: '/enterprise/'},
  {file: 'security/index.html', path: '/security/'},
  {file: 'status/index.html', path: '/status/'},
  ...DOC_PAGES,
  ...['terms', 'privacy', 'aup', 'subprocessors'].map(name => ({file: name + '.html', path: '/' + name + '.html'}))
];
export const NAV = [
  {href: '/docs/', label: 'Docs'},
  {href: '/integrations/', label: 'Integrations'},
  {href: '/pricing/', label: 'Pricing'},
  {href: '/app/', label: 'Workspace'}
];
export const FOOTER = [
  {href: '/', label: 'Home'},
  {href: '/docs/', label: 'Docs'},
  {href: '/integrations/', label: 'Integrations'},
  {href: '/pricing/', label: 'Pricing'},
  {href: '/enterprise/', label: 'Enterprise'},
  {href: '/security/', label: 'Security'},
  {href: '/changelog/', label: 'Changelog'},
  {href: '/status/', label: 'Status'},
  {href: '/docs/quickstart/', label: 'Setup guide'},
  {href: '/terms.html', label: 'Terms of Service'},
  {href: '/privacy.html', label: 'Privacy Policy'},
  {href: '/aup.html', label: 'Acceptable Use'},
  {href: '/subprocessors.html', label: 'Subprocessors'}
];

const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const links = (items, current) => items.map(item => `<a href="${item.href}"${item.href === current ? ' aria-current="page"' : ''}>${esc(item.label)}</a>`).join('');

export const header = page => chrome(page.section || page.path);
export const docsNav = current => `
<nav class="docs-nav" aria-label="Docs">
${DOCS.map(group => `<h2>${esc(group.group)}</h2><ul>${group.items.map(item => `<li>${links([item], current)}</li>`).join('')}</ul>`).join('\n')}
</nav>
`;
const chrome = current => `
<header class="site-header">
<a class="wordmark" href="/" aria-label="SupaTrace home"><img class="brand-mark" src="/brand-mark.svg" alt="" width="25" height="46">SupaTrace</a>
<nav aria-label="Main">${links(NAV, current)}</nav>
</header>
`;
// Preserve legal-page chrome owned by the separate launch lane.
export const footer = current => {
  const legal = ['/terms.html', '/privacy.html', '/aup.html'].includes(current);
  const items = legal ? FOOTER.map(item => item.label === 'Setup guide' ? {...item, href: '/agent-setup.html'} : item) : FOOTER;
  return `<nav class="site-links" aria-label="Site">${links(items, current)}<a href="mailto:support@supatrace.dev">Support</a>${legal ? '<span id="build" class="build" hidden></span>' : ''}</nav>${legal ? '<script type="module" src="/build.js"></script>' : ''}`;
};

// Plan formatting. A count of null is unlimited. Enterprise numbers are defaults set per contract, so the page says Custom.
export const format = {
  price: plan => plan.price_kind === 'custom' ? 'Custom' : '$' + plan.monthly_base_usd,
  spans: count => count >= 1e6 ? count / 1e6 + 'M' : count / 1e3 + 'k',
  storage: gb => gb + ' GB',
  retention: days => days % 365 === 0 ? (days / 365 === 1 ? '1 year' : days / 365 + ' years') : days + ' days',
  overage: usd => '$' + usd + ' per 1M spans',
  count: value => value === null ? 'Unlimited' : String(value),
  spendCap: plan => plan.spend_cap === 'on_by_default' ? 'On by default; you can turn it off' : 'Always on',
  atAllowance: plan => plan.at_allowance === 'hard_stop' ? 'Uploads stop until next month' : 'Uploads stop (spend cap), or continue if you turn the cap off'
};
const custom = (plan, value) => plan.price_kind === 'custom' ? 'Custom' : value;
const featureLabels = plan => plan.features.map(id => FEATURES[id].label);
// The features a plan adds over the plan before it.
const added = (catalog, plan) => { const before = catalog.plans[catalog.plans.indexOf(plan) - 1]; return featureLabels(plan).filter(label => !before || !featureLabels(before).includes(label)); };

function card(plan, catalog) {
  const facts = plan.price_kind === 'custom' ? ['Volume and retention set by contract', format.count(plan.seats) + ' members', format.count(plan.environments) + ' environments', format.count(plan.api_keys) + ' API keys', ...added(catalog, plan)] : [
    format.spans(plan.included_spans_per_month) + ' spans per month',
    format.storage(plan.storage_gb) + ' stored',
    format.retention(plan.retention_days) + ' retention',
    format.count(plan.seats) + ' members',
    format.count(plan.environments) + ' environments',
    format.count(plan.api_keys) + ' API keys',
    ...added(catalog, plan)
  ];
  const period = plan.price_kind === 'custom' ? '' : `<span class="per">per organization / month</span>`;
  const cta = plan.id === 'free'
    ? `<a class="button" href="/app/">Start free</a><p class="plan-note">No card.</p><p class="plan-note">Free plan traces may be used to train and improve models and for aggregate analytics. Paid plans: no training on your traces.</p>`
    : plan.checkout
      ? `<a class="button" href="/app/#billing">Choose ${esc(plan.name)}</a><p class="plan-note">Sign in, then upgrade from Billing. Stripe shows the price before you authorize payment.</p>`
      : `<a class="button" href="/enterprise/#contact">Talk to us</a><p class="plan-note">No self-serve checkout. <a href="/enterprise/">What Enterprise includes</a></p>`;
  return `<li class="plan" data-plan="${plan.id}"><h3>${esc(plan.name)}</h3><p class="price"><strong data-field="price">${format.price(plan)}</strong>${period}</p><ul>${facts.map(fact => `<li>${esc(fact)}</li>`).join('')}</ul><div class="plan-cta">${cta}</div></li>`;
}

export function planCards(catalog = PLANS) {
  return `\n<ul class="plans">\n${catalog.plans.map(plan => card(plan, catalog)).join('\n')}\n</ul>\n`;
}

export function planCompare(catalog = PLANS) {
  const rows = [
    ['Price', plan => format.price(plan) + (plan.price_kind === 'custom' ? '' : ' / month')],
    ['Card required', plan => plan.card_required === null ? 'Custom' : plan.card_required ? 'Yes' : 'No'],
    ['Included spans per month', plan => custom(plan, format.spans(plan.included_spans_per_month))],
    ['At the allowance', plan => custom(plan, format.atAllowance(plan))],
    ['Stored data', plan => custom(plan, format.storage(plan.storage_gb))],
    ['Retention', plan => custom(plan, format.retention(plan.retention_days))],
    ['Members', plan => format.count(plan.seats)],
    ['Environments', plan => format.count(plan.environments)],
    ['API keys', plan => format.count(plan.api_keys)],
    ['Projects per organization', plan => format.count(plan.projects)],
    ['Created workspaces per owner (highest owned plan)', plan => format.count(plan.workspaces)],
    ...Object.entries(FEATURES).map(([id, feature]) => [feature.label, plan => plan.features.includes(id) ? 'Yes' : 'No'])
  ];
  const head = `<tr><th scope="col">Plan</th>${catalog.plans.map(plan => `<th scope="col">${esc(plan.name)}</th>`).join('')}</tr>`;
  const body = rows.map(([label, cell]) => `<tr><th scope="row">${esc(label)}</th>${catalog.plans.map(plan => `<td data-plan="${plan.id}">${esc(cell(plan))}</td>`).join('')}</tr>`).join('\n');
  const cards = catalog.plans.map(plan => `<article class="compare-card" data-plan="${plan.id}"><h3>${esc(plan.name)}</h3><dl>${rows.map(([label, cell]) => `<div><dt>${esc(label)}</dt><dd>${esc(cell(plan))}</dd></div>`).join('')}</dl></article>`).join('');
  return `\n<div class="compare-cards">${cards}</div><div class="table-scroll compare-desktop" tabindex="0" role="region" aria-label="Plan comparison"><table class="compare"><thead>${head}</thead><tbody>\n${body}\n</tbody></table></div>\n`;
}

// What the service enforces, read from the same table enforcement uses.
export function plansToday(limits = PLAN_LIMITS) {
  const free = limits.plans[limits.default_plan];
  return `
<ul class="facts">
<li><strong>Plans:</strong> Free plan with no card. Base is $9.99/month. Pro is $25.99/month.</li>
<li><strong>Free allowance, enforced:</strong> ${format.spans(free.spans_per_month)} spans per UTC calendar month and ${format.storage(free.stored_bytes / 1e9)} stored, per organization. A span is one accepted trace event. The span count resets on the first of the month; stored bytes do not reset. At either limit uploads are rejected with an error that names the limit and links to Billing. Nothing already stored is dropped.</li>
<li><strong>Count limits, enforced:</strong> members, environments and API keys per organization. A create request over the limit is refused; existing items stay.</li>
<li><strong>Payments:</strong> Stripe processes Base and Pro subscriptions. The paid plan unlocks its limits and features after Stripe confirms payment.</li>
<li><strong>Service-wide cap:</strong> Shared service caps can stop an upload before an organization reaches its own allowance. Contact support if a service cap blocks your paid plan.</li>
<li><strong>Retention, enforced:</strong> ${format.retention(free.retention_days)} on Free, counted from when a batch is accepted. After that it is no longer listed, opened or exported. Expired data is hidden immediately; the enabled scheduled worker erases payload versions and releases stored-byte capacity. Data stored before retention existed does not expire.</li>
<li><strong>Projects:</strong> projects are isolated within each organization: Free 2, Base 3, Pro 10, Enterprise 20. Billing and usage are shared within the organization.</li>
<li><strong>Batches:</strong> 100 events / 512 KiB per batch.</li>
<li><strong>Keys:</strong> write-only ingest keys, revocable, with no expiry unless you set one. Keys made with a setup code expire after 30 days.</li>
<li><strong>Export:</strong> you can export your original JSON from the workspace on every plan.</li>
</ul>
`;
}

export function planOverage(catalog = PLANS) {
  const metered = catalog.plans.filter(plan => plan.overage_usd_per_million_spans !== null && plan.price_kind !== 'custom');
  const rows = metered.map(plan => `<tr><th scope="row">${esc(plan.name)}</th><td>${format.spans(plan.included_spans_per_month)} spans</td><td>${format.overage(plan.overage_usd_per_million_spans)}</td></tr>`).join('\n');
  return `\n<div class="table-scroll" tabindex="0" role="region" aria-label="Overage rates"><table class="compare stack-table"><thead><tr><th scope="col">Plan</th><th scope="col">Included each month</th><th scope="col">Past the allowance, cap off</th></tr></thead><tbody>\n${rows}\n</tbody></table></div>\n`;
}

// SES receiving for support@ was verified on supatrace.dev on 2026-11-15.
// The form opens a draft in the visitor's mail client; it never submits fields to a backend.
export const CONTACT = {sales: 'support@supatrace.dev', security: 'security@supatrace.dev'};
const EMAIL = /^[a-z0-9._+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
export function salesContact(address = CONTACT.sales) {
  if (address === null) return `
<div class="contact closed" id="contact" data-contact="closed">
<h2>Contact sales</h2>
<p><strong>Sales contact is not open yet.</strong> No sales inbox has been set up, so this page does not publish an address or a form that would go nowhere. Enterprise terms are not final either. You can <a href="/#signin">use the free alpha</a> today.</p>
</div>
`;
  if (!EMAIL.test(address)) throw new Error('CONTACT.sales is not an email address');
  return `
<div class="contact" id="contact" data-contact="open">
<h2>Contact sales</h2>
<p>Sales and support share <a href="mailto:${address}">${address}</a>.</p>
<p>This form sends nothing to SupaTrace by itself. It opens a draft in your own mail client, addressed to <a href="mailto:${address}">${address}</a>, for you to review and send. The button works once this page's script has loaded; without JavaScript, use the address above.</p>
<form id="sales-form" data-to="${address}">
<label for="sales-name">Name</label><input id="sales-name" name="name" autocomplete="name" required maxlength="120">
<label for="sales-email">Work email</label><input id="sales-email" name="email" type="email" autocomplete="email" required maxlength="200">
<label for="sales-company">Company</label><input id="sales-company" name="company" autocomplete="organization" required maxlength="160">
<label for="sales-size">Team size</label><input id="sales-size" name="size" inputmode="numeric" maxlength="20">
<label for="sales-message">What do you need?</label><textarea id="sales-message" name="message" rows="5" maxlength="2000"></textarea>
<button class="button" type="submit" disabled>Open email draft</button>
<p class="plan-note" id="sales-status" role="status"></p>
</form>
</div>
<script type="module" src="/enterprise/contact.js"></script>
`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const longDate = date => { const [year, month, day] = date.split('-').map(Number); return `${MONTHS[month - 1]} ${day}, ${year}`; };
export function changelogList(entries = CHANGELOG) {
  const label = {deployed: ['available', 'deployed'], merged: ['planned', 'merged, not deployed']};
  const items = entries.map(entry => `<li class="change" data-pr="${entry.pr}" data-state="${entry.state}"><time datetime="${entry.date}">${longDate(entry.date)}</time><div><h2>${esc(entry.title)}</h2><p>${esc(entry.body)}</p><p class="change-meta"><span class="status ${label[entry.state][0]}">${label[entry.state][1]}</span> Pull request #${entry.pr}</p></div></li>`).join('\n');
  return `\n<p class="deploy-note">Last production deploy recorded here: ${longDate(LAST_DEPLOY.date)} (commit <code>${LAST_DEPLOY.commit}</code>).</p>\n<ol class="changes">\n${items}\n</ol>\n`;
}

const BLOCKS = {
  'site:header': page => header(page),
  'docs:nav': page => docsNav(page.path),
  'integrations:list': () => integrationsList(),
  'changelog:list': () => changelogList(),
  'otlp:examples': () => otlpExamples(),
  'contact:sales': () => salesContact(),
  'site:footer': page => footer(page.path),
  'plans:cards': () => planCards(),
  'plans:compare': () => planCompare(),
  'plans:overage': () => planOverage(),
  'plans:today': () => plansToday()
};

export const TEMPLATES = {
  ...Object.fromEntries(DOC_PAGES.map(page => [page.file, page.file])),
  'integrations/index.html': 'integrations.html',
  'index.html': 'home.html', 'pricing/index.html': 'pricing.html',
  'terms.html': 'terms.html', 'subprocessors.html': 'subprocessors.html',
  'security/index.html': 'security.html', 'docs/index.html': 'docs.html',
  'docs/limits/index.html': 'limits.html', 'agent-setup.html': 'agent-setup.html',
  'llms.txt': 'llms.txt'
};
const AUXILIARY_PAGES = [{file: 'agent-setup.html'}, {file: 'llms.txt'}];

// Static regions work before the copy-button script runs. Templates are the input,
// so repeated generation cannot nest wrappers or duplicate mobile labels.
export function scrollRegions(html) {
  const shell = content => `<div class="scroll-shell">${content}<span class="scroll-hint" aria-hidden="true">Scroll for more →</span></div>`;
  html = html.replace(/<pre([^>]*)>([\s\S]*?)<\/pre>/g, (_, attrs, code) => shell(`<pre${attrs} tabindex="0" role="region" aria-label="Code example; scroll horizontally for more">${code}</pre>`));
  html = html.replace(/<table([^>]*)>([\s\S]*?)<\/table>/g, (_, attrs, body) => {
    if (attrs.includes('stack-table')) {
      const headings = [...body.matchAll(/<th scope="col">([\s\S]*?)<\/th>/g)].map(match => match[1]);
      body = body.replace(/<tbody>([\s\S]*?)<\/tbody>/, (_, rows) => '<tbody>' + rows.replace(/<tr>([\s\S]*?)<\/tr>/g, (_, cells) => {
        let column = 0;
        return '<tr role="row">' + cells.replace(/<(th|td)([^>]*)>([\s\S]*?)<\/\1>/g, (_, tag, attributes, content) => `<${tag}${attributes} role="${tag === 'th' ? 'rowheader' : 'cell'}" data-label="${esc(headings[column++])}"><span class="cell-value">${content}</span></${tag}>`) + '</tr>';
      }) + '</tbody>');
      attrs += ' role="table"';
    }
    return `<table${attrs}>${body}</table>`;
  });
  // The docs reference tables without a pre-existing wrapper get the same region.
  html = html.replace(/(<div class="table-scroll[^"]*"[^>]*>)?(<table[\s\S]*?<\/table>)(<\/div>)?/g, (_, frame, table) => {
    frame ||= '<div class="table-scroll" tabindex="0" role="region" aria-label="Documentation table">';
    frame = frame.replace(/aria-label="([^"]*)"/, (_, label) => `aria-label="${label}; scroll horizontally for more"`);
    return shell(frame + table + '</div>');
  });
  return html;
}

export function stamp(html, page) {
  const template = TEMPLATES[page.file];
  if (template) html = readFileSync(new URL('./site-templates/' + template, import.meta.url), 'utf8');
  html = html.replace(/<!-- ([a-z]+:[a-z]+) -->[\s\S]*?<!-- \/\1 -->/g, (match, name) => {
    if (!BLOCKS[name]) throw new Error('unknown block ' + name + ' in ' + page.file);
    return `<!-- ${name} -->${BLOCKS[name](page)}<!-- /${name} -->`;
  });
  return page.path?.startsWith('/docs/') || page.path === '/pricing/' || page.file === 'agent-setup.html' ? scrollRegions(html) : html;
}
export const pageUrl = file => new URL('../public/' + file, import.meta.url);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const write = process.argv.includes('--write');
  let stale = 0;
  for (const page of [...PAGES, ...AUXILIARY_PAGES]) {
    const before = readFileSync(pageUrl(page.file), 'utf8'), after = stamp(before, page);
    if (before === after) continue;
    stale += 1;
    if (write) writeFileSync(pageUrl(page.file), after);
    console.log((write ? 'wrote ' : 'stale ') + page.file);
  }
  for (const page of REDIRECTS) {
    const url = pageUrl(page.file), after = redirectHtml(page);
    if (existsSync(url) && readFileSync(url, 'utf8') === after) continue;
    stale += 1;
    if (write) { mkdirSync(new URL('./', url), {recursive: true}); writeFileSync(url, after); }
    console.log((write ? 'wrote ' : 'stale ') + page.file);
  }
  const sitemapUrl = pageUrl('sitemap.xml');
  const sitemap = readFileSync(sitemapUrl, 'utf8');
  const redirectUrls = REDIRECTS.map(page => `  <url><loc>${ORIGIN}/${page.file.replace(/index\.html$/, '')}</loc></url>`).join('\n');
  const nextSitemap = sitemap.replace(/  <!-- redirects -->[\s\S]*?  <!-- \/redirects -->\n/, '').replace('</urlset>', `  <!-- redirects -->\n${redirectUrls}\n  <!-- /redirects -->\n</urlset>`);
  if (nextSitemap !== sitemap) { stale += 1; if (write) writeFileSync(sitemapUrl, nextSitemap); }
  if (stale && !write) { console.error('Run: node scripts/site-pages.mjs --write'); process.exit(1); }
}
