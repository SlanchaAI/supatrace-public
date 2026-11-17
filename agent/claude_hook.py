#!/usr/bin/env python3
"""Opt-in, project-scoped Claude Code stdin capture. No transcript reads or installer.

POSIX Python 3 only. Capture always exits zero without stdout. Content is NOT
redacted. A matching upload ACK is not hosted readback or a complete session.
"""
import argparse
import contextlib
import datetime
import fcntl
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import signal
import stat
import sys
import threading
import time
import urllib.request
import uuid

INPUT_BYTES = 262144
STATE_BYTES = 8 * 1024 * 1024
SPOOL_BYTES = 24 * 1024 * 1024  # Includes one atomic-write temporary copy.
MAX_RECORDS = 2000
BATCH_BYTES = 524288
DATA_BYTES = 32768
LOCK_SECONDS = 0.75
FLUSH_SECONDS = 8
PROJECT = re.compile(r'proj_[a-f0-9]{32}')
NATIVE_ID = re.compile(r'[A-Za-z0-9_.:-]{1,256}')
EVENTS = {'UserPromptSubmit': 'request', 'PostToolUse': 'tool_result', 'Stop': 'response'}
CODES = {'invalid_input', 'unsupported_event', 'missing_identity', 'outside_workspace',
         'identity_conflict', 'capacity', 'private_path', 'locked', 'storage', 'binding',
         'deadline', 'configuration', 'interrupted', 'internal'}


class Gate(Exception):
    def __init__(self, code):
        self.code = code if code in CODES else 'internal'
        super().__init__(self.code)


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False,
                      separators=(',', ':')).encode('utf-8')


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def decode(raw, max_depth=24):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise Gate('invalid_input')
            result[key] = value
        return result
    try:
        value = json.loads(raw, object_pairs_hook=pairs,
                           parse_constant=lambda _: (_ for _ in ()).throw(Gate('invalid_input')))
        def check(item, depth=0):
            if depth > max_depth:
                raise Gate('invalid_input')
            if isinstance(item, (int, float)) and not isinstance(item, bool):
                if not math.isfinite(item) or abs(item) > 9007199254740991:
                    raise Gate('invalid_input')
            if isinstance(item, dict):
                for child in item.values(): check(child, depth + 1)
            elif isinstance(item, list):
                for child in item: check(child, depth + 1)
        check(value)
        canonical(value)  # Reject lone surrogates as well as non-finite JSON.
        return value
    except (ValueError, UnicodeError, RecursionError, OverflowError):
        raise Gate('invalid_input') from None


def absolute(path):
    """Reject symlinks/traversal, including ancestors; never silently follow them."""
    path = Path(path).expanduser()
    if '..' in path.parts:
        raise Gate('private_path')
    path = Path(os.path.abspath(path))
    for part in [*reversed(path.parents), path]:
        if part.is_symlink():
            raise Gate('private_path')
    return path


def private_dir(path):
    path = absolute(path)
    info = path.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise Gate('private_path')
    return path


def private_read(path, limit):
    path = absolute(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_mode & 0o077 or info.st_nlink != 1 or info.st_size > limit):
            raise Gate('private_path')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            raw = stream.read(limit + 1)
        if len(raw) > limit:
            raise Gate('capacity')
        return raw
    finally:
        os.close(fd)


def access(path):
    config = decode(private_read(path, 8192))
    from upload import ORIGINS
    if (not isinstance(config, dict) or config.get('approved') is not True
            or config.get('origin') not in ORIGINS
            or not PROJECT.fullmatch(config.get('project_id', ''))
            or 'environment_id' in config and (not isinstance(config['environment_id'],str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,31}',config['environment_id']))
            or not isinstance(config.get('write_key'), str)
            or not re.fullmatch(r'[A-Za-z0-9_-]{32,128}', config['write_key'])):
        raise Gate('configuration')
    return config


@contextlib.contextmanager
def lock(directory, name='journal.lock'):
    path = directory / name
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_mode & 0o077 or info.st_nlink != 1):
            raise Gate('private_path')
        deadline = time.monotonic() + LOCK_SECONDS
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise Gate('locked') from None
                time.sleep(0.01)
        yield
    finally:
        os.close(fd)  # OS releases the lock, including after process death.


def read_state(directory):
    # The journal adds record/event wrappers around input with depth <=24.
    state = decode(private_read(directory / 'state.json', STATE_BYTES), max_depth=32)
    binding = state['binding']
    if (state.get('version') != 1 or binding['spool'] != str(directory)
            or binding['mode'] not in ('metadata', 'content')
            or not PROJECT.fullmatch(binding['project_id'])
            or 'environment_id' in binding and (not isinstance(binding['environment_id'],str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,31}',binding['environment_id']))
            or binding['origin'] not in ('https://supatrace.dev', 'https://supatrace.tech')
            or type(binding['upload_on_stop']) is not bool
            or len(state['records']) > MAX_RECORDS):
        raise Gate('binding')
    for index, row in enumerate(state['records'], 1):
        data = row['event']['data']
        if (row['seq'] != index or data['capture_sequence'] != index
                or data['content_included'] != (binding['mode'] == 'content')
                or row['payload_hash'] != digest({key: value for key, value in data.items() if key != 'capture_sequence'})
                or len(canonical(data)) > DATA_BYTES):
            raise Gate('binding')
        if binding['mode'] == 'metadata' and set(data) - {
                'source', 'hook_event', 'timestamp_basis', 'coverage', 'content_included', 'prompt_ref',
                'agent_ref', 'tool_ref', 'tool_name', 'stop_hook_active', 'delivery_identity', 'capture_sequence'}:
            raise Gate('binding')
    inventory(directory, state)
    return state


def inventory(directory, state, reserve=0):
    allowed = {'state.json', 'journal.lock', 'flush.lock'} | {batch['hash'] + '.json' for batch in state['batches']}
    total = reserve
    for path in directory.iterdir():
        try:
            info = path.lstat()
        except FileNotFoundError:
            # Only the uploader may unlink a known batch while capture holds the
            # journal lock. Its durable attempting fence remains until ACK commit.
            if path.name in allowed and re.fullmatch(r'[a-f0-9]{64}\.json', path.name): continue
            raise
        if (path.name not in allowed or not stat.S_ISREG(info.st_mode)
                or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1):
            raise Gate('storage')
        total += info.st_size
        if total > SPOOL_BYTES: raise Gate('capacity')


def save_state(directory, state):
    raw = canonical(state)
    if len(raw) > STATE_BYTES:
        raise Gate('capacity')
    target = directory / 'state.json'
    if target.exists(): private_read(target, STATE_BYTES)
    inventory(directory, state, reserve=len(raw))
    from upload import atomic_write
    atomic_write(target, raw)


def initialize(spool, workspace, config, *, content=False, allow_content=False, upload_on_stop=False):
    workspace, config, spool = absolute(workspace), absolute(config), absolute(spool)
    if not workspace.is_dir() or spool == workspace or workspace in spool.parents:
        raise Gate('private_path')
    if content and not allow_content:
        raise Gate('configuration')
    approved = access(config)
    # A new directory only: never reset history, replace consent, or silently rebind.
    spool.mkdir(mode=0o700)
    private_dir(spool)
    state = {'version': 1, 'binding': {'spool': str(spool), 'workspace': str(workspace),
             'config': str(config), 'origin': approved['origin'], 'project_id': approved['project_id'],
             **({'environment_id':approved['environment_id']} if approved.get('environment_id','default')!='default' else {}),
             'mode': 'content' if content else 'metadata', 'upload_on_stop': bool(upload_on_stop),
             'installation_id': uuid.uuid4().hex}, 'records': [], 'batches': [], 'omissions': {}}
    with lock(spool): save_state(spool, state)
    return status(spool)


def record_loss(directory, code):
    code = code if code in CODES else 'internal'
    try:
        directory = private_dir(directory)
        with lock(directory):
            state = read_state(directory)
            state['omissions'][code] = min(state['omissions'].get(code, 0) + 1, 999999999)
            save_state(directory, state)
        return True
    except BaseException:
        return False


def native(value):
    if not isinstance(value, str) or not NATIVE_ID.fullmatch(value):
        raise Gate('missing_identity')
    return value


def project_event(payload, binding, cwd):
    if not isinstance(payload, dict): raise Gate('invalid_input')
    event = payload.get('hook_event_name')
    if event not in EVENTS: raise Gate('unsupported_event')
    root = absolute(binding['workspace'])
    current = absolute(cwd)
    if not isinstance(payload.get('cwd'), str): raise Gate('outside_workspace')
    reported = absolute(payload['cwd'])
    if reported != current or not (current == root or root in current.parents):
        raise Gate('outside_workspace')
    session = native(payload.get('session_id'))
    prompt = native(payload.get('prompt_id'))
    agent = ['subagent', native(payload['agent_id'])] if 'agent_id' in payload else ['main']
    namespace = [binding['installation_id'], session, agent]
    identity = [*namespace, prompt, event]
    data = {'source': 'claude-code-hooks', 'hook_event': event,
            'timestamp_basis': 'hook_received_at', 'coverage': 'partial_hooks',
            'content_included': binding['mode'] == 'content',
            'prompt_ref': digest([*namespace, prompt]), 'agent_ref': digest(namespace)}
    if event == 'UserPromptSubmit':
        if not isinstance(payload.get('prompt'), str): raise Gate('invalid_input')
        if data['content_included']: data['prompt'] = payload['prompt']
    elif event == 'PostToolUse':
        tool_id = native(payload.get('tool_use_id'))
        identity.append(tool_id)
        data['tool_ref'] = digest([*namespace, tool_id])
        # Native tool names only. Paths, arbitrary fields and environment are excluded.
        tool_name = native(payload.get('tool_name'))
        data['tool_name'] = tool_name
        if 'tool_input' not in payload or 'tool_response' not in payload:
            raise Gate('invalid_input')
        if data['content_included']:
            data.update(tool_input=payload['tool_input'], tool_response=payload['tool_response'])
    else:
        if not isinstance(payload.get('last_assistant_message'), str): raise Gate('invalid_input')
        if type(payload.get('stop_hook_active')) is not bool: raise Gate('invalid_input')
        data['stop_hook_active'] = payload['stop_hook_active']
        data['delivery_identity'] = 'local_occurrence_not_native_exactly_once'
        if data['content_included']: data['last_assistant_message'] = payload['last_assistant_message']
        identity = None  # Never merge repeated identical completions using their text.
    if len(canonical(data)) > DATA_BYTES - 100: raise Gate('capacity')
    return {'identity': digest(identity) if identity else None, 'payload_hash': digest(data),
            'run_id': 'claude-' + digest(namespace)[:40], 'kind': EVENTS[event], 'name': event, 'data': data}


def capture(spool, stream, *, cwd=None):
    directory = private_dir(spool)
    raw = stream.read(INPUT_BYTES + 1)
    if len(raw) > INPUT_BYTES: raise Gate('capacity')
    payload = decode(raw)
    with lock(directory):
        state = read_state(directory)
        item = project_event(payload, state['binding'], cwd or os.getcwd())
        if item['identity']:
            old = next((row for row in state['records'] if row['identity'] == item['identity']), None)
            if old:
                if old['payload_hash'] != item['payload_hash']: raise Gate('identity_conflict')
                return {'duplicate': True, 'stop_upload': False}
        if len(state['records']) >= MAX_RECORDS: raise Gate('capacity')
        seq = len(state['records']) + 1
        item['data']['capture_sequence'] = seq
        item['event'] = {'id': 'hook-' + (item['identity'] or digest([state['binding']['installation_id'], seq]))[:48],
                         'time': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds'),
                         'kind': item.pop('kind'), 'name': item.pop('name'), 'data': item.pop('data')}
        item['seq'], item['batch'] = seq, None
        state['records'].append(item)
        save_state(directory, state)
        return {'duplicate': False, 'stop_upload': payload['hook_event_name'] == 'Stop'
                and state['binding']['upload_on_stop']}


def body_for(state, batch):
    rows = [row for row in state['records'] if row['seq'] in batch['sequences']]
    body = {'version': 1, 'batch_id': batch['batch_id'], 'run_id': batch['run_id'],
            'events': [row['event'] for row in rows]}
    raw = canonical(body)
    if len(raw) > BATCH_BYTES or hashlib.sha256(raw).hexdigest() != batch['hash']:
        raise Gate('binding')
    return raw


def prepare_batch(state):
    pending = next((batch for batch in state['batches'] if batch['status'] == 'pending'), None)
    if pending: return pending
    waiting = [row for row in state['records'] if row['batch'] is None]
    if not waiting: return None
    run_id = waiting[0]['run_id']
    rows = []
    for row in waiting:
        if row['run_id'] != run_id: continue
        tentative = rows + [row]
        envelope = {'version': 1, 'batch_id': 'hook-' + '0' * 64, 'run_id': run_id,
                    'events': [record['event'] for record in tentative]}
        if len(tentative) > 100 or len(canonical(envelope)) > BATCH_BYTES: break
        rows = tentative
    if not rows: raise Gate('capacity')
    batch_id = 'hook-' + digest([run_id, [row['seq'] for row in rows], [row['event'] for row in rows]])
    body = {'version': 1, 'batch_id': batch_id, 'run_id': run_id, 'events': [row['event'] for row in rows]}
    batch = {'batch_id': batch_id, 'run_id': run_id, 'sequences': [row['seq'] for row in rows],
             'hash': hashlib.sha256(canonical(body)).hexdigest(), 'status': 'pending'}
    for row in rows: row['batch'] = batch_id
    state['batches'].append(batch)
    return batch


@contextlib.contextmanager
def deadline(seconds):
    # POSIX interrupt timer; some C/library calls can defer Python signal delivery.
    # The installed host hook's timeout is the external guard. Never replace
    # another caller's timer or silently disable this interrupt deadline.
    if (not isinstance(seconds, (int, float)) or isinstance(seconds, bool)
            or not math.isfinite(seconds) or seconds <= 0
            or threading.current_thread() is not threading.main_thread()
            or signal.getitimer(signal.ITIMER_REAL) != (0.0, 0.0)):
        raise Gate('configuration')
    previous = signal.getsignal(signal.SIGALRM)
    def expired(*_): raise Gate('deadline')
    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try: yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


class StrictReply:
    def __init__(self, response, url): self.response, self.url = response, url
    def __enter__(self):
        self.response.__enter__()
        return self
    def __exit__(self, *args): return self.response.__exit__(*args)
    @property
    def status(self): return self.response.status
    def read(self, size):
        if self.response.geturl() != self.url: raise Gate('binding')
        raw = self.response.read(size)
        if len(raw) > 8192 or not isinstance(decode(raw), dict): raise Gate('invalid_input')
        return raw


def flush(spool, *, transport=None, budget=FLUSH_SECONDS):
    if not isinstance(budget, (int, float)) or isinstance(budget, bool) or not math.isfinite(budget) or budget <= 0:
        raise Gate('configuration')
    directory = private_dir(spool)
    from upload import atomic_write, upload_pending
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs): return None
    opener = transport or urllib.request.build_opener(NoRedirect).open
    def strict(request, timeout):
        return StrictReply(opener(request, timeout=min(timeout, 3)), request.full_url)
    with deadline(min(budget, FLUSH_SECONDS)), lock(directory, 'flush.lock'):
        for attempt in range(2):
            with lock(directory):
                state = read_state(directory)
                if any(batch['status'] in ('attempting', 'uncertain') for batch in state['batches']):
                    return status_from(state)
                batch = prepare_batch(state)
                if not batch: return status_from(state)
                # Assignment survives a crash before the pending file exists. A
                # later capture cannot change this batch or orphan its bytes.
                save_state(directory, state)
                config = access(state['binding']['config'])
                if any(config[key] != state['binding'][key] for key in ('origin', 'project_id')) or config.get('environment_id','default')!=state['binding'].get('environment_id','default'):
                    raise Gate('binding')
                raw = body_for(state, batch)
                pending = directory / (batch['hash'] + '.json')
                if pending.exists():
                    if private_read(pending, BATCH_BYTES) != raw: raise Gate('binding')
                else:
                    inventory(directory, state, reserve=len(raw))
                    atomic_write(pending, raw)
                batch_id = batch['batch_id']
            if attempt: time.sleep(2.5)  # Only pace a real second request, outside capture's lock.
            with lock(directory):
                state = read_state(directory)
                batch = next(item for item in state['batches'] if item['batch_id'] == batch_id)
                batch['status'] = 'attempting'
                save_state(directory, state)  # Durable fence before the first possible request.
            accepted = False
            try:
                accepted = upload_pending(pending, config['origin'] + '/api/batches', config['write_key'],
                                          transport=strict, expected_project=config['project_id'],
                                          **({'expected_environment':config['environment_id']} if config.get('environment_id','default')!='default' else {}))
            finally:
                # Reread under the journal lock: captures during network I/O survive.
                with lock(directory):
                    current = read_state(directory)
                    entry = next(item for item in current['batches'] if item['batch_id'] == batch_id)
                    entry['status'] = 'accepted' if accepted else 'uncertain'
                    save_state(directory, current)
            if not accepted: return status(directory)
    return status(directory)


def status_from(state):
    batches = state['batches']
    accepted = sum(len(batch['sequences']) for batch in batches if batch['status'] == 'accepted')
    uncertain = sum(len(batch['sequences']) for batch in batches if batch['status'] in ('attempting', 'uncertain'))
    pending = len(state['records']) - accepted - uncertain
    phase = 'uncertain' if uncertain else 'pending' if pending else 'accepted' if accepted else 'configured'
    return {'state': phase, 'mode': state['binding']['mode'], 'upload_on_stop': state['binding']['upload_on_stop'],
            'captured': len(state['records']), 'pending': pending, 'uncertain': uncertain,
            'accepted': accepted, 'omissions': dict(state['omissions']), 'hosted_readback_verified': False,
            'complete_session': False, 'recording_now_verified': False}


def status(spool):
    directory = private_dir(spool)
    with lock(directory): return status_from(read_state(directory))


class Parser(argparse.ArgumentParser):
    def error(self, _): raise Gate('configuration')


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    hook = bool(argv and argv[0] == 'capture')
    spool = None
    try:
        with contextlib.ExitStack() as stack:
            if hook:
                sink = stack.enter_context(open(os.devnull, 'w'))
                stack.enter_context(contextlib.redirect_stdout(sink))
                stack.enter_context(contextlib.redirect_stderr(sink))
            parser = Parser(description=__doc__)
            sub = parser.add_subparsers(dest='command', required=True, parser_class=Parser)
            init = sub.add_parser('init')
            init.add_argument('--workspace', required=True)
            init.add_argument('--config', required=True)
            init.add_argument('--spool', required=True)
            init.add_argument('--content', action='store_true')
            init.add_argument('--allow-content', action='store_true')
            init.add_argument('--upload-on-stop', action='store_true')
            for name in ('capture', 'flush', 'status'):
                command = sub.add_parser(name)
                command.add_argument('--spool', required=True)
            args = parser.parse_args(argv)
            spool = args.spool
            if args.command == 'init':
                result = initialize(spool, args.workspace, args.config, content=args.content,
                                    allow_content=args.allow_content, upload_on_stop=args.upload_on_stop)
            elif args.command == 'capture':
                with deadline(2): result = capture(spool, sys.stdin.buffer)
                if result['stop_upload']: flush(spool)
                return 0
            elif args.command == 'flush': result = flush(spool)
            else: result = status(spool)
            print(json.dumps(result, sort_keys=True))
            return 0
    except BaseException as error:
        code = error.code if isinstance(error, Gate) else 'interrupted' if isinstance(error, KeyboardInterrupt) else 'internal'
        recorded = record_loss(spool, code) if hook and spool else False
        # Never stringify an exception, parser input, native payload, key or path.
        try:
            message = 'Supatrace hook: ' + code + ('. Loss recorded.\n' if recorded else '. Capture health could not be recorded.\n') if hook else 'Supatrace: ' + code + '.\n'
            os.write(2, message.encode('ascii'))  # No buffered shutdown flush after EPIPE.
        except BaseException:
            pass  # A closed stderr must not turn a hook-health failure into a blocker.
        return 0 if hook else 1


if __name__ == '__main__':
    raise SystemExit(main())
