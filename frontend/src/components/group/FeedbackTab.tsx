import { useEffect, useState } from 'react'
import { apiFetch, readJson, getErrorMessage } from '../../api'
import { isManagerRole, loadGroupMembers, type GroupMember, type GroupRole } from '../../groups'

// 그룹 상세 > 피드백 탭
// - 피드백 쓰기 POST /api/groups/:id/feedbacks: 방장·매니저가 멤버에게 (최대 2000자)
// - 피드백 보기 GET /api/groups/:id/feedbacks:
//   · 방장·매니저: 그룹의 모든 피드백, 멤버별로 거를 수 있음 (target_member_id)
//   · 일반 멤버: 나에게 온 피드백만 (서버가 알아서 거른다)

interface Feedback {
  feedback_id: string
  target_member_id: string
  target_user: { user_id: string; nickname: string | null }
  manager_user: { user_id: string; nickname: string | null }
  content: string
  created_at: string
}

const CONTENT_MAX = 2000

type LoadResult = { ok: true; feedbacks: Feedback[]; total: number } | { ok: false; message: string }

async function loadFeedbacks(groupId: string, targetMemberId: string): Promise<LoadResult> {
  try {
    const params = new URLSearchParams({ limit: '100' })
    if (targetMemberId) params.set('target_member_id', targetMemberId)
    const res = await apiFetch(`/api/groups/${groupId}/feedbacks?${params}`)
    const result = await readJson(res)
    if (!res.ok) return { ok: false, message: getErrorMessage(res, result, '피드백을 불러오지 못했습니다.') }
    const d = result.data
    return { ok: true, feedbacks: d.feedbacks, total: d.pagination?.total ?? d.feedbacks.length }
  } catch {
    return { ok: false, message: '서버에 연결할 수 없습니다.' }
  }
}

interface FeedbackTabProps {
  groupId: string
  myRole: GroupRole
}

function FeedbackTab({ groupId, myRole }: FeedbackTabProps) {
  const isManager = isManagerRole(myRole)
  const myUserId = localStorage.getItem('user_id')

  const [feedbacks, setFeedbacks] = useState<Feedback[]>([])
  const [total, setTotal] = useState(0)
  const [members, setMembers] = useState<GroupMember[]>([])
  const [filterMemberId, setFilterMemberId] = useState('') // 빈 값 = 전체
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)

  // 쓰기 폼 (방장·매니저)
  const [targetId, setTargetId] = useState('')
  const [content, setContent] = useState('')
  const [sending, setSending] = useState(false)
  const [formMessage, setFormMessage] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    const fetchFeedbacks = async () => {
      const result = await loadFeedbacks(groupId, filterMemberId)
      if (result.ok) {
        setFeedbacks(result.feedbacks)
        setTotal(result.total)
      } else {
        setError(result.message)
      }
      setLoading(false)
    }
    fetchFeedbacks()
  }, [groupId, filterMemberId, reloadKey])

  // 방장·매니저만: 피드백 대상으로 고를 멤버 명단 (나 자신은 뺀다)
  useEffect(() => {
    if (!isManager) return
    const fetchMembers = async () => {
      const list = (await loadGroupMembers(groupId)).filter((m) => m.user_id !== myUserId)
      setMembers(list)
      setTargetId(list[0]?.group_member_id ?? '')
    }
    fetchMembers()
  }, [groupId, isManager, myUserId])

  const reload = () => {
    setError('')
    setReloadKey((k) => k + 1)
  }

  const handleFilter = (memberId: string) => {
    setError('')
    setLoading(true)
    setFilterMemberId(memberId)
  }

  const handleSend = async () => {
    setFormMessage(null)
    setSending(true)
    try {
      const res = await apiFetch(`/api/groups/${groupId}/feedbacks`, {
        method: 'POST',
        body: JSON.stringify({ target_member_id: targetId, content: content.trim() }),
      })
      const result = await readJson(res)
      if (!res.ok) {
        setFormMessage({ ok: false, text: getErrorMessage(res, result, '피드백을 보내지 못했습니다.') })
        return
      }
      setContent('')
      setFormMessage({ ok: true, text: '피드백을 남겼어요.' })
      reload()
    } catch {
      setFormMessage({ ok: false, text: '서버에 연결할 수 없습니다.' })
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="space-y-4">
      {isManager && (
        <div className="bg-surface rounded-xl shadow-md p-5 space-y-3">
          <p className="text-sm font-medium text-primary">피드백 남기기</p>
          {members.length === 0 ? (
            <p className="text-xs text-secondary">피드백을 남길 다른 멤버가 없어요.</p>
          ) : (
            <>
              <select
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                aria-label="피드백 받을 멤버"
              >
                {members.map((m) => (
                  <option key={m.group_member_id} value={m.group_member_id}>
                    {m.nickname ?? '알 수 없는 사용자'}
                  </option>
                ))}
              </select>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value.slice(0, CONTENT_MAX))}
                rows={3}
                placeholder="예: 이번 주 집중도가 많이 올랐어요! 오후 시간대만 조금 더 신경 써 봐요."
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                aria-label="피드백 내용"
              />
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-secondary">
                  {content.length}/{CONTENT_MAX}
                </span>
                <button
                  onClick={handleSend}
                  disabled={sending || !targetId || !content.trim()}
                  className="px-3 py-1.5 rounded-lg text-sm bg-primary text-white hover:bg-secondary disabled:opacity-50"
                >
                  {sending ? '보내는 중...' : '남기기'}
                </button>
              </div>
              {formMessage && (
                <p className={`text-xs ${formMessage.ok ? 'text-secondary' : 'text-red-600'}`}>{formMessage.text}</p>
              )}
            </>
          )}
        </div>
      )}

      <div className="bg-surface rounded-xl shadow-md p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <p className="text-sm font-medium text-primary">
            {isManager ? '그룹 피드백' : '나에게 온 피드백'} <span className="text-secondary">{total}</span>
          </p>
          {isManager && members.length > 0 && (
            <select
              value={filterMemberId}
              onChange={(e) => handleFilter(e.target.value)}
              className="border border-gray-300 rounded-lg px-2 py-1 text-xs"
              aria-label="멤버별 보기"
            >
              <option value="">전체 멤버</option>
              {members.map((m) => (
                <option key={m.group_member_id} value={m.group_member_id}>
                  {m.nickname ?? '알 수 없는 사용자'}
                </option>
              ))}
            </select>
          )}
        </div>

        {loading && <p className="text-sm text-secondary">불러오는 중...</p>}
        {error && (
          <div className="flex items-center gap-3">
            <p className="text-sm text-red-600">{error}</p>
            <button onClick={reload} className="text-sm text-secondary underline shrink-0">
              다시 시도
            </button>
          </div>
        )}
        {!loading && !error && feedbacks.length === 0 && (
          <p className="text-sm text-secondary">아직 피드백이 없어요.</p>
        )}

        <ul className="space-y-3">
          {feedbacks.map((f) => (
            <li key={f.feedback_id} className="bg-bg rounded-lg p-3">
              <p className="text-xs text-secondary mb-1">
                {f.manager_user.nickname ?? '알 수 없음'} → {f.target_user.nickname ?? '알 수 없음'} ·{' '}
                {new Date(f.created_at).toLocaleString('ko-KR', {
                  month: 'numeric',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </p>
              <p className="text-sm text-primary whitespace-pre-wrap break-words">{f.content}</p>
            </li>
          ))}
        </ul>
        {total > feedbacks.length && <p className="text-xs text-secondary mt-3">최근 100개까지만 보여요.</p>}
      </div>
    </div>
  )
}

export default FeedbackTab
