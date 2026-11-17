// /build.json tells anyone which commit a deployed site serves. It is stamped at publish
// time by scripts/build-marker.mjs (AWS deploy workflow or a Cloudflare Pages build command)
// and is "unstamped" in the repository, so a stale SHA can never be committed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {marker, serialize, UNSTAMPED} from '../scripts/build-marker.mjs';
import {PAGES, pageUrl} from '../scripts/site-pages.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const sha = 'a'.repeat(40), now = new Date('2026-11-14T00:00:00Z');

test('the marker takes the commit from the AWS deploy or the Cloudflare Pages build environment', () => {
  assert.deepEqual(marker({GITHUB_SHA: sha, GITHUB_REF_NAME: 'main'}, now), {schema: 1, commit: sha, short: 'aaaaaaa', ref: 'main', source: 'github-actions', built_at: '2026-11-14T00:00:00.000Z'});
  assert.deepEqual(marker({CF_PAGES_COMMIT_SHA: sha, CF_PAGES_BRANCH: 'stfinish/74-build-marker'}, now), {schema: 1, commit: sha, short: 'aaaaaaa', ref: 'stfinish/74-build-marker', source: 'cloudflare-pages', built_at: '2026-11-14T00:00:00.000Z'});
  assert.equal(marker({GITHUB_SHA: sha, CF_PAGES_COMMIT_SHA: 'b'.repeat(40)}, now).source, 'github-actions');
  assert.equal(marker({GITHUB_SHA: sha, GITHUB_REF_NAME: 'bad ref\n<script>'}, now).ref, null);
  for (const bad of [{}, {GITHUB_SHA: 'abc'}, {GITHUB_SHA: sha.toUpperCase()}, {CF_PAGES_COMMIT_SHA: sha + '\n'}, {GITHUB_SHA: '<script>alert(1)</script>'}]) assert.throws(() => marker(bad, now));
});

test('the command writes the marker, and refuses to write one without a commit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'supatrace-build-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(GITHUB_|CF_PAGES_)/.test(name)));
  try {
    const out = join(dir, 'build.json'), script = join(repo, 'scripts/build-marker.mjs');
    execFileSync(process.execPath, [script, '--out', out], {env: {...env, CF_PAGES_COMMIT_SHA: sha, CF_PAGES_BRANCH: 'preview'}});
    const written = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(written.commit, sha);
    assert.equal(written.source, 'cloudflare-pages');
    assert.ok(Date.parse(written.built_at) > 0);
    const refused = spawnSync(process.execPath, [script, '--out', join(dir, 'none.json')], {env, encoding: 'utf8'});
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /build marker not written/);
    assert.throws(() => readFileSync(join(dir, 'none.json')));
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('the repository copy is unstamped and every public page can show a stamped build', () => {
  assert.equal(readFileSync(pageUrl('build.json'), 'utf8'), serialize(UNSTAMPED));
  assert.equal(UNSTAMPED.commit, null);
  for (const page of PAGES) {
    const html = readFileSync(pageUrl(page.file), 'utf8');
    assert.ok(html.includes('<span id="build" class="build" hidden></span>'), page.file + ' has the build slot');
    assert.ok(html.includes('<script type="module" src="/build.js"></script>'), page.file + ' loads build.js');
  }
  const script = readFileSync(pageUrl('build.js'), 'utf8');
  assert.match(script, /fetch\('\/build\.json'/);
  assert.match(script, /textContent/);
  assert.doesNotMatch(script, /innerHTML/);
});

test('the AWS deploy stamps the marker before publishing and the smoke check requires this release', () => {
  const deploy = readFileSync(join(repo, '.github/workflows/deploy.yml'), 'utf8');
  const stamp = deploy.indexOf('node scripts/build-marker.mjs'), sync = deploy.indexOf('aws s3 cp public/ "s3://${STATIC_BUCKET}/" --recursive');
  assert.ok(stamp > 0 && stamp < sync, 'stamped before the static sync');
  assert.match(deploy, /curl -sS -o \/tmp\/build\.json -w '%\{http_code\}' "https:\/\/\$\{host\}\/build\.json"/);
  assert.match(deploy, /json\.load\(open\("\/tmp\/build\.json"\)\)\.get\("commit"\)==os\.environ\["GITHUB_SHA"\]/);
  // No AWS resource is added for this: the template does not mention the marker.
  assert.doesNotMatch(readFileSync(join(repo, 'aws/template.yaml'), 'utf8'), /build\.json|build-marker/);
  const docs = readFileSync(join(repo, 'aws/DEPLOYMENT.md'), 'utf8');
  assert.match(docs, /build\.json/);
  assert.match(docs, /node scripts\/build-marker\.mjs/);
});
