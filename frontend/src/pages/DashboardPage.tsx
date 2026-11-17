import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Line } from 'react-chartjs-2'
import { apiFetch, readJson, getErrorMessage } from '../api'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
} from 'chart.js'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip)

interface DailySummary {
  date: string
  session_count: number
  total_study_seconds: number
  avg_focus_score: number | null // 기록이 없는 날은 null
}

type Period = 'weekly' | 'monthly'

// 주간·월간 응답을 같은 모양으로 맞춘 것 (docs/api-spec.md 주간·월간 리포트)
interface PeriodData {
  period: Period // 이 데이터가 어느 기간 것인지 (전환 중 이전 데이터에 새 제목이 붙지 않도록)
  daily_summaries: DailySummary[]
  avg_focus_score: number | null
  total_study_seconds: number
}

const PERIOD_LABEL: Record<Period, { tab: string; title: string; avg: string; total: string }> = {
  weekly: { tab: '주간', title: '최근 7일', avg: '주간 평균 집중도', total: '최근 7일 학습 시간' },
  monthly: { tab: '월간', title: '최근 30일', avg: '월간 평균 집중도', total: '최근 30일 학습 시간' },
}

// 오늘 집중도 원형 게이지 (기획서 6.3절 (2) 히어로 섹션)
function FocusGauge({ score }: { score: number | null }) {
  const radius = 52
  const circumference = 2 * Math.PI * radius
  const ratio = score === null ? 0 : Math.min(Math.max(score, 0), 100) / 100

  return (
    <div className="relative w-36 h-36">
      <svg viewBox="0 0 120 120" className="w-full h-full -rotate-90">
        <circle cx="60" cy="60" r={radius} fill="none" stroke="#F5ECD7" strokeWidth="12" />
        <circle
          cx="60"
          cy="60"
          r={radius}
          fill="none"
          stroke="#C4956A"
          strokeWidth="12"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - ratio)}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        {score === null ? (
          <span className="text-sm text-secondary">기록 없음</span>
        ) : (
          <>
            <span className="text-3xl font-bold text-primary">{score.toFixed(0)}</span>
            <span className="text-xs text-secondary">/ 100</span>
          </>
        )}
      </div>
    </div>
  )
}

function DashboardPage() {
  const [period, setPeriod] = useState<Period>('weekly')
  const [data, setData] = useState<PeriodData | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0) // 값이 바뀌면 다시 불러온다

  useEffect(() => {
    const fetchPeriod = async () => {
      try {
        const res = await apiFetch(`/api/reports/${period}`)
        const result = await readJson(res)

        if (!res.ok) {
          setError(getErrorMessage(res, result, '데이터를 불러오지 못했습니다.'))
          return
        }

        const d = result.data
        setData({
          period,
          daily_summaries: d.daily_summaries,
          avg_focus_score: period === 'weekly' ? d.weekly_avg_focus_score : d.monthly_avg_focus_score,
          total_study_seconds:
            period === 'weekly' ? d.weekly_total_study_seconds : d.monthly_total_study_seconds,
        })
      } catch {
        setError('서버에 연결할 수 없습니다.')
      } finally {
        setLoading(false)
      }
    }

    fetchPeriod()
  }, [period, reloadKey])

  const handleRetry = () => {
    setError('')
    setLoading(true)
    setReloadKey((k) => k + 1)
  }

  const handleChangePeriod = (next: Period) => {
    if (next === period) return
    setError('')
    setLoading(true)
    setPeriod(next)
  }

  const formatDuration = (seconds: number) => {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    return `${hours}시간 ${minutes}분`
  }

  // 오늘 = 응답의 마지막 날짜 (서버는 UTC 날짜 기준, docs/api-spec.md 1.5절)
  const today = data ? data.daily_summaries[data.daily_summaries.length - 1] : null
  const label = data ? PERIOD_LABEL[data.period] : PERIOD_LABEL[period]

  return (
    <div className="min-h-screen bg-bg p-6 pb-24">
      <h1 className="text-2xl font-bold text-primary mb-6">대시보드</h1>

      {loading && <p className="text-secondary mb-4">불러오는 중...</p>}
      {error && (
        <div className="flex items-center gap-3 mb-4">
          <p className="text-red-600">{error}</p>
          <button onClick={handleRetry} className="text-sm text-secondary underline shrink-0">
            다시 시도
          </button>
        </div>
      )}

      {data && (
        <div className="max-w-5xl">
          {/* 히어로: 모바일 1열, 태블릿 2열, 데스크탑 3열 (기획서 6.3절 (2)) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
            <div className="bg-surface rounded-xl shadow-md p-6 flex items-center gap-5">
              <FocusGauge score={today?.avg_focus_score ?? null} />
              <div>
                <p className="text-sm text-secondary mb-1">오늘 집중도</p>
                <p className="text-xs text-secondary">
                  {today ? `세션 ${today.session_count}개` : ''}
                </p>
              </div>
            </div>

            <div className="bg-surface rounded-xl shadow-md p-6">
              <p className="text-sm text-secondary mb-1">오늘 학습 시간</p>
              <p className="text-4xl font-bold text-primary">
                {formatDuration(today?.total_study_seconds ?? 0)}
              </p>
            </div>

            <div className="bg-surface rounded-xl shadow-md p-6">
              <p className="text-sm text-secondary mb-1">{label.avg}</p>
              <p className="text-4xl font-bold text-primary">
                {data.avg_focus_score !== null ? `${data.avg_focus_score.toFixed(1)}점` : '기록 없음'}
              </p>
              <p className="text-sm text-secondary mt-2">
                {label.total} {formatDuration(data.total_study_seconds)}
              </p>
            </div>
          </div>

          <div className="bg-surface rounded-xl shadow-md p-6">
            <div className="flex items-center justify-between mb-4">
              <p className="text-sm text-secondary">{label.title} 집중도 추이</p>
              <div className="flex rounded-lg border border-accent overflow-hidden text-sm">
                {(['weekly', 'monthly'] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => handleChangePeriod(p)}
                    className={`px-3 py-1 ${
                      period === p ? 'bg-primary text-white' : 'text-secondary hover:bg-bg'
                    }`}
                  >
                    {PERIOD_LABEL[p].tab}
                  </button>
                ))}
              </div>
            </div>
            <div className="relative w-full h-64">
              <Line
                data={{
                  labels: data.daily_summaries.map((d) => d.date.slice(5)),
                  datasets: [
                    {
                      label: '평균 집중도',
                      data: data.daily_summaries.map((d) => d.avg_focus_score),
                      borderColor: '#5C3D2E',
                      backgroundColor: '#C4956A',
                      tension: 0.3,
                      spanGaps: true, // 기록 없는 날(null)은 점 없이 건너뛰고 앞뒤 기록을 잇는다 (0으로 바꾸지 않음)
                    },
                  ],
                }}
                options={{
                  responsive: true,
                  maintainAspectRatio: false,
                  scales: {
                    y: { min: 0, max: 100 },
                  },
                }}
              />
            </div>
            <p className="text-xs text-secondary mt-3">
              * 날짜는 UTC 기준입니다. 한국 시간 오전 0~9시에 시작한 세션은 전날로 집계됩니다.
            </p>
          </div>
        </div>
      )}

      {/* 새 학습 세션 시작 고정 버튼 (기획서 6.3절 (2) FAB) */}
      <Link
        to="/session"
        aria-label="새 학습 세션 시작"
        className="fixed bottom-6 right-6 z-40 flex items-center gap-2 rounded-full bg-primary text-white px-5 py-3 shadow-lg hover:bg-secondary transition-colors"
      >
        <span className="text-lg leading-none">＋</span>
        <span className="text-sm font-medium">새 학습 시작</span>
      </Link>
    </div>
  )
}

export default DashboardPage
