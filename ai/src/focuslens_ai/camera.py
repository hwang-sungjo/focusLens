from __future__ import annotations

from collections.abc import Callable
from time import monotonic, sleep

import cv2

from .config import FocusConfig
from .feature_extractor import extract_frame_measurement
from .mediapipe_runner import FaceLandmarkerRunner
from .models import FrameMeasurement
from .visualization import render_debug_frame


MeasurementCallback = Callable[[FrameMeasurement], None]


class WebcamPipeline:
    def __init__(
        self,
        runner: FaceLandmarkerRunner,
        config: FocusConfig,
        camera_index: int = 0,
        preview: bool = True,
    ) -> None:
        self._runner = runner
        self._config = config
        self._camera_index = camera_index
        self._preview = preview
        self._running = False

    def run(self, on_measurement: MeasurementCallback) -> None:
        camera = cv2.VideoCapture(self._camera_index)
        camera.set(cv2.CAP_PROP_FRAME_WIDTH, self._config.camera_width)
        camera.set(cv2.CAP_PROP_FRAME_HEIGHT, self._config.camera_height)
        if not camera.isOpened():
            camera.release()
            raise RuntimeError(f"카메라 {self._camera_index}번을 열 수 없습니다.")

        self._running = True
        last_inference_at = 0.0
        interval_seconds = 1 / self._config.inference_fps
        latest: FrameMeasurement | None = None
        latest_result: object | None = None
        try:
            while self._running:
                success, frame = camera.read()
                if not success:
                    raise RuntimeError("웹캠 프레임을 읽지 못했습니다.")

                now = monotonic()
                if now - last_inference_at >= interval_seconds:
                    timestamp_ms = int(now * 1_000)
                    latest_result = self._runner.detect(frame, timestamp_ms)
                    latest = extract_frame_measurement(latest_result, timestamp_ms, self._config.blink)
                    on_measurement(latest)
                    last_inference_at = now

                if self._preview:
                    debug_frame = render_debug_frame(
                        frame,
                        latest_result,
                        latest,
                        self._config.inference_fps,
                    )
                    cv2.imshow("FocusLens AI - q/ESC to quit", debug_frame)
                    if cv2.waitKey(1) & 0xFF in (ord("q"), 27):
                        self.stop()
                else:
                    sleep(0.001)
        finally:
            camera.release()
            if self._preview:
                cv2.destroyAllWindows()

    def stop(self) -> None:
        self._running = False
