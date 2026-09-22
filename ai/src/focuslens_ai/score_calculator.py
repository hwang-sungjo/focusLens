from __future__ import annotations

from .config import WeightConfig


def clamp_score(score: float) -> float:
    return min(100.0, max(0.0, score))


def round_score(score: float) -> float:
    return round(score + 1e-12, 2)


def calculate_total_score(
    gaze: float,
    blink: float,
    head: float,
    weights: WeightConfig | None = None,
) -> float:
    weights = weights or WeightConfig()
    total = (
        clamp_score(gaze) * weights.gaze
        + clamp_score(blink) * weights.blink
        + clamp_score(head) * weights.head
    )
    return round_score(total)
