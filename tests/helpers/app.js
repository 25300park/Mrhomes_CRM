const { createApp } = require('../../app')
const { createSupabaseFake } = require('./supabase-fake')

function createTestApp({ supabase = createSupabaseFake(), schedulerEnabled = false } = {}) {
  return createApp({ supabase, schedulerEnabled })
}

module.exports = { createTestApp }
