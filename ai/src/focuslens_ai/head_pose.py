from __future__ import annotations

from dataclasses import dataclass
from math import atan2, degrees, hypot
from typing import Any

import numpy as np


@dataclass(frozen=True)
class HeadPose:
    yaw: float
    pitch: float
    roll: float


def _as_matrix(value: Any) -> np.ndarray[Any, np.dtype[np.float64]] | None:
    if value is None:
        return None
    raw = getattr(value, "data", value)
    matrix = np.asarray(raw, dtype=np.float64)
    if matrix.ndim == 1:
        rows = int(getattr(value, "rows", 4))
        columns = int(getattr(value, "columns", 4))
        if matrix.size != rows * columns:
            return None
        matrix = matrix.reshape(rows, columns)
    if matrix.ndim != 2 or matrix.shape[0] < 3 or matrix.shape[1] < 3:
        return None
    return matrix


def extract_head_pose(transformation_matrix: Any) -> HeadPose | None:
    matrix = _as_matrix(transformation_matrix)
    if matrix is None:
        return None
    r00, r10, r20 = matrix[0, 0], matrix[1, 0], matrix[2, 0]
    r21, r22 = matrix[2, 1], matrix[2, 2]
    return HeadPose(
        yaw=degrees(atan2(-r20, hypot(r00, r10))),
        pitch=degrees(atan2(r21, r22)),
        roll=degrees(atan2(r10, r00)),
    )
