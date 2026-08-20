const LOCAL_MODES = new Set(['development', 'test'])

function isRailwayRuntime(env = process.env) {
  return Boolean(
    env.RAILWAY_ENVIRONMENT ||
    env.RAILWAY_ENVIRONMENT_NAME ||
    env.RAILWAY_ENVIRONMENT_ID ||
    env.RAILWAY_PROJECT_ID ||
    env.RAILWAY_SERVICE_ID ||
    env.RAILWAY_DEPLOYMENT_ID
  )
}

function isProductionRuntime(env = process.env) {
  if (isRailwayRuntime(env) || env.NODE_ENV === 'production') return true
  return !LOCAL_MODES.has(env.NODE_ENV)
}

function parseOrigins(value) {
  const entries = Array.isArray(value) ? value : String(value || '').split(',')
  return entries.map(origin => origin.trim()).filter(Boolean).map(origin => {
    let url
    try { url = new URL(origin) } catch { throw new Error(`ALLOWED_ORIGINS contains an invalid origin: ${origin}`) }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.pathname !== '/') {
      throw new Error(`ALLOWED_ORIGINS must contain exact http(s) origins: ${origin}`)
    }
    return url.origin
  })
}

function parseInvalidBefore(value) {
  if (!value || typeof value !== 'string') throw new Error('AUTH_INVALID_BEFORE is required in production')
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error('AUTH_INVALID_BEFORE must be a canonical ISO-8601 UTC instant')
  }
  return value
}

function validateRuntimeConfig(env = process.env) {
  const production = isProductionRuntime(env)
  const originInput = env.ALLOWED_ORIGINS || env.FRONTEND_URL
  const allowedOrigins = parseOrigins(originInput)

  if (production && allowedOrigins.length === 0) {
    throw new Error('ALLOWED_ORIGINS is required in production (FRONTEND_URL is supported for one legacy origin)')
  }

  return {
    production,
    allowedOrigins,
    authInvalidBefore: production ? parseInvalidBefore(env.AUTH_INVALID_BEFORE) : env.AUTH_INVALID_BEFORE
  }
}

module.exports = { isProductionRuntime, parseOrigins, validateRuntimeConfig }
