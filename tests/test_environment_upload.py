"""Synthetic transport proofs for destination environments; no network access."""
import io,json,pathlib,sys,tempfile,unittest,urllib.parse
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'agent'))
import upload
class Response(io.BytesIO):
 status=201
 def __enter__(self):return self
 def __exit__(self,*args):self.close()
class Environments(unittest.TestCase):
 def test_scope_receipt_required_before_pending_cleanup(self):
  with tempfile.TemporaryDirectory() as directory:
   path=pathlib.Path(directory)/'pending.json';body=b'{"version":1,"batch_id":"batch","run_id":"run","events":[]}'
   project='proj_'+'a'*32
   for actual in [None,'production','development']:
    path.write_bytes(body);calls=[]
    def transport(request,timeout):
     calls.append(request);ack={'accepted':True,'batch_id':'batch','request_hash':upload.hashlib.sha256(body).hexdigest(),'project_id':project}
     if actual is not None:ack['environment_id']=actual
     return Response(json.dumps(ack).encode())
    outcome=upload.upload_pending_result(path,'https://supatrace.dev/api/batches','synthetic-token',transport,expected_project=project,expected_environment='development')
    self.assertEqual(outcome['accepted'],actual=='development');self.assertEqual(path.exists(),actual!='development')
    self.assertEqual(urllib.parse.parse_qs(urllib.parse.urlsplit(calls[0].full_url).query),{'project':[project],'environment':['development']})
 def test_conflicting_environment_stops_before_transport(self):
  with tempfile.TemporaryDirectory() as directory:
   path=pathlib.Path(directory)/'pending.json';path.write_text('{}')
   with self.assertRaisesRegex(ValueError,'Conflicting environment'):
    upload.upload_pending_result(path,'https://supatrace.dev/api/batches?environment=production','synthetic',lambda *_:self.fail('No network'),expected_environment='development')
   self.assertTrue(path.exists())
if __name__=='__main__':unittest.main()
