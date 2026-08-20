const request = require('supertest')
const { createTestApp } = require('../helpers/app')

test('POST /api/auth/login remains mounted', async () => {
  const response = await request(createTestApp()).post('/api/auth/login').send({})

  expect(response.status).toBe(400)
  expect(response.status).not.toBe(404)
})

test('GET / still serves the CRM HTML application', async () => {
  const response = await request(createTestApp()).get('/')

  expect(response.status).toBe(200)
  expect(response.type).toMatch(/html/)
  expect(response.text).toMatch(/<!DOCTYPE html>/i)
})

test('time-management client routes use their own static fallback without taking over CRM or APIs', async () => {
  const app = createTestApp()

  const timeManagementRoot = await request(app).get('/time-management')
  const timeManagement = await request(app).get('/time-management/records')
  const crm = await request(app).get('/')
  const unknownApi = await request(app).get('/api/not-a-route')

  expect(timeManagementRoot.status).toBe(200)
  expect(timeManagementRoot.text).toContain('<div id="root"></div>')
  expect(timeManagement.status).toBe(200)
  expect(timeManagement.text).toContain('<div id="root"></div>')
  expect(crm.status).toBe(200)
  expect(crm.text).toContain('RBS Homes CRM')
  expect(unknownApi.status).toBe(404)
  expect(unknownApi.type).toMatch(/json/)
})
