import json
import sys
import unittest
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ai3_keychain import KeychainTokens


class KeychainTests(unittest.TestCase):
    @patch("ai3_keychain.sys.platform", "darwin")
    @patch("ai3_keychain.subprocess.run")
    def test_rotation_uses_stdin_and_verifies_the_saved_pair(self, run):
        pair = dict(access_token="test-access", refresh_token="test-refresh")
        run.side_effect = [CompletedProcess([], 0, "", ""), CompletedProcess([], 0, json.dumps(pair), "")]
        store = KeychainTokens("test-user")
        store.set(**pair)
        command = run.call_args_list[0]
        self.assertEqual(command.args[0], ["/usr/bin/security", "-i"])
        self.assertIn(pair["refresh_token"], command.kwargs["input"])
        self.assertNotIn(pair["refresh_token"], repr(command.args))
        self.assertNotIn(pair["refresh_token"], repr(store))

    @patch("ai3_keychain.sys.platform", "darwin")
    @patch("ai3_keychain.subprocess.run")
    def test_interactive_error_is_reported_without_secrets(self, run):
        run.return_value = CompletedProcess([], 0, "", "SecKeychain: denied")
        with self.assertRaisesRegex(RuntimeError, "Could not save"):
            KeychainTokens("test-user").set("access", "refresh")

    @patch("ai3_keychain.sys.platform", "darwin")
    def test_account_cannot_add_interactive_commands(self):
        with self.assertRaises(ValueError):
            KeychainTokens('user"\nother-command')
