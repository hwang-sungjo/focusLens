import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { apiFetch, readJson, getErrorMessage } from '../api'
import {
  GROUP_TYPE_LABEL,
  ROLE_LABEL,
  VISIBILITY_LABEL,
  type GroupSummary,
  type GroupType,
  type GroupVisibility,
} from '../groups'

// 그룹 목록 화면 (GET /api/groups, POST /api/groups, POST /api/groups/join)
// - 내가 속한 그룹 목록
// - 새 그룹 만들기 → 만든 사람이 방장(OWNER)
// - 초대 코드로 가입: "받은 초대 목록" API가 없어서, 초대한 사람이 코드를 직접 전달해 주면 여기에 입력한다

type LoadResult = { ok: true; groups: GroupSummary[] } | { ok: false; message: string }

async function loadMyGroups(): Promise<LoadResult> {
  try {
    const res = await apiFetch('/api/groups?limit=100')
    const result = await readJson(res)
    if (!res.ok) return { ok: false, message: getErrorMessage(res, result, '그룹 목록을 불러오지 못했습니다.') }
    return { ok: true, groups: result.data.groups }
  } catch {
    return { ok: false, message: '서버에 연결할 수 없습니다.' }
  }
}

const NAME_MAX = 100
const DESCRIPTION_MAX = 1000

function GroupsPage() {
  const navigate = useNavigate()

  const [groups, setGroups] = useState<GroupSummary[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)

  // 만들기 폼
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [groupType, setGroupType] = useState<GroupType>('STUDY')
  const [visibility, setVisibility] = useState<GroupVisibility>('PRIVATE')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')

  // 코드로 가입
  const [inviteCode, setInviteCode] = useState('')
  const [joining, setJoining] = useState(false)
  const [joinError, setJoinError] = useState('')

  useEffect(() => {
    const fetchGroups = async () => {
      const result = await loadMyGroups()
      if (result.ok) setGroups(result.groups)
      else setError(result.message)
      setLoading(false)
    }
    fetchGroups()
  }, [reloadKey])

  const handleRetry = () => {
    setError('')
    setLoading(true)
    setReloadKey((k) => k + 1)
  }

  const handleCreate = async () => {
    setCreateError('')
    setCreating(true)
    try {
      const res = await apiFetch('/api/groups', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
          group_type: groupType,
          visibility,
        }),
      })
      const result = await readJson(res)
      if (!res.ok) {
        setCreateError(getErrorMessage(res, result, '그룹을 만들지 못했습니다.'))
        return
      }
      navigate(`/groups/${result.data.group_id}`) // 만든 그룹 화면으로 이동
    } catch {
      setCreateError('서버에 연결할 수 없습니다.')
    } finally {
      setCreating(false)
    }
  }

  const handleJoin = async () => {
    setJoinError('')
    setJoining(true)
    try {
      const res = await apiFetch('/api/groups/join', {
        method: 'POST',
        body: JSON.stringify({ invite_code: inviteCode.trim() }),
      })
      const result = await readJson(res)
      if (!res.ok) {
        // 403: 다른 사람에게 발급된 코드 (초대장은 받는 사람이 정해져 있다)
        setJoinError(
          res.status === 403
            ? '이 초대 코드는 다른 사람에게 발급된 코드예요. 초대한 사람에게 내 이메일이나 ID로 다시 초대해 달라고 해 주세요.'
            : getErrorMessage(res, result, '가입하지 못했습니다.'),
        )
        return
      }
      navigate(`/groups/${result.data.group_id}`)
    } catch {
      setJoinError('서버에 연결할 수 없습니다.')
    } finally {
      setJoining(false)
    }
  }

  const inputClass = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm'

  return (
    <div className="min-h-screen bg-bg p-6">
      <div className="max-w-2xl flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-primary">그룹</h1>
        <button
          onClick={() => setCreateOpen((v) => !v)}
          className="px-3 py-1.5 rounded-lg text-sm bg-primary text-white hover:bg-secondary"
        >
          {createOpen ? '닫기' : '+ 새 그룹'}
        </button>
      </div>

      <div className="max-w-2xl space-y-4">
        {/* 새 그룹 만들기 */}
        {createOpen && (
          <div className="bg-surface rounded-xl shadow-md p-5 space-y-3">
            <p className="text-sm font-medium text-primary">새 그룹 만들기</p>
            <div>
              <label htmlFor="group-name" className="block text-xs text-secondary mb-1">
                이름 (필수)
              </label>
              <input
                id="group-name"
                value={name}
                onChange={(e) => setName(e.target.value.slice(0, NAME_MAX))}
                placeholder="예: CV 기말 스터디"
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="group-desc" className="block text-xs text-secondary mb-1">
                소개 (선택)
              </label>
              <textarea
                id="group-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value.slice(0, DESCRIPTION_MAX))}
                rows={2}
                className={inputClass}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="group-type" className="block text-xs text-secondary mb-1">
                  종류
                </label>
                <select
                  id="group-type"
                  value={groupType}
                  onChange={(e) => setGroupType(e.target.value as GroupType)}
                  className={inputClass}
                >
                  {(Object.keys(GROUP_TYPE_LABEL) as GroupType[]).map((t) => (
                    <option key={t} value={t}>
                      {GROUP_TYPE_LABEL[t]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="group-visibility" className="block text-xs text-secondary mb-1">
                  공개 여부
                </label>
                <select
                  id="group-visibility"
                  value={visibility}
                  onChange={(e) => setVisibility(e.target.value as GroupVisibility)}
                  className={inputClass}
                >
                  <option value="PRIVATE">비공개</option>
                  <option value="PUBLIC">공개</option>
                </select>
              </div>
            </div>
            <p className="text-xs text-secondary">
              공개 그룹은 멤버가 아니어도 그룹 정보를 볼 수 있어요. 가입은 공개·비공개 모두 초대 코드로만 할 수 있어요.
            </p>
            {createError && <p className="text-sm text-red-600">{createError}</p>}
            <button
              onClick={handleCreate}
              disabled={creating || !name.trim()}
              className="w-full bg-primary text-white rounded-lg px-4 py-2 text-sm hover:bg-secondary disabled:opacity-50"
            >
              {creating ? '만드는 중...' : '만들기'}
            </button>
          </div>
        )}

        {/* 초대 코드로 가입 */}
        <div className="bg-surface rounded-xl shadow-md p-5">
          <label htmlFor="invite-code" className="block text-sm font-medium text-primary mb-1">
            초대 코드로 가입
          </label>
          <p className="text-xs text-secondary mb-2">방장·매니저에게 받은 초대 코드를 붙여넣어 주세요.</p>
          <div className="flex gap-2">
            <input
              id="invite-code"
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              placeholder="초대 코드"
              className="flex-1 min-w-0 border border-gray-300 rounded-lg px-3 py-1.5 text-sm"
            />
            <button
              onClick={handleJoin}
              disabled={joining || !inviteCode.trim()}
              className="px-3 py-1.5 rounded-lg text-sm bg-primary text-white hover:bg-secondary disabled:opacity-50 shrink-0"
            >
              {joining ? '가입 중...' : '가입'}
            </button>
          </div>
          {joinError && <p className="text-xs text-red-600 mt-1">{joinError}</p>}
        </div>

        {/* 내 그룹 목록 */}
        {loading && <p className="text-secondary">불러오는 중...</p>}
        {error && (
          <div className="flex items-center gap-3">
            <p className="text-red-600">{error}</p>
            <button onClick={handleRetry} className="text-sm text-secondary underline shrink-0">
              다시 시도
            </button>
          </div>
        )}
        {!loading && !error && groups.length === 0 && (
          <div className="bg-surface rounded-xl shadow-md p-6 text-center">
            <p className="text-sm text-secondary">아직 속한 그룹이 없어요.</p>
            <p className="text-xs text-secondary mt-1">새 그룹을 만들거나 초대 코드로 가입해 보세요.</p>
          </div>
        )}
        {groups.map((g) => (
          <Link
            key={g.group_id}
            to={`/groups/${g.group_id}`}
            className="block bg-surface rounded-xl shadow-md p-5 hover:ring-2 hover:ring-accent"
          >
            <div className="flex items-center justify-between gap-3 mb-1">
              <p className="font-medium text-primary truncate">{g.name}</p>
              <span className="text-xs text-white bg-accent rounded-full px-2 py-0.5 shrink-0">
                {ROLE_LABEL[g.my_role]}
              </span>
            </div>
            {g.description && <p className="text-sm text-secondary truncate mb-1">{g.description}</p>}
            <p className="text-xs text-secondary">
              {GROUP_TYPE_LABEL[g.group_type]} · {VISIBILITY_LABEL[g.visibility]} · 멤버 {g.member_count}명
            </p>
          </Link>
        ))}
      </div>
    </div>
  )
}

export default GroupsPage
