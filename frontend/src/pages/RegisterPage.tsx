import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'

function RegisterPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [nickname, setNickname] = useState('')
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
    if (!name || !nickname) {
      setError('이름과 닉네임을 입력해주세요.')
      return
    }

    try {
      const res = await fetch('http://localhost:3000/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, name, nickname }),
      })

      const result = await res.json()

      if (!res.ok) {
        setError(result.error || '회원가입에 실패했습니다.')
        return
      }

      navigate('/login?registered=true')
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
          회원가입하고 학습을 시작하세요
        </p>

        {error && (
          <p className="text-red-600 text-sm text-center mb-3">{error}</p>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label className="block text-sm font-medium text-primary mb-1">
              이름
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="홍길동"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-primary mb-1">
              닉네임
            </label>
            <input
              type="text"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="focus_master"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
              required
            />
          </div>

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
            회원가입
          </button>
        </form>

        <p className="text-sm text-center text-secondary mt-4">
          이미 계정이 있으신가요?{' '}
          <Link to="/login" className="text-primary font-medium underline">
            로그인
          </Link>
        </p>
      </div>
    </div>
  )
}

export default RegisterPage