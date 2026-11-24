import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from pathlib import Path
from uuid import uuid4

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ai3_delivery import BACKOFF_SECONDS, DeliveryBlocked, DeliveryClient, MemoryTokens, retry_after


SESSION = str(uuid4())


def payload():
    return dict(client_log_id=str(uuid4()), measured_at="2026-11-24T05:01:00.000Z",
                gaze=85.5, blink=72, head=90, total=79.65, face_detected=True)


def ok(data):
    return httpx.Response(200, json={"success": True, "data": data, "error": ""})


def receipt(request):
    item = json.loads(request.content)
    return ok({"client_log_id": item["client_log_id"], "measured_at": item["measured_at"], "log_id": "stored-log"})


class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.path = Path(self.temporary.name) / "outbox.sqlite"
        self.tokens = MemoryTokens("secret-access", "secret-refresh")
        self.clients = []

    def tearDown(self):
        for client in self.clients:
            client.close()
        self.temporary.cleanup()

    def client(self, handler, **options):
        transport = httpx.Client(transport=httpx.MockTransport(handler))
        self.addCleanup(transport.close)
        client = DeliveryClient("http://127.0.0.1:12345", self.path, self.tokens, http=transport,
                                sleep=options.pop("sleep", lambda _: None), **options)
        self.clients.append(client)
        return client

    def assertBlocked(self, code, operation):
        with self.assertRaises(DeliveryBlocked) as error:
            operation()
        self.assertEqual(error.exception.code, code)

    def test_offline_restart_replays_identical_payload_once(self):
        def offline(request):
            raise httpx.ConnectError("offline", request=request)
        item = payload()
        first = self.client(offline, max_retries=0)
        first.enqueue(SESSION, item)
        self.assertEqual(first.drain(SESSION)["pending"], 1)
        first.close()
        requests = []
        def recovered(request):
            requests.append(json.loads(request.content))
            return receipt(request)
        second = self.client(recovered)
        self.assertEqual(second.records(SESSION)[0]["payload"], item)
        self.assertEqual(second.drain(SESSION)["sent"], 1)
        self.assertEqual(second.drain(SESSION)["sent"], 1)
        self.assertEqual(requests, [item])

    def test_lost_log_response_can_be_safely_retried(self):
        requests = []
        def server(request):
            requests.append(json.loads(request.content))
            if len(requests) == 1:
                raise httpx.ReadTimeout("response lost", request=request)
            return receipt(request)
        client = self.client(server)
        item = payload()
        client.enqueue(SESSION, item)
        self.assertEqual(client.drain(SESSION)["sent"], 1)
        self.assertEqual(requests, [item, item])

    def test_eight_retries_stop_and_leave_outbox_pending(self):
        sleeps = []
        requests = []
        def server(request):
            requests.append(request)
            return httpx.Response(503)
        client = self.client(server, sleep=sleeps.append, random=lambda: 0.5)
        client.enqueue(SESSION, payload())
        result = client.drain(SESSION)
        self.assertEqual(len(requests), 9)
        self.assertEqual(sleeps, [0.5, 1, 2, 4, 8, 15, 15, 15])
        self.assertEqual((result["pending"], result["sent"]), (1, 0))
        self.assertEqual(client.records(SESSION)[0]["attempts"], 9)

    def test_retry_after_has_priority_over_jitter(self):
        requests = []
        sleeps = []
        def server(request):
            requests.append(request)
            return httpx.Response(429, headers={"Retry-After": "7"}) if len(requests) == 1 else receipt(request)
        client = self.client(server, sleep=sleeps.append)
        client.enqueue(SESSION, payload())
        self.assertEqual(client.drain(SESSION)["sent"], 1)
        self.assertEqual(sleeps, [7])
        date = format_datetime(datetime.now(timezone.utc) + timedelta(seconds=12), usegmt=True)
        self.assertTrue(10 <= retry_after(httpx.Response(429, headers={"Retry-After": date})) <= 12)
        for invalid in ["bad", "nan", "-1"]:
            self.assertIsNone(retry_after(httpx.Response(429, headers={"Retry-After": invalid})))

    def test_expired_access_token_refreshes_once_and_rotates_in_memory(self):
        calls = []
        def server(request):
            calls.append(request.url.path)
            if request.url.path.endswith("refresh"):
                self.assertEqual(json.loads(request.content), {"refresh_token": "secret-refresh"})
                return ok({"access_token": "new-access", "refresh_token": "new-refresh"})
            if request.headers["Authorization"] == "Bearer secret-access":
                return httpx.Response(401)
            self.assertEqual(request.headers["Authorization"], "Bearer new-access")
            return receipt(request)
        client = self.client(server)
        client.enqueue(SESSION, payload())
        self.assertEqual(client.drain(SESSION)["sent"], 1)
        self.assertEqual(calls.count("/api/auth/refresh"), 1)
        self.assertEqual(self.tokens.get(), dict(access_token="new-access", refresh_token="new-refresh"))

    def test_invalid_refresh_or_second_401_requires_auth_and_preserves_queue(self):
        for second_401 in [False, True]:
            with self.subTest(second_401=second_401):
                self.tokens.set(f"access-{second_401}", f"refresh-{second_401}")
                refreshes = []
                def server(request):
                    if request.url.path.endswith("refresh"):
                        refreshes.append(request)
                        return ok(dict(access_token="new", refresh_token="rotated")) if second_401 else httpx.Response(401)
                    return httpx.Response(401)
                client = self.client(server)
                session = str(uuid4())
                client.enqueue(session, payload())
                result = client.drain(session)
                self.assertEqual(result["status"], "authentication_required")
                self.assertEqual(result["pending"], 1)
                self.assertEqual(len(refreshes), 1)
                client.close()

    def test_refresh_server_failure_preserves_credentials(self):
        def server(request):
            return httpx.Response(503 if request.url.path.endswith("refresh") else 401)
        client = self.client(server, max_retries=0)
        client.enqueue(SESSION, payload())
        self.assertEqual(client.drain(SESSION)["status"], "pending")
        self.assertEqual(self.tokens.get(), dict(access_token="secret-access", refresh_token="secret-refresh"))

    def test_lost_refresh_response_is_not_reused_after_restart(self):
        refreshes = []
        def uncertain(request):
            if request.url.path.endswith("refresh"):
                refreshes.append(request)
                raise httpx.ReadTimeout("lost rotated token response", request=request)
            return httpx.Response(401)
        client = self.client(uncertain)
        client.enqueue(SESSION, payload())
        self.assertEqual(client.drain(SESSION)["status"], "authentication_required")
        client.close()
        restarted = self.client(uncertain)
        self.assertEqual(restarted.drain(SESSION)["status"], "authentication_required")
        self.assertEqual(len(refreshes), 1)
        restarted.close()
        self.tokens.set("fresh-login-access", "fresh-login-refresh")
        recovered = self.client(receipt)
        self.assertEqual(recovered.drain(SESSION)["sent"], 1)

    def test_refresh_connect_failure_is_retryable(self):
        refreshes = []
        def server(request):
            if request.url.path.endswith("refresh"):
                refreshes.append(request)
                if len(refreshes) == 1:
                    raise httpx.ConnectError("offline before transmission", request=request)
                return ok(dict(access_token="new-access", refresh_token="new-refresh"))
            if request.headers["Authorization"] == "Bearer new-access":
                return receipt(request)
            return httpx.Response(401)
        client = self.client(server)
        client.enqueue(SESSION, payload())
        self.assertEqual(client.drain(SESSION)["sent"], 1)
        self.assertEqual(len(refreshes), 2)

    def test_refresh_token_storage_failure_keeps_log_and_prevents_old_token_reuse(self):
        class BrokenTokens(MemoryTokens):
            def set(self, access, refresh):
                if access == "new-access":
                    raise OSError("secure storage unavailable")
                super().set(access, refresh)
        self.tokens = BrokenTokens("secret-access", "secret-refresh")
        refreshes = []
        def server(request):
            if request.url.path.endswith("refresh"):
                refreshes.append(request)
                return ok(dict(access_token="new-access", refresh_token="new-refresh"))
            return httpx.Response(401)
        client = self.client(server)
        client.enqueue(SESSION, payload())
        self.assertEqual(client.drain(SESSION)["status"], "authentication_required")
        self.assertEqual(client.drain(SESSION)["pending"], 1)
        self.assertEqual(len(refreshes), 1)

    def test_permanent_failures_block_end_until_explicit_discard(self):
        for code in [400, 403, 404, 409]:
            with self.subTest(code=code):
                calls = []
                def server(request):
                    calls.append(request.url.path)
                    return ok({"status": "COMPLETED"}) if request.url.path.endswith("/end") else httpx.Response(code)
                client = self.client(server)
                session = str(uuid4())
                item = payload()
                client.enqueue(session, item)
                self.assertBlocked("failed_logs", lambda: client.finish_session(session))
                self.assertEqual(len(calls), 1)
                self.assertBlocked("discard_reason_required", lambda: client.discard(session, item["client_log_id"], ""))
                client.discard(session, item["client_log_id"], "user confirms invalid input")
                self.assertEqual(client.finish_session(session)["status"], "COMPLETED")
                self.assertEqual(client.records(session)[0]["discard_reason"], "user confirms invalid input")
                client.close()

    def test_pending_outbox_prevents_end_and_blocks_new_samples(self):
        calls = []
        def server(request):
            calls.append(request.url.path)
            return httpx.Response(503)
        client = self.client(server, max_retries=0)
        client.enqueue(SESSION, payload())
        self.assertBlocked("pending_logs", lambda: client.finish_session(SESSION))
        self.assertFalse(any(path.endswith("/end") for path in calls))
        self.assertBlocked("session_closing", lambda: client.enqueue(SESSION, payload()))
        self.assertBlocked("not_a_failed_log", lambda: client.discard(SESSION, client.records(SESSION)[0]["client_log_id"], "drop"))

    def test_lost_end_response_recovers_completed_session_and_report(self):
        ends = []
        calls = []
        def server(request):
            calls.append(request.url.path)
            if request.url.path.endswith("/log"):
                return receipt(request)
            if request.url.path.endswith("/end"):
                ends.append(request)
                if len(ends) == 1:
                    raise httpx.ReadTimeout("lost end response", request=request)
                return httpx.Response(409)
            if request.url.path.startswith("/api/reports/"):
                return ok({"report_id": "report", "summary_json": {"total_logs": 1}})
            return ok({"status": "COMPLETED"})
        client = self.client(server)
        client.enqueue(SESSION, payload())
        result = client.finish_session(SESSION)
        self.assertEqual(result["report_id"], "report")
        self.assertEqual(len(ends), 2)
        self.assertEqual(client.finish_session(SESSION), result)
        self.assertEqual(len(ends), 2)
        self.assertTrue(calls[0].endswith("/log"))

    def test_payload_is_immutable_and_corrupt_receipt_remains_pending(self):
        client = self.client(lambda request: ok({"client_log_id": "wrong", "measured_at": "wrong"}), max_retries=0)
        item = payload()
        client.enqueue(SESSION, item)
        self.assertEqual(client.enqueue(SESSION, item), item["client_log_id"])
        self.assertBlocked("immutable_payload", lambda: client.enqueue(SESSION, {**item, "gaze": 10}))
        self.assertEqual(client.drain(SESSION)["pending"], 1)
        self.assertBlocked("invalid_payload", lambda: client.enqueue(SESSION, {**payload(), "total": float("nan")}))

    def test_receipt_accepts_equivalent_uuid_case_and_utc_precision(self):
        requests = []
        def server(request):
            item = json.loads(request.content)
            requests.append(item)
            return ok({"client_log_id": item["client_log_id"].lower(),
                       "measured_at": "2026-11-24T05:01:00.000Z"})
        client = self.client(server, max_retries=0)
        for measured_at in ["2026-11-24T05:01:00Z", "2026-11-24T05:01:00.0Z"]:
            item = {**payload(), "client_log_id": str(uuid4()).upper(), "measured_at": measured_at}
            client.enqueue(SESSION, item)
            self.assertEqual(client.drain(SESSION)["pending"], 0)
            self.assertEqual(requests[-1], item)
            stored = next(row for row in client.records(SESSION) if row["client_log_id"] == item["client_log_id"])
            self.assertEqual(stored["payload"], item)

    def test_receipt_rejects_a_different_measurement_instant(self):
        def server(request):
            item = json.loads(request.content)
            return ok({"client_log_id": item["client_log_id"],
                       "measured_at": "2026-11-24T05:01:00.001Z"})
        client = self.client(server, max_retries=0)
        client.enqueue(SESSION, {**payload(), "measured_at": "2026-11-24T05:01:00Z"})
        self.assertEqual(client.drain(SESSION)["pending"], 1)
        self.assertEqual(client.records(SESSION)[0]["last_error"], "retry_exhausted")

    def test_outbox_owner_is_exclusive_and_no_credentials_are_persisted(self):
        client = self.client(receipt)
        self.assertBlocked("queue_in_use", lambda: self.client(receipt))
        client.enqueue(SESSION, payload())
        client.drain(SESSION)
        self.assertNotIn("secret-access", repr(self.tokens))
        client.close()
        self.assertEqual(os.stat(self.path).st_mode & 0o777, 0o600)
        for path in self.path.parent.iterdir():
            contents = path.read_bytes()
            self.assertNotIn(b"secret-access", contents)
            self.assertNotIn(b"secret-refresh", contents)
