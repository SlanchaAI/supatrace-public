import pathlib, subprocess, sys, tempfile, unittest, importlib.util, json, io, contextlib, urllib.error, http.client
from unittest.mock import patch
ROOT = pathlib.Path(__file__).parents[1]
CONNECT = ROOT / 'agent' / 'connect.py'

class Connect(unittest.TestCase):
    def test_invalid_project_never_opens_the_network(self):
        with tempfile.TemporaryDirectory() as directory:
            config = pathlib.Path(directory) / 'config.json'
            result = subprocess.run([sys.executable, str(CONNECT), '--config', str(config), '--project', 'not-a-project'], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Invalid project id', result.stderr)
        self.assertFalse(config.exists())

    def test_existing_config_for_another_project_is_left_alone(self):
        with tempfile.TemporaryDirectory() as directory:
            config = pathlib.Path(directory) / 'config.json'
            config.write_text('{"approved": false, "project_id": "proj_' + ('ab' * 16) + '", "origin": "https://supatrace.dev"}')
            before = config.read_text()
            result = subprocess.run([sys.executable, str(CONNECT), '--config', str(config), '--project', 'proj_' + ('cd' * 16)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('different project', result.stderr)
            self.assertEqual(config.read_text(), before)

    def run_connect(self, *args):
        with tempfile.TemporaryDirectory() as directory:
            return subprocess.run([sys.executable, str(CONNECT), '--config', str(pathlib.Path(directory) / 'c.json'), *args], capture_output=True, text=True)

    def test_both_supatrace_origins_pass_the_origin_check(self):
        for origin in ('https://supatrace.tech', 'https://supatrace.dev'):
            result = self.run_connect('--origin', origin, '--project', 'not-a-project')
            self.assertIn('Invalid project id', result.stderr, origin)
            self.assertNotIn('is supported', result.stderr, origin)

    def test_any_other_origin_is_refused_before_the_network(self):
        for origin in ('https://example.com', 'http://supatrace.tech', 'https://supatrace.tech.evil.example', 'https://supatrace.tech/'):
            result = self.run_connect('--origin', origin)
            self.assertNotEqual(result.returncode, 0, origin)
            self.assertIn('is supported', result.stderr, origin)

    def test_default_origin_is_the_primary_dev_site(self):
        spec = importlib.util.spec_from_file_location('upload', ROOT / 'agent' / 'upload.py')
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        self.assertEqual(module.DEFAULT_ORIGIN, 'https://supatrace.dev')
        self.assertEqual(set(module.ORIGINS), {'https://supatrace.tech', 'https://supatrace.dev'})

class Recovery(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.temp.name);self.config=self.root/'config.json'
        with patch.object(sys,'path',[str(ROOT/'agent'),*sys.path]):
            spec=importlib.util.spec_from_file_location('connect_under_test',CONNECT);self.c=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.c)
        self.project='proj_'+('ab'*16);self.other='proj_'+('cd'*16)
        self.state={'approved':False,'origin':'https://supatrace.dev','requested_project_id':self.project,'write_key':'K'*43,'device_secret':'D'*43,'user_code':'C'*12}
    def tearDown(self):self.temp.cleanup()
    def save(self,state=None):
        self.config.write_text(json.dumps(self.state if state is None else state));return self.config.read_bytes()
    def run_main(self,responses,extra=(),writer=None):
        output=io.StringIO();code=0
        with patch.object(sys,'argv',['connect.py','--config',str(self.config),*extra]),patch.object(self.c,'post',side_effect=responses) as post,patch.object(self.c.time,'sleep'),contextlib.redirect_stdout(output),contextlib.redirect_stderr(output):
            try:
                if writer is None:self.c.main()
                else:
                    with patch.object(self.c,'atomic_write',side_effect=writer):self.c.main()
            except SystemExit as e:code=e.code;output.write(str(e.code))
        text=output.getvalue()
        self.assertNotIn('K'*43,text);self.assertNotIn('D'*43,text);self.assertNotIn('SECRET',text)
        return code,text,post
    def test_resume_without_project_preserves_saved_binding(self):
        before=self.save();code,text,post=self.run_main([{'approved':True,'project_id':self.other}])
        self.assertNotEqual(code,0);self.assertIn('did not match',text);self.assertEqual(self.config.read_bytes(),before);self.assertEqual(post.call_count,1)
    def test_added_project_binding_survives_an_interrupted_unbound_resume(self):
        state={**self.state};state.pop('requested_project_id');self.save(state)
        code,text,post=self.run_main([OSError('SECRET')]*60,['--project',self.project])
        self.assertNotEqual(code,0);self.assertEqual(json.loads(self.config.read_text())['requested_project_id'],self.project)
        before=self.config.read_bytes();code,text,post=self.run_main([{'approved':True,'project_id':self.other}])
        self.assertNotEqual(code,0);self.assertIn('did not match',text);self.assertEqual(self.config.read_bytes(),before)
    def test_failed_binding_save_never_polls_or_replaces_config(self):
        state={**self.state};state.pop('requested_project_id');before=self.save(state)
        code,text,post=self.run_main([],['--project',self.project],writer=OSError('SECRET'))
        self.assertNotEqual(code,0);self.assertIn('no approval was checked',text);post.assert_not_called();self.assertEqual(self.config.read_bytes(),before)
    def test_resume_matching_approval_preserves_key_and_removes_device_secret(self):
        self.save();code,text,post=self.run_main([{'approved':True,'project_id':self.project}]);saved=json.loads(self.config.read_text())
        self.assertEqual(code,0);self.assertTrue(saved['approved']);self.assertEqual(saved['write_key'],self.state['write_key']);self.assertNotIn('device_secret',saved);self.assertEqual(self.config.stat().st_mode & 0o777,0o600);self.assertEqual(post.call_count,1)
    def test_network_start_failure_is_actionable_and_leaves_no_file(self):
        for error in (OSError('SECRET'),urllib.error.HTTPError('https://secret.invalid',503,'SECRET',{},None),http.client.IncompleteRead(b'SECRET',5)):
            code,text,post=self.run_main([error]);self.assertNotEqual(code,0);self.assertIn('Could not start setup',text);self.assertFalse(self.config.exists())
    def test_malformed_saved_configs_never_open_network_or_overwrite(self):
        for raw in ('SECRET','[]','null',json.dumps({**self.state,'origin':'https://other.invalid'}),json.dumps({**self.state,'approved':'yes'}),json.dumps({**self.state,'device_secret':None}),json.dumps({**self.state,'project_id':self.other})):
            self.config.write_text(raw);before=self.config.read_bytes();code,text,post=self.run_main([])
            self.assertNotEqual(code,0);post.assert_not_called();self.assertEqual(self.config.read_bytes(),before)
    def test_network_interruption_then_matching_approval_resumes_same_request(self):
        self.save();code,text,post=self.run_main([OSError('SECRET'),{'pending':True},{'approved':True,'project_id':self.project}])
        self.assertEqual(code,0);self.assertEqual(post.call_count,3)
        for call in post.call_args_list:self.assertEqual(call.args[1],'/api/setup/poll');self.assertEqual(call.args[2],{'device_secret':self.state['device_secret']})
    def test_timeout_keeps_pending_file_unchanged(self):
        before=self.save();code,text,post=self.run_main([OSError('SECRET')]*60)
        self.assertNotEqual(code,0);self.assertIn('Rerun with the same config',text);self.assertEqual(self.config.read_bytes(),before);self.assertEqual(post.call_count,60)
    def test_expiry_keeps_pending_file_unchanged(self):
        before=self.save();code,text,post=self.run_main([urllib.error.HTTPError('https://secret.invalid',410,'SECRET',{},None)])
        self.assertNotEqual(code,0);self.assertIn('different config path',text);self.assertEqual(self.config.read_bytes(),before)
    def test_invalid_status_never_marks_approved(self):
        for status in ([],{'approved':'yes'}, {'approved':True,'project_id':'SECRET'}, {'approved':True}):
            before=self.save();code,text,post=self.run_main([status]);self.assertNotEqual(code,0);self.assertEqual(self.config.read_bytes(),before)
    def test_approved_config_repeated_command_does_not_make_network_call(self):
        state={**self.state,'approved':True,'project_id':self.project};state.pop('device_secret');before=self.save(state)
        code,text,post=self.run_main([]);self.assertEqual(code,0);self.assertIn('Already connected',text);post.assert_not_called();self.assertEqual(self.config.read_bytes(),before)
    def test_failed_approval_save_retains_pending_for_recovery(self):
        before=self.save();code,text,post=self.run_main([{'approved':True,'project_id':self.project}],writer=OSError('SECRET'))
        self.assertNotEqual(code,0);self.assertIn('rerun with the same config',text);self.assertEqual(self.config.read_bytes(),before)
    def test_start_response_validation_and_save_failure(self):
        for response in ([],{'device_secret':'SECRET','user_code':'bad'}):
            code,text,post=self.run_main([response]);self.assertNotEqual(code,0);self.assertFalse(self.config.exists());self.assertIn('could not be verified',text)
        response={'device_secret':'D'*43,'user_code':'C'*12}
        code,text,post=self.run_main([response],writer=OSError('SECRET'));self.assertNotEqual(code,0);self.assertFalse(self.config.exists());self.assertIn('Could not save',text)
    def test_new_setup_binds_project_and_does_not_persist_untrusted_fields(self):
        response={'device_secret':'D'*43,'user_code':'C'*12,'extra':'SECRET'}
        code,text,post=self.run_main([response,{'approved':True,'project_id':self.project}],['--project',self.project])
        self.assertEqual(code,0);saved=json.loads(self.config.read_text());self.assertEqual(saved['requested_project_id'],self.project);self.assertNotIn('extra',saved);self.assertIn('?project='+self.project,post.call_args_list[0].args[1]);self.assertEqual(saved['origin'],'https://supatrace.dev');self.assertIn('https://supatrace.dev/app/',text)

class ResumeBinding(unittest.TestCase):
    def setUp(self):
        import json
        from unittest.mock import patch
        self.json=json;self.patch=patch;self.temp=tempfile.TemporaryDirectory();self.path=pathlib.Path(self.temp.name)/'config.json'
        self.project='proj_'+'ab'*16;self.other='proj_'+'cd'*16
        self.state={'origin':'https://supatrace.dev','requested_project_id':self.project,'approved':False,'device_secret':'D'*43,'write_key':'K'*43,'user_code':'C'*12}
        spec=importlib.util.spec_from_file_location('upload',ROOT/'agent/upload.py');upload=importlib.util.module_from_spec(spec);spec.loader.exec_module(upload)
        with patch.dict(sys.modules,{'upload':upload}):
            spec=importlib.util.spec_from_file_location('connect_under_test',CONNECT);self.c=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.c)
    def tearDown(self):self.temp.cleanup()
    def invoke(self,status,*args,state=None):
        import contextlib,io
        self.path.write_text(self.json.dumps(self.state if state is None else state));self.before=self.path.read_bytes();self.calls=[];output=io.StringIO()
        def post(origin,path,payload):
            self.calls.append((origin,path,payload))
            if isinstance(status,BaseException):raise status
            return status
        with self.patch.object(sys,'argv',['connect.py','--config',str(self.path),*args]),self.patch.object(self.c,'post',side_effect=post),self.patch.object(self.c.time,'sleep'),contextlib.redirect_stdout(output),contextlib.redirect_stderr(output):
            try:self.c.main();self.code=0
            except SystemExit as e:self.code=e.code
        self.output=output.getvalue();return self.json.loads(self.path.read_text())
    def unchanged_failure(self):
        self.assertNotEqual(self.code,0);self.assertEqual(self.path.read_bytes(),self.before);self.assertNotIn('Connected with',self.output)
    def test_resume_without_flags_preserves_saved_origin_and_project(self):
        result=self.invoke({'approved':True,'project_id':self.project})
        self.assertEqual(self.code,0);self.assertEqual(len(self.calls),1);self.assertEqual(self.calls[0][0],'https://supatrace.dev');self.assertEqual(result['origin'],'https://supatrace.dev');self.assertEqual(result['project_id'],self.project);self.assertTrue(result['approved']);self.assertNotIn('device_secret',result)
    def test_legacy_tech_config_keeps_saved_host_without_flags(self):
        result=self.invoke({'approved':True,'project_id':self.project},state={**self.state,'origin':'https://supatrace.tech'})
        self.assertEqual(self.code,0);self.assertEqual(result['origin'],'https://supatrace.tech');self.assertEqual(self.calls[0][0],'https://supatrace.tech')
    def test_mismatched_approval_without_project_flag_never_rebinds(self):
        self.invoke({'approved':True,'project_id':self.other});self.unchanged_failure();self.assertEqual(len(self.calls),1)
    def test_explicit_origin_conflict_fails_before_network(self):
        self.invoke({'approved':True,'project_id':self.project},'--origin','https://supatrace.tech');self.unchanged_failure();self.assertEqual(self.calls,[])
    def test_explicit_project_conflict_fails_before_network(self):
        self.invoke({'approved':True,'project_id':self.other},'--project',self.other);self.unchanged_failure();self.assertEqual(self.calls,[])
    def test_explicit_matching_flags_resume(self):
        self.invoke({'approved':True,'project_id':self.project},'--origin','https://supatrace.dev','--project',self.project);self.assertEqual(self.code,0);self.assertEqual(len(self.calls),1)
    def test_saved_project_id_without_requested_project_is_binding(self):
        state={**self.state,'project_id':self.project};state.pop('requested_project_id')
        self.invoke({'approved':True,'project_id':self.other},state=state);self.unchanged_failure()
    def test_saved_conflicting_or_malformed_bindings_fail_before_network(self):
        for change in [{'origin':'https://example.invalid'},{'origin':None},{'project_id':self.other},{'requested_project_id':''},{'requested_project_id':7},{'approved':'yes'},{'device_secret':None},{'user_code':''}]:
            with self.subTest(change=change):
                self.invoke({'approved':True,'project_id':self.project},state={**self.state,**change});self.unchanged_failure();self.assertEqual(self.calls,[])
    def test_legacy_unbound_pending_can_pin_explicit_project_on_approval(self):
        state=dict(self.state);state.pop('requested_project_id')
        result=self.invoke({'approved':True,'project_id':self.project},'--project',self.project,state=state);self.assertEqual(self.code,0);self.assertEqual(result['project_id'],self.project)
    def test_malformed_approval_responses_never_mutate_config(self):
        for status in [[],None,{'approved':'true','project_id':self.project},{'approved':True},{'approved':True,'project_id':'bad'}]:
            with self.subTest(status=status):
                self.invoke(status);self.unchanged_failure()
    def test_expired_response_retains_pending_state(self):
        import urllib.error
        self.invoke(urllib.error.HTTPError('https://supatrace.dev',410,'expired',{},None));self.unchanged_failure();self.assertEqual(len(self.calls),1)
    def test_pending_response_does_not_discard_config(self):
        self.invoke({'approved':False});self.unchanged_failure();self.assertEqual(len(self.calls),1)
    def test_already_approved_binding_conflict_is_rejected(self):
        self.invoke({},'--origin','https://supatrace.tech',state={**self.state,'approved':True,'project_id':self.project});self.unchanged_failure();self.assertEqual(self.calls,[])

    def test_local_save_failure_never_reports_success_or_changes_pending_state(self):
        with self.patch.object(self.c,'atomic_write',side_effect=OSError('synthetic disk failure')):
            self.invoke({'approved':True,'project_id':self.project})
        self.unchanged_failure();self.assertEqual(len(self.calls),1)

    def test_pending_response_shape_from_real_store_preserves_config(self):
        self.invoke({'pending':True});self.unchanged_failure();self.assertEqual(len(self.calls),60)



class EnvironmentResume(unittest.TestCase):
    setUp=ResumeBinding.setUp
    tearDown=ResumeBinding.tearDown
    invoke=ResumeBinding.invoke
    unchanged_failure=ResumeBinding.unchanged_failure
    # Reuse the author-provided invocation helper without rerunning its cases.
    def test_nondefault_resume_uses_saved_scope_without_flags(self):
        state={**self.state,'requested_environment_id':'development'}
        saved=self.invoke({'approved':True,'project_id':self.project,'environment_id':'development'},state=state)
        self.assertEqual(self.code,0);self.assertEqual(saved['environment_id'],'development')
        self.assertEqual(saved['requested_environment_id'],'development');self.assertEqual(saved['origin'],state['origin'])
        self.assertEqual(self.calls[0][1],'/api/setup/poll');self.assertEqual(len(self.calls),1)
    def test_nondefault_wrong_or_missing_ack_retains_pending(self):
        for change in ({},{'environment_id':'production'},{'environment_id':None},{'environment_id':False}):
            with self.subTest(change=change):
                self.invoke({'approved':True,'project_id':self.project,**change},state={**self.state,'requested_environment_id':'development'})
                self.unchanged_failure();self.assertEqual(len(self.calls),1)
    def test_explicit_default_cannot_rebind_saved_nondefault_scope(self):
        self.invoke({},'--environment','default',state={**self.state,'requested_environment_id':'development'})
        self.unchanged_failure();self.assertEqual(self.calls,[])
    def test_malformed_or_conflicting_environment_state_stops_before_poll(self):
        for change in ({'requested_environment_id':None},{'environment_id':''},{'requested_environment_id':7},{'environment_id':'dev','requested_environment_id':'prod'},{'approved':True,'project_id':self.project,'requested_environment_id':'dev'}):
            with self.subTest(change=change):
                self.invoke({},state={**self.state,**change});self.unchanged_failure();self.assertEqual(self.calls,[])
    def test_new_environment_setup_keeps_verified_link_and_scope(self):
        self.path.unlink(missing_ok=True);calls=[];output=io.StringIO()
        responses=[{'device_secret':'D'*43,'user_code':'C'*12,'verification_uri':'/app/#setup','untrusted':'SECRET'},{'approved':True,'project_id':self.project,'environment_id':'development'}]
        with patch.object(sys,'argv',['connect.py','--config',str(self.path),'--project',self.project,'--environment','development']),patch.object(self.c,'post',side_effect=responses) as post,contextlib.redirect_stdout(output):
            self.c.main();calls=post.call_args_list
        from urllib.parse import urlsplit,parse_qs
        self.assertEqual(parse_qs(urlsplit(calls[0].args[1]).query),{'project':[self.project],'environment':['development']})
        saved=json.loads(self.path.read_text());self.assertEqual(saved['environment_id'],'development');self.assertEqual(saved['origin'],'https://supatrace.dev')
        self.assertIn('/app/#setup',output.getvalue());self.assertNotIn('SECRET',self.path.read_text());self.assertNotIn('K'*43,output.getvalue())

if __name__ == '__main__':
    unittest.main()
