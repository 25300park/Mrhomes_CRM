const router = require('express').Router()
const auth   = require('../middleware/auth')

// GET /api/notifications/followup — 오늘 팔로업 목록
router.get('/followup', auth, async (req, res) => {
  let query = req.supabase
    .from('v_leads_followup')
    .select('*')
    .order('next_followup_at', { ascending: true })

  // 직원은 본인 것만, admin은 전체
  if (req.user.role !== 'admin') {
    query = query.eq('assigned_user_id', req.user.id)
  }

  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })
  res.json(data || [])
})

// GET /api/notifications/count — 미처리 팔로업 건수만
router.get('/count', auth, async (req, res) => {
  let query = req.supabase
    .from('v_leads_followup')
    .select('id', { count: 'exact', head: true })

  if (req.user.role !== 'admin') {
    query = query.eq('assigned_user_id', req.user.id)
  }

  const { count, error } = await query
  if (error) return res.status(500).json({ error: error.message })
  res.json({ count: count || 0 })
})

// POST /api/notifications/test-email — 테스트 이메일 발송 (admin only)
router.post('/test-email', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '관리자만 사용 가능합니다' })

  const { sendFollowupReminder } = require('../services/mailer')
  const { data: user }  = await req.supabase.from('users').select('id, name, email').eq('id', req.user.id).single()
  const { data: leads } = await req.supabase.from('v_leads_followup').select('*').limit(3)

  try {
    await sendFollowupReminder(user, leads || [])
    res.json({ message: `테스트 이메일 발송 완료: ${user.email}` })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

module.exports = router
