import sys
import unittest
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ai2_scoring import Calibration, ScoredMinute, closure_ratio_penalty
from focuslens_ai.models import CalibrationBaseline, FrameMeasurement


BASELINE = CalibrationBaseline(0.5, 0.5, 0, 0, 0)


def frame(ms, **changes):
    return replace(FrameMeasurement(ms, True, 0.5, 0.5, 0.1, 0.1, False, 0, 0, 0), **changes)


def minute_result(change_frame):
    minute = ScoredMinute(BASELINE)
    for i in range(601):
        minute.observe(change_frame(i, frame(i * 100)))
    return minute.result(0)


class ScoringTests(unittest.TestCase):
    def test_ratio_penalty_at_exact_percentage_boundaries(self):
        for closed_ms, expected in [(8994, 0), (9000, 0), (9599, 0), (9600, 1), (13800, 8), (60000, 85)]:
            with self.subTest(closed_ms=closed_ms):
                self.assertEqual(closure_ratio_penalty(closed_ms), expected)

    def test_reference_minute_scores_and_time_weighted_penalty(self):
        def sample(i, value):
            return replace(value, gaze_x=0.5 if i < 513 else 0.9,
                           yaw=0 if i < 540 else 40,
                           eye_blink_left=0.8 if 10 <= i < 148 else 0.1,
                           eye_blink_right=0.8 if 10 <= i < 148 else 0.1)
        result = minute_result(sample)
        self.assertEqual(result["score"], dict(gaze=85.5, blink=72, head=90, total=79.65, face_detected=True))
        self.assertEqual(result["metrics"]["eye_closed_ms"], 13800)
        self.assertEqual(result["metrics"]["long_closure_count"], 1)
        self.assertEqual(result["metrics"]["ratio_penalty"], 8)

    def test_one_eye_or_below_eighty_percent_does_not_count_as_closed(self):
        for left, right in [(0.8, 0.79), (0.79, 0.8), (0.79, 0.79)]:
            result = minute_result(lambda i, value: replace(value, eye_blink_left=left, eye_blink_right=right))
            self.assertEqual(result["score"]["blink"], 100)
            self.assertEqual(result["metrics"]["eye_closed_ms"], 0)

    def test_variable_sampling_uses_elapsed_time_instead_of_frame_count(self):
        minute = ScoredMinute(BASELINE)
        timestamps = list(range(0, 30000, 50)) + list(range(30000, 60001, 200))
        for ms in timestamps:
            closed = ms < 9000
            minute.observe(frame(ms, eye_blink_left=0.8 if closed else 0.1,
                                 eye_blink_right=0.8 if closed else 0.1))
        result = minute.result(0)
        self.assertEqual(result["metrics"]["eye_closed_ms"], 9000)
        self.assertEqual(result["metrics"]["eye_closed_ratio"], 0.15)
        self.assertTrue(result["metrics"]["prolonged_closure"])
        self.assertEqual(result["metrics"]["ratio_penalty"], 0)

    def test_normal_blinks_and_trailing_long_closure(self):
        def sample(i, value):
            closed = 10 <= i < 12 or i >= 590
            return replace(value, eye_blink_left=0.9 if closed else 0.1,
                           eye_blink_right=0.9 if closed else 0.1)
        result = minute_result(sample)
        self.assertEqual(result["metrics"]["normal_blink_count"], 1)
        self.assertEqual(result["metrics"]["blink_count"], 1)
        self.assertEqual(result["metrics"]["long_closure_count"], 1)
        self.assertEqual(result["score"]["blink"], 80)

    def test_exact_one_second_closure_is_the_long_event_boundary(self):
        for duration, long_events in [(999, 0), (1000, 1)]:
            with self.subTest(duration=duration):
                minute = ScoredMinute(BASELINE)
                times = sorted(set(range(0, 60001, 100)) | {1000 + duration})
                for ms in times:
                    closed = 1000 <= ms < 1000 + duration
                    minute.observe(frame(ms, eye_blink_left=0.8 if closed else 0.1,
                                         eye_blink_right=0.8 if closed else 0.1))
                result = minute.result(0)
                self.assertEqual(result["metrics"]["eye_closed_ms"], duration)
                self.assertEqual(result["metrics"]["long_closure_count"], long_events)
                self.assertEqual(result["score"]["blink"], 100 - 20 * long_events)

    def test_nonfinite_features_are_excluded_but_eye_duration_uses_only_eye_data(self):
        for name in ("gaze_x", "gaze_y", "yaw", "pitch", "roll", "eye_blink_left", "eye_blink_right"):
            for nonfinite in (float("nan"), float("inf"), float("-inf")):
                with self.subTest(field=name, value=nonfinite):
                    def sample(i, value):
                        closed = 10 <= i < 20
                        value = replace(value, eye_blink_left=0.8 if closed else 0.1,
                                        eye_blink_right=0.8 if closed else 0.1)
                        return replace(value, **{name: nonfinite}) if i == 15 else value
                    result = minute_result(sample)
                    self.assertEqual(result["samples"], 599)
                    self.assertEqual(result["metrics"]["invalid_samples"], 1)
                    eye_invalid = name in ("eye_blink_left", "eye_blink_right")
                    self.assertEqual(result["metrics"]["long_closure_count"], 0 if eye_invalid else 1)
                    self.assertEqual(result["metrics"]["eye_closed_ms"], 800 if eye_invalid else 1000)
                    self.assertTrue(all(isinstance(value, (int, float, bool)) for value in result["score"].values()))

    def test_known_closed_eyes_still_score_when_gaze_is_temporarily_unavailable(self):
        def sample(i, value):
            closed = 10 <= i < 106
            return replace(value, gaze_x=None if closed else 0.5,
                           eye_blink_left=0.9 if closed else 0.1,
                           eye_blink_right=0.9 if closed else 0.1)
        result = minute_result(sample)
        self.assertEqual(result["samples"], 504)
        self.assertEqual(result["metrics"]["eye_closed_ms"], 9600)
        self.assertEqual(result["metrics"]["long_closure_count"], 1)
        self.assertEqual(result["metrics"]["ratio_penalty"], 1)
        self.assertEqual(result["score"]["blink"], 79)
        self.assertEqual(result["score"]["total"], 89.5)

    def test_missing_face_does_not_join_closed_intervals(self):
        def sample(i, value):
            return replace(value, eye_blink_left=0.9, eye_blink_right=0.9,
                           face_detected=not (i % 6 == 0))
        result = minute_result(sample)
        self.assertEqual(result["metrics"]["long_closure_count"], 0)
        self.assertTrue(result["metrics"]["unknown_blink_ms"] > 0)

    def test_leading_closed_interval_counts_long_closure_once_and_clamps(self):
        result = minute_result(lambda i, value: replace(value, eye_blink_left=0.8, eye_blink_right=0.8))
        self.assertEqual(result["metrics"]["long_closure_count"], 1)
        self.assertEqual(result["metrics"]["normal_blink_count"], 0)
        self.assertEqual(result["score"]["blink"], 0)

    def test_minimum_valid_samples_and_face_presence(self):
        minute = ScoredMinute(BASELINE)
        for i in range(601):
            minute.observe(frame(i * 100, gaze_x=float("nan") if i < 121 else 0.5))
        with self.assertRaisesRegex(ValueError, "minimum 480"):
            minute.result(0)
        for faces, detected in [(479, False), (480, True)]:
            result = minute_result(lambda i, value: replace(value, face_detected=i < faces))
            self.assertEqual(result["score"]["face_detected"], detected)

    def test_long_gap_resets_closure_and_duplicate_timestamps_fail(self):
        minute = ScoredMinute(BASELINE)
        minute.observe(frame(0, eye_blink_left=0.9, eye_blink_right=0.9))
        minute.observe(frame(5000, eye_blink_left=0.9, eye_blink_right=0.9))
        self.assertEqual(minute.closed_ms, 0)
        self.assertEqual(minute.long_closure_count, 0)
        with self.assertRaisesRegex(ValueError, "increasing"):
            minute.observe(frame(5000))


class CalibrationTests(unittest.TestCase):
    def test_three_seconds_twenty_samples_and_finite_average(self):
        calibration = Calibration()
        for ms in range(0, 3001, 100):
            done = calibration.observe(frame(ms, gaze_x=0.6, yaw=5))
        self.assertTrue(done)
        self.assertEqual(len(calibration.frames), 30)
        self.assertAlmostEqual(calibration.baseline().gaze_x, 0.6)
        self.assertEqual(calibration.baseline().yaw, 5)

    def test_short_or_invalid_calibration_is_rejected(self):
        calibration = Calibration()
        calibration.observe(frame(0))
        with self.assertRaisesRegex(ValueError, "3 seconds"):
            calibration.baseline()
        for ms in range(100, 3001, 100):
            calibration.observe(frame(ms, gaze_x=float("nan")))
        with self.assertRaisesRegex(ValueError, "20 valid"):
            calibration.baseline()
