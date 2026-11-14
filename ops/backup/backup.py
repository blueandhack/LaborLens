#!/usr/bin/env python3
"""Case-consistent MongoDB dumps, encrypted Drive upload, verification, retention.

Runs on the configured backup host; mongodump runs inside the MongoDB pod.
Only a temporary archive is held on the backup host; credentials and status persist.
"""
import argparse
import contextlib
import datetime as dt
import fcntl
import gzip
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
LEGACY_STAMP = re.compile(r'^\d{8}T\d{6}Z-[0-9a-f]{8}$')
STAMP = re.compile(r'^(?:\d{8}T\d{6}Z|\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_UTC)-[0-9a-f]{8}$')
PACIFIC = ZoneInfo('America/Los_Angeles')


def snapshot_time(name):
    if not STAMP.fullmatch(name):
        raise ValueError('Unexpected backup folder name')
    pattern = '%Y%m%dT%H%M%SZ' if LEGACY_STAMP.fullmatch(name) else '%Y-%m-%d_%H-%M-%S_UTC'
    return dt.datetime.strptime(name[:-9], pattern).replace(tzinfo=dt.timezone.utc)


def snapshot_name(captured_at):
    captured = dt.datetime.fromisoformat(captured_at.replace('Z', '+00:00'))
    if captured.tzinfo is None:
        raise ValueError('Snapshot capture time must include a timezone')
    return captured.astimezone(dt.timezone.utc).strftime('%Y-%m-%d_%H-%M-%S_UTC-') + os.urandom(4).hex()


def log(message):
    print(f'{dt.datetime.now(dt.timezone.utc).isoformat()} {message}', flush=True)


def command(args, **kwargs):
    return subprocess.run(args, check=True, timeout=kwargs.pop('timeout', 600), **kwargs)


# Records the backup's state in the site database (discovery_state "backup") for
# the administration overview. Runs in the backend container, like the lease, and
# never affects the backup itself.
STATUS_SCRIPT = r'''
const { MongoClient } = require('mongodb');
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', async () => {
    const fields = JSON.parse(input);
    const dates = value => value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /At$/.test(key) && typeof item === 'string' ? new Date(item) : dates(item)]))
        : value;
    const client = await MongoClient.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
    try {
        await client.db().collection('discovery_state').updateOne({ _id: 'backup' }, { $set: { ...dates(fields), updatedAt: new Date() } }, { upsert: true });
    } finally { await client.close(); }
});
'''


def next_scheduled_run():
    try:
        value = subprocess.run(['systemctl', 'show', 'laborlens-backup.timer', '-p', 'NextElapseUSecRealtime', '--value'],
                               capture_output=True, text=True, timeout=15).stdout.strip()
        if value and value != 'n/a':
            # For example "Mon 2026-12-01 04:05:00 PST".
            stamp = ' '.join(value.split()[1:3])
            local = dt.datetime.strptime(stamp, '%Y-%m-%d %H:%M:%S').replace(tzinfo=ZoneInfo('America/Los_Angeles'))
            return local.astimezone(dt.timezone.utc).isoformat()
    except Exception:
        pass
    return None


def record_status(fields):
    try:
        fields = {**fields, 'nextRunAt': next_scheduled_run()}
        command(['kubectl', '-n', 'laborlens', 'exec', '-i', 'deployment/laborlens-backend', '--', 'node', '-e', STATUS_SCRIPT],
                input=json.dumps(fields), text=True, capture_output=True, timeout=90)
    except Exception as error:
        log(f'Backup status not recorded in the site database: {str(error)[:200]}')


def stop(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=15)


class Lease:
    def __init__(self, kubectl, test_database=None):
        self.kubectl = kubectl
        self.test_database = test_database
        self.events = queue.Queue()
        self.process = None
        self.last_seen = time.monotonic()

    def __enter__(self):
        source = (ROOT / 'lease.cjs').read_text()
        runtime = ['node', '-e', source]
        if self.test_database:
            if not re.fullmatch(r'laborlens_backup_test_[a-f0-9]+', self.test_database):
                raise ValueError('Integration tests must use an isolated backup test database')
            runtime = ['env', f'MONGO_URI=mongodb://laborlens-mongodb:27017/{self.test_database}'] + runtime
        self.process = subprocess.Popen(
            self.kubectl + ['exec', '-i', 'deployment/laborlens-backend', '--'] + runtime,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1,
        )

        def read_events():
            try:
                for line in self.process.stdout:
                    self.events.put(json.loads(line))
            except Exception as error:
                self.events.put({'event': 'error', 'message': str(error)})
            finally:
                self.events.put({'event': 'error', 'message': 'Backup lease connection closed'})

        threading.Thread(target=read_events, daemon=True).start()
        try:
            deadline = time.monotonic() + 21900
            while time.monotonic() < deadline:
                event = self.event(timeout=60)
                if event['event'] == 'ready':
                    self.manifest = event['manifest']
                    log('Import/clear lease acquired')
                    return self
                if event['event'] == 'waiting':
                    log('Waiting for the current import/clear to finish')
            raise TimeoutError('Timed out waiting for import lease')
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def event(self, timeout):
        try:
            event = self.events.get(timeout=timeout)
        except queue.Empty:
            raise RuntimeError('Backup lease stopped responding') from None
        self.last_seen = time.monotonic()
        if event['event'] == 'error':
            raise RuntimeError(event.get('message', 'Backup lease lost'))
        return event

    def check(self):
        if self.process.poll() is not None:
            raise RuntimeError('Backup lease process exited; rejecting dump')
        while not self.events.empty():
            self.event(timeout=0)
        if time.monotonic() - self.last_seen > 30:
            raise RuntimeError('Backup lease heartbeat lost; rejecting dump')

    def __exit__(self, *_):
        if self.process:
            if self.process.stdin:
                with contextlib.suppress(BrokenPipeError):
                    self.process.stdin.close()
            try:
                self.process.wait(timeout=45)
            except subprocess.TimeoutExpired:
                stop(self.process)
            self.process.stdout.close()


def dump_database(kubectl, pod, target, lease):
    # This older, pinned tools build supports the VPS CPU and MongoDB 9.
    source = os.environ.get('MONGODUMP_BIN', '/opt/laborlens-backup/bin/mongodump')
    remote_bin = '/tmp/laborlens-mongodump-100.20.0'
    database = lease.manifest['database']
    if database != 'pwd_cases' and not re.fullmatch(r'laborlens_backup_test_[a-f0-9]+', database):
        raise ValueError('Unexpected backup database')
    with open(source, 'rb') as binary:
        command(kubectl + ['exec', '-i', pod, '--', 'sh', '-c',
                          f'cat > {remote_bin} && chmod 700 {remote_bin}'], stdin=binary)
    # Authentication is supplied to the MongoDB pod through a Kubernetes
    # secret. Expand it only inside the pod instead of copying it to the backup
    # host or placing it in this process's command line.
    remote_command = (
        f'test -n "$MONGO_BACKUP_URI" && exec {remote_bin} '
        f'--uri="$MONGO_BACKUP_URI" --db={database} --archive --gzip '
        '--numParallelCollections=1 --excludeCollection=import_locks'
    )
    args = kubectl + ['exec', pod, '--', 'sh', '-c', remote_command]
    log('Dumping in the MongoDB pod; application searches remain available')
    with target.open('wb') as output:
        process = subprocess.Popen(args, stdout=output)
        try:
            deadline = time.monotonic() + 3600
            while process.poll() is None:
                lease.check()
                if time.monotonic() > deadline:
                    raise TimeoutError('Database dump exceeded one hour')
                time.sleep(1)
            lease.check()
            if process.returncode:
                raise RuntimeError(f'mongodump exited {process.returncode}')
        finally:
            stop(process)


def verify_gzip(path):
    with gzip.open(path, 'rb') as stream:
        while stream.read(1024 * 1024):
            pass


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def retention(names, daily=7, weekly=4):
    """Keep the latest snapshot on each of 7 days and in each of 4 ISO weeks."""
    snapshots = []
    for name in names:
        try:
            snapshots.append((name, snapshot_time(name).astimezone(PACIFIC)))
        except ValueError:
            continue
    keep = set()
    days, weeks = set(), set()
    for name, date in sorted(snapshots, key=lambda item: (item[1], item[0]), reverse=True):
        if date.date() not in days and len(days) < daily:
            keep.add(name)
            days.add(date.date())
        week = date.isocalendar()[:2]
        if week not in weeks and len(weeks) < weekly:
            keep.add(name)
            weeks.add(week)
    return sorted(name for name, _ in snapshots if name not in keep)


class Drive:
    def __init__(self):
        self.config = os.environ.get('RCLONE_CONFIG', '/etc/laborlens-backup/rclone.conf')
        self.remote = 'backup:mongodb'
        self.base = ['rclone', '--config', self.config, '--transfers=1', '--checkers=1',
                     '--buffer-size=4M', '--retries=3', '--contimeout=30s', '--timeout=5m']

    def run(self, *args, **kwargs):
        return command(self.base + list(args), **kwargs)

    def preflight(self):
        # Check the effective backend so credentials cannot accidentally select plaintext.
        # Capture credentials in memory only: never log the config dump.
        config = json.loads(self.run('config', 'dump', capture_output=True, text=True).stdout)
        if (config.get('backup', {}).get('type') != 'crypt' or
                config.get('backup', {}).get('remote') != 'gdrive:LaborLens-Backups' or
                config.get('gdrive', {}).get('type') != 'drive'):
            raise RuntimeError('Expected backup: to encrypt gdrive:LaborLens-Backups on Google Drive')
        if config['gdrive'].get('scope') != 'drive.file':
            raise RuntimeError('Google Drive must use only drive.file access; broader scopes are rejected')
        if (config['backup'].get('filename_encryption', 'standard') != 'standard' or
                str(config['backup'].get('directory_name_encryption')).lower() != 'false'):
            raise RuntimeError('Expected encrypted filenames and readable dated directory names')
        self.run('mkdir', 'backup:')
        self.run('lsf', 'backup:', '--max-depth=1', capture_output=True, text=True)

    def publish(self, folder, name):
        destination = f'{self.remote}/{name}'
        log('Uploading encrypted recovery files to Google Drive')
        self.run('copy', str(folder), destination, timeout=7200)
        log('Encrypted upload finished; checking remote integrity')
        self.run('cryptcheck', str(folder), destination, '--one-way', timeout=7200)
        marker = folder / 'complete.json'
        marker.write_text(json.dumps({'verifiedAt': dt.datetime.now(dt.timezone.utc).isoformat()}))
        self.run('copyto', str(marker), destination + '/complete.json')

    def prune(self):
        result = self.run('lsf', self.remote, '--dirs-only', capture_output=True, text=True)
        complete = []
        for name in result.stdout.splitlines():
            name = name.rstrip('/')
            if not STAMP.fullmatch(name):
                continue
            # Retention must never mistake an incomplete upload for a recovery copy.
            probe = subprocess.run(self.base + ['cat', f'{self.remote}/{name}/complete.json'],
                                   capture_output=True, text=True, timeout=600)
            if probe.returncode:
                continue
            json.loads(probe.stdout)
            complete.append(name)
        for name in retention(complete):
            log(f'Moving expired backup to Google Drive Trash: {name}')
            self.run('purge', f'{self.remote}/{name}')


def backup(snapshot_only=None):
    state = Path(os.environ.get('BACKUP_STATE', '/var/lib/laborlens-backup'))
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (state / 'backup.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        started = dt.datetime.now(dt.timezone.utc)
        if snapshot_only is None:
            record_status({'state': 'running', 'startedAt': started.isoformat(), 'error': None})
        drive = Drive()
        if snapshot_only is None:
            drive.preflight()  # Fail before taking the application lease if OAuth is missing.
        kubectl = ['kubectl', '-n', 'laborlens']
        pods = json.loads(command(kubectl + ['get', 'pods', '-l', 'app=laborlens-mongodb', '-o', 'json'],
                                  capture_output=True, text=True).stdout)['items']
        ready = [p for p in pods if not p['metadata'].get('deletionTimestamp') and
                 any(c['type'] == 'Ready' and c['status'] == 'True' for c in p['status'].get('conditions', []))]
        if len(ready) != 1:
            raise RuntimeError('Expected exactly one ready database pod')
        with tempfile.TemporaryDirectory(prefix='snapshot-', dir=state) as temporary:
            folder = Path(temporary)
            archive = folder / 'pwd_cases.archive.gz'
            with Lease(kubectl) as lease:
                name = snapshot_name(lease.manifest['capturedAt'])
                dump_database(kubectl, ready[0]['metadata']['name'], archive, lease)
                manifest = lease.manifest
            log('Import/clear lease released; verifying compressed archive')
            verify_gzip(archive)
            digest = sha256(archive)
            log(f'Compressed archive validated: {archive.stat().st_size} bytes')
            manifest.update({'archiveSha256': digest, 'archiveBytes': archive.stat().st_size})
            (folder / 'manifest.json').write_text(json.dumps(manifest, indent=2))
            (folder / 'SHA256SUMS').write_text(f'{digest}  pwd_cases.archive.gz\n')
            if snapshot_only:
                shutil.copytree(folder, snapshot_only)
                log(f'Local rehearsal completed: {snapshot_only}')
                return
            drive.publish(folder, name)
            # Publication and verification must succeed before any retention runs.
            success = {
                'completedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
                'remote': f'{drive.remote}/{name}', 'archiveBytes': archive.stat().st_size,
                'sha256': digest,
            }
            (state / 'last-success.json').write_text(json.dumps(success, indent=2))
            record_status({'state': 'succeeded', 'finishedAt': success['completedAt'], 'error': None,
                           'lastSuccess': {**success, 'startedAt': started.isoformat(),
                                           'durationSeconds': round((dt.datetime.now(dt.timezone.utc) - started).total_seconds())}})
            log(f'Encrypted backup verified: {drive.remote}/{name}')
            drive.prune()
        log('Temporary server archive removed')


def main():
    os.umask(0o077)
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, lambda *_: sys.exit(1))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot-only', type=Path, help='Rehearse without Drive; save to a new private directory')
    args = parser.parse_args()
    try:
        backup(args.snapshot_only)
    except Exception as error:
        log(f'BACKUP FAILED: {error}')
        if args.snapshot_only is None:
            now = dt.datetime.now(dt.timezone.utc).isoformat()
            record_status({'state': 'failed', 'finishedAt': now, 'error': str(error)[:300],
                           'lastFailure': {'failedAt': now, 'error': str(error)[:300]}})
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
