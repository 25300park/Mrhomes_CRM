const jwt = require('jsonwebtoken')

const {
  clearSessionCookie,
  issueSessionCookie
} = require('../../services/session')

function responseRecorder() {
  const calls = []
  return {
    calls,
    cookie(name, value, options) { calls.push({ type: 'cookie', name, value, options }) },
    clearCookie(name, options) { calls.push({ type: 'clear', name, options }) }
  }
}

test('issueSessionCookie creates an HttpOnly Lax root cookie', () => {
  const res = responseRecorder()

  issueSessionCookie(res, { id: 'user-1' }, { production: false })

  expect(res.calls[0]).toMatchObject({
    type: 'cookie',
    name: 'crm_session',
    options: { httpOnly: true, sameSite: 'lax', path: '/', secure: false }
  })
  expect(jwt.verify(res.calls[0].value, process.env.JWT_SECRET).id).toBe('user-1')
})

test('production session cookies are Secure', () => {
  const res = responseRecorder()
  issueSessionCookie(res, { id: 'user-1' }, { production: true })
  expect(res.calls[0].options.secure).toBe(true)
})

test('Railway cookies are Secure even if NODE_ENV is missing or development', () => {
  const previous = { NODE_ENV: process.env.NODE_ENV, RAILWAY_ENVIRONMENT: process.env.RAILWAY_ENVIRONMENT }
  process.env.NODE_ENV = 'development'
  process.env.RAILWAY_ENVIRONMENT = 'production'
  try {
    const res = responseRecorder()
    issueSessionCookie(res, { id: 'user-1' })
    expect(res.calls[0].options.secure).toBe(true)
  } finally {
    process.env.NODE_ENV = previous.NODE_ENV
    if (previous.RAILWAY_ENVIRONMENT === undefined) delete process.env.RAILWAY_ENVIRONMENT
    else process.env.RAILWAY_ENVIRONMENT = previous.RAILWAY_ENVIRONMENT
  }
})

test('session maxAge and JWT expiration both cover seven days', () => {
  const res = responseRecorder()
  issueSessionCookie(res, { id: 'user-1' }, { production: false })
  const claims = jwt.verify(res.calls[0].value, process.env.JWT_SECRET)
  expect(res.calls[0].options.maxAge).toBe(7 * 24 * 60 * 60 * 1000)
  expect(claims.exp - claims.iat).toBe(7 * 24 * 60 * 60)
})

test('clearSessionCookie expires the same cookie scope', () => {
  const res = responseRecorder()
  clearSessionCookie(res, { production: true })
  expect(res.calls[0]).toMatchObject({
    type: 'clear',
    name: 'crm_session',
    options: { httpOnly: true, sameSite: 'lax', path: '/', secure: true }
  })
})
