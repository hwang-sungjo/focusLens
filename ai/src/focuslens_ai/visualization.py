from __future__ import annotations

from typing import Any

import cv2
from mediapipe.tasks.python.vision import FaceLandmarksConnections
import numpy as np

from .models import FrameMeasurement


PANEL_WIDTH = 340
BACKGROUND = (24, 31, 27)
TEXT = (225, 235, 229)
MUTED = (142, 157, 148)
GREEN = (89, 210, 143)
YELLOW = (76, 190, 238)
RED = (91, 91, 238)
TRACK = (54, 66, 59)


def render_debug_frame(
    frame: np.ndarray[Any, Any],
    result: Any | None,
    measurement: FrameMeasurement | None,
    inference_fps: int,
) -> np.ndarray[Any, Any]:
    """카메라 영상과 실시간 feature 패널을 하나의 OpenCV 화면으로 만든다."""
    camera_view = cv2.flip(frame, 1)
    if result is not None and getattr(result, "face_landmarks", None):
        _draw_face_landmarks(camera_view, result.face_landmarks[0])
        _draw_direction_vectors(camera_view, result.face_landmarks[0], measurement)

    panel = np.full((camera_view.shape[0], PANEL_WIDTH, 3), BACKGROUND, dtype=np.uint8)
    _draw_panel(panel, measurement, inference_fps)
    return np.hstack((camera_view, panel))


def _draw_face_landmarks(image: np.ndarray[Any, Any], landmarks: list[Any]) -> None:
    contours = FaceLandmarksConnections.FACE_LANDMARKS_CONTOURS
    irises = (
        FaceLandmarksConnections.FACE_LANDMARKS_LEFT_IRIS
        + FaceLandmarksConnections.FACE_LANDMARKS_RIGHT_IRIS
    )
    _draw_connections(image, landmarks, contours, (115, 216, 164), 1)
    _draw_connections(image, landmarks, irises, (75, 190, 245), 2)


def _draw_connections(
    image: np.ndarray[Any, Any],
    landmarks: list[Any],
    connections: list[Any],
    color: tuple[int, int, int],
    thickness: int,
) -> None:
    height, width = image.shape[:2]
    for connection in connections:
        if connection.start >= len(landmarks) or connection.end >= len(landmarks):
            continue
        start = landmarks[connection.start]
        end = landmarks[connection.end]
        start_point = (int((1 - start.x) * width), int(start.y * height))
        end_point = (int((1 - end.x) * width), int(end.y * height))
        cv2.line(image, start_point, end_point, color, thickness, cv2.LINE_AA)


def _draw_direction_vectors(
    image: np.ndarray[Any, Any],
    landmarks: list[Any],
    measurement: FrameMeasurement | None,
) -> None:
    if measurement is None or len(landmarks) <= 168:
        return
    height, width = image.shape[:2]
    anchor = landmarks[168]
    origin = (int((1 - anchor.x) * width), int(anchor.y * height))

    if measurement.gaze_x is not None and measurement.gaze_y is not None:
        gaze_end = (
            int(origin[0] - (measurement.gaze_x - 0.5) * 150),
            int(origin[1] + (measurement.gaze_y - 0.5) * 150),
        )
        cv2.arrowedLine(image, origin, gaze_end, YELLOW, 2, cv2.LINE_AA, tipLength=0.2)

    if measurement.yaw is not None and measurement.pitch is not None:
        head_end = (
            int(origin[0] - measurement.yaw / 45 * 90),
            int(origin[1] + measurement.pitch / 45 * 90),
        )
        cv2.arrowedLine(image, origin, head_end, GREEN, 3, cv2.LINE_AA, tipLength=0.2)


def _draw_panel(
    panel: np.ndarray[Any, Any],
    measurement: FrameMeasurement | None,
    inference_fps: int,
) -> None:
    _text(panel, "FOCUSLENS LIVE", 24, 38, TEXT, 0.72, 2)
    _text(panel, f"INFERENCE  {inference_fps} FPS", 24, 64, MUTED, 0.42, 1)
    cv2.line(panel, (24, 82), (PANEL_WIDTH - 24, 82), TRACK, 1)

    if measurement is None:
        _text(panel, "Preparing model output...", 24, 120, MUTED, 0.48, 1)
        return

    detected_color = GREEN if measurement.face_detected else RED
    detected_text = "DETECTED" if measurement.face_detected else "NOT DETECTED"
    cv2.circle(panel, (31, 112), 7, detected_color, -1, cv2.LINE_AA)
    _text(panel, f"FACE  {detected_text}", 48, 118, detected_color, 0.52, 2)

    _draw_bar(panel, 24, 158, "GAZE X", measurement.gaze_x, 0.0, 1.0, YELLOW)
    _draw_bar(panel, 24, 213, "GAZE Y", measurement.gaze_y, 0.0, 1.0, YELLOW)
    _draw_bar(panel, 24, 268, "BLINK LEFT", measurement.eye_blink_left, 0.0, 1.0, GREEN)
    _draw_bar(panel, 24, 323, "BLINK RIGHT", measurement.eye_blink_right, 0.0, 1.0, GREEN)

    eye_color = RED if measurement.eye_closed else GREEN
    eye_text = "CLOSED" if measurement.eye_closed else "OPEN"
    _text(panel, f"EYES  {eye_text}", 24, 374, eye_color, 0.52, 2)

    _draw_centered_bar(panel, 24, 414, "YAW", measurement.yaw, 45.0, GREEN)
    _draw_centered_bar(panel, 24, 469, "PITCH", measurement.pitch, 45.0, GREEN)
    _draw_centered_bar(panel, 24, 524, "ROLL", measurement.roll, 45.0, GREEN)

    if panel.shape[0] >= 620:
        _text(panel, "Yellow arrow: gaze", 24, panel.shape[0] - 54, MUTED, 0.4, 1)
        _text(panel, "Green arrow: head pose", 24, panel.shape[0] - 30, MUTED, 0.4, 1)


def _draw_bar(
    image: np.ndarray[Any, Any],
    x: int,
    y: int,
    label: str,
    value: float | None,
    minimum: float,
    maximum: float,
    color: tuple[int, int, int],
) -> None:
    width = PANEL_WIDTH - x - 24
    shown = "--" if value is None else f"{value:.3f}"
    _text(image, f"{label}  {shown}", x, y, TEXT, 0.45, 1)
    top = y + 12
    cv2.rectangle(image, (x, top), (x + width, top + 10), TRACK, -1)
    if value is not None:
        ratio = min(1.0, max(0.0, (value - minimum) / (maximum - minimum)))
        cv2.rectangle(image, (x, top), (x + int(width * ratio), top + 10), color, -1)


def _draw_centered_bar(
    image: np.ndarray[Any, Any],
    x: int,
    y: int,
    label: str,
    value: float | None,
    limit: float,
    color: tuple[int, int, int],
) -> None:
    width = PANEL_WIDTH - x - 24
    shown = "--" if value is None else f"{value:+.1f} deg"
    _text(image, f"{label}  {shown}", x, y, TEXT, 0.45, 1)
    top = y + 12
    center = x + width // 2
    cv2.rectangle(image, (x, top), (x + width, top + 10), TRACK, -1)
    cv2.line(image, (center, top - 3), (center, top + 13), MUTED, 1)
    if value is not None:
        endpoint = center + int(min(1.0, abs(value) / limit) * width / 2 * (1 if value >= 0 else -1))
        cv2.rectangle(image, (min(center, endpoint), top), (max(center, endpoint), top + 10), color, -1)


def _text(
    image: np.ndarray[Any, Any],
    text: str,
    x: int,
    y: int,
    color: tuple[int, int, int],
    scale: float,
    thickness: int,
) -> None:
    cv2.putText(image, text, (x, y), cv2.FONT_HERSHEY_SIMPLEX, scale, color, thickness, cv2.LINE_AA)
