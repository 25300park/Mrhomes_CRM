const { createApp } = require('../../app')
const { createSupabaseFake } = require('./supabase-fake')

function createTestApp({
  supabase = createSupabaseFake(),
  schedulerEnabled = false,
  allowedOrigins,
  timePushSecurity
} = {}) {
  return createApp({ supabase, schedulerEnabled, allowedOrigins, timePushSecurity })
}

module.exports = { createTestApp }
