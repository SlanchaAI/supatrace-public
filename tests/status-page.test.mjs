// /status/ reads an optional public health feed. The reader must never present a missing,
// malformed or stale feed as current status.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {readFeed, time, STALE_AFTER_MS, CLOCK_SKEW_MS, MAX_ITEMS, STATES} from '../public/status/feed.js';
import {pageUrl, FOOTER} from '../scripts/site-pages.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const now = Date.parse('2026-11-14T20:00:00Z');
const feed = extra => ({schema: 1, source: 'probe', updated_at: '2026-11-14T19:58:00Z', components: [{name: 'Uploads', status: 'operational'}, {name: 'Dashboard', status: 'degraded', note: 'slow'}], incidents: [], ...extra});

test('the repository feed means "no monitoring feed", and the page says so without JavaScript', () => {
  const committed = JSON.parse(readFileSync(pageUrl('status.json'), 'utf8'));
  assert.equal(committed.updated_at, null);
  assert.deepEqual(readFeed(committed, now), {kind: 'none'});
  const html = readFileSync(pageUrl('status/index.html'), 'utf8'), shown = html.replace(/<[^>]+>/g, ' ');
  assert.match(shown, /No monitoring feed is published yet\./);
  assert.equal((shown.match(/No monitoring feed is published yet/g) || []).length, 1, 'only inside the block the script replaces');
  assert.ok(html.indexOf('No monitoring feed is published yet') > html.indexOf('<div id="feed">') && html.indexOf('No monitoring feed is published yet') < html.indexOf('</div>', html.indexOf('<div id="feed">')));
  assert.match(shown, /There is no hosted status page and no uptime commitment/);
  assert.match(shown, /They do not test sign-in, uploads or export, and they are not a record of past availability/);
  assert.doesNotMatch(shown, /All systems operational|99\.\d|uptime of|status\.supatrace\.dev/i);
  assert.ok(FOOTER.some(item => item.href === '/status/'));
  assert.ok(readFileSync(pageUrl('index.html'), 'utf8').includes('<a href="/status/">Status</a>'));
});

test('a fresh valid feed is current and reports the worst component', () => {
  const result = readFeed(feed(), now);
  assert.equal(result.kind, 'current');
  assert.equal(result.overall, 'degraded');
  assert.deepEqual(result.components, [{name: 'Uploads', status: 'operational', note: null}, {name: 'Dashboard', status: 'degraded', note: 'slow'}]);
  assert.equal(readFeed(feed({components: [{name: 'Uploads', status: 'outage'}, {name: 'Dashboard', status: 'operational'}]}), now).overall, 'outage');
  const incident = readFeed(feed({incidents: [{title: 'Uploads rejected', started_at: '2026-11-14T18:00:00Z', resolved_at: '2026-11-14T18:20:00Z', body: 'Fixed.'}]}), now).incidents[0];
  assert.deepEqual(incident, {title: 'Uploads rejected', started_at: '2026-11-14T18:00:00.000Z', resolved_at: '2026-11-14T18:20:00.000Z', body: 'Fixed.'});
  assert.deepEqual(STATES, ['operational', 'degraded', 'outage']);
});

test('a stale or future-dated feed is never current', () => {
  const old = new Date(now - STALE_AFTER_MS - 1000).toISOString();
  assert.equal(readFeed(feed({updated_at: old}), now).kind, 'stale');
  assert.equal(readFeed(feed({updated_at: old}), now).overall, undefined);
  assert.equal(readFeed(feed({updated_at: new Date(now + STALE_AFTER_MS + 1000).toISOString()}), now).kind, 'stale');
  assert.equal(readFeed(feed({updated_at: new Date(now + CLOCK_SKEW_MS + 1000).toISOString()}), now).kind, 'stale', 'beyond the clock allowance');
  assert.equal(readFeed(feed({updated_at: new Date(now + CLOCK_SKEW_MS - 1000).toISOString()}), now).kind, 'current', 'within the clock allowance');
  assert.equal(CLOCK_SKEW_MS, 2 * 60 * 1000);
  // The same feed read later is stale: classification depends on the time of reading.
  assert.equal(readFeed(feed(), now + STALE_AFTER_MS).kind, 'stale');
  assert.equal(readFeed(feed({updated_at: new Date(now - STALE_AFTER_MS + 1000).toISOString()}), now).kind, 'current');
});

test('malformed feeds are invalid, not partially shown', () => {
  // A supplied optional field that is wrong rejects the feed; it is never dropped silently.
  const component = extra => feed({components: [{name: 'Uploads', status: 'operational', ...extra}]});
  const incident = extra => feed({incidents: [{title: 'Uploads rejected', started_at: '2026-11-14T18:00:00Z', ...extra}]});
  for (const bad of [component({note: 'x'.repeat(301)}), component({note: 5}), component({note: {}}), incident({body: {}}), incident({body: 'x'.repeat(1001)}), incident({resolved_at: 'not a date'}), incident({resolved_at: 5}), incident({resolved_at: '2026-11-14T17:00:00Z'})]) assert.deepEqual(readFeed(bad, now), {kind: 'invalid'});
  assert.equal(readFeed(component({note: null}), now).components[0].note, null);
  assert.equal(readFeed(incident({resolved_at: null, body: undefined}), now).incidents[0].resolved_at, null);
  assert.equal(readFeed(incident({resolved_at: '2026-11-14T18:20:00Z'}), now).incidents[0].resolved_at, '2026-11-14T18:20:00.000Z');
  // An outage after the display limit can never be dropped from the overall state.
  const many = Array.from({length: MAX_ITEMS}, (_, index) => ({name: 'Component ' + index, status: 'operational'}));
  assert.equal(readFeed(feed({components: many}), now).overall, 'operational');
  assert.deepEqual(readFeed(feed({components: [...many, {name: 'Hidden', status: 'outage'}]}), now), {kind: 'invalid'});
  assert.deepEqual(readFeed(feed({components: [...many.slice(1), {name: 'Last', status: 'outage'}]}), now).overall, 'outage');
  assert.deepEqual(readFeed(feed({incidents: Array.from({length: MAX_ITEMS + 1}, () => ({title: 'x', started_at: '2026-11-14T18:00:00Z'}))}), now), {kind: 'invalid'});
  for (const bad of [null, [], 'up', {schema: 2, updated_at: '2026-11-14T19:58:00Z'}, feed({components: []}), feed({components: 'operational'}), feed({components: [{name: 'Uploads', status: 'fine'}]}), feed({components: [{name: '', status: 'operational'}]}), feed({components: [{name: 'x'.repeat(81), status: 'operational'}]}), feed({incidents: [{title: 'No start'}]}), feed({incidents: {}})]) assert.deepEqual(readFeed(bad, now), {kind: 'invalid'});
  // A present but malformed timestamp is a broken feed, not "no feed", and impossible dates are refused.
  assert.deepEqual(readFeed({schema: 1, updated_at: 'not a date', components: [], incidents: []}, now), {kind: 'invalid'});
  for (const stamp of ['2026-11-31T00:00:00Z', '2026-02-30T10:00:00Z', '2026-13-01T00:00:00Z', '2026-11-14T24:00:00Z', '2026-11-14T10:60:00Z', '2026-11-14', '2026-11-14T10:00:00', 'November 14, 2026', '2026-11-14T10:00:00+99:00', 1763150400000, '']) {
    assert.equal(time(stamp), null, String(stamp));
    assert.deepEqual(readFeed(feed({updated_at: stamp}), Date.parse('2026-12-01T00:05:00Z')), {kind: 'invalid'}, String(stamp));
    assert.deepEqual(readFeed(feed({incidents: [{title: 'x', started_at: stamp}]}), now), {kind: 'invalid'}, 'incident ' + stamp);
  }
  assert.equal(time('2026-11-14T19:58:00Z'), '2026-11-14T19:58:00.000Z');
  assert.equal(time('2026-11-14T20:58:00.5+01:00'), '2026-11-14T19:58:00.500Z');
  assert.equal(time('2028-02-29T00:00:00Z'), '2028-02-29T00:00:00.000Z');
});

test('the page script renders feed text safely and the operator steps are documented', () => {
  const script = readFileSync(pageUrl('status/status.js'), 'utf8');
  assert.doesNotMatch(script, /innerHTML|insertAdjacentHTML|document\.write/);
  for (const path of ["'/build.json'", "'/api/auth/providers'", "'/status.json'"]) assert.ok(script.includes(path), path);
  const docs = readFileSync(repo + 'docs/status-page.md', 'utf8');
  for (const fact of ['"updated_at": null', 'more than 15 minutes old', 'more than 2 minutes in the future', 'rejected rather than truncated', '`POST /api/batches`', 'Operator actions (not done)', 'status.supatrace.dev', 'GET /api/health', '--cache-control no-store', '--exclude "status.json"', 'create-invalidation', 'default TTL is 24 hours']) assert.ok(docs.includes(fact), fact);
  // The docs' claims about the deploy and API hold.
  const deploy = readFileSync(repo + '.github/workflows/deploy.yml', 'utf8');
  assert.match(deploy, /aws s3 cp public\/ "s3:\/\/\$\{STATIC_BUCKET\}\/" --recursive --exclude "_headers" --exclude "\*\/_headers" --sse AES256 --cache-control "no-cache" --only-show-errors/);
  assert.ok(readFileSync(repo + 'src/aws-api.mjs', 'utf8').includes('/api/auth/providers'));
  // The caching section describes the real edge: static files use the managed CachingOptimized policy,
  // the release upload writes status.json today, with Cache-Control: no-cache, and does not exclude it.
  assert.match(readFileSync(repo + 'aws/template.yaml', 'utf8'), /DefaultCacheBehavior:\n\s+TargetOriginId: static[\s\S]{0,200}CachePolicyId: 658327ea-f89d-4fab-a63d-7e88639e58f6/);
  assert.doesNotMatch(deploy, /--exclude "status\.json"/);
  assert.ok(readFileSync(repo + 'src/aws-api.mjs', 'utf8').includes("'/api/batches'"));
  assert.doesNotMatch(docs, /10 MiB/, 'the probe guidance names the current allowance, not the old lifetime cap');
  assert.match(docs, /50,000 spans per UTC month on Free, which resets/);
  assert.match(script, /const key = feed\.kind \+ '\|' \+ JSON\.stringify\(last \?\? null\);/, 'render key covers the whole feed');
  assert.match(script, /const mine = \+\+generation;[\s\S]*if \(mine !== generation\) return;\n  last = result;/, 'an older response cannot replace a newer one');
  assert.match(script, /setInterval\(show, 5000\)/, 'cached feed is re-classified without the network');
  assert.match(script, /setInterval\(\(\) => \{ if \(document\.visibilityState === 'visible'\) refresh\(\); \}, 60000\)/);
  assert.match(script, /visibilitychange/);
  assert.equal(existsSync(pageUrl('build.json')), true);
});

test('static files are revalidated on every request and the dashboard recovers from a cached page of another release', () => {
  const deploy = readFileSync(repo + '.github/workflows/deploy.yml', 'utf8');
  // Publish and the smoke-failure restore both set the header; nothing reaches the static bucket without it.
  const writes = deploy.split('\n').filter(line => /aws s3 (sync|cp) [^|]*"s3:\/\/\$\{STATIC_BUCKET\}\//.test(line) && !/aws s3 sync "s3:/.test(line));
  assert.equal(writes.length, 5); // Includes the favicon upload with an explicit content type.
  for (const line of writes) assert.match(line, /--cache-control "no-cache"/, line.trim());
  // Publish force-writes every object: a sync would skip a file it considers unchanged and leave its old metadata.
  const publish = deploy.slice(deploy.indexOf('- name: Publish static files after the stack update'), deploy.indexOf('- name: Smoke check'));
  assert.equal((publish.match(/aws s3 cp [a-z]+\/ "s3:\/\/\$\{STATIC_BUCKET\}\/[a-z/]*" --recursive /g) || []).length, 2);
  assert.doesNotMatch(publish, /aws s3 sync/);
  assert.match(deploy, /for path in \/app\/ \/app\/app\.js; do\n\s+curl -sS -o \/dev\/null -D \/tmp\/cache\.hdr "https:\/\/\$\{host\}\$\{path\}" \|\| return 1\n\s+grep -qi '\^cache-control: no-cache' \/tmp\/cache\.hdr \|\| return 1/);
  // The guard is installed before the first element binding, and removed once the module has evaluated.
  const app = readFileSync(pageUrl('app/app.js'), 'utf8'), guard = app.indexOf("addEventListener('error',pageSkew);addEventListener('load',()=>removeEventListener('error',pageSkew),{once:true});");
  assert.ok(guard > 0 && guard < app.search(/\n ?\$\('[^']+'\)\.on[a-z]+=/), 'the skew guard precedes every top-level handler binding');
  assert.match(app, /sessionStorage\.setItem\('supatrace-skew-reload',String\(Date\.now\(\)\)\);location\.reload\(\);return;/);
});
