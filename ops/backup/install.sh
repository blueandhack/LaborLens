#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
target=${BACKUP_SSH_TARGET:?Set BACKUP_SSH_TARGET privately to the backup host SSH target}
if [[ ! "$target" =~ ^[A-Za-z0-9_.@:-]+$ || "$target" == -* ]]; then
    echo 'BACKUP_SSH_TARGET must be a valid SSH target' >&2
    exit 1
fi
ssh "$target" 'install -d -m 700 /opt/laborlens-backup/bin /etc/laborlens-backup /var/lib/laborlens-backup'
scp backup.py lease.cjs test_backup.py integration_test.py laborlens-backup.service laborlens-backup.timer "$target:/opt/laborlens-backup/"
ssh "$target" bash -s <<'REMOTE'
set -euo pipefail
apt-get install -y --no-install-recommends rclone
for tool in mongodump mongorestore; do
    test -x "/opt/laborlens-backup/bin/$tool" || {
        echo "Install compatible MongoDB Database Tools at /opt/laborlens-backup/bin/$tool first" >&2
        exit 1
    }
done
install -m 644 /opt/laborlens-backup/laborlens-backup.service /etc/systemd/system/
install -m 644 /opt/laborlens-backup/laborlens-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/laborlens-backup.service /etc/systemd/system/laborlens-backup.timer
cd /opt/laborlens-backup
python3 -B -m unittest -v test_backup
echo 'Installed. Initial setup does not enable the timer; connect Drive and verify the first real backup first.'
REMOTE
