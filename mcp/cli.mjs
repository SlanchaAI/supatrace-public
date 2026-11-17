import {openSync, fstatSync, readSync, closeSync, constants, createReadStream} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {validateScope} from './reader.mjs';
import {startStdio} from './server.mjs';

export function readSpec(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 2 || stat.size > 16384) throw Error('invalid_spec');
    const buffer = Buffer.alloc(16385), size = readSync(fd, buffer, 0, buffer.length, 0);
    if (size > 16384) throw Error('invalid_spec');
    const raw = buffer.subarray(0, size);
    return validateScope(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(raw)));
  } finally {closeSync(fd);}
}
export async function readLease(fd = 3, timeoutMs = 30000) {
  const stat = fstatSync(fd);
  if (!stat.isFIFO() && !stat.isSocket()) throw Error('lease_pipe_required');
  const stream = createReadStream(null, {fd, autoClose: true, highWaterMark: 4096});
  return new Promise((resolve, reject) => {
    let bytes = 0, chunks = [];
    const timer = setTimeout(() => stream.destroy(Error('lease_timeout')), timeoutMs);
    stream.on('data', chunk => {bytes += chunk.length; if (bytes > 4096) stream.destroy(Error('lease_too_large')); else chunks.push(chunk);});
    stream.on('error', () => {clearTimeout(timer); chunks = []; reject(Error('lease_unavailable'));});
    stream.on('end', () => {
      clearTimeout(timer);
      try {resolve(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks))));}
      catch {reject(Error('lease_unavailable'));} finally {chunks = [];}
    });
  });
}
export async function main(argv = process.argv.slice(2)) {
  if (argv.length < 2 || argv.length > 3 || argv[1] !== '--serve' || argv.length === 3 && argv[2] !== '--include-content') throw Error('usage');
  const scope = readSpec(argv[0]);
  if ((scope.content === 'include') !== argv.includes('--include-content')) throw Error('content_scope');
  const lease = await readLease();
  if (!Number.isSafeInteger(lease?.expiresAt) || lease.expiresAt <= Date.now() || lease.expiresAt > Date.now() + 300000) throw Error('lease_unavailable');
  const handle = startStdio(scope, {credentialProvider: async () => lease, authorize: async () => true});
  const stop = async () => {clearTimeout(expiry); process.off('SIGINT', stop); process.off('SIGTERM', stop); await handle.close();};
  const expiry = setTimeout(stop, Math.max(1, lease.expiresAt - Date.now())); expiry.unref();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  return handle;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => {
  process.stderr.write('SupaTrace MCP stopped. Check the non-secret scope, explicit serve/content flags and approved short-lived credential pipe on fd 3. No credential was printed.\n');
  process.exitCode = 1;
});
