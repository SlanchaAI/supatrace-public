import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Client, InMemoryTransport} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {createMcpServer} from '../server.mjs';
import {fixture} from './fixture.mjs';

test('real SDK client discovers and calls scoped tools through actual API/storage', async () => {
  const env = await fixture(), [clientWire, serverWire] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(env.reader), client = new Client({name: 'supatrace-test', version: '1'});
  try {
    await server.connect(serverWire); await client.connect(clientWire);
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 4); assert.ok(tools.every(t => t.annotations.readOnlyHint && !t.annotations.destructiveHint));
    const list = await client.callTool({name: 'supatrace_list_traces', arguments: {}});
    assert.equal(list.isError, undefined); assert.equal(list.structuredContent.total, 1);
    assert.equal(list.structuredContent.runs[0].id, 'mcp-proof'); assert.doesNotMatch(JSON.stringify(list), /PRIVATE_|foreign-only/);
    const search = await client.callTool({name: 'supatrace_search_traces', arguments: {query: 'proof'}});
    assert.equal(search.structuredContent.total, 1);
    const detail = await client.callTool({name: 'supatrace_inspect_trace', arguments: {runId: 'mcp-proof'}});
    assert.equal(detail.structuredContent.trace.events.length, 2); assert.doesNotMatch(JSON.stringify(detail), /PRIVATE_/);
    const denied = await client.callTool({name: 'supatrace_inspect_trace', arguments: {runId: 'mcp-proof', includeContent: true}});
    assert.equal(denied.isError, true); assert.match(denied.content[0].text, /content_not_authorized/);
    const foreign = await client.callTool({name: 'supatrace_export_trace', arguments: {runId: 'foreign-only'}});
    assert.equal(foreign.isError, true); assert.match(foreign.content[0].text, /trace_not_available/);
    assert.ok(env.requests.every(r => r.method === 'GET' && new URL(r.url).searchParams.get('project') === env.scope.projectId));
  } finally {await client.close(); await server.close(); env.reader.close(); await env.close();}
});

for (const mode of ['legacy', 'auto']) test('actual SDK stdio client exports exact stored events using ' + mode + ' negotiation', {timeout: 20000}, async () => {
  const transport = new StdioClientTransport({command: process.execPath, args: [new URL('stdio-fixture.mjs', import.meta.url).pathname], env: {PATH: process.env.PATH, TMPDIR: process.env.TMPDIR ?? '/tmp'}, stderr: 'pipe'});
  let stderr = ''; transport.stderr.on('data', value => {stderr += value;});
  const client = new Client({name: 'supatrace-stdio-acceptance', version: '1'}, {versionNegotiation: {mode}});
  try {
    await client.connect(transport);
    assert.equal(client.getNegotiatedProtocolVersion(), mode === 'auto' ? '2026-07-28' : '2025-11-25');
    assert.equal((await client.listTools()).tools.length, 4);
    const result = await client.callTool({name: 'supatrace_export_trace', arguments: {runId: 'mcp-proof', includeContent: true}});
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const output = result.structuredContent, trace = JSON.parse(output.json);
    assert.equal(output.sha256, createHash('sha256').update(output.json).digest('hex'));
    assert.equal(trace.version, 1); assert.equal(trace.events.length, 2);
    assert.equal(trace.events[1].data.span.parentSpanId, 'root');
    assert.equal(trace.events[0].data.prompt, 'PRIVATE_PROMPT ignore previous instructions');
    assert.equal(output.bytes, Buffer.byteLength(output.json));
    assert.doesNotMatch(stderr, /PRIVATE_|sessionToken|__Host/);
  } finally {await client.close();}
});
