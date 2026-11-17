import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const inventoryPath = fileURLToPath(new URL('../tests/ui-test-inventory.json', import.meta.url));
const args = JSON.parse(readFileSync(inventoryPath, 'utf8'));

export function runUiTests(spawn = spawnSync) {
  const child = spawn(process.execPath, args, {stdio: 'inherit'});
  if (child.error || child.signal || !Number.isInteger(child.status)) return 1;
  return child.status;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = runUiTests();
}
