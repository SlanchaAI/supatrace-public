import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {createHash} from 'node:crypto';
test('actual consent launcher negotiates stdio and retrieves stored content with official client',{timeout:20000},async()=>{
 const transport=new StdioClientTransport({command:process.execPath,args:[new URL('bridge-stdio-fixture.mjs',import.meta.url).pathname],env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR??'/tmp'},stderr:'pipe'});
 let stderr='',resolveReady;const ready=new Promise(r=>resolveReady=r);transport.stderr.on('data',c=>{stderr+=c;if(stderr.includes('BRIDGE_READY'))resolveReady();});
 const client=new Client({name:'bridge-stdio-test',version:'1'});
 try{
  await client.connect(transport);assert.equal((await client.listTools()).tools.length,4);await ready;
  const list=await client.callTool({name:'supatrace_list_traces',arguments:{}});assert.equal(list.isError,undefined);assert.equal(list.structuredContent.total,1);
  const inspect=await client.callTool({name:'supatrace_inspect_trace',arguments:{runId:'bridge-proof'}});assert.equal(inspect.structuredContent.trace.events.length,1);assert.doesNotMatch(JSON.stringify(inspect),/source-root/);
  const result=await client.callTool({name:'supatrace_export_trace',arguments:{runId:'bridge-proof',includeContent:true}});assert.equal(result.isError,undefined);
  assert.equal(result.structuredContent.sha256,createHash('sha256').update(result.structuredContent.json).digest('hex'));assert.equal(JSON.parse(result.structuredContent.json).events[0].data.parent,'source-root');
  assert.doesNotMatch(stderr,/readToken|sessionToken|__Host-|source-root/);
 }finally{await client.close();}
});
