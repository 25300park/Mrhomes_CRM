const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const request = require('supertest')
const { createTestApp } = require('../helpers/app')

function usersQuery(user) {
  const query = {
    select() { return query },
    eq(column, value) {
      if (column === 'email' && user.email !== value) query.matches = false
      if (column === 'id' && user.id !== value) query.matches = false
      if (column === 'is_active' && user.is_active !== value) query.matches = false
      return query
    },
    single() {
      return Promise.resolve(query.matches === false
        ? { data: null, error: { message: 'not found' } }
        : { data: user, error: null })
    }
  }
  return query
}

async function fixture() {
  const user = {
    id: 'user-1', name: 'Agent One', email: 'agent@example.com', role: 'agent',
    is_active: true, password_hash: await bcrypt.hash('correct-password', 4), work_mode: 'office'
  }
  const supabase = { from: vi.fn(() => usersQuery(user)) }
  return { user, app: createTestApp({ supabase }) }
}

test('login issues an HttpOnly SameSite=Lax root session cookie', async () => {
  const { app } = await fixture()
  const response = await request(app).post('/api/auth/login').send({
    email: 'agent@example.com', password: 'correct-password'
  })

  expect(response.status).toBe(200)
  const cookie = response.headers['set-cookie'][0]
  expect(cookie).toContain('crm_session=')
  expect(cookie).toContain('HttpOnly')
  expect(cookie).toContain('SameSite=Lax')
  expect(cookie).toContain('Path=/')
  expect(response.body.token).toEqual(expect.any(String))
})

test('cookie-authenticated GET /api/auth/me reloads the active user', async () => {
  const { app } = await fixture()
  const agent = request.agent(app)
  await agent.post('/api/auth/login').send({ email: 'agent@example.com', password: 'correct-password' })

  const response = await agent.get('/api/auth/me')

  expect(response.status).toBe(200)
  expect(response.body).toMatchObject({ id: 'user-1', role: 'agent' })
})

test('missing and inactive cookie principals are rejected after JWT verification', async () => {
  const missing = { from: () => usersQuery({ id: 'different', is_active: true }) }
  const inactive = { from: () => usersQuery({ id: 'user-1', is_active: false }) }
  const token = jwt.sign({ id: 'user-1', role: 'admin' }, process.env.JWT_SECRET)

  const missingResponse = await request(createTestApp({ supabase: missing }))
    .get('/api/auth/me').set('Cookie', `crm_session=${token}`)
  const inactiveResponse = await request(createTestApp({ supabase: inactive }))
    .get('/api/auth/me').set('Cookie', `crm_session=${token}`)

  expect(missingResponse.status).toBe(401)
  expect(inactiveResponse.status).toBe(401)
})

test('logout requires valid CSRF for cookie auth and expires the session', async () => {
  const { app } = await fixture()
  const agent = request.agent(app)
  await agent.post('/api/auth/login').send({ email: 'agent@example.com', password: 'correct-password' })

  expect((await agent.post('/api/auth/logout')).status).toBe(403)
  expect((await agent.post('/api/auth/logout').set('X-CSRF-Token', 'invalid')).status).toBe(403)
  const csrf = await agent.get('/api/auth/csrf')
  const logout = await agent.post('/api/auth/logout').set('X-CSRF-Token', csrf.body.csrfToken)

  expect(csrf.status).toBe(200)
  expect(logout.status).toBe(200)
  expect(logout.headers['set-cookie'][0]).toMatch(/crm_session=;/)
})

test('cookie state changes require CSRF while Bearer state changes are exempt', async () => {
  const { app } = await fixture()
  const agent = request.agent(app)
  await agent.post('/api/auth/login').send({ email: 'agent@example.com', password: 'correct-password' })
  const cookieMutation = await agent.post('/api/auth/change-password').send({})

  const bearer = jwt.sign({ id: 'user-1', role: 'admin' }, process.env.JWT_SECRET)
  const bearerMutation = await request(app).post('/api/auth/logout')
    .set('Authorization', `Bearer ${bearer}`).send({})

  expect(cookieMutation.status).toBe(403)
  expect(bearerMutation.status).not.toBe(403)
})

test('a Bearer header cannot bypass CSRF when a session cookie is present', async () => {
  const { app } = await fixture()
  const agent = request.agent(app)
  await agent.post('/api/auth/login').send({ email: 'agent@example.com', password: 'correct-password' })
  const bearer = jwt.sign({ id: 'user-1' }, process.env.JWT_SECRET)

  const response = await agent.post('/api/auth/logout').set('Authorization', `Bearer ${bearer}`)

  expect(response.status).toBe(403)
})

test('CORS permits configured origins and origin-less requests but rejects others', async () => {
  const { user } = await fixture()
  const supabase = { from: () => usersQuery(user) }
  const app = createTestApp({ supabase, allowedOrigins: ['https://crm.example.com'] })

  expect((await request(app).get('/health')).status).toBe(200)
  expect((await request(app).get('/health').set('Origin', 'https://crm.example.com')).status).toBe(200)
  expect((await request(app).get('/health').set('Origin', 'https://evil.example')).status).toBe(403)
})
