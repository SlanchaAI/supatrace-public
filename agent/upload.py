#!/usr/bin/env python3
"""Explicit trace upload. No automatic discovery; no secret values in logs.
An accepted batch must match server batch id/hash; ambiguous responses stay pending.
Local spooling survives process exit, not machine/disk disappearance.
"""
import argparse, hashlib, json, os, pathlib, re, tempfile, urllib.request, urllib.error, urllib.parse

# One deployment serves both hostnames and one account store. A credential stays bound to the origin it was approved on.
ORIGINS=('https://supatrace.dev','https://supatrace.tech')
DEFAULT_ORIGIN=ORIGINS[0]

def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()

def atomic_write(path, data):
    path=pathlib.Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    fd, name=tempfile.mkstemp(prefix='.pending-',dir=path.parent)
    try:
        os.fchmod(fd,0o600)
        with os.fdopen(fd,'wb') as f: f.write(data); f.flush(); os.fsync(f.fileno())
        os.replace(name,path)
        directory=os.open(path.parent,os.O_RDONLY)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        if os.path.exists(name): os.unlink(name)

def stage(source, spool):
    raw=pathlib.Path(source).read_bytes()
    if len(raw)>524288: raise ValueError('Batch exceeds 512 KiB')
    batch=json.loads(raw)
    if not isinstance(batch,dict) or not isinstance(batch.get('batch_id'),str): raise ValueError('Missing batch id')
    digest=hashlib.sha256(canonical(batch)).hexdigest()
    path=pathlib.Path(spool)/(digest+'.json')
    atomic_write(path,canonical(batch))
    return path

# Classify only known status/code pairs. Never relay server bodies or exceptions.
REJECTIONS = {
    (429, 'rate_limit'): 'rate_limit',
    (429, 'storage_capacity'): 'storage_capacity',
    (429, 'storage_capacity_or_unknown_tenant'): 'capacity_or_account_state',
    (429, 'monthly_span_allowance_exceeded'): 'monthly_allowance',
    (429, 'stored_bytes_allowance_exceeded'): 'stored_allowance',
    (429, 'spend_cap_reached'): 'spend_cap',
    (401, 'write_key_required'): 'write_key',
    (401, 'invalid_write_key'): 'write_key',
    (403, 'project_unavailable'): 'project',
    (403, 'project_paused'): 'project_paused',
    (403, 'commercial_upload_blocked'): 'account_access',
    (409, 'idempotency_conflict'): 'identity_conflict',
}

def _outcome(reason, retry_after=None):
    return {'accepted': reason == 'accepted', 'reason': reason,
            'retry_after_seconds': retry_after}

def _inspect_response(response, batch_id, request_hash, expected_project, allow_ack=True, classify_rejections=True, expected_environment=None):
    status = response.status
    if status not in (200, 201, 401, 403, 409, 429) or not classify_rejections and status not in (200, 201):
        return _outcome('unconfirmed')
    data = response.read(8193)
    if not isinstance(data, bytes) or len(data) > 8192:
        return _outcome('unconfirmed')
    try:
        def unique(pairs):
            value = {}
            for key, item in pairs:
                if key in value: raise ValueError('ambiguous_ack')
                value[key] = item
            return value
        def reject_constant(_): raise ValueError('invalid_ack_number')
        ack = json.loads(data, object_pairs_hook=unique, parse_constant=reject_constant)
    except (ValueError, UnicodeError, RecursionError):
        return _outcome('unconfirmed')
    if not isinstance(ack, dict):
        return _outcome('unconfirmed')
    if status in (200, 201):
        if (not allow_ack or ack.get('accepted') is not True
                or ack.get('batch_id') != batch_id
                or ack.get('request_hash') != request_hash
                or expected_project is not None and ack.get('project_id') != expected_project
                or expected_environment is not None and ack.get('environment_id') != expected_environment):
            return _outcome('unconfirmed')
        return _outcome('accepted')
    code = ack.get('error')
    reason = REJECTIONS.get((status, code), 'unconfirmed') if isinstance(code, str) else 'unconfirmed'
    retry_after = None
    if reason == 'rate_limit':
        header = (getattr(response, 'headers', None) or {}).get('Retry-After')
        if isinstance(header, str) and re.fullmatch(r'[0-9]{1,5}', header) and 1 <= int(header) <= 86400:
            retry_after = int(header)
    return _outcome(reason, retry_after)

def _upload_pending_attempt(path, endpoint, token, transport=None, expected_project=None, classify_rejections=False, expected_environment=None):
    """One attempt, sanitized outcome, no retry or capacity inference.

    Even a known rejection can follow an earlier reservation or object write.
    Only a matching successful ACK followed by local cleanup returns accepted.
    """
    if not endpoint.startswith('https://'): raise ValueError('HTTPS endpoint required')
    if expected_project is not None:
        if not isinstance(expected_project,str) or not re.fullmatch(r'proj_[a-f0-9]{32}',expected_project):raise ValueError('Invalid project id')
        url=urllib.parse.urlsplit(endpoint);query=urllib.parse.parse_qs(url.query)
        if 'project' in query and query['project']!=[expected_project]:raise ValueError('Conflicting project target')
        query['project']=[expected_project];endpoint=urllib.parse.urlunsplit(url._replace(query=urllib.parse.urlencode(query,doseq=True)))
    if expected_environment is not None:
        if not isinstance(expected_environment,str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,31}',expected_environment):raise ValueError('Invalid environment id')
        url=urllib.parse.urlsplit(endpoint);query=urllib.parse.parse_qs(url.query)
        if 'environment' in query and query['environment']!=[expected_environment]:raise ValueError('Conflicting environment target')
        query['environment']=[expected_environment];endpoint=urllib.parse.urlunsplit(url._replace(query=urllib.parse.urlencode(query,doseq=True)))
    body=pathlib.Path(path).read_bytes(); batch=json.loads(body)
    request_hash=hashlib.sha256(body).hexdigest()
    request=urllib.request.Request(endpoint,body,headers={'Authorization':'Bearer '+token,'X-Supatrace-Key':token,'Content-Type':'application/json','x-amz-content-sha256':request_hash},method='POST')
    # Refuse redirects: never forward credentials or acknowledge a different endpoint.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs): return None
    open_request=transport or urllib.request.build_opener(NoRedirect).open
    try:
        try:
            with open_request(request,timeout=30) as response:
                result = _inspect_response(response, batch['batch_id'], request_hash, expected_project, classify_rejections=classify_rejections, expected_environment=expected_environment)
        except urllib.error.HTTPError as error:
            with error:
                result = _inspect_response(error, batch['batch_id'], request_hash, expected_project, allow_ack=False, classify_rejections=classify_rejections, expected_environment=expected_environment)
        if result['accepted']:
            try:
                pathlib.Path(path).unlink()
            except OSError:
                return _outcome('acknowledged_pending_cleanup')
        return result
    except (OSError, urllib.error.URLError, ValueError, TypeError, AttributeError, RecursionError):
        return _outcome('unconfirmed')

def upload_pending_result(path, endpoint, token, transport=None, expected_project=None, expected_environment=None):
    return _upload_pending_attempt(path, endpoint, token, transport, expected_project, classify_rejections=True, expected_environment=expected_environment)

def upload_pending(path, endpoint, token, transport=None, expected_project=None, expected_environment=None):
    # Preserve boolean callers and their stricter uncertainty/reconciliation journals.
    # They do not read rejection bodies, which their bounded transports may not wrap.
    return _upload_pending_attempt(path, endpoint, token, transport, expected_project, expected_environment=expected_environment)['accepted']

def upload_result_message(result):
    reason = result.get('reason')
    if result.get('accepted') is True and reason == 'accepted':
        return 'Accepted by server.'
    if reason == 'acknowledged_pending_cleanup':
        return ('The server acknowledged this exact batch, but local pending cleanup failed. '
                'Keep the file and reconcile before cleanup or another attempt.')
    messages = {
        'rate_limit': 'Request rate limited. Wait before an explicit retry of the same unchanged file.',
        'storage_capacity': 'Storage capacity unavailable. Check Usage; repeated retries do not add capacity.',
        'monthly_allowance': 'This month\'s span allowance for the plan is used up. It resets at the start of next month (UTC); check Usage for the date. Paid plans are not available yet. Retrying before then does not add allowance.',
        'spend_cap': 'The spend cap is on and this month\'s included spans are used up, so uploads stop instead of adding overage. The workspace owner can turn the cap off under Billing, or wait for the monthly reset. Retrying does not add allowance.',
        'stored_allowance': 'The plan\'s stored-data allowance is used up. It does not reset monthly; check Usage. Paid plans are not available yet. Retrying does not add allowance.',
        'capacity_or_account_state': 'Storage capacity or account state needs review. Check Usage and the approved account; repeated retries do not add capacity.',
        'write_key': 'Write key not accepted. Check the approved connection and key state before another attempt.',
        'project_paused': 'The project is paused because no trace was accepted for 30 days. Stored traces are kept. The workspace owner can resume it under Usage in the dashboard; then retry the same unchanged file.',
        'project': 'Project not available to this key. Check the project-bound configuration before another attempt.',
        'account_access': 'Account upload access is blocked. Review account state; an upgrade or payment is not promised to resolve it.',
        'identity_conflict': 'Batch identity conflicts with recorded content. Keep the unchanged original and reconcile; do not change its ID to force a retry.',
        'unconfirmed': 'Upload outcome unconfirmed. Verify the accepted batch/hash/project before another explicit attempt.',
    }
    message = messages.get(reason, messages['unconfirmed'])
    wait = result.get('retry_after_seconds')
    if reason == 'rate_limit' and isinstance(wait, int) and not isinstance(wait, bool) and 1 <= wait <= 86400:
        message += ' Server retry window: '+str(wait)+' seconds.'
    return ('Not acknowledged. Local batch retained. '+message+
            ' Existing server reservations may still consume quota; there is no monthly reset or automatic cleanup.')

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('file');p.add_argument('--config');p.add_argument('--endpoint');p.add_argument('--spool',default=str(pathlib.Path.home()/'.supatrace'/'pending'))
    args=p.parse_args();token=os.environ.get('SUPATRACE_TOKEN');project=None;environment=None
    if args.config:
        try: config=json.loads(pathlib.Path(args.config).read_text())
        except (OSError,ValueError): p.error('Cannot read the config as JSON. Check --config points to your approved connection file; do not paste its contents into chat.')
        if not isinstance(config,dict): p.error('Config must be an approved connection object')
        if config.get('approved') is not True or config.get('origin') not in ORIGINS:p.error('Config is not approved for Supatrace')
        token=config.get('write_key')
        project=config.get('project_id')
        if not isinstance(project,str) or not re.fullmatch(r'proj_[a-f0-9]{32}',project):p.error('Config requires a valid project id; use the approved config for your workspace project')
        environment=config.get('environment_id')
        bound=config['origin']
        if not args.endpoint:args.endpoint=bound+'/api/batches'
        destination=urllib.parse.urlsplit(args.endpoint)
        if destination.scheme!='https' or destination.hostname!=urllib.parse.urlsplit(bound).hostname or destination.port not in (None,443) or destination.path!='/api/batches':p.error('Config credential is bound to the Supatrace batches endpoint')
    if not args.endpoint:args.endpoint=DEFAULT_ORIGIN+'/api/batches'
    if not isinstance(token,str) or not token: p.error('Use --config with your approved connection file, or set SUPATRACE_TOKEN for this upload session')
    spool=args.spool
    if environment is not None:
        if not isinstance(environment,str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,31}',environment):p.error('Invalid configured environment')
        spool=str(pathlib.Path(spool)/('scope-'+hashlib.sha256(json.dumps([bound,project,environment]).encode()).hexdigest()))
    try: pending=stage(args.file,spool)
    except (OSError,ValueError): p.error('Cannot prepare the batch. Check the file exists, is JSON with a batch_id, is at most 512 KiB, and the spool folder is writable. No upload was attempted.')
    result=upload_pending_result(pending,args.endpoint,token,expected_project=project,expected_environment=environment)
    print(upload_result_message(result))
    if not result['accepted']:raise SystemExit(1)
if __name__=='__main__':main()
