import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { PersonalReviewPage } from '../src/features/review/personal-review-page'

afterEach(cleanup)

describe('personal review', () => {
  test('shows completion, plan variance, and core-work ratio as separate metrics', async () => {
    const api = { get: vi.fn(async () => ({
      metrics: { completion: { plan: true, time: true, reflection: false }, planVarianceMinutes: -35, coreWorkRatio: 0.625 },
      reflection: null,
      review: null
    })) }
    render(<PersonalReviewPage api={api} />)

    expect(await screen.findByText('Completion')).toBeInTheDocument()
    expect(screen.getByText('Plan and time complete; reflection pending')).toBeInTheDocument()
    expect(screen.getByText('Plan variance')).toBeInTheDocument()
    expect(screen.getByText('35 minutes under plan')).toBeInTheDocument()
    expect(screen.getByText('Core-work ratio')).toBeInTheDocument()
    expect(screen.getByText('62.5% of tracked time')).toBeInTheDocument()
    expect(screen.queryByText(/score/i)).not.toBeInTheDocument()
  })
})
