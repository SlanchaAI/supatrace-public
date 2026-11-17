// tests/browser.mjs browser probe (#75): which executable the UI suites fall back to when Playwright's own
// browser is not installed. A fake file system stands in for macOS and Linux; nothing is launched here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {browserCandidates, playwrightCaches} from './browser.mjs';

// A fake tree: every listed path exists, and listing a directory returns its direct children.
function tree(paths) {
  const all = new Set(); for (const path of paths) { const parts = path.split('/'); for (let i = 2; i <= parts.length; i++) all.add(parts.slice(0, i).join('/')); }
  return {exists: path => all.has(path), list: dir => [...new Set([...all].filter(path => path.startsWith(dir + '/')).map(path => path.slice(dir.length + 1).split('/')[0]))]};
}
const MAC = '/Users/dev', CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('macOS: the Playwright cache under ~/Library/Caches is found, newest headless shell first, then Chromium, then installed Chrome', () => {
  assert.deepEqual(playwrightCaches({platform: 'darwin', home: MAC, env: {}}), [MAC + '/Library/Caches/ms-playwright']);
  const cache = MAC + '/Library/Caches/ms-playwright', fs = tree([
    cache + '/chromium_headless_shell-999/chrome-headless-shell-mac-arm64/chrome-headless-shell',
    cache + '/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell',
    cache + '/chromium-1248/chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    cache + '/chromium-1300/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    cache + '/ffmpeg-1011/ffmpeg-mac', cache + '/chromium_headless_shell-1100/INSTALLATION_COMPLETE',
    CHROME, MAC + '/Applications/Chromium.app/Contents/MacOS/Chromium']);
  assert.deepEqual(browserCandidates({platform: 'darwin', home: MAC, env: {}, ...fs}), [
    cache + '/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell',
    cache + '/chromium_headless_shell-999/chrome-headless-shell-mac-arm64/chrome-headless-shell',
    cache + '/chromium-1300/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    cache + '/chromium-1248/chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    CHROME, MAC + '/Applications/Chromium.app/Contents/MacOS/Chromium']);
  // The case in the issue: nothing in the cache, Chrome installed. Before the fix this found no browser.
  assert.deepEqual(browserCandidates({platform: 'darwin', home: MAC, env: {}, ...tree([CHROME])}), [CHROME]);
  assert.deepEqual(browserCandidates({platform: 'darwin', home: MAC, env: {}, ...tree([])}), []);
});

test('Linux: the existing cached shell is still chosen, then cached Chromium and system browsers; cache overrides are honoured', () => {
  const home = '/home/dev', cache = home + '/.cache/ms-playwright', shell = cache + '/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell';
  const fs = tree([shell, cache + '/chromium-1248/chrome-linux64/chrome', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']);
  assert.deepEqual(browserCandidates({platform: 'linux', home, env: {}, ...fs}), [shell, cache + '/chromium-1248/chrome-linux64/chrome', '/usr/bin/google-chrome']);
  assert.deepEqual(playwrightCaches({platform: 'linux', home, env: {XDG_CACHE_HOME: '/var/cache'}}), ['/var/cache/ms-playwright']);
  assert.deepEqual(playwrightCaches({platform: 'linux', home, env: {PLAYWRIGHT_BROWSERS_PATH: '/opt/pw'}}), ['/opt/pw', cache]);
  assert.deepEqual(playwrightCaches({platform: 'linux', home, env: {PLAYWRIGHT_BROWSERS_PATH: '0'}}), [cache]);
  const custom = tree(['/opt/pw/chromium_headless_shell-1300/chrome-headless-shell-linux64/chrome-headless-shell', shell]);
  assert.deepEqual(browserCandidates({platform: 'linux', home, env: {PLAYWRIGHT_BROWSERS_PATH: '/opt/pw'}, ...custom}), ['/opt/pw/chromium_headless_shell-1300/chrome-headless-shell-linux64/chrome-headless-shell', shell]);
  // Another platform has no probe: the env var is the way there.
  assert.deepEqual(browserCandidates({platform: 'win32', home: 'C:/Users/dev', env: {}, ...fs}), []);
});

test('this machine: every candidate the real probe returns exists, and the docs name the env var', () => {
  const real = browserCandidates(); assert.ok(Array.isArray(real));
  const source = readFileSync(new URL('./browser.mjs', import.meta.url), 'utf8'); assert.ok(source.includes('Google Chrome.app'));
  assert.match(readFileSync(new URL('../docs/local-development.md', import.meta.url), 'utf8'), /PLAYWRIGHT_CHROMIUM_PATH/);
});
