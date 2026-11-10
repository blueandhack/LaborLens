import datetime as dt
import gzip
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

import backup


def stamp(date, suffix='00000000'):
    return date.strftime('%Y%m%dT%H%M%SZ-') + suffix


class BackupTests(unittest.TestCase):
    def test_snapshot_name_uses_capture_time_in_utc(self):
        name = backup.snapshot_name('2025-04-15T18:10:11.123-07:00')
        self.assertRegex(name, r'^2025-04-16_01-10-11_UTC-[0-9a-f]{8}$')
        self.assertEqual(backup.snapshot_time(name), dt.datetime(2025, 4, 16, 1, 10, 11, tzinfo=dt.timezone.utc))

    def test_retention_sorts_legacy_and_readable_names_by_time(self):
        old = '20261106T120000Z-00000000'
        new = '2026-11-07_12-00-00_UTC-00000000'
        self.assertEqual(backup.retention([old, new], daily=1, weekly=1), [old])
        self.assertEqual(backup.retention(['2026-99-07_12-00-00_UTC-00000000']), [])

    def test_retention_keeps_recent_days_and_four_distinct_weeks(self):
        newest = dt.datetime(2026, 11, 6, 20, tzinfo=dt.timezone.utc)
        names = [stamp(newest - dt.timedelta(days=i)) for i in range(45)]
        removed = set(backup.retention(names))
        kept = set(names) - removed
        self.assertTrue(set(names[:7]).issubset(kept))
        for days_ago in (0, 5, 12, 19):
            self.assertIn(names[days_ago], kept)
        self.assertNotIn(names[35], kept)
        self.assertLessEqual(len(kept), 11)

    def test_retention_does_not_touch_unrelated_or_partial_names(self):
        self.assertEqual(backup.retention(['manual', '../anything', '20261106', 'migration-copy']), [])

    def test_retention_accounts_for_pacific_date_and_year_boundary(self):
        dates = [dt.datetime(2027, 1, 1, 1, tzinfo=dt.timezone.utc),
                 dt.datetime(2026, 12, 31, 23, tzinfo=dt.timezone.utc)]
        names = [stamp(d) for d in dates]
        # Both snapshots are December 31 in Pacific time; only the later one survives.
        self.assertEqual(backup.retention(names, daily=1, weekly=1), [names[1]])

    def test_corrupt_compressed_archive_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'archive.gz'
            file.write_bytes(gzip.compress(b'backup-data')[:-5])
            with self.assertRaises(EOFError):
                backup.verify_gzip(file)

    def test_plaintext_or_wrong_destination_is_rejected(self):
        drive = backup.Drive()
        drive.run = Mock(return_value=Mock(stdout=json.dumps({'backup': {'type': 'drive'}})))
        with self.assertRaisesRegex(RuntimeError, 'encrypt'):
            drive.preflight()
        self.assertEqual(drive.run.call_count, 1)

    def test_failed_integrity_check_does_not_publish_completion_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            (folder / 'archive.gz').write_bytes(b'data')
            drive = backup.Drive()
            drive.run = Mock(side_effect=[None, RuntimeError('checksum mismatch')])
            with self.assertRaisesRegex(RuntimeError, 'checksum mismatch'):
                drive.publish(folder, '20261106T120000Z-00000000')
            self.assertFalse((folder / 'complete.json').exists())
            self.assertEqual(drive.run.call_count, 2)

    def test_broader_drive_permissions_are_rejected_before_accessing_drive(self):
        for scope in ['drive', 'drive.file,drive.readonly', '']:
            with self.subTest(scope=scope):
                drive = backup.Drive()
                config = {'backup': {'type': 'crypt', 'remote': 'gdrive:LaborLens-Backups'},
                          'gdrive': {'type': 'drive', 'scope': scope}}
                drive.run = Mock(return_value=Mock(stdout=json.dumps(config)))
                with self.assertRaisesRegex(RuntimeError, 'broader scopes are rejected'):
                    drive.preflight()
                self.assertEqual(drive.run.call_count, 1)

    def test_incomplete_upload_does_not_displace_an_older_valid_backup(self):
        drive = backup.Drive()
        newest = dt.datetime(2026, 11, 6, 20, tzinfo=dt.timezone.utc)
        names = [stamp(newest - dt.timedelta(days=i)) for i in range(9)]
        drive.run = Mock(return_value=Mock(stdout='\n'.join(n + '/' for n in names)))
        # The seven newest directories are incomplete. Only the two old backups count.
        replies = [Mock(returncode=1, stdout='')] * 7 + [Mock(returncode=0, stdout='{}')] * 2
        with patch('backup.subprocess.run', side_effect=replies):
            drive.prune()
        self.assertEqual(drive.run.call_count, 1)  # listing only; no purge

    def test_lost_lease_stops_the_dump_and_rejects_the_snapshot(self):
        process = Mock()
        process.poll.return_value = None
        process.wait.return_value = 0
        lease = Mock()
        lease.manifest = {'database': 'pwd_cases'}
        lease.check.side_effect = RuntimeError('lease lost')
        with tempfile.TemporaryDirectory() as directory, patch('backup.command'), \
                patch('backup.subprocess.Popen', return_value=process):
            binary = Path(directory) / 'mongodump'
            binary.write_bytes(b'fake binary')
            with patch.dict(os.environ, {'MONGODUMP_BIN': str(binary)}):
                with self.assertRaisesRegex(RuntimeError, 'lease lost'):
                    backup.dump_database(['kubectl'], 'mongo-pod', Path(directory) / 'archive', lease)
        process.terminate.assert_called_once()

    def test_upload_failure_does_not_prune_or_record_success_and_removes_temporary_dump(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'BACKUP_STATE': directory}):
            drive = Mock()
            drive.publish.side_effect = RuntimeError('upload failed')
            lease = Mock(manifest={'database': 'pwd_cases', 'capturedAt': '2025-04-16T01:10:11Z'})
            pod = {'metadata': {'name': 'mongo'}, 'status': {'conditions': [{'type': 'Ready', 'status': 'True'}]}}

            def dump(_kubectl, _pod, path, _lease):
                path.write_bytes(gzip.compress(b'database'))

            with patch('backup.Drive', return_value=drive), \
                    patch('backup.Lease') as lease_class, \
                    patch('backup.command', return_value=Mock(stdout=json.dumps({'items': [pod]}))), \
                    patch('backup.dump_database', side_effect=dump):
                lease_class.return_value.__enter__.return_value = lease
                with self.assertRaisesRegex(RuntimeError, 'upload failed'):
                    backup.backup()
            drive.prune.assert_not_called()
            self.assertFalse((Path(directory) / 'last-success.json').exists())
            self.assertEqual(list(Path(directory).glob('snapshot-*')), [])

    def test_status_is_recorded_without_affecting_the_backup(self):
        with patch('backup.command', side_effect=RuntimeError('cluster unreachable')) as run, \
                patch('backup.next_scheduled_run', return_value='2026-12-01T12:05:00+00:00'):
            backup.record_status({'state': 'running'})  # A failure to record is only logged.
        args, kwargs = run.call_args
        self.assertEqual(args[0][:6], ['kubectl', '-n', 'laborlens', 'exec', '-i', 'deployment/laborlens-backend'])
        self.assertEqual(json.loads(kwargs['input']), {'state': 'running', 'nextRunAt': '2026-12-01T12:05:00+00:00'})


if __name__ == '__main__':
    unittest.main()
