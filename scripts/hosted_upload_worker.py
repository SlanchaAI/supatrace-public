"""Private RPC adapter for the retained uploader. No direct network or real keys.

Invoked by the trusted Node controller with an isolated interpreter/environment.
An interrupted pipe leaves the existing journal/lock recovery rules in force.
"""
import base64
import io
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'agent'))
import private_upload_runtime as runtime

MAX_FRAME = 750000
sequence = 0


def read_frame():
    raw = sys.stdin.buffer.readline(MAX_FRAME + 1)
    if not raw.endswith(b'\n') or len(raw) > MAX_FRAME:
        raise OSError('upload_bridge_pipe_unavailable')
    return runtime._json(raw)


def emit(value):
    raw = runtime.canonical(value)
    if len(raw) + 1 > MAX_FRAME:
        raise OSError('upload_bridge_frame_bound')
    sys.stdout.buffer.write(raw + b'\n')
    sys.stdout.buffer.flush()


def rpc(kind, **payload):
    global sequence
    sequence += 1
    emit({'id': sequence, 'type': kind, **payload})
    answer = read_frame()
    if not isinstance(answer, dict) or set(answer) != {'id', 'value'} or answer['id'] != sequence:
        raise OSError('upload_bridge_response_invalid')
    return answer['value']


def main():
    initial = read_frame()
    if not isinstance(initial, dict) or set(initial) != {'directory', 'scope'}:
        raise OSError('upload_bridge_configuration_invalid')
    scope = initial['scope']

    def remaining_ms(value):
        remaining = int((value - time.monotonic()) * 1000)
        if remaining < 1:
            raise OSError('upload_bridge_deadline')
        return remaining

    def authorize(descriptor):
        descriptor = dict(descriptor)
        descriptor['remaining_ms'] = remaining_ms(descriptor.pop('deadline_monotonic'))
        return rpc('authorize', descriptor=descriptor) is True

    def credential(binding):
        binding = dict(binding)
        binding['remaining_ms'] = remaining_ms(binding.pop('deadline_monotonic'))
        # This lease contains a local surrogate, never the actual server key.
        return rpc('lease', binding=binding)

    class Reply:
        def __init__(self, value, url):
            if not isinstance(value, dict) or set(value) != {'status', 'body'}:
                raise OSError('upload_bridge_reply_invalid')
            self.status, self.url = value['status'], url
            self.body = base64.b64decode(value['body'], validate=True)
            if type(self.status) is not int or not 100 <= self.status <= 599 or len(self.body) > 8192:
                raise OSError('upload_bridge_reply_bound')
        def __enter__(self): return self
        def __exit__(self, *_): self.close()
        def geturl(self): return self.url
        def read(self, size): return self.body[:size]
        def close(self): self.body = b''

    def transport(request, timeout):
        value = rpc('post', url=request.full_url, method=request.get_method(),
                    body=base64.b64encode(request.data).decode('ascii'))
        return Reply(value, request.full_url)

    result = runtime.upload_staged_workspace(initial['directory'], scope,
                    credential_provider=credential, authorize=authorize, transport=transport)
    emit({'type': 'result', 'result': result})


if __name__ == '__main__':
    try:
        main()
    except BaseException:
        # Never print a source row, filesystem path, credential or raw exception.
        try: emit({'type': 'result', 'result': {'outcome': 'stopped-reconciliation-required'}})
        except BaseException: pass
        raise SystemExit(1)
