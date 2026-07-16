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

test('clearSessionCookie expires the same cookie scope', () => {
  const res = responseRecorder()
  clearSessionCookie(res, { production: true })
  expect(res.calls[0]).toMatchObject({
    type: 'clear',
    name: 'crm_session',
    options: { httpOnly: true, sameSite: 'lax', path: '/', secure: true }
  })
})
