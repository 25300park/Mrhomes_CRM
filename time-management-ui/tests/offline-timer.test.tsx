import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { TodayPage } from '../src/features/today/today-page'

afterEach(cleanup)

describe('offline timer display', () => {
  test('keeps a persisted running timer visible while offline without reconciling or mutating', async () => {
    window.localStorage.setItem('time-management.active-timer', JSON.stringify({
      entryId: '50000000-0000-4000-8000-000000000001', categoryId: '20000000-0000-4000-8000-000000000001', startedAt: '2026-07-29T01:00:00.000Z', crm: { type: 'CONTACT', id: '60000000-0000-4000-8000-000000000001', label: 'Alex Kim' }
    }))
    const api = { get: vi.fn(async () => ({ standard: [{ id: '20000000-0000-4000-8000-000000000001', name: 'Client work' }], personal: [] })), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }
    render(<TodayPage api={api} online={false} />)

    expect(await screen.findByText('Running: Client work')).toBeInTheDocument()
    expect(screen.getByText('CONTACT: Alex Kim')).toBeInTheDocument()
    expect(api.post).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Stop timer' }))
    expect(api.post).not.toHaveBeenCalled()
  })

  test('uses a newer server timer as authoritative on reconnect', async () => {
    window.localStorage.setItem('time-management.active-timer', JSON.stringify({ entryId: 'old-entry', categoryId: 'old-category', startedAt: '2026-07-29T01:00:00.000Z', crm: null }))
    const api = {
      get: vi.fn(async (path: string) => path === '/categories' ? { standard: [{ id: 'other-category', name: 'Other' }, { id: 'new-category', name: 'New work' }], personal: [] } : { plan: null, allocations: [], varianceMinutes: 0 }),
      post: vi.fn(async (path: string) => path === '/entries/timer/reconcile' ? { matches: false, authoritativeEntry: { id: 'new-entry', standard_category_id: 'new-category', started_at: '2026-07-29T02:00:00.000Z', linked_entity_type: null, linked_entity_id: null, linked_entity_label: null } } : {}),
      put: vi.fn(), patch: vi.fn(), delete: vi.fn()
    }
    render(<TodayPage api={api} online />)

    expect(await screen.findByText('Running: New work')).toBeInTheDocument()
    expect(screen.getByLabelText('Timer category')).toHaveValue('new-category')
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem('time-management.active-timer') ?? '{}')).toMatchObject({ entryId: 'new-entry', categoryId: 'new-category' }))
  })

  test('keeps a newer local timer and prompts recovery instead of overwriting it', async () => {
    window.localStorage.setItem('time-management.active-timer', JSON.stringify({ entryId: 'local-entry', categoryId: 'local-category', startedAt: '2026-07-29T03:00:00.000Z', crm: null }))
    const api = {
      get: vi.fn(async (path: string) => path === '/categories' ? { standard: [{ id: 'local-category', name: 'Local work' }, { id: 'server-category', name: 'Server work' }], personal: [] } : { plan: null, allocations: [], varianceMinutes: 0 }),
      post: vi.fn(async () => ({ matches: false, authoritativeEntry: { id: 'server-entry', standard_category_id: 'server-category', started_at: '2026-07-29T02:00:00.000Z', linked_entity_type: null, linked_entity_id: null, linked_entity_label: null } })),
      put: vi.fn(), patch: vi.fn(), delete: vi.fn()
    }
    render(<TodayPage api={api} online />)

    expect(await screen.findByText('Running: Local work')).toBeInTheDocument()
    expect(screen.getByText(/local timer is newer/i)).toBeInTheDocument()
    expect(JSON.parse(window.localStorage.getItem('time-management.active-timer') ?? '{}')).toMatchObject({ entryId: 'local-entry' })
  })

  test('derives elapsed time from the server start timestamp', async () => {
    window.localStorage.setItem('time-management.active-timer', JSON.stringify({ entryId: '50000000-0000-4000-8000-000000000001', categoryId: '20000000-0000-4000-8000-000000000001', startedAt: '2026-07-29T01:00:00.000Z', crm: null }))
    const api = { get: vi.fn(async () => ({ standard: [{ id: '20000000-0000-4000-8000-000000000001', name: 'Client work' }], personal: [] })), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }
    render(<TodayPage api={api} online={false} now={() => Date.parse('2026-07-29T02:30:00.000Z')} />)

    expect(await screen.findByText('Elapsed: 01:30:00')).toBeInTheDocument()
  })
})
