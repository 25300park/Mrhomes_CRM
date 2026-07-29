import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { TodayPage } from '../src/features/today/today-page'

afterEach(cleanup)

const CATEGORY = { id: '20000000-0000-4000-8000-000000000001', name: 'Client work' }
const ENTRY = { id: '50000000-0000-4000-8000-000000000001', standard_category_id: CATEGORY.id, started_at: '2026-07-29T01:00:00.000Z', linked_entity_type: 'CONTACT', linked_entity_id: '60000000-0000-4000-8000-000000000001', linked_entity_label: 'Alex Kim' }

function client() {
  let active: typeof ENTRY | null = null
  return {
    get: vi.fn(async (path: string) => {
      if (path === '/categories') return { standard: [CATEGORY], personal: [] }
      if (path === '/plans/today') return { plan: null, allocations: [], varianceMinutes: 0 }
      if (path.startsWith('/crm-links')) return { data: [{ type: 'CONTACT', id: ENTRY.linked_entity_id, label: 'Alex Kim' }] }
      return { data: [] }
    }),
    post: vi.fn(async (path: string, body?: Record<string, unknown>) => {
      if (path === '/entries/timer/reconcile') return { matches: true, authoritativeEntry: active }
      if (path === '/entries/timer/start' || path === '/entries/timer/switch') {
        active = { ...ENTRY, standard_category_id: body?.standardCategoryId as string }
        return { started_entry_id: ENTRY.id }
      }
      if (path === '/entries/timer/stop') { active = null; return { stopped_entry_id: ENTRY.id } }
      return {}
    }),
    put: vi.fn(), patch: vi.fn(), delete: vi.fn()
  }
}

describe('timer controls', () => {
  test('starts, switches, and stops with one large action and a fresh request ID', async () => {
    const api = client()
    const ids = ['request-1', 'request-2', 'request-3']
    render(<TodayPage api={api} online requestId={() => ids.shift() ?? 'unexpected'} />)
    await screen.findByRole('button', { name: 'Start timer' })

    fireEvent.click(screen.getByRole('button', { name: 'Start timer' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/entries/timer/start', expect.objectContaining({ requestId: 'request-1', standardCategoryId: CATEGORY.id })))

    fireEvent.click(await screen.findByRole('button', { name: 'Switch timer' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/entries/timer/switch', expect.objectContaining({ requestId: 'request-2' })))

    fireEvent.click(screen.getByRole('button', { name: 'Stop timer' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/entries/timer/stop', { requestId: 'request-3' }))
  })

  test('shows an optional CRM search result by type and label only', async () => {
    const api = client()
    render(<TodayPage api={api} online />)
    await screen.findByRole('button', { name: 'Start timer' })

    fireEvent.change(screen.getByLabelText('Optional CRM link'), { target: { value: 'Alex' } })
    const listbox = await screen.findByRole('listbox', { name: 'CRM search results' })
    fireEvent.click(within(listbox).getByRole('option', { name: 'CONTACT: Alex Kim' }))
    expect(screen.getByText('Linked: CONTACT: Alex Kim')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear CRM link' }))
    expect(screen.queryByText('Linked: CONTACT: Alex Kim')).not.toBeInTheDocument()
    expect(screen.queryByText(ENTRY.linked_entity_id)).not.toBeInTheDocument()
  })

  test('disables timer actions while a command is in flight', async () => {
    let resolveStart: (() => void) | undefined
    const api = client()
    api.post.mockImplementationOnce(async () => ({ matches: true, authoritativeEntry: null }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveStart = () => resolve({ started_entry_id: ENTRY.id }) }))
    render(<TodayPage api={api} online />)
    const start = await screen.findByRole('button', { name: 'Start timer' })

    fireEvent.click(start)
    fireEvent.click(start)

    expect(start).toBeDisabled()
    expect(api.post.mock.calls.filter(([path]) => path === '/entries/timer/start')).toHaveLength(1)
    resolveStart?.()
  })
})
