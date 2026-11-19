import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { apiFetch, readJson, getErrorMessage } from '../api'
import { GROUP_TYPE_LABEL, ROLE_LABEL, VISIBILITY_LABEL, type GroupDetail } from '../groups'
import MembersTab from '../components/group/MembersTab'
import GoalsTab from '../components/group/GoalsTab'
import FeedbackTab from '../components/group/FeedbackTab'

// 그룹 상세 화면 (/groups/:id, GET /api/groups/:id)
// 위쪽: 그룹 이름·소개·종류·내 역할 / 아래쪽: 탭
// 탭 내용은 components/group/ 아래 파일로 나눠 둔다

type Tab = 'members' | 'goals' | 'feedbacks'
const TAB_LABEL: Record<Tab, string> = { members: '멤버', goals: '목표', feedbacks: '피드백' }

type LoadResult = { ok: true; group: GroupDetail } | { ok: false; message: string }

async function loadGroup(groupId: string): Promise<LoadResult> {
  try {
    const res = await apiFetch(`/api/groups/${groupId}`)
    const result = await readJson(res)
    if (!res.ok) return { ok: false, message: getErrorMessage(res, result, '그룹 정보를 불러오지 못했습니다.') }
    return { ok: true, group: result.data }
  } catch {
    return { ok: false, message: '서버에 연결할 수 없습니다.' }
  }
}

function GroupDetailPage() {
  const { id: groupId = '' } = useParams()

  const [group, setGroup] = useState<GroupDetail | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)
  const [tab, setTab] = useState<Tab>('members')

  useEffect(() => {
    const fetchGroup = async () => {
      const result = await loadGroup(groupId)
      if (result.ok) setGroup(result.group)
      else setError(result.message)
      setLoading(false)
    }
    fetchGroup()
  }, [groupId, reloadKey])

  const handleRetry = () => {
    setError('')
    setLoading(true)
    setReloadKey((k) => k + 1)
  }

  return (
    <div className="min-h-screen bg-bg p-6">
      <Link to="/groups" className="text-sm text-secondary hover:text-primary">
        ← 그룹 목록
      </Link>

      <div className="max-w-2xl mt-3 space-y-4">
        {loading && <p className="text-secondary">불러오는 중...</p>}
        {error && (
          <div className="flex items-center gap-3">
            <p className="text-red-600">{error}</p>
            <button onClick={handleRetry} className="text-sm text-secondary underline shrink-0">
              다시 시도
            </button>
          </div>
        )}

        {group && (
          <>
            {/* 그룹 정보 */}
            <div className="bg-surface rounded-xl shadow-md p-5">
              <div className="flex items-center justify-between gap-3 mb-1">
                <h1 className="text-2xl font-bold text-primary truncate">{group.name}</h1>
                {group.my_role && (
                  <span className="text-xs text-white bg-accent rounded-full px-2 py-0.5 shrink-0">
                    {ROLE_LABEL[group.my_role]}
                  </span>
                )}
              </div>
              {group.description && (
                <p className="text-sm text-secondary whitespace-pre-wrap break-words mb-2">{group.description}</p>
              )}
              <p className="text-xs text-secondary">
                {GROUP_TYPE_LABEL[group.group_type]} · {VISIBILITY_LABEL[group.visibility]} · 멤버{' '}
                {group.member_count}명
              </p>
            </div>

            {/* 공개 그룹을 멤버가 아닌 사람이 보는 경우: 정보만 보여 준다 */}
            {!group.my_role ? (
              <p className="text-sm text-secondary bg-surface rounded-xl shadow-md p-5">
                이 그룹의 멤버가 아니에요. 가입하려면 방장·매니저에게 초대 코드를 받아{' '}
                <Link to="/groups" className="underline">
                  그룹 화면
                </Link>
                에서 입력해 주세요.
              </p>
            ) : (
              <>
                {/* 탭 */}
                <div className="flex rounded-lg border border-accent overflow-hidden text-sm w-max">
                  {(Object.keys(TAB_LABEL) as Tab[]).map((t) => (
                    <button
                      key={t}
                      onClick={() => setTab(t)}
                      className={`px-4 py-1.5 ${tab === t ? 'bg-primary text-white' : 'bg-surface text-secondary hover:bg-bg'}`}
                    >
                      {TAB_LABEL[t]}
                    </button>
                  ))}
                </div>

                {tab === 'members' && (
                  <MembersTab groupId={group.group_id} myRole={group.my_role} onGroupChanged={handleRetry} />
                )}
                {tab === 'goals' && <GoalsTab groupId={group.group_id} myRole={group.my_role} />}
                {tab === 'feedbacks' && <FeedbackTab groupId={group.group_id} myRole={group.my_role} />}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export default GroupDetailPage
