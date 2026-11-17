import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';

const root = new URL('../public/', import.meta.url);

test('public files outside fixtures never link to the private repository', () => {
  const files = directory => readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    return entry.isDirectory() ? (entry.name === 'fixtures' ? [] : files(path)) : [path];
  });
  for (const path of files(root)) {
    assert.ok(!readFileSync(path, 'utf8').toLowerCase().includes('github.com/slanchaai/supatrace'), path.pathname);
  }
});

test('import plans disclose unavailable local importers and offer hosted paths', () => {
  const html = readFileSync(new URL('app/index.html', root), 'utf8');
  for (const importer of ['braintrust', 'langsmith']) {
    const output = html.split(`<div id="${importer}-output" hidden>`)[1].split('</section>')[0];
    assert.ok(output.includes(`The local ${importer === 'braintrust' ? 'Braintrust' : 'LangSmith'} importer is not available to outside users yet.`));
    assert.ok(output.includes('<a href="#home">Home snippets</a>'));
    assert.ok(output.includes('<a href="/docs/frameworks/opentelemetry/">hosted OTLP</a>'));
    assert.ok(html.includes(`id="${importer}-form"`));
    assert.ok(output.includes(`id="${importer}-command"`));
  }
});
