import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, test } from 'vitest'
import { AppShell } from '../src/shared/app-shell'

function renderShell(role: 'admin' | 'agent' = 'agent') {
  return render(
    <MemoryRouter>
      <AppShell role={role}><h1>Today content</h1></AppShell>
    </MemoryRouter>
  )
}

describe('time-management application shell', () => {
  test('offers Today, Records, Review, and Settings in desktop and mobile navigation', () => {
    renderShell()

    expect(screen.getByRole('navigation', { name: 'Time management' })).toHaveTextContent('Today')
    expect(screen.getByRole('navigation', { name: 'Time management' })).toHaveTextContent('Records')
    expect(screen.getByRole('navigation', { name: 'Time management' })).toHaveTextContent('Review')
    expect(screen.getByRole('navigation', { name: 'Time management' })).toHaveTextContent('Settings')
    expect(screen.getByRole('navigation', { name: 'Mobile time management' })).toHaveTextContent('Today')
    expect(screen.getByRole('navigation', { name: 'Mobile time management' })).toHaveTextContent('Settings')
  })

  test('keeps Admin navigation hidden from non-admin users', () => {
    renderShell('agent')

    expect(screen.queryByRole('link', { name: 'Admin' })).not.toBeInTheDocument()
  })

  test('shows Admin navigation to admins', () => {
    renderShell('admin')

    expect(screen.getAllByRole('link', { name: 'Admin' })).toHaveLength(2)
  })
})
