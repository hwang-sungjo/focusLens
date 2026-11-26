"""Loopback browser controls for the native FocusLens camera and durable outbox."""
import argparse
import base64
import json
import re
import signal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from uuid import UUID

import httpx

from ai3_delivery import DeliveryBlocked
from local_ai import LocalAIError, local_origin


ROUTES = {"/status": "GET", "/preview": "GET", "/start": "POST", "/resume": "POST", "/finish": "POST"}


class ControlError(Exception):
    def __init__(self, status, code):
        self.status = status
        self.code = code
        super().__init__(code)


def verified_user(client, base_url, token):
    # Express validates this exact token's signature, expiry and Redis blacklist.
    # Extract its subject only after that check. No refresh cookies enter the bridge.
    response = client.get(base_url + "/api/users/me/privacy", headers={"Authorization": "Bearer " + token})
    if response.status_code == 401:
        raise ControlError(401, "authentication_required")
    if response.status_code != 200 or response.json().get("success") is not True:
        raise ControlError(503, "backend_unavailable")
    try:
        _, payload, _ = token.split(".")
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        return str(UUID(claims["sub"]))
    except (ValueError, TypeError, KeyError):
        raise ControlError(401, "authentication_required") from None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def setup(self):
        super().setup()
        self.connection.settimeout(8)

    def reply(self, status, data=None, error="", jpeg=None):
        if jpeg is not None:
            content = jpeg
        elif status == 204:
            content = b""
        else:
            content = json.dumps({"success": status < 400, "data": data or {}, "error": error},
                                 allow_nan=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Vary", "Origin")
        self.send_header("X-Content-Type-Options", "nosniff")
        if self.headers.get("Origin") == self.server.frontend_origin:
            self.send_header("Access-Control-Allow-Origin", self.server.frontend_origin)
            if self.command == "OPTIONS":
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
                self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Type", "image/jpeg" if jpeg is not None else "application/json")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        if content:
            self.wfile.write(content)

    def command_body(self):
        if self.headers.get_content_type() != "application/json" or self.headers.get("Transfer-Encoding"):
            raise ControlError(400, "invalid_command")
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 1024:
                raise ValueError
            body = json.loads(self.rfile.read(size))
            if self.path == "/start" and body == {}:
                return None
            if self.path in {"/resume", "/finish"} and isinstance(body, dict) and set(body) == {"session_id"}:
                return str(UUID(str(body["session_id"])))
        except (ValueError, TypeError):
            pass
        raise ControlError(400, "invalid_command")

    def handle_control(self):
        port = self.server.server_port
        if (self.headers.get("Host") not in {f"localhost:{port}", f"127.0.0.1:{port}"}
                or self.headers.get("Origin") != self.server.frontend_origin):
            raise ControlError(403, "browser_origin_denied")
        if self.path not in ROUTES:
            raise ControlError(404, "unknown_control")
        method = ROUTES[self.path]
        if self.command == "OPTIONS":
            if self.headers.get("Access-Control-Request-Method") != method:
                raise ControlError(400, "invalid_preflight")
            return self.reply(204)
        if self.command != method:
            raise ControlError(400, "invalid_command")
        bearer = self.headers.get("Authorization", "")
        if not re.fullmatch(r"Bearer [A-Za-z0-9._-]{1,8192}", bearer):
            raise ControlError(401, "authentication_required")
        token = bearer[7:]
        user = verified_user(self.server.auth_client, self.server.base_url, token)
        manager = self.server.manager
        if self.path == "/preview":
            jpeg = manager.preview(user)
            return self.reply(200 if jpeg else 204, jpeg=jpeg)
        session_id = self.command_body() if method == "POST" else None
        snapshot = manager.handle(user, token, self.path[1:], session_id)
        self.reply(200, data=snapshot)

    def dispatch(self):
        try:
            self.handle_control()
        except ControlError as exc:
            self.reply(exc.status, error=exc.code)
        except (LocalAIError, DeliveryBlocked) as exc:
            # A worker credential failure is recoverable via a fresh status request.
            # A bridge 401 is reserved for an actual rejection by the backend.
            code = exc.code if re.fullmatch(r"[a-z0-9_]{1,90}", exc.code) else "measurement_unavailable"
            self.reply(409, error=code)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except httpx.HTTPError:
            self.reply(503, error="backend_unavailable")
        except Exception:
            self.reply(500, error="measurement_unavailable")

    do_GET = do_POST = do_OPTIONS = dispatch


class ControlServer(ThreadingHTTPServer):
    daemon_threads = False

    def server_close(self):
        super().server_close()
        try:
            self.manager.close()
        finally:
            self.auth_client.close()


def create_server(host, port, base_url, frontend_origin, manager):
    if host not in {"127.0.0.1", "localhost"}:
        raise ValueError("Use an explicit loopback address")
    base_url, frontend_origin = local_origin(base_url), local_origin(frontend_origin)
    # Assign resources before binding so an occupied port also cleans up correctly.
    server = ControlServer((host, port), Handler, bind_and_activate=False)
    server.manager = manager
    server.base_url = base_url
    server.frontend_origin = frontend_origin
    server.auth_client = httpx.Client(timeout=3, trust_env=False, follow_redirects=False)
    try:
        server.server_bind()
        server.server_activate()
    except Exception:
        server.server_close()
        raise
    return server


def main():
    from local_ai_web_runtime import WebAIRuntime
    parser = argparse.ArgumentParser(description="Run local browser controls for FocusLens AI measurement")
    parser.add_argument("--port", type=int, default=4317)
    parser.add_argument("--base-url", default="http://127.0.0.1:3000")
    parser.add_argument("--frontend-origin", default="http://localhost:5173")
    parser.add_argument("--state-dir", type=Path)
    parser.add_argument("--camera", type=int, default=0)
    args = parser.parse_args()
    if args.camera < 0 or not 0 < args.port <= 65535:
        parser.error("Invalid camera index or port")
    base_url = local_origin(args.base_url)
    frontend = local_origin(args.frontend_origin)
    manager = WebAIRuntime(base_url, state_root=args.state_dir, camera_index=args.camera)
    try:
        server = create_server("127.0.0.1", args.port, base_url, frontend, manager)
    except OSError:
        parser.exit(1, "Could not bind the local AI port. Check whether the bridge is already running.\n")
    stopping = False

    def stop(*_args):
        nonlocal stopping
        stopping = True

    with server:
        server.timeout = 0.5
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        print(f"FocusLens local AI ready on http://127.0.0.1:{server.server_port} for {frontend}", flush=True)
        while not stopping:
            server.handle_request()


if __name__ == "__main__":
    main()
