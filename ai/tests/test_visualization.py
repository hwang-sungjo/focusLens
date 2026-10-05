from types import SimpleNamespace

import numpy as np

from focuslens_ai.models import FrameMeasurement
from focuslens_ai.visualization import PANEL_WIDTH, render_debug_frame


def test_render_debug_frame_appends_side_panel() -> None:
    frame = np.zeros((640, 800, 3), dtype=np.uint8)
    result = SimpleNamespace(face_landmarks=[])
    measurement = FrameMeasurement(timestamp_ms=1_000, face_detected=False)

    rendered = render_debug_frame(frame, result, measurement, inference_fps=10)

    assert rendered.shape == (640, 800 + PANEL_WIDTH, 3)
