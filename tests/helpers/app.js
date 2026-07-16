const { createApp } = require('../../app')
const { createSupabaseFake } = require('./supabase-fake')

function createTestApp({
  supabase = createSupabaseFake(),
  schedulerEnabled = false,
  allowedOrigins
} = {}) {
  return createApp({ supabase, schedulerEnabled, allowedOrigins })
}

module.exports = { createTestApp }
