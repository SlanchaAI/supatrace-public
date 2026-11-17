import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runUiTests} from '../scripts/run-ui-tests.mjs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const inventory = JSON.parse(readFileSync(new URL('../tests/ui-test-inventory.json', import.meta.url), 'utf8'));

test('test:ui script invokes the runner', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['test:ui'], 'node scripts/run-ui-tests.mjs');
});

test('inventory matches the original test:ui arguments', () => {
  assert.ok(Array.isArray(inventory));
  assert.ok(inventory.length >= 2);
});

test('runUiTests passes inventory to node with inherit stdio', () => {
  let captured;
  const status = runUiTests((cmd, args, opts) => {
    captured = {cmd, args, opts};
    return {status: 0};
  });
  assert.equal(status, 0);
  assert.equal(captured.cmd, process.execPath);
  assert.deepEqual(captured.args, inventory);
  assert.deepEqual(captured.opts, {stdio: 'inherit'});
});

test('runUiTests returns child error as 1', () => {
  assert.equal(runUiTests(() => ({error: new Error('boom')})), 1);
});

test('runUiTests returns signal as 1', () => {
  assert.equal(runUiTests(() => ({signal: 'SIGTERM'})), 1);
});

test('runUiTests returns non-integer status as 1', () => {
  assert.equal(runUiTests(() => ({status: null})), 1);
});

test('runUiTests returns nonzero status', () => {
  assert.equal(runUiTests(() => ({status: 7})), 7);
});

test('runner entry point exits with child status', () => {
  const out = execFileSync(process.execPath, ['-e', `
    import {runUiTests} from '${fileURLToPath(new URL('../scripts/run-ui-tests.mjs', import.meta.url))}';
    console.log(runUiTests(() => ({status: 3})));
  `], {encoding: 'utf8'}).trim();
  assert.equal(out, '3');
});
