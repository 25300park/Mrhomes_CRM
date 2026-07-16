require('dotenv').config()

const { createClient } = require('@supabase/supabase-js')
const { createApp } = require('./app')
const { validateRuntimeConfig } = require('./services/runtime-config')

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('Required environment variables are missing: SUPABASE_URL, SUPABASE_SERVICE_KEY')
  console.error('Configure them in Railway Dashboard > Variables.')
  process.exit(1)
}

const runtimeConfig = validateRuntimeConfig(process.env)

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const schedulerEnabled = process.env.SCHEDULER_ENABLED !== 'false'
const app = createApp({ supabase, schedulerEnabled, allowedOrigins: runtimeConfig.allowedOrigins })
const PORT = process.env.PORT || 4000

app.listen(PORT, '0.0.0.0', () => {
  console.log(`RBS Homes CRM: http://0.0.0.0:${PORT}`)

  if (!schedulerEnabled) return

  try {
    const { startScheduler } = require('./services/scheduler')
    startScheduler(supabase)
  } catch (error) {
    console.warn('[Scheduler] failed to start:', error.message)
  }
})

module.exports = { app, supabase }
