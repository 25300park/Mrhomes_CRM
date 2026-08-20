const request = require('supertest')
const { createApp } = require('../../app')

test('GET /health remains available', async () => {
  const app = createApp({ supabase: {}, schedulerEnabled: false })
  const response = await request(app).get('/health')

  expect(response.status).toBe(200)
  expect(response.body.status).toBe('ok')
})

test('createApp records that scheduling is disabled for tests', () => {
  const app = createApp({ supabase: {}, schedulerEnabled: false })

  expect(app.locals.schedulerEnabled).toBe(false)
})

test('createApp can capture errors without changing the production logger default', async () => {
  const errors = []
  const app = createApp({
    supabase: {},
    schedulerEnabled: false,
    allowedOrigins: ['http://allowed.test'],
    logger: { error: value => errors.push(String(value)) }
  })

  const response = await request(app).get('/health').set('Origin', 'http://blocked.test')

  expect(response.status).toBe(403)
  expect(errors.join('\n')).toContain('Origin is not allowed')
})
