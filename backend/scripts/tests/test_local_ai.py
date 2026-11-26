import json
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from uuid import uuid4

import httpx

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
from ai3_delivery import DeliveryBlocked, MemoryTokens
from local_ai import LocalAIError, LocalAIRuntime


ORIGIN = "http://127.0.0.1:12345"


def response(data, status=200):
    return httpx.Response(status, json={"success": status < 400, "data": data,
                                       "error": "" if status < 400 else "unavailable"})


def minute(index):
    return {"measured_at": f"2026-11-25T10:0{index}:00.000Z", "samples": 600,
            "face_samples": 600, "metrics": {"eye_closed_ms": 13800},
            "score": {"gaze": 85.5, "blink": 72, "head": 90,
                      "total": 79.65, "face_detected": True}}


def capture_stats(count=0, partial=False):
    return {"completed_windows": count, "emitted_minutes": count, "skipped_minutes": 0,
            "calibration_samples": 30, "partial_minute_discarded": partial}


class Backend:
    def __init__(self):
        self.user = str(uuid4())
        self.session = str(uuid4())
        self.report = str(uuid4())
        self.started_at = "2026-11-25T10:00:00.000Z"
        self.active = False
        self.start_lost = False
        self.start_error = None
        self.start_status = 201
        self.start_calls = 0
        self.end_calls = 0
        self.log_status = 200
        self.attempted = []
        self.delivered = {}
        self.entered = threading.Event()
        self.release = threading.Event()
        self.block_logs = False

    def session_data(self):
        return {"session_id": self.session, "started_at": self.started_at,
                "status": "IN_PROGRESS" if self.active else "COMPLETED"}

    def __call__(self, request):
        path = request.url.path
        if path == "/api/auth/login":
            return response({"user_id": self.user, "access_token": "private-issued-access",
                             "refresh_token": "private-issued-refresh"})
        if path == "/api/sessions" and request.method == "GET":
            return response({"sessions": [self.session_data()] if self.active else []})
        if path == "/api/sessions/start":
            self.start_calls += 1
            if self.start_error:
                raise self.start_error("start did not connect", request=request)
            if self.start_status != 201:
                return response({}, self.start_status)
            self.active = True
            if self.start_lost:
                self.start_lost = False
                raise httpx.ReadError("start response lost", request=request)
            return response(self.session_data(), 201)
        if path.startswith("/api/v2/sessions/") and path.endswith("/log"):
            payload = json.loads(request.content)
            self.attempted.append(payload)
            if self.block_logs:
                self.entered.set()
                if not self.release.wait(5):
                    raise RuntimeError("test delivery release timed out")
            if self.log_status != 200:
                return response({}, self.log_status)
            self.delivered[payload["client_log_id"]] = payload
            return response({"client_log_id": payload["client_log_id"],
                             "measured_at": payload["measured_at"], "log_id": str(uuid4())})
        if path == f"/api/sessions/{self.session}/end":
            self.end_calls += 1
            self.active = False
            return response({"session_id": self.session, "status": "COMPLETED",
                             "report_id": self.report, "summary": {"total_logs": len(self.delivered)}})
        if path.startswith("/api/sessions/") and request.method == "GET":
            return response(self.session_data())
        raise AssertionError(f"Unexpected test request: {request.method} {path}")


class LocalRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name) / "state"
        self.backend = Backend()
        self.tokens = MemoryTokens("private-initial-access", "private-initial-refresh")
        self.runtimes = []
        self.http_clients = []
        self.events = []

    def tearDown(self):
        self.backend.release.set()
        for runtime in self.runtimes:
            runtime.close()
        for http in self.http_clients:
            http.close()
        self.temporary.cleanup()

    def runtime(self, **options):
        http = httpx.Client(transport=httpx.MockTransport(self.backend))
        self.http_clients.append(http)
        runtime = LocalAIRuntime(options.pop("base_url", ORIGIN), self.directory,
                                 tokens=self.tokens, http=http, on_event=self.events.append, **options)
        self.runtimes.append(runtime)
        return runtime

    def login(self, runtime):
        runtime.login("camera@example.test", "private-password")

    def assert_code(self, error_type, code, operation):
        with self.assertRaises(error_type) as error:
            operation()
        self.assertEqual(error.exception.code, code)

    def test_fresh_start_refuses_an_existing_frontend_session_without_adopting_it(self):
        with self.runtime() as runtime:
            self.login(runtime)
            self.backend.active = True
            self.assert_code(LocalAIError, "active_session_exists", runtime.start)
            self.assertEqual(runtime.state["phase"], "idle")
            self.assertIsNone(runtime.state.get("session_id"))
            self.assertEqual(self.backend.start_calls, 0)

    def test_start_response_loss_is_recovered_from_saved_intent_without_another_start(self):
        with self.runtime() as runtime:
            self.login(runtime)
            self.backend.start_lost = True
            self.assert_code(LocalAIError, "start_confirmation_required_use_resume", runtime.start)
            self.assertEqual(runtime.state["phase"], "starting")
            self.assertIsNone(runtime.state["session_id"])
        with self.runtime() as restarted:
            self.assert_code(LocalAIError, "confirm_session_id_required", restarted.resume_session)
            self.assertEqual(restarted.state["phase"], "starting")
            self.assert_code(LocalAIError, "confirm_session_id_required",
                             lambda: restarted.resume_session(str(uuid4())))
            resumed = restarted.resume_session(self.backend.session)
            self.assertEqual(resumed["session_id"], self.backend.session)
            self.assertEqual(restarted.state["started_at"], self.backend.started_at)
            self.assertEqual(restarted.state["phase"], "measuring")
        self.assertEqual(self.backend.start_calls, 1)

    def test_a_start_connection_failure_returns_to_idle_without_adopting_other_sessions(self):
        with self.runtime() as runtime:
            self.login(runtime)
            for error_type in (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout):
                with self.subTest(error=error_type.__name__):
                    self.backend.start_error = error_type
                    self.assert_code(LocalAIError, "server_unavailable_measure_again", runtime.start)
                    self.assertEqual(runtime.state["phase"], "idle")
                    self.assertIsNone(runtime.state["session_id"])
                    self.assertFalse(self.backend.active)

    def test_a_definite_start_rejection_returns_to_idle(self):
        with self.runtime() as runtime:
            self.login(runtime)
            self.backend.start_status = 409
            self.assert_code(LocalAIError, "start_http_409_use_resume", runtime.start)
            self.assertEqual(runtime.state["phase"], "idle")
            self.assertIsNone(runtime.state["session_id"])
            self.assertEqual(self.backend.end_calls, 0)

    def test_state_is_bound_to_origin_and_account_without_writing_credentials(self):
        with self.runtime() as runtime:
            self.login(runtime)
            runtime.client  # Bind the queue's origin/user metadata as well.
            saved = runtime.file.read_bytes()
            tokens = self.tokens.get()
            self.backend.user = str(uuid4())
            self.assert_code(LocalAIError, "use_another_state_directory_for_another_account",
                             lambda: self.login(runtime))
            self.assertEqual(self.tokens.get(), tokens)
            self.assertEqual(runtime.file.read_bytes(), saved)
            for file in self.directory.iterdir():
                if file.is_file():
                    content = file.read_bytes()
                    for secret in ("private-password", "private-issued-access", "private-issued-refresh"):
                        self.assertNotIn(secret.encode(), content)
            self.assertEqual(runtime.file.stat().st_mode & 0o777, 0o600)
        self.assert_code(LocalAIError, "invalid_local_state",
                         lambda: self.runtime(base_url="http://127.0.0.1:12346"))
        self.assertEqual((self.directory / "session.json").read_bytes(), saved)
        with sqlite3.connect(self.directory / "outbox.sqlite3") as queue:
            queue.execute("UPDATE delivery_metadata SET value=? WHERE name='local_ai_user'", (str(uuid4()),))
        with self.runtime() as reopened:
            self.assert_code(LocalAIError, "queue_account_or_origin_mismatch", lambda: reopened.client)
        self.assertEqual((self.directory / "session.json").read_bytes(), saved)

    def test_two_durable_minutes_survive_an_outage_and_resume_finishes_with_the_same_ids(self):
        self.backend.log_status = 503
        def capture(on_minute, **_options):
            on_minute(minute(1))
            on_minute(minute(2))
            return capture_stats(2)
        with self.runtime() as runtime:
            self.login(runtime)
            self.assert_code(DeliveryBlocked, "pending_logs", lambda: runtime.measure(minutes=2, capture=capture))
            self.assertEqual(runtime.state["phase"], "closing")
            records = runtime.client.records(self.backend.session)
            payloads = [row["payload"] for row in records]
            self.assertEqual(len(payloads), 2)
            self.assertTrue(all(row["status"] == "pending" for row in records))
            with sqlite3.connect(self.directory / "outbox.sqlite3") as reader:
                self.assertEqual(reader.execute("SELECT count(*) FROM outbox").fetchone()[0], 2)
            self.assertEqual(self.backend.end_calls, 0)
        self.backend.log_status = 200
        with self.runtime() as restarted:
            result = restarted.finish()
            self.assertEqual(result["status"], "COMPLETED")
            self.assertEqual(restarted.state["phase"], "ended")
            self.assertEqual([row["payload"] for row in restarted.client.records(self.backend.session)], payloads)
            self.assertEqual({row["status"] for row in restarted.client.records(self.backend.session)}, {"sent"})
            self.assertEqual(restarted.finish(), result)
        self.assertEqual(self.backend.end_calls, 1)
        self.assertEqual(set(self.backend.delivered), {payload["client_log_id"] for payload in payloads})

    def test_capture_with_only_a_partial_window_sends_no_minute_log(self):
        def capture(_on_minute, **_options):
            return capture_stats(partial=True)
        with self.runtime() as runtime:
            self.login(runtime)
            result = runtime.measure(capture=capture)
            self.assertEqual(result["summary"]["total_logs"], 0)
            self.assertEqual(runtime.client.records(self.backend.session), [])
        self.assertEqual(self.backend.attempted, [])
        self.assertEqual(self.backend.end_calls, 1)

    def test_another_process_cannot_open_the_same_state_directory(self):
        with self.runtime() as runtime:
            self.login(runtime)
            script = """import sys
sys.path.insert(0, sys.argv[1])
from local_ai import LocalAIRuntime, LocalAIError
try:
    with LocalAIRuntime(sys.argv[2], sys.argv[3]):
        print('unexpected_open')
except LocalAIError as error:
    print(error.code)
"""
            child = subprocess.run([sys.executable, "-B", "-c", script, str(SCRIPTS), ORIGIN, str(self.directory)],
                                   capture_output=True, text=True, timeout=5, check=False)
            self.assertEqual(child.returncode, 0)
            self.assertEqual(child.stdout.strip(), "runtime_in_use")
            self.assertEqual(child.stderr, "")

    def test_camera_can_commit_a_second_minute_while_the_sender_waits_on_http(self):
        self.backend.block_logs = True
        def capture(on_minute, **_options):
            on_minute(minute(1))
            self.assertTrue(self.backend.entered.wait(2))
            completed = threading.Event()
            outcome = {}
            def produce():
                try:
                    on_minute(minute(2))
                except BaseException as error:
                    outcome["error"] = error
                finally:
                    completed.set()
            producer = threading.Thread(target=produce)
            producer.start()
            try:
                self.assertTrue(completed.wait(2), "camera persistence must not wait for network delivery")
                self.assertNotIn("error", outcome)
                with sqlite3.connect(self.directory / "outbox.sqlite3") as reader:
                    self.assertEqual(reader.execute("SELECT count(*) FROM outbox").fetchone()[0], 2)
                self.assertFalse(self.backend.release.is_set())
            finally:
                self.backend.release.set()
                producer.join(5)
            self.assertFalse(producer.is_alive())
            return capture_stats(2)
        with self.runtime() as runtime:
            self.login(runtime)
            runtime.measure(minutes=2, capture=capture)
        self.assertEqual(len(self.backend.delivered), 2)
        self.assertEqual(self.backend.end_calls, 1)

    def test_capture_failure_joins_the_sender_before_closing_sqlite(self):
        self.backend.block_logs = True
        runtime = self.runtime()
        self.login(runtime)
        client = runtime.client
        closed_before_release = []
        original_close = client.close
        def close_after_sender():
            closed_before_release.append(not self.backend.release.is_set())
            original_close()
        client.close = close_after_sender
        capture_failed = threading.Event()
        outcome = {}
        def capture(on_minute, **_options):
            on_minute(minute(1))
            if not self.backend.entered.wait(2):
                raise AssertionError("delivery did not start")
            capture_failed.set()
            raise OSError("camera disconnected")
        def measure():
            try:
                with runtime:
                    runtime.measure(capture=capture)
            except BaseException as error:
                outcome["error"] = error
        measuring = threading.Thread(target=measure)
        measuring.start()
        try:
            self.assertTrue(capture_failed.wait(2))
            self.assertIs(runtime._client, client)
            self.assertTrue(measuring.is_alive())
            self.assertIsNotNone(client.db, "shared SQLite must remain open until blocked delivery finishes")
        finally:
            self.backend.release.set()
            measuring.join(5)
        self.assertFalse(measuring.is_alive())
        self.assertIsInstance(outcome.get("error"), OSError)
        self.assertIsNone(client.db)
        self.assertEqual(closed_before_release, [False])
        self.assertEqual(json.loads((self.directory / "session.json").read_text())["phase"], "paused")
        self.assertEqual(self.backend.end_calls, 0)

    def test_a_failed_log_remains_blocking_after_restart_instead_of_being_ignored(self):
        self.backend.log_status = 400
        def capture(on_minute, **_options):
            on_minute(minute(1))
            return capture_stats(1)
        with self.runtime() as runtime:
            self.login(runtime)
            self.assert_code(DeliveryBlocked, "failed_logs", lambda: runtime.measure(capture=capture))
            self.assertEqual(runtime.status()["failed"], 1)
            self.assertEqual(runtime.state["phase"], "closing")
        with self.runtime() as restarted:
            self.assert_code(DeliveryBlocked, "failed_logs", restarted.finish)
            self.assertEqual(restarted.status()["failed"], 1)
        self.assertEqual(self.backend.end_calls, 0)

    def test_resume_refuses_a_server_session_identity_that_differs_from_saved_metadata(self):
        with self.runtime() as runtime:
            self.login(runtime)
            runtime.start()
            self.backend.started_at = "2026-11-25T10:00:01.000Z"
            self.assert_code(LocalAIError, "session_identity_mismatch", runtime.resume_session)
            self.assertEqual(self.backend.start_calls, 1)
            self.assertEqual(self.backend.end_calls, 0)


if __name__ == "__main__":
    unittest.main()
