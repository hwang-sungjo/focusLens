# FocusLens 집중도 로그 생성 모듈 구현 계획

## 1. 구현 범위

이번 구현 범위는 전체 FocusLens 기능 중 다음 파이프라인에 한정한다.

```text
웹캠 영상
  → 얼굴/눈/머리 랜드마크 검출
  → 시선 방향, 눈 깜빡임, 머리 자세 측정
  → 약 1분 동안 값 누적
  → gaze/blink/head 점수를 0~100으로 정규화
  → total 집중도 점수 계산
  → 백엔드에 집중도 로그 전송
```

최종적으로 클라이언트는 1분 단위로 다음 API를 호출한다.

```http
POST /api/sessions/{session_id}/log
Authorization: Bearer {JWT}
Content-Type: application/json
```

```json
{
  "gaze": 85.5,
  "blink": 72.0,
  "head": 90.0,
  "total": 82.8,
  "face_detected": true
}
```

---

# 2. 전체 처리 흐름

```text
Webcam Frame
   ↓
MediaPipe Face Landmarker
   ↓
Frame-level Feature Extraction
   ├─ Gaze
   ├─ Blink / Eye Closure
   ├─ Head Pose
   └─ Face Presence
   ↓
1분 Buffer
   ↓
Minute Aggregation
   ↓
Score Normalization
   ├─ gazeScore   0~100
   ├─ blinkScore  0~100
   └─ headScore   0~100
   ↓
Total Score
   ↓
POST /api/sessions/{session_id}/log
```

---

# 3. MediaPipe 초기화

## 3.1 사용 모듈

브라우저에서 MediaPipe Tasks Vision의 `FaceLandmarker`를 사용한다.

주요 출력:

```text
faceLandmarks
faceBlendshapes
facialTransformationMatrixes
```

각 출력은 다음 용도로 사용한다.

| 출력 | 사용 목적 |
|---|---|
| `faceLandmarks` | 눈/홍채 위치, 얼굴 검출 여부 |
| `faceBlendshapes` | 눈 감김 및 blink 추정 |
| `facialTransformationMatrixes` | yaw / pitch / roll 추정 |

---

# 4. Webcam Frame Sampling

웹캠 자체는 약 30 FPS로 동작하더라도 모든 프레임에 inference를 수행할 필요는 없다.

초기 설정:

```text
Camera FPS: 약 30 FPS
Inference FPS: 약 5~10 FPS
```

권장 초기값:

```text
Inference FPS = 10
```

즉 약 100ms마다 한 번씩 MediaPipe inference를 수행한다.

```text
Webcam 30 FPS
↓
Frame sampling
↓
10 FPS inference
```

1분 동안 약:

```text
10 FPS × 60초 = 600 samples
```

가 생성된다.

---

# 5. Frame-level 데이터 구조

MediaPipe 결과를 다음 내부 데이터 구조로 변환한다.

```typescript
interface FrameMeasurement {
  timestamp: number;

  faceDetected: boolean;

  gazeX?: number;
  gazeY?: number;

  eyeBlinkLeft?: number;
  eyeBlinkRight?: number;
  eyeClosed?: boolean;

  yaw?: number;
  pitch?: number;
  roll?: number;
}
```

얼굴 검출에 실패한 경우에는:

```typescript
{
  timestamp,
  faceDetected: false
}
```

만 기록한다.

---

# 6. 얼굴 검출 여부 측정

MediaPipe가 얼굴 landmark를 반환하면:

```text
faceDetected = true
```

반환하지 않으면:

```text
faceDetected = false
```

로 처리한다.

단일 프레임 검출 실패는 카메라 noise일 수 있으므로
최종 API의 `face_detected`는 1분 단위 통계를 기반으로 판단한다.

예:

```text
1분간 전체 valid inference frame 중
얼굴 검출 비율 >= 0.8
```

이면:

```json
"face_detected": true
```

그보다 낮으면:

```json
"face_detected": false
```

초기 threshold:

```text
FACE_DETECTION_RATIO_THRESHOLD = 0.8
```

---

# 7. Gaze 측정

## 7.1 목적

사용자의 눈이 화면 정면을 향하고 있는지 측정한다.

MediaPipe의 눈/홍채 landmark를 이용하여 눈 내부에서 iris의 상대 위치를 계산한다.

수평 방향:

```text
gazeX =
(irisX - eyeLeftX)
/
(eyeRightX - eyeLeftX)
```

수직 방향:

```text
gazeY =
(irisY - eyeTopY)
/
(eyeBottomY - eyeTopY)
```

정면 응시 시 baseline에 가까운 값이 나온다.

---

# 8. Gaze Calibration

사용자의 눈 형태와 웹캠 위치가 다르기 때문에 세션 시작 전 baseline을 구한다.

약 2~3초 동안 사용자가 화면 중앙을 바라보도록 한다.

수집:

```text
baselineGazeX
baselineGazeY
```

실시간 측정에서는:

```text
deltaX = gazeX - baselineGazeX
deltaY = gazeY - baselineGazeY
```

를 계산한다.

초기 threshold 예:

```text
|deltaX| <= 0.15
|deltaY| <= 0.15
```

이면:

```text
GAZE_ON_SCREEN = true
```

그 외에는:

```text
GAZE_ON_SCREEN = false
```

로 기록한다.

---

# 9. Gaze 1분 누적

각 inference frame마다 다음 값을 저장한다.

```text
1 = 화면 응시
0 = 화면 이탈
```

예:

```text
[1, 1, 1, 0, 1, 1, 0, ...]
```

1분 종료 후:

```text
gazeRatio =
화면 응시 frame 수
/
유효 gaze frame 수
```

를 계산한다.

---

# 10. Gaze Score 정규화

가장 단순한 MVP 방식은 비율을 그대로 0~100으로 변환하는 것이다.

```text
gazeScore = gazeRatio × 100
```

예:

```text
유효 gaze frame = 560
화면 응시 frame = 479

gazeRatio = 479 / 560
          ≈ 0.855

gazeScore = 85.5
```

최종:

```json
"gaze": 85.5
```

---

# 11. Blink 측정

## 11.1 MediaPipe Blendshape 사용

다음 값을 사용한다.

```text
eyeBlinkLeft
eyeBlinkRight
```

초기 threshold:

```text
BLINK_THRESHOLD = 0.6
```

예:

```text
eyeBlinkLeft > 0.6
AND
eyeBlinkRight > 0.6
```

이면:

```text
eyeClosed = true
```

로 판단한다.

---

# 12. Blink 이벤트 검출

단순히 eyeClosed frame 수를 세지 않고,
눈이 닫혔다 다시 열리는 하나의 구간을 blink event로 본다.

```text
OPEN
↓
CLOSED
↓
OPEN
```

이 한 사이클을:

```text
1 Blink
```

로 기록한다.

각 blink event에 대해 duration도 함께 측정한다.

```typescript
interface BlinkEvent {
  startTime: number;
  endTime: number;
  duration: number;
}
```

---

# 13. Blink와 Long Eye Closure 구분

정상 blink와 장시간 눈 감김을 분리한다.

예시 초기값:

```text
Normal Blink:
100ms ~ 500ms

Long Eye Closure:
>= 1000ms
```

1초 이상 눈을 감고 있으면 일반 blink가 아니라
집중 저하 또는 졸음 관련 이벤트로 처리한다.

---

# 14. Blink 1분 누적 Feature

1분 동안 다음 값을 계산한다.

```text
blinkCount
normalBlinkCount
longClosureCount
totalEyeClosedDuration
eyeClosedRatio
```

예:

```text
blinkCount = 18
normalBlinkCount = 17
longClosureCount = 1
eyeClosedRatio = 0.07
```

---

# 15. Blink Score 산정

Blink는 gaze처럼 단순 비율이 높을수록 좋은 지표가 아니므로
초기 MVP에서는 penalty 기반 score로 구현한다.

기본값:

```text
blinkScore = 100
```

장시간 눈 감김에 대해 감점:

```text
longClosure 1회당 -20
```

눈 감김 비율이 지나치게 높으면 추가 감점:

```text
eyeClosedRatio > threshold
→ penalty
```

예:

```text
blinkScore =
100
- longClosurePenalty
- eyeClosedRatioPenalty
```

최종적으로:

```text
0 <= blinkScore <= 100
```

범위로 clamp한다.

예:

```text
longClosureCount = 1
eyeClosedRatio penalty = 8

blinkScore = 100 - 20 - 8
           = 72
```

최종:

```json
"blink": 72.0
```

※ Blink Score 공식과 threshold는 초기 구현 후 테스트 데이터를 기반으로 조정한다.

---

# 16. Head Pose 측정

MediaPipe의:

```text
facialTransformationMatrixes
```

에서 얼굴 rotation을 추출하여 다음 값을 계산한다.

```text
yaw
pitch
roll
```

의미:

```text
yaw   = 좌우 회전
pitch = 위아래 회전
roll  = 좌우 기울기
```

---

# 17. Head Pose Calibration

세션 시작 시 정면 상태의 baseline을 저장한다.

```text
baselineYaw
baselinePitch
baselineRoll
```

실시간 측정값에서 baseline을 뺀다.

```text
deltaYaw   = yaw - baselineYaw
deltaPitch = pitch - baselinePitch
deltaRoll  = roll - baselineRoll
```

---

# 18. Head Forward 판정

초기 threshold 예:

```text
|deltaYaw| <= 20°
|deltaPitch| <= 15°
|deltaRoll| <= 20°
```

모든 조건을 만족하면:

```text
HEAD_FORWARD = true
```

하나라도 크게 벗어나면:

```text
HEAD_FORWARD = false
```

로 기록한다.

---

# 19. Head Score 1분 누적

각 frame마다:

```text
1 = HEAD_FORWARD
0 = HEAD_TURNED
```

로 기록한다.

1분 후:

```text
headRatio =
HEAD_FORWARD frame 수
/
유효 head pose frame 수
```

를 계산한다.

---

# 20. Head Score 정규화

```text
headScore = headRatio × 100
```

예:

```text
유효 frame = 570
HEAD_FORWARD = 513

headScore =
513 / 570 × 100

= 90
```

최종:

```json
"head": 90.0
```

---

# 21. 1분 Buffer 구조

1분 동안 모든 결과를 저장한다.

```typescript
interface MinuteBuffer {
  startedAt: number;

  totalFrames: number;
  faceDetectedFrames: number;

  gazeValidFrames: number;
  gazeOnScreenFrames: number;

  headValidFrames: number;
  headForwardFrames: number;

  blinkEvents: BlinkEvent[];
  totalEyeClosedDuration: number;
  longClosureCount: number;
}
```

매 frame마다 buffer를 update한다.

---

# 22. 1분 종료 조건

다음 조건에서 aggregation을 수행한다.

```text
currentTime - startedAt >= 60,000ms
```

즉:

```text
1 minute
```

이 지나면:

```text
MinuteBuffer
↓
aggregateMinute()
↓
MinuteScore
```

를 생성한다.

---

# 23. Minute Score 데이터 구조

```typescript
interface MinuteScore {
  gaze: number;
  blink: number;
  head: number;
  total: number;
  faceDetected: boolean;
}
```

예:

```typescript
{
  gaze: 85.5,
  blink: 72.0,
  head: 90.0,
  total: 82.8,
  faceDetected: true
}
```

---

# 24. Total 집중도 점수 계산

기획서 초기 가중치를 사용한다.

```text
Gaze  = 0.4
Blink = 0.3
Head  = 0.3
```

공식:

```text
total =
gaze × 0.4
+
blink × 0.3
+
head × 0.3
```

예:

```text
gaze  = 85.5
blink = 72.0
head  = 90.0
```

이면:

```text
total =
85.5 × 0.4
+
72.0 × 0.3
+
90.0 × 0.3
```

```text
= 34.2 + 21.6 + 27
= 82.8
```

최종:

```json
"total": 82.8
```

---

# 25. Score Clamp

모든 점수는 전송 전 다음 범위를 보장한다.

```text
0 <= score <= 100
```

예:

```typescript
function clampScore(score: number) {
  return Math.min(100, Math.max(0, score));
}
```

---

# 26. 최종 API Payload 생성

Aggregation 결과를 다음 형태로 변환한다.

```typescript
const payload = {
  gaze: 85.5,
  blink: 72.0,
  head: 90.0,
  total: 82.8,
  face_detected: true
};
```

---

# 27. Backend API 요청

Endpoint:

```http
POST /api/sessions/{session_id}/log
```

Header:

```http
Authorization: Bearer {JWT}
Content-Type: application/json
```

Body:

```json
{
  "gaze": 85.5,
  "blink": 72.0,
  "head": 90.0,
  "total": 82.8,
  "face_detected": true
}
```

---

# 28. API 호출 구현 예시

```typescript
async function sendFocusLog(
  sessionId: string,
  token: string,
  score: MinuteScore
) {
  const response = await fetch(
    `/api/sessions/${sessionId}/log`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({
        gaze: score.gaze,
        blink: score.blink,
        head: score.head,
        total: score.total,
        face_detected: score.faceDetected,
      }),
    }
  );

  if (!response.ok) {
    throw new Error("Failed to send focus log");
  }
}
```

---

# 29. 전송 성공 후 Buffer Reset

API 전송 성공 여부와 관계없이 다음 1분 측정을 시작할 수 있도록
새 buffer를 생성한다.

```text
Minute 1 Buffer
↓
Score 계산
↓
API 전송
↓
Minute 2 Buffer 시작
```

단, API 전송 실패 시 데이터 유실을 막기 위해
전송 데이터는 별도 retry queue에 보관하는 것이 좋다.

---

# 30. API 실패 처리

네트워크 오류 또는 서버 오류가 발생할 수 있다.

예:

```text
POST 실패
↓
pendingLogs에 저장
↓
다음 전송 시 retry
```

간단한 구조:

```typescript
const pendingLogs: MinuteScore[] = [];
```

전송 실패:

```text
pendingLogs.push(score)
```

다음 API 호출 시 이전 실패 로그부터 재전송한다.

---

# 31. 파일 구조

집중도 측정 부분만 분리하면 다음과 같이 구성할 수 있다.

```text
src/
├── ai/
│   ├── mediapipe.ts
│   ├── featureExtractor.ts
│   ├── calibration.ts
│   ├── gaze.ts
│   ├── blink.ts
│   ├── headPose.ts
│   ├── minuteBuffer.ts
│   └── scoreCalculator.ts
│
├── api/
│   └── focusLogApi.ts
│
├── types/
│   └── focus.ts
│
└── workers/
    └── focus.worker.ts
```

각 파일의 역할:

### `mediapipe.ts`

```text
FaceLandmarker 초기화
frame inference
```

### `featureExtractor.ts`

```text
MediaPipe output
→ FrameMeasurement
```

### `gaze.ts`

```text
iris 위치 계산
gaze delta 계산
screen/away 판단
```

### `blink.ts`

```text
eye blink 값 처리
blink event 검출
long closure 검출
```

### `headPose.ts`

```text
yaw/pitch/roll 계산
정면 여부 판단
```

### `minuteBuffer.ts`

```text
1분 frame 결과 누적
```

### `scoreCalculator.ts`

```text
gaze 0~100
blink 0~100
head 0~100
total 계산
```

### `focusLogApi.ts`

```text
POST /api/sessions/{session_id}/log
```

---

# 32. 구현 순서

## Step 1. MediaPipe 연결

구현:

```text
Webcam
→ FaceLandmarker
→ Landmark 출력
```

완료 조건:

```text
브라우저 console에서
landmark / blendshape / transform matrix 확인
```

---

## Step 2. Frame-level Feature 구현

구현:

```text
faceDetected
gazeX
gazeY
eyeBlinkLeft
eyeBlinkRight
yaw
pitch
roll
```

완료 조건:

```text
웹캠을 움직이거나 눈을 움직였을 때
각 feature 값이 정상적으로 변화
```

---

## Step 3. Calibration 구현

구현:

```text
baselineGaze
baselineYaw
baselinePitch
baselineRoll
```

완료 조건:

```text
정면을 봤을 때 delta 값이 0 근처
```

---

## Step 4. Frame 상태 판정

구현:

```text
GAZE_ON_SCREEN
EYE_CLOSED
LONG_EYE_CLOSURE
HEAD_FORWARD
FACE_DETECTED
```

완료 조건:

```text
테스트 행동에 따라 state가 정상적으로 변경
```

---

## Step 5. 1분 Buffer 구현

구현:

```text
FrameMeasurement
↓
MinuteBuffer
```

완료 조건:

```text
1분 동안 frame 결과가 누적됨
```

개발 중에는 1분 대신:

```text
10초
```

로 설정해 빠르게 테스트한 뒤 최종적으로 60초로 변경한다.

---

## Step 6. Score 계산

구현:

```text
Gaze Score
Blink Score
Head Score
Total Score
```

완료 조건:

```text
모든 값이 0~100 범위
```

---

## Step 7. API 연동

구현:

```text
POST /api/sessions/{session_id}/log
```

완료 조건:

```text
1분마다 backend에 payload가 정상 전달됨
```

---

# 33. 테스트 시나리오

## Case 1 — 정상 집중

행동:

```text
1분 동안 화면 정면 응시
```

예상:

```text
gaze 높음
head 높음
blink 정상
total 높음
```

---

## Case 2 — 시선 이탈

행동:

```text
약 20초 동안 화면 밖을 응시
```

예상:

```text
gaze 감소
head는 비교적 유지 가능
total 감소
```

---

## Case 3 — 고개 돌림

행동:

```text
20초 동안 옆을 바라봄
```

예상:

```text
head 감소
gaze도 일부 감소 가능
```

---

## Case 4 — 눈 감음

행동:

```text
2초 이상 눈을 감는 행동 반복
```

예상:

```text
longClosureCount 증가
blink score 감소
```

---

## Case 5 — 자리 비움

행동:

```text
카메라에서 약 20초 동안 사라짐
```

예상:

```text
face detection ratio 감소
```

얼굴 검출 비율이 threshold 이하이면:

```json
"face_detected": false
```

---

# 34. 개발용 Debug Log

초기 구현에서는 frame-level 값을 console 또는 CSV로 확인할 수 있게 한다.

예:

```text
timestamp
faceDetected
gazeX
gazeY
gazeOnScreen
eyeBlinkLeft
eyeBlinkRight
eyeClosed
yaw
pitch
roll
headForward
```

1분 aggregation 후에는:

```text
gazeRatio
eyeClosedRatio
longClosureCount
headForwardRatio
faceDetectionRatio

gazeScore
blinkScore
headScore
totalScore
```

를 출력한다.

---

# 35. 초기 Configuration

모든 threshold는 별도 config로 관리한다.

```typescript
export const focusConfig = {
  inferenceFps: 10,

  gaze: {
    xThreshold: 0.15,
    yThreshold: 0.15,
  },

  blink: {
    blinkThreshold: 0.6,
    longClosureMs: 1000,
  },

  head: {
    yawThreshold: 20,
    pitchThreshold: 15,
    rollThreshold: 20,
  },

  aggregation: {
    intervalMs: 60_000,
    faceDetectionRatioThreshold: 0.8,
  },

  weights: {
    gaze: 0.4,
    blink: 0.3,
    head: 0.3,
  },
};
```

초기값은 고정된 최종 기준이 아니라
실제 사용자 테스트 후 조정할 수 있도록 파라미터화한다.

---

# 36. MVP 완료 기준

이 모듈은 다음 조건을 모두 만족하면 MVP 구현 완료로 본다.

- 웹캠에서 MediaPipe Face Landmarker가 동작한다.
- 얼굴 검출 여부를 frame 단위로 얻을 수 있다.
- 시선 상태를 frame 단위로 추정할 수 있다.
- 눈 감김 및 장시간 eye closure를 검출할 수 있다.
- yaw / pitch / roll을 이용해 머리 정면 여부를 판단할 수 있다.
- 각 측정값을 약 1분간 누적할 수 있다.
- `gaze` 점수를 0~100으로 계산할 수 있다.
- `blink` 점수를 0~100으로 계산할 수 있다.
- `head` 점수를 0~100으로 계산할 수 있다.
- 세 점수를 이용해 `total`을 계산할 수 있다.
- 얼굴 검출 비율을 기반으로 `face_detected`를 계산할 수 있다.
- JWT를 포함해 `POST /api/sessions/{session_id}/log` 요청을 보낼 수 있다.
- 전송 payload가 아래 schema와 일치한다.

```json
{
  "gaze": 85.5,
  "blink": 72.0,
  "head": 90.0,
  "total": 82.8,
  "face_detected": true
}
```
