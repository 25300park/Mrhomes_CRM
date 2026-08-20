const { calculateDailyMetrics, aggregateTeamKeywords } = require('../../services/time-management/analytics')

test('calculates independent daily completion, absolute category variance, and core-work ratio metrics', () => {
  const metrics = calculateDailyMetrics({
    plan: { is_completed: true },
    allocations: [
      { standard_category_id: 'client', planned_minutes: 120 },
      { standard_category_id: 'admin', planned_minutes: 30 }
    ],
    entries: [
      { standard_category_id: 'client', duration_seconds: 5400, is_focus: true },
      { standard_category_id: 'prospecting', duration_seconds: 1800, is_focus: false },
      { standard_category_id: 'admin', duration_seconds: null, is_focus: false }
    ],
    reflection: { reflection_text: 'Closed the loop.' }
  })

  expect(metrics).toEqual({
    completion: { plan: true, time: true, reflection: true },
    planVarianceMinutes: 90,
    coreWorkRatio: 0.75
  })
  expect(metrics).not.toHaveProperty('score')
})

test('returns null core-work ratio when no completed time has been tracked', () => {
  expect(calculateDailyMetrics({
    plan: { is_completed: false },
    allocations: [],
    entries: [{ standard_category_id: 'client', duration_seconds: null, is_focus: true }],
    reflection: null
  })).toEqual({
    completion: { plan: false, time: false, reflection: false },
    planVarianceMinutes: 0,
    coreWorkRatio: null
  })
})

test('does not aggregate a keyword contributed by fewer than three active people', async () => {
  const writes = []
  const result = await aggregateTeamKeywords({
    supabase: keywordSupabase({
      users: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      reflections: [
        { id: 'r1', user_id: 'a', version: 1, business_date: '2026-07-01' },
        { id: 'r2', user_id: 'b', version: 1, business_date: '2026-07-01' },
        { id: 'r3', user_id: 'c', version: 1, business_date: '2026-07-01' }
      ],
      reviews: [
        { reflection_id: 'r1', user_id: 'a', reflection_version: 1, keywords: ['Focus'] },
        { reflection_id: 'r2', user_id: 'b', reflection_version: 1, keywords: ['focus'] },
        { reflection_id: 'r3', user_id: 'c', reflection_version: 1, keywords: ['Planning'] }
      ],
      writes
    }),
    actor: { id: 'admin', role: 'admin', is_active: true },
    periodStart: '2026-07-01',
    periodEnd: '2026-07-07'
  })

  expect(result).toEqual({ status: 'OK', contributorCount: 3, keywords: [] })
  expect(writes).toEqual([])
})

test('persists only normalized aggregate fields after three distinct contributors share a keyword', async () => {
  const writes = []
  const result = await aggregateTeamKeywords({
    supabase: keywordSupabase({
      users: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      reflections: [
        { id: 'r1', user_id: 'a', version: 1, business_date: '2026-07-01' },
        { id: 'r2', user_id: 'b', version: 1, business_date: '2026-07-02' },
        { id: 'r3', user_id: 'c', version: 1, business_date: '2026-07-03' }
      ],
      reviews: [
        { reflection_id: 'r1', user_id: 'a', reflection_version: 1, keywords: ['  Focus  '] },
        { reflection_id: 'r2', user_id: 'b', reflection_version: 1, keywords: ['FOCUS'] },
        { reflection_id: 'r3', user_id: 'c', reflection_version: 1, keywords: ['focus'] }
      ],
      writes
    }),
    actor: { id: 'admin', role: 'admin', is_active: true },
    periodStart: '2026-07-01',
    periodEnd: '2026-07-07'
  })

  expect(result).toEqual({
    status: 'OK', contributorCount: 3,
    keywords: [{ keyword: 'focus', contributorCount: 3, occurrenceCount: 3 }]
  })
  expect(writes).toEqual([{
    period_start: '2026-07-01', period_end: '2026-07-07', keyword: 'focus',
    contributor_count: 3, occurrence_count: 3
  }])
  expect(JSON.stringify(writes)).not.toContain('user_id')
})

test('does not aggregate AI keywords from an older private reflection revision', async () => {
  const writes = []
  const result = await aggregateTeamKeywords({
    supabase: keywordSupabase({
      users: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      reflections: [
        { id: 'r1', user_id: 'a', version: 2, business_date: '2026-07-01' },
        { id: 'r2', user_id: 'b', version: 1, business_date: '2026-07-02' },
        { id: 'r3', user_id: 'c', version: 1, business_date: '2026-07-03' }
      ],
      reviews: [
        { reflection_id: 'r1', user_id: 'a', reflection_version: 1, keywords: ['Focus'] },
        { reflection_id: 'r2', user_id: 'b', reflection_version: 1, keywords: ['Focus'] },
        { reflection_id: 'r3', user_id: 'c', reflection_version: 1, keywords: ['Focus'] }
      ],
      writes
    }),
    actor: { id: 'admin', role: 'admin', is_active: true },
    periodStart: '2026-07-01',
    periodEnd: '2026-07-07'
  })

  expect(result).toEqual({ status: 'INSUFFICIENT_DATA', contributorCount: 2, keywords: [] })
  expect(writes).toEqual([])
})

test('requires three current-review contributors even when three active people authored reflections', async () => {
  const writes = []
  const result = await aggregateTeamKeywords({
    supabase: keywordSupabase({
      users: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      reflections: [
        { id: 'r1', user_id: 'a', version: 1, business_date: '2026-07-01' },
        { id: 'r2', user_id: 'b', version: 1, business_date: '2026-07-02' },
        { id: 'r3', user_id: 'c', version: 1, business_date: '2026-07-03' }
      ],
      reviews: [
        { reflection_id: 'r1', user_id: 'a', reflection_version: 1, keywords: ['Focus'] },
        { reflection_id: 'r2', user_id: 'b', reflection_version: 1, keywords: ['Planning'] }
      ],
      writes
    }),
    actor: { id: 'admin', role: 'admin', is_active: true },
    periodStart: '2026-07-01',
    periodEnd: '2026-07-07'
  })

  expect(result).toEqual({ status: 'INSUFFICIENT_DATA', contributorCount: 2, keywords: [] })
  expect(writes).toEqual([])
})

test('accepts the exact boundary of three current-review contributors', async () => {
  const writes = []
  const result = await aggregateTeamKeywords({
    supabase: keywordSupabase({
      users: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      reflections: [
        { id: 'r1', user_id: 'a', version: 1, business_date: '2026-07-01' },
        { id: 'r2', user_id: 'b', version: 1, business_date: '2026-07-02' },
        { id: 'r3', user_id: 'c', version: 1, business_date: '2026-07-03' }
      ],
      reviews: [
        { reflection_id: 'r1', user_id: 'a', reflection_version: 1, keywords: ['Focus'] },
        { reflection_id: 'r2', user_id: 'b', reflection_version: 1, keywords: ['Planning'] },
        { reflection_id: 'r3', user_id: 'c', reflection_version: 1, keywords: ['Follow up'] }
      ],
      writes
    }),
    actor: { id: 'admin', role: 'admin', is_active: true },
    periodStart: '2026-07-01',
    periodEnd: '2026-07-07'
  })

  expect(result).toEqual({ status: 'OK', contributorCount: 3, keywords: [] })
  expect(writes).toEqual([])
})

function keywordSupabase({ users, reflections, reviews, writes }) {
  return {
    from(table) {
      const query = {
        select() { return query },
        eq() { return query },
        gte() { return query },
        lte() { return query },
        in() { return query },
        then(resolve, reject) {
          const data = table === 'users' ? users : table === 'time_reflections' ? reflections : reviews
          return Promise.resolve({ data, error: null }).then(resolve, reject)
        },
        upsert(value) {
          writes.push(...value)
          return { select: () => Promise.resolve({ data: value, error: null }) }
        }
      }
      return query
    }
  }
}
