import test from 'node:test';import assert from 'node:assert/strict';import {boundedText,requireOrigin} from '../src/http.mjs';
const req=(body,headers={})=>new Request('https://example.invalid',{method:'POST',body,headers:{'content-type':'application/json',...headers}});
test('bounds real bytes despite false Content-Length',async()=>{await assert.rejects(boundedText(req('12345',{'content-length':'1'}),4),/batch_too_large/);});
test('rejects compressed payload',async()=>{await assert.rejects(boundedText(req('{}',{'content-encoding':'gzip'})),/compressed/);});
test('reads valid JSON bytes',async()=>assert.equal(await boundedText(req('{}')),'{}'));
test('cookie mutation requires exact origin',()=>{assert.throws(()=>requireOrigin(req('{}',{'origin':'https://evil.invalid'}),'https://supatrace.dev'),/origin/);});
