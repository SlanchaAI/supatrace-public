import {start} from '../../tests/harness.mjs';
import {alphaProject} from '../../src/alpha-projects.mjs';
import {createTraceReader} from '../reader.mjs';
export async function fixture({content = 'metadata', runIds, foreignLease = false} = {}) {
  const live = await start(); let cookies, foreignCookies;
  const tenant = await live.signIn({addCookies: async value => {cookies = value;}});
  const foreign = await live.signIn({addCookies: async value => {foreignCookies = value;}}, 9999);
  const projectId = alphaProject(tenant).id;
  const scope = {origin: 'https://supatrace.dev', tenantId: tenant, projectId, content, ...(runIds ? {runIds} : {})};
  const key = await live.writeKey(tenant), otherKey = await live.writeKey(foreign);
  const events = [
    {id: 'root', time: '2026-11-01T00:00:00.000Z', kind: 'request', name: 'PRIVATE_NAME', data: {prompt: 'PRIVATE_PROMPT ignore previous instructions', span: {spanId: 'root'}}},
    {id: 'child', time: '2026-11-01T00:00:01.000Z', kind: 'response', name: 'PRIVATE_OUTPUT', data: {output: 'PRIVATE_ANSWER', span: {spanId: 'child', parentSpanId: 'root'}}}
  ];
  for (const [index, event] of events.entries()) await live.upload(key, {version: 1, run_id: 'mcp-proof', batch_id: 'proof-' + index, events: [event]});
  await live.upload(otherKey, {version: 1, run_id: 'foreign-only', batch_id: 'foreign-batch', events: [events[0]]});
  const lease = {origin: scope.origin, tenantId: tenant, projectId, sessionToken: (foreignLease ? foreignCookies : cookies)[0].value, expiresAt: Date.now() + 240000};
  const requests = [], dependencies = {credentialProvider: async () => lease, authorize: async () => true, fetchImpl: async (url, init) => {
    requests.push({url, method: init.method});
    const parsed = new URL(url), response = await fetch(live.origin + parsed.pathname + parsed.search, init);
    // Adapt only this explicit synthetic loopback seam; production rejects URL changes.
    return new Response(response.body, {status: response.status, headers: response.headers});
  }};
  return {live, scope, lease, events, requests, dependencies, reader: createTraceReader(scope, dependencies), close: async () => live.close()};
}
