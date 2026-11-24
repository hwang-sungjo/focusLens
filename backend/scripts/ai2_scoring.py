"""Calibration and one-minute scores for the AI-2 integration verifier."""
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

AI_ROOT = Path(__file__).resolve().parents[2] / "ai"
sys.path.insert(0, str(AI_ROOT / "src"))

from focuslens_ai.config import DEFAULT_CONFIG
from focuslens_ai.models import CalibrationBaseline
from focuslens_ai.score_calculator import calculate_total_score, clamp_score, round_score


BASELINE_FIELDS = ("gaze_x", "gaze_y", "yaw", "pitch", "roll")
EYE_CLOSURE_THRESHOLD = 0.8
MAX_CONTINUOUS_SAMPLE_GAP_MS = 250


def finite_fields(frame, names):
    return all(isinstance(getattr(frame, name), (int, float))
               and not isinstance(getattr(frame, name), bool)
               and math.isfinite(getattr(frame, name)) for name in names)


def valid_face(frame):
    return frame.face_detected and finite_fields(frame, BASELINE_FIELDS)


def valid_measurement(frame):
    if not frame.face_detected:
        return True
    return valid_face(frame) and valid_eyes(frame)


def valid_eyes(frame):
    # Closed eyelids can make gaze extraction unavailable while blendshapes
    # remain usable. Eye duration must not depend on the gaze/head channels.
    return (frame.face_detected and finite_fields(frame, ("eye_blink_left", "eye_blink_right"))
            and 0 <= frame.eye_blink_left <= 1 and 0 <= frame.eye_blink_right <= 1)


def timestamp(frame, previous):
    value = frame.timestamp_ms
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("camera sample timestamps must be integer milliseconds")
    if previous is not None and value <= previous:
        raise ValueError("camera sample timestamps must be strictly increasing")
    if not isinstance(frame.face_detected, bool):
        raise ValueError("face_detected must be boolean")
    return value


def closure_ratio_penalty(closed_ms, window_ms=60_000):
    """Each complete percentage point beyond 15% subtracts one point."""
    return max(0, (closed_ms * 100 - window_ms * 15) // window_ms)


class Calibration:
    def __init__(self):
        self.start_ms = None
        self.last_ms = None
        self.frames = []

    def observe(self, frame):
        self.last_ms = timestamp(frame, self.last_ms)
        if self.start_ms is None:
            self.start_ms = frame.timestamp_ms
        if self.last_ms - self.start_ms >= 3_000:
            return True
        if valid_face(frame):
            self.frames.append(frame)
        return False

    def baseline(self):
        if self.start_ms is None or self.last_ms - self.start_ms < 3_000:
            raise ValueError("calibration requires 3 seconds")
        if len(self.frames) < 20:
            raise ValueError("calibration requires at least 20 valid face samples")
        return CalibrationBaseline(**{
            name: sum(getattr(frame, name) for frame in self.frames) / len(self.frames)
            for name in BASELINE_FIELDS
        })


class ScoredMinute:
    def __init__(self, baseline):
        self.baseline = baseline
        self.start_ms = None
        self.last_ms = None
        self.previous = None
        self.samples = 0
        self.faces = 0
        self.invalid_samples = 0
        self.gaze_on = 0
        self.head_on = 0
        self.closed_ms = 0
        self.unknown_ms = 0
        self.closure_start = None
        self.closure_had_open = False
        self.long_counted = False
        self.blink_count = 0
        self.normal_blink_count = 0
        self.long_closure_count = 0
        self.complete = False

    @staticmethod
    def closed(frame):
        return (frame.eye_blink_left >= EYE_CLOSURE_THRESHOLD
                and frame.eye_blink_right >= EYE_CLOSURE_THRESHOLD)

    def observe(self, frame):
        if self.complete:
            raise ValueError("minute is already complete")
        current_ms = timestamp(frame, self.last_ms)
        if self.start_ms is None:
            self.start_ms = current_ms
        end_ms = self.start_ms + DEFAULT_CONFIG.aggregation.interval_ms
        effective_ms = min(current_ms, end_ms)
        usable = valid_measurement(frame)
        eye_known = valid_eyes(frame)
        if self.previous is not None:
            previous_known = valid_eyes(self.previous)
            continuous = previous_known and eye_known and current_ms - self.last_ms <= MAX_CONTINUOUS_SAMPLE_GAP_MS
            if continuous:
                if self.closed(self.previous):
                    self.closed_ms += effective_ms - self.last_ms
                    if not self.long_counted and effective_ms - self.closure_start >= DEFAULT_CONFIG.blink.long_closure_ms:
                        self.long_closure_count += 1
                        self.long_counted = True
                    if not self.closed(frame):
                        duration = effective_ms - self.closure_start
                        if self.closure_had_open:
                            self.blink_count += 1
                            if DEFAULT_CONFIG.blink.normal_min_ms <= duration <= DEFAULT_CONFIG.blink.normal_max_ms:
                                self.normal_blink_count += 1
                        self.closure_start = None
                elif self.closed(frame):
                    self.closure_start = effective_ms
                    self.closure_had_open = True
                    self.long_counted = False
            else:
                self.unknown_ms += effective_ms - self.last_ms
                self.closure_start = effective_ms if eye_known and self.closed(frame) else None
                self.closure_had_open = False
                self.long_counted = False
        elif eye_known and self.closed(frame):
            # A leading closed interval cannot be a completed normal blink, but a
            # measured 1s closure still counts for the long-closure penalty.
            self.closure_start = effective_ms
        self.previous = frame
        self.last_ms = current_ms
        if current_ms >= end_ms:
            self.complete = True
            return True
        if not usable:
            self.invalid_samples += 1
            return False
        self.samples += 1
        if frame.face_detected:
            self.faces += 1
            gaze = DEFAULT_CONFIG.gaze
            head = DEFAULT_CONFIG.head
            self.gaze_on += int(abs(frame.gaze_x - self.baseline.gaze_x) <= gaze.x_threshold
                                and abs(frame.gaze_y - self.baseline.gaze_y) <= gaze.y_threshold)
            self.head_on += int(abs(frame.yaw - self.baseline.yaw) <= head.yaw_threshold
                                and abs(frame.pitch - self.baseline.pitch) <= head.pitch_threshold
                                and abs(frame.roll - self.baseline.roll) <= head.roll_threshold)
        return False

    def result(self, utc_offset_ms):
        if not self.complete:
            raise ValueError("a full minute of camera input is required")
        if self.samples < 480:
            raise ValueError(f"only {self.samples} valid samples in 60s (minimum 480); no log sent")
        window_ms = DEFAULT_CONFIG.aggregation.interval_ms
        detected = self.faces / self.samples >= DEFAULT_CONFIG.aggregation.face_detection_ratio_threshold
        penalty = closure_ratio_penalty(self.closed_ms, window_ms)
        gaze = round_score(self.gaze_on / self.faces * 100) if detected else 0
        head = round_score(self.head_on / self.faces * 100) if detected else 0
        blink = clamp_score(100 - 20 * self.long_closure_count - penalty) if detected else 0
        end_utc = datetime.fromtimestamp((utc_offset_ms + self.start_ms + window_ms) / 1000, timezone.utc)
        return {
            "samples": self.samples, "face_samples": self.faces, "window_ms": window_ms,
            "measured_at": end_utc.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "score": {"gaze": gaze, "blink": blink, "head": head,
                      "total": calculate_total_score(gaze, blink, head), "face_detected": detected},
            "metrics": {
                "eye_closed_ms": self.closed_ms,
                "eye_closed_ratio": self.closed_ms / window_ms,
                "prolonged_closure": self.closed_ms * 100 >= window_ms * 15,
                "ratio_penalty": penalty, "long_closure_count": self.long_closure_count,
                "blink_count": self.blink_count, "normal_blink_count": self.normal_blink_count,
                "unknown_blink_ms": self.unknown_ms, "invalid_samples": self.invalid_samples,
            },
        }
