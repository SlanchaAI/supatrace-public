// The public changelog is stamped from scripts/changelog.mjs. Entries are real merged pull
// requests; "deployed" is only claimed for commits on main. The history checks run when the
// checkout has full history and an origin/main ref (they are skipped in shallow CI clones).
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {CHANGELOG, LAST_DEPLOY} from '../scripts/changelog.mjs';
import {changelogList, longDate, pageUrl, FOOTER} from '../scripts/site-pages.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const git = (...args) => spawnSync('git', ['-C', repo, ...args], {encoding: 'utf8'});

test('changelog entries are well formed, newest first and never dated after the last deploy when deployed', () => {
  assert.ok(CHANGELOG.length >= 10);
  assert.equal(new Set(CHANGELOG.map(entry => entry.pr)).size, CHANGELOG.length);
  for (const [index, entry] of CHANGELOG.entries()) {
    assert.match(entry.date, /^2026-(10|11|12)-\d\d$/, 'pr ' + entry.pr);
    assert.ok(!Number.isNaN(Date.parse(entry.date + 'T00:00:00Z')));
    assert.ok(Number.isInteger(entry.pr) && entry.pr > 0);
    assert.match(entry.commit, /^[0-9a-f]{10}$/);
    assert.ok(['deployed', 'merged'].includes(entry.state));
    assert.ok(entry.title.length > 5 && entry.body.length > 20 && !/[<>]/.test(entry.title + entry.body));
    if (index) assert.ok(CHANGELOG[index - 1].date >= entry.date, 'newest first at pr ' + entry.pr);
    if (entry.state === 'deployed') assert.ok(entry.date <= LAST_DEPLOY.date, 'pr ' + entry.pr + ' cannot be deployed after the last recorded deploy');
  }
});

test('the changelog page shows every entry with its date, state and pull request, and is linked in the footer', () => {
  const html = readFileSync(pageUrl('changelog/index.html'), 'utf8');
  assert.ok(html.includes(changelogList()));
  const shown = [...html.matchAll(/<li class="change" data-pr="(\d+)" data-state="([a-z]+)"><time datetime="([\d-]+)">([^<]+)<\/time>/g)];
  assert.deepEqual(shown.map(item => [Number(item[1]), item[2], item[3], item[4]]), CHANGELOG.map(entry => [entry.pr, entry.state, entry.date, longDate(entry.date)]));
  assert.equal(longDate('2026-11-05'), 'November 5, 2026');
  assert.ok(FOOTER.some(item => item.href === '/changelog/'));
  for (const file of ['index.html', 'pricing/index.html', 'docs/index.html']) assert.ok(readFileSync(pageUrl(file), 'utf8').includes('<a href="/changelog/">Changelog</a>'), file + ' footer');
  const text = html.replace(/<[^>]+>/g, ' ');
  assert.match(text, /merged, not deployed/);
  assert.doesNotMatch(text, /generally available|\bGA\b|launch week/i);
});

test('against git history: each entry is a real commit, and deployed entries are on main', t => {
  if (git('rev-parse', '--is-shallow-repository').stdout.trim() !== 'false' || git('rev-parse', '--verify', '--quiet', 'origin/main').status !== 0) return t.skip('needs full history and origin/main');
  for (const entry of CHANGELOG) {
    assert.equal(git('cat-file', '-e', entry.commit + '^{commit}').status, 0, 'pr ' + entry.pr + ' commit ' + entry.commit);
    if (entry.state === 'deployed') assert.equal(git('merge-base', '--is-ancestor', entry.commit, 'origin/main').status, 0, 'pr ' + entry.pr + ' is on main');
  }
  assert.equal(git('merge-base', '--is-ancestor', LAST_DEPLOY.commit, 'origin/main').status, 0);
});
