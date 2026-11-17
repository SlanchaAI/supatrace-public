import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch
from tests import test_private_upload_runtime as fixtures

runtime = fixtures.runtime
PROJECT = fixtures.PROJECT


class StatusTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.UploadTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.workspace = self.fixture.workspace

    def status(self, **extra):
        return runtime.inspect_staged_workspace(self.workspace, origin=extra.get('origin', 'https://supatrace.dev'), project_id=extra.get('project_id', PROJECT))

    def journal(self):
        manifest, items = runtime._preflight(self.workspace, self.fixture.scope)
        return runtime._validated_journal(self.workspace, self.fixture.scope, manifest, items)

    def write_journal(self, journal):
        path = self.workspace / 'upload-receipts.json'
        path.write_bytes(runtime.canonical(journal));path.chmod(0o600)

    def snapshot(self):
        return {str(p.relative_to(self.workspace)): p.read_bytes() for p in self.workspace.rglob('*') if p.is_file()}

    def test_fresh_stage_is_pending_offline_and_preserves_all_bytes(self):
        before = self.snapshot()
        with patch('socket.create_connection', side_effect=AssertionError('network forbidden')):
            value = self.status()
        self.assertEqual(value['outcome'], 'awaiting-approved-upload')
        self.assertEqual(value['pending_batches'], 1)
        self.assertEqual(value['network_requests_attempted'], 0)
        self.assertFalse(value['hosted_readback_verified'])
        self.assertEqual(before, self.snapshot())
        self.assertFalse((self.workspace / '.live-import.lock').exists())
        self.assertNotIn('synthetic-source', json.dumps(value))

    def test_real_retained_uploader_ack_is_reported_without_replay(self):
        self.fixture.run_upload()
        calls = dict(self.fixture.calls);before = self.snapshot()
        value = self.status()
        self.assertTrue(value['all_batches_acknowledged'])
        self.assertEqual(value['acknowledged_batches'], 1)
        self.assertFalse(value['hosted_readback_verified'])
        self.assertEqual(self.fixture.calls, calls)
        self.assertEqual(self.snapshot(), before)

    def test_ambiguous_states_are_never_called_complete_even_without_pending_file(self):
        for state in ['attempting', 'unacknowledged']:
            journal = self.journal()
            next(iter(journal['entries'].values()))['status'] = state
            self.write_journal(journal)
            for p in self.fixture.pending(): p.unlink()
            before = self.snapshot();value = self.status()
            self.assertEqual(value['outcome'], 'reconciliation-required')
            self.assertEqual(value['ambiguous_batches'], 1)
            self.assertFalse(value['all_batches_acknowledged'])
            self.assertEqual(before, self.snapshot())

    def test_actual_interrupted_upload_reports_mixed_ack_and_ambiguity_without_replay(self):
        self.fixture.workspace = self.workspace.parent / 'two-batches'
        receipt = json.loads(self.fixture.capture(rows=2).stdout)
        self.workspace = self.fixture.workspace
        self.fixture.scope.update(fingerprint=receipt['fingerprint'], conversion_hash=receipt['conversionHash'], manifest_hash=receipt['manifestHash'])
        attempts = []
        def transport(request, timeout):
            attempts.append(request)
            if len(attempts) == 2:
                raise OSError('synthetic response lost')
            return fixtures.Reply(request)
        result = self.fixture.run_upload(transport=transport)
        self.assertEqual(result['outcome'], 'reconciliation-required')
        before = self.snapshot()
        value = self.status()
        self.assertEqual((value['acknowledged_batches'], value['ambiguous_batches']), (1, 1))
        self.assertEqual(value['outcome'], 'reconciliation-required')
        self.assertEqual(len(attempts), 2)
        self.assertEqual(before, self.snapshot())

    def test_missing_pending_without_ack_is_refused(self):
        self.fixture.pending()[0].unlink()
        with self.assertRaises(runtime.RuntimeGate): self.status()

    def test_forged_or_malformed_ack_is_refused(self):
        for entry in [{'status': 'accepted', 'receipt': {}}, {'status': 'mystery'}, {'status': 'pending', 'request_hash': 'bad'}]:
            journal = self.journal()
            next(iter(journal['entries'].values())).update(entry)
            self.write_journal(journal)
            with self.assertRaises(runtime.RuntimeGate): self.status()
            (self.workspace / 'upload-receipts.json').unlink()

    def test_cross_project_and_origin_binding_are_refused(self):
        with self.assertRaises(runtime.RuntimeGate): self.status(project_id='proj_'+'b'*32)
        self.fixture.run_upload()
        with self.assertRaises(runtime.RuntimeGate): self.status(origin='https://supatrace.tech')
        with self.assertRaises(runtime.RuntimeGate): self.status(origin='https://evil.invalid')

    def test_active_or_abandoned_lock_is_preserved(self):
        path = self.workspace / '.live-import.lock';path.write_text('held');path.chmod(0o600)
        with self.assertRaises(runtime.RuntimeGate): self.status()
        self.assertEqual(path.read_text(), 'held')

    def test_tampered_pending_and_unsafe_permissions_are_refused(self):
        path = self.fixture.pending()[0];original = path.read_bytes();path.write_bytes(b'{}')
        with self.assertRaises(runtime.RuntimeGate): self.status()
        path.write_bytes(original);path.chmod(0o644)
        with self.assertRaises(runtime.RuntimeGate): self.status()
        path.chmod(0o600)
        self.workspace.chmod(0o755)
        with self.assertRaises(runtime.RuntimeGate): self.status()

    def test_cli_reports_safe_summary_and_no_private_exception_details(self):
        command = [sys.executable, str(fixtures.HERE/'private_upload_runtime.py'), 'status', '--directory', str(self.workspace), '--origin', 'https://supatrace.dev', '--project', PROJECT]
        result = subprocess.run(command, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['pending_batches'], 1)
        self.fixture.pending()[0].unlink()
        result = subprocess.run(command, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, '')
        self.assertNotIn(str(self.workspace), result.stderr)
        self.assertNotIn('Traceback', result.stderr)
        self.assertIn('No network request was attempted', result.stderr)
