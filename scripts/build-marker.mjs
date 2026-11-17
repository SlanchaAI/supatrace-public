#!/usr/bin/env node
// Writes public/build.json so anyone can tell which commit a deployed site serves.
// It runs at publish time, never at commit time: the checked-in file stays "unstamped".
//   AWS static publish: the Deploy workflow runs this with GITHUB_SHA before `aws s3 sync`.
//   Cloudflare Pages:   set the Pages build command to `node scripts/build-marker.mjs`;
//                       Pages provides CF_PAGES_COMMIT_SHA and CF_PAGES_BRANCH.
//   node scripts/build-marker.mjs [--out FILE] [--unstamped]
import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const SHA = /^[0-9a-f]{40}$/;
export const UNSTAMPED = Object.freeze({schema: 1, commit: null, short: null, ref: null, source: 'unstamped', built_at: null});

export function marker(env = process.env, now = new Date()) {
  const found = env.GITHUB_SHA ? {commit: env.GITHUB_SHA, ref: env.GITHUB_REF_NAME, source: 'github-actions'}
    : env.CF_PAGES_COMMIT_SHA ? {commit: env.CF_PAGES_COMMIT_SHA, ref: env.CF_PAGES_BRANCH, source: 'cloudflare-pages'}
    : null;
  if (!found) throw new Error('no GITHUB_SHA or CF_PAGES_COMMIT_SHA in the environment');
  if (!SHA.test(found.commit)) throw new Error('commit is not a 40-character lowercase hex SHA');
  const ref = typeof found.ref === 'string' && /^[\w./-]{1,200}$/.test(found.ref) ? found.ref : null;
  return {schema: 1, commit: found.commit, short: found.commit.slice(0, 7), ref, source: found.source, built_at: now.toISOString()};
}
export const serialize = value => JSON.stringify(value, null, 2) + '\n';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), at = args.indexOf('--out');
  const out = at === -1 ? fileURLToPath(new URL('../public/build.json', import.meta.url)) : args[at + 1];
  try {
    if (!out) throw new Error('--out needs a file');
    const value = args.includes('--unstamped') ? UNSTAMPED : marker();
    writeFileSync(out, serialize(value));
    console.log(`build marker: ${value.commit || 'unstamped'} (${value.source}) -> ${out}`);
  } catch (error) {
    console.error('build marker not written: ' + error.message);
    process.exit(1);
  }
}
