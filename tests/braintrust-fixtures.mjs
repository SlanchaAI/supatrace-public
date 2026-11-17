import assert from 'node:assert/strict';
import {BRAINTRUST_TRANSPORT_BOUNDS} from '../src/importers/braintrust-transport.mjs';
export const sourceProject = '12345678-1234-1234-1234-123456789abc';
export const spec = {origin: 'https://api.braintrust.dev', sourceProject, destinationProject: 'proj_' + '1'.repeat(32), namespace: 'braintrust-test', rootSpanIds: ['root'], pageSize: 2};
export const key = 'bt-synthetic-secret-never-live';
export const marker = 'PRIVATE_PROMPT_MUST_NOT_PERSIST';
export function row(span = 'root', extra = {}) { return {id: 'row-' + span, project_id: sourceProject, root_span_id: 'root', span_id: span, span_parents: span === 'root' ? [] : ['root'], created: '2026-11-04T00:00:00Z', metrics: {start: 1793750400, end: 1793750401, prompt_tokens: 2}, span_attributes: {type: 'llm', name: marker}, input: marker, output: marker, metadata: {prompt: marker}, ...extra}; }
export function json(data, headers = {}) { return new Response(JSON.stringify(data), {headers: {'content-type': 'application/json', ...headers}}); }
export function fakeOptions(pages, extra = {}) {
  const requests = [], permissions = [];
  let index = 0;
  return {requests, permissions, options: {
    bounds: {...BRAINTRUST_TRANSPORT_BOUNDS}, credentialProvider: async () => ({origin: spec.origin, projectId: sourceProject, apiKey: key, expiresAt: Date.now() + 60000}),
    authorize: async action => { permissions.push(action); return true; },
    fetchImpl: async (url, init) => {
      requests.push({url, init});
      assert.equal(init.headers.Authorization, 'Bearer ' + key); assert.equal(init.redirect, 'error');
      if (url.endsWith('/v1/project/' + sourceProject)) return json({id: sourceProject});
      const page = pages[index++];
      if (page instanceof Error) throw page;
      if (typeof page === 'function') return page(url, init);
      return json(page.data ?? page, page.headers);
    }, ...extra,
  }};
}
