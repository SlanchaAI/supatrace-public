import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, symlinkSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {readSpec} from '../cli.mjs';
const scope = {origin: 'https://supatrace.dev', tenantId: 'github-1', projectId: 'proj_' + '1'.repeat(32), content: 'metadata'};
test('CLI scope files are bounded, non-secret regular files without symlink following', () => {
  const dir = mkdtempSync(join(tmpdir(), 'supatrace-mcp-spec-'));
  try {
    const file = join(dir, 'scope.json'); writeFileSync(file, JSON.stringify(scope)); assert.deepEqual(readSpec(file), scope);
    const link = join(dir, 'link'); symlinkSync(file, link); assert.throws(() => readSpec(link));
    writeFileSync(file, ' '.repeat(16385)); assert.throws(() => readSpec(file));
    writeFileSync(file, JSON.stringify({...scope, sessionToken: 'secret'})); assert.throws(() => readSpec(file));
  } finally {rmSync(dir, {recursive: true, force: true});}
});
test('production CLI accepts a pipe lease, serves protocol-only discovery and exits on EOF', {timeout: 10000}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'supatrace-mcp-cli-')), file = join(dir, 'scope.json'); writeFileSync(file, JSON.stringify(scope));
  const child = spawn(process.execPath, [new URL('../cli.mjs', import.meta.url).pathname, file, '--serve'], {stdio: ['pipe', 'pipe', 'pipe', 'pipe'], env: {PATH: process.env.PATH}});
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({code, signal})));
  let output = '', errors = ''; child.stderr.on('data', data => {errors += data;});
  const response = new Promise((resolve, reject) => {
    let buffer = '';
    child.stdout.on('data', chunk => {
      output += chunk; buffer += chunk;
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (message.id === 1) {
            child.stdin.write(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}) + '\n');
            child.stdin.write(JSON.stringify({jsonrpc: '2.0', id: 2, method: 'tools/list'}) + '\n');
          }
          if (message.id === 2) resolve(message);
        } catch (error) {reject(error);}
      }
    });
    child.once('error', reject);
  });
  try {
    const token = 'p'.repeat(43);
    child.stdio[3].end(JSON.stringify({origin: scope.origin, tenantId: scope.tenantId, projectId: scope.projectId, sessionToken: token, expiresAt: Date.now() + 60000}));
    child.stdin.write(JSON.stringify({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'cli-wire-test', version: '1'}}}) + '\n');
    assert.equal((await response).result.tools.length, 4);
    child.stdin.end(); assert.equal((await exited).code, 0);
    assert.equal(errors, ''); assert.doesNotMatch(output, new RegExp(token));
  } finally {child.kill(); rmSync(dir, {recursive: true, force: true});}
});
test('CLI malformed or oversized credential pipe fails without echoing secrets', {timeout: 10000}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'supatrace-mcp-pipe-')), file = join(dir, 'scope.json'); writeFileSync(file, JSON.stringify(scope));
  try {
    for (const input of ['PRIVATE_NOT_JSON', 'PRIVATE_SECRET'.repeat(400), JSON.stringify({expiresAt: 0, sessionToken: 'PRIVATE_SECRET'})]) {
      const child = spawn(process.execPath, [new URL('../cli.mjs', import.meta.url).pathname, file, '--serve'], {stdio: ['pipe', 'pipe', 'pipe', 'pipe'], env: {PATH: process.env.PATH}});
      let out = '', errors = ''; child.stdout.on('data', data => {out += data;}); child.stderr.on('data', data => {errors += data;}); child.stdio[3].on('error', () => {});
      const exited = new Promise(resolve => child.once('exit', code => resolve(code))); child.stdio[3].end(input); child.stdin.end();
      assert.equal(await exited, 1); assert.equal(out, ''); assert.doesNotMatch(errors, /PRIVATE_/);
    }
  } finally {rmSync(dir, {recursive: true, force: true});}
});
