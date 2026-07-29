const jwt = require('jsonwebtoken')
const request = require('supertest')
const { createTestApp } = require('../helpers/app')

const AGENT = { id: '10000000-0000-4000-8000-000000000001', role: 'agent', is_active: true }
const INACTIVE = { id: '10000000-0000-4000-8000-000000000002', role: 'agent', is_active: false }

beforeEach(() => {
  process.env.TIME_PUSH_ACTIVE_KEY_ID = 'current'
  process.env.TIME_PUSH_ENCRYPTION_KEYS = `current=${Buffer.alloc(32, 7).toString('base64')}`
})

const PUBLIC_DNS = async () => [{ address: '142.250.72.14', family: 4 }]

function pushApp(fixture) {
  return createTestApp({ supabase: fixture.supabase, timePushSecurity: { resolveAddresses: PUBLIC_DNS } })
}

test('an active user can save only their own Push subscription without exposing its keys', async () => {
  const fixture = pushRouteSupabase()
  const response = await request(pushApp(fixture))
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
  const response = await request(pushApp(fixture))
    .post('/api/time-management/push/subscriptions')
    .set('Cookie', `crm_session=${jwt.sign({ id: AGENT.id }, process.env.JWT_SECRET)}`)
    .send({ endpoint: 'https://push.example/subscription', keys: { p256dh: 'public-key', auth: 'auth-secret' } })

  expect(response.status).toBe(403)
  expect(response.body.error.code).toBe('CSRF_INVALID')
})

test('stores Push encryption keys only as ciphertext envelopes', async () => {
  const fixture = pushRouteSupabase()
  const response = await request(pushApp(fixture))
    .post('/api/time-management/push/subscriptions')
    .set('Authorization', bearer(AGENT))
    .send({ endpoint: 'https://push.example/subscription', keys: { p256dh: 'public-key', auth: 'auth-secret' } })

  expect(response.status).toBe(201)
  expect(fixture.saved.p256dh).not.toContain('public-key')
  expect(fixture.saved.auth_secret).not.toContain('auth-secret')
  expect(fixture.saved.p256dh).toMatch(/^v1:current:/)
  expect(fixture.saved.auth_secret).toMatch(/^v1:current:/)
})

test('does not reassign an existing Push endpoint owned by another user', async () => {
  const fixture = pushRouteSupabase({ endpointOwner: '20000000-0000-4000-8000-000000000099' })
  const response = await request(pushApp(fixture))
    .post('/api/time-management/push/subscriptions')
    .set('Authorization', bearer(AGENT))
    .send({ endpoint: 'https://push.example/subscription', keys: { p256dh: 'new-key', auth: 'new-secret' } })

  expect(response.status).toBe(409)
  expect(response.body.error).toMatchObject({ code: 'PUSH_ENDPOINT_CONFLICT' })
  expect(JSON.stringify(response.body)).not.toContain('20000000-0000-4000-8000-000000000099')
  expect(fixture.saved).toBeUndefined()
})

test('refreshes encrypted keys only when the endpoint already belongs to the active owner', async () => {
  const fixture = pushRouteSupabase({ endpointOwner: AGENT.id })
  const response = await request(pushApp(fixture))
    .post('/api/time-management/push/subscriptions')
    .set('Authorization', bearer(AGENT))
    .send({ endpoint: 'https://push.example/subscription', keys: { p256dh: 'fresh-key', auth: 'fresh-secret' } })

  expect(response.status).toBe(201)
  expect(fixture.saved).toMatchObject({ is_active: true, last_error_code: null })
  expect(fixture.saved).not.toHaveProperty('user_id')
  expect(fixture.ownerFilters).toContainEqual({ key: 'user_id', value: AGENT.id })
})

test('an active Bearer owner can deactivate only their own Push endpoint', async () => {
  const fixture = pushRouteSupabase({ endpointOwner: AGENT.id })
  const response = await request(pushApp(fixture))
    .delete('/api/time-management/push/subscriptions')
    .set('Authorization', bearer(AGENT))
    .send({ endpoint: 'https://push.example/subscription' })

  expect(response.status).toBe(204)
  expect(fixture.saved).toEqual({ is_active: false })
  expect(fixture.ownerFilters).toEqual(expect.arrayContaining([
    { key: 'user_id', value: AGENT.id },
    { key: 'endpoint', value: 'https://push.example/subscription' }
  ]))
})

test('an inactive user cannot deactivate a Push endpoint', async () => {
  const fixture = pushRouteSupabase({ endpointOwner: INACTIVE.id })
  const response = await request(pushApp(fixture))
    .delete('/api/time-management/push/subscriptions')
    .set('Authorization', bearer(INACTIVE))
    .send({ endpoint: 'https://push.example/subscription' })

  expect(response.status).toBe(401)
  expect(fixture.saved).toBeUndefined()
})

test('cookie-authenticated Push deletion requires CSRF', async () => {
  const fixture = pushRouteSupabase({ endpointOwner: AGENT.id })
  const response = await request(pushApp(fixture))
    .delete('/api/time-management/push/subscriptions')
    .set('Cookie', `crm_session=${jwt.sign({ id: AGENT.id }, process.env.JWT_SECRET)}`)
    .send({ endpoint: 'https://push.example/subscription' })

  expect(response.status).toBe(403)
  expect(response.body.error.code).toBe('CSRF_INVALID')
  expect(fixture.saved).toBeUndefined()
})

function bearer(user) { return `Bearer ${jwt.sign({ id: user.id }, process.env.JWT_SECRET)}` }

function pushRouteSupabase({ endpointOwner = null } = {}) {
  let saved
  const ownerFilters = []
  return {
    get saved() { return saved },
    ownerFilters,
    supabase: {
      from(table) {
        const filters = {}
        let operation = 'read'
        const query = {
          select() { return query },
          eq(key, value) { filters[key] = value; if (operation === 'update') ownerFilters.push({ key, value }); return query },
          single: async () => {
            if (table === 'users') return { data: filters.id === AGENT.id ? AGENT : INACTIVE, error: null }
            if (table === 'time_push_subscriptions' && operation === 'read') {
              return endpointOwner
                ? { data: { id: 'subscription-1', user_id: endpointOwner, endpoint: filters.endpoint, is_active: true }, error: null }
                : { data: null, error: { code: 'PGRST116' } }
            }
            if (table === 'time_push_subscriptions' && operation === 'update') {
              return { data: { id: 'subscription-1', endpoint: 'https://push.example/subscription', is_active: saved.is_active }, error: null }
            }
            throw new Error(`Unexpected ${table}.single`)
          },
          insert(value) {
            saved = value
            return { select() { return { single: async () => ({ data: { id: 'subscription-1', endpoint: value.endpoint, is_active: true }, error: null }) } } }
          },
          update(value) {
            operation = 'update'
            saved = value
            return query
          },
          then(resolve, reject) {
            return Promise.resolve({ data: null, error: null }).then(resolve, reject)
          }
        }
        return query
      }
    }
  }
}
