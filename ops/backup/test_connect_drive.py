import configparser
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import Mock, patch


class OAuthConfigurationTests(unittest.TestCase):
    def test_oauth_secret_remains_literal_while_crypt_passwords_are_obscured(self):
        spec = importlib.util.spec_from_file_location('connect_drive', Path(__file__).with_name('connect-drive.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        fixture = {'client_id': 'fixture-client', 'client_secret': 'fixture-oauth-secret',
                   'token': {'access_token': 'fixture-token'},
                   'password': 'fixture-encryption-password', 'salt': 'fixture-salt'}
        output = io.StringIO()
        with patch('sys.stdin', io.StringIO(json.dumps(fixture))), \
                patch('pathlib.Path'), patch('os.replace'), \
                patch('subprocess.run', return_value=Mock(stdout='obscured-fixture\n')), \
                contextlib.redirect_stdout(output):
            exec(module.INSTALL, {})
        config = configparser.ConfigParser(interpolation=None)
        config.read_string(output.getvalue())
        # rclone passes client_secret directly to Google; obscuring it breaks refresh.
        self.assertEqual(config['gdrive']['client_secret'], fixture['client_secret'])
        self.assertEqual(config['gdrive']['scope'], 'drive.file')
        self.assertEqual(config['backup']['password'], 'obscured-fixture')
        self.assertEqual(config['backup']['password2'], 'obscured-fixture')
        self.assertEqual(config['backup']['filename_encryption'], 'standard')
        self.assertEqual(config['backup']['directory_name_encryption'], 'false')


if __name__ == '__main__':
    unittest.main()
