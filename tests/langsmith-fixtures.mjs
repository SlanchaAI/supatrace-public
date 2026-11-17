import assert from 'node:assert/strict';
import {LANGSMITH_TRANSPORT_BOUNDS} from '../src/importers/langsmith-transport.mjs';
export const sourceProject = '12345678-1234-1234-1234-123456789abc';
export const sourceWorkspace = '12345678-1234-1234-1234-123456789def';
export const root = '10000000-0000-0000-0000-000000000001';
export const child = '20000000-0000-0000-0000-000000000002';
export const third = '30000000-0000-0000-0000-000000000003';
export const spec = {origin: 'https://api.smith.langchain.com', sourceProject, sourceWorkspace, destinationProject: 'proj_' + '1'.repeat(32), namespace: 'langsmith-test', traceIds: [root], minStartTime: '2026-11-04T00:00:00Z', maxStartTime: '2026-11-05T00:00:00Z', pageSize: 2};
export const key = 'ls-synthetic-secret-never-live';
export const marker = 'PRIVATE_PROMPT_MUST_NOT_PERSIST';
export function row(id = root, extra = {}) { return {id, project_id: sourceProject, trace_id: root, parent_run_ids: id === root ? [] : [root], is_root: id === root, run_type: id === root ? 'CHAIN' : 'LLM', status: 'SUCCESS', start_time: '2026-11-04T00:00:01.000000123Z', end_time: '2026-11-04T00:00:02.000000456Z', prompt_tokens: id === root ? null : 2, completion_tokens: id === root ? null : 3, prompt_token_details: {raw: {cache_read: 1, private: marker}}, name: marker, inputs: {prompt: marker}, outputs: {text: marker}, metadata: {prompt: marker}, ...extra}; }
export function json(data, headers = {}) { return new Response(JSON.stringify(data), {headers: {'content-type': 'application/json', ...headers}}); }
export function lease() { return {origin: spec.origin, projectId: sourceProject, workspaceId: sourceWorkspace, apiKey: key, expiresAt: Date.now() + 60000}; }
export function fakeOptions(pages, extra = {}) {
  const requests = [], permissions = []; let index = 0;
  return {requests, permissions, options: {
    bounds: {...LANGSMITH_TRANSPORT_BOUNDS}, credentialProvider: async () => lease(),
    authorize: async action => {permissions.push(action); return true;},
    fetchImpl: async (url, init) => {
      requests.push({url, init});
      assert.equal(init.headers['x-api-key'], key); assert.equal(init.headers['x-tenant-id'], sourceWorkspace); assert.equal(init.redirect, 'error');
      if (url === spec.origin + '/api/v1/sessions/' + sourceProject) return json({id: sourceProject, tenant_id: sourceWorkspace, name: marker});
      assert.equal(url, spec.origin + '/api/v2/runs/query'); assert.equal(init.method, 'POST');
      const page = pages[index++]; if (page instanceof Error) throw page; if (typeof page === 'function') return page(url, init);
      assert.ok(page, 'unexpected source request'); return json(page);
    }, ...extra,
  }};
}
