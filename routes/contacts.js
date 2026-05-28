const router = require('express').Router()
const auth   = require('../middleware/auth')

// 연락처 프라이버시 마스킹 함수
// admin 또는 본인 입력·담당 건: 전체 공개
// 타인 건: mobile, email 비공개 (_private: true 표시)
function applyPrivacy(contacts, userId, isAdmin) {
  if (isAdmin) return contacts.map(c => ({ ...c, _private: false }))
  return contacts.map(c => {
    const canSee = c.assigned_user_id === userId || c.created_by === userId
    if (canSee) return { ...c, _private: false }
    return { ...c, mobile: null, email: null, _private: true }
  })
}

// GET /api/contacts
router.get('/', auth, async (req, res) => {
  const { type, status, agent, q, limit = 200, offset = 0 } = req.query

  let query = req.supabase
    .from('contacts')
    .select(`*, assigned_user:users!contacts_assigned_user_id_fkey(id, name)`)
    .order('name', { ascending: true })
    .range(Number(offset), Number(offset) + Number(limit) - 1)

  if (type)   query = query.eq('type', type.toUpperCase())
  if (status) query = query.eq('status', status.toUpperCase())
  if (agent)  query = query.eq('assigned_user_id', agent)
  if (q)      query = query.ilike('name', `%${q}%`)

  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })

  const result = applyPrivacy(data || [], req.user.id, req.user.role === 'admin')
  res.json({ data: result })
})

// GET /api/contacts/:id
router.get('/:id', auth, async (req, res) => {
  const { data, error } = await req.supabase
    .from('contacts')
    .select(`*, assigned_user:users!contacts_assigned_user_id_fkey(id, name)`)
    .eq('id', req.params.id)
    .single()
  if (error) return res.status(404).json({ error: '고객을 찾을 수 없습니다' })

  const isAdmin = req.user.role === 'admin'
  const canSee  = isAdmin || data.assigned_user_id === req.user.id || data.created_by === req.user.id
  res.json({ ...data, mobile: canSee ? data.mobile : null, email: canSee ? data.email : null, _private: !canSee })
})

// POST /api/contacts
router.post('/', auth, async (req, res) => {
  const { name, type, type2, nickname, mobile, email, nationality, platform, assigned_user_id, status, remarks } = req.body
  if (!name || !type) return res.status(400).json({ error: '이름과 유형은 필수입니다' })

  const { data, error } = await req.supabase
    .from('contacts')
    .insert({
      name, type, type2: type2||null, nickname: nickname||null,
      mobile, email, nationality, platform,
      assigned_user_id: assigned_user_id || req.user.id,
      created_by: req.user.id,
      status: status || 'ACTIVE', remarks
    })
    .select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.status(201).json(data)
})

// PATCH /api/contacts/:id
router.patch('/:id', auth, async (req, res) => {
  const allowed = ['name','type','type2','nickname','mobile','email','nationality','platform','assigned_user_id','status','remarks']
  const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)))
  updates.updated_at = new Date().toISOString()

  const { data, error } = await req.supabase
    .from('contacts').update(updates).eq('id', req.params.id).select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// DELETE /api/contacts/:id  (hard delete — admin 또는 본인 입력건)
router.delete('/:id', auth, async (req, res) => {
  const { error } = await req.supabase
    .from('contacts').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ message: '삭제되었습니다' })
})

module.exports = router
