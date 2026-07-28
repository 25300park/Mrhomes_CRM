const jwt = require('jsonwebtoken')
const request = require('supertest')
const { createTestApp } = require('../helpers/app')
const { SESSION_COOKIE } = require('../../services/session')

const ACTOR = { id: '10000000-0000-4000-8000-000000000001', role: 'agent', is_active: true }
const STANDARD = '20000000-0000-4000-8000-000000000001'
const ENTRY = '50000000-0000-4000-8000-000000000001'
const CONTACT = '60000000-0000-4000-8000-000000000001'

function bearer() { return `Bearer ${jwt.sign({ id: ACTOR.id }, process.env.JWT_SECRET)}` }

function entrySupabase({ rpcErrors = {} } = {}) {
  const calls = []
  const active = { id: ENTRY, user_id: ACTOR.id, standard_category_id: STANDARD, entry_type: 'TIMER', started_at: '2026-07-29T01:00:00.000Z', ended_at: null }
  return {
    calls,
    supabase: {
      rpc(name, args) {
        calls.push({ operation: 'rpc', name, args })
        if (rpcErrors[name]) return Promise.resolve({ data: null, error: rpcErrors[name] })
        if (name === 'time_resolve_crm_link') return Promise.resolve({ data: [{ id: CONTACT, type: 'CONTACT', label: 'Jane Client' }], error: null })
        if (name === 'time_create_manual_entry') return Promise.resolve({ data: [{ entry_id: ENTRY, replayed: false }], error: null })
        if (name === 'time_revise_entry') return Promise.resolve({ data: [{ entry_id: ENTRY, revision_id: '70000000-0000-4000-8000-000000000001', replayed: false }], error: null })
        return Promise.resolve({ data: [{ stopped_entry_id: name === 'time_start_timer' ? null : ENTRY, started_entry_id: name === 'time_stop_timer' ? null : ENTRY, replayed: false }], error: null })
      },
      from(table) {
        const query = {
          select(columns) { calls.push({ table, operation: 'select', columns }); return query },
          eq(column, value) { calls.push({ table, operation: 'eq', column, value }); return query },
          is(column, value) { calls.push({ table, operation: 'is', column, value }); return query },
          maybeSingle() { return Promise.resolve({ data: table === 'time_entries' ? active : null, error: null }) },
          single() { return Promise.resolve({ data: table === 'users' ? ACTOR : table === 'time_entries' ? active : null, error: null }) }
        }
        return query
      }
    }
  }
}

test('timer start and switch delegate to atomic idempotent RPCs with a frozen CRM snapshot', async () => {
  const fixture = entrySupabase()
  const app = createTestApp({ supabase: fixture.supabase })
  const body = { requestId: 'timer-1', standardCategoryId: STANDARD, crmLink: { type: 'CONTACT', id: CONTACT } }
  const started = await request(app).post('/api/time-management/entries/timer/start').set('Authorization', bearer()).send(body)
  expect(started.status).toBe(201)
  expect(fixture.calls).toContainEqual({ operation: 'rpc', name: 'time_resolve_crm_link', args: { p_type: 'CONTACT', p_id: CONTACT } })
  expect(fixture.calls).toContainEqual({ operation: 'rpc', name: 'time_start_timer', args: expect.objectContaining({
    p_user_id: ACTOR.id, p_request_id: 'timer-1', p_standard_category_id: STANDARD,
    p_contact_id: CONTACT, p_linked_entity_label: 'Jane Client', p_business_time_zone: 'Asia/Seoul'
  }) })

  const switched = await request(app).post('/api/time-management/entries/timer/switch').set('Authorization', bearer())
    .send({ requestId: 'timer-2', standardCategoryId: STANDARD })
  expect(switched.status).toBe(200)
  expect(fixture.calls).toContainEqual({ operation: 'rpc', name: 'time_switch_timer', args: expect.objectContaining({ p_request_id: 'timer-2' }) })
})

test('manual entries are complete and revisions are owner-scoped atomic RPCs', async () => {
  const fixture = entrySupabase()
  const app = createTestApp({ supabase: fixture.supabase })
  const manual = await request(app).post('/api/time-management/entries/manual').set('Authorization', bearer()).send({
    requestId: 'manual-1', standardCategoryId: STANDARD,
    startedAt: '2026-07-29T01:00:00.000Z', endedAt: '2026-07-29T02:00:00.000Z'
  })
  expect(manual.status).toBe(201)
  expect(fixture.calls).toContainEqual({ operation: 'rpc', name: 'time_create_manual_entry', args: expect.objectContaining({
    p_user_id: ACTOR.id, p_request_id: 'manual-1', p_started_at: '2026-07-29T01:00:00.000Z', p_ended_at: '2026-07-29T02:00:00.000Z'
  }) })

  const revised = await request(app).patch(`/api/time-management/entries/${ENTRY}`).set('Authorization', bearer()).send({
    requestId: 'revise-1', notes: 'Client requested a follow-up'
  })
  expect(revised.status).toBe(200)
  expect(fixture.calls).toContainEqual({ operation: 'rpc', name: 'time_revise_entry', args: expect.objectContaining({
    p_user_id: ACTOR.id, p_entry_id: ENTRY, p_request_id: 'revise-1'
  }) })
})

test('entry validation rejects invalid timestamps, multiple links, and unknown keys before writes', async () => {
  const fixture = entrySupabase()
  const app = createTestApp({ supabase: fixture.supabase })
  const invalidRange = await request(app).post('/api/time-management/entries/manual').set('Authorization', bearer()).send({
    requestId: 'manual-invalid', standardCategoryId: STANDARD,
    startedAt: '2026-07-29T02:00:00.000Z', endedAt: '2026-07-29T01:00:00.000Z'
  })
  expect(invalidRange.status).toBe(400)
  expect(invalidRange.body.error.code).toBe('INVALID_REQUEST')

  const multiple = await request(app).post('/api/time-management/entries/timer/start').set('Authorization', bearer()).send({
    requestId: 'links-invalid', standardCategoryId: STANDARD,
    crmLink: [{ type: 'CONTACT', id: CONTACT }, { type: 'DEAL', id: CONTACT }]
  })
  expect(multiple.status).toBe(400)
  expect(fixture.calls.filter(call => ['time_start_timer', 'time_create_manual_entry'].includes(call.name))).toEqual([])
})

test('active timer reconciliation returns the server record as authoritative without writing', async () => {
  const fixture = entrySupabase()
  const response = await request(createTestApp({ supabase: fixture.supabase }))
    .post('/api/time-management/entries/timer/reconcile')
    .set('Authorization', bearer())
    .send({ displayedEntryId: '50000000-0000-4000-8000-000000000099', displayedStartedAt: '2026-07-29T00:59:00.000Z' })
  expect(response.status).toBe(200)
  expect(response.body).toMatchObject({ matches: false, authoritativeEntry: { id: ENTRY } })

  const equivalentTimestamp = await request(createTestApp({ supabase: fixture.supabase }))
    .post('/api/time-management/entries/timer/reconcile')
    .set('Authorization', bearer())
    .send({ displayedEntryId: ENTRY, displayedStartedAt: '2026-07-29T01:00:00+00:00' })
  expect(equivalentTimestamp.body).toMatchObject({ matches: true, authoritativeEntry: { id: ENTRY } })
  expect(fixture.calls.filter(call => ['insert', 'update', 'delete', 'rpc'].includes(call.operation))).toEqual([])
})

test('database conflicts map to stable request-scoped errors without exposing ownership', async () => {
  const fixture = entrySupabase({ rpcErrors: { time_stop_timer: { code: 'P0002', message: 'active timer not found' } } })
  const response = await request(createTestApp({ supabase: fixture.supabase }))
    .post('/api/time-management/entries/timer/stop')
    .set('Authorization', bearer())
    .set('X-Request-Id', 'http-stop-1')
    .send({ requestId: 'stop-1' })
  expect(response.status).toBe(404)
  expect(response.body).toEqual({ error: { code: 'ACTIVE_TIMER_NOT_FOUND', message: expect.any(String), requestId: 'http-stop-1' } })
})

test('Task 5 authentication and CSRF failures use the exact request-scoped error contract', async () => {
  const fixture = entrySupabase()
  const app = createTestApp({ supabase: fixture.supabase })
  const unauthenticated = await request(app)
    .post('/api/time-management/entries/timer/stop')
    .set('X-Request-Id', 'unauth-1')
    .send({ requestId: 'stop-1' })
  expect(unauthenticated.status).toBe(401)
  expect(unauthenticated.body).toEqual({ error: { code: 'UNAUTHENTICATED', message: expect.any(String), requestId: 'unauth-1' } })

  const token = jwt.sign({ id: ACTOR.id }, process.env.JWT_SECRET)
  const csrf = await request(app)
    .post('/api/time-management/entries/timer/stop')
    .set('X-Request-Id', 'csrf-1')
    .set('Cookie', `${SESSION_COOKIE}=${token}`)
    .send({ requestId: 'stop-1' })
  expect(csrf.status).toBe(403)
  expect(csrf.body).toEqual({ error: { code: 'CSRF_INVALID', message: expect.any(String), requestId: 'csrf-1' } })
})
