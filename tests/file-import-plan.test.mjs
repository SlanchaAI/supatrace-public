import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {prepareFileImport,formats} from '../public/file-import-plan.js';
import {FILE_FORMATS} from '../src/importers/connector-files.mjs';
import {fixtures,marker} from './connector-fixtures.mjs';
const base={input:'/private/source.json',format:'langsmith',namespace:'source-project',project:'proj_'+'a'.repeat(32),directory:'/private/new-job'};
test('onboarding formats match shipped converter contract',()=>assert.deepEqual([...formats].sort(),[...FILE_FORMATS].sort()));
for(const format of formats)test(format+': generated shell command stages real synthetic input safely with metadata defaults',()=>{
 const dir=mkdtempSync(join(tmpdir(),'file-plan-'));
 try{
  const input=join(dir,"reviewed' $(touch INJECTED).json"),directory=join(dir,"new job' $(touch INJECTED)");writeFileSync(input,JSON.stringify(fixtures[format]()));
  const command=prepareFileImport({...base,input,directory,format});
  const result=JSON.parse(execFileSync('/bin/sh',['-c',command],{cwd:new URL('../',import.meta.url),encoding:'utf8'}));
  assert.equal(result.uploaded,false);assert.equal(result.content,'metadata');assert.equal(result.staged,2);
  const report=readFileSync(join(directory,'converted','report.json'),'utf8');assert.equal(JSON.parse(report).content,'metadata');assert.equal(report.includes(marker),false);
  assert.equal(existsSync(new URL('../INJECTED',import.meta.url)),false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('flags are explicit and invalid scopes cannot prepare commands',()=>{
 assert.equal(prepareFileImport({...base,jsonl:true,content:true}).endsWith("'--jsonl' '--include-content'"),true);
 for(const bad of [{format:'codex'},{project:'proj_wrong'},{input:'./source.json'},{directory:base.input},{input:'/tmp/a\nnode evil'},{namespace:'$(evil)'},{namespace:'a'.repeat(201)},{content:'true'},{jsonl:1}])assert.throws(()=>prepareFileImport({...base,...bad}));
});
