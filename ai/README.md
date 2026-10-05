# FocusLens AI

Python과 MediaPipe Face Landmarker로 웹캠 프레임에서 집중도 산정용 feature를 추출하는 독립 실행 프로그램입니다.

## 현재 구현 범위

- OpenCV 웹캠 시작 및 종료
- MediaPipe Face Landmarker 모델 자동 다운로드와 초기화
- 10 FPS frame sampling
- 얼굴 검출 여부
- 양쪽 홍채의 눈 내부 상대 위치(`gaze_x`, `gaze_y`)
- 양쪽 눈 blink blendshape와 단일 프레임 눈 감김 판정
- 얼굴 변환 행렬의 `yaw`, `pitch`, `roll` 변환
- 백엔드와 동일한 total 점수 계산 함수
- 집중도 로그 API 클라이언트
- 얼굴 윤곽·눈·홍채 landmark, gaze/head 방향선, 수치 bar를 표시하는 실시간 디버그 화면
- 프레임별 JSON 출력

아직 구현하지 않은 범위:

- 사용자별 gaze/head calibration
- `OPEN → CLOSED → OPEN` blink event 추적
- 장시간 눈 감김 판정
- 1분 buffer와 `gaze/blink/head` 점수 집계
- 실시간 파이프라인과 API 클라이언트 연결
- 실패 전송 retry queue

## 설치

검증된 실행 버전은 Python 3.11입니다.

```bash
cd ai
python3 -m venv .venv
source .venv/bin/activate
python --version  # Python 3.11.x인지 확인
python -m pip install -e '.[dev]'
```

## 실행

```bash
focuslens-ai
```

첫 실행 때 `models/face_landmarker.task`를 자동으로 내려받습니다. 카메라 화면에서 `q` 또는 `ESC`를 누르면 종료됩니다.

디버그 화면에서는 노란색 화살표가 gaze 방향, 초록색 화살표가 head pose 방향입니다. 오른쪽 패널에서 양쪽 blink 값과 yaw/pitch/roll을 실시간으로 확인할 수 있습니다.

프레임별 측정값을 터미널에서도 확인하려면:

```bash
focuslens-ai --print-values
```

카메라 인덱스가 0이 아닌 환경에서는:

```bash
focuslens-ai --camera 1
```

모듈 명령으로도 실행할 수 있습니다.

```bash
python -m focuslens_ai.main
```

## 테스트

```bash
pytest
```

## 환경변수

- `FOCUSLENS_MODEL_PATH`: Face Landmarker 모델 경로
- `FOCUSLENS_API_BASE_URL`: 추후 API 파이프라인 연결에 사용할 백엔드 주소
- `FOCUSLENS_ACCESS_TOKEN`: 추후 API 파이프라인 연결에 사용할 JWT

토큰이나 실제 환경변수 파일은 Git에 커밋하지 않습니다.
