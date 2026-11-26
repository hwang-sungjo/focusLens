import { apiFetch, readJson } from './api'

// 그룹 관련 공통 타입·문구 (그룹 목록·그룹 상세 화면이 같이 쓴다)
// 서버 응답 모양은 backend/src/controllers/groupsController.js 기준

export type GroupType = 'STUDY' | 'PROJECT' | 'CHALLENGE'
export type GroupVisibility = 'PUBLIC' | 'PRIVATE'
export type GroupRole = 'OWNER' | 'MANAGER' | 'MEMBER'

// GET /api/groups (내가 속한 그룹 목록)의 한 줄
export interface GroupSummary {
  group_id: string
  name: string
  description: string | null
  group_type: GroupType
  visibility: GroupVisibility
  member_count: number
  my_role: GroupRole
  joined_at: string
}

// GET /api/groups/:id (그룹 상세)
export interface GroupDetail {
  group_id: string
  name: string
  description: string | null
  group_type: GroupType
  visibility: GroupVisibility
  member_count: number
  my_role: GroupRole | null // 멤버가 아니면 null (공개 그룹은 비멤버도 상세를 볼 수 있음)
  created_at: string
}

// GET /api/groups/:id/dashboard 의 멤버 한 줄
// 학습 기록은 그 멤버가 프로필에서 "그룹 데이터 공유"를 켰을 때만 채워지고, 껐으면 0·null로 온다
export interface GroupMember {
  group_member_id: string // 역할 변경·내보내기·목표 배정·피드백에 쓰는 ID (user_id와 다름)
  user_id: string
  group_role: GroupRole
  nickname: string | null
  profile_image_url: string | null
  total_sessions: number
  total_study_seconds: number
  avg_focus_score: number | null
  last_session_at: string | null
}

export const GROUP_TYPE_LABEL: Record<GroupType, string> = {
  STUDY: '스터디',
  PROJECT: '프로젝트',
  CHALLENGE: '챌린지',
}
export const VISIBILITY_LABEL: Record<GroupVisibility, string> = { PUBLIC: '공개', PRIVATE: '비공개' }
export const ROLE_LABEL: Record<GroupRole, string> = { OWNER: '방장', MANAGER: '매니저', MEMBER: '멤버' }

// 방장·매니저만 할 수 있는 일(초대, 내보내기, 목표 만들기·배정, 피드백 쓰기, 전체 멤버 현황 보기) 판단용
export const isManagerRole = (role: GroupRole | null) => role === 'OWNER' || role === 'MANAGER'

export function formatStudyTime(seconds: number) {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return hours > 0 ? `${hours}시간 ${minutes}분` : `${minutes}분`
}

// 그룹 목표 (GET /api/groups/:id/goals 의 한 줄)
export type GoalStatus = 'ACTIVE' | 'COMPLETED' | 'CANCELLED'
export interface GroupGoal {
  goal_id: string
  title: string
  description: string | null
  target_study_minutes: number | null
  target_focus_score: number | null
  start_date: string // YYYY-MM-DD
  end_date: string
  status: GoalStatus
  assignee_count: number // 0이면 그룹 전체 대상
  is_assigned_to_me: boolean
  created_at: string
}
export const GOAL_STATUS_LABEL: Record<GoalStatus, string> = {
  ACTIVE: '진행 중',
  COMPLETED: '완료',
  CANCELLED: '취소',
}

// 멤버 명단 불러오기 (목표 배정·피드백 대상 고르기용)
// 멤버 목록 API가 따로 없어서 대시보드 API를 쓴다 → 방장·매니저만 전체 명단을 받는다
export async function loadGroupMembers(groupId: string): Promise<GroupMember[]> {
  try {
    const res = await apiFetch(`/api/groups/${groupId}/dashboard?limit=100`)
    const result = await readJson(res)
    return res.ok ? result.data.members : []
  } catch {
    return []
  }
}
