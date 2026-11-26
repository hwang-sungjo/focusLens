"""Standalone local camera/session adapter; credentials stay in macOS Keychain."""
import argparse
import fcntl
import getpass
import hashlib
import json
import os
import signal
import sys
import threading
from pathlib import Path
from uuid import UUID, uuid4

import httpx

from ai3_delivery import DeliveryBlocked, DeliveryClient, response_data
from ai3_keychain import KeychainTokens


ROOT = Path(__file__).resolve().parents[2]
PHASES = {"idle", "starting", "measuring", "paused", "closing", "ended"}


class LocalAIError(RuntimeError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def local_origin(value):
    url = httpx.URL(value)
    if (url.scheme != "http" or url.host not in {"localhost", "127.0.0.1"}
            or not url.port or url.userinfo or url.query or url.fragment or url.path not in {"", "/"}):
        raise LocalAIError("explicit_loopback_origin_required")
    return str(url).rstrip("/")


def atomic_json(file, value):
    temporary = file.with_name(f".{file.name}.{uuid4()}.tmp")
    try:
        with temporary.open("x", encoding="utf-8") as handle:
            os.chmod(temporary, 0o600)
            json.dump(value, handle, allow_nan=False, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, file)
    finally:
        temporary.unlink(missing_ok=True)


class _Sender:
    def __init__(self, runtime, wait_for_browser_auth=False):
        self.runtime = runtime
        self.wait_for_browser_auth = wait_for_browser_auth
        self.stop_event = threading.Event()
        self.wake = threading.Event()
        self.thread = threading.Thread(target=self.run, name="focuslens-delivery", daemon=True)

    def run(self):
        previous = None
        failures = 0
        while not self.stop_event.is_set():
            try:
                result = self.runtime.client.drain(self.runtime.state["session_id"])
                status = (result["sent"], result["pending"], result["failed"], result["status"])
                if status != previous:
                    self.runtime.emit("delivery_status", **result)
                    previous = status
                if result["failed"] or (result["status"] == "authentication_required" and not self.wait_for_browser_auth):
                    return
                failures = failures + 1 if result["pending"] else 0
            except Exception:
                self.runtime.emit("delivery_paused", code="authentication_or_connection_required")
                return
            self.wake.wait(min(30, 2 ** min(failures, 5)))
            self.wake.clear()

    def start(self):
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        self.wake.set()
        # HTTP has finite timeouts; wait before closing the shared SQLite/client.
        self.thread.join()


class LocalAIRuntime:
    def __init__(self, base_url="http://127.0.0.1:3000", state_dir=None,
                 tokens=None, http=None, on_event=None):
        self.origin = local_origin(base_url)
        origin_hash = hashlib.sha256(self.origin.encode()).hexdigest()
        self.directory = Path(state_dir or ROOT / ".local" / "ai" / origin_hash[:16]).resolve()
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.file = self.directory / "session.json"
        self._lock = (self.directory / "runtime.lock").open("a")
        os.chmod(self.directory / "runtime.lock", 0o600)
        try:
            fcntl.flock(self._lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self._lock.close()
            raise LocalAIError("runtime_in_use") from None
        self._tokens = tokens
        self._http = http
        self._owns_http = http is None
        self._client = None
        self.on_event = on_event or (lambda _event: None)
        try:
            if self.file.exists():
                self.state = json.loads(self.file.read_text(encoding="utf-8"))
                if (self.state.get("version") != 1 or self.state.get("origin") != self.origin
                        or self.state.get("phase") not in PHASES):
                    raise LocalAIError("state_origin_or_version_mismatch")
                UUID(self.state["user_id"])
                if self.state.get("session_id"):
                    UUID(self.state["session_id"])
            else:
                self.state = {"version": 1, "origin": self.origin, "phase": "idle"}
        except Exception:
            self.close()
            raise LocalAIError("invalid_local_state") from None

    def emit(self, event, **fields):
        self.on_event({"event": event, **fields})

    def _save(self, **values):
        candidate = {**self.state, **values}
        atomic_json(self.file, candidate)
        self.state = candidate

    @property
    def http(self):
        if self._http is None:
            self._http = httpx.Client(timeout=httpx.Timeout(3, connect=2), trust_env=False,
                                      follow_redirects=False)
        return self._http

    @property
    def tokens(self):
        if self._tokens is None:
            user = self.state.get("user_id")
            if not user:
                raise LocalAIError("login_required")
            account = "local-" + hashlib.sha256((self.origin + "\n" + user).encode()).hexdigest()
            self._tokens = KeychainTokens(account)
        return self._tokens

    @property
    def client(self):
        if self._client is None:
            if not self.state.get("user_id"):
                raise LocalAIError("login_required")
            client = DeliveryClient(self.origin, self.directory / "outbox.sqlite3",
                                    self.tokens, http=self.http, max_retries=0)
            try:
                with client._mutex, client.db:
                    expected = {"local_ai_origin": self.origin, "local_ai_user": self.state["user_id"]}
                    stored = dict(client.db.execute(
                        "SELECT name,value FROM delivery_metadata WHERE name IN ('local_ai_origin','local_ai_user')"
                    ).fetchall())
                    if stored and stored != expected:
                        raise LocalAIError("queue_account_or_origin_mismatch")
                    if not stored and client.db.execute("SELECT count(*) FROM outbox").fetchone()[0]:
                        raise LocalAIError("unbound_existing_queue")
                    for key, value in expected.items():
                        client.db.execute("INSERT OR IGNORE INTO delivery_metadata(name,value) VALUES (?,?)", (key, value))
                self._client = client
            except Exception:
                client.close()
                raise
        return self._client

    def close(self):
        if getattr(self, "_client", None) is not None:
            self._client.close()
            self._client = None
        if getattr(self, "_owns_http", False) and getattr(self, "_http", None) is not None:
            self._http.close()
            self._http = None
        if not self._lock.closed:
            fcntl.flock(self._lock, fcntl.LOCK_UN)
            self._lock.close()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()

    def login(self, email, password):
        try:
            response = self.http.post(self.origin + "/api/auth/login", json={"email": email, "password": password})
            if response.status_code != 200:
                raise LocalAIError(f"login_http_{response.status_code}")
            data = response_data(response)
            user = str(UUID(data["user_id"]))
            if self.state.get("user_id") and self.state["user_id"] != user:
                raise LocalAIError("use_another_state_directory_for_another_account")
            # Bind credentials to the verified account before writing local metadata.
            previous = self.state
            self.state = {**self.state, "user_id": user}
            try:
                self.tokens.set(data["access_token"], data["refresh_token"])
                self._save()
            except Exception:
                self.state = previous
                raise
            self.emit("logged_in", user_id=user)
            return {"user_id": user, "origin": self.origin}
        except (KeyError, ValueError):
            raise LocalAIError("invalid_login_response") from None
        except httpx.TransportError:
            raise LocalAIError("server_unavailable") from None

    def _active_sessions(self):
        data = self.client._deliver("GET", "/api/sessions?status=IN_PROGRESS&limit=1")
        sessions = data.get("sessions")
        if not isinstance(sessions, list) or len(sessions) > 1:
            raise LocalAIError("invalid_session_list")
        return sessions

    def start(self):
        if self.state.get("phase") not in {"idle", "ended"}:
            raise LocalAIError("unfinished_local_session_use_resume_or_finish")
        if self._active_sessions():
            raise LocalAIError("active_session_exists")
        self._save(phase="starting", session_id=None, started_at=None, end_data=None)
        try:
            response = self.client._request("POST", "/api/sessions/start", {})
        except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout):
            self._save(phase="idle", session_id=None, started_at=None)
            raise LocalAIError("server_unavailable_measure_again") from None
        except httpx.TransportError:
            raise LocalAIError("start_confirmation_required_use_resume") from None
        except DeliveryBlocked:
            self._save(phase="idle", session_id=None, started_at=None)
            raise
        if response.status_code != 201:
            if 400 <= response.status_code < 500:
                # A definite rejection must not adopt a session started elsewhere
                # between the preflight and this request.
                self._save(phase="idle", session_id=None, started_at=None)
            raise LocalAIError(f"start_http_{response.status_code}_use_resume")
        return self._adopt_started(response_data(response))

    def _adopt_started(self, data):
        try:
            session = str(UUID(data["session_id"]))
            started_at = data["started_at"]
            if data["status"] != "IN_PROGRESS" or not isinstance(started_at, str):
                raise ValueError
        except (KeyError, ValueError):
            raise LocalAIError("invalid_session_response") from None
        self._save(phase="measuring", session_id=session, started_at=started_at)
        self.emit("session_started", session_id=session, started_at=started_at)
        return {"session_id": session, "started_at": started_at}

    def resume_session(self, confirmed_session_id=None):
        if self.state.get("phase") == "starting":
            sessions = self._active_sessions()
            if not sessions:
                self._save(phase="idle", session_id=None)
                raise LocalAIError("start_not_found_measure_again")
            if sessions[0].get("session_id") != confirmed_session_id:
                self.emit("start_confirmation_required", session_id=sessions[0].get("session_id"),
                          started_at=sessions[0].get("started_at"))
                raise LocalAIError("confirm_session_id_required")
            self._adopt_started(sessions[0])
        session = self.state.get("session_id")
        if not session:
            raise LocalAIError("no_local_session")
        data = self.client._deliver("GET", f"/api/sessions/{session}")
        if data.get("session_id") != session or data.get("started_at") != self.state.get("started_at"):
            raise LocalAIError("session_identity_mismatch")
        if data.get("status") != "IN_PROGRESS":
            raise LocalAIError("session_already_completed_use_finish")
        return data

    def status(self):
        session = self.state.get("session_id")
        rows = self.client.records(session) if session else []
        return {"origin": self.origin, "user_id": self.state.get("user_id"),
                "session_id": session, "phase": self.state["phase"],
                **{key: sum(row["status"] == key for row in rows)
                   for key in ("sent", "pending", "failed", "discarded")}}

    def finish(self, confirmed_session_id=None):
        if self.state["phase"] == "ended":
            return self.state["end_data"]
        if self.state["phase"] == "starting":
            self.resume_session(confirmed_session_id)
        session = self.state.get("session_id")
        if not session:
            raise LocalAIError("no_local_session")
        self._save(phase="closing")
        try:
            data = self.client.finish_session(session)
        except DeliveryBlocked as error:
            self.emit("session_pending", code=error.code, **self.status())
            raise
        self._save(phase="ended", end_data=data)
        self.emit("session_ended", session_id=session, report_id=data.get("report_id"), summary=data.get("summary"))
        return data

    def measure(self, minutes=0, camera_index=0, resume=False, stop_event=None, capture=None,
                confirmed_session_id=None):
        if isinstance(minutes, bool) or not isinstance(minutes, int) or minutes < 0:
            raise LocalAIError("invalid_minutes")
        if isinstance(camera_index, bool) or not isinstance(camera_index, int) or camera_index < 0:
            raise LocalAIError("invalid_camera_index")
        if stop_event is not None and stop_event.is_set():
            raise LocalAIError("capture_cancelled_before_start")
        if resume and self.state["phase"] in {"closing", "ended"}:
            return self.finish()
        if resume:
            self.resume_session(confirmed_session_id)
            self._save(phase="measuring")
        else:
            self.start()
        try:
            self.capture_session(minutes, camera_index, stop_event, capture)
        except BaseException:
            self._save(phase="paused")
            raise
        return self.finish()

    def capture_session(self, minutes, camera_index, stop_event, capture=None, wait_for_browser_auth=False):
        """Capture for the current session. The controller decides whether to pause or finish."""
        if capture is None:
            from local_ai_camera import collect_camera
            capture = collect_camera
        sender = _Sender(self, wait_for_browser_auth=wait_for_browser_auth)
        # Open/bind the queue on the caller thread before either producer or sender.
        client = self.client
        sender.start()
        def on_minute(result):
            payload = {**result["score"], "client_log_id": str(uuid4()), "measured_at": result["measured_at"]}
            client.enqueue(self.state["session_id"], payload)
            self.emit("minute_enqueued", session_id=self.state["session_id"], **payload,
                      score=result["score"], samples=result["samples"], face_samples=result["face_samples"],
                      metrics=result.get("metrics", {}))
            sender.wake.set()
        try:
            stats = capture(on_minute, minutes=minutes, camera_index=camera_index,
                            stop_event=stop_event, on_event=self.on_event)
            self.emit("capture_completed", **stats)
        finally:
            sender.stop()


def parser():
    result = argparse.ArgumentParser(description="Local FocusLens camera → durable queue → v2 → report")
    result.add_argument("--base-url", default="http://127.0.0.1:3000")
    result.add_argument("--state-dir", type=Path)
    sub = result.add_subparsers(dest="command", required=True)
    login = sub.add_parser("login", help="sign in and save only tokens in macOS Keychain")
    login.add_argument("--email")
    for name in ("measure", "resume"):
        command = sub.add_parser(name, help="measure complete real minutes (0 means until Ctrl+C)")
        command.add_argument("--minutes", type=int, default=0)
        command.add_argument("--camera", type=int, default=0)
        if name == "resume":
            command.add_argument("--confirm-session", help="confirm a session only after a lost start response")
    finish = sub.add_parser("finish", help="drain saved logs and finish the existing session")
    finish.add_argument("--confirm-session", help="confirm a session only after a lost start response")
    sub.add_parser("status", help="show local session and durable queue counts")
    return result


def main():
    args = parser().parse_args()
    stop = threading.Event()
    cancelled_signal = signal.SIGINT
    def interrupt(received, _frame):
        nonlocal cancelled_signal
        cancelled_signal = received
        if args.command in {"measure", "resume"}:
            stop.set()
        else:
            raise KeyboardInterrupt
    previous = {sig: signal.signal(sig, interrupt) for sig in (signal.SIGINT, signal.SIGTERM)}
    output_lock = threading.Lock()
    def emit(value):
        with output_lock:
            print(json.dumps(value, allow_nan=False), flush=True)
    try:
        with LocalAIRuntime(args.base_url, args.state_dir, on_event=emit) as runtime:
            if args.command == "login":
                runtime.login(args.email or input("Email: ").strip(), getpass.getpass("Password: "))
            elif args.command == "status":
                emit({"event": "local_status", **runtime.status()})
            elif args.command == "finish":
                runtime.finish(args.confirm_session)
            else:
                runtime.measure(args.minutes, args.camera, resume=args.command == "resume", stop_event=stop,
                                confirmed_session_id=getattr(args, "confirm_session", None))
    except KeyboardInterrupt:
        emit({"event": "local_ai_cancelled"})
        return 128 + cancelled_signal
    except (LocalAIError, DeliveryBlocked) as error:
        emit({"event": "local_ai_error", "code": error.code,
              "hint": "Use status; login again if needed, then resume or finish with the same origin and state directory."})
        return 3
    except Exception:
        emit({"event": "local_ai_error", "code": "camera_or_local_state_unavailable",
              "hint": "Check Python AI dependencies, camera, Keychain and local server; saved logs remain in the state directory."})
        return 1
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)
    return 0


if __name__ == "__main__":
    sys.exit(main())
