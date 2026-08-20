const express = require('express')
const { createApp } = require('../../app')
const { createFixture, IDS } = require('./supabase.cjs')

const PORT = 4177
process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'task-12-local-fixture-secret-with-32-bytes'
process.env.SCHEDULER_ENABLED = 'false'
delete process.env.AUTH_INVALID_BEFORE

async function startServer() {
  let fixture = await createFixture()
  const supabase = {
    from(...args) { return fixture.supabase.from(...args) },
    rpc(...args) { return fixture.supabase.rpc(...args) },
    get storage() { return fixture.supabase.storage }
  }
  const logger = {
    error(...values) { fixture.state.logs.push(values.map(String).join(' ')) },
    log(...values) { fixture.state.logs.push(values.map(String).join(' ')) }
  }
  const httpLogStream = { write(line) { fixture.state.logs.push(String(line).trim()) } }
  const controller = express()
  controller.use(express.json())
  controller.post('/__e2e/reset', async (req, res) => {
    fixture = await createFixture(req.body || {})
    res.json({ ok: true })
  })
  controller.post('/__e2e/control', (req, res) => {
    const { action, target, status, delayMs, timer } = req.body || {}
    if (action === 'failNext') fixture.state.controls.failures[target] = target.startsWith('/')
      ? { status: Number(status) || 503 }
      : { code: status === 404 ? 'P0003' : 'E2E_INJECTED_FAILURE' }
    else if (action === 'delayNext') fixture.state.controls.delays[target] = Number(delayMs) || 0
    else if (action === 'setServerTimer') {
      fixture.state.tables.time_entries = fixture.state.tables.time_entries.filter(entry => entry.entry_type !== 'TIMER' || entry.ended_at !== null)
      if (timer) fixture.state.tables.time_entries.push({
        ...timer,
        id: String(timer.id).includes('-0000-4000-') ? timer.id : '50000000-0000-4000-8000-000000000099',
        user_id: IDS.user,
        business_date: fixture.state.businessDate, entry_type: 'TIMER',
        standard_category_id: timer.standard_category_id === 'category-client' ? IDS.client : timer.standard_category_id,
        ended_at: null, duration_seconds: null
      })
    } else return res.status(400).json({ error: 'Unknown E2E control action' })
    res.json({ ok: true })
  })
  controller.get('/__e2e/state', (_req, res) => res.json({
    calls: fixture.state.calls,
    activeTimer: fixture.state.tables.time_entries.find(entry => entry.entry_type === 'TIMER' && entry.ended_at === null) || null,
    logs: fixture.state.logs, outbound: fixture.state.outbound, externalRequests: []
  }))
  controller.use(async (req, res, next) => {
    const failure = fixture.state.controls.failures[req.path]
    if (failure?.status) {
      delete fixture.state.controls.failures[req.path]
      return res.status(failure.status).json({ error: { code: 'E2E_INJECTED_FAILURE', message: 'Deterministic test failure' } })
    }
    const delay = fixture.state.controls.delays[req.path]
    if (delay) { delete fixture.state.controls.delays[req.path]; await new Promise(resolve => setTimeout(resolve, delay)) }
    next()
  })
  controller.use(createApp({
    supabase,
    schedulerEnabled: false,
    allowedOrigins: [`http://127.0.0.1:${PORT}`],
    timePushSecurity: { vapidPublicKey: 'BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    logger,
    httpLogStream
  }))
  return new Promise((resolve, reject) => {
    const server = controller.listen(PORT, '127.0.0.1', () => {
      console.log(`[E2E] real local app listening on ${PORT}`)
      resolve(server)
    })
    server.on('error', reject)
  })
}

if (require.main === module) startServer().catch(error => { console.error('[E2E] fixture failed:', error.message); process.exit(1) })
module.exports = { startServer }
