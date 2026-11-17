"""Synthetic hooks and in-process transports only; no native Claude or provider calls."""
import hashlib
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'agent'))
import claude_hook as hook

ROOT = Path(__file__).resolve().parent.parent
PROJECT = 'proj_' + 'a' * 32
SECRET = 'synthetic-secret-not-a-real-credential-0123456789'
SENTINEL = 'PRIVATE_CONTENT_SENTINEL_never_in_status'


class Reply:
    status = 201
    def __init__(self, request, *, project=PROJECT, change=None):
        self.url = request.full_url
        self.closed = False
        batch = json.loads(request.data)
        ack = {'accepted': True, 'batch_id': batch['batch_id'],
               'request_hash': hashlib.sha256(request.data).hexdigest(), 'project_id': project}
        self.raw = hook.canonical(ack) if change is None else change(ack)
    def __enter__(self): return self
    def __exit__(self, *_): self.closed = True
    def geturl(self): return self.url
    def read(self, size): return self.raw[:size]


class HookTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='supatrace-hooks-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.workspace = self.base / 'source workspace'
        self.workspace.mkdir()
        self.spool = self.base / 'private spool'
        self.config = self.base / 'access.json'
        self.config.write_text(json.dumps({'approved': True, 'origin': 'https://supatrace.dev',
                                          'project_id': PROJECT, 'write_key': SECRET}))
        self.config.chmod(0o600)
        hook.initialize(self.spool, self.workspace, self.config)
        self.requests = []

    def payload(self, event='UserPromptSubmit', **changes):
        payload = {'hook_event_name': event, 'session_id': 'session-123', 'prompt_id': 'prompt-1',
                   'cwd': str(self.workspace), 'transcript_path': '/DO_NOT_READ/' + SENTINEL,
                   'scratchpad_dir': SENTINEL, 'arbitrary': SENTINEL}
        if event == 'UserPromptSubmit': payload['prompt'] = SENTINEL
        elif event == 'PostToolUse':
            payload.update(tool_use_id='tool-1', tool_name='Read',
                           tool_input={'file_path': SENTINEL}, tool_response={'output': SENTINEL})
        else: payload.update(stop_hook_active=False, last_assistant_message=SENTINEL)
        return {**payload, **changes}

    def capture(self, event='UserPromptSubmit', **changes):
        return hook.capture(self.spool, io.BytesIO(hook.canonical(self.payload(event, **changes))), cwd=self.workspace)

    def state(self): return hook.read_state(self.spool)

    def content_spool(self, auto=False):
        self.spool = self.base / 'content spool'
        hook.initialize(self.spool, self.workspace, self.config, content=True,
                        allow_content=True, upload_on_stop=auto)

    def transport(self, request, timeout):
        self.requests.append(request)
        self.assertLessEqual(timeout, 3)
        self.assertEqual(request.get_header('X-supatrace-key'), SECRET)
        self.assertEqual(request.full_url, 'https://supatrace.dev/api/batches?project=' + PROJECT)
        return Reply(request)

    def test_metadata_drops_content_paths_environment_and_their_hashes(self):
        for event in hook.EVENTS: self.capture(event)
        raw = (self.spool / 'state.json').read_text()
        for banned in (SENTINEL, SECRET, 'transcript_path', 'scratchpad_dir', hashlib.sha256(SENTINEL.encode()).hexdigest()):
            self.assertNotIn(banned, raw)
        report = hook.status(self.spool)
        self.assertEqual((report['state'], report['captured'], report['pending']), ('pending', 3, 3))
        self.assertFalse(report['complete_session'])
        self.assertFalse(report['recording_now_verified'])

    def test_content_requires_explicit_allowance(self):
        with self.assertRaises(hook.Gate):
            hook.initialize(self.base / 'denied', self.workspace, self.config, content=True)
        self.assertFalse((self.base / 'denied').exists())

    def test_content_preserved_but_not_status_or_filenames(self):
        self.content_spool()
        for event in hook.EVENTS: self.capture(event)
        rows = self.state()['records']
        self.assertEqual(rows[0]['event']['data']['prompt'], SENTINEL)
        self.assertEqual(rows[1]['event']['data']['tool_response'], {'output': SENTINEL})
        self.assertEqual(rows[2]['event']['data']['last_assistant_message'], SENTINEL)
        self.assertNotIn(SENTINEL, json.dumps(hook.status(self.spool)))
        self.assertTrue(all(SENTINEL not in path.name for path in self.spool.iterdir()))

    def test_duplicate_keeps_first_timestamp_event_and_ack_after_restart(self):
        self.capture()
        first = self.state()['records'][0]
        hook.flush(self.spool, transport=self.transport)
        self.assertTrue(self.capture()['duplicate'])
        self.assertEqual(self.state()['records'][0]['event'], first['event'])
        result = hook.flush(self.spool, transport=self.transport)
        self.assertEqual((result['accepted'], len(self.requests)), (1, 1))

    def test_same_text_different_prompt_and_subagent_ids_remain_distinct(self):
        self.capture()
        self.capture(prompt_id='prompt-2')
        self.capture(agent_id='subagent-1')
        self.capture(agent_id='main')
        self.assertEqual(len({row['event']['id'] for row in self.state()['records']}), 4)
        self.assertEqual(len({row['run_id'] for row in self.state()['records']}), 3)

    def test_changed_content_identity_conflicts_without_overwrite(self):
        self.content_spool()
        self.capture()
        old = self.state()['records'][0]
        with self.assertRaisesRegex(hook.Gate, 'identity_conflict'): self.capture(prompt='different')
        self.assertEqual(self.state()['records'][0], old)

    def test_metadata_duplicate_ignores_content_without_hashing_it(self):
        self.capture()
        self.assertTrue(self.capture(prompt='different')['duplicate'])

    def test_stops_use_local_occurrence_never_text_dedup(self):
        self.capture('Stop')
        self.capture('Stop')
        rows = self.state()['records']
        self.assertNotEqual(rows[0]['event']['id'], rows[1]['event']['id'])
        self.assertTrue(all(row['identity'] is None for row in rows))
        self.assertIn('not_native_exactly_once', rows[0]['event']['data']['delivery_identity'])

    def test_native_identity_missing_or_invalid_is_not_fabricated(self):
        for changes in ({'prompt_id': None}, {'session_id': ''}, {'agent_id': '../escape'}):
            with self.assertRaisesRegex(hook.Gate, 'missing_identity'): self.capture(**changes)
        with self.assertRaisesRegex(hook.Gate, 'missing_identity'):
            self.capture('PostToolUse', tool_use_id=None)
        self.assertEqual(hook.status(self.spool)['captured'], 0)

    def test_unsupported_failure_interrupt_not_faked_as_stop(self):
        with self.assertRaisesRegex(hook.Gate, 'unsupported_event'): self.capture('StopFailure')
        self.capture()
        self.assertEqual(len(self.state()['records']), 1)  # No synthetic Stop on interruption.

    def test_source_scope_cwd_and_symlinks_fail_closed(self):
        with self.assertRaisesRegex(hook.Gate, 'outside_workspace'): self.capture(cwd=str(self.base))
        link = self.workspace / 'link'
        link.symlink_to(self.base, target_is_directory=True)
        with self.assertRaisesRegex(hook.Gate, 'private_path'): self.capture(cwd=str(link))

    def test_private_config_and_spool_permissions(self):
        self.assertEqual(self.spool.stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.spool / 'state.json').stat().st_mode & 0o777, 0o600)
        self.config.chmod(0o644)
        self.capture()
        with self.assertRaisesRegex(hook.Gate, 'private_path'): hook.flush(self.spool, transport=self.transport)
        self.assertEqual(self.requests, [])

    def test_cannot_reset_existing_spool_or_store_it_in_source_workspace(self):
        with self.assertRaises(FileExistsError): hook.initialize(self.spool, self.workspace, self.config)
        with self.assertRaisesRegex(hook.Gate, 'private_path'):
            hook.initialize(self.workspace / 'spool', self.workspace, self.config)

    def test_symlink_and_hardlinked_state_are_rejected(self):
        path = self.spool / 'state.json'
        target = self.base / 'state.json'
        path.rename(target)
        path.symlink_to(target)
        with self.assertRaisesRegex(hook.Gate, 'private_path'): hook.status(self.spool)
        path.unlink()
        os.link(target, path)
        with self.assertRaisesRegex(hook.Gate, 'private_path'): hook.status(self.spool)

    def test_oversize_stdin_content_depth_duplicate_keys_nonfinite(self):
        for raw in (b' ' * (hook.INPUT_BYTES + 1), b'{"x":1,"x":2}', b'{"x":NaN}',
                    b'[' * 40 + b'0' + b']' * 40, b'{"x":9007199254740992}', b'{"x":"\\ud800"}'):
            with self.assertRaises(hook.Gate): hook.capture(self.spool, io.BytesIO(raw), cwd=self.workspace)
        self.content_spool()
        with self.assertRaisesRegex(hook.Gate, 'capacity'): self.capture(prompt='x' * hook.DATA_BYTES)
        self.assertEqual(hook.status(self.spool)['captured'], 0)

    def test_capacity_and_atomic_write_failure_never_claim_capture(self):
        with patch.object(hook, 'MAX_RECORDS', 0):
            with self.assertRaisesRegex(hook.Gate, 'capacity'): self.capture()
        with patch('upload.atomic_write', side_effect=OSError(SENTINEL)):
            with self.assertRaises(OSError): self.capture()
        self.assertEqual(hook.status(self.spool)['captured'], 0)

    def test_capture_never_performs_network_by_default(self):
        with patch('urllib.request.build_opener', side_effect=AssertionError('no network')):
            for event in hook.EVENTS: self.assertFalse(self.capture(event)['stop_upload'])

    def test_stop_upload_flag_is_explicit_and_only_at_stop(self):
        self.content_spool(auto=True)
        self.assertFalse(self.capture()['stop_upload'])
        self.assertFalse(self.capture('PostToolUse')['stop_upload'])
        self.assertTrue(self.capture('Stop')['stop_upload'])

    def test_matching_ack_alone_accepts_and_repeated_flush_has_no_request(self):
        for event in hook.EVENTS: self.capture(event)
        result = hook.flush(self.spool, transport=self.transport)
        self.assertEqual((result['accepted'], result['pending'], result['uncertain']), (3, 0, 0))
        self.assertFalse(result['hosted_readback_verified'])
        self.assertEqual([event['name'] for event in json.loads(self.requests[0].data)['events']], list(hook.EVENTS))
        hook.flush(self.spool, transport=self.transport)
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(list(self.spool.glob('[a-f0-9]' * 64 + '.json')), [])

    def test_wrong_project_ack_and_duplicate_ack_keys_are_uncertain_without_retry(self):
        self.capture()
        result = hook.flush(self.spool, transport=lambda r, **_: Reply(r, project='proj_' + 'b' * 32))
        self.assertEqual(result['state'], 'uncertain')
        self.assertEqual(len(list(self.spool.glob('[a-f0-9]' * 64 + '.json'))), 1)
        hook.flush(self.spool, transport=self.transport)
        self.assertEqual(self.requests, [])
        other = self.base / 'another'
        hook.initialize(other, self.workspace, self.config)
        hook.capture(other, io.BytesIO(hook.canonical(self.payload())), cwd=self.workspace)
        with self.assertRaises(hook.Gate):
            hook.flush(other, transport=lambda r, **_: Reply(r, change=lambda ack: b'{"accepted":false,' + hook.canonical(ack)[1:]))
        self.assertEqual(hook.status(other)['state'], 'uncertain')

    def test_lost_ack_http_rate_quota_revoke_and_redirect_remain_fenced(self):
        def failure(*_, **__): raise OSError(SENTINEL)
        self.capture()
        self.assertEqual(hook.flush(self.spool, transport=failure)['state'], 'uncertain')
        self.capture(prompt_id='next-prompt')
        self.assertEqual(hook.flush(self.spool, transport=self.transport)['state'], 'uncertain')
        self.assertEqual(self.requests, [])
        for code in (401, 403, 429, 507, 302):
            spool = self.base / str(code)
            hook.initialize(spool, self.workspace, self.config)
            hook.capture(spool, io.BytesIO(hook.canonical(self.payload())), cwd=self.workspace)
            def reject(request, **_):
                reply = Reply(request)
                reply.status = code
                return reply
            self.assertEqual(hook.flush(spool, transport=reject)['state'], 'uncertain')

    def test_changed_destination_config_and_pending_tamper_never_send(self):
        self.capture()
        config = json.loads(self.config.read_text())
        config['project_id'] = 'proj_' + 'b' * 32
        self.config.write_text(json.dumps(config))
        with self.assertRaisesRegex(hook.Gate, 'binding'): hook.flush(self.spool, transport=self.transport)
        self.assertEqual(self.requests, [])
        config['project_id'] = PROJECT
        self.config.write_text(json.dumps(config))
        with hook.lock(self.spool):
            state = self.state()
            batch = hook.prepare_batch(state)
            hook.save_state(self.spool, state)
        pending = self.spool / (batch['hash'] + '.json')
        pending.write_text('{}')
        pending.chmod(0o600)
        with self.assertRaisesRegex(hook.Gate, 'binding'): hook.flush(self.spool, transport=self.transport)
        self.assertEqual(self.requests, [])

    def test_crashed_attempt_and_post_ack_journal_failure_never_resend(self):
        self.capture()
        original_save = hook.save_state
        def fail_after_ack(directory, state):
            if any(batch['status'] == 'accepted' for batch in state['batches']): raise OSError('disk full')
            original_save(directory, state)
        with patch.object(hook, 'save_state', side_effect=fail_after_ack):
            with self.assertRaises(OSError): hook.flush(self.spool, transport=self.transport)
        self.assertEqual(hook.status(self.spool)['state'], 'uncertain')
        self.assertEqual(hook.flush(self.spool, transport=self.transport)['state'], 'uncertain')
        self.assertEqual(len(self.requests), 1)

    def test_capture_during_network_not_overwritten_by_flush_snapshot(self):
        self.capture()
        def concurrent(request, timeout):
            if not self.requests: self.capture(prompt_id='parallel')
            return self.transport(request, timeout)
        with patch('time.sleep', return_value=None):
            result = hook.flush(self.spool, transport=concurrent)
        self.assertEqual((result['captured'], result['accepted']), (2, 2))

    def test_hard_deadline_interrupts_slow_response_and_retains_uncertain(self):
        self.capture()
        # Isolate the in-flight response boundary. Disk preparation is part of
        # the real total budget and may legitimately expire before any request.
        set_timer = signal.setitimer
        armed, reading = [], []
        def defer_timer(which, seconds, *args):
            if seconds:
                armed.append((which, seconds))
                return (0, 0)
            return set_timer(which, seconds, *args)
        def slow(request, **_):
            reply = Reply(request)
            def read(_):
                reading.append(time.monotonic())
                set_timer(signal.ITIMER_REAL, 0.05)
                time.sleep(10)
            reply.read = read
            return reply
        with patch.object(signal, 'setitimer', side_effect=defer_timer):
            with self.assertRaisesRegex(hook.Gate, 'deadline'):
                hook.flush(self.spool, transport=slow, budget=0.1)
        self.assertEqual(armed, [(signal.ITIMER_REAL, 0.1)])
        self.assertEqual(len(reading), 1)
        self.assertLess(time.monotonic() - reading[0], 1)
        self.assertEqual(hook.status(self.spool)['state'], 'uncertain')
        self.assertEqual(signal.getitimer(signal.ITIMER_REAL), (0, 0))

    def test_deadline_before_request_retains_pending_and_can_resume(self):
        self.capture()
        original_save = hook.save_state
        def expire_after_assignment(directory, state):
            original_save(directory, state)
            signal.raise_signal(signal.SIGALRM)
        with patch.object(hook, 'save_state', side_effect=expire_after_assignment):
            with self.assertRaisesRegex(hook.Gate, 'deadline'):
                hook.flush(self.spool, transport=self.transport)
        self.assertEqual(len(self.requests), 0)
        self.assertEqual(hook.status(self.spool)['state'], 'pending')
        self.assertEqual(signal.getitimer(signal.ITIMER_REAL), (0, 0))
        self.assertEqual(hook.flush(self.spool, transport=self.transport)['state'], 'accepted')
        self.assertEqual(len(self.requests), 1)

    def test_never_replaces_existing_alarm(self):
        signal.setitimer(signal.ITIMER_REAL, 20)
        try:
            with self.assertRaisesRegex(hook.Gate, 'configuration'): hook.flush(self.spool, transport=self.transport)
            self.assertGreater(signal.getitimer(signal.ITIMER_REAL)[0], 19)
        finally: signal.setitimer(signal.ITIMER_REAL, 0)

    def test_batches_obey_byte_event_and_two_request_bounds(self):
        for index in range(205): self.capture(prompt_id='prompt-' + str(index))
        with patch('time.sleep', return_value=None): result = hook.flush(self.spool, transport=self.transport)
        self.assertEqual((len(self.requests), result['accepted'], result['pending']), (2, 200, 5))
        self.assertTrue(all(len(json.loads(request.data)['events']) <= 100 and len(request.data) <= hook.BATCH_BYTES for request in self.requests))
        hook.flush(self.spool, transport=self.transport)
        self.assertEqual(hook.status(self.spool)['accepted'], 205)
        self.content_spool()
        self.requests = []
        for index in range(20): self.capture(prompt_id='large-' + str(index), prompt='x' * 31000)
        with patch('time.sleep', return_value=None): result = hook.flush(self.spool, transport=self.transport)
        self.assertEqual((len(self.requests), result['accepted']), (2, 20))
        self.assertTrue(all(len(request.data) <= hook.BATCH_BYTES for request in self.requests))

    def test_capture_cli_suppresses_imported_output_and_interrupts(self):
        output, errors = io.StringIO(), io.StringIO()
        with patch.object(hook, 'capture', return_value={'stop_upload': True}), patch.object(hook, 'flush', side_effect=lambda _: print(SENTINEL)), patch('sys.stdout', output), patch('sys.stderr', errors):
            self.assertEqual(hook.main(['capture', '--spool', str(self.spool)]), 0)
        self.assertEqual(output.getvalue(), '')
        with patch.object(hook, 'capture', side_effect=KeyboardInterrupt), patch('sys.stdout', output), patch('sys.stderr', errors):
            self.assertEqual(hook.main(['capture', '--spool', str(self.spool)]), 0)
        self.assertEqual(output.getvalue(), '')
        self.assertNotIn(SENTINEL, errors.getvalue())

    def test_deep_accepted_payload_round_trips_through_journal_and_flush(self):
        self.content_spool()
        for depth in range(20, 24):
            nested = 'leaf'
            for _ in range(depth): nested = {'x': nested}
            self.capture('PostToolUse', tool_use_id='depth-' + str(depth), tool_response=nested)
            self.assertGreater(hook.status(self.spool)['captured'], 0)
        self.assertEqual(hook.flush(self.spool, transport=self.transport)['accepted'], 4)

    def test_ack_unlink_during_inventory_does_not_drop_capture(self):
        self.capture()
        with hook.lock(self.spool):
            state = self.state(); batch = hook.prepare_batch(state); hook.save_state(self.spool, state)
        pending = self.spool / (batch['hash'] + '.json')
        pending.write_bytes(hook.body_for(state, batch)); pending.chmod(0o600)
        original = Path.lstat
        def vanished(path):
            if path == pending and pending.exists(): pending.unlink()
            return original(path)
        with patch.object(Path, 'lstat', vanished): self.capture(prompt_id='after-unlink')
        self.assertEqual(hook.status(self.spool)['captured'], 2)

    def test_pending_assignment_survives_materialization_failure_without_orphans(self):
        self.capture()
        original = __import__('upload').atomic_write
        def fail_pending(path, raw):
            if Path(path).name != 'state.json': raise OSError('disk full')
            original(path, raw)
        with patch('upload.atomic_write', side_effect=fail_pending):
            with self.assertRaises(OSError): hook.flush(self.spool, transport=self.transport)
        batch = self.state()['batches'][0]
        self.assertEqual(batch['status'], 'pending')
        self.capture(prompt_id='later')
        with patch('time.sleep', return_value=None): hook.flush(self.spool, transport=self.transport)
        self.assertEqual(json.loads(self.requests[0].data)['batch_id'], batch['batch_id'])
        self.assertEqual(hook.status(self.spool)['accepted'], 2)

    def test_unknown_spool_file_and_aggregate_limit_fail_closed(self):
        orphan = self.spool / ('a' * 64 + '.json')
        orphan.write_text('{}'); orphan.chmod(0o600)
        with self.assertRaisesRegex(hook.Gate, 'storage'): self.capture()
        self.assertTrue(orphan.exists())
        orphan.unlink()
        with patch.object(hook, 'SPOOL_BYTES', 1):
            with self.assertRaisesRegex(hook.Gate, 'capacity'): self.capture()

    def test_content_spool_cannot_be_relabelled_metadata(self):
        self.content_spool()
        self.capture()
        state = self.state(); state['binding']['mode'] = 'metadata'
        (self.spool / 'state.json').write_bytes(hook.canonical(state))
        with self.assertRaisesRegex(hook.Gate, 'binding'): hook.flush(self.spool, transport=self.transport)
        self.assertEqual(self.requests, [])

    def test_no_unnecessary_pacing_and_invalid_deadlines_cannot_disable_timer(self):
        self.capture()
        with patch('time.sleep', side_effect=AssertionError('unexpected pacing')):
            hook.flush(self.spool, transport=self.transport)
        for budget in (0, -1, float('inf'), float('nan'), True):
            with self.assertRaisesRegex(hook.Gate, 'configuration'): hook.flush(self.spool, transport=self.transport, budget=budget)

    def test_parallel_native_tool_hooks_preserve_all_sequences(self):
        children = []
        for index in range(6):
            child = subprocess.Popen([sys.executable, str(ROOT / 'agent/claude_hook.py'), 'capture', '--spool', str(self.spool)],
                                     cwd=self.workspace, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            child.stdin.write(hook.canonical(self.payload('PostToolUse', tool_use_id='tool-' + str(index))))
            child.stdin.close()
            children.append(child)
        for child in children:
            child.wait(timeout=5)
            self.assertEqual(child.returncode, 0)
            self.assertEqual(child.stdout.read(), b'')
            self.assertEqual(child.stderr.read(), b'')
            child.stdout.close(); child.stderr.close()
        self.assertEqual([row['seq'] for row in self.state()['records']], list(range(1, 7)))

    def test_cli_errors_are_nonblocking_sanitized_and_counted_when_possible(self):
        for args, raw in ((['capture', '--spool', str(self.spool)], SENTINEL.encode()),
                          (['capture', '--unexpected', SENTINEL], b'{}'),
                          (['capture', '--help'], b'{}')):
            result = subprocess.run([sys.executable, str(ROOT / 'agent/claude_hook.py'), *args], input=raw,
                                    cwd=self.workspace, capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stdout, b'')
            self.assertNotIn(SENTINEL.encode(), result.stderr)
        self.assertEqual(hook.status(self.spool)['omissions']['invalid_input'], 1)

    def test_real_closed_stderr_pipe_still_exits_zero(self):
        child = subprocess.Popen([sys.executable, str(ROOT / 'agent/claude_hook.py'), 'capture', '--spool', str(self.spool)],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=self.workspace)
        child.stderr.close()
        child.stdin.write(b'not-json'); child.stdin.close()
        child.wait(timeout=5)
        self.assertEqual(child.stdout.read(), b''); child.stdout.close()
        self.assertEqual(child.returncode, 0)

    def test_capture_lock_contention_has_bounded_nonblocking_health(self):
        with hook.lock(self.spool):
            result = subprocess.run([sys.executable, str(ROOT / 'agent/claude_hook.py'), 'capture', '--spool', str(self.spool)],
                                    input=hook.canonical(self.payload()), cwd=self.workspace, capture_output=True, timeout=3)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b'')
        self.assertIn(b'locked', result.stderr)
        self.assertIn(b'could not be recorded', result.stderr)


    def test_environment_config_change_cannot_rebind_existing_capture_journal(self):
        self.capture();config=json.loads(self.config.read_text());config['environment_id']='development';self.config.write_text(json.dumps(config))
        with self.assertRaises(hook.Gate):hook.flush(self.spool,transport=self.transport)
        self.assertEqual(self.requests,[])

    def test_environment_capture_upload_requires_matching_ack(self):
        config=json.loads(self.config.read_text());config['environment_id']='development';self.config.write_text(json.dumps(config))
        self.spool=self.base/'development spool';hook.initialize(self.spool,self.workspace,self.config);self.capture()
        def transport(request,timeout):
            self.assertIn('environment=development',request.full_url)
            return Reply(request,change=lambda ack:hook.canonical({**ack,'environment_id':'development'}))
        result=hook.flush(self.spool,transport=transport)
        self.assertTrue(all(row['status']=='accepted' for row in self.state()['batches']))
        self.assertEqual(self.state()['binding']['environment_id'],'development')



if __name__ == '__main__': unittest.main()
