"""Collect one real webcam minute using the existing AI feature pipeline."""
import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from time import monotonic_ns, time_ns

AI_ROOT = Path(__file__).resolve().parents[2] / "ai"
sys.path.insert(0, str(AI_ROOT / "src"))

from focuslens_ai.config import DEFAULT_CONFIG


class CameraMinute:
    def __init__(self):
        self.start_ms = None
        self.last_ms = None
        self.samples = 0
        self.faces = 0

    def observe(self, frame):
        if self.last_ms is not None and frame.timestamp_ms <= self.last_ms:
            raise ValueError("camera sample timestamps must be strictly increasing")
        self.last_ms = frame.timestamp_ms
        if self.start_ms is None:
            self.start_ms = frame.timestamp_ms
        if frame.timestamp_ms - self.start_ms >= DEFAULT_CONFIG.aggregation.interval_ms:
            return True  # This frame belongs to the next minute.
        self.samples += 1
        self.faces += int(frame.face_detected)
        return False

    def result(self, utc_offset_ms):
        window_ms = DEFAULT_CONFIG.aggregation.interval_ms
        if self.start_ms is None or self.last_ms - self.start_ms < window_ms:
            raise ValueError("a full minute of camera input is required")
        if self.samples < 480:
            raise ValueError(f"only {self.samples} samples in 60s (minimum 480); no log sent")
        if self.faces / self.samples >= DEFAULT_CONFIG.aggregation.face_detection_ratio_threshold:
            raise ValueError(f"face present in {self.faces}/{self.samples} frames; "
                             "the absence score does not apply; no log sent")
        end_utc = datetime.fromtimestamp((utc_offset_ms + self.start_ms + window_ms) / 1000, timezone.utc)
        return {
            "samples": self.samples, "face_samples": self.faces, "window_ms": window_ms,
            "measured_at": end_utc.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "score": {"gaze": 0, "blink": 0, "head": 0, "total": 0, "face_detected": False},
        }


def focus_fixture():
    from ai2_scoring import Calibration, ScoredMinute
    from focuslens_ai.models import FrameMeasurement

    def sample(ms, gaze_x=0.5, yaw=0.0, closed=False):
        return FrameMeasurement(
            timestamp_ms=ms, face_detected=True, gaze_x=gaze_x, gaze_y=0.5,
            yaw=yaw, pitch=0.0, roll=0.0,
            eye_blink_left=0.8 if closed else 0.1,
            eye_blink_right=0.8 if closed else 0.1, eye_closed=closed,
        )

    calibration = Calibration()
    for ms in range(0, 3001, 100):
        calibration.observe(sample(ms))
    minute = ScoredMinute(calibration.baseline())
    for i in range(601):
        minute.observe(sample(
            3100 + i * 100, gaze_x=0.5 if i < 513 else 0.9,
            yaw=0.0 if i < 540 else 30.0, closed=10 <= i < 148,
        ))
    result = minute.result(time_ns() // 1_000_000 - 63_100)
    result["metrics"]["calibration_samples"] = len(calibration.frames)
    return result


def run_minute(fixture, focus):
    from ai2_scoring import Calibration, ScoredMinute
    from focuslens_ai.camera import WebcamPipeline
    from focuslens_ai.feature_extractor import extract_frame_measurement
    from focuslens_ai.mediapipe_runner import FaceLandmarkerRunner
    from focuslens_ai.model_store import ensure_model

    path = Path(os.environ.get("FOCUSLENS_MODEL_PATH", AI_ROOT / DEFAULT_CONFIG.model_path))
    index = int(os.environ.get("AI2_CAMERA_INDEX", "0"))
    if index < 0:
        raise ValueError("AI2_CAMERA_INDEX must be a nonnegative camera index")
    minute = None if focus else CameraMinute()
    calibration = Calibration() if focus else None
    calibration_samples = None
    with FaceLandmarkerRunner(ensure_model(path)) as runner:
        if fixture:
            import numpy as np
            blank = np.zeros((480, 640, 3), dtype=np.uint8)
            # Virtual 10 FPS covering one minute ending now, including the closing boundary.
            utc_offset_ms = time_ns() // 1_000_000 - DEFAULT_CONFIG.aggregation.interval_ms
            for ms in range(0, DEFAULT_CONFIG.aggregation.interval_ms + 1, 100):
                minute.observe(extract_frame_measurement(runner.detect(blank, ms), ms))
            return minute.result(utc_offset_ms)
        pipeline = WebcamPipeline(runner, DEFAULT_CONFIG, camera_index=index, preview=False)
        # WebcamPipeline timestamps frames using the same monotonic clock.
        utc_offset_ms = (time_ns() - monotonic_ns()) // 1_000_000

        def on_measurement(frame):
            nonlocal minute, calibration, calibration_samples
            if calibration is not None:
                if calibration.observe(frame):
                    minute = ScoredMinute(calibration.baseline())
                    calibration_samples = len(calibration.frames)
                    calibration = None
                    print("AI-2: calibration complete; measuring 60 seconds.", file=sys.stderr, flush=True)
                return
            if minute.start_ms is None:
                print("AI-2: first camera sample received; measuring 60 seconds.", file=sys.stderr, flush=True)
            if minute.observe(frame):
                pipeline.stop()

        pipeline.run(on_measurement)
    if minute is None:
        raise ValueError("calibration did not finish")
    result = minute.result(utc_offset_ms)
    if focus:
        result["metrics"]["calibration_samples"] = calibration_samples
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--blank-fixture", action="store_true", help="use generated black images and a virtual clock")
    mode.add_argument("--focus", action="store_true", help="calibrate and score a real face minute")
    mode.add_argument("--focus-fixture", action="store_true", help="score deterministic frame features with a virtual clock")
    args = parser.parse_args()
    try:
        result = focus_fixture() if args.focus_fixture else run_minute(args.blank_fixture, args.focus)
        source = "focus-fixture" if args.focus_fixture else "blank-fixture" if args.blank_fixture else "camera"
        print(json.dumps({**result, "source": source}))
    except (ImportError, OSError, RuntimeError, ValueError) as error:
        sys.exit(f"AI-2 camera: {error}")
