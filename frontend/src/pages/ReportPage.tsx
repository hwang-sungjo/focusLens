import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Line } from 'react-chartjs-2'
import { apiFetch, readJson, getErrorMessage } from '../api'
import ShareDialog from '../components/ShareDialog'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js'

// Filler: 선 아래를 색으로 채우는 기능 (B9 면적 그래프)
ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler)

interface SessionSummary {
  session_id: string
  started_at: string
  ended_at: string | null
  status: 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED'
  avg_focus_score: number | null
  duration_seconds: number | null
}

type Granularity = 'MINUTE' | 'HOUR' | 'DAY' | 'WEEK'
type AttentionState = 'FOCUSED' | 'NORMAL' | 'DISTRACTED'

// 30일이 지나면 서버가 분 단위 기록을 시간·일·주 평균으로 묶는다 (docs/rollup-strategy.md)
// 묶인 행은 minute_index, attention_state가 null
interface TimelineEntry {
  granularity: Granularity
  minute_index: number | null
  logged_at: string
  gaze_score: number
  blink_score: number
  head_score: number
  focus_score: number
  attention_state: AttentionState | null
}

// B8: 같은 상태가 연속된 구간
interface Segment {
  startAt: string // 첫 1분의 logged_at
  endAt: string // 마지막 1분의 logged_at
  minutes: number
  avgScore: number
}

const TOP_COUNT = 3
const PAGE_SIZE = 20 // 완료 세션 목록을 한 번에 불러오는 개수 (서버 기본값과 같음)

// 타임라인을 앞에서부터 훑으며 같은 상태가 이어진 덩어리를 만든다.
// 상태가 바뀌거나, 분이 건너뛰어지면(기록 누락) 덩어리를 끊는다.
function findSegments(timeline: TimelineEntry[], target: AttentionState): Segment[] {
  const segments: Segment[] = []
  let current: TimelineEntry[] = []

  const close = () => {
    if (current.length > 0) {
      const sum = current.reduce((acc, t) => acc + t.focus_score, 0)
      segments.push({
        startAt: current[0].logged_at,
        endAt: current[current.length - 1].logged_at,
        minutes: current.length,
        avgScore: sum / current.length,
      })
    }
    current = []
  }

  for (const t of timeline) {
    const prev = current[current.length - 1]
    const continues =
      t.attention_state === target &&
      prev !== undefined &&
      prev.minute_index !== null &&
      t.minute_index === prev.minute_index + 1

    if (!continues) close()
    if (t.attention_state === target) current.push(t)
  }
  close()
  return segments
}

// 집중: 길이 긴 순 → 평균 높은 순 / 이탈: 길이 긴 순 → 평균 낮은 순
function topFocused(timeline: TimelineEntry[]): Segment[] {
  return findSegments(timeline, 'FOCUSED')
    .sort((a, b) => b.minutes - a.minutes || b.avgScore - a.avgScore)
    .slice(0, TOP_COUNT)
}

function topDistracted(timeline: TimelineEntry[]): Segment[] {
  return findSegments(timeline, 'DISTRACTED')
    .sort((a, b) => b.minutes - a.minutes || a.avgScore - b.avgScore)
    .slice(0, TOP_COUNT)
}

const GRANULARITY_LABEL: Record<Granularity, string> = {
  MINUTE: '1분',
  HOUR: '1시간',
  DAY: '1일',
  WEEK: '1주',
}

const formatClock = (iso: string) =>
  new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })

// 차트 가로축 글자: 분·시간 단위는 시각, 일·주 단위는 날짜
const formatAxisLabel = (t: TimelineEntry) =>
  t.granularity === 'DAY' || t.granularity === 'WEEK'
    ? new Date(t.logged_at).toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit' })
    : formatClock(t.logged_at)

function SegmentCard({
  title,
  tone,
  segments,
  emptyText,
}: {
  title: string
  tone: 'good' | 'bad'
  segments: Segment[]
  emptyText: string
}) {
  return (
    <div className="bg-surface rounded-xl shadow-md print:shadow-none print:border print:border-accent/40 p-5 break-inside-avoid">
      <p className={`text-sm font-medium mb-3 ${tone === 'good' ? 'text-green-700' : 'text-red-700'}`}>
        {title}
      </p>
      {segments.length === 0 ? (
        <p className="text-sm text-secondary">{emptyText}</p>
      ) : (
        <ol className="space-y-2">
          {segments.map((seg, i) => (
            <li key={seg.startAt} className="flex items-baseline justify-between gap-3 text-sm">
              <span className="text-primary">
                {i + 1}.{' '}
                {seg.minutes === 1
                  ? formatClock(seg.startAt)
                  : `${formatClock(seg.startAt)} ~ ${formatClock(seg.endAt)}`}
              </span>
              <span className="text-secondary shrink-0">
                {seg.minutes}분 · 평균 {seg.avgScore.toFixed(0)}점
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

interface ReportDetail {
  session_id: string
  timeline: TimelineEntry[]
  summary_json: {
    avg_focus_score: number | null
    duration_seconds: number | null
    gaze_avg: number | null
    blink_avg: number | null
    head_avg: number | null
    focused_minutes: number
    normal_minutes: number
    distracted_minutes: number
  }
}

type SessionPageResult =
  | { ok: true; rows: SessionSummary[]; total: number }
  | { ok: false; message: string }

// 완료 세션 목록 한 페이지 요청 (서버는 page·limit을 받고 전체 개수 pagination.total을 돌려준다)
async function loadSessionPage(pageNo: number): Promise<SessionPageResult> {
  try {
    const res = await apiFetch(`/api/sessions?status=COMPLETED&page=${pageNo}&limit=${PAGE_SIZE}`)
    const result = await readJson(res)
    if (!res.ok) {
      return { ok: false, message: getErrorMessage(res, result, '세션 목록을 불러오지 못했습니다.') }
    }
    const rows: SessionSummary[] = result.data.sessions
    return { ok: true, rows, total: result.data.pagination?.total ?? rows.length }
  } catch {
    return { ok: false, message: '서버에 연결할 수 없습니다.' }
  }
}

// 그래프 틀: 높이를 폭에 맞춰 정한다 (가로:세로 = 10:3).
// 화면이 넓어져 상세 영역이 늘어나면 그래프 높이도 같이 커져서, 가로로만 납작하게 늘어나지 않는다.
// 좁은 화면에서는 최소 256px(지금 높이), 아주 넓은 화면에서는 최대 640px에서 멈춘다.
// CSS aspect-ratio 대신 폭을 재서 정수 높이를 주는 이유: 소수점 높이면 Chart.js가 크기를 계속 다시 맞추면서 그리기 애니메이션이 멈출 수 있다.
const CHART_RATIO = 0.3
const CHART_MIN_HEIGHT = 256
const CHART_MAX_HEIGHT = 640

function ChartBox({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(CHART_MIN_HEIGHT)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(
        Math.min(CHART_MAX_HEIGHT, Math.max(CHART_MIN_HEIGHT, entry.contentRect.width * CHART_RATIO)),
      )
      setHeight((prev) => (prev === next ? prev : next))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {children}
    </div>
  )
}

function ReportPage() {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [report, setReport] = useState<ReportDetail | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [listFailed, setListFailed] = useState(false) // 세션 목록 불러오기 실패 → 다시 시도 버튼
  const [reloadKey, setReloadKey] = useState(0)
  // 세션 목록 페이지 처리: 지금까지 불러온 페이지 번호, 서버가 알려준 전체 개수, 더 보기 진행 중 여부
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [shareOpen, setShareOpen] = useState(false) // 공유 창 열림 여부

  // 처음 들어올 때와 [다시 시도]를 눌렀을 때 첫 페이지부터 불러온다
  useEffect(() => {
    const fetchFirstPage = async () => {
      const result = await loadSessionPage(1)
      if (!result.ok) {
        setError(result.message)
        setListFailed(true)
      } else {
        setSessions(result.rows)
        setTotal(result.total)
        setPage(1)
      }
      setLoading(false)
    }

    fetchFirstPage()
  }, [reloadKey])

  // [더 보기]: 다음 페이지를 불러와 목록 뒤에 이어 붙인다
  const handleLoadMore = async () => {
    setError('')
    setListFailed(false)
    setLoadingMore(true)
    const next = page + 1
    const result = await loadSessionPage(next)
    if (!result.ok) {
      setError(result.message)
      setListFailed(true)
    } else {
      // 목록을 보는 사이 새 세션이 끝나면 페이지가 한 칸씩 밀려 같은 세션이 또 올 수 있어 중복은 뺀다
      setSessions((prev) => {
        const seen = new Set(prev.map((s) => s.session_id))
        return [...prev, ...result.rows.filter((r) => !seen.has(r.session_id))]
      })
      setTotal(result.total)
      setPage(next)
    }
    setLoadingMore(false)
  }

  const hasMore = sessions.length < total

  const handleRetry = () => {
    setError('')
    setListFailed(false)
    setLoading(true)
    setReloadKey((k) => k + 1)
  }

  const handleSelectSession = async (sessionId: string) => {
    setSelectedSessionId(sessionId)
    setReport(null)
    setError('')

    try {
      const res = await apiFetch(`/api/reports/${sessionId}`)
      const result = await readJson(res)
      if (!res.ok) {
        setError(getErrorMessage(res, result, '리포트를 불러오지 못했습니다.'))
        return
      }
      setReport(result.data)
    } catch {
      setError('서버에 연결할 수 없습니다.')
    }
  }

  // 타임라인에 묶인 행이 있으면 그 단위 (없으면 null = 최근 세션)
  const rolledUpEntry = report?.timeline.find((t) => t.granularity !== 'MINUTE')
  const rolledUpUnit = rolledUpEntry ? GRANULARITY_LABEL[rolledUpEntry.granularity] : null

  // PDF 첫 줄에 넣을 세션 날짜 (목록에서 선택한 세션을 찾아 쓴다)
  const selectedSession = sessions.find((s) => s.session_id === selectedSessionId)

  // [PDF로 저장]: 브라우저 인쇄 창을 연다. 인쇄 창에서 "PDF로 저장"을 고르면 파일이 된다.
  // 메뉴·세션 목록·버튼은 print:hidden으로 인쇄에서 빠진다.
  const handleSavePdf = () => {
    window.print()
  }

  const formatDuration = (seconds: number) => {
    const minutes = Math.floor(seconds / 60)
    return `${minutes}분`
  }

  return (
    <div className="min-h-screen bg-bg p-6 print:min-h-0 print:p-0 print:bg-white">
      <h1 className="text-2xl font-bold text-primary mb-6 print:mb-3">리포트</h1>

      {loading && <p className="text-secondary">불러오는 중...</p>}
      {error && (
        <div className="flex items-center gap-3 mb-4 print:hidden">
          <p className="text-red-600">{error}</p>
          {listFailed && (
            <button onClick={handleRetry} className="text-sm text-secondary underline shrink-0">
              다시 시도
            </button>
          )}
        </div>
      )}

      <div className="flex gap-6 flex-wrap">
        {/* 세션 목록 */}
        <div className="bg-surface rounded-xl shadow-md p-4 w-full sm:w-64 print:hidden">
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
          {hasMore && (
            <button
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="w-full mt-3 px-3 py-2 rounded-lg text-sm text-secondary border border-accent hover:bg-bg disabled:opacity-50"
            >
              {loadingMore ? '불러오는 중...' : `더 보기 (${sessions.length}/${total})`}
            </button>
          )}
        </div>

        {/* 상세 리포트 */}
        {report && (
          <div className="flex-1 min-w-0 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-secondary">
                {selectedSession &&
                  new Date(selectedSession.started_at).toLocaleString('ko-KR', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                    weekday: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
              </p>
              <div className="flex gap-2 shrink-0 print:hidden">
                <button
                  onClick={() => setShareOpen(true)}
                  className="px-3 py-1.5 rounded-lg text-sm text-secondary border border-accent hover:bg-bg"
                >
                  📤 공유하기
                </button>
                <button
                  onClick={handleSavePdf}
                  className="px-3 py-1.5 rounded-lg text-sm text-secondary border border-accent hover:bg-bg"
                >
                  📄 PDF로 저장
                </button>
              </div>
            </div>
            <div className="bg-surface rounded-xl shadow-md print:shadow-none print:border print:border-accent/40 p-6 grid grid-cols-3 gap-4 text-center">
              <div>
                <p className="text-sm text-secondary mb-1">평균 집중도</p>
                <p className="text-2xl font-bold text-primary">
                  {report.summary_json.avg_focus_score !== null
                    ? `${report.summary_json.avg_focus_score.toFixed(1)}점`
                    : '기록 없음'}
                </p>
              </div>
              <div>
                <p className="text-sm text-secondary mb-1">학습 시간</p>
                <p className="text-2xl font-bold text-primary">
                  {report.summary_json.duration_seconds !== null
                    ? formatDuration(report.summary_json.duration_seconds)
                    : '기록 없음'}
                </p>
              </div>
              <div>
                <p className="text-sm text-secondary mb-1">집중 시간</p>
                <p className="text-2xl font-bold text-primary">
                  {report.summary_json.focused_minutes}분
                </p>
              </div>
            </div>

            <div className="bg-surface rounded-xl shadow-md print:shadow-none print:border print:border-accent/40 p-6">
              <p className="text-sm text-secondary mb-4">집중도 타임라인</p>
              {/* B11: 묶인(오래된) 세션 안내 */}
              {rolledUpUnit && (
                <p className="text-sm text-secondary bg-bg rounded-lg px-3 py-2 mb-4">
                  ℹ️ 30일 넘게 지난 세션이라 {rolledUpUnit} 평균으로 저장돼 있어요. 그래서 점이 적고,
                  집중·이탈 구간 분석은 제공하지 않아요.
                </p>
              )}
              {report.timeline.length === 0 ? (
                <p className="text-sm text-secondary">기록된 데이터가 없습니다.</p>
              ) : (
                <ChartBox>
                  <Line
                    data={{
                      labels: report.timeline.map(formatAxisLabel),
                      datasets: [
                        {
                          label: '집중도',
                          data: report.timeline.map((t) => t.focus_score),
                          borderColor: '#2E1D14',
                          // B9: 집중도 선 아래만 연한 우드색으로 채움 (나머지 3개 선은 그대로)
                          fill: 'origin',
                          backgroundColor: 'rgba(196, 149, 106, 0.25)',
                          pointBackgroundColor: '#2E1D14', // 점은 예전처럼 진한 색 유지
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
                      responsive: true,
                      maintainAspectRatio: false,
                      scales: { y: { min: 0, max: 100 } },
                    }}
                  />
                </ChartBox>
              )}
            </div>

            {/* B8: 집중 / 이탈 TOP3 연속 구간 (묶인 세션에서는 계산할 수 없어 숨김) */}
            {!rolledUpUnit && report.timeline.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <SegmentCard
                  title="🟢 집중 TOP 구간"
                  tone="good"
                  segments={topFocused(report.timeline)}
                  emptyText="연속으로 집중한 구간이 없어요."
                />
                <SegmentCard
                  title="🔴 이탈 TOP 구간"
                  tone="bad"
                  segments={topDistracted(report.timeline)}
                  emptyText="집중이 흐트러진 구간이 없어요 👍"
                />
              </div>
            )}
          </div>
        )}
      </div>

      {shareOpen && selectedSessionId && (
        <ShareDialog sessionId={selectedSessionId} onClose={() => setShareOpen(false)} />
      )}
    </div>
  )
}

export default ReportPage