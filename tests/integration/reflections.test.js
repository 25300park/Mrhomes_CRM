const jwt = require('jsonwebtoken')
const request = require('supertest')
const { createTestApp } = require('../helpers/app')

const AGENT = { id: '10000000-0000-4000-8000-000000000001', role: 'agent', is_active: true }
const ADMIN = { id: '10000000-0000-4000-8000-000000000002', role: 'admin', is_active: true }
const reflection = { id: '20000000-0000-4000-8000-000000000001', user_id: AGENT.id, business_date: '2026-07-29', reflection_text: 'Worked deeply.', version: 1 }

function bearer(user) { return `Bearer ${jwt.sign({ id: user.id }, process.env.JWT_SECRET)}` }

function reflectionSupabase({ jobInsertError = null, existingReflection = null, jobStatus = null } = {}) {
  const events = []
  const persistedReflections = []
  const jobs = []
  return {
    events,
    persistedReflections,
    jobs,
    supabase: {
      from(table) {
        const filters = {}
        const query = {
          select() { return query },
          eq(key, value) { filters[key] = value; return query },
          single() {
            if (table === 'users') return Promise.resolve({ data: filters.id === ADMIN.id ? ADMIN : AGENT, error: null })
            if (table === 'time_reflections') return Promise.resolve({ data: existingReflection, error: existingReflection ? null : { code: 'PGRST116' } })
            if (table === 'time_ai_reviews') return Promise.resolve({ data: null, error: { code: 'PGRST116' } })
            if (table === 'time_jobs') return Promise.resolve({ data: jobStatus ? { id: 'job-1', status: jobStatus } : null, error: jobStatus ? null : { code: 'PGRST116' } })
            return Promise.resolve({ data: null, error: { code: 'PGRST116' } })
          },
          insert(value) {
            events.push(`${table}:insert`)
            if (table === 'time_reflections') persistedReflections.push({ ...reflection, ...value })
            if (table === 'time_jobs') jobs.push(value)
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

test('returns a saved reflection with retryable AI failure when AI enqueueing fails', async () => {
  const fixture = reflectionSupabase({ jobInsertError: { code: '08006', message: 'queue unavailable' } })
  const response = await request(createTestApp({ supabase: fixture.supabase }))
    .put('/api/time-management/reflections/today')
    .set('Authorization', bearer(AGENT))
    .send({ reflectionText: 'Still retained.' })

  expect(response.status).toBe(201)
  expect(response.body).toMatchObject({
    reflection: { id: reflection.id, reflection_text: 'Still retained.' },
    job: null,
    ai: { status: 'FAILED', retryable: true }
  })
  expect(fixture.persistedReflections).toHaveLength(1)
  expect(fixture.persistedReflections[0]).toMatchObject({ user_id: AGENT.id, reflection_text: 'Still retained.' })
})

test('reports FAILED, never PROCESSING, when a saved reflection has no AI job', async () => {
  const fixture = reflectionSupabase({ existingReflection: reflection })
  const response = await request(createTestApp({ supabase: fixture.supabase }))
    .get('/api/time-management/reflections/today/status')
    .set('Authorization', bearer(AGENT))

  expect(response.status).toBe(200)
  expect(response.body).toEqual({ status: 'FAILED', retryable: true })
})

test('owner retries the same failed reflection version through the queue without saving new text', async () => {
  const fixture = reflectionSupabase({ existingReflection: reflection })
  const response = await request(createTestApp({ supabase: fixture.supabase }))
    .post('/api/time-management/reflections/today/retry')
    .set('Authorization', bearer(AGENT))
    .send({})

  expect(response.status).toBe(201)
  expect(response.body).toMatchObject({
    reflection: { id: reflection.id, version: 1, reflection_text: 'Worked deeply.' },
    job: { job_type: 'AI_REVIEW', dedupe_key: `${reflection.id}:1` },
    ai: { status: 'PROCESSING', retryable: false }
  })
  expect(fixture.persistedReflections).toHaveLength(0)
  expect(fixture.jobs).toEqual([expect.objectContaining({ dedupe_key: `${reflection.id}:1`, payload: { reflectionId: reflection.id, reflectionVersion: 1 } })])
})

test('does not let administrators read another users reflection through the private route', async () => {
  const fixture = reflectionSupabase()
  const response = await request(createTestApp({ supabase: fixture.supabase }))
    .get('/api/time-management/reflections/2026-07-29')
    .set('Authorization', bearer(ADMIN))

  expect(response.status).toBe(200)
  expect(response.body.reflection).toBeNull()
})

test('reports only the current reflection AI state for the owner', async () => {
  const fixture = reflectionSupabase()
  const response = await request(createTestApp({ supabase: fixture.supabase }))
    .get('/api/time-management/reflections/today/status')
    .set('Authorization', bearer(AGENT))

  expect(response.status).toBe(200)
  expect(response.body).toEqual({ status: 'NOT_STARTED' })
})

test('reports a failed current AI job without exposing reflection or job details', async () => {
  const fixture = reflectionSupabase({ existingReflection: reflection, jobStatus: 'FAILED' })
  const response = await request(createTestApp({ supabase: fixture.supabase }))
    .get('/api/time-management/reflections/today/status')
    .set('Authorization', bearer(AGENT))

  expect(response.status).toBe(200)
  expect(response.body).toEqual({ status: 'FAILED', retryable: true })
})
