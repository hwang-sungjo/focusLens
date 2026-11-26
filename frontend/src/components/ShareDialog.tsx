import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiFetch, readJson, getErrorMessage } from '../api'

// 세션 공유 창 (POST /api/session-shares, docs/api-spec.md)
// - 공유 범위: PUBLIC(전체) · FRIENDS(친구) · GROUP(그룹)
// - 서버 규칙: 프로필의 "기본 세션 공개 범위"보다 넓게는 공유할 수 없다 (넓은 순서 PUBLIC > GROUP > FRIENDS > PRIVATE)
//   → 창을 열 때 내 공개 범위를 불러와, 허용되지 않는 범위는 미리 막아 둔다
// - 같은 세션을 같은 범위로 두 번 공유하면 서버가 409를 돌려준다

type ShareScope = 'PUBLIC' | 'FRIENDS' | 'GROUP'
type SessionScope = ShareScope | 'PRIVATE'

const SCOPE_RANK: Record<SessionScope, number> = { PRIVATE: 0, FRIENDS: 1, GROUP: 2, PUBLIC: 3 }
const SCOPE_LABEL: Record<ShareScope, string> = { PUBLIC: '전체 공개', FRIENDS: '친구에게', GROUP: '그룹에게' }
const SHARE_SCOPES: ShareScope[] = ['PUBLIC', 'FRIENDS', 'GROUP']
const MESSAGE_MAX = 500

interface MyGroup {
  group_id: string
  name: string
}

interface ShareDialogProps {
  sessionId: string
  onClose: () => void
}

function ShareDialog({ sessionId, onClose }: ShareDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [maxScope, setMaxScope] = useState<SessionScope | null>(null) // 내 기본 세션 공개 범위
  const [myGroups, setMyGroups] = useState<MyGroup[]>([])
  const [scope, setScope] = useState<ShareScope | null>(null)
  const [groupId, setGroupId] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])

  // 창을 열 때: 내 공개 범위와 내 그룹 목록을 함께 불러온다
  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const [privacyRes, groupsRes] = await Promise.all([
          apiFetch('/api/users/me/privacy'),
          apiFetch('/api/groups?limit=100'),
        ])
        const privacyResult = await readJson(privacyRes)
        if (!privacyRes.ok) {
          setError(getErrorMessage(privacyRes, privacyResult, '공개 범위 설정을 불러오지 못했습니다.'))
          return
        }
        const max: SessionScope = privacyResult.data.default_session_scope
        setMaxScope(max)

        const groupsResult = await readJson(groupsRes)
        const groups: MyGroup[] = groupsRes.ok ? groupsResult.data.groups : []
        setMyGroups(groups)
        if (groups.length > 0) setGroupId(groups[0].group_id)

        // 고를 수 있는 범위 중 가장 넓은 것을 기본 선택 (그룹이 없으면 GROUP은 건너뜀)
        const first = SHARE_SCOPES.find(
          (s) => SCOPE_RANK[s] <= SCOPE_RANK[max] && (s !== 'GROUP' || groups.length > 0),
        )
        setScope(first ?? null)
      } catch {
        setError('서버에 연결할 수 없습니다.')
      } finally {
        setLoading(false)
      }
    }
    fetchSettings()
  }, [])

  const isAllowed = (s: ShareScope) =>
    maxScope !== null && SCOPE_RANK[s] <= SCOPE_RANK[maxScope] && (s !== 'GROUP' || myGroups.length > 0)

  const handleSubmit = async () => {
    if (!scope) return
    setError('')
    setSubmitting(true)
    try {
      const res = await apiFetch('/api/session-shares', {
        method: 'POST',
        body: JSON.stringify({
          session_id: sessionId,
          share_scope: scope,
          ...(scope === 'GROUP' ? { group_id: groupId } : {}),
          ...(message.trim() ? { share_message: message.trim() } : {}),
        }),
      })
      const result = await readJson(res)
      if (!res.ok) {
        setError(
          res.status === 409
            ? '이미 같은 범위로 공유한 세션이에요.'
            : getErrorMessage(res, result, '공유하지 못했습니다.'),
        )
        return
      }
      setDone(true)
    } catch {
      setError('서버에 연결할 수 없습니다.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="fixed inset-0 m-auto max-h-[calc(100%_-_2rem)] w-[calc(100%_-_2rem)] max-w-md overflow-auto rounded-xl bg-surface shadow-lg backdrop:bg-black/30 print:hidden"
      aria-labelledby="share-heading"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <div className="p-6">
        <p id="share-heading" className="text-lg font-bold text-primary mb-4">세션 공유하기</p>

        {loading && <p className="text-sm text-secondary">불러오는 중...</p>}

        {done ? (
          <div className="text-center">
            <p className="text-3xl mb-2">🎉</p>
            <p className="text-sm text-secondary mb-5">공유했어요. 피드에서 확인할 수 있어요.</p>
            <div className="flex gap-2">
              <Link
                to="/feed"
                className="flex-1 text-center border border-accent text-secondary rounded-lg px-4 py-2 hover:bg-bg"
              >
                피드 보기
              </Link>
              <button
                onClick={onClose}
                className="flex-1 bg-primary text-white rounded-lg px-4 py-2 hover:bg-secondary"
              >
                닫기
              </button>
            </div>
          </div>
        ) : (
          !loading && (
            <>
              {maxScope === 'PRIVATE' ? (
                <p className="text-sm text-secondary bg-bg rounded-lg px-3 py-2 mb-4">
                  지금 기본 세션 공개 범위가 &quot;비공개(PRIVATE)&quot;라서 공유할 수 없어요.{' '}
                  <Link to="/profile" className="underline">
                    프로필
                  </Link>
                  에서 범위를 넓혀 주세요.
                </p>
              ) : (
                maxScope && (
                  <>
                    <p className="text-sm text-secondary mb-2">누구에게 보여 줄까요?</p>
                    <div className="space-y-2 mb-4">
                      {SHARE_SCOPES.map((s) => (
                        <label
                          key={s}
                          className={`flex items-center gap-2 text-sm ${
                            isAllowed(s) ? 'text-primary' : 'text-gray-400'
                          }`}
                        >
                          <input
                            type="radio"
                            name="share-scope"
                            checked={scope === s}
                            disabled={!isAllowed(s)}
                            onChange={() => setScope(s)}
                          />
                          {SCOPE_LABEL[s]}
                          {!isAllowed(s) && (
                            <span className="text-xs">
                              {s === 'GROUP' && myGroups.length === 0
                                ? '(가입한 그룹 없음)'
                                : '(프로필 공개 범위보다 넓음)'}
                            </span>
                          )}
                        </label>
                      ))}
                    </div>

                    {scope === 'GROUP' && (
                      <select
                        aria-label="공유할 그룹"
                        value={groupId}
                        onChange={(e) => setGroupId(e.target.value)}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-4"
                      >
                        {myGroups.map((g) => (
                          <option key={g.group_id} value={g.group_id}>
                            {g.name}
                          </option>
                        ))}
                      </select>
                    )}

                    <label className="block text-sm text-secondary mb-1" htmlFor="share-message">
                      한마디 (선택)
                    </label>
                    <textarea
                      id="share-message"
                      value={message}
                      onChange={(e) => setMessage(e.target.value.slice(0, MESSAGE_MAX))}
                      rows={3}
                      placeholder="오늘 공부 어땠나요?"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    />
                    <p className="text-xs text-secondary text-right mb-4">
                      {message.length}/{MESSAGE_MAX}
                    </p>
                  </>
                )
              )}

              {error && <p className="text-sm text-red-600 mb-3">{error}</p>}

              <div className="flex gap-2">
                <button
                  onClick={onClose}
                  className="flex-1 border border-accent text-secondary rounded-lg px-4 py-2 hover:bg-bg"
                >
                  취소
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={!scope || submitting}
                  className="flex-1 bg-primary text-white rounded-lg px-4 py-2 hover:bg-secondary disabled:opacity-50"
                >
                  {submitting ? '공유하는 중...' : '공유하기'}
                </button>
              </div>
            </>
          )
        )}
      </div>
    </dialog>
  )
}

export default ShareDialog
