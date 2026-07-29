const jwt = require('jsonwebtoken')
const request = require('supertest')
const { createTestApp } = require('../helpers/app')
const { SESSION_COOKIE } = require('../../services/session')
const { createCsrfToken } = require('../../middleware/csrf')

const ACTOR = { id: '10000000-0000-4000-8000-000000000001', role: 'agent', is_active: true }
const STANDARD = '20000000-0000-4000-8000-000000000001'
const ENTRY = '50000000-0000-4000-8000-000000000001'
const CONTACT = '60000000-0000-4000-8000-000000000001'

function bearer() { return `Bearer ${jwt.sign({ id: ACTOR.id }, process.env.JWT_SECRET)}` }

test('time-management session and CSRF endpoints use the shared CRM cookie session', async () => {
  const token = jwt.sign({ id: ACTOR.id }, process.env.JWT_SECRET)
  const supabase = {
    from() {
      return {
        select() { return this },
        eq() { return this },
        single() { return Promise.resolve({ data: ACTOR, error: null }) }
      }
    }
  }
  const app = createTestApp({ supabase })

  const session = await request(app).get('/api/time-management/session').set('Authorization', bearer())
  const csrf = await request(app).get('/api/time-management/csrf').set('Cookie', `${SESSION_COOKIE}=${token}`)
  const bearerCsrf = await request(app).get('/api/time-management/csrf').set('Authorization', bearer())

  expect(session.body).toEqual({ role: 'agent' })
  expect(csrf.body).toEqual({ csrfToken: createCsrfToken(token) })
  expect(bearerCsrf.status).toBe(400)
  expect(bearerCsrf.body.error).toMatchObject({ code: 'COOKIE_SESSION_REQUIRED' })
})

function entrySupabase({ rpcErrors = {}, replay = null, throwRpc = null } = {}) {
  const calls = []
  const active = { id: ENTRY, user_id: ACTOR.id, standard_category_id: STANDARD, entry_type: 'TIMER', started_at: '2026-07-29T01:00:00.000Z', ended_at: null }
  return {
    calls,
    supabase: {
      rpc(name, args) {
        calls.push({ operation: 'rpc', name, args })
        if (name === throwRpc) throw new Error('unexpected database failure with private details')
        if (rpcErrors[name]) return Promise.resolve({ data: null, error: rpcErrors[name] })
        if (name === 'time_get_command_replay') {
          return Promise.resolve({ data: replay ? [{ response_payload: replay }] : [], error: null })
        }
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
  expect(fixture.calls.find(call => call.name === 'time_get_command_replay')).toEqual({ operation: 'rpc', name: 'time_get_command_replay', args: {
    p_user_id: ACTOR.id,
    p_request_id: 'timer-1',
    p_command_type: 'START',
    p_request_payload: {
      standardCategoryId: STANDARD,
      crmLink: { type: 'CONTACT', id: CONTACT },
      businessTimeZone: 'Asia/Seoul'
    }
  } })
  expect(fixture.calls).toContainEqual({ operation: 'rpc', name: 'time_start_timer', args: expect.objectContaining({
    p_user_id: ACTOR.id, p_actor_role: ACTOR.role, p_request_id: 'timer-1', p_standard_category_id: STANDARD,
    p_contact_id: CONTACT, p_linked_entity_label: null, p_business_time_zone: 'Asia/Seoul'
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
    p_user_id: ACTOR.id, p_actor_role: ACTOR.role, p_entry_id: ENTRY, p_request_id: 'revise-1'
  }) })
})

test('stored command replay is returned before any mutable CRM lookup', async () => {
  const fixture = entrySupabase({ replay: { stopped_entry_id: null, started_entry_id: ENTRY } })
  const response = await request(createTestApp({ supabase: fixture.supabase }))
    .post('/api/time-management/entries/timer/start')
    .set('Authorization', bearer())
    .send({ requestId: 'replay-before-crm', standardCategoryId: STANDARD, crmLink: { type: 'CONTACT', id: CONTACT } })

  expect(response.status).toBe(200)
  expect(response.body).toEqual({ stopped_entry_id: null, started_entry_id: ENTRY, replayed: true })
  expect(fixture.calls.map(call => call.name).filter(Boolean)).toEqual(['time_get_command_replay'])
})

test('revision canonicalizes patch field order before replay lookup and mutation', async () => {
  const fixture = entrySupabase()
  const response = await request(createTestApp({ supabase: fixture.supabase }))
    .patch(`/api/time-management/entries/${ENTRY}`)
    .set('Authorization', bearer())
    .send({ requestId: 'canonical-revise', standardCategoryId: STANDARD, crmLink: null, notes: 'ordered' })

  expect(response.status).toBe(200)
  const replayCall = fixture.calls.find(call => call.name === 'time_get_command_replay')
  expect(replayCall.args.p_request_payload.patchFields).toEqual(['crmLink', 'notes', 'standardCategoryId'])
  expect(replayCall.args.p_request_payload).not.toHaveProperty('linkedEntityLabel')
  const mutationCall = fixture.calls.find(call => call.name === 'time_revise_entry')
  expect(mutationCall.args.p_patch_fields).toEqual(['crmLink', 'notes', 'standardCategoryId'])
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

test('missing and inaccessible CRM links share the same non-disclosing API error', async () => {
  const fixture = entrySupabase({ rpcErrors: { time_start_timer: { code: 'P0003', message: 'CRM link not found' } } })
  const response = await request(createTestApp({ supabase: fixture.supabase }))
    .post('/api/time-management/entries/timer/start')
    .set('Authorization', bearer())
    .set('X-Request-Id', 'crm-link-denied')
    .send({ requestId: 'crm-link-denied', standardCategoryId: STANDARD, crmLink: { type: 'CONTACT', id: CONTACT } })
  expect(response.status).toBe(404)
  expect(response.body).toEqual({ error: { code: 'CRM_LINK_NOT_FOUND', message: expect.any(String), requestId: 'crm-link-denied' } })
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

test('unknown nested methods and unexpected failures never leak to the CRM SPA or global error shape', async () => {
  const fixture = entrySupabase({ throwRpc: 'time_get_command_replay' })
  const app = createTestApp({ supabase: fixture.supabase })

  const missingGet = await request(app)
    .get('/api/time-management/not-a-route')
    .set('Authorization', bearer())
    .set('X-Request-Id', 'missing-get')
  expect(missingGet.status).toBe(404)
  expect(missingGet.type).toMatch(/json/)
  expect(missingGet.body).toEqual({ error: { code: 'NOT_FOUND', message: expect.any(String), requestId: 'missing-get' } })

  const missingPost = await request(app)
    .post('/api/time-management/not-a-route')
    .set('Authorization', bearer())
    .set('X-Request-Id', 'missing-post')
  expect(missingPost.status).toBe(404)
  expect(missingPost.body.error).toMatchObject({ code: 'NOT_FOUND', requestId: 'missing-post' })

  const failed = await request(app)
    .post('/api/time-management/entries/timer/start')
    .set('Authorization', bearer())
    .set('X-Request-Id', 'unexpected-500')
    .send({ requestId: 'unexpected-500', standardCategoryId: STANDARD })
  expect(failed.status).toBe(500)
  expect(failed.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: expect.any(String), requestId: 'unexpected-500' } })
  expect(JSON.stringify(failed.body)).not.toContain('private details')
})

test('owner records read returns date-scoped entries with immutable revision metadata', async () => {
  const calls = []
  const record = {
    id: ENTRY, user_id: ACTOR.id, business_date: '2026-07-29', standard_category_id: STANDARD,
    personal_category_id: null, entry_type: 'MANUAL', started_at: '2026-07-29T01:00:00.000Z', ended_at: '2026-07-29T02:00:00.000Z',
    duration_seconds: 3600, notes: 'owner note', linked_entity_type: 'CONTACT', linked_entity_id: CONTACT, linked_entity_label: 'Archived contact'
  }
  const revision = { id: '70000000-0000-4000-8000-000000000001', entry_id: ENTRY, user_id: ACTOR.id, changed_by: ACTOR.id, changed_at: '2026-07-29T03:00:00.000Z', before_value: { notes: 'old' }, after_value: { notes: 'new' } }
  const supabase = {
    from(table) {
      const query = {
        select(columns) { calls.push({ table, operation: 'select', columns }); return query },
        eq(column, value) { calls.push({ table, operation: 'eq', column, value }); return query },
        in(column, values) { calls.push({ table, operation: 'in', column, values }); return query },
        order() { return Promise.resolve({ data: table === 'time_entries' ? [record] : [revision], error: null }) },
        single() { return Promise.resolve({ data: ACTOR, error: null }) }
      }
      return query
    }
  }

  const response = await request(createTestApp({ supabase }))
    .get('/api/time-management/entries?businessDate=2026-07-29')
    .set('Authorization', bearer())

  expect(response.status).toBe(200)
  expect(response.body).toEqual({ entries: [{ ...record, revisions: [revision] }] })
  expect(calls).toContainEqual({ table: 'time_entries', operation: 'eq', column: 'user_id', value: ACTOR.id })
  expect(calls).toContainEqual({ table: 'time_entry_revisions', operation: 'eq', column: 'user_id', value: ACTOR.id })
  expect(calls).toContainEqual({ table: 'time_entry_revisions', operation: 'select', columns: 'id, entry_id, user_id, changed_by, changed_at, before_value, after_value' })
})
