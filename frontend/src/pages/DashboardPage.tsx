import { useEffect, useState } from 'react'
import { Line } from 'react-chartjs-2'
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
  avg_focus_score: number
}

interface WeeklyData {
  period: { start_date: string; end_date: string }
  daily_summaries: DailySummary[]
  weekly_avg_focus_score: number | null
  weekly_total_study_seconds: number
}

function DashboardPage() {
  const [data, setData] = useState<WeeklyData | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchWeekly = async () => {
      const token = localStorage.getItem('access_token')
      try {
        const res = await fetch('http://localhost:3000/api/reports/weekly', {
          headers: { Authorization: `Bearer ${token}` },
        })
        const result = await res.json()

        if (!res.ok) {
          setError(result.error || '데이터를 불러오지 못했습니다.')
          return
        }

        setData(result.data)
      } catch (err) {
        setError('서버에 연결할 수 없습니다.')
      } finally {
        setLoading(false)
      }
    }

    fetchWeekly()
  }, [])

  const formatDuration = (seconds: number) => {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    return `${hours}시간 ${minutes}분`
  }

  return (
    <div className="min-h-screen bg-bg p-6">
      <h1 className="text-2xl font-bold text-primary mb-6">대시보드</h1>

      {loading && <p className="text-secondary">불러오는 중...</p>}
      {error && <p className="text-red-600">{error}</p>}

      {data && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6 max-w-2xl">
            <div className="bg-surface rounded-xl shadow-md p-6">
              <p className="text-sm text-secondary mb-1">주간 평균 집중도</p>
              <p className="text-4xl font-bold text-primary">
                {data.weekly_avg_focus_score !== null
                  ? `${data.weekly_avg_focus_score.toFixed(1)}점`
                  : '기록 없음'}
              </p>
            </div>
            <div className="bg-surface rounded-xl shadow-md p-6">
              <p className="text-sm text-secondary mb-1">이번 주 총 학습 시간</p>
              <p className="text-4xl font-bold text-primary">
                {formatDuration(data.weekly_total_study_seconds)}
              </p>
            </div>
          </div>

          <div className="bg-surface rounded-xl shadow-md p-6 max-w-2xl">
            <p className="text-sm text-secondary mb-4">최근 7일 집중도 추이</p>
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
                  },
                ],
              }}
              options={{
                scales: {
                  y: { min: 0, max: 100 },
                },
              }}
            />
          </div>
        </>
      )}
    </div>
  )
}

export default DashboardPage