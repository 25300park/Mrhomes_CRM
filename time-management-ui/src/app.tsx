import { useEffect, useState } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { apiClient } from './api/client'
import { AppShell } from './shared/app-shell'

type Role = 'admin' | 'agent'
type Session = { role: Role }

function Placeholder({ title }: { title: string }) {
  return <section className="page-placeholder"><h1>{title}</h1><p>This section is ready for the time-management workflows.</p></section>
}

export function App() {
  const [role, setRole] = useState<Role>('agent')

  useEffect(() => {
    void apiClient.get<Session>('/session').then(session => setRole(session.role)).catch(() => undefined)
  }, [])

  return (
    <BrowserRouter basename="/time-management">
      <AppShell role={role}>
        <Routes>
          <Route index element={<Placeholder title="Today" />} />
          <Route path="records" element={<Placeholder title="Records" />} />
          <Route path="review" element={<Placeholder title="Review" />} />
          <Route path="settings" element={<Placeholder title="Settings" />} />
          <Route path="admin" element={<Placeholder title="Admin" />} />
          <Route path="*" element={<Placeholder title="Today" />} />
        </Routes>
      </AppShell>
    </BrowserRouter>
  )
}
