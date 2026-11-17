import importlib.util, pathlib, tempfile, unittest, json, hashlib
s=importlib.util.spec_from_file_location('u',pathlib.Path(__file__).parents[1]/'agent/upload.py');u=importlib.util.module_from_spec(s);s.loader.exec_module(u)
class Response:
 status=201
 def __init__(self,data):self.data=data
 def read(self,n):return json.dumps(self.data).encode()[:n]
 def __enter__(self):return self
 def __exit__(self,*a):pass
class Upload(unittest.TestCase):
 def setUp(self):
  self.t=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.t.name);self.source=self.root/'source';self.source.write_text('{"batch_id":"b","events":[]}');self.p=u.stage(self.source,self.root/'spool')
 def tearDown(self):self.t.cleanup()
 def ack(self,**changes):
  a={'accepted':True,'batch_id':'b','request_hash':hashlib.sha256(self.p.read_bytes()).hexdigest()};a.update(changes);return lambda *a_,**k:Response(a)
 def test_accept_deletes_only_after_exact_ack(self):self.assertTrue(u.upload_pending(self.p,'https://example.invalid/api','test',self.ack()));self.assertFalse(self.p.exists())
 def test_wrong_hash_retains(self):self.assertFalse(u.upload_pending(self.p,'https://example.invalid/api','test',self.ack(request_hash='wrong')));self.assertTrue(self.p.exists())
 def test_wrong_batch_retains(self):self.assertFalse(u.upload_pending(self.p,'https://example.invalid/api','test',self.ack(batch_id='other')));self.assertTrue(self.p.exists())
 def test_network_failure_retains(self):
  def fail(*a,**k):raise OSError('offline')
  self.assertFalse(u.upload_pending(self.p,'https://example.invalid/api','test',fail));self.assertTrue(self.p.exists())
 def test_retry_same_file_same_spool(self):self.assertEqual(self.p,u.stage(self.source,self.root/'spool'))
 def test_http_refused(self):
  with self.assertRaises(ValueError):u.upload_pending(self.p,'http://example.invalid','test',self.ack())
class Origins(unittest.TestCase):
 def run_main(self,config,*args):
  seen={}
  def fake(path,endpoint,token,*a,**k):seen['endpoint']=endpoint;seen['token']=token;return {'accepted':True,'reason':'accepted'}
  with tempfile.TemporaryDirectory() as d:
   d=pathlib.Path(d);source=d/'trace.json';source.write_text('{"batch_id":"b","events":[]}');cfg=d/'cfg.json';cfg.write_text(json.dumps(config))
   original,u.upload_pending_result=u.upload_pending_result,fake;argv=__import__('sys').argv
   __import__('sys').argv=['upload.py',str(source),'--config',str(cfg),'--spool',str(d/'spool'),*args]
   try:
    try:u.main();code=0
    except SystemExit as e:code=e.code
   finally:u.upload_pending_result=original;__import__('sys').argv=argv
  return code,seen
 def approved(self,origin):return {'approved':True,'origin':origin,'write_key':'k'*43,'project_id':'proj_'+'ab'*16}
 def test_existing_dev_config_uploads_to_dev_by_default(self):
  code,seen=self.run_main(self.approved('https://supatrace.dev'));self.assertEqual(code,0);self.assertEqual(seen['endpoint'],'https://supatrace.dev/api/batches')
 def test_tech_config_uploads_to_tech_by_default(self):
  code,seen=self.run_main(self.approved('https://supatrace.tech'));self.assertEqual(code,0);self.assertEqual(seen['endpoint'],'https://supatrace.tech/api/batches')
 def test_credential_cannot_be_sent_to_the_other_host_or_elsewhere(self):
  for origin,endpoint in (('https://supatrace.dev','https://supatrace.tech/api/batches'),('https://supatrace.tech','https://supatrace.dev/api/batches'),('https://supatrace.tech','https://example.com/api/batches'),('https://supatrace.tech','http://supatrace.tech/api/batches'),('https://supatrace.tech','https://supatrace.tech/other')):
   code,seen=self.run_main(self.approved(origin),'--endpoint',endpoint);self.assertNotEqual(code,0,(origin,endpoint));self.assertEqual(seen,{},(origin,endpoint))
 def test_config_for_an_unknown_origin_is_refused(self):
  code,seen=self.run_main(self.approved('https://supatrace.example'));self.assertNotEqual(code,0);self.assertEqual(seen,{})

class Recovery(unittest.TestCase):
 def setUp(self):
  self.t=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.t.name);self.source=self.root/'source';self.source.write_text('{"batch_id":"b","events":[]}');self.p=u.stage(self.source,self.root/'spool');self.raw=self.p.read_bytes();self.project='proj_'+'ab'*16
 def tearDown(self):self.t.cleanup()
 def transport(self,status,body,headers=None,http_error=False):
  import io, urllib.error
  self.calls=0;self.reads=[]
  outer=self
  class Fake:
   def __init__(self):self.status=status;self.headers=headers or {}
   def read(self,n):outer.reads.append(n);return body[:n]
   def __enter__(self):return self
   def __exit__(self,*args):pass
  def send(request,timeout):
   self.calls+=1;self.request=request
   if http_error:raise urllib.error.HTTPError('https://example.invalid/PRIVATE_URL',status,'PRIVATE_REASON',headers or {},io.BytesIO(body))
   return Fake()
  return send
 def run_outcome(self,status,body,headers=None,http_error=False):
  result=u.upload_pending_result(self.p,'https://example.invalid/api','PRIVATE_TOKEN',self.transport(status,body,headers,http_error),expected_project=self.project)
  self.assertEqual(self.calls,1);self.assertTrue(self.p.exists());self.assertEqual(self.p.read_bytes(),self.raw)
  self.assertNotIn('PRIVATE_',json.dumps(result)+u.upload_result_message(result));return result
 def test_known_rejections_have_safe_distinct_recovery_for_both_transport_shapes(self):
  for pair,reason in u.REJECTIONS.items():
   for raised in (False,True):
    with self.subTest(pair=pair,raised=raised):
     status,code=pair;r=self.run_outcome(status,json.dumps({'error':code,'detail':'PRIVATE_BODY'}).encode(),{'Retry-After':'60'},raised)
     self.assertFalse(r['accepted']);self.assertEqual(r['reason'],reason)
     self.assertEqual(r['retry_after_seconds'],60 if reason=='rate_limit' else None)
     message=u.upload_result_message(r);self.assertIn('Local batch retained',message);self.assertIn('reservations may still consume quota',message)
 def test_status_code_pair_must_match_and_unknowns_stay_unconfirmed(self):
  for status,body in [(200,b'{"error":"rate_limit"}'),(401,b'{"error":"rate_limit"}'),(429,b'{"error":"invalid_write_key"}'),(429,b'{"error":"PRIVATE_BODY"}'),(503,b'{"error":"storage_capacity"}'),(302,b'{"accepted":true}'),(403,b'{"error":[]}')]:
   self.assertEqual(self.run_outcome(status,body)['reason'],'unconfirmed')
 def test_malformed_oversized_and_non_object_bodies_are_not_success(self):
  for body in [b'PRIVATE_BODY',b'[]',b'null',b'true',b'['*2000+b']'*2000,b' '*8193,b'{"error":"rate_limit","error":"rate_limit"}',b'{"error":"rate_limit","value":NaN}']:
   for status in (201,429):
    self.assertEqual(self.run_outcome(status,body)['reason'],'unconfirmed');self.assertEqual(self.reads,[8193])
 def test_retry_header_is_bounded_integer_only_and_never_echoed(self):
  for header in ['PRIVATE_HEADER','Fri, 1 Jan 2038 00:00:00 GMT','0','-1','86401','1.5','60\r\nPRIVATE_HEADER','9'*100]:
   self.assertIsNone(self.run_outcome(429,b'{"error":"rate_limit"}',{'Retry-After':header})['retry_after_seconds'])
  self.assertEqual(self.run_outcome(429,b'{"error":"rate_limit"}',{'Retry-After':'86400'})['retry_after_seconds'],86400)
 def test_boolean_callers_never_start_reading_rejection_bodies(self):
  transport=self.transport(429,b'{"error":"rate_limit"}')
  self.assertFalse(u.upload_pending(self.p,'https://example.invalid/api','PRIVATE_TOKEN',transport));self.assertEqual(self.calls,1);self.assertEqual(self.reads,[])
  import urllib.error
  class Body:
   def read(self,n):raise AssertionError('must not read an unwrapped error body')
   def close(self):pass
  def fail(*args,**kwargs):raise urllib.error.HTTPError('https://example.invalid',429,'PRIVATE_REASON',{},Body())
  self.assertFalse(u.upload_pending(self.p,'https://example.invalid/api','PRIVATE_TOKEN',fail));self.assertTrue(self.p.exists())
 def test_exact_ack_is_the_only_success_and_cleanup_failure_is_distinct(self):
  ack={'accepted':True,'batch_id':'b','request_hash':hashlib.sha256(self.raw).hexdigest(),'project_id':self.project}
  for changes in [{'batch_id':'other'},{'request_hash':'other'},{'project_id':'proj_'+'cd'*16},{'accepted':1}]:
   self.assertEqual(self.run_outcome(201,json.dumps({**ack,**changes}).encode())['reason'],'unconfirmed')
  from unittest.mock import patch
  with patch.object(pathlib.Path,'unlink',side_effect=OSError('PRIVATE_PATH')):
   result=u.upload_pending_result(self.p,'https://example.invalid/api','PRIVATE_TOKEN',self.transport(201,json.dumps(ack).encode()),expected_project=self.project)
  self.assertFalse(result['accepted']);self.assertEqual(result['reason'],'acknowledged_pending_cleanup');self.assertTrue(self.p.exists());self.assertIn('server acknowledged',u.upload_result_message(result));self.assertNotIn('PRIVATE_',u.upload_result_message(result))
  result=u.upload_pending_result(self.p,'https://example.invalid/api','PRIVATE_TOKEN',self.transport(201,json.dumps(ack).encode()),expected_project=self.project)
  self.assertTrue(result['accepted']);self.assertFalse(self.p.exists());self.assertEqual(u.upload_result_message(result),'Accepted by server.')
 def test_network_failure_retains_without_retry_or_exception_disclosure(self):
  calls=[]
  def offline(*args,**kwargs):calls.append(1);raise OSError('PRIVATE_TOKEN PRIVATE_URL')
  result=u.upload_pending_result(self.p,'https://example.invalid/api','PRIVATE_TOKEN',offline)
  self.assertEqual(result['reason'],'unconfirmed');self.assertEqual(len(calls),1);self.assertTrue(self.p.exists());self.assertNotIn('PRIVATE_',u.upload_result_message(result))
 def test_messages_do_not_promise_quota_release_or_silent_id_changes(self):
  capacity=u.upload_result_message(u._outcome('capacity_or_account_state'))
  self.assertIn('account state',capacity);self.assertIn('no monthly reset or automatic cleanup',capacity);self.assertNotIn('nothing stored',capacity)
  self.assertIn('do not change its ID',u.upload_result_message(u._outcome('identity_conflict')))
  self.assertIn('not promised',u.upload_result_message(u._outcome('account_access')))
  self.assertNotIn('PRIVATE_',u.upload_result_message({'reason':'PRIVATE_BODY','retry_after_seconds':'PRIVATE_HEADER'}))
 def test_cli_prints_only_sanitized_outcome_and_exits_unsuccessful(self):
  from unittest.mock import patch
  from contextlib import redirect_stdout,redirect_stderr
  import io,sys
  config=self.root/'config';config.write_text(json.dumps({'approved':True,'origin':'https://supatrace.dev','write_key':'PRIVATE_TOKEN','project_id':self.project}))
  output=io.StringIO()
  with patch.object(sys,'argv',['upload.py',str(self.source),'--config',str(config),'--spool',str(self.root/'spool')]),patch.object(u,'upload_pending_result',return_value=u._outcome('capacity_or_account_state')),redirect_stdout(output),redirect_stderr(output):
   with self.assertRaises(SystemExit) as error:u.main()
  self.assertEqual(error.exception.code,1);self.assertIn('capacity or account state',output.getvalue());self.assertNotIn('PRIVATE_',output.getvalue());self.assertNotIn(str(self.root),output.getvalue());self.assertTrue(self.p.exists())

 def test_cli_missing_or_malformed_config_has_safe_actionable_error(self):
  import subprocess,sys
  for content in (None,'SECRET','[]','{"approved": "yes", "origin": "https://supatrace.dev", "write_key": "SECRET"}'):
   config=self.root/'config.json'
   if content is not None:config.write_text(content)
   result=subprocess.run([sys.executable,str(pathlib.Path(u.__file__)),str(self.source),'--config',str(config),'--spool',str(self.root/'unused')],capture_output=True,text=True)
   self.assertNotEqual(result.returncode,0);self.assertNotIn('Traceback',result.stderr);self.assertNotIn('SECRET',result.stderr);self.assertIn('error:',result.stderr)
   self.assertFalse((self.root/'unused').exists())
 def test_cli_missing_batch_does_not_upload_or_print_key(self):
  import subprocess,sys
  config=self.root/'config.json';config.write_text(json.dumps({'approved':True,'origin':'https://supatrace.dev','write_key':'SECRET','project_id':'proj_'+('ab'*16)}))
  result=subprocess.run([sys.executable,str(pathlib.Path(u.__file__)),str(self.root/'missing'),'--config',str(config),'--spool',str(self.root/'unused')],capture_output=True,text=True)
  self.assertNotEqual(result.returncode,0);self.assertIn('No upload was attempted',result.stderr);self.assertNotIn('Traceback',result.stderr);self.assertNotIn('SECRET',result.stderr)


if __name__=='__main__':unittest.main()

class DefaultOrigin(unittest.TestCase):
 def test_default_upload_origin(self):
  self.assertEqual(u.DEFAULT_ORIGIN, 'https://supatrace.dev')
  self.assertIn('https://supatrace.tech', u.ORIGINS)
