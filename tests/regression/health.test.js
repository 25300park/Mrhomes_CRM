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
