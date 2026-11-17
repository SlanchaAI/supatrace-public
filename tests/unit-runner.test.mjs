import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runUnitTests} from '../scripts/run-unit-tests.mjs';

test('package test script uses the unit runner and keeps the python suffix', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const segments = pkg.scripts.test.split(' && ');
  assert.equal(segments[0], 'node scripts/run-unit-tests.mjs');
  assert.equal(segments[1], 'node scripts/run-python-tests.mjs');
  assert.ok(JSON.parse(readFileSync(new URL('./python-test-inventory.json', import.meta.url), 'utf8')).includes('tests/test_connect.py'));
});

test('runner spawns node with exact inventory argv and inherit stdio', () => {
  const inventory = JSON.parse(
    readFileSync(new URL('../tests/unit-test-inventory.json', import.meta.url), 'utf8'),
  );
  let captured;
  const exitCode = runUnitTests((cmd, args, opts) => {
    captured = {cmd, args, opts};
    return {status: 0};
  });
  assert.equal(exitCode, 0);
  assert.equal(captured.cmd, process.execPath);
  assert.deepEqual(captured.args, inventory);
  assert.deepEqual(captured.opts, {stdio: 'inherit'});
});

test('runner propagates child failure status', () => {
  assert.equal(runUnitTests(() => ({status: 3})), 3);
});

test('runner returns 1 on spawn error', () => {
  assert.equal(runUnitTests(() => ({error: new Error('spawn failed')})), 1);
});

test('runner returns 1 on child signal', () => {
  assert.equal(runUnitTests(() => ({signal: 'SIGTERM'})), 1);
});
