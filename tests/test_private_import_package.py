import contextlib,importlib.util,io,json,pathlib,sys,tempfile,unittest,zipfile
from unittest import mock
ROOT=pathlib.Path(__file__).resolve().parents[1]
class PrivatePackageTest(unittest.TestCase):
 def test_source_edit_after_git_comparison_cannot_enter_a_pinned_revision(self):
  spec=importlib.util.spec_from_file_location('private_package',ROOT/'scripts/package-private-import.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
  with tempfile.TemporaryDirectory() as temp:
   root=pathlib.Path(temp).resolve();revision='a'*40
   files={'src/worker.mjs':b'// approved source\n','package.json':b'{"type":"module"}','package-lock.json':b'{"packages":{}}'}
   for name in ['scripts/hosted_upload_worker.py','scripts/package-private-import.py','scripts/private-host-synthetic.mjs','tests/memory-dynamo.mjs','agent/private_upload_runtime.py','agent/upload.py','agent/stage_import.py']:files[name]=b'# synthetic approved source\n'
   for name,body in files.items():path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(body)
   def git(args,**kwargs):
    if 'rev-parse' in args:return revision+'\n'
    if 'ls-tree' in args:return 'src/worker.mjs\n'
    name=args[-1].split(':',1)[1]
    if name=='src/worker.mjs':(root/name).write_bytes(b'// changed after approval\n')
    return files[name]
   output=root/'host.zip'
   with mock.patch.object(module,'ROOT',root),mock.patch.object(module.subprocess,'check_output',side_effect=git),mock.patch.object(sys,'argv',['package','--output',str(output)]),contextlib.redirect_stdout(io.StringIO()):module.main()
   with zipfile.ZipFile(output) as archive:
    self.assertEqual(archive.read('src/worker.mjs'),files['src/worker.mjs'])
    manifest=json.loads(archive.read('private-host-manifest.json'));self.assertEqual(manifest['source_revision'],revision)
   self.assertNotEqual((root/'src/worker.mjs').read_bytes(),files['src/worker.mjs'])
