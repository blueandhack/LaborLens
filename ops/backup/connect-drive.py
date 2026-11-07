#!/usr/bin/env python3
"""Authorize personal Drive on this Mac, then install the encrypted remote over SSH.

Only stdlib dependencies. The OAuth callback and tokens never pass through chat.
Download a Desktop app client JSON to .local/backup/google-client.json first.
"""
import argparse
import base64
import datetime as dt
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time
import urllib.parse
import urllib.request


INSTALL = r'''
import configparser,io,json,os,pathlib,subprocess,sys
os.umask(0o077)
data=json.load(sys.stdin)
def obscure(value):
    return subprocess.run(['rclone','obscure','-'],input=value+'\n',text=True,capture_output=True,check=True).stdout.strip()
c=configparser.ConfigParser(interpolation=None)
# rclone's OAuth client_secret option is literal; crypt passwords use obscuring.
c['gdrive']={'type':'drive','client_id':data['client_id'],'client_secret':data['client_secret'],
             'scope':'drive.file','token':json.dumps(data['token'])}
c['backup']={'type':'crypt','remote':'gdrive:LaborLens-Backups','filename_encryption':'standard',
             'directory_name_encryption':'false','password':obscure(data['password']),'password2':obscure(data['salt'])}
out=io.StringIO();c.write(out)
p=pathlib.Path('/etc/laborlens-backup/rclone.conf');tmp=p.with_suffix('.new')
tmp.write_text(out.getvalue());tmp.chmod(0o600);os.replace(tmp,p)
print(out.getvalue(),end='')
'''


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--client', type=Path, default=Path(__file__).resolve().parents[2] / '.local/backup/google-client.json')
    parser.add_argument('--host', default=os.environ.get('BACKUP_SSH_TARGET'),
                        help='SSH target (or set BACKUP_SSH_TARGET privately)')
    args = parser.parse_args()
    if not args.host or args.host.startswith('-') or any(char.isspace() for char in args.host):
        parser.error('Set BACKUP_SSH_TARGET or --host to a valid SSH target')
    if not args.client.exists():
        parser.error(f'Save the Desktop app OAuth client JSON at {args.client} first')
    client = json.loads(args.client.read_text()).get('installed', {})
    if not client.get('client_id', '').endswith('.apps.googleusercontent.com') or not client.get('client_secret'):
        parser.error('Expected a Google Desktop app OAuth client JSON (installed client)')
    args.client.chmod(0o600)
    state = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
    result = {}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass  # Authorization codes must not appear in HTTP access logs.

        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            query = urllib.parse.parse_qs(parsed.query)
            if parsed.path != '/' or not secrets.compare_digest(query.get('state', [''])[0], state):
                self.send_error(400, 'Invalid authorization callback')
                return
            result.update({key: value[0] for key, value in query.items()})
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(b'Google authorization received. You can close this tab and return to Codex.')

    with HTTPServer(('127.0.0.1', 53682), Handler) as server:
        server.timeout = 1
        redirect = 'http://127.0.0.1:53682/'
        url = 'https://accounts.google.com/o/oauth2/v2/auth?' + urllib.parse.urlencode({
            'client_id': client['client_id'], 'redirect_uri': redirect, 'response_type': 'code',
            'scope': 'https://www.googleapis.com/auth/drive.file', 'access_type': 'offline',
            'prompt': 'consent', 'state': state, 'code_challenge': challenge, 'code_challenge_method': 'S256',
        })
        print('Open this link in your browser and authorize LaborLens Backups:\n' + url, flush=True)
        deadline = time.monotonic() + 900
        while not result and time.monotonic() < deadline:
            server.handle_request()
    if result.get('error') or not result.get('code'):
        raise RuntimeError('Google authorization was declined or timed out; nothing was enabled')
    body = urllib.parse.urlencode({
        'client_id': client['client_id'], 'client_secret': client['client_secret'],
        'code': result['code'], 'redirect_uri': redirect, 'grant_type': 'authorization_code',
        'code_verifier': verifier,
    }).encode()
    with urllib.request.urlopen(urllib.request.Request('https://oauth2.googleapis.com/token', data=body), timeout=30) as response:
        token = json.load(response)
    if not token.get('refresh_token'):
        raise RuntimeError('Google did not issue an offline refresh token; retry authorization')
    if set(token.get('scope', '').split()) != {'https://www.googleapis.com/auth/drive.file'}:
        raise RuntimeError('Google returned unexpected permissions; only drive.file access is allowed')
    token['expiry'] = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=token.pop('expires_in'))).isoformat()
    token.pop('scope', None)
    directory = args.client.parent
    recovery_path = directory / 'recovery.json'
    if recovery_path.exists():
        recovery = json.loads(recovery_path.read_text())
    else:
        recovery = {'password': secrets.token_urlsafe(48), 'salt': secrets.token_urlsafe(48)}
        recovery_path.write_text(json.dumps(recovery, indent=2))
    recovery_path.chmod(0o600)
    payload = {**recovery, 'client_id': client['client_id'], 'client_secret': client['client_secret'], 'token': token}
    # Keep a local private recovery config even if the SSH transfer fails.
    (directory / 'authorization.json').write_text(json.dumps(payload))
    (directory / 'authorization.json').chmod(0o600)
    install = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', args.host,
                              'python3 -c ' + __import__('shlex').quote(INSTALL)],
                             input=json.dumps(payload), capture_output=True, text=True, check=True)
    config_path = directory / 'rclone.conf'
    config_path.write_text(install.stdout)
    config_path.chmod(0o600)
    subprocess.run(['ssh', '-o', 'BatchMode=yes', args.host,
                    'python3 -c "import sys; sys.path.insert(0,\'/opt/laborlens-backup\'); from backup import Drive; Drive().preflight()"'],
                   check=True)
    print('Google Drive connected; encrypted remote verified. Credentials were saved privately.', flush=True)
    print(f'Keep an independent copy of {recovery_path} in your password manager.', flush=True)
    print('Ready for the first upload and timer activation.', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'Setup did not complete: {error}', file=sys.stderr)
        sys.exit(1)
