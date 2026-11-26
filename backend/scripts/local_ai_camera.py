"""Continuous webcam minutes for the local backend adapter.

Only this adapter is new: calibration, frame extraction and scoring are supplied
by the existing AI pipeline. Normal windows stay on their first 60-second grid;
the closing frame also opens the next window. A gap longer than one whole
minute invalidates elapsed windows, and capture resumes from the current frame
without manufacturing samples for the missing time. No partial window is sent.
"""
from __future__ import annotations

import os
from pathlib import Path
from time import monotonic_ns, time_ns

from ai2_scoring import AI_ROOT, Calibration, ScoredMinute, timestamp
from focuslens_ai.config import DEFAULT_CONFIG


WINDOW_MS = DEFAULT_CONFIG.aggregation.interval_ms


class ContinuousMinutes:
    def __init__(self, utc_offset_ms, on_minute, on_event=lambda _event: None, minutes=0):
        if isinstance(utc_offset_ms, bool) or not isinstance(utc_offset_ms, int):
            raise ValueError("utc_offset_ms must be integer milliseconds")
        if isinstance(minutes, bool) or not isinstance(minutes, int) or minutes < 0:
            raise ValueError("minutes must be a nonnegative integer")
        if not callable(on_minute) or not callable(on_event):
            raise ValueError("Minute and event callbacks must be callable")
        self.utc_offset_ms = utc_offset_ms
        self.on_minute = on_minute
        self.on_event = on_event
        self.minutes = minutes
        self.calibration = Calibration()
        self.baseline = None
        self.minute = None
        self.last_ms = None
        self.completed_windows = 0
        self.emitted_minutes = 0
        self.skipped_minutes = 0
        self.calibration_samples = 0
        self._finished = False
        self._stats = None

    def _new_minute(self, start_ms):
        self.minute = ScoredMinute(self.baseline)
        # ScoredMinute's public start field fixes the next boundary even when
        # the camera observes that boundary a few milliseconds late.
        self.minute.start_ms = start_ms

    def _at_limit(self):
        return self.minutes > 0 and self.completed_windows >= self.minutes

    def _skip(self, count, reason):
        if self.minutes:
            count = min(count, self.minutes - self.completed_windows)
        self.completed_windows += count
        self.skipped_minutes += count
        self.on_event({
            "event": "minute_skipped", "reason": reason,
            "skipped_windows": count, "completed_windows": self.completed_windows,
        })

    def observe(self, frame):
        """Observe one real frame; return True when the requested windows end."""
        if self._finished:
            raise ValueError("camera measurement is already finished")
        if self._at_limit():
            return True
        current_ms = timestamp(frame, self.last_ms)
        gap_ms = None if self.last_ms is None else current_ms - self.last_ms
        self.last_ms = current_ms

        if self.baseline is None:
            if self.calibration.observe(frame):
                self.baseline = self.calibration.baseline()
                self.calibration_samples = len(self.calibration.frames)
                # Release calibration frame features once the baseline is known.
                self.calibration = None
                self.on_event({"event": "calibration_completed", "samples": self.calibration_samples})
            return False

        if self.minute is None:
            self._new_minute(current_ms)
            self.on_event({"event": "camera_measurement_started", "window_ms": WINDOW_MS})
        elif gap_ms > WINDOW_MS:
            elapsed = (current_ms - self.minute.start_ms) // WINDOW_MS
            self._skip(max(1, elapsed), "camera_gap")
            self.minute = None
            if self._at_limit():
                return True
            self._new_minute(current_ms)

        if not self.minute.observe(frame):
            return False

        next_start_ms = self.minute.start_ms + WINDOW_MS
        self.completed_windows += 1
        try:
            result = self.minute.result(self.utc_offset_ms)
        except ValueError:
            self.skipped_minutes += 1
            self.on_event({
                "event": "minute_skipped", "reason": "insufficient_valid_samples",
                "skipped_windows": 1, "completed_windows": self.completed_windows,
            })
        else:
            # The parent must persist this result before acknowledging it. Network
            # delivery belongs to its separate outbox worker, not this callback.
            self.on_minute(result)
            self.emitted_minutes += 1
            self.on_event({
                "event": "minute_completed", "completed_windows": self.completed_windows,
                "emitted_minutes": self.emitted_minutes,
            })
        self.minute = None
        if self._at_limit():
            return True
        self._new_minute(next_start_ms)
        self.minute.observe(frame)
        return False

    def finish(self):
        """Return safe counters and discard any incomplete final window."""
        if self._stats is not None:
            return dict(self._stats)
        partial = self.minute is not None and not self.minute.complete and self.minute.samples > 0
        self._finished = True
        self.minute = None
        self._stats = {
            "completed_windows": self.completed_windows,
            "emitted_minutes": self.emitted_minutes,
            "skipped_minutes": self.skipped_minutes,
            "calibration_samples": self.calibration_samples,
            "partial_minute_discarded": partial,
        }
        return dict(self._stats)


def collect_camera(on_minute, minutes=0, camera_index=0, stop_event=None,
                   on_event=lambda _event: None):
    """Collect real webcam data; caller controls signals and owns the outbox."""
    if isinstance(camera_index, bool) or not isinstance(camera_index, int) or camera_index < 0:
        raise ValueError("camera_index must be a nonnegative integer")
    collector = ContinuousMinutes(
        (time_ns() - monotonic_ns()) // 1_000_000, on_minute, on_event, minutes,
    )
    if stop_event is not None and stop_event.is_set():
        return collector.finish()
    # Heavy camera imports stay lazy so status/login, cancelled capture and pure
    # aggregation tests do not initialize a camera or MediaPipe.
    from focuslens_ai.camera import WebcamPipeline
    from focuslens_ai.mediapipe_runner import FaceLandmarkerRunner
    from focuslens_ai.model_store import ensure_model

    model_path = Path(os.environ.get("FOCUSLENS_MODEL_PATH",
                                     AI_ROOT.parent / ".local" / "ai" / "models" / "face_landmarker.task"))
    on_event({"event": "calibration_started", "duration_ms": 3000})
    with FaceLandmarkerRunner(ensure_model(model_path)) as runner:
        pipeline = WebcamPipeline(runner, DEFAULT_CONFIG, camera_index=camera_index, preview=False)

        def on_measurement(frame):
            if stop_event is not None and stop_event.is_set():
                pipeline.stop()
                return
            if collector.observe(frame):
                pipeline.stop()

        pipeline.run(on_measurement)
    return collector.finish()
