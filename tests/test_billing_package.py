import os, pathlib, tempfile, shutil, subprocess, unittest, zipfile
ROOT=pathlib.Path(__file__).resolve().parents[1]

class BillingPackageTest(unittest.TestCase):
 def runtime_fixture(self, root):
  (root/'aws').mkdir()
  for name in ['aws/package.py','aws/handler.mjs','aws/stripe-worker.mjs','aws/stripe-entitlement-worker.mjs','aws/stripe-usage-meter-worker.mjs','package.json','package-lock.json']:
   shutil.copy2(ROOT/name,root/name)
  shutil.copytree(ROOT/'src',root/'src')
  (root/'public/app').mkdir(parents=True)
  for name in ['span-data.js','model-prices.js']:shutil.copy2(ROOT/'public/app'/name,root/'public/app'/name)

 def package(self, root):
  subprocess.run(['python3',str(root/'aws/package.py')],check=True,capture_output=True,timeout=60)
  return root/'supatrace-lambda.zip'

 def test_worker_and_recursive_source_are_in_real_packager_output(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=pathlib.Path(tmp);self.runtime_fixture(root)
   dep=root/'node_modules/@aws-sdk/client-s3';dep.mkdir(parents=True);(dep/'package.json').write_text('{}')
   with zipfile.ZipFile(self.package(root)) as archive:
    expected={path.relative_to(ROOT).as_posix():path for path in (ROOT/'src').rglob('*.mjs') if path.is_file()}
    packaged={name for name in archive.namelist() if name.startswith('src/') and name.endswith('.mjs')}
    self.assertEqual(packaged,set(expected),'all nested runtime modules must be packaged')
    for name,path in expected.items():self.assertEqual(archive.read(name),path.read_bytes(),name)
    for name in ['public/app/span-data.js','public/app/model-prices.js']:
     self.assertEqual(archive.read(name),(ROOT/name).read_bytes())
    for name in ['aws/handler.mjs','aws/stripe-worker.mjs','aws/stripe-entitlement-worker.mjs','aws/stripe-usage-meter-worker.mjs']:
     self.assertEqual(archive.read(name),(ROOT/name).read_bytes())
    for name in ['LICENSE','provenance.json','source-pins.json']:
     path='src/importers/vendor/hue/'+name
     self.assertEqual(archive.read(path),(ROOT/path).read_bytes(),'vendored license and provenance must travel with code')
    for name in ['LICENSE','provenance.json','langsmith-provenance.json']:
     path='src/importers/vendor/kitaru/'+name
     self.assertEqual(archive.read(path),(ROOT/path).read_bytes(),'Apache license and modification notice must travel with code')

 def test_extracted_lambda_entries_load_with_only_packaged_dependencies(self):
  # This checks the deployment artifact, not imports from the source checkout.
  # CI runs npm ci first. Missing real dependencies must fail, never skip.
  self.assertTrue((ROOT/'node_modules/@aws-sdk/client-s3/package.json').is_file(),'Run npm ci before the package smoke test')
  with tempfile.TemporaryDirectory() as tmp:
   root=pathlib.Path(tmp)/'build';root.mkdir();self.runtime_fixture(root)
   shutil.copytree(ROOT/'node_modules',root/'node_modules')
   extracted=pathlib.Path(tmp)/'isolated';extracted.mkdir()
   with zipfile.ZipFile(self.package(root)) as archive:archive.extractall(extracted)
   script="""
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import {syncBuiltinESMExports} from 'node:module';
const deny=()=>{throw new Error('Package import must not make network calls');};
http.request=http.get=https.request=https.get=net.connect=net.createConnection=tls.connect=deny;
globalThis.fetch=deny;syncBuiltinESMExports();
for(const path of ['./aws/handler.mjs','./aws/stripe-worker.mjs','./aws/stripe-entitlement-worker.mjs','./aws/stripe-usage-meter-worker.mjs']){
 const entry=await import(path);assert.equal(typeof entry.handler,'function',path);
}
const {handler}=await import('./aws/stripe-entitlement-worker.mjs');
await assert.rejects(handler({}),/stripe_entitlement_worker_disabled/);
console.log('PACKAGED_ENTRIES_LOAD_OK');
"""
   # Do not inherit cloud credentials, config, or Node module-resolution hooks.
   env={'PATH':os.environ.get('PATH',''),'HOME':str(extracted),'AWS_EC2_METADATA_DISABLED':'true'}
   result=subprocess.run(['node','--input-type=module','--eval',script],cwd=extracted,env=env,capture_output=True,text=True,timeout=30)
   self.assertEqual(result.returncode,0,result.stdout+result.stderr)
   self.assertIn('PACKAGED_ENTRIES_LOAD_OK',result.stdout)
