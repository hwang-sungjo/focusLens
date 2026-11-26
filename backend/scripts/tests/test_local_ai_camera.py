import sys
import tempfile
import threading
import unittest
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from local_ai import LocalAIError
from local_ai_camera import ContinuousMinutes, _camera_lease, _PreviewRunner, collect_camera
from focuslens_ai.models import FrameMeasurement


def frame(ms, **changes):
    return replace(FrameMeasurement(ms, True, 0.5, 0.5, 0.1, 0.1, False, 0, 0, 0), **changes)


def calibrated(on_minute, on_event=lambda _event: None, **options):
    collector = ContinuousMinutes(1_700_000_000_000, on_minute, on_event, **options)
    for ms in range(0, 3001, 100):
        collector.observe(frame(ms))
    return collector


class ContinuousCameraTests(unittest.TestCase):
    def test_browser_retries_a_fresh_three_second_window_until_enough_faces(self):
        events = []
        collector = ContinuousMinutes(0, self.fail, events.append, retry_calibration=True)
        for ms in range(0, 6101, 100):
            collector.observe(frame(ms, face_detected=ms >= 3000))
        self.assertEqual(events[:2], [{"event": "calibration_retry", "samples": 0},
                                      {"event": "calibration_completed", "samples": 30}])
        self.assertEqual(collector.minute.start_ms, 6100)

    def test_cli_still_rejects_the_first_insufficient_window(self):
        collector = ContinuousMinutes(0, self.fail)
        with self.assertRaisesRegex(ValueError, "20 valid face samples"):
            for ms in range(0, 3001, 100):
                collector.observe(frame(ms, face_detected=False))

    def test_browser_reports_model_and_device_errors_without_private_diagnostics(self):
        with tempfile.TemporaryDirectory() as tmp, patch("local_ai_camera.AI_ROOT", Path(tmp) / "ai"), \
                patch("focuslens_ai.model_store.ensure_model") as model, \
                patch("focuslens_ai.mediapipe_runner.FaceLandmarkerRunner"), \
                patch("focuslens_ai.camera.WebcamPipeline") as pipeline:
            model.side_effect = OSError("private model path")
            with self.assertRaisesRegex(LocalAIError, "^model_unavailable$"):
                collect_camera(self.fail, on_preview=self.fail)
            model.side_effect = None
            for message, code in [("카메라 0번을 열 수 없습니다.", "camera_open_failed"),
                                  ("웹캠 프레임을 읽지 못했습니다.", "camera_read_failed")]:
                pipeline.return_value.run.side_effect = RuntimeError(message)
                with self.assertRaisesRegex(LocalAIError, f"^{code}$"):
                    collect_camera(self.fail, on_preview=self.fail)

    def test_cli_and_web_capture_cannot_acquire_the_same_camera(self):
        with tempfile.TemporaryDirectory() as tmp, patch("local_ai_camera.AI_ROOT", Path(tmp) / "ai"):
            with _camera_lease(0):
                with self.assertRaisesRegex(LocalAIError, "camera_in_use"), _camera_lease(0):
                    self.fail("Camera should be exclusive")
                with _camera_lease(1):
                    pass
            with _camera_lease(0):
                pass

    def test_preview_samples_the_same_inference_frames_as_small_jpegs(self):
        import cv2
        import numpy as np

        runner = Mock()
        image = np.zeros((480, 640, 3), dtype=np.uint8)
        previews = []
        adapter = _PreviewRunner(runner, previews.append)
        for ms in (1000, 1100, 1200):
            self.assertIs(adapter.detect(image, ms), runner.detect.return_value)
            self.assertIs(runner.detect.call_args.args[0], image)
        self.assertEqual(runner.detect.call_count, 3)
        self.assertEqual(len(previews), 2)
        for jpeg in previews:
            frame = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
            self.assertEqual(frame.shape[:2], (360, 480))

    def test_two_complete_minutes_share_boundary_frame_without_clock_backdating(self):
        results = []
        collector = calibrated(results.append, minutes=2)
        for ms in range(3100, 123101, 100):
            done = collector.observe(frame(ms))
        self.assertTrue(done)
        self.assertEqual(len(results), 2)
        self.assertEqual([result["samples"] for result in results], [600, 600])
        self.assertEqual([result["score"]["total"] for result in results], [100, 100])
        times = [datetime.fromisoformat(result["measured_at"].replace("Z", "+00:00")) for result in results]
        self.assertEqual((times[1] - times[0]).total_seconds(), 60)
        self.assertEqual(int(times[0].timestamp() * 1000), 1_700_000_063_100)
        self.assertEqual(collector.finish(), {
            "completed_windows": 2, "emitted_minutes": 2, "skipped_minutes": 0,
            "calibration_samples": 30, "partial_minute_discarded": False,
        })

    def test_late_boundary_frame_does_not_drift_subsequent_minute(self):
        results = []
        collector = calibrated(results.append, minutes=2)
        for ms in range(3100, 63100, 100):
            collector.observe(frame(ms))
        collector.observe(frame(63137))
        for ms in range(63237, 123100, 100):
            collector.observe(frame(ms))
        self.assertTrue(collector.observe(frame(123100)))
        self.assertEqual(results[0]["measured_at"], "2023-11-14T22:14:23.100Z")
        self.assertEqual(results[1]["measured_at"], "2023-11-14T22:15:23.100Z")
        self.assertEqual([result["samples"] for result in results], [600, 600])

    def test_existing_eighty_percent_eye_closure_penalty_is_unchanged(self):
        results = []
        collector = calibrated(results.append, minutes=1)
        for i in range(601):
            closed = 10 <= i < 148
            collector.observe(frame(
                3100 + i * 100, gaze_x=0.5 if i < 513 else 0.9,
                yaw=0 if i < 540 else 30,
                eye_blink_left=0.8 if closed else 0.1,
                eye_blink_right=0.8 if closed else 0.1,
            ))
        self.assertEqual(results[0]["score"], {
            "gaze": 85.5, "blink": 72, "head": 90, "total": 79.65, "face_detected": True,
        })
        self.assertEqual(results[0]["metrics"]["eye_closed_ms"], 13800)

    def test_insufficient_samples_skip_a_full_window_then_capture_recovers(self):
        results, events = [], []
        collector = calibrated(results.append, events.append, minutes=2)
        for ms in range(3100, 63101, 200):
            collector.observe(frame(ms))
        for ms in range(63200, 123101, 100):
            collector.observe(frame(ms))
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["samples"], 600)
        stats = collector.finish()
        self.assertEqual(stats["completed_windows"], 2)
        self.assertEqual(stats["skipped_minutes"], 1)
        self.assertTrue(any(event.get("reason") == "insufficient_valid_samples" for event in events))

    def test_face_absence_uses_existing_zero_score_rule(self):
        results = []
        collector = calibrated(results.append, minutes=1)
        for ms in range(3100, 63101, 100):
            collector.observe(frame(ms, face_detected=False))
        self.assertEqual(results[0]["score"], {
            "gaze": 0, "blink": 0, "head": 0, "total": 0, "face_detected": False,
        })

    def test_gap_over_a_minute_skips_missing_windows_without_synthetic_samples(self):
        results, events = [], []
        collector = calibrated(results.append, events.append)
        for ms in range(3100, 23100, 100):
            collector.observe(frame(ms))
        collector.observe(frame(190000))
        for ms in range(190100, 250001, 100):
            collector.observe(frame(ms))
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["samples"], 600)
        self.assertEqual(results[0]["measured_at"], "2023-11-14T22:17:30.000Z")
        self.assertEqual(collector.completed_windows, 4)
        self.assertEqual(collector.skipped_minutes, 3)
        self.assertEqual([event["skipped_windows"] for event in events if event.get("reason") == "camera_gap"], [3])

    def test_window_limit_counts_invalid_and_missing_windows(self):
        results = []
        collector = calibrated(results.append, minutes=2)
        collector.observe(frame(3100))
        self.assertTrue(collector.observe(frame(250000)))
        stats = collector.finish()
        self.assertEqual(stats["completed_windows"], 2)
        self.assertEqual(stats["skipped_minutes"], 2)
        self.assertEqual(results, [])

    def test_final_partial_window_is_not_emitted(self):
        results = []
        collector = calibrated(results.append)
        for ms in range(3100, 20000, 100):
            collector.observe(frame(ms))
        stats = collector.finish()
        self.assertTrue(stats["partial_minute_discarded"])
        self.assertEqual(collector.finish(), stats)
        self.assertEqual(results, [])
        with self.assertRaisesRegex(ValueError, "finished"):
            collector.observe(frame(20100))

    def test_invalid_calibration_and_nonincreasing_times_fail_without_emitting(self):
        results = []
        collector = ContinuousMinutes(0, results.append)
        for ms in range(0, 3000, 100):
            collector.observe(frame(ms, face_detected=False))
        with self.assertRaisesRegex(ValueError, "20 valid"):
            collector.observe(frame(3000, face_detected=False))
        collector = calibrated(results.append)
        collector.observe(frame(3100))
        for ms in [3100, 3000]:
            with self.assertRaisesRegex(ValueError, "increasing"):
                collector.observe(frame(ms))
        self.assertEqual(results, [])

    def test_callback_failure_propagates_instead_of_acknowledging_undurable_data(self):
        def fail(_result):
            raise RuntimeError("queue unavailable")
        collector = calibrated(fail, minutes=1)
        for ms in range(3100, 63100, 100):
            collector.observe(frame(ms))
        with self.assertRaisesRegex(RuntimeError, "queue unavailable"):
            collector.observe(frame(63100))
        self.assertEqual(collector.emitted_minutes, 0)

    def test_invalid_runtime_options_are_rejected_without_opening_camera(self):
        for value in [-1, True, 1.5]:
            with self.assertRaises(ValueError):
                ContinuousMinutes(0, lambda _result: None, minutes=value)
            with self.assertRaises(ValueError):
                collect_camera(lambda _result: None, camera_index=value)

    def test_already_stopped_capture_never_initializes_camera_dependencies(self):
        event = threading.Event()
        event.set()
        stats = collect_camera(lambda _result: self.fail("must not emit"), stop_event=event)
        self.assertEqual(stats["completed_windows"], 0)
        self.assertFalse(stats["partial_minute_discarded"])


if __name__ == "__main__":
    unittest.main()
