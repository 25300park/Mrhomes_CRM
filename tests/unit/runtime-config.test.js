const { isProductionRuntime, validateRuntimeConfig } = require('../../services/runtime-config')

const base = {
  JWT_SECRET: 'test-secret',
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SERVICE_KEY: 'service-key'
}

test('Railway and NODE_ENV production are production runtimes', () => {
  expect(isProductionRuntime({ NODE_ENV: 'production' })).toBe(true)
  expect(isProductionRuntime({ NODE_ENV: 'development', RAILWAY_ENVIRONMENT: 'production' })).toBe(true)
  expect(isProductionRuntime({ NODE_ENV: 'development', RAILWAY_ENVIRONMENT_NAME: 'production' })).toBe(true)
  expect(isProductionRuntime({ NODE_ENV: 'test' })).toBe(false)
  expect(isProductionRuntime({ NODE_ENV: 'development' })).toBe(false)
  expect(isProductionRuntime({})).toBe(true)
})

test.each([
  [{ ...base, NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://crm.example.com' }, 'AUTH_INVALID_BEFORE'],
  [{ ...base, RAILWAY_ENVIRONMENT: 'production', AUTH_INVALID_BEFORE: 'invalid', ALLOWED_ORIGINS: 'https://crm.example.com' }, 'AUTH_INVALID_BEFORE'],
  [{ ...base, NODE_ENV: 'production', AUTH_INVALID_BEFORE: '2026-07-16T09:00:00.000Z' }, 'ALLOWED_ORIGINS']
])('production config fails fast when required auth setting is invalid', (env, expected) => {
  expect(() => validateRuntimeConfig(env)).toThrow(expected)
})

test('FRONTEND_URL is accepted as a validated legacy single-origin input', () => {
  const config = validateRuntimeConfig({
    ...base,
    NODE_ENV: 'production',
    AUTH_INVALID_BEFORE: '2026-07-16T09:00:00.000Z',
    FRONTEND_URL: 'https://crm.example.com'
  })
  expect(config.allowedOrigins).toEqual(['https://crm.example.com'])
  expect(config.production).toBe(true)
})

test('origins must be exact http or https origins without paths', () => {
  expect(() => validateRuntimeConfig({ ...base, NODE_ENV: 'development', ALLOWED_ORIGINS: 'https://crm.example.com/path' }))
    .toThrow('ALLOWED_ORIGINS')
})
