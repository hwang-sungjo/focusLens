import base64
import json
import sys
import threading
import unittest
from pathlib import Path
from uuid import uuid4

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from local_ai_web import create_server


class Manager:
    def __init__(self):
        self.calls = []
        self.closed = False

    def handle(self, user, token, action, session_id):
        self.calls.append((user, action, session_id))
        return {"phase": "idle"}

    def preview(self, user):
        return None

    def close(self):
        self.closed = True


class BrowserControlTests(unittest.TestCase):
    def setUp(self):
        self.actor = str(uuid4())
        body = base64.urlsafe_b64encode(json.dumps({"sub": self.actor}).encode()).decode().rstrip("=")
        self.token = "test." + body + ".test"
        self.origin = "http://localhost:5173"
        self.manager = Manager()
        self.server = create_server("127.0.0.1", 0, "http://127.0.0.1:3000", self.origin, self.manager)
        self.server.auth_client.close()
        self.auth_status = 200

        def check(request):
            self.assertEqual(request.url.path, "/api/users/me/privacy")
            self.assertTrue(request.headers["Authorization"] == "Bearer " + self.token)
            return httpx.Response(self.auth_status, json={"success": self.auth_status == 200})

        self.server.auth_client = httpx.Client(transport=httpx.MockTransport(check))
        thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02})
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.client = httpx.Client(base_url=f"http://127.0.0.1:{self.server.server_port}",
                                   headers={"Origin": self.origin, "Authorization": "Bearer " + self.token},
                                   timeout=3, trust_env=False)
        self.addCleanup(self.client.close)

    def test_preflight_and_valid_control_are_scoped_to_the_browser_origin(self):
        response = self.client.options("/status", headers={"Access-Control-Request-Method": "GET"})
        self.assertEqual(response.status_code, 204)
        self.assertEqual(response.headers["access-control-allow-origin"], self.origin)
        self.assertNotIn("access-control-allow-credentials", response.headers)
        self.assertEqual(self.client.get("/status").json()["data"]["phase"], "idle")
        self.assertEqual(self.manager.calls, [(self.actor, "status", None)])
        preview = self.client.get("/preview")
        self.assertEqual(preview.status_code, 204)
        self.assertEqual(preview.headers["cache-control"], "no-store")

    def test_wrong_origin_or_host_cannot_start_a_camera(self):
        for header in [{"Origin": "http://localhost:5174"}, {"Host": "example.test"}]:
            response = self.client.post("/start", json={}, headers=header)
            self.assertEqual(response.status_code, 403)
        self.assertEqual(self.manager.calls, [])

    def test_token_rejection_and_backend_outage_are_distinct(self):
        for upstream_status, expected in [(401, 401), (503, 503)]:
            self.auth_status = upstream_status
            self.assertEqual(self.client.get("/status").status_code, expected)
        self.assertEqual(self.manager.calls, [])

    def test_mutating_an_existing_session_requires_an_explicit_uuid(self):
        self.assertEqual(self.client.post("/finish", json={}).status_code, 400)
        session = str(uuid4())
        self.assertEqual(self.client.post("/finish", json={"session_id": session}).status_code, 200)
        self.assertEqual(self.manager.calls, [(self.actor, "finish", session)])


if __name__ == "__main__":
    unittest.main()
