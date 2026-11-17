// playwright-core is a devDependency. PLAYWRIGHT_CORE can point at another copy.
// PLAYWRIGHT_CHROMIUM_PATH, CHROME_PATH, or CHROMIUM_PATH selects the browser. Without one, Playwright's own
// browser for this playwright-core version is tried first; when it is not installed, the probe below looks for a
// browser already on the machine: Playwright's cache (any version), then the usual application paths.
import {existsSync, readdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

// Binaries inside one unpacked Playwright browser directory, relative to its platform folder
// (chrome-headless-shell-linux64, chrome-headless-shell-mac-arm64, chrome-linux64, chrome-mac, …).
const SHELL_BINARIES = ['chrome-headless-shell'];
const CHROMIUM_BINARIES = ['chrome', 'Chromium.app/Contents/MacOS/Chromium', 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'];
const MAC_APPS = ['Google Chrome.app/Contents/MacOS/Google Chrome', 'Chromium.app/Contents/MacOS/Chromium', 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'];
const LINUX_BROWSERS = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];

/** Where Playwright keeps downloaded browsers: PLAYWRIGHT_BROWSERS_PATH when set to a directory, else the platform default. */
export function playwrightCaches({platform = process.platform, home = homedir(), env = process.env} = {}) {
  const caches = [];
  if (env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== '0') caches.push(env.PLAYWRIGHT_BROWSERS_PATH);
  if (platform === 'darwin') caches.push(join(home, 'Library', 'Caches', 'ms-playwright'));
  else if (platform === 'linux') caches.push(join(env.XDG_CACHE_HOME || join(home, '.cache'), 'ms-playwright'));
  return caches;
}
/**
 * Existing browser executables, best first: cached headless shells (newest build first), cached Chromium builds,
 * then installed applications. `exists` and `list` are injectable so the probe can be tested for any platform.
 */
export function browserCandidates({platform = process.platform, home = homedir(), env = process.env, exists = existsSync, list = dir => { try { return readdirSync(dir); } catch { return []; } }} = {}) {
  const found = [], add = path => { if (!found.includes(path) && exists(path)) found.push(path); };
  const builds = (cache, pattern) => list(cache).filter(name => pattern.test(name)).sort((a, b) => Number(b.split('-').pop()) - Number(a.split('-').pop()));
  const caches = playwrightCaches({platform, home, env});
  for (const [pattern, binaries] of [[/^chromium_headless_shell-\d+$/, SHELL_BINARIES], [/^chromium-\d+$/, CHROMIUM_BINARIES]])
    for (const cache of caches) for (const build of builds(cache, pattern)) for (const folder of list(join(cache, build)).sort()) for (const binary of binaries) add(join(cache, build, folder, binary));
  if (platform === 'darwin') for (const root of ['/Applications', join(home, 'Applications')]) for (const app of MAC_APPS) add(join(root, app));
  else if (platform === 'linux') for (const path of LINUX_BROWSERS) add(path);
  return found;
}

function playwrightPath() {
  if (process.env.PLAYWRIGHT_CORE) return process.env.PLAYWRIGHT_CORE;
  return 'playwright-core';
}

export async function launch() {
  let spec = playwrightPath();
  if (spec.startsWith('/')) spec = pathToFileURL(spec.endsWith('.mjs') ? spec : join(spec, 'index.mjs')).href;
  const {chromium} = await import(spec);
  const chosen = process.env.PLAYWRIGHT_CHROMIUM_PATH || process.env.CHROME_PATH || process.env.CHROMIUM_PATH || '';
  const args = ['--no-sandbox', '--disable-dev-shm-usage'];
  try { return await chromium.launch(chosen ? {executablePath: chosen, args} : {args}); }
  catch (error) {
    // An explicit choice is never second-guessed, and only a missing executable is worth a second try.
    if (chosen || !/Executable doesn't exist/.test(error.message)) throw error;
    const [fallback] = browserCandidates();
    if (!fallback) throw new Error(`No Chromium or Chrome was found. Looked in ${playwrightCaches().join(', ') || 'no Playwright cache for this platform'} and the standard application paths. Install one with "npx playwright-core install chromium", or set PLAYWRIGHT_CHROMIUM_PATH to a browser executable. Playwright said: ${error.message.split('\n')[0]}`);
    return chromium.launch({executablePath: fallback, args});
  }
}
