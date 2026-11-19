import { useEffect, useState } from 'react'
import { apiFetch, readJson, getErrorMessage } from '../api'

// 랭킹 화면 (GET /api/rankings, docs/api-spec.md)
// - 누구끼리(scope) · 기간(period) · 기준(metric) 세 가지를 골라 순위를 본다
// - 서버는 상위 50명과 내 순위(my_rank)를 함께 돌려준다
// - 프로필에서 "랭킹 참여"를 끈 사용자는 서버가 순위에서 뺀다

type Scope = 'global' | 'friends' | 'group'
type Period = 'daily' | 'weekly'
type Metric = 'focus_score' | 'study_time'

interface RankingRow {
  rank: number
  user_id: string
  nickname: string
  profile_image_url: string | null
  value: number // focus_score면 평균 점수, study_time이면 초
  session_count: number
}

interface RankingData {
  rankings: RankingRow[]
  my_rank: { rank: number; value: number } | null
}

interface MyGroup {
  group_id: string
  name: string
}

const SCOPE_LABEL: Record<Scope, string> = { global: '전체', friends: '친구', group: '그룹' }
// 서버는 UTC 날짜 기준으로 집계한다 (daily = 오늘 오전 9시부터, weekly = 최근 7일)
const PERIOD_LABEL: Record<Period, string> = { daily: '오늘', weekly: '최근 7일' }
const METRIC_LABEL: Record<Metric, string> = { focus_score: '집중도', study_time: '학습 시간' }

const MEDAL: Record<number, string> = { 1: '🥇', 2: '🥈', 3: '🥉' }

function formatValue(metric: Metric, value: number) {
  if (metric === 'focus_score') return `${value.toFixed(1)}점`
  const hours = Math.floor(value / 3600)
  const minutes = Math.floor((value % 3600) / 60)
  return hours > 0 ? `${hours}시간 ${minutes}분` : `${minutes}분`
}

// 탭 버튼 묶음 (대시보드 주간/월간 탭과 같은 모양)
function TabGroup<T extends string>({
  options,
  labels,
  value,
  onChange,
}: {
  options: T[]
  labels: Record<T, string>
  value: T
  onChange: (next: T) => void
}) {
  return (
    <div className="flex rounded-lg border border-accent overflow-hidden text-sm">
      {options.map((opt) => (
        <button
          key={opt}
          onClick={() => onChange(opt)}
          className={`px-3 py-1 ${value === opt ? 'bg-primary text-white' : 'text-secondary hover:bg-bg'}`}
        >
          {labels[opt]}
        </button>
      ))}
    </div>
  )
}

function RankingPage() {
  const myUserId = localStorage.getItem('user_id')

  const [scope, setScope] = useState<Scope>('global')
  const [period, setPeriod] = useState<Period>('weekly')
  const [metric, setMetric] = useState<Metric>('focus_score')
  const [groupId, setGroupId] = useState('')

  const [data, setData] = useState<RankingData | null>(null)
  const [myGroups, setMyGroups] = useState<MyGroup[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)

  // 그룹 랭킹에서 고를 수 있게 내가 속한 그룹 목록을 한 번 불러온다
  useEffect(() => {
    const fetchGroups = async () => {
      try {
        const res = await apiFetch('/api/groups?limit=100')
        const result = await readJson(res)
        if (!res.ok) return // 그룹 목록이 없어도 전체·친구 랭킹은 볼 수 있으므로 조용히 넘어간다
        const groups: MyGroup[] = result.data.groups
        setMyGroups(groups)
        if (groups.length > 0) setGroupId(groups[0].group_id)
      } catch {
        // 위와 같은 이유로 무시
      }
    }
    fetchGroups()
  }, [])

  // 그룹 랭킹일 때만 그룹 선택이 의미가 있다. 다른 범위에서 그룹 목록이 늦게 도착해도 다시 요청하지 않게 한다.
  const activeGroupId = scope === 'group' ? groupId : ''

  // 선택이 바뀔 때마다 랭킹을 다시 불러온다
  useEffect(() => {
    const fetchRankings = async () => {
      // 그룹 랭킹인데 고른 그룹이 없으면 요청하지 않는다 (group_id 없으면 서버가 400)
      if (scope === 'group' && !activeGroupId) {
        setData(null)
        setLoading(false)
        return
      }
      try {
        const params = new URLSearchParams({ scope, period, metric })
        if (scope === 'group') params.set('group_id', activeGroupId)
        const res = await apiFetch(`/api/rankings?${params}`)
        const result = await readJson(res)
        if (!res.ok) {
          setError(getErrorMessage(res, result, '랭킹을 불러오지 못했습니다.'))
          setData(null)
          return
        }
        setData({ rankings: result.data.rankings, my_rank: result.data.my_rank })
      } catch {
        setError('서버에 연결할 수 없습니다.')
        setData(null)
      } finally {
        setLoading(false)
      }
    }
    fetchRankings()
  }, [scope, period, metric, activeGroupId, reloadKey])

  // 선택을 바꾸면 이전 오류를 지우고 로딩 상태로 바꾼 뒤 값을 바꾼다
  const change = <T,>(setter: (v: T) => void, current: T) => (next: T) => {
    if (next === current) return
    setError('')
    setLoading(true)
    setter(next)
  }

  const handleRetry = () => {
    setError('')
    setLoading(true)
    setReloadKey((k) => k + 1)
  }

  const myRowInTop = data?.rankings.some((r) => r.user_id === myUserId) ?? false

  return (
    <div className="min-h-screen bg-bg p-6">
      <h1 className="text-2xl font-bold text-primary mb-6">랭킹</h1>

      <div className="max-w-3xl space-y-4">
        {/* 선택 탭 */}
        <div className="bg-surface rounded-xl shadow-md p-4 flex flex-wrap items-center gap-3">
          <TabGroup
            options={['global', 'friends', 'group']}
            labels={SCOPE_LABEL}
            value={scope}
            onChange={change(setScope, scope)}
          />
          <TabGroup
            options={['daily', 'weekly']}
            labels={PERIOD_LABEL}
            value={period}
            onChange={change(setPeriod, period)}
          />
          <TabGroup
            options={['focus_score', 'study_time']}
            labels={METRIC_LABEL}
            value={metric}
            onChange={change(setMetric, metric)}
          />
          {scope === 'group' && myGroups.length > 0 && (
            <select
              value={groupId}
              onChange={(e) => change(setGroupId, groupId)(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-1 text-sm"
            >
              {myGroups.map((g) => (
                <option key={g.group_id} value={g.group_id}>
                  {g.name}
                </option>
              ))}
            </select>
          )}
        </div>

        {period === 'daily' && (
          <p className="text-xs text-secondary">
            서버가 UTC 날짜로 집계해서, &quot;오늘&quot;은 한국 시간 오전 9시에 새로 시작해요.
          </p>
        )}

        {loading && <p className="text-secondary">불러오는 중...</p>}
        {error && (
          <div className="flex items-center gap-3">
            <p className="text-red-600">{error}</p>
            <button onClick={handleRetry} className="text-sm text-secondary underline shrink-0">
              다시 시도
            </button>
          </div>
        )}

        {!loading && scope === 'group' && myGroups.length === 0 && (
          <p className="text-sm text-secondary">가입한 그룹이 없어요. 그룹에 들어가면 그룹 안 순위를 볼 수 있어요.</p>
        )}

        {data && (
          <>
            {/* 내 순위 */}
            <div className="bg-primary text-white rounded-xl shadow-md p-5 flex items-center justify-between">
              <p className="text-sm">내 순위</p>
              {data.my_rank ? (
                <p className="text-lg font-bold">
                  {data.my_rank.rank}위 · {formatValue(metric, data.my_rank.value)}
                </p>
              ) : (
                <p className="text-sm">
                  기록 없음 (이 기간에 완료한 세션이 없거나, 프로필에서 랭킹 참여가 꺼져 있어요)
                </p>
              )}
            </div>

            {/* 순위 목록 */}
            <div className="bg-surface rounded-xl shadow-md p-4">
              {data.rankings.length === 0 ? (
                <p className="text-sm text-secondary">아직 이 기간의 순위가 없어요.</p>
              ) : (
                <ol className="divide-y divide-bg">
                  {data.rankings.map((r) => {
                    const isMe = r.user_id === myUserId
                    return (
                      <li
                        key={r.user_id}
                        className={`flex items-center gap-3 px-2 py-3 ${isMe ? 'bg-bg rounded-lg' : ''}`}
                      >
                        <span className="w-8 sm:w-10 text-center font-bold text-primary shrink-0">
                          {MEDAL[r.rank] ?? r.rank}
                        </span>
                        {r.profile_image_url ? (
                          <img
                            src={r.profile_image_url}
                            alt=""
                            className="w-8 h-8 rounded-full object-cover shrink-0"
                          />
                        ) : (
                          <span className="w-8 h-8 rounded-full bg-accent text-white flex items-center justify-center text-sm shrink-0">
                            👤
                          </span>
                        )}
                        <span className="flex-1 min-w-0 truncate text-primary">
                          {r.nickname}
                          {isMe && <span className="ml-1 text-xs text-secondary">(나)</span>}
                        </span>
                        {/* 좁은 화면에서는 닉네임 자리를 위해 세션 수를 숨긴다 */}
                        <span className="hidden sm:inline text-xs text-secondary shrink-0">
                          세션 {r.session_count}개
                        </span>
                        <span className="sm:w-24 text-right font-medium text-primary shrink-0">
                          {formatValue(metric, r.value)}
                        </span>
                      </li>
                    )
                  })}
                </ol>
              )}
              {data.my_rank && !myRowInTop && (
                <p className="text-xs text-secondary mt-3">상위 50위 밖이라 목록에는 보이지 않아요.</p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default RankingPage
