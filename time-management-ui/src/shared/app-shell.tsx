import { NavLink } from 'react-router'
import type { ReactNode } from 'react'
import './app-shell.css'

type Role = 'admin' | 'agent'

type AppShellProps = {
  children: ReactNode
  role?: Role
}

const navigation = [
  { label: 'Today', to: '/' },
  { label: 'Records', to: '/records' },
  { label: 'Review', to: '/review' },
  { label: 'Settings', to: '/settings' }
]

function Navigation({ className, label, role }: { className: string, label: string, role: Role }) {
  const links = role === 'admin' ? [...navigation, { label: 'Admin', to: '/admin' }] : navigation
  return (
    <nav aria-label={label} className={className}>
      {links.map(({ label: linkLabel, to }) => (
        <NavLink end={to === '/'} key={to} to={to}>{linkLabel}</NavLink>
      ))}
    </nav>
  )
}

export function AppShell({ children, role = 'agent' }: AppShellProps) {
  return (
    <div className="time-management-shell">
      <header className="time-management-header">
        <a className="crm-home" href="/">RBS Homes CRM</a>
        <span>Time Management</span>
      </header>
      <Navigation className="desktop-navigation" label="Time management" role={role} />
      <main>{children}</main>
      <Navigation className="mobile-navigation" label="Mobile time management" role={role} />
    </div>
  )
}
