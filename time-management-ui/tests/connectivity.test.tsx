import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { TodayPage } from '../src/features/today/today-page'
import { RecordsPage } from '../src/features/records/records-page'

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value })
  window.dispatchEvent(new Event(value ? 'online' : 'offline'))
}

afterEach(() => {
  cleanup()
  setOnline(true)
})

describe('live connectivity', () => {
  test('Today immediately blocks plan mutations after a real offline event', async () => {
    setOnline(true)
    const api = {
      get: vi.fn(async (path: string) => path === '/categories' ? { standard: [{ id: 'category-1', name: 'Work' }], personal: [] } : { plan: null, allocations: [], varianceMinutes: 0 }),
      post: vi.fn(async () => ({ matches: true, authoritativeEntry: null })), put: vi.fn(), patch: vi.fn(), delete: vi.fn()
    }
    render(<TodayPage api={api} />)
    await screen.findByRole('button', { name: 'Save plan' })

    setOnline(false)
    expect(await screen.findByText('Offline: plan, manual entry, and reflection changes are unavailable.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save plan' }))
    expect(api.put).not.toHaveBeenCalled()
  })

  test('Records immediately blocks manual mutations after a real offline event', async () => {
    setOnline(true)
    const api = { get: vi.fn(async (path: string) => path === '/categories' ? { standard: [{ id: 'category-1', name: 'Work' }] } : { entries: [] }), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }
    render(<RecordsPage api={api} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add manual entry' }))

    setOnline(false)
    await screen.findByText('Offline: manual entry changes are unavailable.')
    fireEvent.click(screen.getByRole('button', { name: 'Save manual entry' }))
    expect(api.post).not.toHaveBeenCalled()
  })

  test('Today reconciles when a real online event follows offline display', async () => {
    setOnline(false)
    const api = {
      get: vi.fn(async (path: string) => path === '/categories' ? { standard: [{ id: 'server-category', name: 'Server work' }], personal: [] } : { plan: null, allocations: [], varianceMinutes: 0 }),
      post: vi.fn(async () => ({ matches: false, authoritativeEntry: { id: 'server-entry', standard_category_id: 'server-category', started_at: '2026-07-29T02:00:00.000Z', linked_entity_type: null, linked_entity_id: null, linked_entity_label: null } })),
      put: vi.fn(), patch: vi.fn(), delete: vi.fn()
    }
    render(<TodayPage api={api} />)
    await screen.findByRole('button', { name: 'Start timer' })

    setOnline(true)

    expect(await screen.findByText('Running: Server work')).toBeInTheDocument()
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/entries/timer/reconcile', expect.anything()))
  })

  test('Records reloads records and categories and clears its load error after a real online event', async () => {
    setOnline(false)
    const entry = {
      id: 'entry-1', standard_category_id: 'category-1', started_at: '2026-07-29T01:00:00.000Z', ended_at: '2026-07-29T02:00:00.000Z',
      notes: 'Recovered record', linked_entity_type: null, linked_entity_id: null, linked_entity_label: null, revisions: []
    }
    const api = {
      get: vi.fn(async (path: string) => {
        if (!window.navigator.onLine) throw new Error('offline')
        return path === '/categories' ? { standard: [{ id: 'category-1', name: 'Recovered category' }] } : { entries: [entry] }
      }),
      post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn()
    }
    render(<RecordsPage api={api} now={() => new Date('2026-07-29T01:00:00.000Z')} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Records could not be loaded')

    setOnline(true)

    expect(await screen.findByText('Recovered record')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add manual entry' }))
    expect(screen.getByRole('option', { name: 'Recovered category' })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  test('Today clears a stale offline load alert after reconnecting successfully', async () => {
    setOnline(false)
    const api = {
      get: vi.fn(async (path: string) => {
        if (!window.navigator.onLine) throw new Error('offline')
        return path === '/categories'
          ? { standard: [{ id: 'category-1', name: 'Recovered work' }], personal: [] }
          : { plan: null, allocations: [], varianceMinutes: 0 }
      }),
      post: vi.fn(async () => ({ matches: true, authoritativeEntry: null })),
      put: vi.fn(), patch: vi.fn(), delete: vi.fn()
    }
    render(<TodayPage api={api} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Today data could not be loaded')

    setOnline(true)

    expect(await screen.findByRole('option', { name: 'Recovered work' })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(api.post).toHaveBeenCalledWith('/entries/timer/reconcile', expect.anything())
  })
})
