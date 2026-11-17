# Self-hosting for local evaluation

The [README](../README.md#run-locally) starts a loopback server with real API handlers, in-memory storage, and three synthetic accounts. No AWS, OAuth, payment, or model-provider credentials are needed. It is a development setup: data resets on exit. Keep it on loopback.

A durable service needs storage, identity-provider configuration, and deployment work. See [architecture](architecture.md), [configuration](configuration.md), and [AWS deployment](../aws/DEPLOYMENT.md). The hosted deployment workflow protects an existing installation; it is not an installer for another AWS account.

## Send and read one trace

Start the server with the README commands. In a second terminal, run this from the repository directory with Node.js 22+. It signs in as the synthetic Team admin account in its personal workspace, creates a local secret key with scoped read and ingest access, sends one OTLP/HTTP JSON trace, and reads it through the authenticated API. It contacts loopback only. Keys and cookies stay in process memory.

```sh
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import {randomBytes, createHash} from 'node:crypto';
const origin = 'http://127.0.0.1:3000';
const health = await fetch(`${origin}/api/public/health`);
assert.equal(health.status, 200);
const login = await fetch(`${origin}/__local__/signin?account=5252`, {redirect: 'manual'});
assert.equal(login.status, 303);
const cookie = login.headers.get('set-cookie').split(';')[0];
const key = 'st_sec_' + randomBytes(32).toString('base64url');
const created = await fetch(`${origin}/api/keys/create`, {
  method: 'POST', headers: {cookie, origin, 'content-type': 'application/json'},
  body: JSON.stringify({key_hash: createHash('sha256').update(key).digest('hex'), key_type: 'secret'})
});
assert.equal(created.status, 201);
const traceId = randomBytes(16).toString('hex');
const now = BigInt(Date.now()) * 1000000n;
const payload = {resourceSpans: [{
  resource: {attributes: [{key: 'service.name', value: {stringValue: 'synthetic-local-example'}}]},
  scopeSpans: [{scope: {name: 'self-host-check'}, spans: [{
    traceId, spanId: randomBytes(8).toString('hex'), name: 'synthetic first trace',
    startTimeUnixNano: String(now), endTimeUnixNano: String(now + 1000000n)
  }]}]
}]};
const ingested = await fetch(`${origin}/v1/traces`, {
  method: 'POST', headers: {'content-type': 'application/json', 'x-supatrace-key': key},
  body: JSON.stringify(payload)
});
assert.equal(ingested.status, 200);
const read = await fetch(`${origin}/api/events?run=${encodeURIComponent('otlp.' + traceId)}`, {headers: {cookie}});
assert.equal(read.status, 200);
const result = await read.json();
assert.equal(result.events.length, 1);
console.log('health 200; synthetic sign-in 303; key creation 201; OTLP ingest 200; readback 200; events 1');
JS
```

An assertion failure exits nonzero. Success prints the status line above. To inspect through the dashboard, open `/__local__/`, choose **Team admin account**, keep its personal workspace selected, and refresh Traces. The synthetic run is named `otlp.<traceid>`. Restart the server for a clean seed before repeating this example; the Free key allowance is bounded.

The **Owner account** has seeded team runs and starts above the Free key allowance. Use Team admin's personal workspace for a new ingest key. This is a demo seed limitation; changing it is separate from these instructions.
