require('dotenv').config()
const express    = require('express')
const cors       = require('cors')
const morgan     = require('morgan')
const path       = require('path')
const { createClient } = require('@supabase/supabase-js')
const pmsPayments = require('./routes/pms-payments')


// ── 환경변수 확인 ─────────────────────────────
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('❌ 필수 환경변수 누락: SUPABASE_URL, SUPABASE_SERVICE_KEY')
  console.error('Railway Dashboard → Variables 탭에서 설정하세요')
  process.exit(1)
}

// ── Supabase 클라이언트 ───────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// ── Express 앱 설정 ───────────────────────────
const app = express()
app.use(cors({ origin: '*' }))
app.use(express.json())
app.use(morgan('combined'))
app.use(express.static(path.join(__dirname, 'public')))
app.use((req, _res, next) => { req.supabase = supabase; next() })

// ── 라우터 등록 ───────────────────────────────
app.use('/api/auth',          require('./routes/auth'))
app.use('/api/contacts',      require('./routes/contacts'))
app.use('/api/listings',      require('./routes/listings'))
app.use('/api/leads',         require('./routes/leads'))
app.use('/api/deals',         require('./routes/deals'))
app.use('/api/accounting',    require('./routes/accounting'))
app.use('/api/staff',         require('./routes/staff'))
app.use('/api/dashboard',     require('./routes/dashboard'))
app.use('/api/activities',    require('./routes/activities'))
app.use('/api/upload',        require('./routes/upload'))
app.use('/api/notifications', require('./routes/notifications'))
app.use('/api/ai',            require('./routes/ai'))
app.use('/api/condos',        require('./routes/condos'))
app.use('/api/tenants',       require('./routes/tenants'))
app.use('/api/loi',            require('./routes/loi'))
app.use('/api/listing-reports',require('./routes/listing-reports'))
app.use('/api/pms-payments', pmsPayments)

// ── 헬스체크 (Railway 상태 확인용) ───────────
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }))
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')))

// ── 에러 핸들러 ───────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err.stack)
  res.status(err.status || 500).json({ error: err.message || 'Server Error' })
})

// ── 서버 시작 (0.0.0.0 바인딩 — Railway 필수) ─
const PORT = process.env.PORT || 4000
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ RBS Homes CRM → http://0.0.0.0:${PORT}`)
  try {
    const { startScheduler } = require('./services/scheduler')
    startScheduler(supabase)
  } catch(e) {
    console.warn('[Scheduler] 시작 실패 (무시됨):', e.message)
  }
})

module.exports = { app, supabase }
