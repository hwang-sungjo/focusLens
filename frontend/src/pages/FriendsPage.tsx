import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiFetch, readJson, getErrorMessage } from '../api'
import { sendFriendRequest } from '../friends'

// 친구 화면 (GET /api/connections?include_pending=true, POST /api/connections/request, PATCH /api/connections/:id)
// - 받은 요청: 수락(ACCEPTED) / 거절(REJECTED) — 받은 사람만 가능
// - 보낸 요청: 취소(CANCELLED) — 보낸 사람만 가능
// - 친구 찾기: 사용자 검색 API가 없어서 두 가지로 우회한다
//   1) 피드·랭킹에서 [+ 친구] 버튼
//   2) 내 ID를 복사해 친구에게 보내고, 친구의 ID를 받아 붙여넣기

interface Person {
  user_id: string
  nickname: string | null
  profile_image_url: string | null
}
interface Friend extends Person {
  connection_id: string
  connected_at: string
}
interface PendingRequest extends Person {
  request_id: string
  created_at: string
}
interface ConnectionsData {
  connections: Friend[]
  pending_received: PendingRequest[]
  pending_sent: PendingRequest[]
  total: number
}

type RespondStatus = 'ACCEPTED' | 'REJECTED' | 'CANCELLED'

// user_id는 UUID(8-4-4-4-12자리 16진수). 서버도 같은 형식만 받는다
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type LoadResult = { ok: true; data: ConnectionsData } | { ok: false; message: string }

async function loadConnections(): Promise<LoadResult> {
  try {
    const res = await apiFetch('/api/connections?include_pending=true&limit=100')
    const result = await readJson(res)
    if (!res.ok) return { ok: false, message: getErrorMessage(res, result, '친구 목록을 불러오지 못했습니다.') }
    const d = result.data
    return {
      ok: true,
      data: {
        connections: d.connections,
        pending_received: d.pending_received,
        pending_sent: d.pending_sent,
        total: d.pagination?.total ?? d.connections.length,
      },
    }
  } catch {
    return { ok: false, message: '서버에 연결할 수 없습니다.' }
  }
}

function Avatar({ url }: { url: string | null }) {
  return url ? (
    <img src={url} alt="" className="w-8 h-8 rounded-full object-cover shrink-0" />
  ) : (
    <span className="w-8 h-8 rounded-full bg-accent text-white flex items-center justify-center text-sm shrink-0">
      👤
    </span>
  )
}

function FriendsPage() {
  const myUserId = localStorage.getItem('user_id') ?? ''

  const [data, setData] = useState<ConnectionsData | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)
  const [pendingId, setPendingId] = useState<string | null>(null) // 처리 중인 요청 ID

  const [idInput, setIdInput] = useState('')
  const [addMessage, setAddMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [adding, setAdding] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const fetchConnections = async () => {
      const result = await loadConnections()
      if (result.ok) setData(result.data)
      else setError(result.message)
      setLoading(false)
    }
    fetchConnections()
  }, [reloadKey])

  // 목록을 다시 불러온다 (수락·거절·취소·요청 뒤 화면을 서버와 맞춤)
  const reload = () => {
    setError('')
    setReloadKey((k) => k + 1)
  }

  const handleRespond = async (requestId: string, status: RespondStatus) => {
    setError('')
    setPendingId(requestId)
    try {
      const res = await apiFetch(`/api/connections/${requestId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      })
      if (!res.ok) {
        const result = await readJson(res)
        setError(getErrorMessage(res, result, '요청을 처리하지 못했습니다.'))
      }
      reload() // 실패해도 다시 불러온다 (409 = 상대가 이미 취소·처리한 경우라 목록을 맞춰야 함)
    } catch {
      setError('서버에 연결할 수 없습니다.')
    } finally {
      setPendingId(null)
    }
  }

  const handleCopyMyId = async () => {
    try {
      await navigator.clipboard.writeText(myUserId)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // 클립보드 권한이 없는 환경: 글자를 직접 선택해서 복사할 수 있게 그대로 둔다
    }
  }

  const handleAddById = async () => {
    const id = idInput.trim()
    setAddMessage(null)
    if (!UUID_PATTERN.test(id)) {
      setAddMessage({ ok: false, text: 'ID 형식이 아니에요. 친구에게 받은 ID 전체를 붙여넣어 주세요.' })
      return
    }
    if (id === myUserId) {
      setAddMessage({ ok: false, text: '내 ID예요. 친구의 ID를 넣어 주세요.' })
      return
    }
    setAdding(true)
    const message = await sendFriendRequest(id)
    setAdding(false)
    if (message) {
      setAddMessage({ ok: false, text: message })
    } else {
      setAddMessage({ ok: true, text: '친구 요청을 보냈어요.' })
      setIdInput('')
      reload()
    }
  }

  const buttonBase = 'px-3 py-1 rounded-lg text-sm disabled:opacity-50 shrink-0'

  return (
    <div className="min-h-screen bg-bg p-6">
      <h1 className="text-2xl font-bold text-primary mb-6">친구</h1>

      <div className="max-w-2xl space-y-4">
        {loading && <p className="text-secondary">불러오는 중...</p>}
        {error && (
          <div className="flex items-center gap-3">
            <p className="text-red-600">{error}</p>
            <button onClick={reload} className="text-sm text-secondary underline shrink-0">
              다시 시도
            </button>
          </div>
        )}

        {/* 친구 찾기 */}
        <div className="bg-surface rounded-xl shadow-md p-5 space-y-4">
          <p className="text-sm font-medium text-primary">친구 찾기</p>
          <p className="text-xs text-secondary">
            <Link to="/feed" className="underline">
              피드
            </Link>
            나{' '}
            <Link to="/rankings" className="underline">
              랭킹
            </Link>
            에서 다른 사람 옆의 [+ 친구]를 누르거나, 아래처럼 ID를 주고받아 추가할 수 있어요.
          </p>

          <div>
            <p className="text-xs text-secondary mb-1">내 ID (친구에게 보내 주세요)</p>
            <div className="flex gap-2">
              <code className="flex-1 min-w-0 truncate bg-bg rounded-lg px-3 py-1.5 text-xs text-primary select-all">
                {myUserId}
              </code>
              <button
                onClick={handleCopyMyId}
                className={`${buttonBase} border border-accent text-secondary hover:bg-bg`}
              >
                {copied ? '복사됨 ✓' : '복사'}
              </button>
            </div>
          </div>

          <div>
            <label htmlFor="friend-id" className="block text-xs text-secondary mb-1">
              친구 ID로 추가
            </label>
            <div className="flex gap-2">
              <input
                id="friend-id"
                value={idInput}
                onChange={(e) => setIdInput(e.target.value)}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                className="flex-1 min-w-0 border border-gray-300 rounded-lg px-3 py-1.5 text-sm"
              />
              <button
                onClick={handleAddById}
                disabled={adding || !idInput.trim()}
                className={`${buttonBase} bg-primary text-white hover:bg-secondary`}
              >
                {adding ? '보내는 중...' : '요청'}
              </button>
            </div>
            {addMessage && (
              <p className={`text-xs mt-1 ${addMessage.ok ? 'text-secondary' : 'text-red-600'}`}>
                {addMessage.text}
              </p>
            )}
          </div>
        </div>

        {data && (
          <>
            {/* 받은 요청 */}
            {data.pending_received.length > 0 && (
              <div className="bg-surface rounded-xl shadow-md p-5">
                <p className="text-sm font-medium text-primary mb-3">
                  받은 요청 <span className="text-secondary">{data.pending_received.length}</span>
                </p>
                <ul className="space-y-3">
                  {data.pending_received.map((r) => (
                    <li key={r.request_id} className="flex items-center gap-3">
                      <Avatar url={r.profile_image_url} />
                      <span className="flex-1 min-w-0 truncate text-sm text-primary">
                        {r.nickname ?? '알 수 없는 사용자'}
                      </span>
                      <button
                        onClick={() => handleRespond(r.request_id, 'ACCEPTED')}
                        disabled={pendingId === r.request_id}
                        className={`${buttonBase} bg-primary text-white hover:bg-secondary`}
                      >
                        수락
                      </button>
                      <button
                        onClick={() => handleRespond(r.request_id, 'REJECTED')}
                        disabled={pendingId === r.request_id}
                        className={`${buttonBase} border border-accent text-secondary hover:bg-bg`}
                      >
                        거절
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* 보낸 요청 */}
            {data.pending_sent.length > 0 && (
              <div className="bg-surface rounded-xl shadow-md p-5">
                <p className="text-sm font-medium text-primary mb-3">
                  보낸 요청 <span className="text-secondary">{data.pending_sent.length}</span>
                </p>
                <ul className="space-y-3">
                  {data.pending_sent.map((r) => (
                    <li key={r.request_id} className="flex items-center gap-3">
                      <Avatar url={r.profile_image_url} />
                      <span className="flex-1 min-w-0 truncate text-sm text-primary">
                        {r.nickname ?? '알 수 없는 사용자'}
                      </span>
                      <span className="text-xs text-secondary">대기 중</span>
                      <button
                        onClick={() => handleRespond(r.request_id, 'CANCELLED')}
                        disabled={pendingId === r.request_id}
                        className={`${buttonBase} border border-accent text-secondary hover:bg-bg`}
                      >
                        취소
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* 친구 목록 */}
            <div className="bg-surface rounded-xl shadow-md p-5">
              <p className="text-sm font-medium text-primary mb-3">
                내 친구 <span className="text-secondary">{data.total}</span>
              </p>
              {data.connections.length === 0 ? (
                <p className="text-sm text-secondary">아직 친구가 없어요.</p>
              ) : (
                <ul className="space-y-3">
                  {data.connections.map((f) => (
                    <li key={f.connection_id} className="flex items-center gap-3">
                      <Avatar url={f.profile_image_url} />
                      <span className="flex-1 min-w-0 truncate text-sm text-primary">
                        {f.nickname ?? '알 수 없는 사용자'}
                      </span>
                      <span className="text-xs text-secondary">
                        {new Date(f.connected_at).toLocaleDateString('ko-KR')}부터
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {data.total > data.connections.length && (
                <p className="text-xs text-secondary mt-3">처음 100명까지만 보여요.</p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default FriendsPage
