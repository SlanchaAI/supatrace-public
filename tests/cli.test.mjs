// The `supatrace` CLI (packages/supatrace-js/cli.mjs) against the real handler and store logic
// (tests/harness.mjs, in-memory DynamoDB). Offline: the only network peer is the loopback harness.
// Every test also checks that no key, token or device secret reaches stdout or stderr.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {spawn, execFileSync} from 'node:child_process';
import {createServer} from 'node:net';
import {existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {start} from './harness.mjs';
import {digest} from '../src/aws-auth.mjs';
import {main, checkOrigin, findCheckout, CliError} from '../packages/supatrace-js/cli.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url)), cli = join(repo, 'packages/supatrace-js/cli.mjs');
const newToken = () => 'stpat_' + randomBytes(32).toString('base64url');
const mode = path => statSync(path).mode & 0o777;

async function account(live, id) { let cookie = ''; const tenant = await live.signIn({addCookies: async value => { cookie = value.map(c => c.name + '=' + c.value).join('; '); }}, id); return {tenant, cookie}; }
async function createToken(live, cookie) {
  const token = newToken(), r = await fetch(live.origin + '/api/tokens', {method: 'POST', headers: {cookie, origin: live.origin, 'content-type': 'application/json'}, body: JSON.stringify({name: 'cli test', token_hash: digest(token)})});
  assert.equal(r.status, 201, await r.clone().text());
  return {token, id: (await r.json()).id};
}
/** One CLI invocation with captured output, a private HOME and a counted fetch. */
function shell(live, {home = mkdtempSync(join(tmpdir(), 'supatrace-cli-home-')), cwd = mkdtempSync(join(tmpdir(), 'supatrace-cli-app-')), env = {}, stdin = '', sleep} = {}) {
  const out = [], err = [], calls = [];
  const io = {
    stdout: {write: text => { out.push(text); }}, stderr: {write: text => { err.push(text); }}, stdin: Readable.from(stdin ? [stdin] : []),
    env: {HOME: home, ...(live ? {SUPATRACE_ORIGIN: live.origin} : {}), ...env}, cwd,
    fetch: (url, options) => { calls.push({url: String(url), headers: {...options.headers}, body: options.body}); return fetch(url, options); },
    sleep: sleep ?? (async () => { throw new Error('unexpected wait'); }),
  };
  return {home, cwd, calls, io, run: argv => main(argv, io), get out() { return out.join(''); }, get err() { return err.join(''); }, get all() { return out.join('') + err.join(''); }};
}
const credentials = home => join(home, '.config', 'supatrace', 'credentials.json');
const pendingFiles = home => { const dir = join(home, '.config', 'supatrace', 'pending'); return existsSync(dir) ? readdirSync(dir).map(name => join(dir, name)) : []; };
const envOf = text => Object.fromEntries(text.split('\n').filter(Boolean).map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));

test('login verifies a personal access token, saves it owner-only and never prints it', async () => {
  const live = await start(); try {
    const {tenant, cookie} = await account(live), {token} = await createToken(live, cookie);
    const sh = shell(live, {stdin: token + '\n'});
    assert.equal(await sh.run(['login', '--token-stdin']), 0, sh.err);
    const file = credentials(sh.home), saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.origins[live.origin].access_token, token); assert.equal(saved.origins[live.origin].account_id, tenant);
    assert.equal(mode(file), 0o600); assert.equal(mode(join(sh.home, '.config', 'supatrace')), 0o700);
    assert.match(sh.out, /Signed in to .* as account /); assert.ok(sh.out.includes(tenant)); assert.ok(!sh.all.includes(token) && !sh.all.includes(token.slice(6, 20)));
    assert.equal(sh.calls.length, 1); assert.equal(sh.calls[0].url, live.origin + '/api/v1/me');

    // A well-formed token the server does not know: refused, the saved one is kept.
    const before = readFileSync(file, 'utf8'), stranger = newToken(), bad = shell(live, {home: sh.home, stdin: stranger});
    assert.equal(await bad.run(['login', '--token-stdin']), 1); assert.match(bad.err, /refused/); assert.ok(!bad.all.includes(stranger)); assert.equal(readFileSync(file, 'utf8'), before);
    // Not a token at all: no request is made.
    const junk = shell(live, {stdin: 'hunter2-not-a-token'});
    assert.equal(await junk.run(['login', '--token-stdin']), 1); assert.equal(junk.calls.length, 0); assert.ok(!existsSync(credentials(junk.home))); assert.ok(!junk.all.includes('hunter2'));
    // No terminal and no token: a usage error, not a hang.
    const none = shell(live); assert.equal(await none.run(['login']), 2); assert.equal(none.calls.length, 0);

    const off = shell(live, {home: sh.home});
    assert.equal(await off.run(['logout']), 0); assert.equal(JSON.parse(readFileSync(file, 'utf8')).origins[live.origin], undefined); assert.equal(off.calls.length, 0);
    const tail = shell(live, {home: sh.home}); assert.equal(await tail.run(['tail', '--once']), 1); assert.match(tail.err, /supatrace login/); assert.equal(tail.calls.length, 0);
  } finally { await live.close(); }
});

test('a credential is only ever sent to a hosted origin or a loopback development server', async () => {
  for (const ok of ['https://supatrace.dev', 'https://supatrace.tech', 'http://127.0.0.1:3000', 'http://localhost:8080']) assert.equal(checkOrigin(ok), ok);
  for (const bad of ['http://supatrace.dev', 'https://supatrace.dev.evil.example', 'https://evil.example', 'https://supatrace.dev/', 'https://supatrace.dev@evil.example', 'http://127.0.0.1:3000/x', 'http://127.0.0.1.evil.example:3000', 'http://10.0.0.5:3000', 'file:///etc/passwd']) assert.throws(() => checkOrigin(bad), CliError, bad);
  const token = newToken();
  for (const argv of [['login', '--token-stdin', '--origin', 'https://evil.example'], ['init', '--origin', 'https://evil.example'], ['tail', '--once', '--origin', 'https://evil.example']]) {
    const sh = shell(null, {stdin: token, env: {SUPATRACE_ACCESS_TOKEN: token}});
    assert.equal(await sh.run(argv), 2, argv.join(' ')); assert.equal(sh.calls.length, 0); assert.ok(!sh.all.includes(token));
  }
  const viaEnv = shell(null, {env: {SUPATRACE_ORIGIN: 'https://evil.example', SUPATRACE_ACCESS_TOKEN: token}});
  assert.equal(await viaEnv.run(['tail', '--once']), 2); assert.equal(viaEnv.calls.length, 0);
});

test('init pairs the folder, writes a working write key to .env.local without printing it, and is idempotent', async () => {
  const live = await start(); try {
    const {tenant} = await account(live);
    let approved = 0;
    const sh = shell(live, {sleep: async () => { const code = /approves code (\S+)/.exec(sh.out)[1]; await live.store.approveSetup(tenant, code); approved++; }});
    const file = join(sh.cwd, '.env.local');
    writeFileSync(file, '# my app\nDATABASE_URL=postgres://localhost/app\nSUPATRACE_OTLP_ENDPOINT=https://old.example\n', {mode: 0o644});
    assert.equal(await sh.run(['init']), 0, sh.err);
    assert.equal(approved, 1);
    const text = readFileSync(file, 'utf8'), values = envOf(text);
    assert.match(values.SUPATRACE_API_KEY, /^[A-Za-z0-9_-]{43}$/); assert.equal(values.SUPATRACE_OTLP_ENDPOINT, live.origin); assert.match(values.SUPATRACE_PROJECT, /^proj_[a-f0-9]{32}$/);
    assert.ok(text.startsWith('# my app\nDATABASE_URL=postgres://localhost/app\n'), 'other lines are kept'); assert.ok(!text.includes('old.example')); assert.equal(text.match(/SUPATRACE_OTLP_ENDPOINT/g).length, 1);
    assert.equal(mode(file), 0o600); assert.deepEqual(pendingFiles(sh.home), [], 'the pending pairing is removed once written');
    // Nothing secret on the terminal or on the wire: the server only ever receives the key's SHA-256.
    const start_ = sh.calls.find(call => call.url.endsWith('/api/setup/start')), deviceSecret = JSON.parse(sh.calls.find(call => call.url.endsWith('/api/setup/poll')).body).device_secret;
    assert.deepEqual(JSON.parse(start_.body), {key_hash: digest(values.SUPATRACE_API_KEY)});
    for (const secret of [values.SUPATRACE_API_KEY, deviceSecret]) assert.ok(!sh.all.includes(secret) && !sh.all.includes(secret.slice(0, 12)));
    for (const call of sh.calls) assert.ok(!JSON.stringify(call).includes(values.SUPATRACE_API_KEY));
    assert.match(sh.out, /Connected\. Wrote SUPATRACE_API_KEY/);
    // The key in the file is the approved write key: an upload with it lands in the approving workspace.
    await live.upload(values.SUPATRACE_API_KEY, {version: 1, batch_id: 'cli-b1', run_id: 'cli-run', events: [{id: 'e1', time: new Date().toISOString(), kind: 'note', name: 'from the cli key', data: {ok: true}}]});
    assert.ok((await live.store.listRuns(tenant, {limit: 10})).items.some(run => run.run_id === 'cli-run'));

    // Again: nothing is requested, nothing is rewritten.
    const again = shell(live, {home: sh.home, cwd: sh.cwd});
    assert.equal(await again.run(['init']), 0); assert.equal(again.calls.length, 0); assert.equal(readFileSync(file, 'utf8'), text); assert.match(again.out, /Already connected/); assert.ok(!again.all.includes(values.SUPATRACE_API_KEY));
    // An approved file is never silently re-bound.
    for (const flags of [['--origin', 'https://supatrace.dev'], ['--project', 'proj_' + 'f'.repeat(32)]]) {
      const other = shell(live, {home: sh.home, cwd: sh.cwd});
      assert.equal(await other.run(['init', ...flags]), 1); assert.match(other.err, /different (origin|project)/); assert.equal(other.calls.length, 0); assert.equal(readFileSync(file, 'utf8'), text);
    }
  } finally { await live.close(); }
});

test('init that is not approved in time writes nothing and resumes the same pairing on the next run', async () => {
  const live = await start(); try {
    const {tenant} = await account(live);
    const first = shell(live), file = join(first.cwd, '.env.local');
    assert.equal(await first.run(['init', '--wait', '0']), 3); assert.match(first.err, /Not approved yet/); assert.ok(!existsSync(file));
    const [pending] = pendingFiles(first.home); assert.equal(mode(pending), 0o600);
    const state = JSON.parse(readFileSync(pending, 'utf8')), code = /approves code (\S+)/.exec(first.out)[1];
    assert.equal(state.user_code, code); assert.ok(!first.all.includes(state.write_key) && !first.all.includes(state.device_secret));
    // A second run asks for no new code; a different origin is refused instead of replacing the pending pairing.
    const wrong = shell(live, {home: first.home, cwd: first.cwd}); assert.equal(await wrong.run(['init', '--origin', 'https://supatrace.dev']), 1); assert.equal(wrong.calls.length, 0);
    await live.store.approveSetup(tenant, code);
    const second = shell(live, {home: first.home, cwd: first.cwd});
    assert.equal(await second.run(['init']), 0, second.err);
    assert.ok(second.calls.every(call => call.url.endsWith('/api/setup/poll')), 'no second /api/setup/start'); assert.ok(second.out.includes(code));
    assert.equal(envOf(readFileSync(file, 'utf8')).SUPATRACE_API_KEY, state.write_key); assert.deepEqual(pendingFiles(first.home), []); assert.ok(!second.all.includes(state.write_key));

    // The env file is never written through a symlink, and a key that appears while waiting is kept.
    const linked = shell(live); writeFileSync(join(linked.cwd, 'elsewhere'), ''); symlinkSync(join(linked.cwd, 'elsewhere'), join(linked.cwd, '.env.local'));
    assert.equal(await linked.run(['init']), 1); assert.match(linked.err, /symlink/); assert.equal(linked.calls.length, 0); assert.equal(readFileSync(join(linked.cwd, 'elsewhere'), 'utf8'), '');
    const raced = shell(live, {sleep: async () => { writeFileSync(join(raced.cwd, '.env.local'), 'SUPATRACE_API_KEY=someone-elses\n'); await live.store.approveSetup(tenant, /approves code (\S+)/.exec(raced.out)[1]); }});
    assert.equal(await raced.run(['init']), 1); assert.match(raced.err, /gained a SUPATRACE_API_KEY/); assert.equal(readFileSync(join(raced.cwd, '.env.local'), 'utf8'), 'SUPATRACE_API_KEY=someone-elses\n');
    // An expired pairing is cleared so the next run starts clean.
    const stale = shell(live); assert.equal(await stale.run(['init', '--wait', '0']), 3);
    const [stalePath] = pendingFiles(stale.home), staleState = JSON.parse(readFileSync(stalePath, 'utf8'));
    writeFileSync(stalePath, JSON.stringify({...staleState, device_secret: randomBytes(32).toString('base64url')}));
    const expired = shell(live, {home: stale.home, cwd: stale.cwd}); assert.equal(await expired.run(['init']), 1); assert.match(expired.err, /expired/); assert.deepEqual(pendingFiles(stale.home), []); assert.ok(!existsSync(join(stale.cwd, '.env.local')));
  } finally { await live.close(); }
});

test('tail prints each trace once, oldest first, and picks up new and updated traces', async () => {
  const live = await start(); try {
    const {tenant, cookie} = await account(live), runs = await live.seedRuns(tenant, 3), {token, id} = await createToken(live, cookie);
    const login = shell(live, {stdin: token}); assert.equal(await login.run(['login', '--token-stdin']), 0);
    const once = shell(live, {home: login.home});
    assert.equal(await once.run(['tail', '--once']), 0, once.err);
    const lines = once.out.trim().split('\n'); assert.equal(lines.length, 3); assert.deepEqual(lines.map(line => line.trim().split(/\s+/).pop()), runs);
    assert.match(lines[0], /^\d{4}-\d\d-\d\dT\S+\s+ok\s+2\.0s\s+2 events\s+run-000$/); assert.ok(!once.all.includes(token));
    assert.equal(once.calls.length, 1); assert.equal(once.calls[0].headers['x-supatrace-key'], token); assert.ok(once.calls[0].url.startsWith(live.origin + '/api/v1/traces?'));
    const json = shell(live, {home: login.home}); assert.equal(await json.run(['tail', '--once', '--json', '--limit', '2']), 0);
    assert.deepEqual(json.out.trim().split('\n').map(line => JSON.parse(line).id), runs.slice(1)); assert.equal(json.err, '');

    // Following: the second poll sees one new trace and one that grew; the third sees nothing new.
    const key = await live.writeKey(tenant); let polls = 0;
    const follow = shell(live, {env: {SUPATRACE_ACCESS_TOKEN: token}, sleep: async ms => {
      assert.equal(ms, 2000); polls++;
      if (polls === 1) {
        await live.upload(key, {version: 1, batch_id: 'new-b1', run_id: 'run-new', events: [{id: 'n1', time: new Date().toISOString(), kind: 'request', name: 'new', data: {}}]});
        await live.upload(key, {version: 1, batch_id: 'run-002-b2', run_id: 'run-002', events: [{id: 'run-002-e3', time: new Date().toISOString(), kind: 'error', name: 'late failure', data: {}}]});
      }
      if (polls === 3) throw new Error('stop');
    }});
    assert.equal(await follow.run(['tail', '--interval', '2']), 1);
    const followed = follow.out.trim().split('\n');
    assert.equal(followed.length, 5, follow.out); assert.equal(followed.filter(line => line.includes('run-new')).length, 1);
    assert.match(followed.find(line => line.includes('(updated)')), /3 events\s+run-002\s+\(updated\)$/); assert.ok(!follow.all.includes(token));

    // A burst larger than one page between polls is read to the end; traces that were already there when the tail started are not replayed.
    const burst = Array.from({length: 130}, (_, i) => 'burst-' + String(i).padStart(3, '0')); let burstPolls = 0;
    const wide = shell(live, {env: {SUPATRACE_ACCESS_TOKEN: token}, sleep: async () => {
      burstPolls++;
      if (burstPolls === 1) for (const [i, run] of burst.entries()) await live.upload(key, {version: 1, batch_id: run + '-b', run_id: run, events: [{id: run + '-e', time: new Date(Date.now() + i).toISOString(), kind: 'note', name: 'burst', data: {}}]});
      if (burstPolls === 3) throw new Error('stop');
    }});
    assert.equal(await wide.run(['tail', '--limit', '2', '--json']), 1);
    const printed = wide.out.trim().split('\n').map(line => JSON.parse(line).id);
    assert.equal(printed.length, 132, 'two at the start, then every trace of the burst once'); assert.deepEqual(printed.slice(2), burst); assert.equal(new Set(printed).size, 132);
    assert.ok(!printed.includes('run-000') && !printed.includes('run-001'), 'older traces are not replayed as new');
    assert.deepEqual(wide.calls.map(call => new URL(call.url).searchParams.get('offset')), ['0', '0', '100', '0']);

    // More history than one page: a new arrival makes the poll read on, and none of the older traces is replayed as new.
    const deep = await account(live, 5252), history = await live.seedRuns(deep.tenant, 150), deepToken = (await createToken(live, deep.cookie)).token, deepKey = await live.writeKey(deep.tenant); let deepPolls = 0;
    const long = shell(live, {env: {SUPATRACE_ACCESS_TOKEN: deepToken}, sleep: async () => {
      deepPolls++;
      if (deepPolls === 1) await live.upload(deepKey, {version: 1, batch_id: 'late-b', run_id: 'late-arrival', events: [{id: 'l1', time: new Date().toISOString(), kind: 'note', name: 'late', data: {}}]});
      if (deepPolls === 2) await live.upload(deepKey, {version: 1, batch_id: 'old-b2', run_id: history[10], events: [{id: 'old-late', time: new Date(Date.now() - 86400000).toISOString(), kind: 'note', name: 'late event on an old trace', data: {}}]});
      if (deepPolls === 3) throw new Error('stop');
    }});
    assert.equal(await long.run(['tail', '--limit', '2', '--json']), 1);
    assert.deepEqual(long.out.trim().split('\n').map(line => JSON.parse(line).id), [history[148], history[149], 'late-arrival'], 'two at the start, then only the new arrival');

    // The same when the history was stored in the very second the tail starts (receive times have one-second precision).
    const tie = await account(live, 6262), tieKey = await live.writeKey(tie.tenant), tieToken = (await createToken(live, tie.cookie)).token; let tiePolls = 0;
    for (let i = 0; i < 101; i++) await live.upload(tieKey, {version: 1, batch_id: 'old-b-' + i, run_id: 'old-' + String(i).padStart(3, '0'), events: [{id: 'o' + i, time: new Date(Date.now() - (200 - i) * 1000).toISOString(), kind: 'note', name: 'old', data: {}}]});
    const tied = shell(live, {env: {SUPATRACE_ACCESS_TOKEN: tieToken}, sleep: async () => {
      tiePolls++;
      if (tiePolls === 1) await live.upload(tieKey, {version: 1, batch_id: 'fresh-b', run_id: 'fresh', events: [{id: 'f1', time: new Date().toISOString(), kind: 'note', name: 'fresh', data: {}}]});
      if (tiePolls === 2) throw new Error('stop');
    }});
    assert.equal(await tied.run(['tail', '--limit', '1', '--json']), 1);
    assert.deepEqual(tied.out.trim().split('\n').map(line => JSON.parse(line).id), ['old-100', 'fresh']);
    assert.deepEqual(tied.calls.slice(0, 2).map(call => new URL(call.url).searchParams.get('offset')), ['0', '100'], 'the first read covers the whole history');

    // No connection (or a server error) at start: the tail keeps trying and still shows the newest traces once it gets through.
    let outage = 2, outagePolls = 0;
    const flaky = shell(live, {env: {SUPATRACE_ACCESS_TOKEN: token}, sleep: async () => { outagePolls++; if (outagePolls === 4) throw new Error('stop'); }});
    const through = flaky.io.fetch; flaky.io.fetch = (url, options) => outage-- > 0 ? (outage === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(new Response('{"error":"unavailable"}', {status: 503}))) : through(url, options);
    assert.equal(await flaky.run(['tail', '--limit', '2']), 1);
    assert.equal(flaky.out.trim().split('\n').length, 2, flaky.out); assert.match(flaky.err, /no connection\); retrying/); assert.match(flaky.err, /HTTP 503\); retrying/);

    // A poll that fails on a later page is repeated whole: the traces on the page that did answer are not lost or printed twice.
    const mid = await account(live, 7272), midKey = await live.writeKey(mid.tenant), midToken = (await createToken(live, mid.cookie)).token; let midPolls = 0, failNext = false;
    await live.upload(midKey, {version: 1, batch_id: 'seed-b', run_id: 'seed', events: [{id: 's', time: new Date(Date.now() - 60000).toISOString(), kind: 'note', name: 'seed', data: {}}]});
    const many = Array.from({length: 150}, (_, i) => 'mid-' + String(i).padStart(3, '0'));
    const broken = shell(live, {env: {SUPATRACE_ACCESS_TOKEN: midToken}, sleep: async () => {
      midPolls++;
      if (midPolls === 1) { for (const [i, run] of many.entries()) await live.upload(midKey, {version: 1, batch_id: run + '-b', run_id: run, events: [{id: run + '-e', time: new Date(Date.now() + i).toISOString(), kind: 'note', name: 'mid', data: {}}]}); failNext = true; }
      if (midPolls === 4) throw new Error('stop');
    }});
    const direct = broken.io.fetch; broken.io.fetch = (url, options) => { if (failNext && new URL(url).searchParams.get('offset') === '100') { failNext = false; return Promise.resolve(new Response('{"error":"unavailable"}', {status: 503})); } return direct(url, options); };
    assert.equal(await broken.run(['tail', '--json']), 1);
    assert.deepEqual(broken.out.trim().split('\n').map(line => JSON.parse(line).id), ['seed', ...many], 'every trace once, in order, after the failed poll is repeated');
    // A workspace larger than the API lists in one request: the tail says its list is partial instead of looking complete.
    const cut = shell(live, {env: {SUPATRACE_ACCESS_TOKEN: midToken}, sleep: async () => { throw new Error('stop'); }});
    const whole = cut.io.fetch; cut.io.fetch = async (url, options) => { const r = await whole(url, options), body = await r.json(); return new Response(JSON.stringify({...body, truncated: true}), {status: r.status, headers: r.headers}); };
    assert.equal(await cut.run(['tail', '--limit', '1']), 1); assert.equal(cut.err.match(/list is partial/g).length, 1); assert.match(cut.err, /can be missing/);

    // A revoked token stops the tail with a next step instead of retrying forever.
    const revoke = await fetch(live.origin + '/api/tokens/revoke', {method: 'POST', headers: {cookie, origin: live.origin, 'content-type': 'application/json'}, body: JSON.stringify({id})}); assert.equal(revoke.status, 200);
    const revoked = shell(live, {home: login.home}); assert.equal(await revoked.run(['tail']), 1); assert.match(revoked.err, /refused.*supatrace login/); assert.ok(!revoked.all.includes(token));
    const badFlag = shell(live, {home: login.home}); assert.equal(await badFlag.run(['tail', '--limit', '0']), 2); assert.equal(await badFlag.run(['tail', '--follow']), 2); assert.equal(badFlag.calls.length, 0);
  } finally { await live.close(); }
});

test('the package ships the CLI as its `supatrace` bin with no dependencies', () => {
  const pkg = JSON.parse(readFileSync(join(repo, 'packages/supatrace-js/package.json'), 'utf8')), source = readFileSync(cli, 'utf8');
  assert.deepEqual(pkg.bin, {supatrace: './cli.mjs'}); assert.ok(pkg.files.includes('cli.mjs')); assert.equal(pkg.dependencies, undefined);
  assert.ok(source.startsWith('#!/usr/bin/env node\n')); assert.ok(mode(cli) & 0o111, 'executable');
  for (const [, specifier] of source.matchAll(/^import .* from '([^']+)';$/gm)) assert.ok(specifier.startsWith('node:'), specifier);
  // As installed: only the packed files, run from another folder.
  const dir = mkdtempSync(join(tmpdir(), 'supatrace-cli-pack-')); mkdirSync(join(dir, 'pkg'));
  for (const name of [...pkg.files, 'package.json']) writeFileSync(join(dir, 'pkg', name), readFileSync(join(repo, 'packages/supatrace-js', name)));
  const run = argv => { try { return {code: 0, out: execFileSync(process.execPath, [join(dir, 'pkg', 'cli.mjs'), ...argv], {cwd: dir, encoding: 'utf8', env: {HOME: dir, PATH: process.env.PATH}, stdio: ['ignore', 'pipe', 'pipe']})}; } catch (error) { return {code: error.status, out: error.stdout + error.stderr}; } };
  const help = run(['--help']); assert.equal(help.code, 0); for (const command of ['login', 'init', 'tail', 'dev', 'logout']) assert.match(help.out, new RegExp('supatrace ' + command + '\\b'));
  assert.equal(run(['--version']).out.trim(), pkg.version); assert.equal(run([]).code, 2); assert.equal(run(['nope']).code, 2);
  // Outside a source checkout `dev` says what it needs and starts nothing.
  assert.equal(findCheckout(dir), null); assert.equal(findCheckout(join(repo, 'packages/supatrace-js')), repo.replace(/\/$/, ''));
  const dev = run(['dev']); assert.equal(dev.code, 1); assert.match(dev.out, /source checkout/); assert.match(dev.out, /not shipped yet/);
  rmSync(dir, {recursive: true, force: true});
});

const freePort = () => new Promise((done, fail) => { const probe = createServer(); probe.once('error', fail); probe.listen(0, '127.0.0.1', () => { const {port} = probe.address(); probe.close(() => done(port)); }); });

test('dev serves the local viewer on loopback and opens no connection to any other host', {timeout: 90000}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'supatrace-cli-dev-')), log = join(dir, 'outbound.log'), guard = join(repo, 'tests/fixtures/no-outbound.mjs');
  const env = {...process.env, HOME: dir, NODE_OPTIONS: '--import=' + guard, SUPATRACE_TEST_OUTBOUND_LOG: log};
  // The guard itself works: it refuses and records a connection to a non-loopback address (TEST-NET-1, never dialled).
  execFileSync(process.execPath, ['-e', "require('node:net').connect(9,'192.0.2.1').on('error',()=>{});fetch('http://example.invalid/').catch(()=>{})"], {env, stdio: 'ignore', timeout: 20000});
  assert.match(readFileSync(log, 'utf8'), /192\.0\.2\.1/); assert.match(readFileSync(log, 'utf8'), /example\.invalid/); rmSync(log);

  const port = await freePort(), child = spawn(process.execPath, [cli, 'dev', '--port', String(port)], {cwd: join(repo, 'packages'), env, stdio: ['ignore', 'pipe', 'pipe']});
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise(done => child.once('exit', (code, signal) => done({code, signal})));
  try {
    const origin = 'http://127.0.0.1:' + port, deadline = Date.now() + 60000;
    while (!output.includes(origin + '/__local__/')) { if (Date.now() > deadline || child.exitCode !== null) assert.fail('local viewer did not start: ' + output); await new Promise(done => setTimeout(done, 100)); }
    const page = await fetch(origin + '/__local__/'); assert.equal(page.status, 200); assert.match(await page.text(), /Synthetic local workspace/);
    const signin = await fetch(origin + '/__local__/signin?account=4242', {redirect: 'manual'}); assert.equal(signin.status, 303);
    const cookie = signin.headers.getSetCookie()[0].split(';')[0], runs = await fetch(origin + '/api/runs', {headers: {cookie}}); assert.equal(runs.status, 200); assert.equal((await runs.json()).runs.length, 2);
    assert.equal((await fetch(origin + '/app/')).status, 200);
  } finally { child.kill('SIGTERM'); }
  const end = await exited; assert.ok(end.code === 0 || end.signal === 'SIGTERM', JSON.stringify(end) + output);
  assert.ok(!existsSync(log), 'outbound connection attempted: ' + (existsSync(log) ? readFileSync(log, 'utf8') : ''));
  rmSync(dir, {recursive: true, force: true});
});
