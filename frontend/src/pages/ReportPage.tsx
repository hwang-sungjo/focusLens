import { useEffect, useState } from 'react'
import { Line } from 'react-chartjs-2'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
} from 'chart.js'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend)

interface SessionSummary {
  session_id: string
  started_at: string
  ended_at: string | null
  status: 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED'
  avg_focus_score: number | null
  duration_seconds: number | null
}

interface TimelineEntry {
  logged_at: string
  gaze_score: number
  blink_score: number
  head_score: number
  focus_score: number
  attention_state: string
}

interface ReportDetail {
  session_id: string
  timeline: TimelineEntry[]
  summary_json: {
    avg_focus_score: number
    duration_seconds: number
    gaze_avg: number
    blink_avg: number
    head_avg: number
    focused_minutes: number
    normal_minutes: number
    distracted_minutes: number
  }
}

function ReportPage() {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [report, setReport] = useState<ReportDetail | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchSessions = async () => {
      const token = localStorage.getItem('access_token')
      try {
        const res = await fetch('http://localhost:3000/api/sessions?status=COMPLETED', {
          headers: { Authorization: `Bearer ${token}` },
        })
        const result = await res.json()
        if (!res.ok) {
          setError(result.error || '세션 목록을 불러오지 못했습니다.')
          return
        }
        setSessions(result.data.sessions)
      } catch (err) {
        setError('서버에 연결할 수 없습니다.')
      } finally {
        setLoading(false)
      }
    }

    fetchSessions()
  }, [])

  const handleSelectSession = async (sessionId: string) => {
    setSelectedSessionId(sessionId)
    setReport(null)
    setError('')
    const token = localStorage.getItem('access_token')

    try {
      const res = await fetch(`http://localhost:3000/api/reports/${sessionId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const result = await res.json()
      if (!res.ok) {
        setError(result.error || '리포트를 불러오지 못했습니다.')
        return
      }
      setReport(result.data)
    } catch (err) {
      setError('서버에 연결할 수 없습니다.')
    }
  }

  const formatDuration = (seconds: number) => {
    const minutes = Math.floor(seconds / 60)
    return `${minutes}분`
  }

  return (
    <div className="min-h-screen bg-bg p-6">
      <h1 className="text-2xl font-bold text-primary mb-6">리포트</h1>

      {loading && <p className="text-secondary">불러오는 중...</p>}
      {error && <p className="text-red-600 mb-4">{error}</p>}

      <div className="flex gap-6 flex-wrap">
        {/* 세션 목록 */}
        <div className="bg-surface rounded-xl shadow-md p-4 w-full sm:w-64">
          <p className="text-sm font-medium text-primary mb-3">완료된 세션</p>
          {sessions.length === 0 && !loading && (
            <p className="text-sm text-secondary">아직 완료된 세션이 없습니다.</p>
          )}
          <ul className="space-y-2">
            {sessions.map((s) => (
              <li key={s.session_id}>
                <button
                  onClick={() => handleSelectSession(s.session_id)}
                  className={`w-full text-left px-3 py-2 rounded-lg text-sm ${
                    selectedSessionId === s.session_id
                      ? 'bg-primary text-white'
                      : 'hover:bg-bg text-secondary'
                  }`}
                >
                  {new Date(s.started_at).toLocaleString('ko-KR', {
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                  {s.avg_focus_score !== null && ` · ${s.avg_focus_score.toFixed(0)}점`}
                </button>
              </li>
            ))}
          </ul>
        </div>

        {/* 상세 리포트 */}
        {report && (
          <div className="flex-1 min-w-0 space-y-4">
            <div className="bg-surface rounded-xl shadow-md p-6 grid grid-cols-3 gap-4 text-center">
              <div>
                <p className="text-sm text-secondary mb-1">평균 집중도</p>
                <p className="text-2xl font-bold text-primary">
                  {report.summary_json.avg_focus_score.toFixed(1)}점
                </p>
              </div>
              <div>
                <p className="text-sm text-secondary mb-1">학습 시간</p>
                <p className="text-2xl font-bold text-primary">
                  {formatDuration(report.summary_json.duration_seconds)}
                </p>
              </div>
              <div>
                <p className="text-sm text-secondary mb-1">집중 시간</p>
                <p className="text-2xl font-bold text-primary">
                  {report.summary_json.focused_minutes}분
                </p>
              </div>
            </div>

            <div className="bg-surface rounded-xl shadow-md p-6">
              <p className="text-sm text-secondary mb-4">집중도 타임라인</p>
              {report.timeline.length === 0 ? (
                <p className="text-sm text-secondary">기록된 데이터가 없습니다.</p>
              ) : (
                <Line
                  data={{
                    labels: report.timeline.map((t) =>
                      new Date(t.logged_at).toLocaleTimeString('ko-KR', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    ),
                    datasets: [
                      {
                        label: '집중도',
                        data: report.timeline.map((t) => t.focus_score),
                        borderColor: '#2E1D14',
                        backgroundColor: '#2E1D14',
                        borderWidth: 2,
                        pointRadius: 3,
                        tension: 0.3,
                      },
                      {
                        label: 'Gaze',
                        data: report.timeline.map((t) => t.gaze_score),
                        borderColor: '#E6007E',
                        backgroundColor: '#E6007E',
                        borderWidth: 1.5,
                        pointRadius: 2,
                        tension: 0.3,
                      },
                      {
                        label: 'Blink',
                        data: report.timeline.map((t) => t.blink_score),
                        borderColor: '#00B7EB',
                        backgroundColor: '#00B7EB',
                        borderWidth: 1.5,
                        pointRadius: 2,
                        tension: 0.3,
                      },
                      {
                        label: 'Head',
                        data: report.timeline.map((t) => t.head_score),
                        borderColor: '#F4E600',
                        backgroundColor: '#F4E600',
                        borderWidth: 1.5,
                        pointRadius: 2,
                        tension: 0.3,
                      },
                    ],
                  }}
                  options={{
                    scales: { y: { min: 0, max: 100 } },
                  }}
                />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default ReportPage