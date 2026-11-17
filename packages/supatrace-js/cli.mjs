#!/usr/bin/env node
// supatrace CLI: login, init, tail, dev, logout. No dependencies.
//
// Secrets never reach stdout or stderr. `login` stores a read-only personal access token in the
// user's config directory (0600). `init` makes a write key on this machine, has the workspace
// owner approve it in the browser and writes it to an
// env file (0600). The server only ever receives the SHA-256 of the write key.
import {
  createHash,
  randomBytes
} from 'node:crypto';
import {
  spawn,
  execFileSync
} from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import {
  homedir
} from 'node:os';
import {
  dirname,
  isAbsolute,
  join,
  resolve
} from 'node:path';
import {
  fileURLToPath
} from 'node:url';

export const DEFAULT_ORIGIN = 'https://supatrace.dev';
const HOSTED = ['https://supatrace.dev', 'https://supatrace.tech'];
const TOKEN = /^stpat_[A-Za-z0-9_-]{43}$/,
  SECRET = /^[A-Za-z0-9_-]{43}$/,
  CODE = /^[A-Za-z0-9_-]{12}$/,
  PROJECT = /^proj_[a-f0-9]{32}$/,
  ENVIRONMENT = /^[a-z][a-z0-9-]{0,31}$/;
const digest = value => createHash('sha256').update(value).digest('hex');

export class CliError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.exitCode = code;
  }
}

const HELP = `supatrace: connect an app to SupaTrace and watch its traces

Usage
  supatrace login [--token-stdin]     Save a read-only personal access token (made in Settings)
  supatrace init [--env-file PATH]    Pair this folder with a workspace and write its key to .env.local
  supatrace tail [--once] [--json]    Print traces as they arrive
  supatrace dev [--port N]            Run the local viewer from a SupaTrace source checkout
  supatrace logout                    Remove the saved token for the origin

Options
  --origin URL          ${HOSTED.join(' or ')} (default ${DEFAULT_ORIGIN}), or a loopback http origin
  init:  --project proj_…  --environment ID  --wait SECONDS (default 600)
  tail:  --interval SECONDS (default 5)  --limit N (default 20)  --workspace ID  --environment ID

Environment
  SUPATRACE_ORIGIN, SUPATRACE_ACCESS_TOKEN (used by login and tail instead of the saved token)

Keys and tokens are never printed.`;

// ---- arguments -------------------------------------------------------------------------------
const FLAGS = {
  login: {
    origin: 'value',
    'token-stdin': 'flag'
  },
  logout: {
    origin: 'value'
  },
  init: {
    origin: 'value',
    'env-file': 'value',
    project: 'value',
    environment: 'value',
    wait: 'value'
  },
  tail: {
    origin: 'value',
    interval: 'value',
    limit: 'value',
    workspace: 'value',
    environment: 'value',
    once: 'flag',
    json: 'flag'
  },
  dev: {
    port: 'value'
  },
};

function parse(command, args) {
  const spec = FLAGS[command],
    out = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) throw new CliError(`Unexpected argument for ${command}. Run supatrace --help.`, 2);
    const [name, inline] = arg.slice(2).split(/=(.*)/s);
    if (!Object.hasOwn(spec, name) || Object.hasOwn(out, name)) throw new CliError(
      `Unknown or repeated option --${name} for ${command}. Run supatrace --help.`, 2);
    if (spec[name] === 'flag') {
      if (inline !== undefined) throw new CliError(`--${name} takes no value.`, 2);
      out[name] = true;
      continue;
    }
    const value = inline !== undefined ? inline : args[++i];
    if (value === undefined || value === '') throw new CliError(`--${name} needs a value.`, 2);
    out[name] = value;
  }
  return out;
}

function integer(value, name, min, max, fallback) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(n) || n < min || n > max) throw new CliError(
    `--${name} must be a whole number from ${min} to ${max}.`, 2);
  return n;
}
/** Hosted origins, or plain http on loopback for local development. Nothing else receives a credential. */
export function checkOrigin(value) {
  if (HOSTED.includes(value)) return value;
  if (/^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(value)) return value;
  throw new CliError(
    `Unsupported origin. Use ${HOSTED.join(' or ')}, or http://127.0.0.1:<port> for local development.`, 2);
}
const originOf = (flags, io) => checkOrigin(flags.origin ?? io.env.SUPATRACE_ORIGIN ?? DEFAULT_ORIGIN);

// ---- files -----------------------------------------------------------------------------------
function configDir(io) {
  const base = io.env.XDG_CONFIG_HOME && isAbsolute(io.env.XDG_CONFIG_HOME) ? io.env.XDG_CONFIG_HOME : join(io.env
    .HOME || homedir(), '.config');
  return join(base, 'supatrace');
}
/** Owner-only file, replaced atomically. Refuses to write through a symlink. */
function writePrivate(path, text) {
  mkdirSync(dirname(path), {
    recursive: true
  });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new CliError(
    `Refusing to write through a symlink: ${path}`);
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, text, {
      mode: 0o600,
      flag: 'wx'
    });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, {
      force: true
    });
    throw error;
  }
}

function privateDir(path) {
  mkdirSync(path, {
    recursive: true,
    mode: 0o700
  });
  try {
    chmodSync(path, 0o700);
  } catch {
    /* not ours to change */ }
}

function readJson(path) {
  if (!existsSync(path)) return null;
  let value;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new CliError(`Cannot read ${path} as JSON. It was not changed; move it aside to start again.`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CliError(
    `${path} is not a SupaTrace file. It was not changed; move it aside to start again.`);
  return value;
}
const credentialsPath = io => join(configDir(io), 'credentials.json');

function savedToken(io, origin) {
  const saved = readJson(credentialsPath(io))?.origins?.[origin]?.access_token;
  return typeof saved === 'string' && TOKEN.test(saved) ? saved : '';
}

function accessTokenFor(io, origin) {
  const fromEnv = io.env.SUPATRACE_ACCESS_TOKEN;
  if (fromEnv !== undefined && fromEnv !== '') {
    if (!TOKEN.test(fromEnv)) throw new CliError('SUPATRACE_ACCESS_TOKEN is not a SupaTrace personal access token.');
    return fromEnv;
  }
  const saved = savedToken(io, origin);
  if (!saved) throw new CliError(`Not signed in to ${origin}. Run: supatrace login`);
  return saved;
}

// ---- HTTP ------------------------------------------------------------------------------------
// One attempt, no redirects, bounded body. A credential is only ever sent to the checked origin.
async function call(io, origin, path, {
  token,
  body
} = {}) {
  const headers = {
    accept: 'application/json'
  };
  if (token) headers['x-supatrace-key'] = token;
  let raw;
  if (body !== undefined) {
    raw = JSON.stringify(body);
    headers['content-type'] = 'application/json';
    headers['x-amz-content-sha256'] = digest(raw);
  }
  let response;
  try {
    response = await io.fetch(origin + path, {
      method: raw === undefined ? 'GET' : 'POST',
      headers,
      body: raw,
      redirect: 'manual',
      signal: AbortSignal.timeout(30000)
    });
  } catch {
    return {
      status: 0,
      data: null,
      retryAfter: null
    };
  }
  let data = null;
  try {
    const text = await response.text();
    if (text.length <= 1048576) data = JSON.parse(text);
  } catch {
    /* not JSON: the status decides */ }
  const after = Number(response.headers.get('retry-after'));
  const date = Date.parse(response.headers.get('date') ?? '');
  return {
    status: response.status,
    data: data && typeof data === 'object' ? data : null,
    retryAfter: Number.isInteger(after) && after >= 1 ? Math.min(after, 300) : null,
    date: Number.isFinite(date) ? date : null
  };
}
/** Text from the server, safe to put on a terminal. */
const plain = (value, max = 160) => String(value ?? '').replace(/[^\x20-\x7e]/g, '?').slice(0, max);

// ---- login -----------------------------------------------------------------------------------
async function readAll(stream) {
  let text = '';
  stream.setEncoding?.('utf8');
  for await (const chunk of stream) {
    text += chunk;
    if (text.length > 4096) break;
  }
  return text;
}

function readHidden(io, label) {
  const {
    stdin,
    stderr
  } = io;
  return new Promise((done, fail) => {
    let value = '';
    const finish = (settle, result) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stderr.write('\n');
      settle(result);
    };
    const onData = chunk => {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n') return finish(done, value);
        if (ch === '\u0003' || ch === '\u0004') return finish(fail, new CliError(
        'Cancelled. Nothing was saved.'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ' && value.length < 256) value += ch;
      }
    };
    stderr.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}
async function login(flags, io) {
  const origin = originOf(flags, io);
  let token;
  if (flags['token-stdin']) token = (await readAll(io.stdin)).trim();
  else if (io.env.SUPATRACE_ACCESS_TOKEN) token = io.env.SUPATRACE_ACCESS_TOKEN.trim();
  else if (io.stdin.isTTY && typeof io.stdin.setRawMode === 'function') {
    io.stderr.write(`Create a personal access token in ${origin}/app/#settings (read-only, shown once).\n`);
    token = (await readHidden(io, 'Paste the token (input hidden): ')).trim();
  } else throw new CliError(
    `No token given. Create one in ${origin}/app/#settings, then run: supatrace login --token-stdin < token-file`,
    2);
  if (!TOKEN.test(token)) throw new CliError(
    'That is not a SupaTrace personal access token (stpat_…). Nothing was saved.');
  const me = await call(io, origin, '/api/v1/me', {
    token
  });
  if (me.status === 401) throw new CliError(
    'The token was refused: it is wrong, expired or revoked. Nothing was saved.');
  if (me.status !== 200 || typeof me.data?.account_id !== 'string') throw new CliError(
    `Could not verify the token with ${origin}${me.status ? ` (HTTP ${me.status})` : ' (no connection)'}. Nothing was saved.`
    );
  const path = credentialsPath(io),
    file = readJson(path) ?? {
      version: 1,
      origins: {}
    };
  if (!file.origins || typeof file.origins !== 'object' || Array.isArray(file.origins)) file.origins = {};
  file.origins[origin] = {
    access_token: token,
    account_id: me.data.account_id,
    saved_at: new Date().toISOString()
  };
  privateDir(dirname(path));
  writePrivate(path, JSON.stringify(file, null, 1) + '\n');
  io.stdout.write(
    `Signed in to ${origin} as account ${plain(me.data.account_id)} with read-only token ` +
    `"${plain(me.data.token?.name, 80)}"${me.data.token?.expires_at ? `, expires ${plain(me.data.token.expires_at, 32)}` : ''}.\n` +
    `Saved to ${path} (owner-only). The token is not shown.\n`
  );
}
async function logout(flags, io) {
  const origin = originOf(flags, io),
    path = credentialsPath(io),
    file = readJson(path);
  if (!file?.origins?.[origin]) {
    io.stdout.write(`No saved token for ${origin}.\n`);
    return;
  }
  delete file.origins[origin];
  writePrivate(path, JSON.stringify(file, null, 1) + '\n');
  io.stdout.write(`Removed the saved token for ${origin}. It still works until you revoke it in Settings.\n`);
}

// ---- init ------------------------------------------------------------------------------------
const ENV_NAMES = ['SUPATRACE_API_KEY', 'SUPATRACE_OTLP_ENDPOINT', 'SUPATRACE_PROJECT', 'SUPATRACE_ENVIRONMENT'];
const envLine = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function envValue(text, name) {
  let found = '';
  for (const line of text.split(/\r?\n/)) {
    const match = envLine.exec(line);
    if (match && match[1] === name) found = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return found;
}
/** Replaces the four SupaTrace lines and leaves every other line as it was. */
function mergeEnv(text, values) {
  const kept = text.split(/\r?\n/).filter(line => {
    const match = envLine.exec(line);
    return !(match && ENV_NAMES.includes(match[1]));
  });
  while (kept.length && kept[kept.length - 1] === '') kept.pop();
  return [...kept, ...Object.entries(values).map(([name, value]) => `${name}=${value}`)].join('\n') + '\n';
}

function ignoredByGit(path) {
  try {
    execFileSync('git', ['check-ignore', '-q', path], {
      cwd: dirname(path),
      stdio: 'ignore',
      timeout: 5000
    });
    return true;
  } catch (error) {
    return error?.status === 1 ? false : null;
  } // 1: tracked or untracked-and-visible. Anything else: not a repository, or no git.
}
async function init(flags, io) {
  const envFile = resolve(io.cwd, flags['env-file'] ?? '.env.local');
  if (flags.project !== undefined && !PROJECT.test(flags.project)) throw new CliError(
    'Invalid --project. Expected proj_ followed by 32 hex characters.', 2);
  if (flags.environment !== undefined && !ENVIRONMENT.test(flags.environment)) throw new CliError(
    'Invalid --environment.', 2);
  if ((flags.environment ?? 'default') !== 'default' && !flags.project) throw new CliError(
    'An --environment needs an explicit --project.', 2);
  const wait = integer(flags.wait, 'wait', 0, 3600, 600);
  if (existsSync(envFile) && lstatSync(envFile).isSymbolicLink()) throw new CliError(
    `Refusing to write through a symlink: ${envFile}`);
  const existing = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
  // Idempotent: a folder that already has a key keeps it. Replacing access is an explicit act (revoke, remove the line, run again).
  if (envValue(existing, 'SUPATRACE_API_KEY')) {
    const bound = envValue(existing, 'SUPATRACE_OTLP_ENDPOINT');
    if (flags.origin !== undefined && bound && checkOrigin(flags.origin) !== bound) throw new CliError(
      `${envFile} is connected to a different origin. It was not changed.`);
    const project = envValue(existing, 'SUPATRACE_PROJECT');
    if (flags.project && project && flags.project !== project) throw new CliError(
      `${envFile} is connected to a different project. It was not changed.`);
    io.stdout.write(
      `Already connected: ${envFile} has SUPATRACE_API_KEY. Nothing was changed.\n` +
      `To replace it, revoke the key in the workspace, remove that line and run init again.\n`
      );
    return;
  }
  // The pending pairing (with its not-yet-approved key) lives in the user's config directory, never in the project.
  let real = envFile;
  try {
    real = join(realpathSync(dirname(envFile)), envFile.slice(dirname(envFile).length + 1));
  } catch {
    /* folder is created on write */ }
  const pendingPath = join(configDir(io), 'pending', digest(real) + '.json');
  let state = readJson(pendingPath);
  if (state) {
    if (!HOSTED.includes(state.origin) && !/^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(String(state.origin)) ||
      !SECRET.test(String(state.write_key)) || !SECRET.test(String(state.device_secret)) || !CODE.test(String(state
        .user_code))) throw new CliError(
      `The pending setup in ${pendingPath} is incomplete. Remove that file to start again.`);
    if (flags.origin !== undefined && checkOrigin(flags.origin) !== state.origin) throw new CliError(
      `A setup for a different origin is pending for this folder. Remove ${pendingPath} to start again.`);
    if (flags.project && flags.project !== state.requested_project_id) throw new CliError(
      `A setup for a different project is pending for this folder. Remove ${pendingPath} to start again.`);
    if (flags.environment !== undefined && flags.environment !== (state.requested_environment_id ?? 'default'))
    throw new CliError(
        `A setup for a different environment is pending for this folder. Remove ${pendingPath} to start again.`);
  } else {
    const origin = originOf(flags, io),
      key = randomBytes(32).toString('base64url'),
      environment = flags.environment ?? 'default';
    const query = new URLSearchParams();
    if (flags.project) query.set('project', flags.project);
    if (environment !== 'default') query.set('environment', environment);
    const started = await call(io, origin, '/api/setup/start' + (query.size ? '?' + query : ''), {
      body: {
        key_hash: digest(key)
      }
    });
    if (started.status !== 201 || !SECRET.test(String(started.data?.device_secret)) || !CODE.test(String(started.data
        ?.user_code))) throw new CliError(
      `Could not start setup with ${origin}` +
      `${started.status ? ` (HTTP ${started.status}${started.data?.error ? ' ' + plain(started.data.error, 60) : ''})` : ' (no connection)'}.` +
      ' Nothing was saved.'
    );
    const uri = started.data.verification_uri;
    state = {
      version: 1,
      origin,
      write_key: key,
      device_secret: started.data.device_secret,
      user_code: started.data.user_code,
      verification_uri: typeof uri === 'string' && uri.startsWith('/app/') && uri.length <= 512 && !/[^\x21-\x7e]/
        .test(uri) ? uri : '/app/',
      ...(flags.project ? {
        requested_project_id: flags.project
      } : {}),
      ...(environment !== 'default' ? {
        requested_environment_id: environment
      } : {})
    };
    privateDir(configDir(io));
    privateDir(dirname(pendingPath));
    writePrivate(pendingPath, JSON.stringify(state) + '\n');
  }
  const environment = state.requested_environment_id ?? 'default';
  io.stdout.write(
    `To connect ${envFile}, a workspace owner or admin opens\n  ${state.origin}${state.verification_uri}\nand approves code ${state.user_code}\n` +
    `Waiting for approval…\n`
    );
  const deadline = io.now() + wait * 1000;
  for (;;) {
    const poll = await call(io, state.origin, '/api/setup/poll', {
      body: {
        device_secret: state.device_secret
      }
    });
    if (poll.status === 410) {
      rmSync(pendingPath, {
        force: true
      });
      throw new CliError(
        'Setup expired before it was confirmed. Nothing was written. If the code was approved, revoke that key in the workspace, then run init again.'
        );
    }
    if (poll.status === 200 && poll.data?.approved === true) {
      const project = poll.data.project_id;
      if (typeof project !== 'string' || !PROJECT.test(project)) throw new CliError(
        'The approved project could not be verified. Nothing was written; run init again to retry.');
      if (state.requested_project_id && project !== state.requested_project_id) throw new CliError(
        'The approval was for a different project than requested. Nothing was written; do not use this connection.'
        );
      if ((poll.data.environment_id ?? 'default') !== environment) throw new CliError(
        'The approval was for a different environment than requested. Nothing was written; do not use this connection.'
        );
      // Read again: the file may have changed while waiting. Never replace a key that appeared meanwhile.
      const current = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
      if (envValue(current, 'SUPATRACE_API_KEY')) throw new CliError(
        `${envFile} gained a SUPATRACE_API_KEY while waiting. It was not changed; the approved key is kept in ${pendingPath}.`
        );
      writePrivate(envFile, mergeEnv(current, {
        SUPATRACE_API_KEY: state.write_key,
        SUPATRACE_OTLP_ENDPOINT: state.origin,
        SUPATRACE_PROJECT: project,
        ...(environment !== 'default' ? {
          SUPATRACE_ENVIRONMENT: environment
        } : {})
      }));
      rmSync(pendingPath, {
        force: true
      });
      io.stdout.write(
        `Connected. Wrote SUPATRACE_API_KEY, SUPATRACE_OTLP_ENDPOINT and SUPATRACE_PROJECT to ${envFile} (owner-only). ` +
        `The key is write-only and is not shown.\n`
        );
      if (ignoredByGit(envFile) === false) io.stderr.write(
        `Warning: ${envFile} is not ignored by git. Add it to .gitignore before committing.\n`);
      return;
    }
    if (poll.status === 200 && poll.data?.pending !== true) throw new CliError(
      'Setup status could not be verified. Nothing was written; run init again to check.');
    if (![0, 200, 429, 500, 502, 503, 504].includes(poll.status)) throw new CliError(
      `Setup could not complete (HTTP ${poll.status}). Nothing was written; run init again to continue.`);
    const pause = (poll.retryAfter ?? 5) * 1000;
    if (io.now() + pause > deadline) throw new CliError(
      'Not approved yet. Nothing was written. Run init again in this folder to keep waiting; the same code stays valid for 10 minutes.',
      3);
    await io.sleep(pause);
  }
}

// ---- tail ------------------------------------------------------------------------------------
const duration = ms => ms == null ? '-' : ms < 1000 ? `${ms}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` :
  `${Math.floor(ms / 60000)}m${String(Math.round(ms % 60000 / 1000)).padStart(2, '0')}s`;
const TAIL_PAGE = 100,
  TAIL_MAX_PAGES = 5,
  TAIL_HISTORY_PAGES = 20;
async function tail(flags, io) {
  const origin = originOf(flags, io),
    token = accessTokenFor(io, origin);
  const interval = integer(flags.interval, 'interval', 1, 300, 5),
    limit = integer(flags.limit, 'limit', 1, 100, 20);
  const query = new URLSearchParams({
    sort: 'started',
    dir: 'desc'
  });
  if (flags.workspace !== undefined) query.set('workspace', flags.workspace);
  if (flags.environment !== undefined) {
    if (!ENVIRONMENT.test(flags.environment)) throw new CliError('Invalid --environment.', 2);
    query.set('environment', flags.environment);
  }
  const seen = new Map();
  if (!flags.json) io.stderr.write(
    `Tailing traces on ${origin}${flags.once ? '' : ` every ${interval}s. Ctrl-C to stop`}.\n`);
  // Following starts by reading the traces that already exist (newest --limit are shown, the rest only noted), so that
  // nothing stored before the tail began is later printed as new. Each later poll reads the newest TAIL_PAGE traces and
  // keeps reading older pages while a page still holds something new or changed, so a burst is not cut off at one page.
  // If the history is longer than TAIL_HISTORY_PAGES pages the rest is told apart by time instead: `baseline` is the
  // server's clock at the first read, and an unseen trace first received at or before that second is taken as history.
  let baseline = null,
    historyComplete = false,
    started = false,
    warnedPartial = false;
  for (;;) {
    // Until one start-up read succeeds from its first page, every poll is a start-up read.
    const first = !started,
      changed = [],
      undo = [];
    let failure = null,
      retryAfter = null,
      pages = 0,
      more = false,
      partial = false;
    for (let offset = 0;; offset += TAIL_PAGE) {
      query.set('limit', String(flags.once ? limit : TAIL_PAGE));
      query.set('offset', String(offset));
      const page = await call(io, origin, '/api/v1/traces?' + query, {
        token
      });
      if (page.status === 401) throw new CliError(
        'The saved token was refused: it is expired or revoked. Run: supatrace login');
      if (page.status === 403) throw new CliError('This account cannot open that workspace.');
      if (page.status === 400 || page.status === 404) throw new CliError(
        `The request was refused (HTTP ${page.status}${page.data?.error ? ' ' + plain(page.data.error, 60) : ''}). Check --workspace and --environment.`
        );
      if (page.status !== 200 || !Array.isArray(page.data?.runs)) {
        failure = page.status;
        retryAfter = page.retryAfter;
        break;
      }
      if (first && offset === 0) baseline = page.date ?? Math.max(0, ...page.data.runs.map(run => Date.parse(run
        ?.created_at)).filter(Number.isFinite));
      let fresh = 0;
      pages++;
      // The API reads a bounded number of stored traces per request. Past that it answers `truncated` and its list is partial.
      if (page.data.truncated === true) partial = true;
      for (const [index, run] of page.data.runs.entries()) {
        if (!run || typeof run.id !== 'string') continue;
        const mark = `${run.event_count}:${run.status}:${run.ended_at}`,
          known = seen.get(run.id);
        if (known === mark) continue;
        seen.set(run.id, mark);
        undo.push([run.id, known]);
        if (flags.once || first) {
          if (offset === 0 && index < limit) changed.push({
            run,
            updated: false
          });
          continue;
        }
        if (known === undefined && !historyComplete && !(Date.parse(run.created_at) > baseline))
      continue; // history the first read did not reach
        fresh++;
        changed.push({
          run,
          updated: known !== undefined
        });
      }
      if (flags.once) break;
      if (first) {
        if (page.data.next == null) {
          historyComplete = true;
          break;
        }
        if (pages === TAIL_HISTORY_PAGES) break;
        continue;
      }
      if (!fresh || page.data.next == null) break;
      if (pages === TAIL_MAX_PAGES) {
        more = true;
        break;
      }
    }
    // A poll that failed part-way is thrown away whole: what it noted is forgotten and nothing from it is printed, so the
    // next poll reads the same traces again instead of stopping at a first page that now looks unchanged. A failed
    // start-up read is likewise repeated, and still shows the newest --limit traces.
    if (failure !== null && !flags.once) {
      for (const [id, known] of undo.reverse()) {
        if (known === undefined) seen.delete(id);
        else seen.set(id, known);
      }
      changed.length = 0;
      more = false;
      if (first) historyComplete = false;
    } else started = true;
    if (partial) {
      historyComplete = false;
      if (!warnedPartial) {
        warnedPartial = true;
        io.stderr.write(
          'This workspace holds more traces than the API lists in one request. The list is partial, so some traces, including new ones, can be missing here.\n'
          );
      }
    }
    for (const {run, updated} of changed.reverse()) {
      if (flags.json) io.stdout.write(JSON.stringify(run) + '\n');
      else io.stdout.write(
        `${plain(run.started_at ?? run.created_at, 32).padEnd(24)}  ` +
        `${plain(run.status ?? '-', 8).padEnd(5)}  ` +
        `${duration(Number.isFinite(run.duration_ms) ? run.duration_ms : null).padStart(7)}  ` +
        `${String(Number.isSafeInteger(run.event_count) ? run.event_count : '?').padStart(5)} events  ` +
        `${plain(run.id, 128)}${updated ? '  (updated)' : ''}\n`
        );
    }
    if (more) io.stderr.write(
      `More than ${TAIL_PAGE * TAIL_MAX_PAGES} traces changed since the last poll; older ones are not shown.\n`);
    // Memory bound for a very long tail. Dropping remembered traces means history is told apart by time from then on.
    if (seen.size > 200000) {
      for (const id of [...seen.keys()].slice(0, seen.size - 100000)) seen.delete(id);
      historyComplete = false;
    }
    if (flags.once) {
      if (failure !== null) throw new CliError(
        `Could not read traces from ${origin}${failure ? ` (HTTP ${failure})` : ' (no connection)'}.`);
      if (!seen.size && !flags.json) io.stderr.write('No traces yet.\n');
      return;
    }
    if (failure !== null && !flags.json) io.stderr.write(
      `Could not read traces${failure ? ` (HTTP ${failure})` : ' (no connection)'}; retrying.\n`);
    await io.sleep((retryAfter ?? interval) * 1000);
  }
}

// ---- dev -------------------------------------------------------------------------------------
/** The local viewer is the repository's loopback dev server. It is not in the npm package. */
export function findCheckout(from) {
  for (let dir = resolve(from);; dir = dirname(dir)) {
    try {
      if (existsSync(join(dir, 'scripts', 'dev.mjs')) && JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
        .name === 'supatrace') return dir;
    } catch {
      /* keep walking */ }
    if (dirname(dir) === dir) return null;
  }
}
async function dev(flags, io) {
  const port = integer(flags.port, 'port', 1024, 65535, 3000);
  const checkout = findCheckout(io.cwd) ?? findCheckout(dirname(fileURLToPath(import.meta.url)));
  if (!checkout) throw new CliError(
    'supatrace dev runs the local viewer from a SupaTrace source checkout, and none was found from this folder.\n' +
    'A packaged local collector and viewer is not shipped yet. ' +
    'Use `supatrace tail`, or run the SDK in its default source mode, which records spans to a local spool and sends nothing.'
    );
  if (!existsSync(join(checkout, 'node_modules'))) throw new CliError(
    `Install the checkout's dependencies first: npm ci --ignore-scripts (in ${checkout})`);
  io.stderr.write(
    'Starting the local viewer on loopback with in-memory synthetic data. It contacts no outside service; data resets on exit.\n'
    );
  const child = spawn(process.execPath, [join(checkout, 'scripts', 'dev.mjs'), '--port', String(port)], {
    cwd: checkout,
    stdio: 'inherit',
    env: io.env
  });
  const forward = signal => {
    try {
      child.kill(signal);
    } catch {
      /* already gone */ }
  };
  const handlers = {
    SIGINT: () => forward('SIGINT'),
    SIGTERM: () => forward('SIGTERM')
  };
  for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler);
  const code = await new Promise((done, fail) => {
    child.once('error', fail);
    child.once('exit', (status, signal) => done(signal ? 0 : status ?? 1));
  });
  for (const [signal, handler] of Object.entries(handlers)) process.off(signal, handler);
  if (code) throw new CliError('The local viewer stopped with an error.', code);
}

// ---- entry -----------------------------------------------------------------------------------
const COMMANDS = {
  login,
  logout,
  init,
  tail,
  dev
};
/** Runs one command. Returns the exit code; nothing here calls process.exit. */
export async function main(argv, overrides = {}) {
  const io = {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    env: process.env,
    cwd: process.cwd(),
    fetch: globalThis.fetch,
    now: Date.now,
    sleep: ms => new Promise(done => setTimeout(done, ms)),
    ...overrides
  };
  const [command, ...rest] = argv;
  try {
    if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
      io.stdout.write(HELP + '\n');
      return command === undefined ? 2 : 0;
    }
    if (command === '--version' || command === '-v') {
      io.stdout.write(JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version + '\n');
      return 0;
    }
    if (!Object.hasOwn(COMMANDS, command)) throw new CliError(`Unknown command. Run supatrace --help.`, 2);
    if (rest.includes('--help') || rest.includes('-h')) {
      io.stdout.write(HELP + '\n');
      return 0;
    }
    await COMMANDS[command](parse(command, rest), io);
    return 0;
  } catch (error) {
    // Only this file's own messages are printed. Unknown failures get a fixed line: no stack, URL, header or body.
    io.stderr.write((error instanceof CliError ? error.message : 'supatrace failed unexpectedly' + (error?.code &&
        /^[A-Z_]{2,24}$/.test(error.code) ? ` (${error.code})` : '') +
      '. Nothing was printed that contains a key.') + '\n');
    return error instanceof CliError ? error.exitCode : 1;
  }
}

let direct = false;
try {
  direct = !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
} catch {
  /* not run as a script */ }
if (direct) process.exitCode = await main(process.argv.slice(2));
