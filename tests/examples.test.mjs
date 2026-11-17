// Smoke test for the example apps under examples/. Each dry run uses a scripted model and
// must work with the network blocked, no provider key and no installed dependencies, and
// must spool a batch the server's validator accepts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseBatch} from '../src/trace.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
// Fail loudly if an example opens a socket.
const PY_BLOCK = 'import socket, runpy, sys\ndef _blocked(*a, **k):\n    raise RuntimeError("network blocked in smoke test")\nsocket.socket = _blocked\nsocket.create_connection = _blocked\nsys.argv = sys.argv[1:]\nrunpy.run_path(sys.argv[0], run_name="__main__")\n';
const JS_BLOCK = 'data:text/javascript,' + encodeURIComponent('import net from "node:net"; import tls from "node:tls"; const blocked = () => { throw new Error("network blocked in smoke test"); }; net.connect = net.createConnection = tls.connect = blocked; net.Socket.prototype.connect = blocked; globalThis.fetch = blocked;');
const env = dir => Object.fromEntries(Object.entries({...process.env, HOME: dir}).filter(([name]) => !/^(SUPATRACE_|OPENAI_|ANTHROPIC_|OTEL_|PYTHONPATH$)/.test(name)));

function run(command, args) {
  const dir = mkdtempSync(join(tmpdir(), 'supatrace-example-'));
  try {
    const out = JSON.parse(execFileSync(command, args, {cwd: dir, encoding: 'utf8', timeout: 60000, env: env(dir)}));
    assert.equal(out.valid, true);
    assert.deepEqual(out.errors, []);
    assert.match(out.path, /^spool\/[a-f0-9]{64}\.json$/);
    const files = readdirSync(join(dir, 'spool'));
    assert.equal(files.length, 1, 'one reviewed batch file');
    const raw = readFileSync(join(dir, out.path), 'utf8');
    parseBatch(raw);
    assert.equal(existsSync(join(dir, '.supatrace')), false, 'writes only to the spool it names');
    return {out, batch: JSON.parse(raw), raw};
  } finally { rmSync(dir, {recursive: true, force: true}); }
}
// Only what the example chose to record. Timestamps and generated ids are excluded: random
// digits in them must not be mistaken for recorded content.
const recorded = batch => JSON.stringify(batch.events.map(event => [event.kind, event.name, event.data]));
const kinds = batch => batch.events.map(event => event.kind);

test('python-agent dry run records the tool loop and keeps content out by default', () => {
  const script = join(repo, 'examples/python-agent/agent.py');
  const {out, batch, raw} = run('python3', ['-c', PY_BLOCK, script, '--dry-run']);
  assert.equal(out.answer, 'The answer is 391.');
  assert.match(batch.run_id, /^python-agent-[0-9a-f]{12}$/);
  assert.equal(out.ok, true);
  assert.deepEqual(kinds(batch), ['request', 'tool_call', 'tool_result', 'request', 'response']);
  assert.doesNotMatch(recorded(batch), /17 \* 23|391|"arguments"/, 'no question, argument, result or answer text');
  const withContent = run('python3', ['-c', PY_BLOCK, script, '--dry-run', '--content']);
  assert.match(withContent.raw, /The answer is 391\./);
  assert.deepEqual(withContent.batch.events[1].data.arguments, {a: 17, b: 23});
  assert.notEqual(withContent.batch.run_id, batch.run_id, 'each invocation is its own trace');
});

test('langgraph-agent dry run drives the graph nodes and records the same loop', () => {
  const {out, batch, raw} = run('python3', ['-c', PY_BLOCK, join(repo, 'examples/langgraph-agent/agent.py'), '--dry-run']);
  assert.equal(out.answer, 'The answer is 391.');
  assert.ok(['langgraph', 'run_nodes'].includes(out.runner));
  assert.match(batch.run_id, /^langgraph-agent-[0-9a-f]{12}$/);
  assert.equal(out.ok, true);
  assert.deepEqual(kinds(batch), ['request', 'tool_call', 'tool_result', 'request', 'response']);
  assert.doesNotMatch(recorded(batch), /391|17 \* 23/);
  // Tracing switched on in the shell must not make LangChain or LangGraph upload the run.
  const inherited = execFileSync('python3', ['-c', 'import importlib.util, json, os, sys\nspec = importlib.util.spec_from_file_location("example_agent", sys.argv[1])\nagent = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(agent)\nprint(json.dumps({name: os.environ.get(name) for name in agent.TRACING_SWITCHES}))', join(repo, 'examples/langgraph-agent/agent.py')], {encoding: 'utf8', env: {...process.env, LANGSMITH_TRACING: 'true', LANGCHAIN_TRACING_V2: 'true', LANGSMITH_API_KEY: 'synthetic-not-a-key'}});
  assert.deepEqual(JSON.parse(inherited), {LANGSMITH_TRACING: 'false', LANGSMITH_TRACING_V2: 'false', LANGCHAIN_TRACING: 'false', LANGCHAIN_TRACING_V2: 'false'});
  // Without --dry-run a missing langgraph is an error, never a silent fallback.
  const source = readFileSync(join(repo, 'examples/langgraph-agent/agent.py'), 'utf8');
  assert.match(source, /allow_fallback=args\.dry_run/);
  assert.ok(source.indexOf('os.environ[_name] = "false"') < source.indexOf('from langgraph'), 'switched off before langgraph is imported');
  assert.match(source, /with no_third_party_tracing\(\):\n\s+final = graph\.invoke\(state\)/);
  for (const call of ['StateGraph(State)', 'add_conditional_edges("model", route', 'add_edge("tool", "model")']) assert.ok(source.includes(call), call);
});

test('nextjs-ai-sdk smoke runs the code the route handler calls and spools a valid batch', () => {
  const {out, batch, raw} = run(process.execPath, ['--import', JS_BLOCK, join(repo, 'examples/nextjs-ai-sdk/smoke.mjs')]);
  assert.equal(out.answer, 'Hello from a scripted model.');
  assert.match(batch.run_id, /^nextjs-ai-sdk-[0-9a-f]{12}$/);
  assert.deepEqual(kinds(batch), ['request', 'response']);
  assert.doesNotMatch(recorded(batch), /Say hello|scripted model\./, 'no prompt or reply text');
  const route = readFileSync(join(repo, 'examples/nextjs-ai-sdk/app/api/chat/route.js'), 'utf8');
  assert.match(route, /import \{ chat \} from "\.\.\/\.\.\/\.\.\/lib\/chat\.mjs"/);
  assert.match(route, /export const runtime = "nodejs"/);
  assert.match(route, /generate: generateText/);
  const manifest = JSON.parse(readFileSync(join(repo, 'examples/nextjs-ai-sdk/package.json'), 'utf8'));
  assert.equal(manifest.dependencies['@supatrace/client'], 'file:../../packages/supatrace-js');
  for (const name of ['next', 'ai', '@ai-sdk/openai', 'react', 'react-dom']) assert.ok(manifest.dependencies[name], name);
  // The route is unauthenticated and spends a provider key, so the example listens on loopback only.
  for (const script of ['dev', 'start']) assert.match(manifest.scripts[script], /^next (dev|start) -H 127\.0\.0\.1$/, script);
});

test('example READMEs name commands that exist and do not overclaim', () => {
  for (const name of ['nextjs-ai-sdk', 'python-agent', 'langgraph-agent']) {
    const readme = readFileSync(join(repo, 'examples', name, 'README.md'), 'utf8');
    assert.match(readme, /Nothing is uploaded/, name);
    assert.match(readme, /not run in CI|not started in CI/, name + ' says what CI does not cover');
    assert.match(readme, /agent\/upload\.py/, name);
    for (const [, path] of readme.matchAll(/(?:python3|node) (examples\/[a-z-]+\/[a-z.]+)/g)) assert.ok(existsSync(join(repo, path)), path);
    assert.doesNotMatch(readme, /pip install supatrace\b|npm install @supatrace\/client|vercel\.com\/new/, name);
  }
  const index = readFileSync(join(repo, 'examples/README.md'), 'utf8');
  assert.match(index, /not on PyPI or npm/);
  assert.match(index, /OTLP\/HTTP receiver is available on supatrace\.dev for traces/);
  for (const [, link] of index.matchAll(/\]\(([a-z-]+\/)\)/g)) assert.ok(existsSync(join(repo, 'examples', link, 'README.md')), link);
});

// Drives an example's run() with a model the test supplies, in a clean directory.
function drive(example, body) {
  const dir = mkdtempSync(join(tmpdir(), 'supatrace-example-'));
  try {
    const code = `import importlib.util, json, sys\nspec = importlib.util.spec_from_file_location("example_agent", sys.argv[1])\nagent = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(agent)\n${body}`;
    const out = JSON.parse(execFileSync('python3', ['-c', code, join(repo, 'examples', example, 'agent.py')], {cwd: dir, encoding: 'utf8', timeout: 60000, env: env(dir)}));
    const raw = readFileSync(join(dir, out.path), 'utf8');
    parseBatch(raw);
    return {out, batch: JSON.parse(raw), raw};
  } finally { rmSync(dir, {recursive: true, force: true}); }
}

test('a provider failure or an agent that never answers is spooled as an error and reported as failed', () => {
  const failing = 'def model(messages):\n    if messages[-1]["role"] == "tool":\n        raise TimeoutError("secret-detail-from-provider")\n    return agent.scripted_model(messages)\n';
  const python = drive('python-agent', failing + 'answer, report, ok = agent.run("q", model, "m")\nprint(json.dumps({"answer": answer, "ok": ok, "path": report["path"]}))');
  assert.equal(python.out.ok, false);
  assert.equal(python.out.answer, null);
  assert.deepEqual(kinds(python.batch), ['request', 'tool_call', 'tool_result', 'request', 'error']);
  assert.deepEqual(python.batch.events.at(-1).data, {type: 'TimeoutError'});
  assert.doesNotMatch(python.raw, /secret-detail/, 'the error message is not recorded');

  const looping = 'def model(messages):\n    return {"content": None, "tool_calls": [{"id": "c%d" % len(messages), "name": "multiply", "arguments": {"a": 2, "b": 3}}], "total_tokens": 1}\n';
  const exhausted = drive('python-agent', looping + 'answer, report, ok = agent.run("q", model, "m", max_turns=2)\nprint(json.dumps({"answer": answer, "ok": ok, "path": report["path"]}))');
  assert.equal(exhausted.out.ok, false);
  assert.deepEqual(exhausted.batch.events.at(-1), {...exhausted.batch.events.at(-1), kind: 'error', name: 'agent', data: {type: 'max_turns', max_turns: 2}});

  const graph = drive('langgraph-agent', failing.replace('agent.scripted_model(messages)', 'agent.scripted_model(messages)') + 'answer, report, runner, ok = agent.run("q", model, "m", allow_fallback=True)\nprint(json.dumps({"answer": answer, "ok": ok, "path": report["path"]}))');
  assert.equal(graph.out.ok, false);
  assert.deepEqual(kinds(graph.batch), ['request', 'tool_call', 'tool_result', 'request', 'error']);
  assert.doesNotMatch(graph.raw, /secret-detail/);

  // The CLI exit status follows ok, not just batch validity.
  for (const example of ['python-agent', 'langgraph-agent']) assert.match(readFileSync(join(repo, 'examples', example, 'agent.py'), 'utf8'), /return 0 if ok else 1/);
});

test('the Next.js chat route refuses cross-site and non-JSON requests before calling the model', async () => {
  const {rejectCrossSite} = await import('../examples/nextjs-ai-sdk/lib/guard.mjs');
  const request = headers => new Request('http://127.0.0.1:3000/api/chat', {method: 'POST', headers, body: '{"prompt":"x"}'});
  const own = {host: '127.0.0.1:3000', 'content-type': 'application/json'};
  assert.equal(rejectCrossSite(request({...own, origin: 'http://127.0.0.1:3000', 'sec-fetch-site': 'same-origin'})), null);
  assert.equal(rejectCrossSite(request(own)), null, 'curl without Origin');
  assert.deepEqual(rejectCrossSite(request({host: '127.0.0.1:3000', 'content-type': 'text/plain'})), {status: 415, error: 'json_required'});
  assert.deepEqual(rejectCrossSite(request({host: '127.0.0.1:3000'})), {status: 415, error: 'json_required'});
  for (const headers of [{...own, origin: 'https://evil.example'}, {...own, origin: 'http://127.0.0.1:3001'}, {...own, origin: 'null'}, {...own, 'sec-fetch-site': 'cross-site'}, {...own, 'sec-fetch-site': 'same-site', origin: 'http://127.0.0.1:3000'}]) assert.deepEqual(rejectCrossSite(request(headers)), {status: 403, error: 'cross_site_refused'}, JSON.stringify(headers));
  // DNS rebinding: a hostile name that resolves to loopback has matching Host and Origin.
  for (const host of ['evil.example:3000', 'evil.example', '127.0.0.1.evil.example:3000', 'localhost.evil.example', '10.0.0.5:3000', '127.0.0.1:3000@evil.example', '']) {
    assert.deepEqual(rejectCrossSite(request({host, 'content-type': 'application/json', origin: 'http://' + host, 'sec-fetch-site': 'same-origin'})), {status: 403, error: 'host_refused'}, host);
  }
  assert.deepEqual(rejectCrossSite(new Request('http://127.0.0.1:3000/api/chat', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'})), {status: 403, error: 'host_refused'}, 'no Host header');
  for (const host of ['localhost:3000', '127.0.0.1', '[::1]:3000', 'LOCALHOST:3000']) assert.equal(rejectCrossSite(request({host, 'content-type': 'application/json', origin: 'http://' + host.toLowerCase(), 'sec-fetch-site': 'same-origin'})), null, host);
  const route = readFileSync(join(repo, 'examples/nextjs-ai-sdk/app/api/chat/route.js'), 'utf8');
  assert.ok(route.indexOf('rejectCrossSite(request)') > 0 && route.indexOf('rejectCrossSite(request)') < route.indexOf('await chat('), 'checked before the provider call');
});
// Registered here so the root `npm test` list does not change: the CLI ships in the same SDK package the examples use.
import './cli.test.mjs';
