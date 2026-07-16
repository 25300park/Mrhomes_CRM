const jwt = require('jsonwebtoken')
const { SESSION_COOKIE } = require('../services/session')

async function authenticateRequest(req) {
  const cookieToken = req.cookies?.[SESSION_COOKIE]
  const authorization = req.headers.authorization || ''
  const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i)
  const token = cookieToken || bearerMatch?.[1]
  if (!token) {
    const error = new Error('인증이 필요합니다')
    error.status = 401
    throw error
  }

  let claims
  try {
    claims = jwt.verify(token, process.env.JWT_SECRET)
  } catch {
    const error = new Error('유효하지 않은 세션입니다')
    error.status = 401
    throw error
  }

  if (process.env.AUTH_INVALID_BEFORE) {
    const cutoff = Date.parse(process.env.AUTH_INVALID_BEFORE)
    const issuedAt = Number(claims.iat) * 1000
    if (!Number.isFinite(cutoff) || !Number.isFinite(issuedAt) || issuedAt < cutoff) {
      const error = new Error('다시 로그인해 주세요')
      error.status = 401
      throw error
    }
  }

  const { data: user, error: lookupError } = await req.supabase
    .from('users')
    .select('id, name, email, role, is_active')
    .eq('id', claims.id)
    .eq('is_active', true)
    .single()

  if (lookupError || !user || user.is_active !== true) {
    const error = new Error('활성 사용자를 찾을 수 없습니다')
    error.status = 401
    throw error
  }

  return { user, method: cookieToken ? 'cookie' : 'bearer', token }
}

async function auth(req, res, next) {
  try {
    req.auth = await authenticateRequest(req)
    req.user = req.auth.user
    next()
  } catch (error) {
    res.status(error.status || 401).json({ error: error.message })
  }
}

module.exports = auth
module.exports.authenticateRequest = authenticateRequest
