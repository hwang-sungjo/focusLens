import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch, readJson } from '../api'
import { aiErrorText, controlAi, getAiPreview, getAiStatus } from '../localAi'
import type { AiAction, AiStatus, MinuteScore } from '../localAi'

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
// Keep the development alert preview independent of the measured scores and stored logs.
function alertState(state: MinuteScore['attention_state']) {
  return import.meta.env.DEV && new URLSearchParams(window.location.search).has('forceDistracted')
    ? 'DISTRACTED' : state
}
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
interface GuideTracker {
  streak: number
  lastShownAt: number
}

function shouldShowGuide(
  tracker: GuideTracker,
  state: MinuteScore['attention_state'],
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

// 미리보기는 Python이 측정 중인 카메라의 같은 프레임을 사용한다.
function CameraPreview() {
  const [source, setSource] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    let url = ''
    async function update() {
      let frame: Blob | null = null
      try {
        frame = await getAiPreview(AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]))
      } catch {
        // 다음 프레임은 다시 요청한다. 연결 상태·권한 오류는 상태 패널에 표시한다.
      }
      if (controller.signal.aborted) return
      const previous = url
      url = frame ? URL.createObjectURL(frame) : ''
      setSource(url)
      if (previous) URL.revokeObjectURL(previous)
      timer = setTimeout(update, frame ? 250 : 750)
    }
    void update()
    return () => {
      controller.abort()
      clearTimeout(timer)
      if (url) URL.revokeObjectURL(url)
    }
  }, [])
  return source
    ? <img src={source} alt="웹캠 미리보기" className="w-full aspect-video object-cover rounded-lg" />
    : <div className="w-full aspect-video rounded-lg bg-bg grid place-items-center text-sm text-secondary">카메라 연결 중...</div>
}

function SessionPage() {
  const [status, setStatus] = useState<AiStatus | null>(null)
  const observed = useRef<AiStatus | null>(null)
  const [serverSession, setServerSession] = useState<PendingSession | null>(null)
  const [bridgeError, setBridgeError] = useState('')
  const [actionError, setActionError] = useState('')
  const [busy, setBusy] = useState<AiAction | null>(null)
  const commandInFlight = useRef(false)
  const version = useRef(0)
  const [refresh, setRefresh] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [isCameraVisible, setIsCameraVisible] = useState(true)
  const [soundOn, setSoundOn] = useState(readSoundSetting)
  const soundOnRef = useRef(soundOn)
  const [guideMessage, setGuideMessage] = useState<string | null>(null)
  const guideTrackerRef = useRef<GuideTracker>({ streak: 0, lastShownAt: 0 })

  const applyStatus = useCallback((next: AiStatus) => {
    const previous = observed.current
    observed.current = next
    setStatus(next)
    setBridgeError('')
    if (previous && previous.phase !== next.phase) setActionError('')
    const latest = next.latest
    if (previous?.session_id !== next.session_id || next.phase === 'ended') {
      guideTrackerRef.current = { streak: 0, lastShownAt: 0 }
      setGuideMessage(null)
    } else if (latest && next.phase === 'measuring' && latest.client_log_id !== previous?.latest?.client_log_id) {
      if (previous?.latest && Date.parse(latest.measured_at) - Date.parse(previous.latest.measured_at) > 65_000) {
        guideTrackerRef.current.streak = 0
      }
      const state = alertState(latest.attention_state)
      if (state === 'DISTRACTED' && soundOnRef.current) playAlertSound()
      if (shouldShowGuide(guideTrackerRef.current, state, Date.now())) {
        setGuideMessage(GUIDE_MESSAGES[Math.floor(Math.random() * GUIDE_MESSAGES.length)])
      }
    }
  }, [])

  // 다음 요청은 이전 요청이 끝난 뒤 보낸다. 버튼을 누르기 전의 늦은 응답은 버린다.
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      const requestVersion = version.current
      const current = () => !controller.signal.aborted && requestVersion === version.current && !commandInFlight.current
      let delay = 1200
      try {
        const next = await getAiStatus(AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]))
        if (current()) applyStatus(next)
      } catch (error) {
        delay = 3500
        if (current()) setBridgeError(error instanceof Error ? error.message : '로컬 AI에 연결할 수 없습니다.')
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, delay)
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [applyStatus, refresh])

  const phase = status?.phase ?? 'idle'
  const checkServerSession = phase === 'idle' || phase === 'starting' || phase === 'ended'
  // 다른 도구의 진행 세션과 응답이 유실된 시작 요청을 식별한다. 변경 권한은 AI가 확인한다.
  useEffect(() => {
    if (!checkServerSession) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function query() {
      try {
        const res = await apiFetch('/api/sessions?status=IN_PROGRESS&limit=1', { signal: controller.signal })
        const result = await readJson(res)
        if (res.ok && !controller.signal.aborted) setServerSession(result.data.sessions[0] ?? null)
      } catch {
        // 세션 소유·기록 상태를 확인하지 못해도 브라우저가 직접 종료하지 않는다.
      }
      if (!controller.signal.aborted) timer = setTimeout(query, 12_000)
    }
    void query()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [refresh, checkServerSession])

  useEffect(() => {
    const currentUser = localStorage.getItem('user_id')
    function onStorage() {
      if (localStorage.getItem('user_id') !== currentUser) window.location.reload()
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const measuring = phase === 'measuring'
  const sessionStatus = phase === 'ended' ? 'completed' : measuring || phase === 'closing' ? 'in_progress' : 'idle'
  const latestResult = status?.latest
  const showAlert = measuring && latestResult && alertState(latestResult.attention_state) === 'DISTRACTED'
  const uncertainStart = phase === 'starting' && !!status?.error
  const pendingSession = phase === 'paused' && status?.session_id && status.started_at
    ? { session_id: status.session_id, started_at: status.started_at }
    : uncertainStart ? serverSession : null
  const externalSession = serverSession && (phase === 'idle' || phase === 'ended') &&
    serverSession.session_id !== status?.session_id
  const elapsedSeconds = status?.started_at
    ? Math.max(0, Math.floor((now - Date.parse(status.started_at)) / 1000)) : 0
  const statusMessage = actionError || bridgeError || (status?.error ? aiErrorText(status.error) : '')

  useEffect(() => {
    if (sessionStatus !== 'in_progress') return
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [sessionStatus])

  const formatTime = (totalSeconds: number) => {
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }

  async function act(action: AiAction, id: string | null = null) {
    if (commandInFlight.current) return
    commandInFlight.current = true
    version.current++
    setBusy(action)
    setActionError('')
    if (action !== 'finish') unlockAlertSound()
    try {
      const next = await controlAi(action, id)
      applyStatus(next)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '로컬 AI 요청에 실패했습니다.')
    } finally {
      version.current++
      commandInFlight.current = false
      setBusy(null)
      setRefresh(n => n + 1)
    }
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

  const attentionLabel = (state: MinuteScore['attention_state']) =>
    state === 'FOCUSED' ? '집중 상태' : state === 'NORMAL' ? '보통' : '집중 이탈'

  const attentionStyle = (state: MinuteScore['attention_state']) =>
    state === 'FOCUSED'
      ? 'bg-green-100 text-green-700'
      : state === 'NORMAL'
      ? 'bg-yellow-100 text-yellow-700'
      : 'bg-red-100 text-red-700'

  return (
    <div className="min-h-screen bg-bg p-6">
      <h1 className="text-2xl font-bold text-primary mb-4">학습 세션</h1>

      {statusMessage && <p role="status" className="text-red-600 text-sm mb-4">{statusMessage}</p>}
      {externalSession && (
        <p className="text-sm text-secondary mb-4">진행 중인 세션이 있습니다. 측정을 시작한 도구에서 상태를 확인해 주세요.</p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 max-w-6xl">
        <div className="lg:col-span-2 bg-surface rounded-xl shadow-md p-4">
          {isCameraVisible && measuring && !bridgeError
            ? <CameraPreview key={status?.session_id} />
            : <div className="w-full aspect-video rounded-lg bg-bg flex items-center justify-center text-sm text-secondary">
                {!isCameraVisible
                  ? (measuring ? '웹캠 화면이 숨겨져 있어요. 세션은 계속 진행됩니다.' : '웹캠 화면이 숨겨져 있어요.')
                  : measuring ? '미리보기 연결을 기다리고 있습니다.' : '측정을 시작하면 이 컴퓨터의 카메라가 켜집니다.'}
              </div>}
          <div className="flex items-center justify-between mt-2">
            <p className="text-sm text-secondary">
              {measuring ? (status?.stage === 'calibrating' ? '보정 중 · 처음 3초 동안 화면 중앙을 바라봐 주세요.' : 'AI 측정 중')
                : phase === 'closing' ? '기록 전송 및 종료 확인 중' : '웹캠 연결 대기 중...'}
            </p>
            <button onClick={() => setIsCameraVisible(prev => !prev)}
              aria-pressed={isCameraVisible} className="text-sm text-secondary underline">
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
          {(status?.pending || status?.failed) ? (
            <p className="text-sm text-secondary mt-1">전송 대기 {status?.pending}건 · 전송 실패 {status?.failed}건</p>
          ) : null}

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
            <p className="text-xs text-secondary mt-1">
              첫 점수는 카메라 보정 후 1분을 측정하면 표시돼요.
              1분 이하 측정 시에는 점수가 표시되지 않습니다.
            </p>
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
                  disabled={!!busy}
                  onClick={() => void act('resume', pendingSession.session_id)}
                  className="bg-primary text-white rounded-lg px-4 py-2 hover:bg-secondary transition-colors"
                >
                  이어하기
                </button>
                <button
                  disabled={!!busy}
                  onClick={() => void act('finish', pendingSession.session_id)}
                  className="bg-red-600 text-white rounded-lg px-4 py-2 hover:bg-red-700 transition-colors"
                >
                  종료하기
                </button>
              </div>
            </div>
          )}

          {/* 하단 버튼: 패널 맨 아래에 붙인다 (일시정지는 백엔드 미지원으로 제외) */}
          <div className="mt-auto pt-5">
            {(phase === 'idle' || phase === 'ended' || uncertainStart) && !pendingSession && !externalSession && (
              <button
                disabled={!!busy || !status || !!bridgeError}
                onClick={() => void act('start')}
                className="w-full bg-primary text-white rounded-lg px-4 py-2 hover:bg-secondary transition-colors"
              >
                세션 시작
              </button>
            )}

            {phase === 'starting' && !uncertainStart && <p className="text-sm text-secondary">세션 시작 확인 중...</p>}
            {sessionStatus === 'in_progress' && (
              <button
                disabled={!!busy || !status?.session_id}
                onClick={() => void act('finish', status?.session_id ?? null)}
                className="w-full bg-red-600 text-white rounded-lg px-4 py-2 hover:bg-red-700 transition-colors"
              >
                {phase === 'closing' ? '종료하기' : '세션 종료'}
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
