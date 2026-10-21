import { Navigate, Route, Routes } from 'react-router-dom'
import { StaffShell } from './components/StaffShell'
import { ControlPage } from './pages/ControlPage'
import { DisplayPage } from './pages/DisplayPage'
import { LoginPage, SetupPage } from './pages/LoginPage'
import { MediaPage } from './pages/MediaPage'
import { PairPage } from './pages/PairPage'
import { ReportsPage } from './pages/ReportsPage'
import { SessionsPage } from './pages/SessionsPage'
import { AccountPage, UsersPage } from './pages/UsersPage'

export default function App() {
  return (
    <Routes>
      {/* Device views — no staff login (the display uses its own paired-device credential) */}
      <Route path="/auction/display/:sessionId" element={<DisplayPage />} />
      <Route path="/auction/pair" element={<PairPage />} />

      {/* Sign-in */}
      <Route path="/auction/login" element={<LoginPage />} />
      <Route path="/auction/setup" element={<SetupPage />} />

      {/* Staff views — require sign-in */}
      <Route element={<StaffShell />}>
        <Route path="/auction/control" element={<ControlPage />} />
        <Route path="/auction/sessions" element={<SessionsPage />} />
        <Route path="/auction/reports" element={<ReportsPage />} />
        <Route path="/auction/users" element={<UsersPage />} />
        <Route path="/auction/media" element={<MediaPage />} />
        <Route path="/auction/account" element={<AccountPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/auction/control" replace />} />
    </Routes>
  )
}
