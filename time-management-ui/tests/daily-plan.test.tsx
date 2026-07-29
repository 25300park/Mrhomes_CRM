import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { TodayPage } from '../src/features/today/today-page'

afterEach(cleanup)

const CATEGORY = { id: '20000000-0000-4000-8000-000000000001', name: 'Client work' }

function client(overrides: Record<string, unknown> = {}) {
  return {
    get: vi.fn(async (path: string) => {
      if (path === '/categories') return { standard: [CATEGORY], personal: [] }
      if (path === '/plans/today') return { plan: { id: 'plan-1', available_minutes: 480 }, allocations: [], varianceMinutes: 35 }
      return { data: [] }
    }),
    post: vi.fn(async () => ({ matches: true, authoritativeEntry: null })),
    put: vi.fn(async () => ({ plan: { id: 'plan-1' }, warning: { code: 'ALLOCATION_TOTAL_MISMATCH', differenceMinutes: -30 } })),
    patch: vi.fn(),
    delete: vi.fn(),
    ...overrides
  }
}

describe('daily planning', () => {
  test('warns about a plan variance without blocking save', async () => {
    const api = client()
    render(<TodayPage api={api} online />)

    expect(await screen.findByText('35 minutes differ from the plan.')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Available minutes'), { target: { value: '480' } })
    fireEvent.change(screen.getByLabelText('Planned minutes'), { target: { value: '450' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save plan' }))

    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/plans/today', {
      availableMinutes: 480,
      allocations: [{ standardCategoryId: CATEGORY.id, plannedMinutes: 450 }]
    }))
    expect(await screen.findByText('Plan saved with a 30 minute difference.')).toBeInTheDocument()
  })

  test('blocks plan mutations while offline instead of queuing them', async () => {
    const api = client()
    render(<TodayPage api={api} online={false} />)

    await screen.findByLabelText('Available minutes')
    fireEvent.click(screen.getByRole('button', { name: 'Save plan' }))

    expect(api.put).not.toHaveBeenCalled()
    expect(screen.getByText('Offline: plan, manual entry, and reflection changes are unavailable.')).toBeInTheDocument()
  })
})
