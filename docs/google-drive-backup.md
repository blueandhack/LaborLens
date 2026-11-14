# Encrypted Google Drive backups

The optional utilities in `ops/backup/` create encrypted MongoDB backups in Google Drive, verify uploads, apply retention, and test recovery in an isolated local Docker container. This guide describes installation; it does not document a live deployment or contain account identifiers.

## Requirements

- A Linux backup host with Python 3.9+, Node available in the backend pod, `kubectl`, SSH, systemd, and rclone.
- Access to the LaborLens Kubernetes namespace through the backup host's private kubeconfig. The provided service uses the standard k3s kubeconfig location; adapt it for other distributions.
- Compatible `mongodump` and `mongorestore` binaries installed at `/opt/laborlens-backup/bin/` on the backup host. The runner expects Database Tools 100.20.0. Check the tools' OS/CPU compatibility before installation.
- For the local restore verifier, Docker with the `mongo:9.0.8` image available.

Choose your own SSH target and keep it outside tracked files:

```bash
export BACKUP_SSH_TARGET='root@your-backup-host'
bash ops/backup/install.sh
```

The installer requires root privileges on the backup host. It copies the runner and systemd units and runs local unit checks. It does not enable a disabled timer. The provided service requires access to the cluster kubeconfig; review its user and paths for your environment.

## Google authorization

1. Create or select your own Google Cloud project and enable the Google Drive API.
2. Configure Google Auth Platform branding, support/contact details, and the audience appropriate to your account. Supply your own homepage/privacy/terms links when required.
3. Request only `https://www.googleapis.com/auth/drive.file` and create a **Desktop app** OAuth client. Configure the app's publishing status for unattended use; review the current Google requirements in the references below.
4. Save the downloaded client JSON at `.local/backup/google-client.json`, outside version control.
5. Run `python3 -B ops/backup/connect-drive.py` with `BACKUP_SSH_TARGET` set. Open the generated authorization link in a browser on the same computer.

The connection uses a loopback callback, OAuth state validation and PKCE. It rejects an unexpected permission scope. The encrypted rclone remote is configured as `backup:`, backed by the `LaborLens-Backups` directory on the connected account. `drive.file` limits access to app-created or explicitly authorized files; it is **not a folder-only OAuth permission**. The fixed destination is enforced by the backup configuration.

Credentials are written privately to `/etc/laborlens-backup/rclone.conf` on the backup host and under `.local/backup/` locally. The OAuth client secret and tokens are literal values; rclone obscures encryption passwords, which is not a substitute for protecting the configuration file. Keep credentials in directories with mode 0700 and files with mode 0600. Reauthorization preserves existing encryption keys.

Save the encryption password and salt from `.local/backup/recovery.json` in an independent password manager. Losing both the configuration and those keys makes existing encrypted backups unreadable. Never commit client JSON, authorization/recovery files, rclone configurations, database archives or restore reports.

## Backup behavior

The runner backs up `pwd_cases` collections and their index definitions, excluding the runtime `import_locks` collection. It records counts, indexes, MongoDB version, archive size and SHA-256 in a manifest. The shared import/clear lease prevents case mutations during the dump. Independent admin changes and import audit entries may still occur; this is not a server-wide point-in-time snapshot.

The compressed archive is held temporarily on the backup host. The runner validates it, uploads through rclone encryption, and uses `cryptcheck` before publishing `complete.json`. The temporary archive is removed on success or handled failure. An unclean shutdown may leave an orphan directory under the service state directory; inspect it before removing it.

Directories use `YYYY-MM-DD_HH-MM-SS_UTC-<unique-id>`, based on capture time after acquiring the lease. Directory names are readable; file names and contents are encrypted. Recovery must use the same `filename_encryption=standard` and `directory_name_encryption=false` settings and the original encryption keys.

Retention keeps the latest completed backup on seven distinct Pacific dates plus the latest in four distinct ISO weeks, with overlapping selections stored once. Monthly runs normally retain seven snapshots; manual runs can change that selection. Incomplete uploads are excluded. Expired folders move to Drive Trash and may continue to consume storage until emptied or automatically removed.

The supplied timer runs monthly on the first day, in America/Los_Angeles, with up to five minutes of random delay and catch-up after a missed run. Review the unit before enabling it. The job can wait up to six hours for an import/clear to finish. Check the journal for failures; these utilities do not configure external alerts.

## Verify before enabling the timer

With `BACKUP_SSH_TARGET` set:

```bash
ssh "$BACKUP_SSH_TARGET" 'systemctl start --no-block laborlens-backup.service'
ssh "$BACKUP_SSH_TARGET" 'journalctl -u laborlens-backup.service -n 30 --no-pager'
python3 -B ops/backup/verify-drive.py
```

Confirm upload verification and a successful isolated download/restore test. Then enable scheduling:

```bash
ssh "$BACKUP_SSH_TARGET" 'systemctl enable --now laborlens-backup.timer'
ssh "$BACKUP_SSH_TARGET" 'systemctl list-timers laborlens-backup.timer --no-pager'
```

`verify-drive.py` downloads the latest completed archive over SSH directly into an isolated Docker MongoDB instance. It checks archive size/SHA-256, collection counts and index definitions, then removes its temporary container and volumes. Its report stays under ignored `.local/backup/`.

For manual recovery, list completed directories with rclone on the backup host, copy a selected snapshot into a new private directory, and verify `SHA256SUMS` against the manifest. Restore into a **new isolated database** with namespace remapping, then verify counts, indexes and application searches before planning a production cutover. Do not use a production `--drop` restore as a validation step. Backups include database data, not deployment credentials or host configuration; protect those separately.

## Local checks

These checks do not connect to the backup host or Google:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s ops/backup -v
node --check ops/backup/lease.cjs
bash -n ops/backup/install.sh
```

`integration_test.py` is an explicit server-side rehearsal. It creates and drops uniquely named `laborlens_backup_test_*` databases and uses a local encrypted remote. Run it only in an environment where those temporary database operations are authorized.

References: [Drive file scope](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [desktop OAuth and PKCE](https://developers.google.com/identity/protocols/oauth2/native-app), [rclone Drive setup](https://rclone.org/drive/#making-your-own-client-id), [rclone encryption](https://rclone.org/crypt/).
