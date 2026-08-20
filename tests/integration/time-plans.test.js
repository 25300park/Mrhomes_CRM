const jwt = require('jsonwebtoken')
const request = require('supertest')
const { createTestApp } = require('../helpers/app')

const ACTOR = { id: '10000000-0000-4000-8000-000000000001', role: 'agent', is_active: true }
const STANDARD = '20000000-0000-4000-8000-000000000001'
const PERSONAL = '30000000-0000-4000-8000-000000000001'

function bearer() {
  return `Bearer ${jwt.sign({ id: ACTOR.id }, process.env.JWT_SECRET)}`
}

function planSupabase({ rpcError = null } = {}) {
  const calls = []
  const plan = { id: '40000000-0000-4000-8000-000000000001', user_id: ACTOR.id, business_date: '2026-07-29', available_minutes: 480 }
  const allocations = [{ daily_plan_id: plan.id, standard_category_id: STANDARD, personal_category_id: PERSONAL, planned_minutes: 420 }]
  return {
    calls,
    supabase: {
      rpc(name, args) {
        calls.push({ operation: 'rpc', name, args })
        return Promise.resolve({ data: rpcError ? null : [{ ...plan, allocation_total: 420 }], error: rpcError })
      },
      from(table) {
        const filters = {}
        const query = {
          select(columns) { calls.push({ table, operation: 'select', columns }); return query },
          eq(column, value) { filters[column] = value; calls.push({ table, operation: 'eq', column, value }); return query },
          order() { return query },
          single() {
            if (table === 'users') return Promise.resolve({ data: ACTOR, error: null })
            if (table === 'time_daily_plans') return Promise.resolve({ data: filters.business_date === plan.business_date ? plan : null, error: filters.business_date === plan.business_date ? null : { code: 'PGRST116' } })
            return Promise.resolve({ data: null, error: { code: 'PGRST116' } })
          },
          then(resolve, reject) {
            return Promise.resolve({ data: table === 'time_plan_allocations' ? allocations : [], error: null }).then(resolve, reject)
          }
        }
        return query
      }
    }
  }
}

test('daily plan save uses one atomic RPC and warns when allocation total differs', async () => {
  const fixture = planSupabase()
  const response = await request(createTestApp({ supabase: fixture.supabase }))
    .put('/api/time-management/plans/today')
    .set('Authorization', bearer())
    .set('X-Request-Id', 'plan-save-1')
    .send({ availableMinutes: 480, allocations: [{ standardCategoryId: STANDARD, personalCategoryId: PERSONAL, plannedMinutes: 420 }] })

  expect(response.status).toBe(200)
  expect(response.body.warning).toEqual({ code: 'ALLOCATION_TOTAL_MISMATCH', differenceMinutes: -60 })
  expect(fixture.calls.filter(call => call.operation === 'rpc')).toEqual([{
    operation: 'rpc', name: 'time_save_daily_plan', args: {
      p_user_id: ACTOR.id,
      p_business_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      p_available_minutes: 480,
      p_allocations: [{ standardCategoryId: STANDARD, personalCategoryId: PERSONAL, plannedMinutes: 420 }]
    }
  }])
  expect(fixture.calls.some(call => ['insert', 'delete'].includes(call.operation))).toBe(false)
})

test('daily plan date is derived by the server in Asia/Seoul and explicit dates are strictly validated', async () => {
  const fixture = planSupabase()
  const app = createTestApp({ supabase: fixture.supabase })
  const found = await request(app).get('/api/time-management/plans/2026-07-29').set('Authorization', bearer())
  expect(found.status).toBe(200)
  expect(found.body.plan.business_date).toBe('2026-07-29')

  const invalid = await request(app).get('/api/time-management/plans/2026-02-30').set('Authorization', bearer())
  expect(invalid.status).toBe(400)
  expect(invalid.body).toEqual({ error: { code: 'INVALID_REQUEST', message: expect.any(String), requestId: expect.any(String) } })
})

test('daily plan route rejects unknown body keys with the stable request-scoped error contract', async () => {
  const fixture = planSupabase()
  const response = await request(createTestApp({ supabase: fixture.supabase }))
    .put('/api/time-management/plans/today')
    .set('Authorization', bearer())
    .set('X-Request-Id', 'bad-plan')
    .send({ availableMinutes: 480, allocations: [], businessDate: '2020-01-01' })
  expect(response.status).toBe(400)
  expect(response.body).toEqual({ error: { code: 'INVALID_REQUEST', message: expect.any(String), requestId: 'bad-plan' } })
})

test('daily plan category ownership failures map without exposing database details', async () => {
  const fixture = planSupabase({ rpcError: { code: '42501', message: 'personal category is not owned by user' } })
  const response = await request(createTestApp({ supabase: fixture.supabase }))
    .put('/api/time-management/plans/today')
    .set('Authorization', bearer())
    .set('X-Request-Id', 'plan-owner')
    .send({ availableMinutes: 30, allocations: [{ standardCategoryId: STANDARD, personalCategoryId: PERSONAL, plannedMinutes: 30 }] })
  expect(response.status).toBe(403)
  expect(response.body).toEqual({ error: { code: 'FORBIDDEN', message: expect.any(String), requestId: 'plan-owner' } })
  expect(JSON.stringify(response.body)).not.toContain('personal category')
})
