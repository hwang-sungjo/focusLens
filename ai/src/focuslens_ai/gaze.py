from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol


class Landmark(Protocol):
    x: float
    y: float


@dataclass(frozen=True)
class GazePosition:
    x: float
    y: float


RIGHT_EYE = {
    "corners": (33, 133),
    "vertical": (159, 145),
    "iris": (468, 469, 470, 471, 472),
}
LEFT_EYE = {
    "corners": (362, 263),
    "vertical": (386, 374),
    "iris": (473, 474, 475, 476, 477),
}


def _average_point(landmarks: Sequence[Landmark], indices: tuple[int, ...]) -> GazePosition | None:
    try:
        points = [landmarks[index] for index in indices]
    except IndexError:
        return None
    return GazePosition(
        x=sum(point.x for point in points) / len(points),
        y=sum(point.y for point in points) / len(points),
    )


def _normalize_eye(
    landmarks: Sequence[Landmark], eye: dict[str, tuple[int, ...]]
) -> GazePosition | None:
    iris = _average_point(landmarks, eye["iris"])
    if iris is None:
        return None
    try:
        corner_a, corner_b = (landmarks[index] for index in eye["corners"])
        top, bottom = (landmarks[index] for index in eye["vertical"])
    except IndexError:
        return None

    min_x, max_x = sorted((corner_a.x, corner_b.x))
    min_y, max_y = sorted((top.y, bottom.y))
    if max_x == min_x or max_y == min_y:
        return None
    return GazePosition(
        x=(iris.x - min_x) / (max_x - min_x),
        y=(iris.y - min_y) / (max_y - min_y),
    )


def extract_gaze(landmarks: Sequence[Landmark]) -> GazePosition | None:
    left = _normalize_eye(landmarks, LEFT_EYE)
    right = _normalize_eye(landmarks, RIGHT_EYE)
    if left is None or right is None:
        return None
    return GazePosition(x=(left.x + right.x) / 2, y=(left.y + right.y) / 2)
