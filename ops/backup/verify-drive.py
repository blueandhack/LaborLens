#!/usr/bin/env python3
"""Download the latest verified Drive archive and restore it in local, isolated Docker.

Google credentials stay on the configured backup host. Plaintext archive bytes pass over SSH directly
into a temporary MongoDB container, without writing an archive on the Mac.
The container and its anonymous data volumes are removed when the check finishes.
"""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import secrets
import shlex
import subprocess
import sys
import time

from backup import snapshot_time


def run(args, **kwargs):
    return subprocess.run(args, check=True, timeout=kwargs.pop('timeout', 120), **kwargs)


def remote(command):
    host = os.environ.get('BACKUP_SSH_TARGET', '')
    if not host or host.startswith('-') or any(char.isspace() for char in host):
        raise ValueError('Set BACKUP_SSH_TARGET to a valid SSH target')
    return ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, command]


def drive_cat(path):
    return remote('rclone --config /etc/laborlens-backup/rclone.conf cat ' + shlex.quote(path))


def main():
    os.umask(0o077)
    last = json.loads(run(remote('cat /var/lib/laborlens-backup/last-success.json'),
                          capture_output=True, text=True).stdout)
    path = last['remote']
    if not path.startswith('backup:mongodb/'):
        raise RuntimeError('Unexpected backup path')
    snapshot_time(path.removeprefix('backup:mongodb/'))
    complete = json.loads(run(drive_cat(path + '/complete.json'), capture_output=True, text=True).stdout)
    if not complete.get('verifiedAt'):
        raise RuntimeError('Backup has no verified completion marker')
    manifest = json.loads(run(drive_cat(path + '/manifest.json'), capture_output=True, text=True).stdout)
    if manifest.get('database') != 'pwd_cases' or manifest['archiveSha256'] != last['sha256']:
        raise RuntimeError('Backup manifest does not match last-success status')
    name = 'laborlens-drive-restore-' + secrets.token_hex(6)
    image = 'mongo:9.0.8'
    run(['docker', 'image', 'inspect', image], stdout=subprocess.DEVNULL)
    run(['docker', 'run', '--detach', '--rm', '--name', name, '--network', 'none',
         '--user', '999:999', '--memory=1536m', '--cpus=2', image,
         '--bind_ip', '127.0.0.1', '--wiredTigerCacheSizeGB=0.25'], stdout=subprocess.DEVNULL)
    print('Started isolated local MongoDB restore check', flush=True)
    try:
        for attempt in range(60):
            ping = subprocess.run(['docker', 'exec', name, 'mongosh', '--quiet', '--eval',
                                   'quit(db.adminCommand({ping:1}).ok ? 0 : 1)'],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
            if ping.returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError('Temporary MongoDB did not become ready')
        restore = subprocess.Popen(['docker', 'exec', '-i', name, 'mongorestore',
                                    '--uri=mongodb://127.0.0.1:27017', '--archive', '--gzip',
                                    '--numParallelCollections=1', '--numInsertionWorkersPerCollection=1'],
                                   stdin=subprocess.PIPE)
        download = subprocess.Popen(drive_cat(path + '/pwd_cases.archive.gz'), stdout=subprocess.PIPE)
        digest = hashlib.sha256()
        size = 0
        started = time.monotonic()
        next_report = started + 30
        try:
            for chunk in iter(lambda: download.stdout.read(1024 * 1024), b''):
                if time.monotonic() - started > 7200:
                    raise TimeoutError('Restore check exceeded two hours')
                digest.update(chunk)
                size += len(chunk)
                restore.stdin.write(chunk)
                if time.monotonic() >= next_report:
                    print(f'Downloaded and restored {size / 1024**2:.0f} MiB of compressed data', flush=True)
                    next_report = time.monotonic() + 30
            restore.stdin.close()
            if download.wait(timeout=60):
                raise RuntimeError('Drive download failed')
            if digest.hexdigest() != last['sha256'] or size != last['archiveBytes']:
                raise RuntimeError('Downloaded archive checksum or size mismatch')
            print('Downloaded archive SHA-256 and size match', flush=True)
            if restore.wait(timeout=3600):
                raise RuntimeError('MongoDB restore failed')
        finally:
            for process in (download, restore):
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=15)
            download.stdout.close()
        source = 'const manifest = ' + json.dumps(manifest) + ';\n' + r'''
const app = db.getSiblingDB('pwd_cases');
const results = [];
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
    return value;
}
function normalized(index) {
    const {key, ...options} = index;
    return {key: JSON.stringify(key), options: canonical(options)};
}
for (const expected of manifest.collections) {
    const collection = app.getCollection(expected.name);
    const count = collection.countDocuments({});
    if (count !== expected.count && !(expected.name === 'import_runs' && count >= expected.count)) {
        throw Error(expected.name + ': document count mismatch');
    }
    const actualIndexes = collection.getIndexes().sort((a,b) => a.name.localeCompare(b.name)).map(normalized);
    const expectedIndexes = [...expected.indexes].sort((a,b) => a.name.localeCompare(b.name)).map(normalized);
    if (JSON.stringify(actualIndexes) !== JSON.stringify(expectedIndexes)) throw Error(expected.name + ': index definitions differ');
    results.push({name: expected.name, count, indexes: actualIndexes.length});
}
if (app.getCollection('import_locks').countDocuments({}) !== 0) throw Error('Stale import lease was restored');
print(JSON.stringify({collections: results, valid: true}));
'''
        verified = json.loads(run(['docker', 'exec', '-i', name, 'mongosh', '--quiet', '--file', '/dev/stdin'],
                                  input=source, capture_output=True, text=True, timeout=600).stdout)
        result = {'verifiedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
                  'remote': path, 'archiveBytes': size, 'sha256': digest.hexdigest(), **verified}
        destination = Path(__file__).resolve().parents[2] / '.local/backup/restore-check.json'
        destination.write_text(json.dumps(result, indent=2))
        print(json.dumps(result, indent=2), flush=True)
    finally:
        run(['docker', 'stop', '--time', '30', name], stdout=subprocess.DEVNULL)
        print('Temporary restore container and volumes removed', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'Restore verification failed: {error}', file=sys.stderr)
        sys.exit(1)
