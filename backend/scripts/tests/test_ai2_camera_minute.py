import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ai2_camera_minute import CameraMinute
from focuslens_ai.models import FrameMeasurement


def make_window(samples, faces):
    minute = CameraMinute()
    for i in range(samples):
        minute.observe(FrameMeasurement(1000 + i * 60000 // samples, i < faces))
    return minute


class CameraMinuteTests(unittest.TestCase):
    def test_minimum_samples_and_boundary(self):
        minute = make_window(480, 383)
        with self.assertRaisesRegex(ValueError, "full minute"):
            minute.result(0)
        self.assertTrue(minute.observe(FrameMeasurement(61007, True)))
        result = minute.result(0)
        self.assertEqual((result["samples"], result["face_samples"]), (480, 383))
        self.assertEqual(result["measured_at"], "1970-01-01T00:01:01.000Z")
        self.assertEqual(result["score"], dict(gaze=0, blink=0, head=0, total=0, face_detected=False))

    def test_sparse_input_and_eighty_percent_do_not_produce_absence_score(self):
        for samples, faces, reason in [(479, 0, "minimum 480"), (480, 384, "absence score")]:
            with self.subTest(samples=samples, faces=faces):
                minute = make_window(samples, faces)
                minute.observe(FrameMeasurement(61000, False))
                with self.assertRaisesRegex(ValueError, reason):
                    minute.result(0)

    def test_duplicate_frame_is_rejected(self):
        minute = make_window(1, 0)
        with self.assertRaisesRegex(ValueError, "increasing"):
            minute.observe(FrameMeasurement(1000, False))
