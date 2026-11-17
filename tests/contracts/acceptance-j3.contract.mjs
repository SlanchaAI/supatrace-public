// Contract for issue #68 (code part). Fixture receipts only: no server, no browser, no network.
// Do not edit: the issue's Proof pins this file's sha256.
//
// Interface the change must provide, in scripts/acceptance-j3.mjs:
//   export function checkImportReceipt(path) -> {name, ok, ...detail}     (never throws)
//   CLI: node scripts/acceptance-j3.mjs <receipt-path>   prints that object as JSON, exits 0 iff ok
// `name` starts with "J3". The receipt is the file issue #67's live check writes:
//   {kind, source:{count}, destination:{count}, relationships_match, teardown}
// ok is true only when ALL hold: kind is "local-disposable-langfuse" or "synthetic-loopback";
// source.count is an integer >= 2 and equals destination.count; relationships_match === true;
// teardown === true. A missing file, bad JSON or any other shape gives ok:false with a string `reason`
// (never "skipped", never ok). scripts/acceptance-local.mjs must import checkImportReceipt and record it
// with step(), reading the path from env SUPATRACE_IMPORT_RECEIPT (default test-artifacts/langfuse-local/receipt.json).
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {checkImportReceipt} from '../../scripts/acceptance-j3.mjs';

const good={kind:'local-disposable-langfuse',source:{count:2},destination:{count:2},relationships_match:true,teardown:true};
const dir=mkdtempSync(join(tmpdir(),'j3-contract-'));
const write=(name,value)=>{const p=join(dir,name);writeFileSync(p,typeof value==='string'?value:JSON.stringify(value));return p;};
test.after(()=>rmSync(dir,{recursive:true,force:true}));

test('a complete receipt passes, for both accepted kinds',()=>{
 for(const kind of ['local-disposable-langfuse','synthetic-loopback']){
  const r=checkImportReceipt(write('good.json',{...good,kind}));
  assert.equal(r.ok,true,JSON.stringify(r));assert.match(r.name,/^J3/);
 }
 const three=checkImportReceipt(write('three.json',{...good,source:{count:3},destination:{count:3}}));
 assert.equal(three.ok,true,JSON.stringify(three));
});

test('each broken field fails with a reason',()=>{
 const bad={
  'counts differ':{...good,destination:{count:1}},
  'fewer than two':{...good,source:{count:1},destination:{count:1}},
  'count not an integer':{...good,source:{count:'2'},destination:{count:'2'}},
  'count fractional':{...good,source:{count:2.5},destination:{count:2.5}},
  'count negative':{...good,source:{count:-2},destination:{count:-2}},
  'counts differ above two':{...good,source:{count:3},destination:{count:2}},
  'destination larger':{...good,source:{count:2},destination:{count:3}},
  'relationships truthy not true':{...good,relationships_match:1},
  'relationships string':{...good,relationships_match:'true'},
  'teardown truthy not true':{...good,teardown:1},
  'teardown string':{...good,teardown:'true'},
  'relationships false':{...good,relationships_match:false},
  'relationships missing':{kind:good.kind,source:good.source,destination:good.destination,teardown:true},
  'teardown false':{...good,teardown:false},
  'teardown missing':{kind:good.kind,source:good.source,destination:good.destination,relationships_match:true},
  'kind unknown':{...good,kind:'hosted'},
  'kind missing':{source:good.source,destination:good.destination,relationships_match:true,teardown:true},
  'no destination':{kind:good.kind,source:good.source,relationships_match:true,teardown:true},
 };
 for(const [label,receipt] of Object.entries(bad)){
  const r=checkImportReceipt(write('bad.json',receipt));
  assert.equal(r.ok,false,label);assert.match(r.name,/^J3/);assert.equal(typeof r.reason,'string',label);
 }
});

test('missing file and malformed JSON fail, never skip, never throw',()=>{
 const odd=['null','"x"','5','{}','{"kind":"local-disposable-langfuse","source":null,"destination":null}','{"kind":"local-disposable-langfuse","source":5,"destination":{"count":2}}'];
 for(const p of [join(dir,'absent.json'),write('junk.json','{not json'),write('empty.json',''),write('array.json','[]'),...odd.map((t,i)=>write('odd'+i+'.json',t))]){
  let r;assert.doesNotThrow(()=>{r=checkImportReceipt(p);});
  assert.equal(r.ok,false);assert.equal(typeof r.reason,'string');assert.equal(r.skipped,undefined);
 }
});

test('the CLI prints the step as JSON and exits 0 only when ok',()=>{
 const run=p=>spawnSync(process.execPath,[fileURLToPath(new URL('../../scripts/acceptance-j3.mjs',import.meta.url)),p],{encoding:'utf8'});
 const ok=run(write('cli-good.json',good));assert.equal(ok.status,0,ok.stderr);assert.equal(JSON.parse(ok.stdout).ok,true);
 const no=run(write('cli-bad.json',{...good,teardown:false}));assert.notEqual(no.status,0);assert.equal(JSON.parse(no.stdout).ok,false);
 const gone=run(join(dir,'nothing.json'));assert.notEqual(gone.status,0);assert.equal(JSON.parse(gone.stdout).ok,false);
});

test('acceptance-local.mjs records the J3 step from the receipt path',()=>{
 const src=readFileSync(new URL('../../scripts/acceptance-local.mjs',import.meta.url),'utf8');
 const code=src.split('\n').filter(l=>!/^\s*(\/\/|\*)/.test(l)).join('\n');
 assert.match(code,/^\s*import\s[^;\n]*checkImportReceipt[^;\n]*from\s+['"]\.\/acceptance-j3\.mjs['"]/m);
 assert.match(code,/checkImportReceipt\s*\(/);
 assert.match(code,/process\.env\.SUPATRACE_IMPORT_RECEIPT/);
 assert.match(code,/test-artifacts\/langfuse-local\/receipt\.json/);
 assert.match(code,/\bstep\s*\(/);
});
