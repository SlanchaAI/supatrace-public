#!/usr/bin/env python3
"""Explicitly request write-only Supatrace access. Owner approves in browser.
Saves credentials only to the --config path requested by the caller, mode 0600.
Never prints keys. No capture, discovery, or uploads happen in this command.
"""
import argparse,hashlib,json,pathlib,re,secrets,time,urllib.request,urllib.error,urllib.parse,http.client
from upload import atomic_write,ORIGINS,DEFAULT_ORIGIN

def post(origin,path,payload):
 class NoRedirect(urllib.request.HTTPRedirectHandler):
  def redirect_request(self,*args,**kwargs):return None
 body=json.dumps(payload).encode()
 req=urllib.request.Request(origin+path,body,headers={'Content-Type':'application/json','x-amz-content-sha256':hashlib.sha256(body).hexdigest()},method='POST')
 with urllib.request.build_opener(NoRedirect).open(req,timeout=30) as r:
  raw=r.read(8193)
  if len(raw)>8192:raise ValueError('Unexpected response size')
  return json.loads(raw)

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--origin');p.add_argument('--config',required=True);p.add_argument('--project');p.add_argument('--environment');a=p.parse_args()
 if a.origin is not None and a.origin not in ORIGINS:p.error('Only '+' or '.join(ORIGINS)+' is supported')
 if a.project and not re.fullmatch(r'proj_[a-f0-9]{32}',a.project):p.error('Invalid project id')
 if a.environment is not None and not re.fullmatch(r'[a-z][a-z0-9-]{0,31}',a.environment):p.error('Invalid environment id')
 path=pathlib.Path(a.config)
 bound=a.project
 if path.exists():
  try: state=json.loads(path.read_text())
  except (OSError,ValueError):p.error('Cannot read the saved config as JSON. Keep it private and unchanged; check the selected path before retrying.')
  if not isinstance(state,dict):p.error('Saved config must be a connection object; it was not changed')
  requested=state.get('requested_project_id');project=state.get('project_id')
  for field in ('requested_project_id','project_id'):
   if field in state and (not isinstance(state[field],str) or not re.fullmatch(r'proj_[a-f0-9]{32}',state[field])):p.error('Saved config has an invalid project binding; it was not changed')
  if requested and project and requested!=project:p.error('Saved config has conflicting project bindings; it was not changed')
  bound=project or requested
  if a.project and bound and a.project!=bound:p.error('Existing config belongs to a different project; do not replace its access implicitly')
  bound=bound or a.project
  if state.get('origin') not in ORIGINS or type(state.get('approved')) is not bool:p.error('Saved config is not a valid Supatrace connection; it was not changed')
  if a.origin is not None and a.origin!=state['origin']:p.error('Existing config belongs to a different origin; do not replace its access implicitly')
  a.origin=state['origin']
  environments=[state.get(field) for field in ('environment_id','requested_environment_id')]
  for field in ('environment_id','requested_environment_id'):
   if field in state and (not isinstance(state[field],str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,31}',state[field])):p.error('Saved config has an invalid environment binding; it was not changed')
  if all(value is not None for value in environments) and environments[0]!=environments[1]:p.error('Saved config has conflicting environment bindings; it was not changed')
  environment=next((value for value in environments if value is not None),'default')
  if a.environment is not None and a.environment!=environment:p.error('Existing config belongs to a different environment; use a separate config')
  a.environment=environment
  if environment!='default' and not bound:p.error('Saved environment requires a project binding; config was not changed')
  if not isinstance(state.get('write_key'),str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}',state['write_key']):p.error('Saved connection key is invalid; keep the config private and unchanged')
  if state['approved']:
   if not project:p.error('Approved config is missing its project; it was not changed')
   if environment!='default' and state.get('environment_id')!=environment:p.error('Approved config is missing its environment binding; it was not changed')
   print('Already connected. Revoke in your workspace before replacing access.');return
  if not isinstance(state.get('device_secret'),str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}',state['device_secret']) or not isinstance(state.get('user_code'),str) or not re.fullmatch(r'[A-Za-z0-9_-]{12}',state['user_code']):p.error('Pending config is incomplete; keep it unchanged and use a different config path for a new setup')
  if a.project and not requested and not project:
   state={**state,'requested_project_id':a.project}
   try:atomic_write(path,json.dumps(state).encode())
   except OSError:raise SystemExit('Could not save the requested project binding. Check the config folder is writable and rerun with the same config and --project; no approval was checked.')
 else:
  a.origin=a.origin or DEFAULT_ORIGIN
  a.environment=a.environment or 'default'
  if a.environment!='default' and not a.project:p.error('An environment requires an explicit project')
  query={'project':a.project} if a.project else {}
  if a.environment!='default':query['environment']=a.environment
  key=secrets.token_urlsafe(32)
  try:
   start=post(a.origin,'/api/setup/start'+('?'+urllib.parse.urlencode(query) if query else ''),{'key_hash':hashlib.sha256(key.encode()).hexdigest()})
  except (OSError,ValueError,http.client.HTTPException):raise SystemExit('Could not start setup. Check your connection and retry later with the same command. No local config was saved; no key is printed.')
  if not isinstance(start,dict) or not isinstance(start.get('device_secret'),str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}',start['device_secret']) or not isinstance(start.get('user_code'),str) or not re.fullmatch(r'[A-Za-z0-9_-]{12}',start['user_code']):raise SystemExit('Setup response could not be verified. No local config was saved. Retry later; do not approve an unverified code.')
  state={'device_secret':start['device_secret'],'user_code':start['user_code'],'origin':a.origin,'write_key':key,'approved':False,**({'requested_project_id':a.project} if a.project else {}),**({'requested_environment_id':a.environment} if a.environment!='default' else {})}
  verification=start.get('verification_uri')
  if isinstance(verification,str) and verification.startswith('/app/') and len(verification)<=512:state['verification_uri']=verification
  try:atomic_write(path,json.dumps(state).encode())
  except OSError:raise SystemExit('Could not save pending setup. Check the config folder is writable, then rerun with the same path before approving any code.')
 verification=state.get('verification_uri','/app/')
 if not isinstance(verification,str) or not verification.startswith('/app/') or len(verification)>512:verification='/app/'
 print('Ask your owner to open '+a.origin+verification+' and approve this code: '+state['user_code'])
 for _ in range(60):
  try:
   status=post(a.origin,'/api/setup/poll',{'device_secret':state['device_secret']})
  except urllib.error.HTTPError as e:
   if e.code==410:raise SystemExit('Setup expired. No new key was granted by this response. Keep this config unchanged and use a different config path for a new setup.')
   if e.code not in (429,500,502,503,504):raise SystemExit('Setup could not complete. Keep the pending config unchanged and retry later; no key is printed.')
   time.sleep(10);continue
  except (OSError,ValueError,http.client.HTTPException):
   time.sleep(10);continue
  if not isinstance(status,dict) or ('approved' in status and type(status['approved']) is not bool):raise SystemExit('Setup status could not be verified. Keep the pending config unchanged and rerun to check again.')
  if status.get('approved') is True:
   project=status.get('project_id')
   if not isinstance(project,str) or not re.fullmatch(r'proj_[a-f0-9]{32}',project):raise SystemExit('Approved project could not be verified. Pending config retained; rerun with the same config.')
   if bound and project!=bound:raise SystemExit('Approved project did not match the saved or requested project. Pending config retained; do not use this connection.')
   if status.get('environment_id','default')!=a.environment:raise SystemExit('Approved environment did not match the saved or requested environment. Pending config retained; do not use this connection.')
   approved={**state,'project_id':project,'approved':True,**({'environment_id':a.environment} if a.environment!='default' else {})};approved.pop('device_secret',None)
   try:atomic_write(path,json.dumps(approved).encode())
   except OSError:raise SystemExit('Approval could not be saved. Check the config folder is writable, then rerun with the same config to recover; do not start another setup.')
   print('Connected with write-only access. No traces have been uploaded.');return
  if status.get('pending') is not True:raise SystemExit('Setup status could not be verified. Keep the pending config unchanged and rerun to check again.')
  time.sleep(10)
 raise SystemExit('Not yet confirmed. Rerun with the same config to continue; no key is printed or discarded.')
if __name__=='__main__':
 try:main()
 except KeyboardInterrupt:raise SystemExit('Setup interrupted. Keep any saved config unchanged and rerun with the same config path to continue.')
