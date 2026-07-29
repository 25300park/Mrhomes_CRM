import { useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { apiClient } from './api/client'
import { TodayPage } from './features/today/today-page'
import { RecordsPage } from './features/records/records-page'
import { AppShell } from './shared/app-shell'

type Role = 'admin' | 'agent'
type Session = { role: Role }

function Placeholder({ title }: { title: string }) {
  return <section className="page-placeholder"><h1>{title}</h1><p>This section is ready for the time-management workflows.</p></section>
}

export function AppView({ role }: { role: Role | null }) {
  if (role === null) {
    return <main className="page-placeholder"><p role="status">Checking CRM session…</p></main>
  }

  return (
    <AppShell role={role}>
      <Routes>
        <Route index element={<TodayPage />} />
        <Route path="records" element={<RecordsPage />} />
        <Route path="review" element={<Placeholder title="Review" />} />
        <Route path="settings" element={<Placeholder title="Settings" />} />
        <Route path="admin" element={role === 'admin' ? <Placeholder title="Admin" /> : <Navigate replace to="/" />} />
        <Route path="*" element={<Placeholder title="Today" />} />
      </Routes>
    </AppShell>
  )
}

export function App() {
  const [role, setRole] = useState<Role | null>(null)

  useEffect(() => {
    void apiClient.get<Session>('/session').then(session => setRole(session.role)).catch(() => setRole('agent'))
  }, [])

  return (
    <BrowserRouter basename="/time-management">
      <AppView role={role} />
    </BrowserRouter>
  )
}
