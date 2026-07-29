import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, test } from 'vitest'
import { AppView } from '../src/app'

afterEach(cleanup)

function renderAdminRoute(role: 'admin' | 'agent' | null) {
  return render(
    <MemoryRouter initialEntries={['/admin']}>
      <AppView role={role} />
    </MemoryRouter>
  )
}

describe('time-management routes', () => {
  test('does not resolve an admin deep link until the session role is authenticated', () => {
    renderAdminRoute(null)

    expect(screen.getByRole('status')).toHaveTextContent('Checking CRM session')
    expect(screen.queryByRole('heading', { name: 'Admin' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Today' })).not.toBeInTheDocument()
  })

  test('redirects an agent who opens the admin route directly to a safe route', () => {
    renderAdminRoute('agent')

    expect(screen.getByRole('heading', { name: 'Today' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Admin' })).not.toBeInTheDocument()
  })

  test('allows an admin to open the admin route directly', () => {
    renderAdminRoute('admin')

    expect(screen.getByRole('heading', { name: 'Admin' })).toBeInTheDocument()
  })
})
