const jwt = require('jsonwebtoken')
const { isProductionRuntime } = require('./runtime-config')

const SESSION_COOKIE = 'crm_session'
const SESSION_AGE_MS = 7 * 24 * 60 * 60 * 1000

function cookieOptions({ production = isProductionRuntime(process.env) } = {}) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: production,
    path: '/'
  }
}

function issueSessionCookie(res, principal, options = {}) {
  const token = jwt.sign({ id: principal.id }, process.env.JWT_SECRET, { expiresIn: '7d' })
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions(options), maxAge: SESSION_AGE_MS })
  return token
}

function clearSessionCookie(res, options = {}) {
  res.clearCookie(SESSION_COOKIE, cookieOptions(options))
}

module.exports = {
  SESSION_COOKIE,
  clearSessionCookie,
  issueSessionCookie
}
