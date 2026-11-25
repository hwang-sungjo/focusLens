import { useEffect, useState } from 'react'
import { apiFetch, readJson, getErrorMessage } from '../../api'

// 그룹 상세 > 멤버 탭 > 초대 (POST /api/groups/:id/invite) — 방장·매니저만 보인다
// 서버 규칙:
// - 초대장은 받을 사람을 정해서 만든다: 이메일 또는 user_id 중 하나
// - 만들면 초대 코드가 나오고, 받는 사람이 그룹 화면에서 그 코드를 입력해야 가입된다
//   ("받은 초대 목록" API가 없어서 코드는 카톡 등으로 직접 전달해야 한다)
// - 같은 사람에게 아직 유효한 초대가 있으면 409

type InviteBy = 'friend' | 'email'

interface FriendOption {
  user_id: string
  nickname: string | null
}

interface Invitation {
  invite_code: string
  expires_at: string
  target: string // 화면 표시용: 누구에게 보낸 초대인지
}

interface InvitePanelProps {
  groupId: string
  memberUserIds: string[] // 이미 멤버인 사람은 친구 목록에서 뺀다
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const EXPIRE_OPTIONS = [1, 3, 7, 14, 30] // 서버 허용 범위 1~30일, 기본 7일

function InvitePanel({ groupId, memberUserIds }: InvitePanelProps) {
  const [inviteBy, setInviteBy] = useState<InviteBy>('friend')
  const [friends, setFriends] = useState<FriendOption[]>([])
  const [friendId, setFriendId] = useState('')
  const [email, setEmail] = useState('')
  const [expiresInDays, setExpiresInDays] = useState(7)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [invitation, setInvitation] = useState<Invitation | null>(null)
  const [copied, setCopied] = useState(false)

  // 내 친구 목록을 불러와 아직 멤버가 아닌 친구만 고를 수 있게 한다
  const memberKey = memberUserIds.join(',')
  useEffect(() => {
    const fetchFriends = async () => {
      try {
        const res = await apiFetch('/api/connections?limit=100')
        const result = await readJson(res)
        if (!res.ok) return
        const members = new Set(memberKey.split(','))
        const options: FriendOption[] = (result.data.connections as FriendOption[]).filter(
          (f) => !members.has(f.user_id),
        )
        setFriends(options)
        setFriendId(options[0]?.user_id ?? '')
      } catch {
        // 친구 목록을 못 불러와도 이메일 초대는 할 수 있다
      }
    }
    fetchFriends()
  }, [memberKey])

  const handleInvite = async () => {
    setError('')
    setInvitation(null)
    setCopied(false)

    const target =
      inviteBy === 'friend' ? (friends.find((f) => f.user_id === friendId)?.nickname ?? '친구') : email.trim()
    if (inviteBy === 'email' && !EMAIL_PATTERN.test(email.trim())) {
      setError('이메일 형식이 아니에요.')
      return
    }

    setSending(true)
    try {
      const res = await apiFetch(`/api/groups/${groupId}/invite`, {
        method: 'POST',
        body: JSON.stringify({
          ...(inviteBy === 'friend' ? { invitee_user_id: friendId } : { invitee_email: email.trim() }),
          expires_in_days: expiresInDays,
        }),
      })
      const result = await readJson(res)
      if (!res.ok) {
        setError(getErrorMessage(res, result, '초대 코드를 만들지 못했습니다.'))
        return
      }
      setInvitation({ invite_code: result.data.invite_code, expires_at: result.data.expires_at, target })
      setEmail('')
    } catch {
      setError('서버에 연결할 수 없습니다.')
    } finally {
      setSending(false)
    }
  }

  const handleCopy = async () => {
    if (!invitation) return
    try {
      await navigator.clipboard.writeText(invitation.invite_code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // 클립보드 권한이 없으면 코드를 직접 선택해 복사할 수 있다 (select-all)
    }
  }

  const canSend = inviteBy === 'friend' ? Boolean(friendId) : Boolean(email.trim())

  return (
    <div className="bg-surface rounded-xl shadow-md p-5 space-y-3">
      <p className="text-sm font-medium text-primary">멤버 초대</p>

      <div className="flex rounded-lg border border-accent overflow-hidden text-sm w-max">
        {(['friend', 'email'] as const).map((by) => (
          <button
            key={by}
            onClick={() => setInviteBy(by)}
            className={`px-3 py-1 ${inviteBy === by ? 'bg-primary text-white' : 'text-secondary hover:bg-bg'}`}
          >
            {by === 'friend' ? '친구 중에서' : '이메일로'}
          </button>
        ))}
      </div>

      {inviteBy === 'friend' ? (
        friends.length === 0 ? (
          <p className="text-xs text-secondary">
            초대할 수 있는 친구가 없어요. (친구가 없거나 모두 이미 멤버예요)
          </p>
        ) : (
          <select
            value={friendId}
            onChange={(e) => setFriendId(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            aria-label="초대할 친구"
          >
            {friends.map((f) => (
              <option key={f.user_id} value={f.user_id}>
                {f.nickname ?? '알 수 없는 사용자'}
              </option>
            ))}
          </select>
        )
      ) : (
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="초대할 사람의 가입 이메일"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          aria-label="초대할 이메일"
        />
      )}

      <div className="flex items-center gap-2">
        <label htmlFor="invite-expire" className="text-xs text-secondary">
          유효기간
        </label>
        <select
          id="invite-expire"
          value={expiresInDays}
          onChange={(e) => setExpiresInDays(Number(e.target.value))}
          className="border border-gray-300 rounded-lg px-2 py-1 text-sm"
        >
          {EXPIRE_OPTIONS.map((d) => (
            <option key={d} value={d}>
              {d}일
            </option>
          ))}
        </select>
        <button
          onClick={handleInvite}
          disabled={sending || !canSend}
          className="ml-auto px-3 py-1.5 rounded-lg text-sm bg-primary text-white hover:bg-secondary disabled:opacity-50"
        >
          {sending ? '만드는 중...' : '초대 코드 만들기'}
        </button>
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}

      {invitation && (
        <div className="bg-bg rounded-lg p-3 space-y-2">
          <p className="text-xs text-secondary">
            {invitation.target}님에게 이 코드를 보내 주세요. 그룹 화면의 [초대 코드로 가입]에 입력하면
            들어와요.
          </p>
          <div className="flex gap-2">
            <code className="flex-1 min-w-0 truncate bg-surface rounded-lg px-3 py-1.5 text-sm text-primary select-all">
              {invitation.invite_code}
            </code>
            <button
              onClick={handleCopy}
              className="px-3 py-1 rounded-lg text-sm border border-accent text-secondary hover:bg-surface shrink-0"
            >
              {copied ? '복사됨 ✓' : '복사'}
            </button>
          </div>
          <p className="text-xs text-secondary">
            {new Date(invitation.expires_at).toLocaleString('ko-KR')}까지 유효 · 이 사람만 쓸 수 있는 코드예요
          </p>
        </div>
      )}
    </div>
  )
}

export default InvitePanel
