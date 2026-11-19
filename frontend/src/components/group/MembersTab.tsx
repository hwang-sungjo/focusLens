import { useEffect, useState } from 'react'
import { apiFetch, readJson, getErrorMessage } from '../../api'
import { ROLE_LABEL, formatStudyTime, isManagerRole, type GroupMember, type GroupRole } from '../../groups'

// 그룹 상세 > 멤버 탭 (GET /api/groups/:id/dashboard)
// - 방장·매니저: 전체 멤버의 학습 현황
// - 일반 멤버: 서버가 내 줄만 보내 준다 (scope = 'self')
// - "그룹 데이터 공유"를 끈 멤버는 서버가 학습 기록을 0·null로 보낸다
// - 학습 기록은 그룹 가입 이후가 아니라 그 사람의 전체 기간 누적이다 (서버 계산 방식)

type LoadResult =
  | { ok: true; members: GroupMember[]; scope: 'all_members' | 'self'; total: number }
  | { ok: false; message: string }

async function loadDashboard(groupId: string): Promise<LoadResult> {
  try {
    const res = await apiFetch(`/api/groups/${groupId}/dashboard?limit=100`)
    const result = await readJson(res)
    if (!res.ok) return { ok: false, message: getErrorMessage(res, result, '멤버 현황을 불러오지 못했습니다.') }
    const d = result.data
    return { ok: true, members: d.members, scope: d.scope, total: d.pagination?.total ?? d.members.length }
  } catch {
    return { ok: false, message: '서버에 연결할 수 없습니다.' }
  }
}

interface MembersTabProps {
  groupId: string
  myRole: GroupRole
}

function MembersTab({ groupId, myRole }: MembersTabProps) {
  const myUserId = localStorage.getItem('user_id')

  const [members, setMembers] = useState<GroupMember[]>([])
  const [scope, setScope] = useState<'all_members' | 'self'>('self')
  const [total, setTotal] = useState(0)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    const fetchDashboard = async () => {
      const result = await loadDashboard(groupId)
      if (result.ok) {
        setMembers(result.members)
        setScope(result.scope)
        setTotal(result.total)
      } else {
        setError(result.message)
      }
      setLoading(false)
    }
    fetchDashboard()
  }, [groupId, reloadKey])

  const handleRetry = () => {
    setError('')
    setLoading(true)
    setReloadKey((k) => k + 1)
  }

  if (loading) return <p className="text-secondary">불러오는 중...</p>
  if (error)
    return (
      <div className="flex items-center gap-3">
        <p className="text-red-600">{error}</p>
        <button onClick={handleRetry} className="text-sm text-secondary underline shrink-0">
          다시 시도
        </button>
      </div>
    )

  return (
    <div className="bg-surface rounded-xl shadow-md p-5">
      <p className="text-sm font-medium text-primary mb-1">
        {scope === 'all_members' ? `멤버 현황 ${total}명` : '내 현황'}
      </p>
      <p className="text-xs text-secondary mb-4">
        {isManagerRole(myRole)
          ? '전체 기간 누적 기록이에요. "그룹 데이터 공유"를 끈 멤버는 기록이 0으로 보여요.'
          : '전체 멤버 현황은 방장·매니저만 볼 수 있어요. 아래는 내 전체 기간 누적 기록이에요.'}
      </p>

      <ul className="divide-y divide-bg">
        {members.map((m) => {
          const isMe = m.user_id === myUserId
          return (
            <li key={m.group_member_id} className="flex items-center gap-3 py-3">
              {m.profile_image_url ? (
                <img src={m.profile_image_url} alt="" className="w-8 h-8 rounded-full object-cover shrink-0" />
              ) : (
                <span className="w-8 h-8 rounded-full bg-accent text-white flex items-center justify-center text-sm shrink-0">
                  👤
                </span>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm text-primary truncate">
                  {m.nickname ?? '알 수 없는 사용자'}
                  {isMe && <span className="ml-1 text-xs text-secondary">(나)</span>}
                </p>
                <p className="text-xs text-secondary">
                  {ROLE_LABEL[m.group_role]} · 세션 {m.total_sessions}개
                  {m.last_session_at &&
                    ` · 최근 ${new Date(m.last_session_at).toLocaleDateString('ko-KR', {
                      month: 'numeric',
                      day: 'numeric',
                    })}`}
                </p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-sm font-medium text-primary">{formatStudyTime(m.total_study_seconds)}</p>
                <p className="text-xs text-secondary">
                  {m.avg_focus_score !== null ? `평균 ${m.avg_focus_score.toFixed(1)}점` : '점수 없음'}
                </p>
              </div>
            </li>
          )
        })}
      </ul>
      {total > members.length && <p className="text-xs text-secondary mt-3">처음 100명까지만 보여요.</p>}
    </div>
  )
}

export default MembersTab
