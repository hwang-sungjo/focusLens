import { useEffect, useState } from 'react'
import { apiFetch, readJson, getErrorMessage } from '../../api'
import { ROLE_LABEL, formatStudyTime, isManagerRole, type GroupMember, type GroupRole } from '../../groups'
import InvitePanel from './InvitePanel'

// 그룹 상세 > 멤버 탭 (GET /api/groups/:id/dashboard)
// - 방장·매니저: 전체 멤버의 학습 현황
// - 일반 멤버: 서버가 내 줄만 보내 준다 (scope = 'self')
// - "그룹 데이터 공유"를 끈 멤버는 서버가 학습 기록을 0·null로 보낸다
// - 학습 기록은 그룹 가입 이후가 아니라 그 사람의 전체 기간 누적이다 (서버 계산 방식)
//
// 멤버 관리 (서버 권한 규칙 그대로):
// - 초대: 방장·매니저 (InvitePanel)
// - 역할 변경 PATCH /members/:memberId: 방장만. 다른 사람을 방장으로 바꾸면 방장이 넘어가고 나는 매니저가 된다
// - 내보내기 DELETE /members/:memberId: 방장·매니저. 방장은 내보낼 수 없고, 매니저는 다른 매니저를 내보낼 수 없다

type LoadResult =
  | { ok: true; members: GroupMember[]; scope: 'all_members' | 'self'; total: number }
  | { ok: false; message: string }

async function loadDashboard(groupId: string): Promise<LoadResult> {
  try {
    const res = await apiFetch(`/api/groups/${groupId}/dashboard?limit=100`)
    const result = await readJson(res)
    if (!res.ok)
      return { ok: false, message: getErrorMessage(res, result, '멤버 현황을 불러오지 못했습니다.') }
    const d = result.data
    return { ok: true, members: d.members, scope: d.scope, total: d.pagination?.total ?? d.members.length }
  } catch {
    return { ok: false, message: '서버에 연결할 수 없습니다.' }
  }
}

interface MembersTabProps {
  groupId: string
  myRole: GroupRole
  onGroupChanged: () => void // 내 역할·인원 수가 바뀌었을 때 위쪽 그룹 정보를 다시 불러오게 한다
}

// 되돌리기 어려운 동작(내보내기, 방장 넘기기)은 버튼을 한 번 더 눌러야 실행한다
type Confirm = { memberId: string; action: 'remove' | 'owner' } | null

function MembersTab({ groupId, myRole, onGroupChanged }: MembersTabProps) {
  const myUserId = localStorage.getItem('user_id')

  const [members, setMembers] = useState<GroupMember[]>([])
  const [scope, setScope] = useState<'all_members' | 'self'>('self')
  const [total, setTotal] = useState(0)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [actingId, setActingId] = useState<string | null>(null) // 처리 중인 멤버
  const [actionError, setActionError] = useState('')

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

  // 서버 규칙에 맞춰, 이 멤버에게 내가 할 수 있는 일을 정한다
  const canChangeRole = (m: GroupMember) => myRole === 'OWNER' && m.group_role !== 'OWNER'
  const canRemove = (m: GroupMember) =>
    m.user_id !== myUserId &&
    m.group_role !== 'OWNER' &&
    (myRole === 'OWNER' || (myRole === 'MANAGER' && m.group_role === 'MEMBER'))

  // 처리 뒤 목록·그룹 정보를 서버와 다시 맞춘다
  const refreshAll = () => {
    setReloadKey((k) => k + 1)
    onGroupChanged()
  }

  const changeRole = async (m: GroupMember, role: GroupRole) => {
    setActionError('')
    setActingId(m.group_member_id)
    try {
      const res = await apiFetch(`/api/groups/${groupId}/members/${m.group_member_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ group_role: role }),
      })
      if (!res.ok) {
        const result = await readJson(res)
        setActionError(getErrorMessage(res, result, '역할을 바꾸지 못했습니다.'))
      }
      refreshAll()
    } catch {
      setActionError('서버에 연결할 수 없습니다.')
    } finally {
      setActingId(null)
      setConfirm(null)
    }
  }

  const removeMember = async (m: GroupMember) => {
    setActionError('')
    setActingId(m.group_member_id)
    try {
      const res = await apiFetch(`/api/groups/${groupId}/members/${m.group_member_id}`, { method: 'DELETE' })
      if (!res.ok) {
        const result = await readJson(res)
        setActionError(getErrorMessage(res, result, '내보내지 못했습니다.'))
      }
      refreshAll()
    } catch {
      setActionError('서버에 연결할 수 없습니다.')
    } finally {
      setActingId(null)
      setConfirm(null)
    }
  }

  // 역할 선택: 방장으로 바꾸는 것만 한 번 더 확인한다
  const handleRoleSelect = (m: GroupMember, role: GroupRole) => {
    if (role === m.group_role) return
    if (role === 'OWNER') setConfirm({ memberId: m.group_member_id, action: 'owner' })
    else changeRole(m, role)
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
    <div className="space-y-4">
      {isManagerRole(myRole) && (
        <InvitePanel groupId={groupId} memberUserIds={members.map((m) => m.user_id)} />
      )}

      <div className="bg-surface rounded-xl shadow-md p-5">
        <p className="text-sm font-medium text-primary mb-1">
          {scope === 'all_members' ? `멤버 현황 ${total}명` : '내 현황'}
        </p>
        <p className="text-xs text-secondary mb-4">
          {isManagerRole(myRole)
            ? '전체 기간 누적 기록이에요. "그룹 데이터 공유"를 끈 멤버는 기록이 0으로 보여요.'
            : '전체 멤버 현황은 방장·매니저만 볼 수 있어요. 아래는 내 전체 기간 누적 기록이에요.'}
        </p>
        {actionError && <p className="text-xs text-red-600 mb-2">{actionError}</p>}

        <ul className="divide-y divide-bg">
          {members.map((m) => {
            const isMe = m.user_id === myUserId
            const acting = actingId === m.group_member_id
            const confirming = confirm?.memberId === m.group_member_id ? confirm.action : null
            return (
              <li key={m.group_member_id} className="py-3">
                <div className="flex items-center gap-3">
                  {m.profile_image_url ? (
                    <img
                      src={m.profile_image_url}
                      alt=""
                      className="w-8 h-8 rounded-full object-cover shrink-0"
                    />
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
                    <p className="text-sm font-medium text-primary">
                      {formatStudyTime(m.total_study_seconds)}
                    </p>
                    <p className="text-xs text-secondary">
                      {m.avg_focus_score !== null ? `평균 ${m.avg_focus_score.toFixed(1)}점` : '점수 없음'}
                    </p>
                  </div>
                </div>

                {/* 관리 버튼 (할 수 있는 일이 있을 때만) */}
                {(canChangeRole(m) || canRemove(m)) && (
                  <div className="flex items-center justify-end gap-2 mt-2">
                    {confirming === 'owner' && (
                      <>
                        <span className="text-xs text-red-600">방장을 넘기면 나는 매니저가 돼요.</span>
                        <button
                          onClick={() => changeRole(m, 'OWNER')}
                          disabled={acting}
                          className="px-2 py-0.5 rounded-lg text-xs bg-red-600 text-white disabled:opacity-50"
                        >
                          넘기기
                        </button>
                        <button onClick={() => setConfirm(null)} className="text-xs text-secondary underline">
                          취소
                        </button>
                      </>
                    )}
                    {confirming === 'remove' && (
                      <>
                        <span className="text-xs text-red-600">내보낼까요?</span>
                        <button
                          onClick={() => removeMember(m)}
                          disabled={acting}
                          className="px-2 py-0.5 rounded-lg text-xs bg-red-600 text-white disabled:opacity-50"
                        >
                          내보내기
                        </button>
                        <button onClick={() => setConfirm(null)} className="text-xs text-secondary underline">
                          취소
                        </button>
                      </>
                    )}
                    {!confirming && (
                      <>
                        {canChangeRole(m) && (
                          <select
                            value={m.group_role}
                            onChange={(e) => handleRoleSelect(m, e.target.value as GroupRole)}
                            disabled={acting}
                            aria-label={`${m.nickname ?? '멤버'} 역할`}
                            className="border border-gray-300 rounded-lg px-2 py-0.5 text-xs"
                          >
                            <option value="MEMBER">멤버</option>
                            <option value="MANAGER">매니저</option>
                            <option value="OWNER">방장으로 넘기기</option>
                          </select>
                        )}
                        {canRemove(m) && (
                          <button
                            onClick={() => setConfirm({ memberId: m.group_member_id, action: 'remove' })}
                            disabled={acting}
                            className="px-2 py-0.5 rounded-lg text-xs text-red-600 border border-red-300 hover:bg-red-50 disabled:opacity-50"
                          >
                            내보내기
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
        {total > members.length && <p className="text-xs text-secondary mt-3">처음 100명까지만 보여요.</p>}
      </div>
    </div>
  )
}

export default MembersTab
