// The public /integrations directory is stamped from INTEGRATIONS in scripts/site-pages.mjs.
// Each tile's status must match the linked guide and be backed by files in the repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {INTEGRATIONS, STATUSES, integrationsList, pageUrl} from '../scripts/site-pages.mjs';
import {formats} from '../public/file-import-plan.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const read = file => readFileSync(pageUrl(file), 'utf8');
const items = INTEGRATIONS.flatMap(group => group.items);
// What in the repository backs each non-planned status.
const EVIDENCE = {
  langchain: ['packages/supatrace/src/supatrace/__init__.py'], llamaindex: ['packages/supatrace/src/supatrace/__init__.py'],
  openai: ['packages/supatrace/src/supatrace/__init__.py', 'packages/supatrace-js/index.mjs'], anthropic: ['packages/supatrace/src/supatrace/__init__.py'],
  'vercel-ai-sdk': ['packages/supatrace-js/index.mjs'],
  'langsmith-api': ['src/importers/langsmith-transport.mjs', 'docs/langsmith-api-import.md'],
  'braintrust-api': ['src/importers/braintrust-transport.mjs', 'docs/braintrust-api-import.md'],
  langfuse: ['src/server-pull-import.mjs', 'docs/server-pull-import.md'],
  'otlp-ingest': ['docs/otlp-ingest.md', 'tests/otlp-ingest.test.mjs'], 'langfuse-sdk': ['docs/langfuse-compatible-ingest.md', 'tests/langfuse-ingest.test.mjs'],
  'claude-snapshot': ['agent/claude_snapshot.py'], 'claude-hooks': ['agent/claude_hook.py', 'docs/claude-hooks.md'],
  mcp: ['mcp/server.mjs', 'mcp/README.md']
};

test('every integration has a known status, a unique id and a guide that states the same status', () => {
  assert.equal(new Set(items.map(item => item.id)).size, items.length);
  for (const item of items) {
    assert.ok(item.status in STATUSES, item.id + ' status');
    assert.ok(item.name && item.summary.length > 20, item.id + ' copy');
    const [path, anchor] = item.href.split('#');
    assert.match(path, /^\/docs\/[a-z/-]+\/$/, item.id + ' links a docs page');
    const guide = read(path.slice(1) + 'index.html');
    let scope = guide;
    if (anchor) {
      const section = guide.split('<section ').find(part => part.includes(`id="${anchor}"`));
      assert.ok(section, item.id + ' anchor #' + anchor);
      scope = section;
    }
    assert.ok(scope.includes(`<span class="status ${item.status}">`), `${item.id} is "${item.status}" but ${item.href} does not say so`);
  }
});

test('statuses are backed by the repository and file importers match the shipped format list', () => {
  for (const item of items) {
    if (item.status === 'planned') { assert.equal(EVIDENCE[item.id], undefined, item.id); continue; }
    if (item.format) continue;
    assert.ok(EVIDENCE[item.id]?.length, item.id + ' names its evidence');
    for (const file of EVIDENCE[item.id]) assert.ok(existsSync(repo + file), item.id + ' ' + file);
  }
  const fileImports = items.filter(item => item.format);
  assert.deepEqual(fileImports.map(item => item.format).sort(), [...formats].sort());
  for (const item of fileImports) assert.equal(item.status, 'preview', item.id);
  const guide = read('docs/importers/index.html');
  for (const name of ['LangSmith', 'Braintrust', 'Weave', 'Opik', 'Datadog LLM Observability', 'MLflow', 'Helicone', 'OTLP HTTP JSON']) assert.ok(guide.includes(name), name);
  // The Python SDK only knows these instrumentors; SDK-backed tiles stay "preview" while it is unpublished.
  const sdk = readFileSync(repo + 'packages/supatrace/pyproject.toml', 'utf8') + readFileSync(repo + 'packages/supatrace-js/package.json', 'utf8');
  if (/Not deployable/.test(sdk)) for (const id of ['langchain', 'llamaindex', 'openai', 'anthropic', 'vercel-ai-sdk']) assert.equal(items.find(item => item.id === id).status, 'preview', id);
});

test('the integrations page leads with live paths, then beta and one closed Coming soon section', () => {
  const html = read('integrations/index.html');
  assert.ok(html.includes(integrationsList()));
  const tiles = [...html.matchAll(/data-integration="([a-z-]+)" data-status="([a-z]+)"/g)];
  assert.deepEqual(tiles.map(tile => [tile[1], tile[2]]), ['otlp-ingest', 'claude-snapshot', 'langfuse-sdk', 'langfuse', 'claude-hooks'].map(id => [id, items.find(item => item.id === id).status]));
  assert.ok(html.indexOf('id="integrations-live"') < html.indexOf('id="integrations-beta"'));
  assert.equal((html.match(/<details/g) || []).length, 1);
  assert.ok(html.includes('<details class="coming-soon"><summary>Coming soon</summary>'));
  assert.equal((html.match(/Until these ship, use Home snippets or hosted OTLP\./g) || []).length, 1);
  for (const text of ['Traces only. No gRPC, metrics, or logs.', 'This is not a live tail.', 'This only receives traces.', 'Metadata only by default.', 'SDK packages are not on PyPI or npm yet.', 'Private checkout only.', 'Not a hosted MCP endpoint.']) assert.ok(html.includes(text), text);
  for (const match of html.matchAll(/href="(\/docs\/[^"#]*)(?:#[^"]*)?"/g)) assert.ok(existsSync(repo + 'public' + match[1] + 'index.html'), match[1]);
});
// The in-app Integrations view links into the directory above; its tests load here so the root `npm test` list does not change.
import './integrations-view.test.mjs';
