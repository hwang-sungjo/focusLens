import { useRef, useState, useEffect } from 'react'

function SessionPage() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)

  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sessionStatus, setSessionStatus] = useState<'idle' | 'in_progress' | 'completed'>('idle')
  const [sessionError, setSessionError] = useState('')
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [isCameraVisible, setIsCameraVisible] = useState(true)
  const [latestScore, setLatestScore] = useState<number | null>(null)

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
      const token = localStorage.getItem('access_token')
      const gaze = Math.random() * 100
      const blink = Math.random() * 100
      const head = Math.random() * 100
      const total = (gaze * 0.4 + blink * 0.3 + head * 0.3)

      try {
        const res = await fetch(`http://localhost:3000/api/sessions/${sessionId}/log`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ gaze, blink, head, total }),
        })
        const result = await res.json()
        if (res.ok) {
          setLatestScore(result.data.focus_score)
        }
      } catch (err) {
        console.error('로그 전송 실패:', err)
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
    const token = localStorage.getItem('access_token')

    try {
      const res = await fetch('http://localhost:3000/api/sessions/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      })

      const result = await res.json()

      if (!res.ok) {
        setSessionError(result.error || '세션 시작에 실패했습니다.')
        return
      }

      setSessionId(result.data.session_id)
      setSessionStatus('in_progress')
      setElapsedSeconds(0)
    } catch (err) {
      setSessionError('서버에 연결할 수 없습니다.')
    }
  }

  const handleEndSession = async () => {
    if (!sessionId) return
    setSessionError('')
    const token = localStorage.getItem('access_token')

    try {
      const res = await fetch(`http://localhost:3000/api/sessions/${sessionId}/end`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })

      const result = await res.json()

      if (!res.ok) {
        setSessionError(result.error || '세션 종료에 실패했습니다.')
        return
      }

      setSessionStatus('completed')
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
            {latestScore !== null && (
              <p className="text-sm text-secondary mt-1">
                현재 집중도 점수(임시값): {latestScore.toFixed(1)}점
              </p>
            )}
          </>
        )}

        <div className="mt-4 flex gap-3">
          {sessionStatus === 'idle' && (
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

          {sessionStatus === 'completed' && (
            <p className="text-primary font-medium">세션이 종료되었습니다. 수고하셨어요!</p>
          )}
        </div>
      </div>
    </div>
  )
}

export default SessionPage