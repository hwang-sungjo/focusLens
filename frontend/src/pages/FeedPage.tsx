import { useEffect, useState } from 'react'
import { apiFetch, readJson, getErrorMessage } from '../api'

// 소셜 피드 화면 (GET /api/session-shares/feed, 반응 POST·DELETE /api/session-shares/:id/reactions)
// - 전체(all): 전체 공개 + 친구 공유 + 내 그룹 공유 + 내가 공유한 것
// - 친구(friends): 친구가 친구 범위로 공유한 것
// - 공개(public): 전체 공개로 공유한 것
// - 학습 시간·점수는 올린 사람의 공개 범위에 따라 서버가 null로 가려서 보낸다

type FeedScope = 'all' | 'friends' | 'public'
type ReactionType = 'LIKE' | 'CHEER' | 'EMPATHY'

interface FeedItem {
  share_id: string
  session_id: string
  share_scope: 'PUBLIC' | 'FRIENDS' | 'GROUP'
  group_id: string | null
  share_message: string | null
  owner: { user_id: string; nickname: string | null; profile_image_url: string | null }
  session_summary: {
    started_at: string
    duration_seconds: number | null // 공개 범위 밖이면 null
    avg_focus_score: number | null // 공개 범위 밖이거나 기록이 없으면 null
  }
  reaction_counts: Record<ReactionType, number>
  my_reactions: ReactionType[]
  created_at: string
}

const PAGE_SIZE = 20
const SCOPE_LABEL: Record<FeedScope, string> = { all: '전체', friends: '친구', public: '공개' }
const SHARE_SCOPE_LABEL: Record<FeedItem['share_scope'], string> = {
  PUBLIC: '전체 공개',
  FRIENDS: '친구 공개',
  GROUP: '그룹 공개',
}
const REACTIONS: { type: ReactionType; emoji: string; label: string }[] = [
  { type: 'LIKE', emoji: '👍', label: '좋아요' },
  { type: 'CHEER', emoji: '🔥', label: '응원해요' },
  { type: 'EMPATHY', emoji: '🤝', label: '공감해요' },
]

type FeedPageResult = { ok: true; items: FeedItem[]; total: number } | { ok: false; message: string }

// 피드 한 페이지 요청 (리포트 세션 목록과 같은 방식)
async function loadFeedPage(scope: FeedScope, pageNo: number): Promise<FeedPageResult> {
  try {
    const res = await apiFetch(`/api/session-shares/feed?scope=${scope}&page=${pageNo}&limit=${PAGE_SIZE}`)
    const result = await readJson(res)
    if (!res.ok) return { ok: false, message: getErrorMessage(res, result, '피드를 불러오지 못했습니다.') }
    const items: FeedItem[] = result.data.feed
    return { ok: true, items, total: result.data.pagination?.total ?? items.length }
  } catch {
    return { ok: false, message: '서버에 연결할 수 없습니다.' }
  }
}

function formatDuration(seconds: number) {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return hours > 0 ? `${hours}시간 ${minutes}분` : `${minutes}분`
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('ko-KR', {
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// 요약 칸용 짧은 날짜 (좁은 화면에서 줄바꿈되지 않게): 11/19 10:00
function formatShortDate(iso: string) {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function FeedPage() {
  const myUserId = localStorage.getItem('user_id')

  const [scope, setScope] = useState<FeedScope>('all')
  const [items, setItems] = useState<FeedItem[]>([])
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [pendingReaction, setPendingReaction] = useState<string | null>(null) // 처리 중인 "share_id:type"

  // 탭을 바꾸거나 다시 시도하면 첫 페이지부터 불러온다
  useEffect(() => {
    const fetchFirstPage = async () => {
      const result = await loadFeedPage(scope, 1)
      if (!result.ok) {
        setError(result.message)
        setItems([])
      } else {
        setItems(result.items)
        setTotal(result.total)
        setPage(1)
      }
      setLoading(false)
    }
    fetchFirstPage()
  }, [scope, reloadKey])

  const handleChangeScope = (next: FeedScope) => {
    if (next === scope) return
    setError('')
    setLoading(true)
    setScope(next)
  }

  const handleRetry = () => {
    setError('')
    setLoading(true)
    setReloadKey((k) => k + 1)
  }

  const handleLoadMore = async () => {
    setError('')
    setLoadingMore(true)
    const next = page + 1
    const result = await loadFeedPage(scope, next)
    if (!result.ok) {
      setError(result.message)
    } else {
      // 보는 사이 새 공유가 올라오면 페이지가 밀려 같은 글이 또 올 수 있어 중복은 뺀다
      setItems((prev) => {
        const seen = new Set(prev.map((item) => item.share_id))
        return [...prev, ...result.items.filter((item) => !seen.has(item.share_id))]
      })
      setTotal(result.total)
      setPage(next)
    }
    setLoadingMore(false)
  }

  // 화면의 반응 수·내 반응 상태를 바꾼다 (서버 응답이 성공한 뒤에만 부른다)
  const applyReaction = (shareId: string, type: ReactionType, on: boolean) => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.share_id !== shareId) return item
        const already = item.my_reactions.includes(type)
        if (already === on) return item
        return {
          ...item,
          my_reactions: on ? [...item.my_reactions, type] : item.my_reactions.filter((t) => t !== type),
          reaction_counts: {
            ...item.reaction_counts,
            [type]: Math.max(0, item.reaction_counts[type] + (on ? 1 : -1)),
          },
        }
      }),
    )
  }

  // 반응 버튼: 안 누른 상태면 추가(POST), 누른 상태면 취소(DELETE)
  const handleToggleReaction = async (item: FeedItem, type: ReactionType) => {
    const key = `${item.share_id}:${type}`
    if (pendingReaction) return // 연달아 눌러 요청이 꼬이지 않게 한 번에 하나만
    const on = !item.my_reactions.includes(type)
    setError('')
    setPendingReaction(key)
    try {
      const res = on
        ? await apiFetch(`/api/session-shares/${item.share_id}/reactions`, {
            method: 'POST',
            body: JSON.stringify({ reaction_type: type }),
          })
        : await apiFetch(`/api/session-shares/${item.share_id}/reactions/${type}`, { method: 'DELETE' })
      // 409: 다른 탭·기기에서 이미 같은 반응을 남김 → 눌린 상태로 맞춘다
      if (res.ok || (on && res.status === 409)) {
        applyReaction(item.share_id, type, on)
      } else {
        const result = await readJson(res)
        setError(getErrorMessage(res, result, '반응을 남기지 못했습니다.'))
      }
    } catch {
      setError('서버에 연결할 수 없습니다.')
    } finally {
      setPendingReaction(null)
    }
  }

  const hasMore = items.length < total

  return (
    <div className="min-h-screen bg-bg p-6">
      <h1 className="text-2xl font-bold text-primary mb-6">피드</h1>

      <div className="max-w-2xl space-y-4">
        <div className="flex rounded-lg border border-accent overflow-hidden text-sm w-max">
          {(['all', 'friends', 'public'] as const).map((s) => (
            <button
              key={s}
              onClick={() => handleChangeScope(s)}
              className={`px-4 py-1.5 ${scope === s ? 'bg-primary text-white' : 'bg-surface text-secondary hover:bg-bg'}`}
            >
              {SCOPE_LABEL[s]}
            </button>
          ))}
        </div>

        {loading && <p className="text-secondary">불러오는 중...</p>}
        {error && (
          <div className="flex items-center gap-3">
            <p className="text-red-600">{error}</p>
            <button onClick={handleRetry} className="text-sm text-secondary underline shrink-0">
              다시 시도
            </button>
          </div>
        )}

        {!loading && !error && items.length === 0 && (
          <div className="bg-surface rounded-xl shadow-md p-6 text-center">
            <p className="text-sm text-secondary">아직 공유된 세션이 없어요.</p>
            <p className="text-xs text-secondary mt-1">리포트 화면에서 [공유하기]로 첫 세션을 올려 보세요.</p>
          </div>
        )}

        {items.map((item) => {
          const isMine = item.owner.user_id === myUserId
          const { duration_seconds, avg_focus_score } = item.session_summary
          return (
            <article key={item.share_id} className="bg-surface rounded-xl shadow-md p-5">
              {/* 올린 사람 */}
              <div className="flex items-center gap-3 mb-3">
                {item.owner.profile_image_url ? (
                  <img src={item.owner.profile_image_url} alt="" className="w-9 h-9 rounded-full object-cover" />
                ) : (
                  <span className="w-9 h-9 rounded-full bg-accent text-white flex items-center justify-center text-sm">
                    👤
                  </span>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-primary truncate">
                    {item.owner.nickname ?? '알 수 없는 사용자'}
                    {isMine && <span className="ml-1 text-xs text-secondary">(나)</span>}
                  </p>
                  <p className="text-xs text-secondary">
                    {formatDate(item.created_at)} · {SHARE_SCOPE_LABEL[item.share_scope]}
                  </p>
                </div>
              </div>

              {/* 한마디 (React가 글자로 표시하므로 HTML·스크립트는 실행되지 않는다) */}
              {item.share_message && (
                <p className="text-sm text-primary whitespace-pre-wrap break-words mb-3">{item.share_message}</p>
              )}

              {/* 세션 요약: 공개 범위 밖이면 서버가 null → "비공개" */}
              <div className="grid grid-cols-3 gap-2 bg-bg rounded-lg p-3 text-center mb-3">
                <div>
                  <p className="text-xs text-secondary">공부 시작</p>
                  <p className="text-sm font-medium text-primary">{formatShortDate(item.session_summary.started_at)}</p>
                </div>
                <div>
                  <p className="text-xs text-secondary">학습 시간</p>
                  <p className="text-sm font-medium text-primary">
                    {duration_seconds !== null ? formatDuration(duration_seconds) : '비공개'}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-secondary">평균 집중도</p>
                  <p className="text-sm font-medium text-primary">
                    {avg_focus_score !== null ? `${avg_focus_score.toFixed(1)}점` : '비공개'}
                  </p>
                </div>
              </div>

              {/* 반응 버튼 */}
              <div className="flex gap-2">
                {REACTIONS.map(({ type, emoji, label }) => {
                  const pressed = item.my_reactions.includes(type)
                  return (
                    <button
                      key={type}
                      onClick={() => handleToggleReaction(item, type)}
                      disabled={pendingReaction === `${item.share_id}:${type}`}
                      aria-pressed={pressed}
                      aria-label={`${label} ${item.reaction_counts[type]}개`}
                      className={`px-3 py-1 rounded-full text-sm border disabled:opacity-50 ${
                        pressed
                          ? 'bg-primary text-white border-primary'
                          : 'text-secondary border-accent hover:bg-bg'
                      }`}
                    >
                      {emoji} {item.reaction_counts[type]}
                    </button>
                  )
                })}
              </div>
            </article>
          )
        })}

        {hasMore && !loading && (
          <button
            onClick={handleLoadMore}
            disabled={loadingMore}
            className="w-full px-3 py-2 rounded-lg text-sm text-secondary border border-accent bg-surface hover:bg-bg disabled:opacity-50"
          >
            {loadingMore ? '불러오는 중...' : `더 보기 (${items.length}/${total})`}
          </button>
        )}
      </div>
    </div>
  )
}

export default FeedPage
