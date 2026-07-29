const express = require('express')
const cors = require('cors')
const morgan = require('morgan')
const path = require('path')
const cookieParser = require('cookie-parser')
const crypto = require('node:crypto')
const { requireCsrf } = require('./middleware/csrf')
const { parseOrigins } = require('./services/runtime-config')

const pmsPayments = require('./routes/pms-payments')
const pmsCare = require('./routes/pms-care')
const pmsAccounts = require('./routes/pms-accounts')
const pmsDocuments = require('./routes/pms-documents')

function createApp({ supabase, schedulerEnabled = true, allowedOrigins, timePushSecurity } = {}) {
  const app = express()
  app.locals.schedulerEnabled = schedulerEnabled
  app.locals.timePushSecurity = timePushSecurity || {}

  const origins = new Set(parseOrigins(allowedOrigins ?? process.env.ALLOWED_ORIGINS ?? process.env.FRONTEND_URL))
  app.use(cors({
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
    origin(origin, callback) {
      if (!origin || origins.has(origin)) return callback(null, true)
      const error = new Error('Origin is not allowed')
      error.status = 403
      callback(error)
    }
  }))
  app.use(express.json())
  app.use(cookieParser())
  app.use(morgan('combined'))
  app.use(express.static(path.join(__dirname, 'public')))
  app.use((req, _res, next) => {
    req.supabase = supabase
    next()
  })
  app.use('/api/time-management', (req, _res, next) => {
    const inbound = req.get('X-Request-Id')
    req.timeRequestId = typeof inbound === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(inbound)
      ? inbound
      : crypto.randomUUID()
    next()
  })
  app.use(requireCsrf)

  app.use('/api/auth', require('./routes/auth'))
  app.use('/api/contacts', require('./routes/contacts'))
  app.use('/api/listings', require('./routes/listings'))
  app.use('/api/leads', require('./routes/leads'))
  app.use('/api/deals', require('./routes/deals'))
  app.use('/api/accounting', require('./routes/accounting'))
  app.use('/api/staff', require('./routes/staff'))
  app.use('/api/dashboard', require('./routes/dashboard'))
  app.use('/api/activities', require('./routes/activities'))
  app.use('/api/upload', require('./routes/upload'))
  app.use('/api/notifications', require('./routes/notifications'))
  app.use('/api/ai', require('./routes/ai'))
  app.use('/api/condos', require('./routes/condos'))
  app.use('/api/tenants', require('./routes/tenants'))
  app.use('/api/loi', require('./routes/loi'))
  app.use('/api/listing-reports', require('./routes/listing-reports'))
  app.use('/api/ack', require('./routes/ack'))
  app.use('/api/pms-payments', pmsPayments)
  app.use('/api/pms-care', pmsCare)
  app.use('/api/pms-accounts', pmsAccounts)
  app.use('/api/pms-documents', pmsDocuments)
  app.use('/api/time-management', require('./routes/time-management'))

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', ts: new Date().toISOString() })
  })
  app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'))
  })

  app.use((err, _req, res, _next) => {
    console.error(err.stack)
    res.status(err.status || 500).json({ error: err.message || 'Server Error' })
  })

  return app
}

module.exports = { createApp }
