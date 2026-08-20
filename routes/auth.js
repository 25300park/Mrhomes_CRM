const router  = require('express').Router()
const bcrypt  = require('bcryptjs')
const auth    = require('../middleware/auth')
const { createCsrfToken } = require('../middleware/csrf')
const { clearSessionCookie, issueSessionCookie } = require('../services/session')

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body
  if (!email || !password) return res.status(400).json({ error: '이메일과 비밀번호를 입력하세요' })

  const { data: user, error } = await req.supabase
    .from('users')
    .select('*')
    .eq('email', email.toLowerCase())
    .eq('is_active', true)
    .single()

  if (error || !user) return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다' })

  const ok = await bcrypt.compare(password, user.password_hash)
  if (!ok) return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다' })

  const token = issueSessionCookie(res, user)

  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role, work_mode: user.work_mode, mobile: user.mobile || null }
  })
})

router.get('/csrf', auth, (req, res) => {
  if (req.auth.method !== 'cookie') return res.status(400).json({ error: '쿠키 세션이 필요합니다' })
  res.json({ csrfToken: createCsrfToken(req.auth.token) })
})

router.post('/logout', (req, res) => {
  clearSessionCookie(res)
  res.json({ message: '로그아웃되었습니다' })
})

// GET /api/auth/me
router.get('/me', auth, async (req, res) => {
  const { data, error } = await req.supabase
    .from('users')
    .select('id, name, email, role, work_mode, base_salary, mobile')
    .eq('id', req.user.id)
    .single()
  if (error) return res.status(404).json({ error: '사용자를 찾을 수 없습니다' })
  res.json(data)
})

// POST /api/auth/change-password
router.post('/change-password', auth, async (req, res) => {
  const { current, next_pw } = req.body
  const { data: user } = await req.supabase.from('users').select('password_hash').eq('id', req.user.id).single()
  const ok = await bcrypt.compare(current, user.password_hash)
  if (!ok) return res.status(400).json({ error: '현재 비밀번호가 올바르지 않습니다' })
  const hash = await bcrypt.hash(next_pw, 10)
  await req.supabase.from('users').update({ password_hash: hash }).eq('id', req.user.id)
  res.json({ message: '비밀번호가 변경되었습니다' })
})

// PATCH /api/auth/profile  (이메일·연락처·비밀번호 수정)
router.patch('/profile', auth, async (req, res) => {
  const { email, mobile, currentPassword, newPassword, confirmPassword } = req.body

  // 현재 비밀번호 확인 (필수)
  if (!currentPassword) return res.status(400).json({ error: '현재 비밀번호를 입력하세요' })

  const { data: user, error: fetchErr } = await req.supabase
    .from('users').select('password_hash, email, mobile').eq('id', req.user.id).single()
  if (fetchErr) return res.status(500).json({ error: '사용자 조회 실패' })

  const ok = await bcrypt.compare(currentPassword, user.password_hash)
  if (!ok) return res.status(401).json({ error: '현재 비밀번호가 올바르지 않습니다' })

  const updates = { updated_at: new Date().toISOString() }

  // 이메일 변경
  if (email && email !== user.email) {
    const exists = await req.supabase.from('users').select('id').eq('email', email.toLowerCase()).single()
    if (exists.data) return res.status(400).json({ error: '이미 사용 중인 이메일입니다' })
    updates.email = email.toLowerCase()
  }

  // 연락처 변경
  if (mobile !== undefined) updates.mobile = mobile || null

  // 비밀번호 변경
  if (newPassword) {
    if (newPassword.length < 6) return res.status(400).json({ error: '새 비밀번호는 6자 이상이어야 합니다' })
    if (newPassword !== confirmPassword) return res.status(400).json({ error: '새 비밀번호가 일치하지 않습니다' })
    updates.password_hash = await bcrypt.hash(newPassword, 10)
  }

  const { data: updated, error } = await req.supabase
    .from('users').update(updates).eq('id', req.user.id).select('id, name, email, mobile, role').single()
  if (error) return res.status(500).json({ error: error.message })

  res.json({ message: '수정되었습니다', user: updated })
})

module.exports = router
