import { useState } from 'react'
import { BrowserRouter, Routes, Route, Link, useLocation, Navigate } from 'react-router-dom'
import LoginPage from './pages/LoginPage'
import SessionPage from './pages/SessionPage'
import DashboardPage from './pages/DashboardPage'
import ReportPage from './pages/ReportPage'
import ProfilePage from './pages/ProfilePage'
import ProtectedRoute from './ProtectedRoute'
import RegisterPage from './pages/RegisterPage'
import { apiFetch, clearAuth } from './api'

function AppContent() {
  const location = useLocation()
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const isLoggedIn = !!localStorage.getItem('access_token')
  const hideNav = location.pathname === '/login' || location.pathname === '/register'

  const handleLogout = async () => {
    try {
      // 401이어도 갱신하지 않음: 어차피 로그아웃할 것이므로 그대로 진행
      await apiFetch('/api/auth/logout', { method: 'POST', skipAuthRefresh: true })
    } catch {
      // 서버 요청 실패해도 로컬 토큰은 지운다
    }
    clearAuth()
    window.location.href = '/login'
  }

  return (
    <>
      {!hideNav && isLoggedIn && (
        <nav className="bg-surface shadow-sm">
          <div className="flex items-center justify-between px-6 py-3">
            <Link to="/dashboard" className="text-base sm:text-lg font-bold text-primary shrink-0">
              FocusLens
            </Link>

            <div className="flex items-center gap-3 sm:gap-6">
              {/* 넓은 화면: 메뉴 그대로 노출 */}
              <div className="hidden md:flex items-center gap-6">
                <Link to="/dashboard" className="text-sm text-secondary hover:text-primary">
                  대시보드
                </Link>
                <Link to="/session" className="text-sm text-secondary hover:text-primary">
                  세션
                </Link>
                <Link to="/reports" className="text-sm text-secondary hover:text-primary">
                  리포트
                </Link>
              </div>

              {/* 좁은 화면: 햄버거 버튼 */}
              <button
                onClick={() => setMobileMenuOpen((prev) => !prev)}
                className="md:hidden text-2xl text-primary"
              >
                ☰
              </button>

              <div className="relative">
                <button
                  onClick={() => setDropdownOpen((prev) => !prev)}
                  className="w-8 h-8 rounded-full bg-accent text-white flex items-center justify-center text-sm font-medium"
                >
                  👤
                </button>

                {dropdownOpen && (
                  <div className="absolute right-0 mt-2 w-40 bg-surface rounded-lg shadow-md py-2 z-10">
                    <Link
                      to="/profile"
                      onClick={() => setDropdownOpen(false)}
                      className="block px-4 py-2 text-sm text-secondary hover:bg-bg"
                    >
                      프로필 / 설정
                    </Link>
                    <button
                      onClick={handleLogout}
                      className="block w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-bg"
                    >
                      로그아웃
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* 좁은 화면: 펼쳐지는 메뉴 */}
          {mobileMenuOpen && (
            <div className="md:hidden flex flex-col px-6 pb-3 gap-2">
              <Link
                to="/dashboard"
                onClick={() => setMobileMenuOpen(false)}
                className="text-sm text-secondary hover:text-primary py-1"
              >
                대시보드
              </Link>
              <Link
                to="/session"
                onClick={() => setMobileMenuOpen(false)}
                className="text-sm text-secondary hover:text-primary py-1"
              >
                세션
              </Link>
              <Link
                to="/reports"
                onClick={() => setMobileMenuOpen(false)}
                className="text-sm text-secondary hover:text-primary py-1"
              >
                리포트
              </Link>
            </div>
          )}
        </nav>
      )}

      <Routes>
        {/* 첫 주소: 대시보드로 보냄 (로그인 전이면 ProtectedRoute가 /login으로 보냄) */}
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        {/* 없는 주소: 첫 주소로 보냄 */}
        <Route path="*" element={<Navigate to="/" replace />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <DashboardPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/session"
          element={
            <ProtectedRoute>
              <SessionPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/reports"
          element={
            <ProtectedRoute>
              <ReportPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/profile"
          element={
            <ProtectedRoute>
              <ProfilePage />
            </ProtectedRoute>
          }
        />
      </Routes>
    </>
  )
}

function App() {
  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  )
}

export default App