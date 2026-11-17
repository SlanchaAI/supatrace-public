import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { init, parseApiKey, SupaTrace } from '../index.mjs';
import * as sdk from '../index.mjs';
import { parseBatch } from '../../../src/trace.mjs';

const now = () => new Date().toISOString();
const spool = () => mkdtempSync(join(tmpdir(), 'supatrace-spool-'));

const PKG = fileURLToPath(new URL('..', import.meta.url));
const KEY = 'a'.repeat(43) + '.proj_' + '0'.repeat(32);

test('surface: internal receipts are not exported', () => {
  for (const name of ['evidence', 'DRIFT', 'STATE', 'SPEC', 'specSha', 'decision_record']) {
    assert.equal(name in sdk, false, name);
    assert.equal(name in sdk.default, false, name);
  }
});

test('surface: public operations round trip', () => {
  const t = init('checkout', { spool: spool() });
  const ok = [{ id: 'e1', time: now(), kind: 'note', name: 'n', data: { a: 1 } }];
  const checked = {
    version: () => assert.equal(t.batch(ok).batch.version, 1),
    init: () => assert.ok(init('x') instanceof SupaTrace),
    batch: () => assert.equal(t.batch(ok).report.valid, true),
    // dry_run must validate without writing — otherwise it is just `write` under a new name.
    dry_run: () => {
      const trace = init('checkout', { spool: spool() });
      const r = trace.batch(ok, { dryRun: true });
      assert.equal(r.report.valid, true);
      assert.equal(r.report.path, null, 'dry_run must not write');
    },
    span: () => assert.equal(t.span('checkout.request').report.valid, true),
    // attachments: the 32 KiB per-event line the server uses, enforced not described.
    attachments: () => {
      const big = t.build([{ id: 'e2', time: now(), kind: 'note', name: 'big',
                            data: 'x'.repeat(32769) }]);
      assert.equal(big.report.valid, false);
    },
    close: () => assert.equal(t.close().closed, true),
  };
  for (const check of Object.values(checked)) check();
});

test('init(): no network, no provider import, source mode by default', () => {
  const trace = init();
  assert.ok(trace instanceof SupaTrace);
  assert.equal(trace.capture.mode, 'source');
  assert.equal(trace.capture.sending, false, 'nothing is streamed by default');
  assert.equal(trace.capture.telemetryUsed, false);
});

test('init(component, options) and init(options) both work', () => {
  assert.equal(init('checkout').service, 'checkout');
  assert.equal(init({ service: 'billing' }).service, 'billing');
});

test('build(): valid batch round trips through the shipped validator and spools', () => {
  const trace = init('checkout', { spool: spool() });
  const { batch, report } = trace.build([
    { id: 'e1', time: now(), kind: 'note', name: 'synthetic', data: { message: 'safe' } },
  ]);
  assert.equal(report.empty, false);
  assert.ok(report.delegated, 'validation is delegated to src/trace.mjs, not skipped');
  assert.equal(report.valid, true, report.errors.join('; '));
  assert.ok(report.path, 'batch spooled for human review');

  // read back: what landed on disk must still parse as a batch, and must hash identically
  const fromDisk = JSON.parse(readFileSync(report.path, 'utf8'));
  assert.deepEqual(fromDisk, batch);
  assert.equal(parseBatch(JSON.stringify(fromDisk)).content_hash, report.sha256);
});

test('build(): hostile content is preserved as data, never executed or escaped', () => {
  const trace = init('checkout', { spool: spool() });
  const { report } = trace.build([
    { id: 'e1', time: now(), kind: 'note', name: 'xss', data: '<script>alert(1)</script>' },
  ]);
  assert.equal(report.valid, true);
});

test('build(): rejects what the server rejects — delegation is not a rubber stamp', () => {
  const trace = init('checkout', { spool: spool() });
  const bad = (over) => trace.build([{ id: 'e1', time: now(), kind: 'note', name: 'n', data: {}, ...over }]);
  assert.equal(bad({ kind: 'admin' }).report.valid, false, 'unknown kind');
  assert.equal(bad({ time: '2026-11-14T00:00:00' }).report.valid, false, 'missing timezone');
  const dup = trace.build([
    { id: 'e1', time: now(), kind: 'note', name: 'a', data: {} },
    { id: 'e1', time: now(), kind: 'note', name: 'b', data: {} },
  ]);
  assert.equal(dup.report.valid, false, 'duplicate event id');
  assert.ok(dup.report.path === null, 'an invalid batch is never spooled');
});

test('build(): empty source produces no batch', () => {
  const trace = init('checkout', { spool: spool() });
  assert.equal(trace.build([]).report.empty, true);
  assert.equal(trace.build(() => []).report.empty, true, 'callable source stays zero-copy');
});

test('emit(): span() in source mode records for review and does not transmit', () => {
  const trace = init('checkout', { spool: spool() });
  const result = trace.span('checkout.request', { route: '/checkout' });
  assert.equal(result.report.valid, true);
  assert.equal(trace.capture.telemetryUsed, true);
});

test('content capture is opt-in and off by default', () => {
  assert.equal(init().capture.captureContent, false);
  assert.equal(init({ captureContent: true }).capture.captureContent, true);
  process.env.SUPATRACE_CAPTURE_CONTENT = '1';
  assert.equal(init().capture.captureContent, true, 'env opt-in honoured');
  delete process.env.SUPATRACE_CAPTURE_CONTENT;
});

test('attachments(): oversized payload refused at the same 32 KiB line as the server', () => {
  const trace = init('checkout', { spool: spool() });
  const { report } = trace.build([
    { id: 'e1', time: now(), kind: 'note', name: 'big', data: 'x'.repeat(32769) },
  ]);
  assert.equal(report.valid, false);
});

test('otlp mode without a real exporter records why it stayed quiet', () => {
  const trace = init('checkout', { mode: 'otlp' });
  assert.equal(trace.capture.mode, 'otlp');
  assert.equal(trace.capture.sending, false);
  assert.ok(trace.capture.skipped.length > 0);
  assert.match(trace.capture.skipped.join(' '), /nothing to export to|not installed/);
});

test('otlp mode with an endpoint but no key creates no exporter', () => {
  const trace = init('checkout', { mode: 'otlp', endpoint: 'http://127.0.0.1:4318' });
  assert.equal(trace.capture.endpoint, 'http://127.0.0.1:4318');
  assert.equal(trace.capture.sending, false);
  assert.ok(trace.capture.skipped.some((s) => /refusing to export unauthenticated/.test(s)),
    'reported as drift, not silently skipped');
});

const hasOtel = (() => {
  try {
    const require = createRequire(join(PKG, 'index.mjs'));
    require.resolve('@opentelemetry/sdk-trace-base');
    require.resolve('@opentelemetry/exporter-trace-otlp-http');
    return true;
  } catch {
    return false;
  }
})();

test('otlp leaves the application global provider untouched in either setup order', { skip: !hasOtel && 'OTel packages not installed' }, () => {
  for (const order of ['before', 'after']) {
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { trace } from '@opentelemetry/api';
      import { BasicTracerProvider, SimpleSpanProcessor, InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
      import { init } from './index.mjs';
      const sink = new InMemorySpanExporter();
      const app = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(sink)] });
      if ('${order}' === 'before') assert.equal(trace.setGlobalTracerProvider(app), true);
      const original = trace.getTracerProvider();
      const client = init('sdk', { mode: 'otlp', endpoint: 'http://127.0.0.1:4318', apiKey: '${KEY}' });
      assert.equal(client.capture.sending, true);
      assert.equal(trace.getTracerProvider(), original);
      if ('${order}' === 'after') assert.equal(trace.setGlobalTracerProvider(app), true);
      trace.getTracer('application').startSpan('app-before-close').end();
      await client.close().shutdown;
      trace.getTracer('application').startSpan('app-after-close').end();
      assert.deepEqual(sink.getFinishedSpans().map(s => s.name), ['app-before-close', 'app-after-close']);
      await app.shutdown();
    `], { cwd: PKG, stdio: 'pipe' });
  }
});

test('otlp mode exports span() over OTLP/HTTP with the API key', { skip: !hasOtel && 'OTel packages not installed' }, async () => {
  const seen = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push([req.url, req.headers.authorization, req.headers['x-supatrace-key']]);
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const trace = init('checkout', { mode: 'otlp', endpoint, apiKey: KEY, instruments: [] });
    assert.equal(trace.capture.sending, true);
    assert.equal(trace.span('checkout.request').recorded, 'otlp');
    await trace.flush().flushed;
    await trace.close().shutdown;
  } finally {
    server.close();
  }
  assert.ok(seen.length, 'no OTLP request reached the listener');
  assert.deepEqual(seen[0], ['/v1/traces', `Bearer ${'a'.repeat(43)}`, 'a'.repeat(43)]);
});

test('otlp mode without the OTel packages reports sending: false', () => {
  // Run the packed files alone, where no OTel package can resolve.
  const dir = mkdtempSync(join(tmpdir(), 'supatrace-nootel-'));
  for (const f of ['index.mjs', 'trace.mjs', 'instrument.mjs', 'package.json']) copyFileSync(join(PKG, f), join(dir, f));
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { init } from ${JSON.stringify(join(dir, 'index.mjs'))};
    const t = init('c', { mode: 'otlp', endpoint: 'http://127.0.0.1:9', apiKey: ${JSON.stringify(KEY)} });
    console.log(JSON.stringify(t.capture));`], { encoding: 'utf8' });
  const capture = JSON.parse(out);
  assert.equal(capture.sending, false);
  assert.match(capture.skipped.join(' '), /not installed/);
});

test('packed package validates batches on its own (no repo src/ on the path)', () => {
  const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'supatrace-packed-'));
  for (const f of [...pkg.files.filter((f) => f.endsWith('.mjs')), 'package.json']) {
    copyFileSync(join(PKG, f), join(dir, f));
  }
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { init } from ${JSON.stringify(join(dir, 'index.mjs'))};
    const r = init({ spool: ${JSON.stringify(spool())} }).batch([{ id: 'e1', time: new Date().toISOString(), kind: 'note', name: 'n', data: {} }]);
    console.log(JSON.stringify(r.report));`], { encoding: 'utf8' });
  const report = JSON.parse(out);
  assert.deepEqual(report.errors, []);
  assert.equal(report.valid, true);
});

test('bundled trace.mjs is byte-identical to src/trace.mjs', () => {
  const repoCopy = join(PKG, '..', '..', 'src', 'trace.mjs');
  assert.ok(readFileSync(join(PKG, 'trace.mjs')).equals(readFileSync(repoCopy)),
    'packages/supatrace-js/trace.mjs drifted from src/trace.mjs; copy it again');
});

test('batch() is the Python name; build() stays as an alias', () => {
  const ok = [{ id: 'e1', time: '2026-11-14T00:00:00Z', kind: 'note', name: 'n', data: {} }];
  const t = init('checkout', { spool: spool() });
  assert.deepEqual(t.build(ok, { dryRun: true }), t.batch(ok, { dryRun: true }));
});

test('default spool matches the Python half', () => {
  const saved = process.env.SUPATRACE_SPOOL;
  delete process.env.SUPATRACE_SPOOL;
  try {
    assert.equal(init().spool, join(homedir(), '.supatrace', 'pending'));
  } finally {
    if (saved !== undefined) process.env.SUPATRACE_SPOOL = saved;
  }
});

test('spool directory and batch files are owner-only, as in Python', () => {
  const dir = join(spool(), 'fresh');
  const { report } = init('checkout', { spool: dir }).batch([
    { id: 'e1', time: now(), kind: 'note', name: 'n', data: {} }]);
  assert.equal(statSync(report.path).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test('an endpoint in the environment alone does not turn on export', () => {
  process.env.SUPATRACE_OTLP_ENDPOINT = 'http://127.0.0.1:9';
  try {
    const trace = init({ apiKey: KEY });
    assert.equal(trace.capture.mode, 'source');
    assert.equal(trace.capture.sending, false);
  } finally {
    delete process.env.SUPATRACE_OTLP_ENDPOINT;
  }
});

test('a bare secret takes its project from SUPATRACE_PROJECT, as in Python', () => {
  process.env.SUPATRACE_PROJECT = 'proj_' + '1'.repeat(32);
  try {
    const parsed = parseApiKey('a'.repeat(43));
    assert.equal(parsed.project, 'proj_' + '1'.repeat(32));
    assert.equal(parsed.source, 'SUPATRACE_PROJECT');
  } finally {
    delete process.env.SUPATRACE_PROJECT;
  }
  assert.equal(parseApiKey('a'.repeat(43)).project, 'default');
});

test('typed st_pub_ and st_sec_ keys parse; other prefixes and lengths do not', () => {
  const project = 'proj_' + '0'.repeat(32);
  for (const prefix of ['st_pub_', 'st_sec_']) {
    const key = prefix + 'a'.repeat(43);
    assert.equal(parseApiKey(key + '.' + project).secret, key);
    assert.equal(parseApiKey(key).secret, key);
  }
  for (const bad of ['st_adm_' + 'a'.repeat(43), 'st_pub_' + 'a'.repeat(42), 'st_pub_' + 'a'.repeat(44), 'ST_PUB_' + 'a'.repeat(43)]) {
    assert.throws(() => parseApiKey(bad), /does not match/);
  }
});

test('key handling: parsed, and never echoed back whole', () => {
  const good = parseApiKey('a'.repeat(43) + '.proj_' + '0'.repeat(32));
  assert.equal(good.project, 'proj_' + '0'.repeat(32));
  assert.throws(() => parseApiKey('totally-not-a-key'), /does not match/);
  const trace = init({ apiKey: 'totally-not-a-key-that-is-long' });
  assert.ok(!JSON.stringify(trace.capture).includes('totally-not-a-key-that-is-long'), 'no key leak in capture');
  assert.match(trace.toString(), /key=absent/);
});

test('close() releases the handle', () => {
  const trace = init('checkout', { spool: spool() });
  assert.equal(trace.close().closed, true);
  assert.equal(trace.flush().flushed, false);
});