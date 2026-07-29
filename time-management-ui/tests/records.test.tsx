import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { RecordsPage } from '../src/features/records/records-page'

afterEach(cleanup)

const ENTRY = {
  id: '50000000-0000-4000-8000-000000000001', standard_category_id: '20000000-0000-4000-8000-000000000001',
  started_at: '2026-07-29T01:00:00.000Z', ended_at: '2026-07-29T02:00:00.000Z', notes: 'Follow up',
  linked_entity_type: 'CONTACT', linked_entity_id: '60000000-0000-4000-8000-000000000001', linked_entity_label: 'Archived contact',
  revisions: [{ id: 'revision-1', changed_at: '2026-07-29T03:00:00.000Z', changed_by: '10000000-0000-4000-8000-000000000001' }]
}

describe('records editing', () => {
  test('shows owner records, revision metadata, and the stored CRM snapshot fallback', async () => {
    const api = { get: vi.fn(async (path: string) => path === '/categories' ? { standard: [{ id: ENTRY.standard_category_id, name: 'Client work' }] } : { entries: [ENTRY] }), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }
    render(<RecordsPage api={api} online />)

    expect(await screen.findByText('Archived contact')).toBeInTheDocument()
    expect(screen.getByText('1 revision')).toBeInTheDocument()
    expect(screen.getByText('CRM link unavailable; showing stored snapshot.')).toBeInTheDocument()
  })

  test('requires an explicit confirmation before a manual entry mutation', async () => {
    const api = { get: vi.fn(async (path: string) => path === '/categories' ? { standard: [{ id: ENTRY.standard_category_id, name: 'Client work' }] } : { entries: [] }), post: vi.fn(async () => ({ entry_id: ENTRY.id })), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }
    render(<RecordsPage api={api} online requestId={() => 'manual-1'} />)
    await screen.findByRole('button', { name: 'Add manual entry' })

    fireEvent.click(screen.getByRole('button', { name: 'Add manual entry' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save manual entry' }))
    expect(api.post).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm manual entry' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/entries/manual', expect.objectContaining({ requestId: 'manual-1' })))
  })

  test('requires an explicit confirmation before revising a record', async () => {
    const api = { get: vi.fn(async (path: string) => path === '/categories' ? { standard: [{ id: ENTRY.standard_category_id, name: 'Client work' }] } : { entries: [ENTRY] }), post: vi.fn(), put: vi.fn(), patch: vi.fn(async () => ({ entry_id: ENTRY.id })), delete: vi.fn() }
    render(<RecordsPage api={api} online requestId={() => 'revise-1'} />)
    await screen.findByRole('button', { name: 'Edit record' })

    fireEvent.click(screen.getByRole('button', { name: 'Edit record' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save revision' }))
    expect(api.patch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm revision' }))
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith(`/entries/${ENTRY.id}`, { requestId: 'revise-1', notes: 'Follow up' }))
  })

  test('never queues manual changes offline', async () => {
    const api = { get: vi.fn(async (path: string) => path === '/categories' ? { standard: [{ id: ENTRY.standard_category_id, name: 'Client work' }] } : { entries: [] }), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }
    render(<RecordsPage api={api} online={false} />)
    await screen.findByRole('button', { name: 'Add manual entry' })
    fireEvent.click(screen.getByRole('button', { name: 'Add manual entry' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save manual entry' }))

    expect(api.post).not.toHaveBeenCalled()
    expect(screen.getByRole('status')).toHaveTextContent('Offline: manual entry changes are unavailable.')
  })
})
