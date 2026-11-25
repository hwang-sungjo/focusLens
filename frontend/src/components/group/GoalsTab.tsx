import { useEffect, useState } from 'react'
import { apiFetch, readJson, getErrorMessage } from '../../api'
import {
  GOAL_STATUS_LABEL,
  isManagerRole,
  loadGroupMembers,
  type GroupGoal,
  type GroupMember,
  type GroupRole,
} from '../../groups'

// 그룹 상세 > 목표 탭
// - 목표 목록 GET /api/groups/:id/goals: 멤버 누구나
// - 목표 만들기 POST /api/groups/:id/goals: 방장·매니저
// - 담당 지정 POST /api/groups/:id/goals/:goalId/assignees: 방장·매니저
//   · 담당자가 0명이면 "그룹 전체 대상" 목표
//   · 이미 담당인 멤버를 다시 넣으면 409, 빈 배열을 보내면 담당을 모두 풀고 전체 대상으로 되돌린다
// 서버에 없는 것: 달성률(지금까지 몇 분 했는지), 목표 수정·완료·삭제, 현재 담당자 명단(인원 수만 옴)

type LoadResult = { ok: true; goals: GroupGoal[]; total: number } | { ok: false; message: string }

async function loadGoals(groupId: string): Promise<LoadResult> {
  try {
    const res = await apiFetch(`/api/groups/${groupId}/goals?limit=100`)
    const result = await readJson(res)
    if (!res.ok) return { ok: false, message: getErrorMessage(res, result, '목표를 불러오지 못했습니다.') }
    return { ok: true, goals: result.data.goals, total: result.data.pagination?.total ?? result.data.goals.length }
  } catch {
    return { ok: false, message: '서버에 연결할 수 없습니다.' }
  }
}

// 오늘 날짜 YYYY-MM-DD (한국 시간 기준, 날짜 입력 칸 기본값용)
function todayString() {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function formatTarget(goal: GroupGoal) {
  const parts: string[] = []
  if (goal.target_study_minutes !== null) {
    const h = Math.floor(goal.target_study_minutes / 60)
    const m = goal.target_study_minutes % 60
    parts.push(`학습 ${h > 0 ? `${h}시간 ` : ''}${m > 0 || h === 0 ? `${m}분` : ''}`.trim())
  }
  if (goal.target_focus_score !== null) parts.push(`집중도 ${goal.target_focus_score}점 이상`)
  return parts.length > 0 ? parts.join(' · ') : '목표 수치 없음'
}

interface GoalsTabProps {
  groupId: string
  myRole: GroupRole
}

function GoalsTab({ groupId, myRole }: GoalsTabProps) {
  const isManager = isManagerRole(myRole)

  const [goals, setGoals] = useState<GroupGoal[]>([])
  const [total, setTotal] = useState(0)
  const [members, setMembers] = useState<GroupMember[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)

  // 만들기 폼
  const [formOpen, setFormOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [targetMinutes, setTargetMinutes] = useState('')
  const [targetScore, setTargetScore] = useState('')
  const [startDate, setStartDate] = useState(todayString())
  const [endDate, setEndDate] = useState(todayString())
  const [creating, setCreating] = useState(false)
  const [formError, setFormError] = useState('')

  // 담당 지정: 열려 있는 목표 ID와 고른 멤버
  const [assignGoalId, setAssignGoalId] = useState<string | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [assigning, setAssigning] = useState(false)
  const [assignMessage, setAssignMessage] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    const fetchGoals = async () => {
      const result = await loadGoals(groupId)
      if (result.ok) {
        setGoals(result.goals)
        setTotal(result.total)
      } else {
        setError(result.message)
      }
      setLoading(false)
    }
    fetchGoals()
  }, [groupId, reloadKey])

  // 방장·매니저만: 담당 지정에 쓸 멤버 명단
  useEffect(() => {
    if (!isManager) return
    const fetchMembers = async () => {
      setMembers(await loadGroupMembers(groupId))
    }
    fetchMembers()
  }, [groupId, isManager])

  const reload = () => {
    setError('')
    setReloadKey((k) => k + 1)
  }

  const handleCreate = async () => {
    setFormError('')
    const minutes = targetMinutes.trim() ? Number(targetMinutes) : null
    const score = targetScore.trim() ? Number(targetScore) : null
    // 서버 검사와 같은 규칙을 먼저 확인한다
    if (minutes !== null && (!Number.isInteger(minutes) || minutes < 1)) {
      setFormError('목표 학습 시간은 1 이상의 정수(분)로 넣어 주세요.')
      return
    }
    if (score !== null && (Number.isNaN(score) || score < 0 || score > 100)) {
      setFormError('목표 집중도는 0~100 사이로 넣어 주세요.')
      return
    }
    if (endDate < startDate) {
      setFormError('끝나는 날은 시작하는 날과 같거나 뒤여야 해요.')
      return
    }
    setCreating(true)
    try {
      const res = await apiFetch(`/api/groups/${groupId}/goals`, {
        method: 'POST',
        body: JSON.stringify({
          title: title.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
          target_study_minutes: minutes,
          target_focus_score: score,
          start_date: startDate,
          end_date: endDate,
        }),
      })
      const result = await readJson(res)
      if (!res.ok) {
        setFormError(getErrorMessage(res, result, '목표를 만들지 못했습니다.'))
        return
      }
      setTitle('')
      setDescription('')
      setTargetMinutes('')
      setTargetScore('')
      setFormOpen(false)
      reload()
    } catch {
      setFormError('서버에 연결할 수 없습니다.')
    } finally {
      setCreating(false)
    }
  }

  const openAssign = (goalId: string) => {
    setAssignGoalId(goalId === assignGoalId ? null : goalId)
    setPicked(new Set())
    setAssignMessage(null)
  }

  const togglePick = (memberId: string) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(memberId)) next.delete(memberId)
      else next.add(memberId)
      return next
    })

  // memberIds가 비어 있으면 담당을 모두 풀고 그룹 전체 대상으로 되돌린다
  const submitAssign = async (goalId: string, memberIds: string[]) => {
    setAssignMessage(null)
    setAssigning(true)
    try {
      const res = await apiFetch(`/api/groups/${groupId}/goals/${goalId}/assignees`, {
        method: 'POST',
        body: JSON.stringify({ group_member_ids: memberIds }),
      })
      const result = await readJson(res)
      if (!res.ok) {
        setAssignMessage({ ok: false, text: getErrorMessage(res, result, '담당을 지정하지 못했습니다.') })
        return
      }
      setAssignMessage({
        ok: true,
        text: memberIds.length === 0 ? '그룹 전체 대상으로 바꿨어요.' : `${memberIds.length}명을 담당으로 지정했어요.`,
      })
      setPicked(new Set())
      reload()
    } catch {
      setAssignMessage({ ok: false, text: '서버에 연결할 수 없습니다.' })
    } finally {
      setAssigning(false)
    }
  }

  const inputClass = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm'

  return (
    <div className="space-y-4">
      {isManager && (
        <div className="bg-surface rounded-xl shadow-md p-5">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-primary">목표 만들기</p>
            <button onClick={() => setFormOpen((v) => !v)} className="text-sm text-secondary underline">
              {formOpen ? '닫기' : '+ 새 목표'}
            </button>
          </div>

          {formOpen && (
            <div className="space-y-3 mt-3">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value.slice(0, 200))}
                placeholder="목표 이름 (필수) 예: 이번 주 각자 10시간"
                className={inputClass}
                aria-label="목표 이름"
              />
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value.slice(0, 1000))}
                placeholder="설명 (선택)"
                rows={2}
                className={inputClass}
                aria-label="목표 설명"
              />
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="goal-minutes" className="block text-xs text-secondary mb-1">
                    목표 학습 시간 (분, 선택)
                  </label>
                  <input
                    id="goal-minutes"
                    type="number"
                    min={1}
                    value={targetMinutes}
                    onChange={(e) => setTargetMinutes(e.target.value)}
                    placeholder="예: 600"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label htmlFor="goal-score" className="block text-xs text-secondary mb-1">
                    목표 집중도 (0~100, 선택)
                  </label>
                  <input
                    id="goal-score"
                    type="number"
                    min={0}
                    max={100}
                    value={targetScore}
                    onChange={(e) => setTargetScore(e.target.value)}
                    placeholder="예: 80"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label htmlFor="goal-start" className="block text-xs text-secondary mb-1">
                    시작
                  </label>
                  <input
                    id="goal-start"
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label htmlFor="goal-end" className="block text-xs text-secondary mb-1">
                    끝
                  </label>
                  <input
                    id="goal-end"
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className={inputClass}
                  />
                </div>
              </div>
              {formError && <p className="text-xs text-red-600">{formError}</p>}
              <button
                onClick={handleCreate}
                disabled={creating || !title.trim() || !startDate || !endDate}
                className="w-full bg-primary text-white rounded-lg px-4 py-2 text-sm hover:bg-secondary disabled:opacity-50"
              >
                {creating ? '만드는 중...' : '목표 만들기'}
              </button>
            </div>
          )}
        </div>
      )}

      {loading && <p className="text-secondary">불러오는 중...</p>}
      {error && (
        <div className="flex items-center gap-3">
          <p className="text-red-600">{error}</p>
          <button onClick={reload} className="text-sm text-secondary underline shrink-0">
            다시 시도
          </button>
        </div>
      )}
      {!loading && !error && goals.length === 0 && (
        <p className="text-sm text-secondary bg-surface rounded-xl shadow-md p-5 text-center">아직 목표가 없어요.</p>
      )}

      {goals.map((goal) => (
        <div key={goal.goal_id} className="bg-surface rounded-xl shadow-md p-5">
          <div className="flex items-start justify-between gap-3 mb-1">
            <p className="font-medium text-primary break-words">{goal.title}</p>
            <span className="text-xs text-white bg-accent rounded-full px-2 py-0.5 shrink-0">
              {GOAL_STATUS_LABEL[goal.status]}
            </span>
          </div>
          {goal.description && (
            <p className="text-sm text-secondary whitespace-pre-wrap break-words mb-2">{goal.description}</p>
          )}
          <p className="text-sm text-primary">{formatTarget(goal)}</p>
          <p className="text-xs text-secondary mt-1">
            {goal.start_date} ~ {goal.end_date} ·{' '}
            {goal.assignee_count === 0 ? '그룹 전체 대상' : `담당 ${goal.assignee_count}명`}
            {goal.is_assigned_to_me && goal.assignee_count > 0 && ' · 나에게 배정됨'}
          </p>

          {isManager && (
            <div className="mt-3">
              <button onClick={() => openAssign(goal.goal_id)} className="text-xs text-secondary underline">
                {assignGoalId === goal.goal_id ? '담당 지정 닫기' : '담당 지정'}
              </button>

              {assignGoalId === goal.goal_id && (
                <div className="bg-bg rounded-lg p-3 mt-2 space-y-2">
                  <p className="text-xs text-secondary">
                    추가로 담당할 멤버를 고르세요. 서버가 현재 담당자 명단은 주지 않아서, 이미 담당인 멤버를 고르면
                    &quot;이미 배정된 멤버&quot;라고 나와요.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {members.map((m) => (
                      <label
                        key={m.group_member_id}
                        className="flex items-center gap-1 text-sm text-primary bg-surface rounded-full px-3 py-1"
                      >
                        <input
                          type="checkbox"
                          checked={picked.has(m.group_member_id)}
                          onChange={() => togglePick(m.group_member_id)}
                        />
                        {m.nickname ?? '알 수 없는 사용자'}
                      </label>
                    ))}
                  </div>
                  {assignMessage && (
                    <p className={`text-xs ${assignMessage.ok ? 'text-secondary' : 'text-red-600'}`}>
                      {assignMessage.text}
                    </p>
                  )}
                  <div className="flex gap-2">
                    <button
                      onClick={() => submitAssign(goal.goal_id, [...picked])}
                      disabled={assigning || picked.size === 0}
                      className="px-3 py-1 rounded-lg text-xs bg-primary text-white hover:bg-secondary disabled:opacity-50"
                    >
                      {picked.size > 0 ? `${picked.size}명 지정` : '지정'}
                    </button>
                    {goal.assignee_count > 0 && (
                      <button
                        onClick={() => submitAssign(goal.goal_id, [])}
                        disabled={assigning}
                        className="px-3 py-1 rounded-lg text-xs border border-accent text-secondary hover:bg-surface disabled:opacity-50"
                      >
                        전체 대상으로 되돌리기
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      ))}

      {total > goals.length && <p className="text-xs text-secondary">최근 100개까지만 보여요.</p>}
      {goals.length > 0 && (
        <p className="text-xs text-secondary">
          달성률(지금까지 한 양)과 목표 수정·완료 처리는 아직 서버에서 지원하지 않아요.
        </p>
      )}
    </div>
  )
}

export default GoalsTab
