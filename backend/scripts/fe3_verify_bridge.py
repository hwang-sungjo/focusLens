"""Browser verifier companion: the CLI explicitly selects a real camera or a frame fixture."""
import json
import os
from pathlib import Path
import signal
import sqlite3
import sys
from threading import Event
from time import monotonic_ns, time_ns

from local_ai_web import create_server
from local_ai_web_runtime import WebAIRuntime
from local_ai import atomic_json


def fixture_capture(directory, recovery=False):
    """Use real elapsed time and the production calibration, scorer, queue and sender."""
    def capture(on_minute, minutes=0, camera_index=0, stop_event=None,
                on_event=lambda _event: None, on_preview=None):
        import cv2
        import numpy as np
        from local_ai_camera import ContinuousMinutes, WINDOW_MS
        from focuslens_ai.models import FrameMeasurement

        collector = ContinuousMinutes((time_ns() - monotonic_ns()) // 1_000_000,
                                      on_minute, on_event, minutes)
        ok, jpeg = cv2.imencode(".jpg", np.zeros((24, 32, 3), dtype=np.uint8))
        if not ok:
            raise RuntimeError("fixture preview encoding failed")
        jpeg = jpeg.tobytes()
        stop = stop_event or Event()
        on_event({"event": "calibration_started", "duration_ms": 3000})
        while not stop.is_set():
            if (directory / "interrupt_fixture_camera").exists():
                (directory / "interrupt_fixture_camera").unlink()
                raise RuntimeError("verification camera disconnected")
            if on_preview is not None:
                on_preview(jpeg)
            timestamp_ms = monotonic_ns() // 1_000_000
            if recovery and collector.completed_windows >= 1:
                frame = FrameMeasurement(timestamp_ms, False)
            else:
                gaze = 0.5 if collector.baseline is None else 0.9
                frame = FrameMeasurement(timestamp_ms, True, gaze, 0.5, 0.1, 0.1, False, 0, 0, 0)
            if collector.observe(frame):
                break
            stop.wait(1 / 10)
        assert WINDOW_MS == 60_000
        return collector.finish()

    return capture


def live_capture(directory):
    """Forward the production camera with only stage names and sample counts as diagnostics."""
    from local_ai_camera import collect_camera

    def capture(on_minute, *, on_event, **options):
        progress = {}
        target = directory / "fe3-live-progress.json"

        def stage(name, **counts):
            progress.update(stage=name, **counts)
            atomic_json(target, progress)

        def event(data):
            name = data["event"]
            if name in {"calibration_retry", "calibration_completed"}:
                stage(name, calibration_samples=data["samples"])
            elif name == "minute_skipped" and "samples" in data:
                stage(name, minute_samples=data["samples"])
            elif name in {"calibration_started", "camera_measurement_started", "minute_skipped"}:
                stage(name)
            on_event(data)

        def minute(result):
            on_minute(result)
            stage("minute_completed", minute_samples=result["samples"],
                  emitted_minutes=progress.get("emitted_minutes", 0) + 1)

        stage("opening_camera")
        return collect_camera(minute, on_event=event, retry_calibration=True, **options)

    return capture


def queue_evidence(state_root, recovery=False):
    rows = []
    sessions = []
    for file in state_root.rglob("outbox.sqlite3"):
        with sqlite3.connect(file.as_uri() + "?mode=ro", uri=True) as db:
            for session, status, stored in db.execute("SELECT session_id, status, payload FROM outbox ORDER BY rowid"):
                payload = json.loads(stored)
                rows.append({"session_id": session, "status": status, "client_log_id": payload["client_log_id"],
                             "score": payload["total"], "measured_at": payload["measured_at"]})
                if recovery:
                    rows[-1]["payload"] = payload
            sessions.extend(dict(session_id=row[0], status=row[1]) for row in db.execute(
                "SELECT session_id, status FROM delivery_sessions"))
    return {"logs": rows, "delivery_sessions": sessions}


def main():
    mode, *options = sys.argv[1:]
    if mode not in {"fixture", "live"} or options not in ([], ["--recovery"]):
        raise ValueError("invalid capture mode")
    recovery = bool(options)
    directory = Path(os.environ["LOCAL_ENV_FILE"]).resolve().parent
    state_root = directory / "fe3-state"
    manager = WebAIRuntime(os.environ["LOCAL_VERIFY_URL"], state_root=state_root,
                           capture=fixture_capture(directory, recovery) if mode == "fixture" else live_capture(directory))
    server = create_server("127.0.0.1", 0, os.environ["LOCAL_VERIFY_URL"],
                           os.environ["LOCAL_FRONTEND_ORIGIN"], manager)
    done = Event()
    for name in (signal.SIGINT, signal.SIGTERM):
        signal.signal(name, lambda *_: done.set())
    try:
        server.timeout = 0.25
        print(json.dumps({"port": server.server_address[1]}), flush=True)
        while not done.is_set():
            server.handle_request()
    finally:
        server.server_close()
    (directory / "fe3-queue.json").write_text(json.dumps(queue_evidence(state_root, recovery)), encoding="utf-8")


if __name__ == "__main__":
    main()
