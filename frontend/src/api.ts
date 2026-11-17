// 모든 백엔드 API 요청이 거쳐 가는 공통 함수
// 기준 문서: docs/auth-flow.md 7절, docs/frontend-api-map.md 3절
//
// 1. 주소: 환경변수 VITE_API_BASE_URL (없으면 로컬 백엔드 주소)
// 2. 토큰: localStorage의 access_token을 Authorization 헤더에 자동 첨부
// 3. 401: Refresh Token(HttpOnly 쿠키)으로 1회 갱신 → 원 요청 1회 재시도
//         갱신 실패 시 토큰 삭제 → 로그인 화면으로 이동

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

// 동시에 여러 요청이 401을 받아도 갱신은 한 번만 하도록 공유하는 Promise
// (같은 Refresh Token을 두 번 쓰면 서버가 재사용으로 판단해 로그인 전체를 폐기한다)
let refreshing: Promise<boolean> | null = null

function refreshAccessToken(): Promise<boolean> {
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const res = await fetch(`${BASE_URL}/api/auth/refresh`, {
          method: 'POST',
          credentials: 'include',
        })
        if (!res.ok) return false
        const result = await res.json()
        localStorage.setItem('access_token', result.data.access_token)
        return true
      } catch {
        return false
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
  if (refreshed) {
    return send(path, init) // 원 요청 1회 재시도
  }

  // 갱신 실패 → 토큰 삭제 후 로그인 화면으로
  clearAuth()
  window.location.href = '/login?expired=true'
  // 이동하는 동안 호출한 화면이 에러 문구를 잠깐 띄우지 않도록 여기서 멈춘다
  return new Promise<Response>(() => {})
}