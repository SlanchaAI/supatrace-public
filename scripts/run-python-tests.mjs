import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const inventoryPath = fileURLToPath(new URL('../tests/python-test-inventory.json', import.meta.url));
const [cmd, ...args] = JSON.parse(readFileSync(inventoryPath, 'utf8'));

export function runPythonTests(spawn = spawnSync) {
  const child = spawn(cmd, args, {stdio: 'inherit'});
  if (child.error || child.signal || !Number.isInteger(child.status)) return 1;
  return child.status;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = runPythonTests();
}
