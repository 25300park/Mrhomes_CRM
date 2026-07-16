const jwt = require('jsonwebtoken')
const request = require('supertest')
const { createTestApp } = require('../helpers/app')

function userQuery(user) {
  const query = {
    select: () => query,
    eq(column, value) { if (user[column] !== value) query.mismatch = true; return query },
    single: async () => query.mismatch ? { data: null, error: {} } : { data: user, error: null }
  }
  return query
}

test('legacy Bearer authentication remains supported but stale role claims are ignored', async () => {
  const user = { id: 'user-1', name: 'Agent', email: 'a@example.com', role: 'agent', is_active: true }
  const app = createTestApp({ supabase: { from: () => userQuery(user) } })
  const token = jwt.sign({ id: user.id, role: 'admin' }, process.env.JWT_SECRET)

  const response = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`)

  expect(response.status).toBe(200)
  expect(response.body.role).toBe('agent')
})

test('tokens issued before the configured forced re-login cutoff are rejected', async () => {
  const previous = process.env.AUTH_INVALID_BEFORE
  process.env.AUTH_INVALID_BEFORE = '2026-07-16T09:00:00.000Z'
  try {
    const user = { id: 'user-1', name: 'Agent', email: 'a@example.com', role: 'agent', is_active: true }
    const app = createTestApp({ supabase: { from: () => userQuery(user) } })
    const token = jwt.sign({ id: user.id, iat: 1_700_000_000 }, process.env.JWT_SECRET)

    const response = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`)

    expect(response.status).toBe(401)
  } finally {
    if (previous === undefined) delete process.env.AUTH_INVALID_BEFORE
    else process.env.AUTH_INVALID_BEFORE = previous
  }
})

test('a newly issued login token after the forced re-login cutoff is accepted', async () => {
  const previous = process.env.AUTH_INVALID_BEFORE
  process.env.AUTH_INVALID_BEFORE = new Date(Date.now() - 2_000).toISOString()
  try {
    const user = { id: 'user-1', name: 'Agent', email: 'a@example.com', role: 'agent', is_active: true }
    const app = createTestApp({ supabase: { from: () => userQuery(user) } })
    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET)
    const response = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`)
    expect(response.status).toBe(200)
  } finally {
    if (previous === undefined) delete process.env.AUTH_INVALID_BEFORE
    else process.env.AUTH_INVALID_BEFORE = previous
  }
})
