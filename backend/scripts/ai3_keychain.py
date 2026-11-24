"""macOS token storage for the standalone AI delivery adapter."""
import json
import re
import subprocess
import sys


class KeychainTokens:
    def __init__(self, account):
        if sys.platform != "darwin":
            raise RuntimeError("Provide an OS secure token store on this platform")
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", account):
            raise ValueError("Use a user ID or an account identifier")
        self.account = account
        self.service = "FocusLens.AI.delivery"

    def get(self):
        result = subprocess.run(
            ["/usr/bin/security", "find-generic-password", "-s", self.service, "-a", self.account, "-w"],
            capture_output=True, text=True, timeout=15, check=False,
        )
        if result.returncode != 0:
            raise RuntimeError("Keychain credentials unavailable; sign in again")
        tokens = json.loads(result.stdout)
        if not all(isinstance(tokens.get(key), str) and tokens[key] for key in ("access_token", "refresh_token")):
            raise RuntimeError("Keychain credentials invalid; sign in again")
        return tokens

    def set(self, access_token, refresh_token):
        if not all(isinstance(token, str) and token for token in (access_token, refresh_token)):
            raise ValueError("Both tokens are required")
        value = json.dumps({"access_token": access_token, "refresh_token": refresh_token}, separators=(",", ":"))
        # The interactive command travels over stdin so tokens never enter process arguments.
        quoted = '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
        command = f'add-generic-password -U -s "{self.service}" -a "{self.account}" -w {quoted}\n'
        result = subprocess.run(
            ["/usr/bin/security", "-i"], input=command, capture_output=True, text=True, timeout=15, check=False,
        )
        # security's interactive process may return zero after reporting a command error.
        if result.returncode != 0 or "SecKeychain" in result.stderr or "error" in result.stderr.lower():
            raise RuntimeError("Could not save rotated credentials to Keychain")
        if self.get() != {"access_token": access_token, "refresh_token": refresh_token}:
            raise RuntimeError("Keychain credential update was not confirmed")

    def __repr__(self):
        return "KeychainTokens(<redacted>)"
