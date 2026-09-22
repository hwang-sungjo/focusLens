from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/"
    "face_landmarker/float16/latest/face_landmarker.task"
)


@dataclass(frozen=True)
class GazeConfig:
    x_threshold: float = 0.15
    y_threshold: float = 0.15


@dataclass(frozen=True)
class BlinkConfig:
    blink_threshold: float = 0.6
    normal_min_ms: int = 100
    normal_max_ms: int = 500
    long_closure_ms: int = 1_000


@dataclass(frozen=True)
class HeadConfig:
    yaw_threshold: float = 20.0
    pitch_threshold: float = 15.0
    roll_threshold: float = 20.0


@dataclass(frozen=True)
class AggregationConfig:
    interval_ms: int = 60_000
    face_detection_ratio_threshold: float = 0.8


@dataclass(frozen=True)
class WeightConfig:
    gaze: float = 0.4
    blink: float = 0.3
    head: float = 0.3


@dataclass(frozen=True)
class FocusConfig:
    inference_fps: int = 10
    camera_width: int = 1_280
    camera_height: int = 720
    model_path: Path = Path("models/face_landmarker.task")
    gaze: GazeConfig = field(default_factory=GazeConfig)
    blink: BlinkConfig = field(default_factory=BlinkConfig)
    head: HeadConfig = field(default_factory=HeadConfig)
    aggregation: AggregationConfig = field(default_factory=AggregationConfig)
    weights: WeightConfig = field(default_factory=WeightConfig)


DEFAULT_CONFIG = FocusConfig()
