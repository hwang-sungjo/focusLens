"""Private-stdin process adapter for LBE-4's ordinary local-server verifier."""
import argparse
import json
import sqlite3
import sys
import threading
from pathlib import Path
from urllib.parse import urlsplit


PRIVATE_KEYS = {"access_token", "refresh_token", "password", "password_hash", "credentials", "authorization"}
OUTPUT_LOCK = threading.Lock()


def public(value):
    if isinstance(value, dict):
        return {key: public(item) for key, item in value.items() if key.lower() not in PRIVATE_KEYS}
    if isinstance(value, (list, tuple)):
        return [public(item) for item in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return None


def emit(value):
    with OUTPUT_LOCK:
        print(json.dumps(public(value), allow_nan=False), flush=True)


def queue_snapshot(directory):
    """Read only known noncredential tables, independently of runtime status layout."""
    result = {"rows": [], "sessions": []}
    for candidate in sorted(Path(directory).rglob("*")):
        if not candidate.is_file() or candidate.name.endswith(("-wal", "-shm", ".lock")):
            continue
        try:
            with candidate.open("rb") as source:
                if source.read(16) != b"SQLite format 3\x00":
                    continue
            with sqlite3.connect(candidate.resolve().as_uri() + "?mode=ro", uri=True) as database:
                database.row_factory = sqlite3.Row
                tables = {row[0] for row in database.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                if "outbox" not in tables:
                    continue
                for row in database.execute(
                    "SELECT session_id,client_log_id,payload,status,attempts,last_error FROM outbox "
                    "ORDER BY json_extract(payload,'$.measured_at'),rowid"
                ):
                    item = dict(row)
                    item["payload"] = json.loads(item["payload"])
                    result["rows"].append(item)
                if "delivery_sessions" in tables:
                    result["sessions"].extend(dict(row) for row in database.execute(
                        "SELECT session_id,status FROM delivery_sessions ORDER BY session_id"
                    ))
        except (OSError, sqlite3.Error, ValueError):
            continue
    return result


def safe_error(error):
    code = getattr(error, "code", None)
    if isinstance(code, str) and 0 < len(code) <= 80 and all(char.isalnum() or char in "_.:-" for char in code):
        return code
    return "worker_failed"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    config = json.load(sys.stdin)
    url = urlsplit(config["base_url"])
    if (url.scheme != "http" or url.hostname not in ("127.0.0.1", "localhost") or not url.port
            or url.username or url.password or url.path not in ("", "/") or url.query or url.fragment):
        raise ValueError("An explicit local HTTP origin is required")
    directory = Path(config["state_dir"])
    if not directory.is_absolute():
        raise ValueError("An absolute private state directory is required")
    action = config["action"]
    if action not in {"measure", "finish", "status"}:
        raise ValueError("Unknown verification action")

    # No credentials are written to a file or placed in process arguments.
    import httpx
    from ai3_delivery import MemoryTokens
    from local_ai import LocalAIRuntime

    secure_store = config.get("secure_store", False)
    if not isinstance(secure_store, bool):
        raise ValueError("secure_store must be boolean")
    tokens = None if secure_store else MemoryTokens("uninitialized-access", "uninitialized-refresh")
    outcome = None
    error_code = None
    with httpx.Client(timeout=5.0, follow_redirects=False, trust_env=False) as client:
        try:
            with LocalAIRuntime(config["base_url"], state_dir=directory, tokens=tokens,
                                http=client, on_event=emit) as runtime:
                # Real verification reuses OS credentials across worker restarts.
                # Memory-only unit callers may still log in separately each time.
                if action == "measure" or not secure_store:
                    runtime.login(config["credentials"]["email"], config["credentials"]["password"])
                if action == "measure":
                    outcome = runtime.measure(minutes=config.get("minutes", 2),
                                              camera_index=config.get("camera_index", 0))
                elif action == "finish":
                    outcome = runtime.finish()
                else:
                    outcome = runtime.status()
        except Exception as error:
            error_code = safe_error(error)
    snapshot = queue_snapshot(directory)
    blocked = error_code is not None or any(row["status"] in {"pending", "failed"} for row in snapshot["rows"])
    emit({"event": "worker_result", "action": action, "ok": not blocked,
          "error_code": error_code, "result": outcome, "queue": snapshot})
    return 3 if blocked else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        emit({"event": "worker_result", "ok": False, "error_code": "worker_failed"})
        raise SystemExit(1)
