const jwt = require('jsonwebtoken')
const request = require('supertest')
const { createTestApp } = require('../helpers/app')

const AGENT = { id: '10000000-0000-4000-8000-000000000001', role: 'agent', is_active: true }
const INACTIVE = { id: '10000000-0000-4000-8000-000000000002', role: 'agent', is_active: false }

beforeEach(() => {
  process.env.TIME_PUSH_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
})

test('an active user can save only their own Push subscription without exposing its keys', async () => {
  const fixture = pushRouteSupabase()
  const response = await request(createTestApp({ supabase: fixture.supabase }))
    .post('/api/time-management/push/subscriptions')
    .set('Authorization', bearer(AGENT))
    .send({ endpoint: 'https://push.example/subscription', keys: { p256dh: 'public-key', auth: 'auth-secret' } })

  expect(response.status).toBe(201)
  expect(response.body).toEqual({ subscription: { id: 'subscription-1', endpoint: 'https://push.example/subscription', is_active: true } })
  expect(fixture.saved).toMatchObject({ user_id: AGENT.id, endpoint: 'https://push.example/subscription', is_active: true, last_error_code: null })
  expect(fixture.saved.p256dh).not.toContain('public-key')
  expect(fixture.saved.auth_secret).not.toContain('auth-secret')
  expect(JSON.stringify(response.body)).not.toContain('auth-secret')
})

test('the Push subscription route keeps cookie-authenticated writes behind CSRF protection', async () => {
  const fixture = pushRouteSupabase()
  const response = await request(createTestApp({ supabase: fixture.supabase }))
    .post('/api/time-management/push/subscriptions')
    .set('Cookie', `crm_session=${jwt.sign({ id: AGENT.id }, process.env.JWT_SECRET)}`)
    .send({ endpoint: 'https://push.example/subscription', keys: { p256dh: 'public-key', auth: 'auth-secret' } })

  expect(response.status).toBe(403)
  expect(response.body.error.code).toBe('CSRF_INVALID')
})

test('stores Push encryption keys only as ciphertext envelopes', async () => {
  const fixture = pushRouteSupabase()
  const previous = process.env.TIME_PUSH_ENCRYPTION_KEY
  process.env.TIME_PUSH_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
  try {
    const response = await request(createTestApp({ supabase: fixture.supabase }))
      .post('/api/time-management/push/subscriptions')
      .set('Authorization', bearer(AGENT))
      .send({ endpoint: 'https://push.example/subscription', keys: { p256dh: 'public-key', auth: 'auth-secret' } })

    expect(response.status).toBe(201)
    expect(fixture.saved.p256dh).not.toContain('public-key')
    expect(fixture.saved.auth_secret).not.toContain('auth-secret')
    expect(fixture.saved.p256dh).toMatch(/^v1:/)
    expect(fixture.saved.auth_secret).toMatch(/^v1:/)
  } finally {
    if (previous === undefined) delete process.env.TIME_PUSH_ENCRYPTION_KEY
    else process.env.TIME_PUSH_ENCRYPTION_KEY = previous
  }
})

function bearer(user) { return `Bearer ${jwt.sign({ id: user.id }, process.env.JWT_SECRET)}` }

function pushRouteSupabase() {
  let saved
  return {
    get saved() { return saved },
    supabase: {
      from(table) {
        const filters = {}
        const query = {
          select() { return query },
          eq(key, value) { filters[key] = value; return query },
          single: async () => {
            if (table === 'users') return { data: filters.id === AGENT.id ? AGENT : INACTIVE, error: null }
            throw new Error(`Unexpected ${table}.single`)
          },
          upsert(value) {
            saved = value
            return { select() { return { single: async () => ({ data: { id: 'subscription-1', endpoint: value.endpoint, is_active: true }, error: null }) } } }
          }
        }
        return query
      }
    }
  }
}
