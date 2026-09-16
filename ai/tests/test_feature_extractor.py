from dataclasses import dataclass
from types import SimpleNamespace

from focuslens_ai.feature_extractor import extract_frame_measurement


@dataclass
class Landmark:
    x: float = 0.5
    y: float = 0.5


def test_missing_face_returns_presence_only() -> None:
    result = SimpleNamespace(
        face_landmarks=[],
        face_blendshapes=[],
        facial_transformation_matrixes=[],
    )
    measurement = extract_frame_measurement(result, 1_000)
    assert measurement.timestamp_ms == 1_000
    assert measurement.face_detected is False
    assert measurement.gaze_x is None


def test_both_blink_scores_above_threshold_mean_closed() -> None:
    landmarks = [Landmark() for _ in range(478)]
    landmarks[33].x, landmarks[133].x = 0.4, 0.6
    landmarks[159].y, landmarks[145].y = 0.4, 0.6
    landmarks[362].x, landmarks[263].x = 0.4, 0.6
    landmarks[386].y, landmarks[374].y = 0.4, 0.6
    result = SimpleNamespace(
        face_landmarks=[landmarks],
        face_blendshapes=[
            [
                SimpleNamespace(category_name="eyeBlinkLeft", score=0.8),
                SimpleNamespace(category_name="eyeBlinkRight", score=0.7),
            ]
        ],
        facial_transformation_matrixes=[],
    )

    measurement = extract_frame_measurement(result, 2_000)
    assert measurement.face_detected is True
    assert measurement.eye_closed is True
    assert measurement.gaze_x == 0.5
    assert measurement.gaze_y == 0.5
