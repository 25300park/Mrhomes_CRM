const jwt = require('jsonwebtoken')
const request = require('supertest')
const { createTestApp } = require('../helpers/app')

const AGENT = { id: '10000000-0000-4000-8000-000000000001', role: 'agent', is_active: true }
const ADMIN = { id: '10000000-0000-4000-8000-000000000002', role: 'admin', is_active: true }
const reflection = { id: '20000000-0000-4000-8000-000000000001', user_id: AGENT.id, business_date: '2026-07-29', reflection_text: 'Worked deeply.', version: 1 }

function bearer(user) { return `Bearer ${jwt.sign({ id: user.id }, process.env.JWT_SECRET)}` }

function reflectionSupabase({ jobInsertError = null } = {}) {
  const events = []
  const persistedReflections = []
  return {
    events,
    persistedReflections,
    supabase: {
      from(table) {
        const filters = {}
        const query = {
          select() { return query },
          eq(key, value) { filters[key] = value; return query },
          single() {
            if (table === 'users') return Promise.resolve({ data: filters.id === ADMIN.id ? ADMIN : AGENT, error: null })
            if (table === 'time_reflections') return Promise.resolve({ data: null, error: { code: 'PGRST116' } })
            if (table === 'time_ai_reviews') return Promise.resolve({ data: null, error: { code: 'PGRST116' } })
            return Promise.resolve({ data: null, error: { code: 'PGRST116' } })
          },
          insert(value) {
            events.push(`${table}:insert`)
            if (table === 'time_reflections') persistedReflections.push({ ...reflection, ...value })
            return { select() { return { single: async () => ({
              data: jobInsertError && table === 'time_jobs' ? null : table === 'time_reflections' ? { ...reflection, ...value } : { id: 'job-1', ...value },
              error: jobInsertError && table === 'time_jobs' ? jobInsertError : null
            }) } } }
          }
        }
        return query
      }
    }
  }
}

test('persists a private reflection before enqueueing its versioned AI job', async () => {
  const fixture = reflectionSupabase()
  const response = await request(createTestApp({ supabase: fixture.supabase }))
    .put('/api/time-management/reflections/today')
    .set('Authorization', bearer(AGENT))
    .send({ reflectionText: 'Worked deeply.' })

  expect(response.status).toBe(201)
  expect(response.body.reflection).toMatchObject({ id: reflection.id, user_id: AGENT.id, version: 1 })
  expect(response.body.job).toMatchObject({ job_type: 'AI_REVIEW', dedupe_key: `${reflection.id}:1` })
  expect(fixture.events).toEqual(['time_reflections:insert', 'time_jobs:insert'])
})

test('keeps the committed reflection when AI job enqueueing fails', async () => {
  const fixture = reflectionSupabase({ jobInsertError: { code: '08006', message: 'queue unavailable' } })
  const response = await request(createTestApp({ supabase: fixture.supabase }))
    .put('/api/time-management/reflections/today')
    .set('Authorization', bearer(AGENT))
    .send({ reflectionText: 'Still retained.' })

  expect(response.status).toBe(500)
  expect(fixture.persistedReflections).toHaveLength(1)
  expect(fixture.persistedReflections[0]).toMatchObject({ user_id: AGENT.id, reflection_text: 'Still retained.' })
})

test('does not let administrators read another users reflection through the private route', async () => {
  const fixture = reflectionSupabase()
  const response = await request(createTestApp({ supabase: fixture.supabase }))
    .get('/api/time-management/reflections/2026-07-29')
    .set('Authorization', bearer(ADMIN))

  expect(response.status).toBe(200)
  expect(response.body.reflection).toBeNull()
})
