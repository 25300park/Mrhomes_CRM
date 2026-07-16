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
