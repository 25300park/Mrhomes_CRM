require('dotenv').config()
const express    = require('express')
const cors       = require('cors')
const morgan     = require('morgan')
const path       = require('path')
const { createClient } = require('@supabase/supabase-js')

// ── Supabase 클라이언트 ───────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY   // service role key (백엔드 전용)
)

// ── Express 앱 설정 ───────────────────────────
const app = express()
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }))
app.use(express.json())
app.use(morgan('dev'))

// 프론트엔드 정적 파일 서빙
app.use(express.static(path.join(__dirname, 'public')))

// Supabase 클라이언트를 req에 주입 (모든 라우터에서 사용)
app.use((req, _res, next) => { req.supabase = supabase; next() })

// ── 라우터 등록 ───────────────────────────────
app.use('/api/auth',       require('./routes/auth'))
app.use('/api/contacts',   require('./routes/contacts'))
app.use('/api/listings',   require('./routes/listings'))
app.use('/api/leads',      require('./routes/leads'))
app.use('/api/deals',      require('./routes/deals'))
app.use('/api/accounting', require('./routes/accounting'))
app.use('/api/staff',      require('./routes/staff'))
app.use('/api/dashboard',  require('./routes/dashboard'))
app.use('/api/activities',     require('./routes/activities'))
app.use('/api/upload',         require('./routes/upload'))
app.use('/api/notifications',  require('./routes/notifications'))

// ── 헬스체크 ─────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }))

// ── 에러 핸들러 ───────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err.stack)
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' })
})

const PORT = process.env.PORT || 4000
app.listen(PORT, () => {
  console.log(`🏠 RBS Homes CRM API → http://localhost:${PORT}`)
  // 스케줄러 시작 (이메일 설정 여부와 무관하게 시작)
  try {
    const { startScheduler } = require('./services/scheduler')
    startScheduler(supabase)
  } catch(e) {
    console.warn('[Scheduler] 시작 실패:', e.message)
  }
})

module.exports = { app, supabase }
