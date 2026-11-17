// Deterministic synthetic tokens, confined to the invoking Node test process.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import {digest} from '../src/aws-auth.mjs';
export const token = bytes => bytes.toString('base64url');
export const slot = bytes => Number(BigInt('0x' + digest(token(bytes))) % 1000n);
export const first = Buffer.alloc(32, 1), collisions = [], free = [];
for (let i = 0; collisions.length < 3 || free.length < 2; i++) {
  const bytes = crypto.createHash('sha256').update('session-regression-' + i).digest();
  if (slot(bytes) === slot(first) && collisions.length < 3) collisions.push(bytes);
  if (slot(bytes) !== slot(first) && free.length < 2 && !free.some(value => slot(value) === slot(bytes))) free.push(bytes);
  assert.ok(i < 100000, 'bounded fixture search');
}
export async function withSessionTokens(tokens, run) {
  const original = crypto.randomBytes; let used = 0;
  crypto.randomBytes = (size, ...args) => {
    if (size !== 32) return original(size, ...args);
    assert.ok(used < tokens.length, 'unexpected extra session token');
    return Buffer.from(tokens[used++]);
  };
  syncBuiltinESMExports();
  try { const result = await run(); assert.equal(used, tokens.length, 'expected token attempts'); return result; }
  finally { crypto.randomBytes = original; syncBuiltinESMExports(); }
}
