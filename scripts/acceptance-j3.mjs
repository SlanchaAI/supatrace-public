// J3 receipt gate for issue #68. Fixture-backed: reads an import receipt file, no server, no browser,
// no network. See tests/contracts/acceptance-j3.contract.mjs for the pinned interface.
import {readFileSync, realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const KINDS=['local-disposable-langfuse','synthetic-loopback'];
const isNatural=n=>typeof n==='number'&&Number.isInteger(n)&&n>=2;
export function checkImportReceipt(path){
 const name='J3 import receipt',read=(p)=>{try{return readFileSync(p,'utf8');}catch{return null;}};
 if(typeof path!=='string'||path==='')return {name,ok:false,reason:'receipt path must be a non-empty string: '+String(path)};
 const raw=read(path);
 if(raw===null)return {name,ok:false,reason:'receipt file not readable: '+String(path)};
 let receipt;try{receipt=JSON.parse(raw);}catch(error){return {name,ok:false,reason:'receipt is not valid JSON: '+String(error&&error.message||error)};}
 if(receipt===null||typeof receipt!=='object'||Array.isArray(receipt))return {name,ok:false,reason:'receipt must be a JSON object'};
 if(!KINDS.includes(receipt.kind))return {name,ok:false,reason:'receipt kind must be one of '+KINDS.join(' or ')+', got '+JSON.stringify(receipt.kind)};
 const {source,destination}=receipt;
 if(source===null||typeof source!=='object'||Array.isArray(source)||!isNatural(source.count))return {name,ok:false,reason:'source.count must be an integer of at least 2'};
 if(destination===null||typeof destination!=='object'||Array.isArray(destination)||!isNatural(destination.count))return {name,ok:false,reason:'destination.count must be an integer of at least 2'};
 if(source.count!==destination.count)return {name,ok:false,reason:'source.count '+source.count+' does not equal destination.count '+destination.count};
 if(receipt.relationships_match!==true)return {name,ok:false,reason:'relationships_match must be exactly true'};
 if(receipt.teardown!==true)return {name,ok:false,reason:'teardown must be exactly true'};
 return {name,ok:true,kind:receipt.kind,events:source.count,path:String(path)};
}
const sameFile=(a,b)=>{try{return realpathSync(a)===realpathSync(b);}catch{return false;}};
if(process.argv[1]&&sameFile(fileURLToPath(import.meta.url),process.argv[1])){
 const result=checkImportReceipt(process.argv[2]);process.stdout.write(JSON.stringify(result)+'\n');
 if(!result.ok)process.exitCode=1;
}
