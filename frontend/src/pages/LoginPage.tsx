import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const navigate = useNavigate()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      setError('올바른 이메일 형식을 입력해주세요.')
      return
    }
    if (password.length < 8) {
      setError('비밀번호는 8자 이상이어야 합니다.')
      return
    }

    try {
      const res = await fetch('http://localhost:3000/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })

      const result = await res.json()

      if (!res.ok) {
        setError(result.error || '로그인에 실패했습니다.')
        return
      }

      localStorage.setItem('access_token', result.data.access_token)
      navigate('/dashboard')
    } catch (err) {
      setError('서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.')
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg">
      <div className="bg-surface rounded-xl shadow-md p-8 w-full max-w-sm">
        <h1 className="text-2xl font-bold text-primary mb-2 text-center">
          FocusLens
        </h1>
        <p className="text-sm text-secondary mb-6 text-center">
          로그인하고 학습 집중도를 확인하세요
        </p>

        {error && (
          <p className="text-red-600 text-sm text-center mb-3">{error}</p>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label className="block text-sm font-medium text-primary mb-1">
              이메일
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-primary mb-1">
              비밀번호
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
              required
            />
          </div>

          <button
            type="submit"
            className="bg-primary text-white rounded-lg py-2 mt-2 hover:bg-secondary transition-colors"
          >
            로그인
          </button>
        </form>
      </div>
    </div>
  )
}

export default LoginPage