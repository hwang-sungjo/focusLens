from __future__ import annotations

import argparse
from dataclasses import replace
import json
import os
from pathlib import Path

from .camera import WebcamPipeline
from .config import DEFAULT_CONFIG
from .mediapipe_runner import FaceLandmarkerRunner
from .model_store import ensure_model
from .models import FrameMeasurement


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="FocusLens 웹캠 feature 측정 도구")
    parser.add_argument("--camera", type=int, default=0, help="OpenCV 카메라 인덱스")
    parser.add_argument(
        "--model",
        type=Path,
        default=Path(os.getenv("FOCUSLENS_MODEL_PATH", str(DEFAULT_CONFIG.model_path))),
        help="Face Landmarker .task 모델 경로",
    )
    parser.add_argument("--no-preview", action="store_true", help="OpenCV 미리보기 창을 끕니다")
    parser.add_argument("--print-values", action="store_true", help="프레임 측정값을 JSON으로 출력합니다")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    model_path = ensure_model(args.model)
    config = replace(DEFAULT_CONFIG, model_path=model_path)

    def handle_measurement(measurement: FrameMeasurement) -> None:
        if args.print_values:
            print(json.dumps(measurement.to_dict(), ensure_ascii=False), flush=True)

    print(f"모델: {model_path}")
    print("카메라를 시작합니다. 종료하려면 미리보기 창에서 q 또는 ESC를 누르세요.")
    with FaceLandmarkerRunner(model_path) as runner:
        pipeline = WebcamPipeline(
            runner=runner,
            config=config,
            camera_index=args.camera,
            preview=not args.no_preview,
        )
        try:
            pipeline.run(handle_measurement)
        except KeyboardInterrupt:
            pipeline.stop()


if __name__ == "__main__":
    main()
