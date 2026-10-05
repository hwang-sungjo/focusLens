from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class FrameMeasurement:
    timestamp_ms: int
    face_detected: bool
    gaze_x: float | None = None
    gaze_y: float | None = None
    eye_blink_left: float | None = None
    eye_blink_right: float | None = None
    eye_closed: bool | None = None
    yaw: float | None = None
    pitch: float | None = None
    roll: float | None = None

    def to_dict(self) -> dict[str, int | float | bool | None]:
        return asdict(self)


@dataclass(frozen=True)
class CalibrationBaseline:
    gaze_x: float
    gaze_y: float
    yaw: float
    pitch: float
    roll: float


@dataclass(frozen=True)
class BlinkEvent:
    start_time_ms: int
    end_time_ms: int

    @property
    def duration_ms(self) -> int:
        return self.end_time_ms - self.start_time_ms


@dataclass(frozen=True)
class MinuteScore:
    gaze: float
    blink: float
    head: float
    total: float
    face_detected: bool


@dataclass(frozen=True)
class FocusLogPayload:
    gaze: float
    blink: float
    head: float
    total: float
    face_detected: bool

    def to_dict(self) -> dict[str, float | bool]:
        return asdict(self)
