const { getPersonalReview, getAdminMemberSummaries, aggregateTeamKeywords } = require('../../services/time-management/analytics')
const jwt = require('jsonwebtoken')
const request = require('supertest')
const { createTestApp } = require('../helpers/app')
const { SESSION_COOKIE } = require('../../services/session')

const AGENT = { id: 'agent-1', role: 'agent', is_active: true }
const ADMIN = { id: 'admin-1', role: 'admin', is_active: true }

test('personal review keeps the owner reflection and AI review available only in the personal read model', async () => {
  const result = await getPersonalReview({ supabase: personalSupabase(), actor: AGENT, businessDate: '2026-07-29' })

  expect(result.reflection).toMatchObject({ reflection_text: 'Private reflection' })
  expect(result.review).toMatchObject({ summary: 'Private AI summary', keywords: ['focus'] })
})

test('personal review returns empty private fields when the valid date has no reflection', async () => {
  const result = await getPersonalReview({
    supabase: querySupabase({
      users: AGENT,
      time_daily_plans: { id: 'p1', is_completed: false },
      time_plan_allocations: [],
      time_entries: []
    }),
    actor: AGENT,
    businessDate: '2026-07-28'
  })

  expect(result).toEqual({
    metrics: {
      completion: { plan: false, time: false, reflection: false },
      planVarianceMinutes: 0,
      coreWorkRatio: null
    },
    reflection: null,
    review: null
  })
})

test('personal review scopes every private query to the authenticated owner', async () => {
  const fixture = scopedPersonalSupabase()
  await getPersonalReview({ supabase: fixture.supabase, actor: AGENT, businessDate: '2026-07-29' })

  for (const table of ['time_daily_plans', 'time_plan_allocations', 'time_entries', 'time_reflections', 'time_ai_reviews']) {
    expect(fixture.calls).toContainEqual({ table, column: 'user_id', value: AGENT.id })
  }
})

test('admin member summaries select and return only plan, time, and independent metric fields', async () => {
  const fixture = adminSupabase()
  const result = await getAdminMemberSummaries({
    supabase: fixture.supabase, actor: ADMIN, businessDate: '2026-07-29'
  })

  expect(result).toEqual([{
    user: { id: AGENT.id, name: 'Agent' },
    metrics: {
      completion: { plan: true, time: true },
      planVarianceMinutes: 0,
      coreWorkRatio: 1
    }
  }])
  const exposed = JSON.stringify(result)
  for (const forbidden of ['reflection', 'summary', 'keywords', 'wins', 'blockers', 'nextActions', 'revision']) {
    expect(exposed.toLowerCase()).not.toContain(forbidden.toLowerCase())
  }
  const selected = fixture.calls.filter(call => call.operation === 'select').map(call => call.columns).join(',')
  for (const forbidden of ['reflection_text', 'summary', 'keywords', 'wins', 'blockers', 'next_actions', 'version', 'time_entry_revisions']) {
    expect(selected).not.toContain(forbidden)
  }
})

test('team keyword aggregation reports insufficient data before three distinct active contributors', async () => {
  const result = await aggregateTeamKeywords({
    supabase: aggregateSupabase(), actor: ADMIN, periodStart: '2026-07-01', periodEnd: '2026-07-07'
  })

  expect(result).toEqual({ status: 'INSUFFICIENT_DATA', contributorCount: 0, keywords: [] })
})

test('admin analytics route is authenticated and does not disclose private review fields', async () => {
  const response = await request(createTestApp({ supabase: analyticsRouteSupabase() }))
    .get('/api/time-management/analytics/admin/members/2026-07-29')
    .set('Authorization', `Bearer ${jwt.sign({ id: ADMIN.id }, process.env.JWT_SECRET)}`)

  expect(response.status).toBe(200)
  expect(response.body).toEqual([{
    user: { id: AGENT.id, name: 'Agent' },
    metrics: { completion: { plan: true, time: true }, planVarianceMinutes: 0, coreWorkRatio: 1 }
  }])
  expect(JSON.stringify(response.body).toLowerCase()).not.toMatch(/reflection|summary|keywords|wins|blockers|nextactions|revision/)
})

test('an agent cannot access administrator analytics', async () => {
  const response = await request(createTestApp({ supabase: analyticsRouteSupabase() }))
    .get('/api/time-management/analytics/admin/members/2026-07-29')
    .set('Authorization', `Bearer ${jwt.sign({ id: AGENT.id }, process.env.JWT_SECRET)}`)

  expect(response.status).toBe(403)
  expect(response.body.error.code).toBe('FORBIDDEN')
})

test('cookie-authenticated keyword aggregation retains CSRF protection', async () => {
  const token = jwt.sign({ id: ADMIN.id }, process.env.JWT_SECRET)
  const response = await request(createTestApp({ supabase: analyticsRouteSupabase() }))
    .post('/api/time-management/analytics/admin/team-keywords')
    .set('Cookie', `${SESSION_COOKIE}=${token}`)
    .send({ periodStart: '2026-07-01', periodEnd: '2026-07-07' })

  expect(response.status).toBe(403)
  expect(response.body.error.code).toBe('CSRF_INVALID')
})

function personalSupabase() {
  return querySupabase(personalRows())
}

function scopedPersonalSupabase() {
  const calls = []
  return { supabase: querySupabase(personalRows(), calls), calls }
}

function personalRows() {
  return {
    users: AGENT,
    time_daily_plans: { id: 'p1', is_completed: true },
    time_plan_allocations: [{ standard_category_id: 'focus', planned_minutes: 60 }],
    time_entries: [{ standard_category_id: 'focus', duration_seconds: 3600, is_focus: true }],
    time_reflections: { id: 'r1', user_id: AGENT.id, reflection_text: 'Private reflection', version: 1 },
    time_ai_reviews: { summary: 'Private AI summary', keywords: ['focus'], wins: [], blockers: [], next_actions: [] }
  }
}

function adminSupabase() {
  const calls = []
  return {
    calls,
    supabase: querySupabase({
      users: [{ id: AGENT.id, name: 'Agent', is_active: true }],
      time_daily_plans: [{ id: 'p1', user_id: AGENT.id, is_completed: true }],
      time_plan_allocations: [{ daily_plan_id: 'p1', standard_category_id: 'focus', planned_minutes: 60 }],
      time_entries: [{ user_id: AGENT.id, standard_category_id: 'focus', duration_seconds: 3600, is_focus: true }]
    }, calls)
  }
}

function aggregateSupabase() {
  return querySupabase({
    users: [{ id: 'a' }, { id: 'b' }],
    time_reflections: [{ id: 'r1', user_id: 'a' }, { id: 'r2', user_id: 'b' }],
    time_ai_reviews: []
  })
}

function analyticsRouteSupabase() {
  return {
    from(table) {
      const filters = {}
      const query = {
        select() { return query },
        eq(key, value) { filters[key] = value; return query },
        in() { return query },
        single() {
          if (table === 'users') {
            const user = filters.id === ADMIN.id ? ADMIN : filters.id === AGENT.id ? AGENT : null
            return Promise.resolve({ data: user, error: user ? null : { code: 'PGRST116' } })
          }
          return Promise.resolve({ data: null, error: { code: 'PGRST116' } })
        },
        then(resolve, reject) {
          const data = table === 'users' ? [{ id: AGENT.id, name: 'Agent' }]
            : table === 'time_daily_plans' ? [{ id: 'p1', user_id: AGENT.id, is_completed: true }]
              : table === 'time_plan_allocations' ? [{ daily_plan_id: 'p1', standard_category_id: 'focus', planned_minutes: 60 }]
                : table === 'time_entries' ? [{ user_id: AGENT.id, standard_category_id: 'focus', duration_seconds: 3600, time_standard_categories: { is_focus: true } }]
                  : []
          return Promise.resolve({ data, error: null }).then(resolve, reject)
        }
      }
      return query
    }
  }
}

function querySupabase(rows, calls = []) {
  return {
    from(table) {
      const query = {
        select(columns) { calls.push({ table, operation: 'select', columns }); return query },
        eq(column, value) { calls.push({ table, column, value }); return query },
        gte() { return query },
        lte() { return query },
        in() { return query },
        single() { return Promise.resolve({ data: rows[table] ?? null, error: rows[table] ? null : { code: 'PGRST116' } }) },
        then(resolve, reject) { return Promise.resolve({ data: rows[table] ?? [], error: null }).then(resolve, reject) }
      }
      return query
    }
  }
}
