import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runPythonTests} from '../scripts/run-python-tests.mjs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const inventory = JSON.parse(readFileSync(new URL('../tests/python-test-inventory.json', import.meta.url), 'utf8'));

test('test script invokes the python runner', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.scripts.test.includes('node scripts/run-python-tests.mjs'));
});

test('test script keeps the node segment', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const parts = pkg.scripts.test.split(' && ');
  assert.equal(parts.length, 2);
  assert.equal(parts[0], 'node scripts/run-unit-tests.mjs');
  assert.equal(parts[1], 'node scripts/run-python-tests.mjs');
});

test('inventory matches the original python segment', () => {
  assert.ok(Array.isArray(inventory));
  assert.equal(inventory[0], 'python3');
  assert.equal(inventory[1], '-m');
  assert.equal(inventory[2], 'unittest');
  assert.deepEqual(inventory.slice(3).map((f) => f.endsWith('.py')), inventory.slice(3).map(() => true));
});

test('runPythonTests passes inventory to python3 with inherit stdio', () => {
  let captured;
  const status = runPythonTests((cmd, args, opts) => {
    captured = {cmd, args, opts};
    return {status: 0};
  });
  assert.equal(status, 0);
  assert.equal(captured.cmd, 'python3');
  assert.deepEqual(captured.args, inventory.slice(1));
  assert.deepEqual(captured.opts, {stdio: 'inherit'});
});

test('runPythonTests returns child error as 1', () => {
  assert.equal(runPythonTests(() => ({error: new Error('boom')})), 1);
});

test('runPythonTests returns signal as 1', () => {
  assert.equal(runPythonTests(() => ({signal: 'SIGTERM'})), 1);
});

test('runPythonTests returns non-integer status as 1', () => {
  assert.equal(runPythonTests(() => ({status: null})), 1);
});

test('runPythonTests returns nonzero status', () => {
  assert.equal(runPythonTests(() => ({status: 7})), 7);
});

test('runner entry point exits with child status', () => {
  const out = execFileSync(process.execPath, ['-e', `
    import {runPythonTests} from '${fileURLToPath(new URL('../scripts/run-python-tests.mjs', import.meta.url))}';
    console.log(runPythonTests(() => ({status: 3})));
  `], {encoding: 'utf8'}).trim();
  assert.equal(out, '3');
});
