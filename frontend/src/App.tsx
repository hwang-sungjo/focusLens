import { BrowserRouter, Routes, Route, Link } from 'react-router-dom'
import LoginPage from './pages/LoginPage'
import SessionPage from './pages/SessionPage'
import DashboardPage from './pages/DashboardPage'
import ReportPage from './pages/ReportPage'
import ProfilePage from './pages/ProfilePage'
import ProtectedRoute from './ProtectedRoute'
import RegisterPage from './pages/RegisterPage'
import { useState } from 'react'

function App() {
    const handleLogout = async () => {
    const token = localStorage.getItem('access_token')
    try {
      await fetch('http://localhost:3000/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
    } catch (err) {
      // 서버 요청 실패해도 로컬 토큰은 지운다
    }
    localStorage.removeItem('access_token')
    window.location.href = '/login'
  }
  
  return (
    <BrowserRouter>
      <nav className="flex gap-4 p-4 bg-gray-100">
        <Link to="/login">로그인</Link>
        <Link to="/register">회원가입</Link>
        <Link to="/dashboard">대시보드</Link>
        <Link to="/session">세션</Link>
        <Link to="/reports">리포트</Link>
        <Link to="/profile">프로필</Link>
        <button onClick={handleLogout} className="text-red-600">로그아웃</button>
      </nav>

      <Routes>
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
    </BrowserRouter>
  )
}

export default App