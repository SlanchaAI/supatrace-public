import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import sys
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'agent'))
import private_upload_runtime as runtime

HERE = Path(__file__).resolve().parent.parent/'agent'
JS = Path(__file__).resolve().parent.parent/'src/importers'
PROJECT = 'proj_' + 'a' * 32
TOKEN = 'x' * 43  # Synthetic, never retrieved from an account.
SPEC = {'origin': 'https://cloud.langfuse.com', 'sourceProject': 'synthetic-source',
        'destinationProject': PROJECT, 'namespace': 'synthetic-upload-integration',
        'from': '2026-10-01T00:00:00Z', 'to': '2026-10-02T00:00:00Z',
        'maxRows': 2, 'maxPages': 2, 'pageSize': 2, 'maxBytes': 100000, 'maxRetries': 0}


def capture_script(workspace, rows=1):
    return '''import {runPrivateLangfuseWorkflow} from %s;
      const spec=%s;
      const rows=Array.from({length:%s},(_,i)=>({id:'synthetic-'+i,traceId:'synthetic-trace',
        projectId:spec.sourceProject,startTime:'2026-10-01T12:00:00Z',input:{n:i}}));
      const result=await runPrivateLangfuseWorkflow(spec,{directory:%s,
        bounds:{requestTimeoutMs:1000,totalTimeoutMs:10000,maxRequests:10,maxResponseBytes:100000,maxTotalBytes:200000},
        fetchImpl:async url=>new Response(JSON.stringify(url.endsWith('/projects')?
          {data:[{id:spec.sourceProject}]}:{data:rows,meta:{cursor:null}}),{headers:{'content-type':'application/json'}}),
        authorize:async()=>true,
        credentialProvider:async()=>({origin:spec.origin,projectId:spec.sourceProject,
          publicKey:'synthetic-public',secretKey:'synthetic-secret',expiresAt:Date.now()+60000})});
      process.stdout.write(JSON.stringify(result.stageReceipt));
    ''' % (json.dumps((JS / 'private-langfuse-runtime.mjs').as_uri()), json.dumps(SPEC), rows, json.dumps(str(workspace)))


class Reply:
    def __init__(self, request, project=PROJECT, url=None, on_read=None):
        self.status = 201
        self.url = url or request.full_url
        self.on_read = on_read
        self.closed = False
        batch = json.loads(request.data)
        self.body = io.BytesIO(json.dumps({'accepted': True, 'batch_id': batch['batch_id'],
                                          'request_hash': hashlib.sha256(request.data).hexdigest(),
                                          'project_id': project}).encode())
    def geturl(self):
        return self.url
    def __enter__(self):
        return self
    def __exit__(self, *_):
        self.close()
    def close(self):
        self.closed = True
    def read(self, length):
        if self.on_read:
            self.on_read()
        return self.body.read(length)


class CaptureFailure:
    """Stand-in for a non-zero capture exit, carrying whatever stderr the child produced."""
    def __init__(self, returncode=1, stderr=''):
        self.returncode = returncode
        self.stdout = ''
        self.stderr = stderr


def _captured_stderr(result):
    """Surface captured stderr instead of losing it inside the raised error."""
    stderr = getattr(result, 'stderr', None)
    if not stderr:
        return ''
    if isinstance(stderr, bytes):
        stderr = stderr.decode('utf-8', 'replace')
    return stderr.strip()


def _run_capture(argv, **options):
    """Indirection point so tests can mock the child process without touching UploadTests setUp."""
    return subprocess.run(argv, **options)


def capture_workspace(workspace, rows=1, timeout=5):
    """Run the Node capture stage; on failure raise RuntimeError that keeps stderr visible."""
    completed = _run_capture(['node', '--input-type=module', '-e', capture_script(workspace, rows)],
                             check=False, timeout=timeout, capture_output=True, text=True)
    if completed.returncode != 0:
        raise RuntimeError('capture stage failed with exit %s: %s' % (
            completed.returncode, _captured_stderr(completed) or '<no captured stderr>'))
    return completed


class CaptureFailureDiagnosticsTests(unittest.TestCase):
    """Mocked-only: a failed capture must never swallow the child's stderr."""

    def test_nonzero_capture_exit_reports_captured_stderr(self):
        with patch.object(sys.modules[__name__], '_run_capture',
                          return_value=CaptureFailure(returncode=3, stderr='synthetic-capture-marker')):
            with self.assertRaisesRegex(RuntimeError, 'synthetic-capture-marker'):
                capture_workspace(Path('/synthetic/does-not-matter'))

    def test_nonzero_capture_exit_without_stderr_still_reports_exit_code(self):
        with patch.object(sys.modules[__name__], '_run_capture', return_value=CaptureFailure(returncode=4)):
            with self.assertRaisesRegex(RuntimeError, 'exit 4'):
                capture_workspace(Path('/synthetic/does-not-matter'))

    def test_zero_capture_exit_returns_completed_process(self):
        completed = subprocess.CompletedProcess(['node'], 0, '{"stageReceipt":{}}', '')
        with patch.object(sys.modules[__name__], '_run_capture', return_value=completed) as run:
            result = capture_workspace(Path('/synthetic/does-not-matter'))
        self.assertIs(result, completed)
        self.assertFalse(run.call_args.kwargs['check'])
        self.assertEqual(run.call_args.kwargs['timeout'], 5)
        self.assertTrue(run.call_args.kwargs['capture_output'])


class UploadTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='supatrace-upload-runtime-')
        self.addCleanup(self.tmp.cleanup)
        self.workspace = Path(self.tmp.name) / 'workspace'
        receipt = json.loads(self.capture().stdout)
        self.scope = {'origin': 'https://supatrace.dev', 'project_id': PROJECT,
                      'fingerprint': receipt['fingerprint'], 'conversion_hash': receipt['conversionHash'],
                      'manifest_hash': receipt['manifestHash'],
                      'max_batches': 2, 'max_total_bytes': 1048576, 'max_requests': 2, 'total_timeout_ms': 10000}
        self.calls = {'credentials': 0, 'authorization': 0, 'transport': 0}

    def capture(self, rows=1):
        return capture_workspace(self.workspace, rows)

    def credentials(self, _):
        self.calls['credentials'] += 1
        return {'origin': self.scope['origin'], 'project_id': PROJECT,
                'write_key': TOKEN, 'expires_at': 1060}

    def authorize(self, descriptor):
        self.calls['authorization'] += 1
        self.assertEqual(descriptor['project_id'], PROJECT)
        self.assertEqual(descriptor['action'], 'upload-approved-batch')
        return True

    def transport(self, request, timeout):
        self.calls['transport'] += 1
        self.assertEqual(request.get_header('X-supatrace-key'), TOKEN)
        self.assertGreater(timeout, 0)
        return Reply(request)

    def run_upload(self, **extra):
        options = {'credential_provider': self.credentials, 'authorize': self.authorize,
                   'transport': self.transport, 'now': lambda: 1000}
        options.update(extra)
        return runtime.upload_staged_workspace(self.workspace, self.scope, **options)

    def pending(self):
        return list((self.workspace / 'pending').glob('[0-9a-f]' * 64 + '.json'))

    def test_capture_stage_existing_uploader_and_receipt_journal(self):
        result = self.run_upload()
        self.assertTrue(result['all_batches_acknowledged'])
        self.assertFalse(result['hosted_readback_verified'])
        self.assertEqual(self.calls['transport'], 1)
        self.assertEqual(self.pending(), [])
        journal = json.loads((self.workspace / 'upload-receipts.json').read_text())
        self.assertEqual(next(iter(journal['entries'].values()))['status'], 'accepted')
        for path in self.workspace.rglob('*.json'):
            self.assertNotIn(TOKEN, path.read_text())

    def test_reopen_and_restage_replay_never_resend_accepted_batch(self):
        self.run_upload()
        self.calls = dict.fromkeys(self.calls, 0)
        self.assertEqual(self.run_upload()['transport_requests_attempted'], 0)
        self.assertEqual(sum(self.calls.values()), 0)
        self.capture()
        self.assertEqual(len(self.pending()), 1)
        self.assertEqual(self.run_upload()['transport_requests_attempted'], 0)
        self.assertEqual(self.pending(), [])

    def test_wrong_project_ack_is_retained_and_never_automatically_retried(self):
        result = self.run_upload(transport=lambda request, timeout: Reply(request, project='proj_' + 'b' * 32))
        self.assertEqual(result['outcome'], 'reconciliation-required')
        self.assertEqual(len(self.pending()), 1)
        self.calls = dict.fromkeys(self.calls, 0)
        self.assertEqual(self.run_upload()['outcome'], 'reconciliation-required')
        self.assertEqual(sum(self.calls.values()), 0)

    def test_lost_ack_keeps_pending_and_blocks_retry(self):
        def lost(*_, **__):
            raise OSError('synthetic unknown server outcome')
        self.assertEqual(self.run_upload(transport=lost)['outcome'], 'reconciliation-required')
        self.assertEqual(len(self.pending()), 1)
        self.calls = dict.fromkeys(self.calls, 0)
        self.assertEqual(self.run_upload()['transport_requests_attempted'], 0)
        self.assertEqual(sum(self.calls.values()), 0)

    def test_denial_never_retrieves_a_credential(self):
        with self.assertRaisesRegex(runtime.RuntimeGate, 'not_authorized'):
            self.run_upload(authorize=lambda _: False)
        self.assertEqual(self.calls['credentials'], 0)
        self.assertEqual(self.calls['transport'], 0)

    def test_wrong_credential_binding_never_reaches_transport(self):
        for changed in [{'origin': 'https://foreign.invalid'}, {'project_id': 'proj_' + 'b' * 32}, {'expires_at': 999}]:
            with self.assertRaisesRegex(runtime.RuntimeGate, 'credential_binding'):
                self.run_upload(credential_provider=lambda _, changed=changed: {**self.credentials(None), **changed})
        self.assertEqual(self.calls['transport'], 0)

    def test_scope_and_pending_tamper_fail_before_any_hook(self):
        original = self.scope['project_id']
        self.scope['project_id'] = 'proj_' + 'b' * 32
        with self.assertRaisesRegex(runtime.RuntimeGate, 'scope_mismatch'):
            self.run_upload()
        self.scope['project_id'] = original
        self.pending()[0].write_text('{}')
        with self.assertRaisesRegex(runtime.RuntimeGate, 'hash_mismatch'):
            self.run_upload()
        self.assertEqual(sum(self.calls.values()), 0)

    def test_stale_lock_never_expires_or_is_taken_over(self):
        path = self.workspace / runtime.LOCK_NAME
        path.write_text('stale')
        path.chmod(0o600)
        with self.assertRaisesRegex(runtime.RuntimeGate, 'locked_reconciliation'):
            self.run_upload()
        self.assertEqual(path.read_text(), 'stale')
        self.assertEqual(sum(self.calls.values()), 0)

    def test_python_lock_blocks_node_capture_before_hooks(self):
        with runtime.workspace_lock(self.workspace):
            result = subprocess.run(['node', '--input-type=module', '-e', capture_script(self.workspace)],
                                    timeout=3, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('workspace_locked_reconciliation_required', result.stderr)

    def test_node_lock_blocks_python_upload_before_hooks(self):
        script = '''import {acquireWorkspaceLock} from %s;
          const lock=acquireWorkspaceLock(%s);console.log('locked');
          await new Promise(resolve=>process.stdin.once('data',resolve));lock.release();
        ''' % (json.dumps((JS / 'private-workspace-lock.mjs').as_uri()), json.dumps(str(self.workspace)))
        child = subprocess.Popen(['node', '--input-type=module', '-e', script], stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), 'locked')
            with self.assertRaisesRegex(runtime.RuntimeGate, 'locked_reconciliation'):
                self.run_upload()
            self.assertEqual(sum(self.calls.values()), 0)
        finally:
            child.communicate('release', timeout=3)

    def test_failure_after_unlink_before_accepted_journal_requires_reconciliation(self):
        module = runtime._uploader()
        original = module.atomic_write
        def fail_accepted(path, data):
            if path.name == 'upload-receipts.json' and any(x['status'] == 'accepted' for x in json.loads(data)['entries'].values()):
                raise OSError('synthetic local receipt failure')
            return original(path, data)
        module.atomic_write = fail_accepted
        with patch.object(runtime, '_uploader', return_value=module):
            with self.assertRaises(OSError):
                self.run_upload()
        self.assertEqual(self.pending(), [])
        self.calls = dict.fromkeys(self.calls, 0)
        self.assertEqual(self.run_upload()['outcome'], 'reconciliation-required')
        self.assertEqual(sum(self.calls.values()), 0)

    def test_expiry_during_ack_read_does_not_delete_pending(self):
        wall = [1000]
        def expire(request, timeout):
            return Reply(request, on_read=lambda: wall.__setitem__(0, 2000))
        result = self.run_upload(transport=expire, now=lambda: wall[0])
        self.assertEqual(result['outcome'], 'reconciliation-required')
        self.assertEqual(len(self.pending()), 1)

    def test_foreign_response_target_is_closed_and_retained(self):
        replies = []
        def foreign(request, timeout):
            response = Reply(request, url='https://foreign.invalid/')
            replies.append(response)
            return response
        self.assertEqual(self.run_upload(transport=foreign)['outcome'], 'reconciliation-required')
        self.assertTrue(replies[0].closed)
        self.assertEqual(len(self.pending()), 1)

    def test_fifo_binding_is_rejected_before_hooks(self):
        path = self.workspace / 'binding.json'
        path.unlink()
        os.mkfifo(path, 0o600)
        with self.assertRaisesRegex(runtime.RuntimeGate, 'file_unsafe'):
            self.run_upload()
        self.assertEqual(sum(self.calls.values()), 0)

    def test_request_budget_pauses_before_another_credential_or_request(self):
        shutil.rmtree(self.workspace)
        self.capture(rows=2)
        receipt = json.loads((self.workspace / 'stage-receipt.json').read_text())
        self.scope.update(fingerprint=receipt['fingerprint'], conversion_hash=receipt['conversionHash'],
                          manifest_hash=receipt['manifestHash'], max_requests=1)
        first = self.run_upload()
        self.assertEqual(first['outcome'], 'bounded-pending')
        self.assertEqual(self.calls['credentials'], 1)
        self.assertEqual(self.calls['transport'], 1)
        second = self.run_upload()
        self.assertTrue(second['all_batches_acknowledged'])
        self.assertEqual(self.calls['transport'], 2)

    def test_process_exit_keeps_lock_and_attempting_journal_fail_closed(self):
        script = '''import os,sys,json
sys.path.insert(0,%s)
import private_upload_runtime as runtime
def interrupted(request, timeout): os._exit(77)
runtime.upload_staged_workspace(%s,%s,
    authorize=lambda _:True,
    credential_provider=lambda _:{'origin':'https://supatrace.dev','project_id':%s,
      'write_key':'x'*43,'expires_at':1060},
    transport=interrupted,now=lambda:1000)
''' % (repr(str(HERE)), repr(str(self.workspace)), repr(self.scope), repr(PROJECT))
        child = subprocess.run(['python3', '-c', script], timeout=5, capture_output=True)
        self.assertEqual(child.returncode, 77, child.stderr.decode())
        lock = self.workspace / runtime.LOCK_NAME
        self.assertTrue(lock.exists())
        journal = json.loads((self.workspace / 'upload-receipts.json').read_text())
        self.assertEqual(next(iter(journal['entries'].values()))['status'], 'attempting')
        with self.assertRaisesRegex(runtime.RuntimeGate, 'locked_reconciliation'):
            self.run_upload()
        self.assertEqual(sum(self.calls.values()), 0)
        # Explicit test-owner cleanup only after the owned process is confirmed dead.
        lock.unlink()
        self.assertEqual(self.run_upload()['outcome'], 'reconciliation-required')
        self.assertEqual(sum(self.calls.values()), 0)

    def test_byte_bound_fails_before_credentials_or_requests(self):
        self.scope['max_total_bytes'] = 1
        with self.assertRaisesRegex(runtime.RuntimeGate, 'pending_scope_invalid'):
            self.run_upload()
        self.assertEqual(sum(self.calls.values()), 0)

    def test_coordinated_pending_manifest_receipt_tamper_cannot_change_approved_bytes(self):
        pending = self.pending()[0]
        batch = json.loads(pending.read_text())
        batch['events'][0]['data']['observation']['input']['n'] = 999
        body = runtime.canonical(batch)
        changed_hash = hashlib.sha256(body).hexdigest()
        pending.unlink()
        changed_path = pending.parent / (changed_hash + '.json')
        changed_path.write_bytes(body)
        changed_path.chmod(0o600)
        manifest_path = pending.parent / 'import-manifest.json'
        manifest = json.loads(manifest_path.read_text())
        manifest['batches'][0].update(request_hash=changed_hash, pending_file=changed_path.name)
        manifest_path.write_bytes(runtime.canonical(manifest))
        receipt_path = self.workspace / 'stage-receipt.json'
        receipt = json.loads(receipt_path.read_text())
        receipt['manifestHash'] = runtime.digest(manifest)
        receipt_path.write_bytes(runtime.canonical(receipt))
        with self.assertRaisesRegex(runtime.RuntimeGate, 'manifest_invalid'):
            self.run_upload()
        self.assertEqual(sum(self.calls.values()), 0)

    def test_duplicate_ack_fields_are_never_accepted(self):
        def duplicate(request, timeout):
            reply = Reply(request)
            body = reply.body.getvalue().replace(b'"accepted": true', b'"accepted": false, "accepted": true')
            reply.body = io.BytesIO(body)
            return reply
        self.assertEqual(self.run_upload(transport=duplicate)['outcome'], 'reconciliation-required')
        self.assertEqual(len(self.pending()), 1)

    def test_oversize_ack_is_never_accepted(self):
        def oversize(request, timeout):
            reply = Reply(request)
            reply.body = io.BytesIO(reply.body.getvalue().ljust(8193, b' '))
            return reply
        self.assertEqual(self.run_upload(transport=oversize)['outcome'], 'reconciliation-required')
        self.assertEqual(len(self.pending()), 1)


    def test_destination_environment_binds_lease_wire_ack_and_receipt_journal(self):
        self.scope['environment_id']='development'
        def credentials(binding):
            self.assertEqual(binding['environment_id'],'development')
            return {**self.credentials(binding),'environment_id':'development'}
        def transport(request,timeout):
            self.assertIn('environment=development',request.full_url)
            reply=Reply(request);ack=json.loads(reply.body.getvalue());ack['environment_id']='development';reply.body=io.BytesIO(json.dumps(ack).encode());return reply
        self.assertTrue(self.run_upload(credential_provider=credentials,transport=transport)['all_batches_acknowledged'])
        journal=json.loads((self.workspace/'upload-receipts.json').read_text())
        self.assertEqual(journal['scope']['environment_id'],'development')
        self.assertEqual(next(iter(journal['entries'].values()))['receipt']['environment_id'],'development')
        self.scope['environment_id']='production'
        with self.assertRaisesRegex(runtime.RuntimeGate,'journal_scope_mismatch'):self.run_upload()

    def test_destination_environment_rejects_missing_lease_binding_before_wire(self):
        self.scope['environment_id']='development'
        with self.assertRaisesRegex(runtime.RuntimeGate,'credential_binding_invalid'):self.run_upload()
        self.assertEqual(self.calls['transport'],0)

    def test_environment_missing_ack_stays_uncertain_and_does_not_replay(self):
        self.scope['environment_id']='development'
        credentials=lambda binding:{**self.credentials(binding),'environment_id':'development'}
        self.assertFalse(self.run_upload(credential_provider=credentials)['all_batches_acknowledged'])
        count=self.calls['transport'];self.assertFalse(self.run_upload(credential_provider=credentials)['all_batches_acknowledged']);self.assertEqual(self.calls['transport'],count)



if __name__ == '__main__':
    unittest.main()
