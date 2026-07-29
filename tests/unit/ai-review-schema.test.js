const { dailyReviewSchema, generateAiReview, createOpenAiReviewProvider, getPlanVsActual } = require('../../services/time-management/ai-review')

test('daily review contract rejects empty and overlong model output fields', () => {
  expect(() => dailyReviewSchema.parse({
    keywords: [], summary: '', wins: [], blockers: [], nextActions: []
  })).toThrow()
  expect(() => dailyReviewSchema.parse({
    keywords: ['focus'], summary: 'ok', wins: [], blockers: [], nextActions: ['a', 'b', 'c', 'd']
  })).toThrow()
})

test('generates a validated review using only reflection text and calculated plan data', async () => {
  const received = []
  const provider = {
    async review(input) {
      received.push(input)
      return { keywords: ['focus'], summary: 'Good progress.', wins: ['Finished plan'], blockers: [], nextActions: ['Plan tomorrow'] }
    }
  }

  await expect(generateAiReview({
    provider,
    reflectionText: 'I completed my priority work.',
    planVsActual: { plannedMinutes: 480, trackedMinutes: 420, varianceMinutes: 60 }
  })).resolves.toEqual({
    keywords: ['focus'], summary: 'Good progress.', wins: ['Finished plan'], blockers: [], nextActions: ['Plan tomorrow']
  })
  expect(received).toEqual([{
    reflectionText: 'I completed my priority work.',
    planVsActual: { plannedMinutes: 480, trackedMinutes: 420, varianceMinutes: 60 }
  }])
})

test('rejects a provider response that violates the stored review contract', async () => {
  await expect(generateAiReview({
    provider: { review: async () => ({ keywords: [], summary: '', wins: [], blockers: [], nextActions: [] }) },
    reflectionText: 'Text',
    planVsActual: { plannedMinutes: 0, trackedMinutes: 0, varianceMinutes: 0 }
  })).rejects.toThrow()
})

test('calculates plan-vs-actual from allocations on the selected daily plan only', async () => {
  const allocationFilters = []
  const supabase = {
    from(table) {
      const filters = []
      const query = {
        select() { return query },
        eq(column, value) { filters.push([column, value]); return query },
        single: async () => table === 'time_daily_plans'
          ? { data: { id: 'plan-today', available_minutes: 480 }, error: null }
          : { data: null, error: { code: 'PGRST116' } },
        then(resolve) {
          if (table === 'time_plan_allocations') allocationFilters.push(...filters)
          const data = table === 'time_plan_allocations'
            ? [{ standard_category_id: 'focus', planned_minutes: 120 }]
            : [{ standard_category_id: 'focus', duration_seconds: 3600 }]
          return Promise.resolve({ data, error: null }).then(resolve)
        }
      }
      return query
    }
  }

  await expect(getPlanVsActual({ supabase, userId: 'user-1', businessDate: '2026-07-29' })).resolves.toEqual({
    plannedMinutes: 120, trackedMinutes: 60, varianceMinutes: 60
  })
  expect(allocationFilters).toContainEqual(['daily_plan_id', 'plan-today'])
})

test('OpenAI adapter sends only review inputs and disables response storage', async () => {
  const requests = []
  const provider = createOpenAiReviewProvider({
    apiKey: 'test-key',
    fetchImpl: async (url, request) => {
      requests.push({ url, body: JSON.parse(request.body) })
      return { ok: true, json: async () => ({ output_text: JSON.stringify({ keywords: ['focus'], summary: 'Done.', wins: [], blockers: [], nextActions: ['Rest'] }) }) }
    }
  })

  await expect(provider.review({
    reflectionText: 'Private note',
    planVsActual: { plannedMinutes: 30, trackedMinutes: 20, varianceMinutes: 10 },
    userId: 'must-not-leak'
  })).resolves.toMatchObject({ summary: 'Done.' })
  expect(requests).toEqual([{ url: 'https://api.openai.com/v1/responses', body: expect.objectContaining({
    store: false,
    input: [{ role: 'user', content: expect.stringContaining('Private note') }]
  }) }])
  expect(JSON.stringify(requests[0].body)).not.toContain('must-not-leak')
})
