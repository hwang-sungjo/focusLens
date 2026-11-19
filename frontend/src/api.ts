// 모든 백엔드 API 요청이 거쳐 가는 공통 함수
// 기준 문서: docs/auth-flow.md 7절, docs/frontend-api-map.md 3절
//
// 1. 주소: 환경변수 VITE_API_BASE_URL (없으면 로컬 백엔드 주소)
// 2. 토큰: localStorage의 access_token을 Authorization 헤더에 자동 첨부
// 3. 401: Refresh Token(HttpOnly 쿠키)으로 1회 갱신 → 원 요청 1회 재시도
//         Refresh Token이 무효일 때만 토큰 삭제 → 로그인 화면으로 이동
//         서버 장애·네트워크 끊김이면 로그아웃하지 않고 오류로 돌려준다

const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000'

interface ApiOptions extends RequestInit {
  // 로그인·회원가입처럼 401이 "세션 만료"가 아닌 요청은 true로 넘긴다
  skipAuthRefresh?: boolean
}

// 응답 본문을 JSON으로 읽는다. 서버 앞단 장애 등으로 JSON이 아니면 null을 돌려준다
export function readJson(res: Response) {
  return res.json().catch(() => null)
}

// 상태 코드별 화면 문구 (docs/frontend-api-map.md 3절 HTTP 오류 UX)
// 500·503은 X-Request-ID를 붙여 서버 로그와 대조할 수 있게 한다 (같은 문서 2절)
export function getErrorMessage(
  res: Response,
  result: { error?: string } | null,
  fallback: string,
): string {
  const serverMessage = result?.error || ''
  const requestId = res.headers.get('X-Request-ID')
  const withId = (message: string) => (requestId ? `${message} (요청 ID: ${requestId})` : message)

  if (res.status === 403) return '이 작업을 할 권한이 없습니다.'
  if (res.status === 404) return serverMessage || '요청한 정보를 찾을 수 없습니다.'
  if (res.status === 503) return withId('서비스가 일시적으로 불안정합니다. 잠시 후 다시 시도해주세요.')
  if (res.status >= 500) return withId('일시적인 오류가 발생했습니다.')
  // 400·409 등: 서버가 준 구체적인 문구(입력 오류, 중복 등)를 그대로 보여준다
  return serverMessage || fallback
}

export function clearAuth() {
  localStorage.removeItem('access_token')
  localStorage.removeItem('user_id')
}

// 실제 fetch 실행 (토큰·헤더·쿠키 설정)
function send(path: string, init: RequestInit): Promise<Response> {
  const { headers, ...rest } = init
  const token = localStorage.getItem('access_token')

  return fetch(`${BASE_URL}${path}`, {
    ...rest,
    credentials: 'include', // Refresh Token 쿠키를 주고받기 위해 필요
    headers: {
      ...(rest.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers as Record<string, string> | undefined),
    },
  })
}

// 갱신 결과
// - ok: 새 Access Token 저장 완료
// - expired: Refresh Token이 무효(만료·폐기·재사용) → 다시 로그인해야 함
// - unavailable: 서버 장애(5xx 등)나 네트워크 끊김 → 로그인은 유효할 수 있으므로 로그아웃하지 않음
type RefreshResult =
  | { kind: 'ok' }
  | { kind: 'expired' }
  | { kind: 'unavailable'; status: number | null; requestId: string | null }

// 동시에 여러 요청이 401을 받아도 갱신은 한 번만 하도록 공유하는 Promise
// (같은 Refresh Token을 두 번 쓰면 서버가 재사용으로 판단해 로그인 전체를 폐기한다)
let refreshing: Promise<RefreshResult> | null = null

function refreshAccessToken(): Promise<RefreshResult> {
  if (!refreshing) {
    refreshing = (async (): Promise<RefreshResult> => {
      try {
        const res = await fetch(`${BASE_URL}/api/auth/refresh`, {
          method: 'POST',
          credentials: 'include',
        })
        if (res.ok) {
          const result = await readJson(res)
          const token = result?.data?.access_token
          if (!token) return { kind: 'unavailable', status: res.status, requestId: null }
          localStorage.setItem('access_token', token)
          return { kind: 'ok' }
        }
        // 400·401·403: Refresh Token 자체가 무효 → 재로그인
        if (res.status < 500 && res.status !== 429) return { kind: 'expired' }
        // 429·5xx: 서버 쪽 일시 문제
        return { kind: 'unavailable', status: res.status, requestId: res.headers.get('X-Request-ID') }
      } catch {
        // 네트워크 끊김, 서버 꺼짐
        return { kind: 'unavailable', status: null, requestId: null }
      } finally {
        refreshing = null
      }
    })()
  }
  return refreshing
}

export async function apiFetch(path: string, options: ApiOptions = {}): Promise<Response> {
  // skipAuthRefresh는 fetch가 모르는 옵션이라 따로 빼낸다
  const { skipAuthRefresh, ...init } = options
  const res = await send(path, init)

  if (res.status !== 401 || skipAuthRefresh) {
    return res
  }

  // 401 → 갱신 1회 시도
  const refreshed = await refreshAccessToken()
  if (refreshed.kind === 'ok') {
    return send(path, init) // 원 요청 1회 재시도
  }

  if (refreshed.kind === 'unavailable') {
    // 로그인은 그대로 두고, 화면이 평소 오류 처리로 안내하게 한다
    if (refreshed.status === null) {
      throw new TypeError('network error') // 각 화면의 catch → "서버에 연결할 수 없습니다"
    }
    // 서버 응답(503 등)을 그대로 넘겨 getErrorMessage가 상태별 문구와 요청 ID를 보여주게 한다
    return new Response(JSON.stringify({ success: false, data: {}, error: '' }), {
      status: refreshed.status,
      headers: refreshed.requestId ? { 'X-Request-ID': refreshed.requestId } : {},
    })
  }

  // Refresh Token 무효 → 토큰 삭제 후 로그인 화면으로
  clearAuth()
  window.location.href = '/login?expired=true'
  // 이동하는 동안 호출한 화면이 에러 문구를 잠깐 띄우지 않도록 여기서 멈춘다
  return new Promise<Response>(() => {})
}
