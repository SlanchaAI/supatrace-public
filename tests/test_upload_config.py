import contextlib
import importlib.util
import io
import json
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('upload_config_under_test', pathlib.Path(__file__).parents[1] / 'agent/upload.py')
upload = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upload)


class ProjectConfig(unittest.TestCase):
    def invoke(self, config, origin='https://supatrace.dev'):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            config_path = root / 'config.json'
            config_path.write_text(json.dumps(config))
            arguments = ['upload.py', str(root / 'not-read-before-config-validation.json'), '--config', str(config_path), '--spool', str(root / 'spool')]
            with mock.patch.object(sys, 'argv', arguments), mock.patch.object(upload, 'stage', return_value=root / 'pending.json') as stage, mock.patch.object(upload, 'upload_pending_result', return_value={'accepted': True, 'reason': 'accepted', 'retry_after_seconds': None}) as send, contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                try:
                    upload.main()
                    code = 0
                except SystemExit as error:
                    code = error.code
            return code, stage.call_args_list, send.call_args_list

    def approved(self, origin='https://supatrace.dev'):
        return {'approved': True, 'origin': origin, 'write_key': 'synthetic-not-a-real-key', 'project_id': 'proj_' + 'ab' * 16}

    def test_missing_project_rejected_before_staging_or_transport(self):
        config = self.approved()
        del config['project_id']
        code, staged, sent = self.invoke(config)
        self.assertEqual(code, 2)
        self.assertEqual(staged, [])
        self.assertEqual(sent, [])

    def test_malformed_projects_rejected_before_staging_or_transport(self):
        for project in (None, '', 7, False, [], {}, 'proj_short', 'proj_' + 'AB' * 16, 'proj_' + 'ab' * 16 + '\n'):
            with self.subTest(project=project):
                config = self.approved()
                config['project_id'] = project
                code, staged, sent = self.invoke(config)
                self.assertEqual(code, 2)
                self.assertEqual(staged, [])
                self.assertEqual(sent, [])

    def test_valid_project_binding_preserved_on_both_origins(self):
        for origin in upload.ORIGINS:
            with self.subTest(origin=origin):
                config = self.approved(origin)
                code, staged, sent = self.invoke(config)
                self.assertEqual(code, 0)
                self.assertEqual(len(staged), 1)
                self.assertEqual(len(sent), 1)
                self.assertEqual(sent[0].args[1], origin + '/api/batches')
                self.assertEqual(sent[0].kwargs['expected_project'], config['project_id'])

    def test_environment_binding_and_scoped_spool_survive_union(self):
        config={**self.approved(),'environment_id':'development'}
        code,staged,sent=self.invoke(config)
        self.assertEqual(code,0);self.assertEqual(sent[0].kwargs['expected_environment'],'development')
        self.assertIn('scope-',staged[0].args[1]);self.assertEqual(sent[0].kwargs['expected_project'],config['project_id'])

    def test_environment_token_path_is_unchanged(self):
        with mock.patch.object(sys, 'argv', ['upload.py', 'synthetic.json']), mock.patch.dict(upload.os.environ, {'SUPATRACE_TOKEN': 'synthetic-not-a-real-key'}, clear=True), mock.patch.object(upload, 'stage', return_value=pathlib.Path('pending.json')) as stage, mock.patch.object(upload, 'upload_pending_result', return_value={'accepted': True, 'reason': 'accepted', 'retry_after_seconds': None}) as send, contextlib.redirect_stdout(io.StringIO()):
            upload.main()
        stage.assert_called_once()
        self.assertIsNone(send.call_args.kwargs['expected_project'])


if __name__ == '__main__':
    unittest.main()
