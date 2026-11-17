"""Local integration of the retained uploader. No default network or credentials.

Callers supply genuine authorization, a bound ephemeral credential provider and
a redirect-refusing HTTPS transport. Hooks must honor their supplied deadline.
An unacknowledged attempt blocks automatic retry until authenticated reconciliation.
"""
import contextlib
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import stat
import time
import urllib.parse

LOCK_NAME = '.live-import.lock'
ROOT = Path(__file__).resolve().parent.parent
UPLOADER_PATH = Path(__file__).resolve().parent / 'upload.py'
ORIGINS = ('https://supatrace.dev', 'https://supatrace.tech')
HEX = re.compile(r'[a-f0-9]{64}')
PROJECT = re.compile(r'proj_[a-f0-9]{32}')


class RuntimeGate(Exception):
    pass


def fail(code):
    raise RuntimeGate(code)


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def _owned_directory(path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        fail('private_upload_directory_unsafe')


def _private_bytes(path, maximum):
    fd = None
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > maximum:
            fail('private_upload_file_unsafe')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            body = stream.read(maximum + 1)
        if len(body) > maximum:
            fail('private_upload_file_unsafe')
        return body, info
    except RuntimeGate:
        raise
    except OSError:
        fail('private_upload_file_unavailable')
    finally:
        if fd is not None:
            os.close(fd)


def _json(body):
    def pairs(items):
        value = {}
        for key, item in items:
            if key in value:
                fail('private_upload_json_ambiguous')
            value[key] = item
        return value
    try:
        return json.loads(body, object_pairs_hook=pairs,
                          parse_constant=lambda _: fail('private_upload_json_invalid'))
    except (ValueError, UnicodeError):
        fail('private_upload_json_invalid')


def _read_json(path, maximum=20 * 1024 * 1024):
    return _json(_private_bytes(path, maximum)[0])


def _sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


@contextlib.contextmanager
def workspace_lock(directory, phase='upload'):
    if phase not in ('capture-stage', 'upload'):
        fail('private_upload_lock_phase_invalid')
    directory = Path(directory).absolute()
    _owned_directory(directory)
    path = directory / LOCK_NAME
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    except FileExistsError:
        fail('private_upload_workspace_locked_reconciliation_required')
    except OSError:
        fail('private_upload_lock_unavailable')
    identity = os.fstat(fd)
    try:
        os.write(fd, canonical({'version': 1, 'pid': os.getpid(), 'phase': phase}))
        os.fsync(fd)
        _sync_directory(directory)
        yield
    finally:
        try:
            current = path.lstat()
            if not stat.S_ISREG(current.st_mode) or current.st_nlink != 1 or current.st_uid != os.getuid() or current.st_mode & 0o077 or (current.st_dev, current.st_ino) != (identity.st_dev, identity.st_ino):
                fail('private_upload_lock_reconciliation_required')
            path.unlink()
            _sync_directory(directory)
        finally:
            os.close(fd)


def _uploader():
    spec = importlib.util.spec_from_file_location('supatrace_retained_upload', UPLOADER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _scope(scope):
    required = {'origin', 'project_id', 'fingerprint', 'conversion_hash', 'manifest_hash',
                'max_batches', 'max_total_bytes', 'max_requests', 'total_timeout_ms'}
    if not isinstance(scope, dict) or set(scope) not in (required,required|{'environment_id'}):
        fail('private_upload_explicit_scope_required')
    scope = _json(canonical(scope))
    if 'environment_id' in scope:
        if not isinstance(scope['environment_id'],str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,31}',scope['environment_id']):fail('private_upload_destination_invalid')
        if scope['environment_id']=='default':scope.pop('environment_id')
    if scope['origin'] not in ORIGINS or not isinstance(scope['project_id'], str) or not PROJECT.fullmatch(scope['project_id']):
        fail('private_upload_destination_invalid')
    if any(not isinstance(scope[key], str) or not HEX.fullmatch(scope[key]) for key in ('fingerprint', 'conversion_hash', 'manifest_hash')):
        fail('private_upload_scope_hash_invalid')
    for key, maximum in [('max_batches', 1000), ('max_requests', 1000),
                         ('max_total_bytes', 20 * 1024 * 1024), ('total_timeout_ms', 300000)]:
        if type(scope[key]) is not int or not 1 <= scope[key] <= maximum:
            fail('private_upload_explicit_bounds_required')
    return scope


def _preflight(directory, scope):
    binding = _read_json(directory / 'binding.json', 65536)
    receipt = _read_json(directory / 'stage-receipt.json', 65536)
    if not isinstance(binding, dict) or not isinstance(receipt, dict):
        fail('private_upload_stage_scope_mismatch')
    expected = {'destinationProject': scope['project_id'], 'fingerprint': scope['fingerprint']}
    if binding != expected or any(receipt.get(key) != value for key, value in expected.items()) or receipt.get('conversionHash') != scope['conversion_hash'] or receipt.get('uploaded') is not False or receipt.get('persistence') != 'local-files-verified-no-fsync-guarantee':
        fail('private_upload_stage_scope_mismatch')
    pending = directory / 'pending'
    _owned_directory(pending)
    manifest = _read_json(pending / 'import-manifest.json')
    if not isinstance(manifest, dict) or manifest.get('version') != 1 or manifest.get('mode') != 'stage-only-no-network' or not isinstance(manifest.get('batches'), list) or type(manifest.get('count')) is not int or manifest['count'] != len(manifest['batches']) or manifest['count'] != receipt.get('batches') or not 1 <= manifest['count'] <= scope['max_batches'] or digest(manifest) != receipt.get('manifestHash') or digest(manifest) != scope['manifest_hash']:
        fail('private_upload_manifest_invalid')
    items = {}
    allowed_files = {'import-manifest.json'}
    total = 0
    for item in manifest['batches']:
        if not isinstance(item, dict) or set(item) != {'batch_id', 'request_hash', 'pending_file'} or not isinstance(item['batch_id'], str) or not item['batch_id'] or len(item['batch_id']) > 200 or not isinstance(item['request_hash'], str) or not HEX.fullmatch(item['request_hash']) or item['pending_file'] != item['request_hash'] + '.json' or item['batch_id'] in items:
            fail('private_upload_manifest_invalid')
        allowed_files.add(item['pending_file'])
        items[item['batch_id']] = item
        path = pending / item['pending_file']
        if path.exists() or path.is_symlink():
            body, _ = _private_bytes(path, 524288)
            batch = _json(body)
            if hashlib.sha256(body).hexdigest() != item['request_hash'] or not isinstance(batch, dict) or batch.get('batch_id') != item['batch_id']:
                fail('private_upload_pending_hash_mismatch')
            total += len(body)
            if total > scope['max_total_bytes']:
                fail('private_upload_pending_scope_invalid')
    if total > scope['max_total_bytes'] or any(child.name not in allowed_files for child in pending.iterdir()):
        fail('private_upload_pending_scope_invalid')
    return manifest, items


def _remove_acknowledged_copy(path, request_hash):
    body, identity = _private_bytes(path, 524288)
    current = path.lstat()
    if hashlib.sha256(body).hexdigest() != request_hash or (current.st_dev, current.st_ino) != (identity.st_dev, identity.st_ino):
        fail('private_upload_pending_hash_mismatch')
    path.unlink()
    _sync_directory(path.parent)


def _validated_journal(directory, scope, manifest, items):
    journal_path = directory / 'upload-receipts.json'
    identity = {key: scope[key] for key in ('origin', 'project_id', 'fingerprint', 'conversion_hash', 'manifest_hash')}
    if 'environment_id' in scope:identity['environment_id']=scope['environment_id']
    if journal_path.exists() or journal_path.is_symlink():
        journal = _read_json(journal_path)
        if not isinstance(journal, dict) or journal.get('version') != 1 or journal.get('scope') != identity or journal.get('manifest_hash') != digest(manifest) or not isinstance(journal.get('entries'), dict) or set(journal['entries']) != set(items):
            fail('private_upload_journal_scope_mismatch')
    else:
        journal = {'version': 1, 'scope': identity, 'manifest_hash': digest(manifest),
                   'entries': {key: {'request_hash': item['request_hash'], 'status': 'pending'} for key, item in items.items()}}
    for key, item in items.items():
        entry = journal['entries'][key]
        if not isinstance(entry, dict) or entry.get('request_hash') != item['request_hash'] or entry.get('status') not in ('pending', 'attempting', 'unacknowledged', 'accepted'):
            fail('private_upload_journal_invalid')
        path = directory / 'pending' / item['pending_file']
        if entry['status'] == 'accepted':
            ack = entry.get('receipt')
            if ack != {'accepted': True, 'batch_id': key, 'request_hash': item['request_hash'], 'project_id': scope['project_id'],**({'environment_id':scope['environment_id']} if 'environment_id' in scope else {})}:
                fail('private_upload_journal_invalid')
        elif entry['status'] == 'pending' and not path.exists():
            fail('private_upload_pending_missing_reconciliation_required')
    return journal


def upload_staged_workspace(directory, scope, *, credential_provider, authorize, transport,
                            now=time.time, monotonic=time.monotonic):
    if not all(callable(value) for value in (credential_provider, authorize, transport, now, monotonic)):
        fail('private_upload_runtime_hooks_required')
    scope = _scope(scope)
    directory = Path(directory).absolute()
    deadline = monotonic() + scope['total_timeout_ms'] / 1000
    attempts = 0
    def remaining():
        value = deadline - monotonic()
        if not math.isfinite(value) or value <= 0:
            fail('private_upload_deadline_exceeded')
        return value
    with workspace_lock(directory):
        manifest, items = _preflight(directory, scope)
        module = _uploader()
        journal_path = directory / 'upload-receipts.json'
        identity = {key: scope[key] for key in ('origin', 'project_id', 'fingerprint', 'conversion_hash', 'manifest_hash')}
        if 'environment_id' in scope:identity['environment_id']=scope['environment_id']
        journal = _validated_journal(directory, scope, manifest, items)
        # A prior ambiguous attempt, including lost ACK after unlink, is never retried here.
        if any(entry['status'] in ('attempting', 'unacknowledged') for entry in journal['entries'].values()):
            return {'outcome': 'reconciliation-required', 'transport_requests_attempted': 0,
                    'all_batches_acknowledged': False, 'hosted_readback_verified': False}
        module.atomic_write(journal_path, canonical(journal))
        for key, item in items.items():
            entry = journal['entries'][key]
            path = directory / 'pending' / item['pending_file']
            if entry['status'] == 'accepted':
                if path.exists() or path.is_symlink():
                    _remove_acknowledged_copy(path, item['request_hash'])
                continue
            if attempts >= scope['max_requests']:
                return {'outcome': 'bounded-pending', 'transport_requests_attempted': attempts,
                        'all_batches_acknowledged': False, 'hosted_readback_verified': False}
            remaining()
            body, _ = _private_bytes(path, 524288)
            descriptor = {'action': 'upload-approved-batch', **identity,
                          'batch_id': key, 'request_hash': item['request_hash'], 'bytes': len(body),
                          'deadline_monotonic': deadline}
            try:
                allowed = authorize(_json(canonical(descriptor)))
            except Exception:
                fail('private_upload_authorization_unavailable')
            remaining()
            if allowed is not True:
                fail('private_upload_not_authorized')
            try:
                credential = credential_provider({'origin': scope['origin'], 'project_id': scope['project_id'],
                                                  'deadline_monotonic': deadline,**({'environment_id':scope['environment_id']} if 'environment_id' in scope else {})})
                credential = _json(canonical(credential))
            except Exception:
                fail('private_upload_credential_unavailable')
            remaining()
            if not isinstance(credential, dict) or set(credential) != ({'origin', 'project_id', 'write_key', 'expires_at'}|({'environment_id'} if 'environment_id' in scope else set())) or credential.get('environment_id')!=scope.get('environment_id') or credential['origin'] != scope['origin'] or credential['project_id'] != scope['project_id'] or not isinstance(credential['write_key'], str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}', credential['write_key']) or type(credential['expires_at']) not in (int, float) or not math.isfinite(credential['expires_at']) or not now() < credential['expires_at'] <= now() + 300:
                fail('private_upload_credential_binding_invalid')
            token = credential['write_key']
            expires = credential['expires_at']
            endpoint = scope['origin'] + '/api/batches'
            expected_url = endpoint + '?' + urllib.parse.urlencode({'project': scope['project_id'],**({'environment':scope['environment_id']} if 'environment_id' in scope else {})})
            entry['status'] = 'attempting'
            module.atomic_write(journal_path, canonical(journal))
            def guarded_transport(request, timeout):
                nonlocal attempts
                remaining()
                if attempts >= scope['max_requests'] or now() >= expires or request.full_url != expected_url or request.get_method() != 'POST' or hashlib.sha256(request.data).hexdigest() != item['request_hash']:
                    raise OSError('private_upload_transport_refused')
                attempts += 1
                response = transport(request, timeout=min(timeout, remaining(), expires - now()))
                def check_response():
                    remaining()
                    if now() >= expires or response.geturl() != expected_url:
                        raise OSError('private_upload_response_target_refused')
                try:
                    check_response()
                except Exception:
                    response.close()
                    raise
                class BoundedResponse:
                    @property
                    def status(self):
                        return response.status
                    def __enter__(self):
                        response.__enter__()
                        check_response()
                        return self
                    def __exit__(self, *args):
                        return response.__exit__(*args)
                    def read(self, length):
                        check_response()
                        body = response.read(length)
                        check_response()
                        if not isinstance(body, bytes) or len(body) > 8192 or not isinstance(_json(body), dict):
                            raise OSError('private_upload_ack_invalid')
                        return body
                return BoundedResponse()
            try:
                accepted = module.upload_pending(path, endpoint, token, transport=guarded_transport,
                                                 expected_project=scope['project_id'],**({'expected_environment':scope['environment_id']} if 'environment_id' in scope else {}))
            except Exception:
                accepted = False
            finally:
                token = None
                credential = None
            if not accepted:
                entry['status'] = 'unacknowledged'
                module.atomic_write(journal_path, canonical(journal))
                return {'outcome': 'reconciliation-required', 'transport_requests_attempted': attempts,
                        'all_batches_acknowledged': False, 'hosted_readback_verified': False}
            entry['status'] = 'accepted'
            entry['receipt'] = {'accepted': True, 'batch_id': key, 'request_hash': item['request_hash'],
                                'project_id': scope['project_id'],**({'environment_id':scope['environment_id']} if 'environment_id' in scope else {})}
            module.atomic_write(journal_path, canonical(journal))
        return {'outcome': 'all-uploader-acknowledgments-verified', 'transport_requests_attempted': attempts,
                'accepted_batches': len(items), 'all_batches_acknowledged': True,
                'hosted_readback_verified': False}


def inspect_staged_workspace(directory, *, origin, project_id, environment_id=None):
    """Bounded offline status. Uses the upload lock; never uploads or edits receipts."""
    if origin not in ORIGINS or not isinstance(project_id, str) or not PROJECT.fullmatch(project_id):
        fail('private_upload_destination_invalid')
    directory = Path(directory).absolute()
    with workspace_lock(directory):
        receipt = _read_json(directory / 'stage-receipt.json', 65536)
        if not isinstance(receipt, dict):
            fail('private_upload_stage_scope_mismatch')
        scope = _scope({'origin': origin, 'project_id': project_id,
                        'fingerprint': receipt.get('fingerprint'),
                        'conversion_hash': receipt.get('conversionHash'),
                        'manifest_hash': receipt.get('manifestHash'),
                        'max_batches': 1000, 'max_total_bytes': 20 * 1024 * 1024,
                        'max_requests': 1000, 'total_timeout_ms': 300000,**({'environment_id':environment_id} if environment_id is not None else {})})
        manifest, items = _preflight(directory, scope)
        journal = _validated_journal(directory, scope, manifest, items)
        counts = {state: 0 for state in ('pending', 'attempting', 'unacknowledged', 'accepted')}
        for entry in journal['entries'].values():
            counts[entry['status']] += 1
        ambiguous = counts['attempting'] + counts['unacknowledged']
        acknowledged = counts['accepted'] == len(items)
        return {'outcome': 'reconciliation-required' if ambiguous else
                'all-uploader-acknowledgments-verified' if acknowledged else 'awaiting-approved-upload',
                'total_batches': len(items), 'pending_batches': counts['pending'],
                'acknowledged_batches': counts['accepted'], 'ambiguous_batches': ambiguous,
                'all_batches_acknowledged': acknowledged, 'hosted_readback_verified': False,
                'network_requests_attempted': 0}


def main():
    import argparse
    parser = argparse.ArgumentParser(description='Inspect one explicit staged import offline. Never uploads or reconciles server state.')
    parser.add_argument('action', choices=['status'])
    parser.add_argument('--directory', required=True)
    parser.add_argument('--origin', required=True, choices=ORIGINS)
    parser.add_argument('--project', required=True)
    parser.add_argument('--environment')
    args = parser.parse_args()
    try:
        result = inspect_staged_workspace(args.directory, origin=args.origin, project_id=args.project,environment_id=args.environment)
    except (RuntimeGate, OSError, ValueError, KeyError, TypeError):
        parser.exit(1, 'Import status unavailable. Check the explicit project, private workspace, lock and receipts. Do not delete a lock or replay batches to bypass this refusal. No network request was attempted.\n')
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    main()
