"""Durable v2 outbox used by the AI integration adapter.

The caller supplies a token store. Credentials never enter the SQLite outbox.
Only one process owns an outbox, so rotating refresh tokens and ending a session
cannot race another worker using the same queue.

One capture thread may enqueue while one delivery worker performs HTTP requests.
Stop and join workers before closing the client.
"""
import fcntl
import hashlib
import json
import math
import os
import random as random_module
import sqlite3
import threading
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from uuid import UUID

import httpx


RETRYABLE_STATUSES = {408, 429, 500, 502, 503, 504}
BACKOFF_SECONDS = (1, 2, 4, 8, 16, 30)
SCORE_FIELDS = ("gaze", "blink", "head", "total")


class DeliveryBlocked(RuntimeError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


class MemoryTokens:
    def __init__(self, access_token, refresh_token):
        self.set(access_token, refresh_token)

    def get(self):
        return dict(self._tokens)

    def set(self, access_token, refresh_token):
        if not isinstance(access_token, str) or not access_token or not isinstance(refresh_token, str) or not refresh_token:
            raise DeliveryBlocked("invalid_credentials")
        self._tokens = {"access_token": access_token, "refresh_token": refresh_token}

    def __repr__(self):
        return "MemoryTokens(<redacted>)"


def response_data(response):
    try:
        envelope = response.json()
        if envelope.get("success") is True and isinstance(envelope.get("data"), dict):
            return envelope["data"]
    except (ValueError, AttributeError):
        pass
    raise DeliveryBlocked("invalid_response")


def retry_after(response):
    value = response.headers.get("Retry-After")
    if value is None:
        return None
    try:
        delay = float(value)
        return delay if math.isfinite(delay) and delay >= 0 else None
    except ValueError:
        try:
            date = parsedate_to_datetime(value)
            return max(0, (date - datetime.now(timezone.utc)).total_seconds())
        except (ValueError, TypeError, OverflowError):
            return None


def canonical_payload(payload):
    expected = {"client_log_id", "measured_at", "face_detected", *SCORE_FIELDS}
    if not isinstance(payload, dict) or set(payload) != expected:
        raise DeliveryBlocked("invalid_payload")
    try:
        if UUID(payload["client_log_id"]).version != 4 or not payload["measured_at"].endswith("Z"):
            raise ValueError
        datetime.fromisoformat(payload["measured_at"].replace("Z", "+00:00"))
    except (ValueError, TypeError, AttributeError):
        raise DeliveryBlocked("invalid_payload") from None
    if not isinstance(payload["face_detected"], bool):
        raise DeliveryBlocked("invalid_payload")
    for field in SCORE_FIELDS:
        value = payload[field]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 100:
            raise DeliveryBlocked("invalid_payload")
    if not payload["face_detected"] and any(payload[field] != 0 for field in SCORE_FIELDS):
        raise DeliveryBlocked("invalid_payload")
    normalized = {**payload, **{field: float(payload[field]) for field in SCORE_FIELDS}}
    return json.dumps(normalized, sort_keys=True, separators=(",", ":"), allow_nan=False)


class DeliveryClient:
    def __init__(self, base_url, queue_path, tokens, http=None, sleep=time.sleep,
                 random=random_module.random, max_retries=8):
        if isinstance(max_retries, bool) or not isinstance(max_retries, int) or not 0 <= max_retries <= 8:
            raise ValueError("max_retries must be between zero and eight")
        url = httpx.URL(base_url)
        if url.scheme not in ("http", "https") or not url.host or url.userinfo or url.query or url.fragment:
            raise ValueError("base_url must be an HTTP(S) origin without credentials")
        self.base_url = base_url.rstrip("/")
        self.tokens = tokens
        self.sleep = sleep
        self.random = random
        self.max_retries = max_retries
        self._mutex = threading.RLock()
        # SQLite transactions stay short so a completed camera minute can be
        # committed while delivery waits on HTTP, secure storage or backoff.
        self._delivery_mutex = threading.RLock()
        self._owns_http = http is None
        self.http = http or httpx.Client(timeout=10, follow_redirects=False)
        path = Path(queue_path)
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd = os.open(str(path) + ".lock", os.O_CREAT | os.O_RDWR, 0o600)
        self._lock = os.fdopen(fd, "a")
        try:
            fcntl.flock(self._lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self._lock.close()
            if self._owns_http:
                self.http.close()
            raise DeliveryBlocked("queue_in_use") from None
        self.db = None
        try:
            fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
            os.close(fd)
            self.db = sqlite3.connect(path, check_same_thread=False)
            self.db.row_factory = sqlite3.Row
            self.db.executescript("""
                PRAGMA journal_mode=WAL;
                PRAGMA synchronous=FULL;
                CREATE TABLE IF NOT EXISTS outbox (
                    session_id TEXT NOT NULL,
                    client_log_id TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    attempts INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT,
                    discard_reason TEXT,
                    PRIMARY KEY(session_id, client_log_id)
                );
                CREATE TABLE IF NOT EXISTS delivery_sessions (
                    session_id TEXT PRIMARY KEY,
                    status TEXT NOT NULL DEFAULT 'open',
                    end_data TEXT
                );
                CREATE TABLE IF NOT EXISTS delivery_metadata (
                    name TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
            """)
        except Exception:
            self.close()
            raise

    def close(self):
        if self.db is not None:
            self.db.close()
            self.db = None
        if not self._lock.closed:
            fcntl.flock(self._lock, fcntl.LOCK_UN)
            self._lock.close()
        if self._owns_http:
            self.http.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def enqueue(self, session_id, payload):
        try:
            UUID(session_id)
        except (ValueError, TypeError, AttributeError):
            raise DeliveryBlocked("invalid_session") from None
        encoded = canonical_payload(payload)
        with self._mutex, self.db:
            existing = self.db.execute("SELECT payload FROM outbox WHERE session_id=? AND client_log_id=?",
                                       (session_id, payload["client_log_id"])).fetchone()
            if existing:
                if existing["payload"] != encoded:
                    raise DeliveryBlocked("immutable_payload")
                return payload["client_log_id"]
            self.db.execute("INSERT OR IGNORE INTO delivery_sessions(session_id) VALUES (?)", (session_id,))
            state = self.db.execute("SELECT status FROM delivery_sessions WHERE session_id=?", (session_id,)).fetchone()
            if state["status"] != "open":
                raise DeliveryBlocked("session_closing")
            self.db.execute("INSERT INTO outbox(session_id,client_log_id,payload) VALUES (?,?,?)",
                            (session_id, payload["client_log_id"], encoded))
        return payload["client_log_id"]

    def records(self, session_id):
        with self._mutex:
            rows = self.db.execute("SELECT * FROM outbox WHERE session_id=? ORDER BY json_extract(payload,'$.measured_at'),rowid",
                                   (session_id,)).fetchall()
            return [{**dict(row), "payload": json.loads(row["payload"])} for row in rows]

    def _mark(self, session_id, client_id, status, error=None):
        with self._mutex, self.db:
            self.db.execute("UPDATE outbox SET status=?,last_error=? WHERE session_id=? AND client_log_id=?",
                            (status, error, session_id, client_id))

    def _request(self, method, path, payload=None):
        # Both the worker and any authenticated control request use this lock;
        # a rotating Refresh Token must never be used by concurrent requests.
        with self._delivery_mutex:
            return self._request_serialized(method, path, payload)

    def _request_serialized(self, method, path, payload=None):
        tokens = self.tokens.get()
        response = self.http.request(method, self.base_url + path, json=payload,
                                     headers={"Authorization": "Bearer " + tokens["access_token"]})
        if response.status_code != 401:
            return response
        fingerprint = hashlib.sha256(tokens["refresh_token"].encode()).hexdigest()
        with self._mutex:
            uncertain = self.db.execute("SELECT value FROM delivery_metadata WHERE name='refresh_in_flight'").fetchone()
        if uncertain and uncertain["value"] == fingerprint:
            raise DeliveryBlocked("authentication_required")
        # Persist intent before transmission. A response lost after rotation (or
        # a process crash here) must never cause reuse of the old refresh token.
        with self._mutex, self.db:
            self.db.execute("INSERT OR REPLACE INTO delivery_metadata(name,value) VALUES ('refresh_in_flight',?)",
                            (fingerprint,))
        try:
            rotated = self.http.post(self.base_url + "/api/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
        except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout):
            self._clear_refresh_guard()
            raise
        except httpx.TransportError:
            raise DeliveryBlocked("authentication_required") from None
        if rotated.status_code == 401:
            raise DeliveryBlocked("authentication_required")
        if rotated.status_code != 200:
            self._clear_refresh_guard()
            return rotated
        try:
            data = response_data(rotated)
            self.tokens.set(data["access_token"], data["refresh_token"])
        except Exception:
            raise DeliveryBlocked("credential_store_failed") from None
        self._clear_refresh_guard()
        response = self.http.request(method, self.base_url + path, json=payload,
                                     headers={"Authorization": "Bearer " + data["access_token"]})
        if response.status_code == 401:
            raise DeliveryBlocked("authentication_required")
        return response

    def _clear_refresh_guard(self):
        with self._mutex, self.db:
            self.db.execute("DELETE FROM delivery_metadata WHERE name='refresh_in_flight'")

    def _pause(self, retry, response):
        delay = retry_after(response) if response is not None and response.status_code == 429 else None
        if delay is None:
            delay = BACKOFF_SECONDS[min(retry, len(BACKOFF_SECONDS) - 1)] * self.random()
        self.sleep(delay)

    def _deliver(self, method, path, payload=None, attempt=None, validate=None):
        for retry in range(self.max_retries + 1):
            response = None
            if attempt:
                attempt()
            try:
                response = self._request(method, path, payload)
                if response.status_code == 200:
                    data = response_data(response)
                    if validate:
                        validate(data)
                    return data
                if response.status_code not in RETRYABLE_STATUSES:
                    raise DeliveryBlocked(f"http_{response.status_code}")
            except httpx.TransportError:
                pass
            except DeliveryBlocked as error:
                if error.code != "invalid_response":
                    raise
            if retry < self.max_retries:
                self._pause(retry, response)
        raise DeliveryBlocked("retry_exhausted")

    def drain(self, session_id):
        with self._delivery_mutex:
            status = "drained"
            for row in self.records(session_id):
                if row["status"] != "pending":
                    continue
                client_id = row["client_log_id"]

                def attempt():
                    with self._mutex, self.db:
                        self.db.execute("UPDATE outbox SET attempts=attempts+1 WHERE session_id=? AND client_log_id=?",
                                        (session_id, client_id))

                def receipt(data):
                    try:
                        same_id = UUID(data["client_log_id"]) == UUID(client_id)
                        received_time = datetime.fromisoformat(data["measured_at"].replace("Z", "+00:00"))
                        measured_time = datetime.fromisoformat(row["payload"]["measured_at"].replace("Z", "+00:00"))
                    except (KeyError, ValueError, TypeError, AttributeError):
                        raise DeliveryBlocked("invalid_response") from None
                    if not same_id or received_time != measured_time:
                        raise DeliveryBlocked("invalid_response")

                try:
                    self._deliver("POST", f"/api/v2/sessions/{session_id}/log", row["payload"], attempt, receipt)
                except DeliveryBlocked as error:
                    pending = error.code in {"retry_exhausted", "authentication_required", "invalid_credentials", "credential_store_failed"}
                    self._mark(session_id, client_id, "pending" if pending else "failed", error.code)
                    status = "authentication_required" if error.code in {"authentication_required", "credential_store_failed"} else "pending"
                    if pending:
                        break
                else:
                    self._mark(session_id, client_id, "sent")
            rows = self.records(session_id)
            counts = {key: sum(row["status"] == key for row in rows) for key in ("sent", "pending", "failed", "discarded")}
            if counts["failed"]:
                status = "failed"
            elif counts["pending"] and status == "drained":
                # Capture can append after the delivery snapshot was taken.
                status = "pending"
            return {**counts, "status": status}

    def discard(self, session_id, client_log_id, reason):
        if not isinstance(reason, str) or not reason.strip() or len(reason) > 500:
            raise DeliveryBlocked("discard_reason_required")
        with self._mutex, self.db:
            changed = self.db.execute("UPDATE outbox SET status='discarded',discard_reason=? "
                                      "WHERE session_id=? AND client_log_id=? AND status='failed'",
                                      (reason, session_id, client_log_id))
            if changed.rowcount != 1:
                raise DeliveryBlocked("not_a_failed_log")

    def finish_session(self, session_id):
        with self._delivery_mutex:
            with self._mutex, self.db:
                self.db.execute("INSERT OR IGNORE INTO delivery_sessions(session_id) VALUES (?)", (session_id,))
                stored = self.db.execute("SELECT * FROM delivery_sessions WHERE session_id=?", (session_id,)).fetchone()
                if stored["status"] == "ended":
                    return json.loads(stored["end_data"])
                self.db.execute("UPDATE delivery_sessions SET status='closing' WHERE session_id=?", (session_id,))
            result = self.drain(session_id)
            if result["failed"]:
                raise DeliveryBlocked("failed_logs")
            if result["pending"]:
                raise DeliveryBlocked("pending_logs")
            try:
                data = self._deliver("POST", f"/api/sessions/{session_id}/end")
            except DeliveryBlocked as error:
                if error.code != "http_409":
                    raise
                session = self._deliver("GET", f"/api/sessions/{session_id}")
                if session.get("status") != "COMPLETED":
                    raise
                report = self._deliver("GET", f"/api/reports/{session_id}")
                data = {"session_id": session_id, "status": "COMPLETED", "report_id": report["report_id"],
                        "summary": report["summary_json"]}
            with self._mutex, self.db:
                self.db.execute("UPDATE delivery_sessions SET status='ended',end_data=? WHERE session_id=?",
                                (json.dumps(data), session_id))
            return data
