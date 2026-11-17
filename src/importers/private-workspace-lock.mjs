import {openSync,closeSync,writeFileSync,fsyncSync,fstatSync,lstatSync,unlinkSync,constants} from 'node:fs';
import {join} from 'node:path';

export const WORKSPACE_LOCK = '.live-import.lock';
const fail = code => { throw new Error(code); };

// Shared file protocol with private_upload_runtime.py. No expiry or automatic takeover.
export function acquireWorkspaceLock(directory, phase = 'capture-stage') {
  if (!['capture-stage', 'upload'].includes(phase)) fail('private_runtime_lock_phase_invalid');
  const parentIdentity = lstatSync(directory);
  if (!parentIdentity.isDirectory() || parentIdentity.uid !== process.getuid() ||
      parentIdentity.mode & 0o077) fail('private_runtime_lock_directory_unsafe');
  const path = join(directory, WORKSPACE_LOCK);
  let fd;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
      constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') fail('private_runtime_workspace_locked_reconciliation_required');
    fail('private_runtime_lock_unavailable');
  }
  const identity = fstatSync(fd);
  let released = false;
  function release() {
    if (released) return;
    try {
      const current = lstatSync(path);
      if (!current.isFile() || current.nlink !== 1 || current.dev !== identity.dev ||
          current.ino !== identity.ino || current.uid !== process.getuid() || current.mode & 0o077) {
        fail('private_runtime_lock_reconciliation_required');
      }
      unlinkSync(path);
      const parent = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(parent); } finally { closeSync(parent); }
    } finally {
      closeSync(fd);
      released = true;
    }
  }
  try {
    writeFileSync(fd, JSON.stringify({version:1,pid:process.pid,phase}));
    fsyncSync(fd);
    const parent = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } catch {
    try { release(); } catch { /* Leave any unmatched lock for explicit reconciliation. */ }
    fail('private_runtime_lock_unavailable');
  }
  return Object.freeze({release});
}
