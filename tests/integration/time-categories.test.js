const jwt = require('jsonwebtoken')
const request = require('supertest')
const { createTestApp } = require('../helpers/app')

function createCategorySupabase({ actor }) {
  const standards = [
    { id: 'standard-active', name: 'Client response', sort_order: 1, is_active: true },
    { id: 'standard-inactive', name: 'Legacy', sort_order: 2, is_active: false }
  ]
  const personal = []

  function result(data) { return Promise.resolve({ data, error: null }) }
  function tableQuery(table) {
    const state = { filters: {}, update: null, insert: null }
    const query = {
      select() { return query },
      eq(column, value) { state.filters[column] = value; return query },
      order() { return query },
      insert(value) { state.insert = value; return query },
      update(value) { state.update = value; return query },
      single() {
        if (table === 'users') return result(actor)
        const records = table === 'time_standard_categories' ? standards : personal
        const existing = records.find(record => Object.entries(state.filters).every(([key, value]) => record[key] === value))
        if (state.insert) {
          const record = { id: `${table}-${records.length + 1}`, ...state.insert }
          records.push(record)
          return result(record)
        }
        if (state.update && existing) {
          Object.assign(existing, state.update)
          return result(existing)
        }
        return existing ? result(existing) : Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'not found' } })
      },
      then(resolve, reject) {
        const records = table === 'time_standard_categories' ? standards : personal
        const data = records.filter(record => Object.entries(state.filters).every(([key, value]) => record[key] === value))
        return result(data).then(resolve, reject)
      }
    }
    return query
  }

  return {
    supabase: { from: tableQuery },
    standards,
    personal
  }
}

function bearer(user) {
  return `Bearer ${jwt.sign({ id: user.id }, process.env.JWT_SECRET)}`
}

test('only an admin can mutate standard categories', async () => {
  const agent = { id: 'agent-1', role: 'agent', is_active: true }
  const agentFixture = createCategorySupabase({ actor: agent })
  const forbidden = await request(createTestApp({ supabase: agentFixture.supabase }))
    .post('/api/time-management/categories/standard')
    .set('Authorization', bearer(agent))
    .send({ name: 'Reports', sortOrder: 3 })

  expect(forbidden.status).toBe(403)
  expect(forbidden.body.error.code).toBe('FORBIDDEN')

  const admin = { id: 'admin-1', role: 'admin', is_active: true }
  const adminFixture = createCategorySupabase({ actor: admin })
  const created = await request(createTestApp({ supabase: adminFixture.supabase }))
    .post('/api/time-management/categories/standard')
    .set('Authorization', bearer(admin))
    .send({ name: 'Reports', sortOrder: 3, isFocus: true })

  expect(created.status).toBe(201)
  expect(created.body).toMatchObject({ name: 'Reports', sort_order: 3, is_focus: true })
})

test('an agent personal category requires an active standard parent and stays user-owned', async () => {
  const actor = { id: 'agent-1', role: 'agent', is_active: true }
  const fixture = createCategorySupabase({ actor })
  const app = createTestApp({ supabase: fixture.supabase })

  const invalidParent = await request(app)
    .post('/api/time-management/categories/personal')
    .set('Authorization', bearer(actor))
    .send({ name: 'Old lead work', parentStandardCategoryId: 'standard-inactive' })
  expect(invalidParent.status).toBe(422)
  expect(invalidParent.body.error.code).toBe('INACTIVE_STANDARD_CATEGORY')

  const created = await request(app)
    .post('/api/time-management/categories/personal')
    .set('Authorization', bearer(actor))
    .send({ name: 'VIP responses', parentStandardCategoryId: 'standard-active' })
  expect(created.status).toBe(201)
  expect(created.body).toMatchObject({ user_id: 'agent-1', parent_standard_category_id: 'standard-active' })
})

test('personal category deletion is a soft deactivation and list omits inactive categories', async () => {
  const actor = { id: 'agent-1', role: 'agent', is_active: true }
  const fixture = createCategorySupabase({ actor })
  fixture.personal.push({
    id: 'personal-1', user_id: actor.id, parent_standard_category_id: 'standard-active',
    name: 'VIP responses', sort_order: 0, is_active: true
  })
  const app = createTestApp({ supabase: fixture.supabase })

  const removed = await request(app)
    .delete('/api/time-management/categories/personal/personal-1')
    .set('Authorization', bearer(actor))
  expect(removed.status).toBe(200)
  expect(fixture.personal[0].is_active).toBe(false)

  const listed = await request(app)
    .get('/api/time-management/categories')
    .set('Authorization', bearer(actor))
  expect(listed.status).toBe(200)
  expect(listed.body.personal).toEqual([])
})

test('category list rejects unrecognized query parameters', async () => {
  const actor = { id: 'agent-1', role: 'agent', is_active: true }
  const fixture = createCategorySupabase({ actor })

  const response = await request(createTestApp({ supabase: fixture.supabase }))
    .get('/api/time-management/categories?includeInactive=true')
    .set('Authorization', bearer(actor))

  expect(response.status).toBe(400)
  expect(response.body.error.code).toBe('INVALID_REQUEST')
})

test('an agent cannot deactivate another agents personal category', async () => {
  const actor = { id: 'agent-1', role: 'agent', is_active: true }
  const fixture = createCategorySupabase({ actor })
  fixture.personal.push({
    id: 'other-personal', user_id: 'agent-2', parent_standard_category_id: 'standard-active',
    name: 'Other agent work', sort_order: 0, is_active: true
  })

  const response = await request(createTestApp({ supabase: fixture.supabase }))
    .delete('/api/time-management/categories/personal/other-personal')
    .set('Authorization', bearer(actor))

  expect(response.status).toBe(403)
  expect(fixture.personal[0].is_active).toBe(true)
})

test('category list omits active personal categories when their standard parent is inactive', async () => {
  const actor = { id: 'agent-1', role: 'agent', is_active: true }
  const fixture = createCategorySupabase({ actor })
  fixture.personal.push({
    id: 'legacy-personal', user_id: actor.id, parent_standard_category_id: 'standard-inactive',
    name: 'Legacy follow-up', sort_order: 0, is_active: true
  })

  const response = await request(createTestApp({ supabase: fixture.supabase }))
    .get('/api/time-management/categories')
    .set('Authorization', bearer(actor))

  expect(response.status).toBe(200)
  expect(response.body.personal).toEqual([])
})

test('personal category deletion rejects unexpected query parameters', async () => {
  const actor = { id: 'agent-1', role: 'agent', is_active: true }
  const fixture = createCategorySupabase({ actor })
  fixture.personal.push({
    id: 'personal-1', user_id: actor.id, parent_standard_category_id: 'standard-active',
    name: 'VIP responses', sort_order: 0, is_active: true
  })

  const response = await request(createTestApp({ supabase: fixture.supabase }))
    .delete('/api/time-management/categories/personal/personal-1?force=true')
    .set('Authorization', bearer(actor))

  expect(response.status).toBe(400)
  expect(response.body.error.code).toBe('INVALID_REQUEST')
  expect(fixture.personal[0].is_active).toBe(true)
})
