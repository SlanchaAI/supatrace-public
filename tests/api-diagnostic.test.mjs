import test from 'node:test';
import assert from 'node:assert/strict';
import {apiDiagnostic} from '../src/api-diagnostic.mjs';
import {handle} from '../src/aws-api.mjs';
import {handler} from '../aws/handler.mjs';

test('unexpected API failures retain the 503 contract and report safe SDK categories',async()=>{
 const entries=[],privateValue='private-key-cookie-body';
 const error=Object.assign(new Error(privateValue),{name:'TransactionCanceledException',$metadata:{httpStatusCode:400,requestId:privateValue},CancellationReasons:[{Code:'TransactionConflict',Message:privateValue},{Code:privateValue}]});
 const response=await handle(new Request('https://supatrace.dev/api/public/health?secret='+privateValue),{ENABLED:true,APP_ORIGIN:'https://supatrace.dev',GITHUB_CLIENT_ID:'synthetic',GITHUB_CLIENT_SECRET:'synthetic',objects:{},store:{consumeRate:async()=>{throw error;}},apiDiagnostic:entry=>entries.push(entry)});
 assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'temporarily_unavailable'});
 assert.deepEqual(entries,[{event:'api_unexpected_error',phase:'api',error:'TransactionCanceledException',sdk_status:400,cancellation_codes:['TransactionConflict','Unknown']}]);
 assert.equal(JSON.stringify(entries).includes(privateValue),false);
});

test('arbitrary names, malformed SDK metadata and failing diagnostics cannot escape',()=>{
 const entries=[];
 apiDiagnostic({name:'secret',$metadata:{httpStatusCode:'secret'},CancellationReasons:'secret'},'secret',entry=>entries.push(entry));
 assert.deepEqual(entries,[{event:'api_unexpected_error',phase:'api',error:'Error',sdk_status:0,cancellation_codes:[]}]);
 assert.doesNotThrow(()=>apiDiagnostic(new Error('secret'),'api',()=>{throw Error('secret');}));
 assert.doesNotThrow(()=>apiDiagnostic(null,'api'));
});

test('Lambda adapter failures report once without leaking request values',async()=>{
 const entries=[],original=console.error,enabled=process.env.SUPATRACE_ENABLED;
 process.env.SUPATRACE_ENABLED='false';console.error=value=>entries.push(JSON.parse(value));
 try{
  const response=await handler({rawPath:'/private-key-cookie-body',requestContext:{http:{method:'INVALID METHOD'}},headers:{host:'supatrace.dev',cookie:'private-key-cookie-body'}});
  assert.equal(response.statusCode,503);
  assert.equal(response.body,'{"error":"temporarily_unavailable"}');
  assert.deepEqual(entries,[{event:'api_unexpected_error',phase:'handler',error:'TypeError',sdk_status:0,cancellation_codes:[]}]);
 }finally{console.error=original;if(enabled===undefined)delete process.env.SUPATRACE_ENABLED;else process.env.SUPATRACE_ENABLED=enabled;}
});
