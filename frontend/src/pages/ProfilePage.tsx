import { useEffect, useState } from 'react'
import { apiFetch, readJson, getErrorMessage } from '../api'

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
  const [loadFailed, setLoadFailed] = useState(false) // 불러오기 실패 → 다시 시도 버튼
  const [reloadKey, setReloadKey] = useState(0)

  const userId = localStorage.getItem('user_id')

  useEffect(() => {
    const fetchData = async () => {
      try {
        const profileRes = await apiFetch(`/api/users/${userId}/profile`)
        const profileResult = await readJson(profileRes)
        if (!profileRes.ok) {
          setError(getErrorMessage(profileRes, profileResult, '프로필을 불러오지 못했습니다.'))
          setLoadFailed(true)
          return
        }
        const profile: Profile = profileResult.data
        setNickname(profile.nickname)
        setBio(profile.bio || '')

        const privacyRes = await apiFetch('/api/users/me/privacy')
        const privacyResult = await readJson(privacyRes)
        if (!privacyRes.ok) {
          setError(getErrorMessage(privacyRes, privacyResult, '프라이버시 설정을 불러오지 못했습니다.'))
          setLoadFailed(true)
          return
        }
        setPrivacy(privacyResult.data)
      } catch (err) {
        setError('서버에 연결할 수 없습니다.')
        setLoadFailed(true)
      }
    }

    fetchData()
  }, [reloadKey])

  const handleRetry = () => {
    setError('')
    setLoadFailed(false)
    setReloadKey((k) => k + 1)
  }

  const handleSaveAll = async () => {
    setError('')
    setMessage('')
    setSaving(true)

    try {
      const profileRes = await apiFetch('/api/users/me/profile', {
        method: 'PATCH',
        body: JSON.stringify({ nickname, bio }),
      })
      const profileResult = await readJson(profileRes)
      if (!profileRes.ok) {
        setError(getErrorMessage(profileRes, profileResult, '프로필 저장에 실패했습니다.'))
        setSaving(false)
        return
      }

      if (privacy) {
        const privacyRes = await apiFetch('/api/users/me/privacy', {
          method: 'PATCH',
          body: JSON.stringify(privacy),
        })
        const privacyResult = await readJson(privacyRes)
        if (!privacyRes.ok) {
          setError(getErrorMessage(privacyRes, privacyResult, '프라이버시 설정 저장에 실패했습니다.'))
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

      {error && (
        <div className="flex items-center gap-3 mb-4">
          <p className="text-red-600">{error}</p>
          {loadFailed && (
            <button onClick={handleRetry} className="text-sm text-secondary underline shrink-0">
              다시 시도
            </button>
          )}
        </div>
      )}
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