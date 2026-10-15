import { Navigate, Route, Routes } from 'react-router-dom'
import { StaffShell } from './components/StaffShell'
import { ControlPage } from './pages/ControlPage'
import { DisplayPage } from './pages/DisplayPage'
import { PairPage } from './pages/PairPage'
import { ReportsPage } from './pages/ReportsPage'
import { SessionsPage } from './pages/SessionsPage'

export default function App() {
  return (
    <Routes>
      {/* Device views — no staff chrome, no staff login */}
      <Route path="/auction/display/:sessionId" element={<DisplayPage />} />
      <Route path="/auction/pair" element={<PairPage />} />

      {/* Staff views */}
      <Route element={<StaffShell />}>
        <Route path="/auction/control" element={<ControlPage />} />
        <Route path="/auction/sessions" element={<SessionsPage />} />
        <Route path="/auction/reports" element={<ReportsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/auction/control" replace />} />
    </Routes>
  )
}
