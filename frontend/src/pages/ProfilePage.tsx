import { useEffect, useState } from 'react'

interface Profile {
  user_id: string
  nickname: string
  profile_image_url: string | null
  bio: string | null
}

interface Privacy {
  default_session_scope: 'PUBLIC' | 'FRIENDS' | 'GROUP' | 'PRIVATE'
  score_visibility: 'PUBLIC' | 'FRIENDS' | 'GROUP' | 'PRIVATE'
  study_time_visibility: 'PUBLIC' | 'FRIENDS' | 'GROUP' | 'PRIVATE'
  group_data_sharing: boolean
  ranking_participation: boolean
}

function ProfilePage() {
  const [nickname, setNickname] = useState('')
  const [bio, setBio] = useState('')
  const [privacy, setPrivacy] = useState<Privacy | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)

  const token = localStorage.getItem('access_token')
  const userId = localStorage.getItem('user_id')

  useEffect(() => {
    const fetchData = async () => {
      try {
        const profileRes = await fetch(`http://localhost:3000/api/users/${userId}/profile`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        const profileResult: { data: Profile } = await profileRes.json()
        if (profileRes.ok) {
          setNickname(profileResult.data.nickname)
          setBio(profileResult.data.bio || '')
        }

        const privacyRes = await fetch('http://localhost:3000/api/users/me/privacy', {
          headers: { Authorization: `Bearer ${token}` },
        })
        const privacyResult = await privacyRes.json()
        if (privacyRes.ok) {
          setPrivacy(privacyResult.data)
        }
      } catch (err) {
        setError('정보를 불러오지 못했습니다.')
      }
    }

    fetchData()
  }, [])

  const handleSaveAll = async () => {
    setError('')
    setMessage('')
    setSaving(true)

    try {
      const profileRes = await fetch('http://localhost:3000/api/users/me/profile', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ nickname, bio }),
      })
      const profileResult = await profileRes.json()
      if (!profileRes.ok) {
        setError(profileResult.error || '프로필 저장에 실패했습니다.')
        setSaving(false)
        return
      }

      if (privacy) {
        const privacyRes = await fetch('http://localhost:3000/api/users/me/privacy', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(privacy),
        })
        const privacyResult = await privacyRes.json()
        if (!privacyRes.ok) {
          setError(privacyResult.error || '프라이버시 설정 저장에 실패했습니다.')
          setSaving(false)
          return
        }
      }

      setMessage('설정이 저장되었습니다.')
    } catch (err) {
      setError('서버에 연결할 수 없습니다.')
    } finally {
      setSaving(false)
    }
  }

  const updatePrivacyField = (field: keyof Privacy, value: string | boolean) => {
    if (!privacy) return
    setPrivacy({ ...privacy, [field]: value })
  }

  const scopeOptions = ['PUBLIC', 'FRIENDS', 'GROUP', 'PRIVATE'] as const

  return (
    <div className="min-h-screen bg-bg p-6">
      <h1 className="text-2xl font-bold text-primary mb-6">프로필 / 설정</h1>

      {error && <p className="text-red-600 mb-4">{error}</p>}
      {message && <p className="text-green-600 mb-4">{message}</p>}

      <div className="max-w-xl space-y-6">
        {/* 프로필 수정 */}
        <div className="bg-surface rounded-xl shadow-md p-6">
          <p className="text-sm font-medium text-primary mb-4">개인 정보</p>

          <div className="space-y-3">
            <div>
              <label className="block text-sm text-secondary mb-1">닉네임</label>
              <input
                type="text"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
            <div>
              <label className="block text-sm text-secondary mb-1">소개</label>
              <textarea
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                rows={3}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
          </div>
        </div>

        {/* 프라이버시 설정 */}
        {privacy && (
          <div className="bg-surface rounded-xl shadow-md p-6">
            <p className="text-sm font-medium text-primary mb-4">프라이버시 설정</p>

            <div className="space-y-4">
              <div>
                <label className="block text-sm text-secondary mb-1">기본 세션 공개 범위</label>
                <select
                  value={privacy.default_session_scope}
                  onChange={(e) => updatePrivacyField('default_session_scope', e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                >
                  {scopeOptions.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm text-secondary mb-1">점수 공개 범위</label>
                <select
                  value={privacy.score_visibility}
                  onChange={(e) => updatePrivacyField('score_visibility', e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                >
                  {scopeOptions.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              </div>

              <label className="flex items-center gap-2 text-sm text-secondary">
                <input
                  type="checkbox"
                  checked={privacy.ranking_participation}
                  onChange={(e) => updatePrivacyField('ranking_participation', e.target.checked)}
                />
                랭킹 참여
              </label>

              <label className="flex items-center gap-2 text-sm text-secondary">
                <input
                  type="checkbox"
                  checked={privacy.group_data_sharing}
                  onChange={(e) => updatePrivacyField('group_data_sharing', e.target.checked)}
                />
                그룹 데이터 공유
              </label>
            </div>
          </div>
        )}

        <div className="flex justify-center">
          <button
            onClick={handleSaveAll}
            disabled={saving}
            className="bg-primary text-white rounded-lg px-6 py-2 hover:bg-secondary transition-colors disabled:opacity-50"
          >
            {saving ? '저장 중...' : '저장하기'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default ProfilePage