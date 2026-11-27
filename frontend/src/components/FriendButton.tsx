import { useState } from 'react'
import { sendFriendRequest, type FriendStatus } from '../friends'

// 다른 사람 옆에 붙이는 [+ 친구] 버튼 (피드·랭킹에서 사용)

interface FriendButtonProps {
  userId: string
  status: FriendStatus
  onSent: (userId: string) => void // 요청 성공 시 부모가 관계 표를 'sent'로 바꾼다
}

function FriendButton({ userId, status, onSent }: FriendButtonProps) {
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')

  if (status === 'friend') return <span className="text-xs text-secondary shrink-0">친구</span>
  if (status === 'sent') return <span className="text-xs text-secondary shrink-0">요청 보냄</span>
  if (status === 'received') return <span className="text-xs text-secondary shrink-0">요청 받음</span>

  const handleClick = async () => {
    setError('')
    setSending(true)
    const message = await sendFriendRequest(userId)
    setSending(false)
    if (message) setError(message)
    else onSent(userId)
  }

  return (
    <span className="flex items-center gap-2 shrink-0">
      {error && <span className="text-xs text-red-600">{error}</span>}
      <button
        onClick={handleClick}
        disabled={sending}
        className="px-2 py-0.5 rounded-full text-xs text-secondary border border-accent hover:bg-bg disabled:opacity-50"
      >
        {sending ? '보내는 중...' : '+ 친구'}
      </button>
    </span>
  )
}

export default FriendButton
