import { getErrorMessage, readJson, withAuthRefresh } from './api'

type Phase = 'idle' | 'starting' | 'measuring' | 'paused' | 'closing' | 'ended'
export type AiAction = 'start' | 'resume' | 'finish'

export interface MinuteScore {
  client_log_id: string
  measured_at: string
  focus_score: number
  attention_state: 'FOCUSED' | 'NORMAL' | 'DISTRACTED'
  gaze: number
  blink: number
  head: number
}

export interface AiStatus {
  phase: Phase
  session_id: string | null
  started_at: string | null
  stage: string
  error: string | null
  pending: number
  failed: number
  latest: MinuteScore | null
}

const connectionHint = '로컬 AI에 연결할 수 없습니다. 컴퓨터에서 npm run local:ai:web을 실행해 주세요.'
const errors: Record<string, string> = {
  active_session_exists: '이미 진행 중인 세션이 있습니다. 시작한 도구에서 상태를 확인해 주세요.',
  session_not_managed_here: '다른 도구에서 시작한 세션입니다. 해당 도구에서 이어가거나 종료해 주세요.',
  session_identity_mismatch: '세션이 바뀌었습니다. 현재 세션을 다시 확인해 주세요.',
  camera_in_use: '카메라가 사용 중입니다. 기존 측정을 마친 뒤 다시 시도해 주세요.',
  calibration_needs_face: '얼굴이 카메라에 잘 보이도록 화면 중앙을 3초간 바라봐 주세요. 보정을 다시 시도하고 있습니다.',
  model_unavailable: '얼굴 분석 모델을 열 수 없습니다. 로컬 AI의 모델 파일 경로를 확인해 주세요.',
  camera_dependencies_unavailable: '로컬 AI의 Python 환경과 카메라 패키지 설치를 확인해 주세요.',
  camera_open_failed: '카메라를 열 수 없습니다. Python을 실행한 앱의 카메라 권한을 확인해 주세요.',
  camera_read_failed: '카메라 입력이 끊겼습니다. 카메라를 연결한 뒤 이어하기를 눌러 주세요.',
  camera_inference_failed: '카메라 프레임을 분석하지 못했습니다. 이어하기로 측정을 다시 시작해 주세요.',
  camera_or_local_state_unavailable: '측정이 중단되었습니다. 카메라 연결과 권한을 확인한 뒤 이어하기를 눌러 주세요.',
  browser_disconnected: '화면 연결이 끊겨 측정이 멈췄습니다. 이어하기를 누르면 다시 측정합니다.',
  authentication_required: '측정 기록을 보내려면 로그인이 필요합니다. 로그인 후 다시 시도해 주세요.',
  server_unavailable_measure_again: '서버에 연결할 수 없습니다. 연결을 확인한 뒤 다시 시작해 주세요.',
  confirm_session_id_required: '시작 응답을 확인하지 못했습니다. 아래 세션의 시작 시각을 확인해 주세요.',
  start_confirmation_required_use_resume: '시작 응답을 확인하지 못했습니다. 서버의 진행 세션을 확인해 주세요.',
  pending_logs: '전송을 기다리는 기록이 있습니다. 연결을 확인한 뒤 종료를 다시 시도해 주세요.',
  failed_logs: '전송하지 못한 기록이 있어 종료를 보류했습니다. 로컬 AI 상태를 확인해 주세요.',
  insufficient_valid_samples: '이번 분은 유효한 측정 표본이 부족했습니다.',
  retry_exhausted: '기록 전송을 마치지 못했습니다. 서버 연결을 확인한 뒤 다시 시도해 주세요.',
  retry_finish_required: '종료 확인이 중단되었습니다. 종료하기를 눌러 남은 기록을 전송해 주세요.',
  backend_unavailable: '로컬 AI가 백엔드에 연결할 수 없습니다. 서버 상태를 확인해 주세요.',
}

export function aiErrorText(code: string) {
  return errors[code] || '로컬 AI 작업을 마치지 못했습니다. 연결과 세션 상태를 확인해 주세요.'
}

function bridgeRequest(route: 'status' | 'preview' | AiAction, init: RequestInit): Promise<Response> {
  const value = import.meta.env.VITE_LOCAL_AI_ORIGIN || 'http://127.0.0.1:4317'
  if (!/^http:\/\/(127\.0\.0\.1|localhost):[1-9]\d{0,4}\/?$/.test(value)) {
    throw new Error('로컬 AI 주소에 localhost 또는 127.0.0.1과 HTTP 포트를 지정해 주세요.')
  }
  const url = new URL('/' + route, value)
  return withAuthRefresh(async () => {
    const token = localStorage.getItem('access_token')
    try {
      return await fetch(url, {
        ...init, credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
        headers: { Authorization: 'Bearer ' + (token || ''), ...(init.body && { 'Content-Type': 'application/json' }) },
      })
    } catch (error) {
      if (init.signal?.aborted) throw error
      throw new Error(connectionHint, { cause: error })
    }
  })
}

async function readStatus(response: Response): Promise<AiStatus> {
  const result = await readJson(response)
  if (!response.ok || !result?.success) {
    const code = result?.error
    throw new Error(errors[code] || getErrorMessage(response, null, '로컬 AI 상태를 확인할 수 없습니다.'))
  }
  const status = result.data as AiStatus
  if (!['idle', 'starting', 'measuring', 'paused', 'closing', 'ended'].includes(status?.phase)) {
    throw new Error('로컬 AI에서 유효한 세션 상태를 받지 못했습니다.')
  }
  return status
}

export async function getAiStatus(signal: AbortSignal) {
  return readStatus(await bridgeRequest('status', { signal }))
}

export async function controlAi(action: AiAction, sessionId: string | null) {
  if (action !== 'start' && !sessionId) throw new Error('대상 세션을 확인한 뒤 다시 시도해 주세요.')
  return readStatus(await bridgeRequest(action, {
    method: 'POST', body: JSON.stringify(action === 'start' ? {} : { session_id: sessionId }),
    signal: AbortSignal.timeout(30_000),
  }))
}

export async function getAiPreview(signal: AbortSignal): Promise<Blob | null> {
  const response = await bridgeRequest('preview', { signal })
  if (response.status === 204) return null
  if (!response.ok || !response.headers.get('content-type')?.startsWith('image/jpeg')) {
    throw new Error('미리보기 연결을 기다리고 있습니다.')
  }
  return response.blob()
}
