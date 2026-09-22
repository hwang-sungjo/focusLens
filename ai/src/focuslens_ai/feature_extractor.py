from __future__ import annotations

from typing import Any

from .config import BlinkConfig
from .gaze import extract_gaze
from .head_pose import extract_head_pose
from .models import FrameMeasurement


def _blendshape_score(result: Any, category_name: str) -> float | None:
    if not result.face_blendshapes:
        return None
    for category in result.face_blendshapes[0]:
        if category.category_name == category_name:
            return float(category.score)
    return None


def extract_frame_measurement(
    result: Any,
    timestamp_ms: int,
    blink_config: BlinkConfig | None = None,
) -> FrameMeasurement:
    if not result.face_landmarks:
        return FrameMeasurement(timestamp_ms=timestamp_ms, face_detected=False)

    blink_config = blink_config or BlinkConfig()
    landmarks = result.face_landmarks[0]
    gaze = extract_gaze(landmarks)
    matrix = result.facial_transformation_matrixes[0] if result.facial_transformation_matrixes else None
    head_pose = extract_head_pose(matrix)
    eye_blink_left = _blendshape_score(result, "eyeBlinkLeft")
    eye_blink_right = _blendshape_score(result, "eyeBlinkRight")
    eye_closed = None
    if eye_blink_left is not None and eye_blink_right is not None:
        eye_closed = (
            eye_blink_left > blink_config.blink_threshold
            and eye_blink_right > blink_config.blink_threshold
        )

    return FrameMeasurement(
        timestamp_ms=timestamp_ms,
        face_detected=True,
        gaze_x=gaze.x if gaze else None,
        gaze_y=gaze.y if gaze else None,
        eye_blink_left=eye_blink_left,
        eye_blink_right=eye_blink_right,
        eye_closed=eye_closed,
        yaw=head_pose.yaw if head_pose else None,
        pitch=head_pose.pitch if head_pose else None,
        roll=head_pose.roll if head_pose else None,
    )
