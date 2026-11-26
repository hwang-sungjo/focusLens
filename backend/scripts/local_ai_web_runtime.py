"""Account-scoped control of the local camera and durable v2 queue for the browser."""
import hashlib
import json
import threading
from functools import partial
from pathlib import Path
from time import monotonic
from uuid import UUID

from ai3_delivery import DeliveryBlocked
from local_ai import ROOT, LocalAIError, LocalAIRuntime, local_origin


# A closed browser or a logged-out viewer cannot leave the camera recording indefinitely.
BROWSER_LEASE_SECONDS = 90


class _BrowserToken:
    """Only the web client handles refresh, using its HttpOnly cookie."""

    def __init__(self, access):
        self.access = access

    def get(self):
        return {"access_token": self.access}


class _Capture:
    def __init__(self, runtime, user):
        self.runtime = runtime
        self.user = user
        self.stop = threading.Event()
        self.last_seen = monotonic()
        self.stage = "calibrating"
        self.error = None
        self.frame = None
        self.finish_requested = False
        self.thread = None

    def event(self, event):
        kind = event["event"]
        if kind == "camera_measurement_started":
            self.stage = "measuring"
            self.error = None
        elif kind == "calibration_retry":
            self.error = "calibration_needs_face"
        elif kind == "minute_skipped":
            self.error = event["reason"]
        elif kind == "minute_enqueued":
            self.error = None

    def publish(self, jpeg):
        if not self.stop.is_set():
            self.frame = jpeg


def _snapshot(runtime=None, capture=None):
    state = runtime.state if runtime else {}
    session = state.get("session_id")
    phase = state.get("phase", "idle")
    if phase == "measuring" and capture is None:
        phase = "paused"  # Unclean process exit; no camera is attached.
    error = capture.error if capture else state.get("web_error")
    if phase == "starting" and not error:
        error = "start_confirmation_required_use_resume"
    if phase == "closing" and capture is None and not error:
        error = "retry_finish_required"
    latest = None
    pending = failed = 0
    if session:
        client = runtime.client
        with client._mutex:
            counts = dict(client.db.execute(
                "SELECT status, count(*) FROM outbox WHERE session_id=? GROUP BY status", (session,)))
            row = client.db.execute(
                "SELECT payload FROM outbox WHERE session_id=? ORDER BY rowid DESC LIMIT 1", (session,)
            ).fetchone()
        pending, failed = counts.get("pending", 0), counts.get("failed", 0)
        if row:
            payload = json.loads(row["payload"])
            total = payload["total"]
            # These are the backend's attention bands (focusScore.js); the score itself
            # comes from the exact immutable v2 payload, also available while offline.
            attention = "FOCUSED" if total >= 70 else "NORMAL" if total >= 40 else "DISTRACTED"
            latest = {key: payload[key] for key in ("client_log_id", "measured_at", "gaze", "blink",
                                                     "head", "face_detected")}
            latest.update(focus_score=total, attention_state=attention)
    stage = capture.stage if capture and phase == "measuring" else phase
    return {"phase": phase, "session_id": session, "started_at": state.get("started_at"),
            "latest": latest, "stage": stage, "pending": pending, "failed": failed,
            "error": error, "preview_ready": bool(capture and not capture.stop.is_set() and capture.frame)}


class WebAIRuntime:
    def __init__(self, base_url, state_root=None, camera_index=0, capture=None):
        self.origin = local_origin(base_url)
        self.directory = Path(state_root or ROOT / ".local" / "ai-web") / hashlib.sha256(
            self.origin.encode()).hexdigest()[:16]
        if isinstance(camera_index, bool) or not isinstance(camera_index, int) or camera_index < 0:
            raise LocalAIError("invalid_camera_index")
        self.camera_index = camera_index
        self.capture = capture
        self.lock = threading.RLock()
        self.active = None
        self.closed = False

    def _runtime(self, user, token):
        runtime = LocalAIRuntime(self.origin, self.directory / user, tokens=_BrowserToken(token))
        try:
            if "user_id" not in runtime.state:
                runtime._save(user_id=user)
            elif runtime.state["user_id"] != user:
                raise LocalAIError("queue_account_or_origin_mismatch")
            return runtime
        except BaseException:
            runtime.close()
            raise

    @staticmethod
    def _check_session(runtime, session):
        if not session:
            raise LocalAIError("confirm_session_id_required")
        if runtime.state["phase"] == "starting" and not runtime.state.get("session_id"):
            # LocalAIRuntime rechecks the explicit candidate against the backend.
            return
        if runtime.state.get("session_id") != session:
            raise LocalAIError("session_not_managed_here")

    def handle(self, user_id, access_token, action, session_id=None):
        try:
            user = str(UUID(user_id))
            session = str(UUID(session_id)) if session_id is not None else None
        except (TypeError, ValueError, AttributeError):
            raise LocalAIError("invalid_identity") from None
        if not isinstance(access_token, str) or not access_token:
            raise LocalAIError("authentication_required")
        if action not in {"status", "start", "resume", "finish"}:
            raise LocalAIError("invalid_action")
        with self.lock:
            if self.closed:
                raise LocalAIError("bridge_closing")
            current = self.active
            if current and current.user == user:
                runtime = current.runtime
                runtime.tokens.access = access_token
                current.last_seen = monotonic()
                if action in {"resume", "finish"}:
                    self._check_session(runtime, session)
                if action == "finish" and not current.finish_requested:
                    # Record the end intent before asking the camera to release. A
                    # crash here must drain/finish on retry, never resume capture.
                    runtime._save(phase="closing", web_error=None)
                    current.finish_requested = True
                    current.stop.set()
                return _snapshot(runtime, current)

            has_state = (self.directory / user / "session.json").exists()
            if action == "status" and not has_state:
                return _snapshot()
            if action in {"resume", "finish"} and not has_state:
                raise LocalAIError("session_not_managed_here")
            runtime = self._runtime(user, access_token)
            transfer_to_worker = False
            try:
                phase = runtime.state["phase"]
                if action == "status":
                    return _snapshot(runtime)
                if action in {"resume", "finish"}:
                    self._check_session(runtime, session)
                    if phase == "ended":
                        return _snapshot(runtime)
                if current:
                    raise LocalAIError("camera_in_use")
                finish_only = action == "finish" or (action == "resume" and phase == "closing")
                if finish_only:
                    if phase == "starting":
                        runtime.resume_session(confirmed_session_id=session)
                    runtime._save(phase="closing", web_error=None)
                elif action == "start":
                    if phase == "starting" and not runtime.state.get("session_id"):
                        if runtime._active_sessions():
                            raise LocalAIError("confirm_session_id_required")
                        runtime._save(phase="idle")
                    runtime.start()
                else:
                    runtime.resume_session(confirmed_session_id=session)
                if not finish_only:
                    runtime._save(phase="measuring", web_error=None)
                runtime.client  # Validate the binding and obtain both file locks before starting.
                capture = _Capture(runtime, user)
                runtime.on_event = capture.event
                capture.finish_requested = finish_only
                target = self._settle if finish_only else self._run
                capture.thread = threading.Thread(target=target, args=(capture,), name="focuslens-web-camera")
                self.active = capture
                try:
                    capture.thread.start()
                except RuntimeError:
                    self.active = None
                    runtime._save(phase="closing" if finish_only else "paused",
                                  web_error="camera_or_local_state_unavailable")
                    raise
                transfer_to_worker = True
                return _snapshot(runtime, capture)
            except (LocalAIError, DeliveryBlocked) as error:
                if runtime.state["phase"] in {"starting", "closing"}:
                    runtime._save(web_error=error.code)
                raise
            finally:
                if not transfer_to_worker:
                    runtime.close()

    def _watch(self, capture):
        while not capture.stop.is_set():
            with self.lock:
                remaining = capture.last_seen + BROWSER_LEASE_SECONDS - monotonic()
                if remaining <= 0:
                    capture.error = "browser_disconnected"
                    capture.stop.set()
                    return
            capture.stop.wait(remaining)

    def _run(self, capture):
        runtime = capture.runtime
        watcher = threading.Thread(target=self._watch, args=(capture,), name="focuslens-camera-presence")
        watcher.start()
        try:
            camera = self.capture
            if camera is None:
                from local_ai_camera import collect_camera
                camera = partial(collect_camera, retry_calibration=True)
            runtime.capture_session(0, self.camera_index, capture.stop,
                                    capture=partial(camera, on_preview=capture.publish), wait_for_browser_auth=True)
        except (LocalAIError, DeliveryBlocked) as error:
            capture.error = error.code
        except Exception:
            capture.error = "camera_or_local_state_unavailable"
        finally:
            capture.stop.set()
            watcher.join()
            self._settle(capture)

    def _settle(self, capture):
        # Read the end intent under the command lock and keep exclusive ownership
        # through the last receipt. Polls can inspect closing while HTTP drains.
        runtime = capture.runtime
        with self.lock:
            capture.frame = None
            if not capture.finish_requested:
                try:
                    runtime._save(phase="paused", web_error=capture.error)
                finally:
                    runtime.close()
                    self.active = None
                return
        try:
            runtime.finish()
        except (DeliveryBlocked, LocalAIError) as error:
            runtime._save(phase="closing", web_error=error.code)
        except Exception:
            runtime._save(phase="closing", web_error="camera_or_local_state_unavailable")
        finally:
            with self.lock:
                runtime.close()
                self.active = None

    def preview(self, user_id):
        with self.lock:
            capture = self.active
            if capture and capture.user == user_id and not capture.stop.is_set():
                return capture.frame
            return None

    def close(self):
        with self.lock:
            self.closed = True
            active = self.active
            if active:
                active.stop.set()
        if active:
            active.thread.join()
