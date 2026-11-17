// The docs under public/docs/ only document what exists: every page is in the sidebar,
// every runnable snippet is executed against the SDKs in packages/ (provider libraries are
// replaced by local stubs, so no network and no provider key), every SDK symbol and
// environment variable named in the docs exists in the SDK source, and every cross-page
// anchor resolves.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DOCS, DOC_PAGES, REDIRECTS, pageUrl} from '../scripts/site-pages.mjs';
import {parseBatch} from '../src/trace.mjs';
import {OTLP_ENV, OTLP_PYTHON, OTLP_JS, OTLP_CURL} from '../scripts/otlp-snippets.mjs';
import * as jsSdk from '../packages/supatrace-js/index.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const read = file => readFileSync(pageUrl(file), 'utf8');
const decode = text => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const pySource = readFileSync(join(repo, 'packages/supatrace/src/supatrace/__init__.py'), 'utf8');
const jsSource = readFileSync(join(repo, 'packages/supatrace-js/index.mjs'), 'utf8');
const snippets = DOC_PAGES.flatMap(page => [...read(page.file).matchAll(/<pre data-lang="([a-z]+)"(?: data-run="([a-z]+)")?><code>([\s\S]*?)<\/code><\/pre>/g)]
  .map(([, lang, run, body]) => ({file: page.file, lang, run, code: decode(body)})));

// Minimal stand-ins for the provider libraries the snippets import. They return a fixed
// reply so the SupaTrace half of each snippet really runs.
const PY_STUBS = {
  'openai/__init__.py': 'class _U:\n    total_tokens = 12\nclass _R:\n    usage = _U()\nclass _C:\n    def create(self, **kw):\n        return _R()\nclass _Chat:\n    completions = _C()\nclass OpenAI:\n    chat = _Chat()\n',
  'anthropic/__init__.py': 'class _U:\n    input_tokens = 5\n    output_tokens = 7\nclass _R:\n    usage = _U()\nclass _M:\n    def create(self, **kw):\n        return _R()\nclass Anthropic:\n    messages = _M()\n',
  'langchain_openai/__init__.py': 'class _R:\n    content = "hello"\nclass ChatOpenAI:\n    def __init__(self, **kw):\n        pass\n    def invoke(self, prompt):\n        return _R()\n',
  'llama_index/__init__.py': '', 'llama_index/llms/__init__.py': '',
  'llama_index/llms/openai/__init__.py': 'class _R:\n    text = "hello"\nclass OpenAI:\n    def __init__(self, **kw):\n        pass\n    def complete(self, prompt):\n        return _R()\n'
};
const JS_STUBS = {
  'openai': 'export default class OpenAI { chat = { completions: { create: async () => ({ usage: { total_tokens: 12 } }) } }; }\n',
  'ai': 'export const calls = []; export async function generateText(options) { calls.push(options); return { text: "hello", usage: { totalTokens: 12 } }; }\n',
  '@ai-sdk/openai': 'export const openai = model => ({ model });\n'
};
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'supatrace-docs-'));
  for (const [name, body] of Object.entries(PY_STUBS)) { mkdirSync(dirname(join(dir, 'stubs', name)), {recursive: true}); writeFileSync(join(dir, 'stubs', name), body); }
  for (const [name, body] of Object.entries(JS_STUBS)) {
    const root = join(dir, 'node_modules', name); mkdirSync(root, {recursive: true});
    writeFileSync(join(root, 'package.json'), JSON.stringify({name, type: 'module', main: 'index.mjs', exports: './index.mjs'}));
    writeFileSync(join(root, 'index.mjs'), body);
  }
  symlinkSync(join(repo, 'packages/supatrace-js'), join(dir, 'node_modules', 'supatrace'), 'dir');
  return dir;
}
// No endpoint, key or content switch may leak in from the developer's shell.
const env = extra => Object.fromEntries(Object.entries({...process.env, ...extra}).filter(([name]) => !/^(SUPATRACE_|OTEL_|TRACELOOP_|OPENINFERENCE_)/.test(name) || name in extra));

test('the sidebar lists exactly the pages under public/docs/', () => {
  const found = [];
  const walk = dir => { for (const entry of readdirSync(new URL(dir, pageUrl('docs/')), {withFileTypes: true})) { if (entry.isDirectory()) walk(dir + entry.name + '/'); else if (entry.name === 'index.html') found.push('/docs/' + dir); } };
  walk('');
  assert.deepEqual(found.sort(), [...DOCS.flatMap(group => group.items.map(item => item.href)), ...REDIRECTS.filter(page => page.file.startsWith('docs/')).map(page => '/' + page.file.replace('index.html', ''))].sort());
  for (const page of DOC_PAGES) {
    const html = read(page.file);
    assert.ok(html.includes(`<a href="${page.path}" aria-current="page">`), page.file + ' marks itself in the sidebar');
    assert.ok(html.includes('<script type="module" src="/docs/docs.js"></script>'), page.file + ' loads the copy script');
  }
  assert.ok(snippets.length >= 25, 'snippets were found');
});

test('every Python snippet in the docs runs against packages/supatrace and spools a batch the server accepts', {timeout: 120000}, () => {
  const python = snippets.filter(snippet => snippet.lang === 'python' && snippet.run !== 'otlp');
  assert.ok(python.length >= 10);
  for (const snippet of python) {
    assert.equal(snippet.run, 'py', snippet.file + ' python snippets are runnable');
    const dir = sandbox();
    try {
      const out = execFileSync('python3', ['-c', snippet.code], {cwd: dir, encoding: 'utf8', timeout: 30000, env: env({PYTHONPATH: join(repo, 'packages/supatrace/src') + ':' + join(dir, 'stubs'), HOME: dir})});
      if (/mode="otlp"/.test(snippet.code)) {
        assert.match(out, /^False /, snippet.file + ' sends nothing without an endpoint');
        // OTLP mode has no spool: the docs must not promise a saved file.
        assert.equal(existsSync(join(dir, 'spool')) || existsSync(join(dir, '.supatrace')), false, snippet.file + ' OTLP mode writes no file');
      }
      else if (/dry_run=True/.test(snippet.code)) assert.equal(out.trim(), 'True [] None', snippet.file);
      else assert.match(out, /^True spool\/[a-f0-9]{64}\.json\n$/, snippet.file);
      if (existsSync(join(dir, 'spool'))) for (const name of readdirSync(join(dir, 'spool'))) parseBatch(readFileSync(join(dir, 'spool', name), 'utf8'));
      assert.equal(existsSync(join(dir, '.supatrace')) && !/mode="otlp"/.test(snippet.code), false, snippet.file + ' writes only to the spool it names');
    } finally { rmSync(dir, {recursive: true, force: true}); }
  }
});

test('every JavaScript snippet in the docs runs against packages/supatrace-js and spools a batch the server accepts', {timeout: 120000}, () => {
  const scripts = snippets.filter(snippet => snippet.lang === 'js' && snippet.run !== 'otlp');
  assert.ok(scripts.length >= 5);
  for (const snippet of scripts) {
    assert.equal(snippet.run, 'js', snippet.file + ' js snippets are runnable');
    const dir = sandbox();
    try {
      writeFileSync(join(dir, 'snippet.mjs'), snippet.code);
      const out = execFileSync(process.execPath, ['snippet.mjs'], {cwd: dir, encoding: 'utf8', timeout: 30000, env: env({HOME: dir})});
      if (/mode: "otlp"/.test(snippet.code)) {
        assert.match(out, /^false \[/, snippet.file + ' sends nothing without an endpoint');
        assert.equal(existsSync(join(dir, 'spool')) || existsSync(join(dir, '.supatrace')), false, snippet.file + ' OTLP mode writes no file');
      }
      else assert.match(out, /^true spool\/[a-f0-9]{64}\.json\n$/, snippet.file);
      if (existsSync(join(dir, 'spool'))) for (const name of readdirSync(join(dir, 'spool'))) parseBatch(readFileSync(join(dir, 'spool', name), 'utf8'));
    } finally { rmSync(dir, {recursive: true, force: true}); }
  }
});

test('every SDK symbol, option and environment variable named in the docs exists in the SDK source', () => {
  const agent = readdirSync(join(repo, 'agent')).filter(name => name.endsWith('.py')).map(name => readFileSync(join(repo, 'agent', name), 'utf8')).join('\n');
  for (const page of DOC_PAGES) {
    const html = decode(read(page.file));
    for (const [name] of html.matchAll(/SUPATRACE_[A-Z_]+/g)) assert.ok(pySource.includes(name) || jsSource.includes(name) || agent.includes(name), page.file + ' names unknown ' + name);
  }
  const prose = DOC_PAGES.map(page => decode(read(page.file)).replace(/<pre[\s\S]*?<\/pre>/g, '')).join('\n');
  for (const [, name] of prose.matchAll(/<code>(?:trace|supatrace)\.([A-Za-z_]+)/g)) assert.ok(new RegExp(`def ${name}\\(|\\b${name}\\(|trace\\.${name} = |get ${name}\\(`).test(pySource + jsSource), 'prose names unknown ' + name);
  for (const snippet of snippets.filter(item => item.lang === 'python' && item.run !== 'otlp')) {
    for (const [, name] of snippet.code.matchAll(/\bsupatrace\.([a-z_]+)\(/g)) assert.match(pySource, new RegExp(`^def ${name}\\(`, 'm'), snippet.file + ' supatrace.' + name);
    for (const [, name] of snippet.code.matchAll(/\btrace\.([a-z_]+)/g)) assert.match(pySource, new RegExp(`^    def ${name}\\(`, 'm'), snippet.file + ' trace.' + name);
    for (const [, args] of snippet.code.matchAll(/supatrace\.init\(([^)]*)\)/g)) for (const [, option] of args.matchAll(/\b([a-z_]+)=/g)) assert.ok(pySource.includes(`options.get("${option}")`), snippet.file + ' init option ' + option);
    for (const [, key] of snippet.code.matchAll(/trace\.capture\["([a-z_]+)"\]/g)) assert.ok(pySource.includes(`"${key}":`), snippet.file + ' capture key ' + key);
  }
  for (const snippet of snippets.filter(item => item.lang === 'js' && item.run !== 'otlp')) {
    for (const [, names] of snippet.code.matchAll(/import \{([^}]+)\} from "@supatrace\/client"/g)) for (const name of names.split(',').map(item => item.trim())) assert.equal(typeof jsSdk[name], 'function', snippet.file + ' export ' + name);
    for (const [, name] of snippet.code.matchAll(/\btrace\.([A-Za-z]+)/g)) assert.ok(name in jsSdk.SupaTrace.prototype || jsSource.includes(`trace.${name} = `), snippet.file + ' trace.' + name);
    for (const [, options] of snippet.code.matchAll(/init\("[a-z-]+", \{([^}]*)\}\)/g)) for (const [, option] of options.matchAll(/\b([A-Za-z]+):/g)) assert.ok(jsSource.includes(`options.${option}`), snippet.file + ' init option ' + option);
    for (const [, key] of snippet.code.matchAll(/trace\.capture\.([A-Za-z]+)/g)) assert.ok(new RegExp(`\\b${key}:`).test(jsSource), snippet.file + ' capture key ' + key);
  }
  // Commands the docs tell people to run name files that ship.
  for (const snippet of snippets.filter(item => item.lang === 'sh')) {
    for (const [, script] of snippet.code.matchAll(/python3 ([a-z_]+\.py)/g)) assert.ok(existsSync(join(repo, 'agent', script)), snippet.file + ' ' + script);
    for (const [, script] of snippet.code.matchAll(/node (agent\/[a-z_]+\.mjs)/g)) assert.ok(existsSync(join(repo, script)), snippet.file + ' ' + script);
    for (const [, path] of snippet.code.matchAll(/install (\.\/packages\/[a-z-]+)/g)) assert.ok(existsSync(join(repo, path)), snippet.file + ' ' + path);
    for (const [, flag] of snippet.code.matchAll(/(--[a-z-]+)/g)) assert.ok(agent.includes(`'${flag}'`), snippet.file + ' flag ' + flag);
  }
});

test('the docs distinguish available hosted OTLP from the unpublished SDK', () => {
  const api = readFileSync(join(repo, 'src/aws-api.mjs'), 'utf8') + readFileSync(join(repo, 'aws/handler.mjs'), 'utf8');
  const hosted = /['"`]\/v1\/traces/.test(api);
  assert.ok(hosted, 'the hosted receiver exists');
  assert.match(readFileSync(join(repo, 'docs/otlp-ingest.md'), 'utf8'), /\*\*Available\*\* on https:\/\/supatrace\.dev/);
  for (const page of DOC_PAGES) {
    const html = read(page.file), shown = decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
    assert.doesNotMatch(shown, /pip install supatrace\b|npm install (?:@supatrace\/client|@supatrace\/js|supatrace)\b|npx supatrace/, page.file + ' has no registry install');
    assert.doesNotMatch(shown, /https:\/\/(?:otlp|api|ingest)\.supatrace\.dev/, page.file + ' invents no endpoint URL');
    if (/@supatrace\/client|import supatrace/.test(shown)) assert.match(shown, /not published to PyPI or npm/, page.file + ' says the SDK is unpublished');
    assert.doesNotMatch(shown, /not reachable on|hosted edge pending/, page.file + ' has no stale hosted status');
    assert.doesNotMatch(shown, /#99|not live yet/, page.file + ' has no stale OTLP wording');
  }
  assert.match(read('docs/frameworks/opentelemetry/index.html'), /nothing is sent and nothing is saved/);
  // Cross-page anchors into the setup guide resolve.
  const guide = read('agent-setup.html');
  for (const page of DOC_PAGES) for (const [, anchor] of read(page.file).matchAll(/href="\/agent-setup\.html#([a-z-]+)"/g)) assert.ok(guide.includes(`id="${anchor}"`), page.file + ' #' + anchor);
});

test('workspace controls named in the docs exist in the app with the same label', () => {
  const app = readFileSync(join(repo, 'public/app/index.html'), 'utf8').replace(/<[^>]+>/g, '\n');
  const docs = DOC_PAGES.map(page => read(page.file)).join('\n');
  for (const label of ['Export original JSON', 'Export selected environment', 'Export all workspace environments', 'Download prepared archive', 'Prepare redacted copy', 'API keys', 'Agents', 'Traces']) {
    assert.ok(docs.includes(`<strong>${label}</strong>`), 'docs name ' + label);
    assert.ok(app.split('\n').some(line => line.trim() === label), 'the app has no control labelled "' + label + '"');
  }
  assert.ok(docs.includes('<strong>Refresh Traces</strong>'));
  assert.ok(app.split('\n').some(line => line.trim() === 'Refresh'), 'Traces uses the short Refresh label');
  assert.ok(readFileSync(join(repo, 'agent/upload.py'), 'utf8').includes('Accepted by server'));
  // The Langfuse section describes the in-app server pull the app and template actually ship.
  const importers = read('docs/importers/index.html');
  assert.ok(importers.includes('<strong>Import from Langfuse</strong>') && app.includes('Import from Langfuse'));
  assert.ok(app.includes('100 observations, 10 pages, 50 rows per page and 128 KiB source JSON'));
  assert.match(importers, /100 observations, 10 pages, 50 rows per page and 128 KiB of source JSON/);
  assert.match(readFileSync(join(repo, 'aws/template.yaml'), 'utf8'), /ServerPullConfig:[\s\S]{0,80}Default: '\{"mode":"bounded-server-pull-v1","origin":"https:\/\/supatrace\.dev"\}'/);
  assert.match(importers, /id="langfuse">Langfuse <span class="status beta">beta<\/span>/);
  assert.doesNotMatch(importers, /disabled in the hosted alpha|no customer-run Langfuse import/);
  const exportPage = read('docs/export/index.html');
  assert.match(exportPage, /reads only the environment shown/);
  assert.match(exportPage, /streams straight to it[\s\S]*no separate download step[\s\S]*Without Save File support[\s\S]*Download prepared archive/);
  assert.doesNotMatch(exportPage, /every indexed trace in the project|Export account|Download account archive/);
});


test('onboarding leads with public paths and keeps stock exporter examples identical', () => {
  const quick = read('docs/quickstart/index.html');
  assert.ok(quick.indexOf('id="home"') < quick.indexOf('id="otlp"'));
  assert.ok(quick.indexOf('id="otlp"') < quick.indexOf('id="today"'));
  assert.match(quick, /about 30 seconds after sign-in/);
  assert.match(read('index.html'), /href="\/docs\/quickstart\/">Read the setup guide/);
  const guide = read('agent-setup.html');
  assert.ok(guide.indexOf('/docs/quickstart/#home') < guide.indexOf('/docs/quickstart/#otlp'));
  assert.ok(guide.indexOf('/docs/quickstart/#otlp') < guide.indexOf('id="reviewed-scripts"'));
  const md = readFileSync(join(repo, 'docs/otlp-ingest.md'), 'utf8');
  for (const file of ['docs/quickstart/index.html', 'docs/frameworks/opentelemetry/index.html']) {
    const blocks = snippets.filter(item => item.file === file && item.run === 'otlp');
    assert.deepEqual(blocks.map(item => item.code), [OTLP_PYTHON, OTLP_JS]);
    assert.ok(decode(read(file)).includes(OTLP_ENV));
    assert.match(read(file), /no gRPC, metrics or logs/i);
  }
  for (const code of [OTLP_ENV, OTLP_PYTHON, OTLP_JS, OTLP_CURL]) assert.ok(md.includes(code));
  assert.match(OTLP_PYTHON, /SimpleSpanProcessor\(OTLPSpanExporter\(\)\)/);
  assert.match(OTLP_JS, /new SimpleSpanProcessor\(new OTLPTraceExporter\(\)\)/);
  for (const code of [OTLP_PYTHON, OTLP_JS]) {
    assert.ok(code.includes('gen_ai.request.model'));
    assert.ok(code.includes('provider.shutdown()'));
  }
});

test('public docs state current allowances, key lifetimes and private-checkout limits', () => {
  assert.match(read('docs/index.html'), /50,000 spans per UTC month, 1 GB stored, 2 projects/);
  assert.match(read('docs/export/index.html'), /On Free that is 7 days/);
  for (const file of [...DOC_PAGES.map(page => page.file), 'agent-setup.html', 'llms.txt', 'integrations/index.html', 'changelog/index.html']) {
    const html = read(file);
    assert.doesNotMatch(html, /github\.com\/SlanchaAI\/supatrace(?:[\/#"]|$)/, file);
    assert.doesNotMatch(html, /not reachable on (?:https:\/\/)?supatrace\.dev yet|hosted edge pending|100k spans|100,000 spans per UTC/, file);
    if (html.includes('private checkout') || html.includes('private repository')) assert.match(html, /unavailable to outside users|private repository access/, file);
  }
  for (const file of ['docs/quickstart/index.html', 'docs/keys/index.html', 'agent-setup.html']) {
    const shown = decode(read(file).replace(/<[^>]+>/g, ' '));
    assert.match(shown, /keys from pairing an agent last 30 days/);
    assert.match(shown, /do not expire/);
  }
  const sample = JSON.parse(read('examples/first-trace.json'));
  assert.equal(sample.run_id, 'first-trace-example');
  assert.ok(sample.events.every(event => event.time.startsWith('2026-11-')));
});
