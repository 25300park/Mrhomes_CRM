import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AdminSummaryPage } from '../src/features/admin/admin-summary-page'

afterEach(cleanup)

describe('admin summary privacy boundary', () => {
  test('renders summaries and team keywords but strips malformed private fields', async () => {
    const api = { get: vi.fn(async () => [{
      user: { id: 'user-1', name: 'Min Seo' },
      metrics: { completion: { plan: true, time: true }, planVarianceMinutes: 15, coreWorkRatio: 0.4 },
      reflection: { reflection_text: 'PRIVATE REFLECTION' }, review: { summary: 'PRIVATE AI SUMMARY' }
    }]), post: vi.fn(async () => ({ status: 'OK', contributorCount: 3, keywords: [{ keyword: 'follow-up', contributorCount: 3, occurrenceCount: 4, summary: 'PRIVATE KEYWORD DETAIL' }] })) }
    render(<AdminSummaryPage api={api} businessDate="2026-07-29" />)

    expect(await screen.findByText('Min Seo')).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('15 minutes over plan')
    expect(screen.getAllByRole('listitem')[1]).toHaveTextContent('follow-up (3 contributors)')
    expect(screen.queryByText(/PRIVATE/)).not.toBeInTheDocument()
  })
})
