import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ai3_delivery import DeliveryBlocked
from local_ai import LocalAIError, LocalAIRuntime
from local_ai_web_runtime import WebAIRuntime
from test_local_ai import Backend, ORIGIN, capture_stats, minute, response


class WebAIRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        self.backend = Backend()
        self.user = self.backend.user
        self.other = str(uuid4())
        self.token = "browser-test-only-bearer"
        self.received = threading.Event()
        self.http = httpx.Client(transport=httpx.MockTransport(self.backend))
        self.factory = patch("local_ai_web_runtime.LocalAIRuntime",
                             side_effect=lambda *a, **kw: LocalAIRuntime(*a, http=self.http, **kw))
        self.factory.start()
        self.manager = self.manager_with(self.capture)

    def tearDown(self):
        self.manager.close()
        self.factory.stop()
        self.http.close()
        self.root.cleanup()

    def manager_with(self, capture):
        return WebAIRuntime(ORIGIN, self.root.name, capture=capture)

    def capture(self, on_minute, *, minutes, camera_index, stop_event, on_event, on_preview):
        on_event({"event": "camera_measurement_started"})
        on_preview(b"private-test-jpeg")
        on_minute(minute(1))
        self.received.set()
        stop_event.wait(5)
        return capture_stats(1)

    def command(self, action, session=None, user=None):
        return self.manager.handle(user or self.user, self.token, action, session)

    def wait(self, phase, **expected):
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            state = self.command("status")
            if state["phase"] == phase and all(state[key] == value for key, value in expected.items()):
                return state
            time.sleep(0.01)
        self.fail(f"Did not reach {phase}: {state}")

    def test_multiple_tabs_use_one_producer_and_other_accounts_cannot_see_or_end_it(self):
        self.assertEqual(self.command("status")["phase"], "idle")
        session = self.command("start")["session_id"]
        self.assertTrue(self.received.wait(2))
        self.assertEqual(self.command("start")["session_id"], session)
        self.assertEqual(self.command("resume", session)["session_id"], session)
        state = self.command("status")
        self.assertEqual(state["latest"]["focus_score"], 79.65)
        self.assertEqual(state["latest"]["attention_state"], "FOCUSED")
        self.assertEqual(self.manager.preview(self.user), b"private-test-jpeg")
        self.assertIsNone(self.manager.preview(self.other))
        self.assertEqual(self.command("status", user=self.other)["phase"], "idle")
        with self.assertRaisesRegex(LocalAIError, "session_not_managed_here"):
            self.command("finish", session, self.other)
        with self.assertRaisesRegex(LocalAIError, "camera_in_use"):
            self.command("start", user=self.other)
        with self.assertRaisesRegex(LocalAIError, "session_not_managed_here"):
            self.command("finish", str(uuid4()))
        self.assertEqual(self.command("finish", session)["phase"], "closing")
        self.assertIsNone(self.manager.preview(self.user))
        self.wait("ended")
        self.assertEqual(self.command("finish", session)["phase"], "ended")
        self.assertEqual(self.backend.end_calls, 1)
        self.assertEqual(self.backend.start_calls, 1)
        self.assertEqual(len(self.backend.delivered), 1)
        self.command("start", user=self.other)
        self.assertEqual(self.backend.start_calls, 2)

    def test_close_preserves_queue_and_restart_refuses_end_until_receipt(self):
        self.backend.log_status = 503
        session = self.command("start")["session_id"]
        self.assertTrue(self.received.wait(2))
        original = self.command("status")["latest"]
        self.manager.close()
        self.assertEqual(self.backend.end_calls, 0)
        self.manager = self.manager_with(self.capture)
        self.wait("paused", pending=1, latest=original)
        self.command("finish", session)
        self.wait("closing", pending=1, error="pending_logs")
        self.assertEqual(self.backend.end_calls, 0)
        self.manager.close()
        self.manager = self.manager_with(self.capture)
        self.backend.log_status = 200
        self.command("resume", session)
        self.wait("ended", pending=0, latest=original, error=None)
        self.assertEqual(self.backend.end_calls, 1)
        self.assertEqual(set(self.backend.delivered), {original["client_log_id"]})
        for path in Path(self.root.name).rglob("*"):
            if path.is_file():
                content = path.read_bytes()
                self.assertNotIn(self.token.encode(), content)
                self.assertNotIn(b"private-test-jpeg", content)

    def test_browser_lease_expires_even_if_another_user_polls(self):
        with patch("local_ai_web_runtime.BROWSER_LEASE_SECONDS", 0.10):
            session = self.command("start")["session_id"]
            self.assertTrue(self.received.wait(2))
            until = time.monotonic() + .30
            while time.monotonic() < until:
                self.command("status", user=self.other)
                time.sleep(.02)
            self.wait("paused", error="browser_disconnected")
            self.assertIsNone(self.manager.preview(self.user))
            self.assertEqual(self.backend.end_calls, 0)
            self.command("finish", session)
            self.wait("ended")

    def test_start_ack_loss_requires_confirmation_and_no_external_session_is_claimed(self):
        self.backend.active = True
        with self.assertRaisesRegex(LocalAIError, "active_session_exists"):
            self.command("start")
        with self.assertRaisesRegex(LocalAIError, "session_not_managed_here"):
            self.command("finish", self.backend.session)
        self.backend.active = False
        self.backend.start_lost = True
        with self.assertRaisesRegex(LocalAIError, "start_confirmation_required"):
            self.command("start")
        self.assertEqual(self.command("status")["phase"], "starting")
        with self.assertRaisesRegex(LocalAIError, "confirm_session_id_required"):
            self.command("start")
        with self.assertRaisesRegex(LocalAIError, "confirm_session_id_required"):
            self.command("resume", str(uuid4()))
        self.assertEqual(self.backend.end_calls, 0)
        self.command("resume", self.backend.session)
        self.assertTrue(self.received.wait(2))
        self.command("finish", self.backend.session)
        self.wait("ended")
        self.assertEqual(self.backend.start_calls, 1)

    def test_browser_refresh_is_never_attempted_by_python_and_queued_log_can_recover(self):
        rejected = threading.Event()
        refresh_calls = []
        original = self.backend

        def reject_old_token(request):
            if request.url.path == "/api/auth/refresh":
                refresh_calls.append(True)
            if request.url.path.endswith("/log") and request.headers["authorization"] != "Bearer replacement":
                rejected.set()
                return response({}, 401)
            return original(request)

        self.http.close()
        self.http = httpx.Client(transport=httpx.MockTransport(reject_old_token))
        session = self.command("start")["session_id"]
        self.assertTrue(rejected.wait(2))
        self.assertEqual(self.command("status")["pending"], 1)
        self.token = "replacement"
        self.command("status")
        self.command("finish", session)
        self.wait("ended", pending=0)
        self.assertFalse(refresh_calls)
        self.assertEqual(len(original.delivered), 1)
