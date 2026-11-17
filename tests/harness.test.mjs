import test from 'node:test';
import './browser-probe.test.mjs';
import assert from 'node:assert/strict';
import {start} from './harness.mjs';

test('browser fixtures seed beyond 800 runs without rate-slot collisions', async () => {
  const live = await start();
  try {
    const tenant = await live.signIn({async addCookies() {}});
    const ids = await live.seedRuns(tenant, 801);
    assert.equal(ids.length, 801);
    assert.equal(new Set(ids).size, 801);
    // Two distinct buckets must not make this UI fixture nondeterministic.
    for (let i = 0; i < 1000; i++) {
      const result = await live.store.consumeRate({scope: 'request', identity: `fixture-${i}`, limit: 1, windowSeconds: 60});
      assert.equal(result.allowed, true);
    }
  } finally { await live.close(); }
});
