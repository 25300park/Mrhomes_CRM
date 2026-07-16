const crypto = require('node:crypto')
const { SESSION_COOKIE } = require('../services/session')
const { authenticateRequest } = require('./auth')

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

function createCsrfToken(sessionToken) {
  return crypto.createHmac('sha256', process.env.JWT_SECRET).update(sessionToken).digest('base64url')
}

function tokensMatch(actual, expected) {
  if (!actual || !expected) return false
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

async function requireCsrf(req, res, next) {
  if (SAFE_METHODS.has(req.method) || req.path === '/api/auth/login') return next()
  const sessionToken = req.cookies?.[SESSION_COOKIE]
  if (!sessionToken) return next()

  // A stale session must always be removable. Valid active sessions still require CSRF.
  if (req.path === '/api/auth/logout') {
    try { await authenticateRequest(req) } catch { return next() }
  }

  const supplied = req.get('X-CSRF-Token')
  if (!tokensMatch(supplied, createCsrfToken(sessionToken))) {
    return res.status(403).json({ error: '유효한 CSRF 토큰이 필요합니다' })
  }
  next()
}

module.exports = { createCsrfToken, requireCsrf }
