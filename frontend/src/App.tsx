import { BrowserRouter, Routes, Route, Link } from 'react-router-dom'
import LoginPage from './pages/LoginPage'
import SessionPage from './pages/SessionPage'
import DashboardPage from './pages/DashboardPage'
import ReportPage from './pages/ReportPage'
import ProfilePage from './pages/ProfilePage'

function App() {
  return (
    <BrowserRouter>
      <nav className="flex gap-4 p-4 bg-gray-100">
        <Link to="/login">로그인</Link>
        <Link to="/dashboard">대시보드</Link>
        <Link to="/session">세션</Link>
        <Link to="/reports">리포트</Link>
        <Link to="/profile">프로필</Link>
      </nav>

      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/session" element={<SessionPage />} />
        <Route path="/reports" element={<ReportPage />} />
        <Route path="/profile" element={<ProfilePage />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App