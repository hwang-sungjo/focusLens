import { useRef, useState, useEffect } from 'react'
import { apiFetch, readJson, getErrorMessage } from '../api'

interface FocusResult {
  focus_score: number
  attention_state: 'FOCUSED' | 'NORMAL' | 'DISTRACTED'
  gaze: number
  blink: number
  head: number
}

// 화면을 벗어나서 서버에 IN_PROGRESS로 남아 있는 세션
interface PendingSession {
  session_id: string
  started_at: string
}

// ===================== 집중 이탈 알림 설정 (B6 소리, B7 팝업 가이드) =====================
// 숫자나 문구를 바꾸고 싶으면 이 블록만 고치면 된다

const SOUND_STORAGE_KEY = 'focuslens_alert_sound' // 소리 켬/끔을 브라우저에 기억하는 이름
const GUIDE_DISTRACTED_STREAK = 2 // '집중 이탈'이 이 횟수(1분 단위)만큼 연속되면 팝업
const GUIDE_COOLDOWN_MS = 10 * 60 * 1000 // 팝업을 띄운 뒤 이 시간 동안은 다시 띄우지 않음 (10분)
const GUIDE_MESSAGES = [
  '자리에서 일어나 가볍게 스트레칭해 보세요.',
  '물 한 잔 마시고 오면 다시 집중하기 쉬워요.',
  '잠깐 창밖 먼 곳을 바라보며 눈을 쉬게 해 주세요.',
  '천천히 심호흡을 세 번 하고 다시 시작해 볼까요?',
]

// 기획서 6.3절 (3): 집중 이탈 시 작은 소리. 소리 파일 없이 브라우저에서 짧은 '띵' 소리를 만든다
let audioCtx: AudioContext | null = null

// 브라우저는 사용자가 버튼을 누른 순간에만 소리를 허용하므로, 버튼 클릭 때 미리 준비해 둔다
function unlockAlertSound() {
  try {
    audioCtx ??= new AudioContext()
    if (audioCtx.state === 'suspended') void audioCtx.resume()
  } catch {
    // 소리를 지원하지 않는 환경이면 조용히 넘어간다
  }
}

function playAlertSound() {
  if (!audioCtx) return
  const osc = audioCtx.createOscillator()
  const gain = audioCtx.createGain()
  osc.frequency.value = 880 // 높은 '라' 음
  gain.gain.value = 0.05 // 작게 (실제 크기는 기기 볼륨에 따라 다름)
  osc.connect(gain)
  gain.connect(audioCtx.destination)
  osc.start()
  osc.stop(audioCtx.currentTime + 0.15) // 0.15초
}

function readSoundSetting(): boolean {
  try {
    return localStorage.getItem(SOUND_STORAGE_KEY) === 'on' // 기본값: 꺼짐
  } catch {
    return false
  }
}

// 팝업을 띄울지 판단. 연속 이탈 횟수와 마지막으로 띄운 시각을 tracker에 기록한다
// TODO: AI 연동 방식이 정해지면 판정(attention_state)을 받는 위치만 바꾸면 된다. 눈 감지 팝업은 AI 신호가 생기면 추가
interface GuideTracker {
  streak: number
  lastShownAt: number
}

function shouldShowGuide(
  tracker: GuideTracker,
  state: FocusResult['attention_state'],
  now: number,
): boolean {
  tracker.streak = state === 'DISTRACTED' ? tracker.streak + 1 : 0
  if (tracker.streak >= GUIDE_DISTRACTED_STREAK && now - tracker.lastShownAt >= GUIDE_COOLDOWN_MS) {
    tracker.streak = 0
    tracker.lastShownAt = now
    return true
  }
  return false
}
// =========================================================================================

// 진행 중으로 남아 있는 세션이 있는지 서버에 확인 (docs/frontend-api-map.md: 세션 시작 409 처리)
async function fetchInProgressSession(): Promise<PendingSession | null> {
  try {
    const res = await apiFetch('/api/sessions?status=IN_PROGRESS&limit=1')
    const result = await readJson(res)
    if (res.ok && result.data.sessions.length > 0) {
      const s = result.data.sessions[0]
      return { session_id: s.session_id, started_at: s.started_at }
    }
  } catch (err) {
    console.error('진행 중 세션 확인 실패:', err)
  }
  return null
}

function SessionPage() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)

  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sessionStatus, setSessionStatus] = useState<'idle' | 'in_progress' | 'completed'>('idle')
  const [sessionError, setSessionError] = useState('')
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [isCameraVisible, setIsCameraVisible] = useState(true)
  const [latestResult, setLatestResult] = useState<FocusResult | null>(null)
  const [showAlert, setShowAlert] = useState(false)
  const [pendingSession, setPendingSession] = useState<PendingSession | null>(null)
  const [logError, setLogError] = useState('') // 1분 로그 전송 실패 안내 (세션은 계속 진행)
  const [soundOn, setSoundOn] = useState(readSoundSetting)
  const soundOnRef = useRef(soundOn) // 1분 타이머 안에서 최신 켬/끔 값을 읽기 위한 사본
  const [guideMessage, setGuideMessage] = useState<string | null>(null) // 팝업 가이드 문구 (null이면 닫힘)
  const guideTrackerRef = useRef<GuideTracker>({ streak: 0, lastShownAt: 0 })

  useEffect(() => {
    let stream: MediaStream

    const startCamera = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true })
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          setIsStreaming(true)
        }
      } catch (err) {
        console.error('웹캠 접근 에러:', err)
        setError('웹캠 권한이 필요합니다. 브라우저 설정에서 카메라 접근을 허용해주세요.')
      }
    }

    startCamera()

    return () => {
      stream?.getTracks().forEach((track) => track.stop())
    }
  }, [])

  // 페이지에 들어올 때 남아 있는 세션이 있는지 한 번 확인
  useEffect(() => {
    fetchInProgressSession().then((pending) => {
      if (pending) setPendingSession(pending)
    })
  }, [])

  useEffect(() => {
    if (sessionStatus !== 'in_progress') return

    const interval = setInterval(() => {
      setElapsedSeconds((prev) => prev + 1)
    }, 1000)

    return () => clearInterval(interval)
  }, [sessionStatus])

  // MediaPipe 연동 후 더미 값을 실제 gaze/blink/head/total 점수로 교체
  useEffect(() => {
    if (sessionStatus !== 'in_progress' || !sessionId) return

    const sendDummyLog = async () => {
      const round2 = (v: number) => Math.round(v * 100) / 100
      // 개발용: 주소 끝에 ?forceDistracted 를 붙이면 항상 낮은 점수를 보내 알림·팝업을 확인할 수 있다
      // (import.meta.env.DEV는 npm run dev에서만 true → 배포 빌드에서는 동작하지 않음)
      const forceLow =
        import.meta.env.DEV && new URLSearchParams(window.location.search).has('forceDistracted')
      const max = forceLow ? 30 : 100
      const gaze = round2(Math.random() * max)
      const blink = round2(Math.random() * max)
      const head = round2(Math.random() * max)
      const total = round2(gaze * 0.4 + blink * 0.3 + head * 0.3)

      try {
        const res = await apiFetch(`/api/sessions/${sessionId}/log`, {
          method: 'POST',
          body: JSON.stringify({ gaze, blink, head, total, face_detected: true }),
        })
        const result = await readJson(res)
        const time = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
        if (!res.ok) {
          setLogError(`${time} 기록 전송 실패: ${getErrorMessage(res, result, '알 수 없는 오류')}`)
          return
        }
        setLogError('')
        setLatestResult({
          focus_score: result.data.focus_score,
          attention_state: result.data.attention_state,
          gaze,
          blink,
          head,
        })
        const state: FocusResult['attention_state'] = result.data.attention_state
        setShowAlert(state === 'DISTRACTED')

        // B6: 집중 이탈이면 소리 (켜 둔 경우). 진동은 안드로이드에서만 지원돼 제외함
        if (state === 'DISTRACTED' && soundOnRef.current) playAlertSound()

        // B7: 이탈이 연속되면 팝업 가이드
        if (shouldShowGuide(guideTrackerRef.current, state, Date.now())) {
          setGuideMessage(GUIDE_MESSAGES[Math.floor(Math.random() * GUIDE_MESSAGES.length)])
        }
      } catch (err) {
        console.error('로그 전송 실패:', err)
        const time = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
        setLogError(`${time} 기록 전송 실패: 서버에 연결할 수 없습니다.`)
      }
    }

    const logInterval = setInterval(sendDummyLog, 60000)
    return () => clearInterval(logInterval)
  }, [sessionStatus, sessionId])

  const formatTime = (totalSeconds: number) => {
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }

  // 새 세션 시작·이어하기 때: 팝업 기록 초기화, 소리 준비 (버튼 클릭 순간이라 브라우저가 소리를 허용함)
  const resetAlerts = () => {
    guideTrackerRef.current = { streak: 0, lastShownAt: 0 }
    setGuideMessage(null)
    unlockAlertSound()
  }

  // 🔔 버튼: 켬/끔을 바꾸고 브라우저에 기억. 켤 때는 미리 들어 볼 수 있게 한 번 울린다
  const toggleSound = () => {
    const next = !soundOn
    setSoundOn(next)
    soundOnRef.current = next
    try {
      localStorage.setItem(SOUND_STORAGE_KEY, next ? 'on' : 'off')
    } catch {
      // 저장이 막힌 환경이면 이번 화면에서만 적용
    }
    if (next) {
      unlockAlertSound()
      playAlertSound()
    }
  }

  const handleStartSession = async () => {
    setSessionError('')

    try {
      const res = await apiFetch('/api/sessions/start', {
        method: 'POST',
        body: JSON.stringify({}),
      })

      const result = await readJson(res)

      if (res.status === 409) {
        // 다른 탭 등에서 시작된 세션이 남아 있는 경우 → 이어하기/종료 안내를 띄운다
        const pending = await fetchInProgressSession()
        if (pending) setPendingSession(pending)
        setSessionError('이미 진행 중인 세션이 있습니다. 아래에서 이어하거나 종료해 주세요.')
        return
      }

      if (!res.ok) {
        setSessionError(getErrorMessage(res, result, '세션 시작에 실패했습니다.'))
        return
      }

      setSessionId(result.data.session_id)
      setSessionStatus('in_progress')
      setElapsedSeconds(0)
      setLatestResult(null)
      setShowAlert(false)
      setLogError('')
      resetAlerts()
    } catch (err) {
      setSessionError('서버에 연결할 수 없습니다.')
    }
  }

  // 남아 있던 세션을 이어서 진행: 시작 시각 기준으로 타이머를 맞춘다
  const handleResumeSession = () => {
    if (!pendingSession) return
    const elapsed = Math.floor((Date.now() - new Date(pendingSession.started_at).getTime()) / 1000)
    setSessionId(pendingSession.session_id)
    setElapsedSeconds(Math.max(0, elapsed))
    setSessionStatus('in_progress')
    setLatestResult(null)
    setShowAlert(false)
    setSessionError('')
    setLogError('')
    setPendingSession(null)
    resetAlerts()
  }

  // 남아 있던 세션을 종료: 이후 새 세션을 시작할 수 있다
  const handleEndPendingSession = async () => {
    if (!pendingSession) return
    setSessionError('')

    try {
      const res = await apiFetch(`/api/sessions/${pendingSession.session_id}/end`, { method: 'POST' })
      const result = await readJson(res)

      // 409(이미 종료됨)도 남은 세션이 없다는 뜻이므로 정리하고 넘어간다
      if (!res.ok && res.status !== 409) {
        setSessionError(getErrorMessage(res, result, '이전 세션 종료에 실패했습니다.'))
        return
      }

      setPendingSession(null)
      setSessionStatus('idle')
    } catch {
      setSessionError('서버에 연결할 수 없습니다.')
    }
  }

  const handleEndSession = async () => {
    if (!sessionId) return
    setSessionError('')

    try {
      const res = await apiFetch(`/api/sessions/${sessionId}/end`, { method: 'POST' })

      const result = await readJson(res)

      if (!res.ok) {
        setSessionError(getErrorMessage(res, result, '세션 종료에 실패했습니다.'))
        return
      }

      setSessionStatus('completed')
      setShowAlert(false)
      setLogError('')
      setGuideMessage(null)
    } catch (err) {
      setSessionError('서버에 연결할 수 없습니다.')
    }
  }

  const attentionLabel = (state: FocusResult['attention_state']) =>
    state === 'FOCUSED' ? '집중 상태' : state === 'NORMAL' ? '보통' : '집중 이탈'

  const attentionStyle = (state: FocusResult['attention_state']) =>
    state === 'FOCUSED'
      ? 'bg-green-100 text-green-700'
      : state === 'NORMAL'
      ? 'bg-yellow-100 text-yellow-700'
      : 'bg-red-100 text-red-700'

  return (
    <div className="min-h-screen bg-bg p-6">
      <h1 className="text-2xl font-bold text-primary mb-4">학습 세션</h1>

      {error && <p className="text-red-600 text-sm mb-4">{error}</p>}
      {sessionError && <p className="text-red-600 text-sm mb-4">{sessionError}</p>}

      {/* 기획서 6.3절 (3): 좌측 2/3 웹캠, 우측 1/3 실시간 패널. 좁은 화면에서는 위아래로 쌓인다 */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 max-w-6xl">
        {/* 좌측: 웹캠 */}
        <div className="lg:col-span-2 bg-surface rounded-xl shadow-md p-4">
          {/* video는 숨겨도 화면에서 빼지 않는다 (나중에 분석이 연결되면 계속 동작해야 함) */}
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className={`w-full aspect-video rounded-lg bg-black object-cover ${
              isCameraVisible ? '' : 'hidden'
            }`}
          />
          {!isCameraVisible && (
            <div className="w-full aspect-video rounded-lg bg-bg flex items-center justify-center text-sm text-secondary">
              웹캠 화면이 숨겨져 있어요. 세션은 계속 진행됩니다.
            </div>
          )}
          <div className="flex items-center justify-between mt-2">
            <p className="text-sm text-secondary">
              {isStreaming ? '웹캠 연결됨' : '웹캠 연결 대기 중...'}
            </p>
            <button
              onClick={() => setIsCameraVisible((prev) => !prev)}
              className="text-sm text-secondary underline"
            >
              {isCameraVisible ? '웹캠 숨기기' : '웹캠 보이기'}
            </button>
          </div>
        </div>

        {/* 우측: 실시간 집중도 패널 */}
        <div className="bg-surface rounded-xl shadow-md p-5 flex flex-col">
          <div className="flex items-center justify-between">
            <p className="text-sm text-secondary">경과 시간</p>
            <button
              onClick={toggleSound}
              className="text-xs text-secondary border border-accent rounded-full px-3 py-1 hover:bg-bg"
              aria-pressed={soundOn}
            >
              {soundOn ? '🔔 이탈 알림음 켬' : '🔕 이탈 알림음 끔'}
            </button>
          </div>
          <p
            className={`text-3xl font-bold ${
              sessionStatus === 'in_progress' ? 'text-primary' : 'text-gray-300'
            }`}
          >
            {formatTime(sessionStatus === 'in_progress' ? elapsedSeconds : 0)}
          </p>
          {logError && <p className="text-sm text-red-600 mt-1">{logError}</p>}

          <p className="text-sm text-secondary mt-5">집중도</p>
          <div className="flex items-center gap-3">
            <p className="text-5xl font-bold text-primary">
              {sessionStatus === 'in_progress' && latestResult
                ? latestResult.focus_score.toFixed(0)
                : '--'}
            </p>
            {sessionStatus === 'in_progress' && latestResult && (
              <span
                className={`text-sm font-medium px-2 py-1 rounded ${attentionStyle(
                  latestResult.attention_state,
                )}`}
              >
                {attentionLabel(latestResult.attention_state)}
              </span>
            )}
          </div>
          {sessionStatus === 'in_progress' && !latestResult && (
            <p className="text-xs text-secondary mt-1">첫 점수는 세션 시작 1분 뒤에 표시돼요.</p>
          )}

          {/* Gaze/Blink/Head 미니 게이지 */}
          <div className="mt-4 space-y-2">
            {[
              { label: 'Gaze', value: latestResult?.gaze },
              { label: 'Blink', value: latestResult?.blink },
              { label: 'Head', value: latestResult?.head },
            ].map(({ label, value }) => {
              const shown = sessionStatus === 'in_progress' && value !== undefined
              return (
                <div key={label}>
                  <div className="flex justify-between text-xs text-secondary mb-1">
                    <span>{label}</span>
                    <span>{shown ? value.toFixed(0) : '--'}</span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-2">
                    <div
                      className="bg-accent h-2 rounded-full"
                      style={{ width: `${shown ? value : 0}%` }}
                    />
                  </div>
                </div>
              )
            })}
          </div>

          {pendingSession && sessionStatus !== 'in_progress' && (
            <div className="mt-5 rounded-lg border border-accent bg-bg p-4">
              <p className="text-sm text-primary font-medium">
                진행 중인 세션이 있습니다 (
                {new Date(pendingSession.started_at).toLocaleString('ko-KR', {
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                })}{' '}
                시작)
              </p>
              <div className="flex gap-3 mt-3">
                <button
                  onClick={handleResumeSession}
                  className="bg-primary text-white rounded-lg px-4 py-2 hover:bg-secondary transition-colors"
                >
                  이어하기
                </button>
                <button
                  onClick={handleEndPendingSession}
                  className="bg-red-600 text-white rounded-lg px-4 py-2 hover:bg-red-700 transition-colors"
                >
                  종료하기
                </button>
              </div>
            </div>
          )}

          {/* 하단 버튼: 패널 맨 아래에 붙인다 (일시정지는 백엔드 미지원으로 제외) */}
          <div className="mt-auto pt-5">
            {(sessionStatus === 'idle' || sessionStatus === 'completed') && !pendingSession && (
              <button
                onClick={handleStartSession}
                className="w-full bg-primary text-white rounded-lg px-4 py-2 hover:bg-secondary transition-colors"
              >
                세션 시작
              </button>
            )}

            {sessionStatus === 'in_progress' && (
              <button
                onClick={handleEndSession}
                className="w-full bg-red-600 text-white rounded-lg px-4 py-2 hover:bg-red-700 transition-colors"
              >
                세션 종료
              </button>
            )}

            {sessionStatus === 'completed' && (
              <p className="text-primary font-medium mt-2 text-center">
                세션이 종료되었습니다. 수고하셨어요!
              </p>
            )}
          </div>
        </div>
      </div>

      {/* B7: 집중 저하 팝업 가이드 (기획서 2.3절 (5), 4.3절) */}
      {guideMessage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="bg-surface rounded-xl shadow-lg p-6 w-full max-w-sm text-center">
            <p className="text-3xl mb-2">🌿</p>
            <p className="text-lg font-bold text-primary mb-1">잠깐 쉬어 갈까요?</p>
            <p className="text-sm text-secondary mb-1">
              {GUIDE_DISTRACTED_STREAK}분째 집중이 흐트러져 있어요.
            </p>
            <p className="text-sm text-secondary mb-5">{guideMessage}</p>
            <button
              onClick={() => setGuideMessage(null)}
              className="w-full bg-primary text-white rounded-lg px-4 py-2 hover:bg-secondary transition-colors"
            >
              확인
            </button>
          </div>
        </div>
      )}

      {showAlert && (
        <div className="fixed top-20 left-4 right-4 sm:left-auto sm:right-4 sm:w-max sm:whitespace-nowrap bg-red-600 text-white px-4 py-3 rounded-lg shadow-lg z-50">
          ⚠️ 집중이 흐트러졌어요! 자세를 확인해주세요.
        </div>
      )}
    </div>
  )
}

export default SessionPage