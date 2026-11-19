import { apiFetch, readJson, getErrorMessage } from './api'

// 친구 관련 공통 함수 (친구 화면·피드·랭킹이 같이 쓴다)
// 컴포넌트 파일(components/FriendButton.tsx)과 나눈 이유: 컴포넌트 파일에서 함수까지 내보내면
// 개발 서버의 화면 즉시 갱신(Fast Refresh)이 동작하지 않아 lint가 막는다

// 나와 그 사람의 관계: 친구 / 내가 요청 보냄 / 상대가 요청 보냄 / 없음
export type FriendStatus = 'friend' | 'sent' | 'received' | 'none'

interface ConnectionUser {
  user_id: string
}

// 내 친구·대기 요청을 한 번에 불러와 user_id → 관계 표로 만든다
// 한 번에 100명까지만 불러오므로(서버 limit 최대값), 그 이상이면 일부는 'none'으로 보일 수 있다
export async function loadFriendStatus(): Promise<Map<string, FriendStatus>> {
  const map = new Map<string, FriendStatus>()
  try {
    const res = await apiFetch('/api/connections?include_pending=true&limit=100')
    const result = await readJson(res)
    if (!res.ok) return map
    const { connections, pending_sent, pending_received } = result.data as {
      connections: ConnectionUser[]
      pending_sent: ConnectionUser[]
      pending_received: ConnectionUser[]
    }
    connections.forEach((c) => map.set(c.user_id, 'friend'))
    pending_sent.forEach((r) => map.set(r.user_id, 'sent'))
    pending_received.forEach((r) => map.set(r.user_id, 'received'))
  } catch {
    // 불러오지 못해도 버튼은 보여 준다 (누르면 서버가 중복 여부를 알려 줌)
  }
  return map
}

// 친구 요청 보내기. 성공하면 null, 실패하면 화면에 보여 줄 문구를 돌려준다
export async function sendFriendRequest(userId: string): Promise<string | null> {
  try {
    const res = await apiFetch('/api/connections/request', {
      method: 'POST',
      body: JSON.stringify({ receiver_user_id: userId }),
    })
    if (res.ok) return null
    const result = await readJson(res)
    // 409: 이미 친구이거나 대기 중인 요청이 있음 → 서버 문구를 그대로 보여 준다
    return getErrorMessage(res, result, '친구 요청을 보내지 못했습니다.')
  } catch {
    return '서버에 연결할 수 없습니다.'
  }
}
