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
      const gaze = round2(Math.random() * 100)
      const blink = round2(Math.random() * 100)
      const head = round2(Math.random() * 100)
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
        setShowAlert(result.data.attention_state === 'DISTRACTED')
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
    } catch (err) {
      setSessionError('서버에 연결할 수 없습니다.')
    }
  }

  return (
    <div className="min-h-screen bg-bg p-6">
      <h1 className="text-2xl font-bold text-primary mb-4">학습 세션</h1>

      {error && <p className="text-red-600 text-sm mb-4">{error}</p>}
      {sessionError && <p className="text-red-600 text-sm mb-4">{sessionError}</p>}

      <div className="bg-surface rounded-xl shadow-md p-4 max-w-2xl">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={`w-full rounded-lg bg-black ${isCameraVisible ? '' : 'hidden'}`}
        />
        <p className="text-sm text-secondary mt-2">
          {isStreaming ? '웹캠 연결됨' : '웹캠 연결 대기 중...'}
        </p>
        <button
          onClick={() => setIsCameraVisible((prev) => !prev)}
          className="text-sm text-secondary underline mt-1"
        >
          {isCameraVisible ? '웹캠 숨기기' : '웹캠 보이기'}
        </button>

        {sessionStatus === 'in_progress' && (
          <>
            <p className="text-3xl font-bold text-primary mt-3">
              {formatTime(elapsedSeconds)}
            </p>

            {logError && <p className="text-sm text-red-600 mt-1">{logError}</p>}

            {latestResult && (
              <div className="mt-4">
                <div className="flex items-center gap-3">
                  <p className="text-5xl font-bold text-primary">
                    {latestResult.focus_score.toFixed(0)}
                  </p>
                  <span
                    className={`text-sm font-medium px-2 py-1 rounded ${
                      latestResult.attention_state === 'FOCUSED'
                        ? 'bg-green-100 text-green-700'
                        : latestResult.attention_state === 'NORMAL'
                        ? 'bg-yellow-100 text-yellow-700'
                        : 'bg-red-100 text-red-700'
                    }`}
                  >
                    {latestResult.attention_state === 'FOCUSED'
                      ? '집중 상태'
                      : latestResult.attention_state === 'NORMAL'
                      ? '보통'
                      : '집중 이탈'}
                  </span>
                </div>

                <div className="mt-3 space-y-2">
                  {[
                    { label: 'Gaze', value: latestResult.gaze },
                    { label: 'Blink', value: latestResult.blink },
                    { label: 'Head', value: latestResult.head },
                  ].map(({ label, value }) => (
                    <div key={label}>
                      <div className="flex justify-between text-xs text-secondary mb-1">
                        <span>{label}</span>
                        <span>{value.toFixed(0)}</span>
                      </div>
                      <div className="w-full bg-gray-200 rounded-full h-2">
                        <div
                          className="bg-accent h-2 rounded-full"
                          style={{ width: `${value}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {pendingSession && sessionStatus !== 'in_progress' && (
          <div className="mt-4 rounded-lg border border-accent bg-bg p-4">
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

        <div className="mt-4">
          <div className="flex gap-3">
            {(sessionStatus === 'idle' || sessionStatus === 'completed') && !pendingSession && (
              <button
                onClick={handleStartSession}
                className="bg-primary text-white rounded-lg px-4 py-2 hover:bg-secondary transition-colors"
              >
                세션 시작
              </button>
            )}

            {sessionStatus === 'in_progress' && (
              <button
                onClick={handleEndSession}
                className="bg-red-600 text-white rounded-lg px-4 py-2 hover:bg-red-700 transition-colors"
              >
                세션 종료
              </button>
            )}
          </div>

          {sessionStatus === 'completed' && (
            <p className="text-primary font-medium mt-2">
              세션이 종료되었습니다. 수고하셨어요!
            </p>
          )}
        </div>
      </div>

      {showAlert && (
        <div className="fixed top-20 left-4 right-4 sm:left-auto sm:right-4 sm:w-max sm:whitespace-nowrap bg-red-600 text-white px-4 py-3 rounded-lg shadow-lg z-50">
          ⚠️ 집중이 흐트러졌어요! 자세를 확인해주세요.
        </div>
      )}
    </div>
  )
}

export default SessionPage