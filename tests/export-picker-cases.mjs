import test from 'node:test';
import assert from 'node:assert/strict';
import {pickExportFile} from '../public/app/export-picker.js';

for(const elapsed of [0,1,749,749.999,750,751,5000]){
 for(const name of ['AbortError','SecurityError','NotAllowedError'])test(`picker ${name} after ${elapsed} ms`,async()=>{
  let time=12345,picks=0;
  const options={suggestedName:'synthetic.json'},cancelled=name==='AbortError'&&elapsed>=750;
  await assert.rejects(pickExportFile(given=>{
   picks++;assert.equal(given,options);time+=elapsed;
   throw Object.assign(Error('synthetic private browser detail'),{name});
  },options,()=>time),error=>{
   assert.equal(error.message,cancelled?'export_file_cancelled':'export_picker_unavailable');
   assert.equal(error.pickerCancelled,cancelled?true:undefined);return true;
  });
  assert.equal(picks,1);
 });
}
test('picker retains synchronous gesture dispatch and returns a selected handle regardless of elapsed time',async()=>{
 let time=0,picks=0;const handle={};
 const result=pickExportFile(()=>{picks++;time=10000;return Promise.resolve(handle);},{},()=>time);
 assert.equal(picks,1);assert.equal(await result,handle);
});
for(const elapsed of [749,750])test(`picker measures until asynchronous rejection at ${elapsed} ms`,async()=>{
 let time=100,reads=0,reject;
 const pending=pickExportFile(()=>new Promise((_,no)=>reject=no),{},()=>{reads++;return time;});
 assert.equal(reads,1);time+=elapsed;reject(Object.assign(Error(),{name:'AbortError'}));
 await assert.rejects(pending,{message:elapsed<750?'export_picker_unavailable':'export_file_cancelled'});
 assert.equal(reads,2);
});
