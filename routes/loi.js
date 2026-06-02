const router = require('express').Router()
const auth   = require('../middleware/auth')

// GET /api/loi — 내 LOI 목록
router.get('/', auth, async (req, res) => {
  const isAdmin = req.user.role === 'admin'
  let query = req.supabase
    .from('loi_documents')
    .select('*')
    .order('loi_date', { ascending: false })
  if (!isAdmin) query = query.eq('created_by', req.user.id)
  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })
  res.json(data || [])
})

// POST /api/loi — 신규 저장
router.post('/', auth, async (req, res) => {
  const {
    loi_date, listing_id, property_name, address, unit_no, area_sqm,
    furnished, tenant_name, nationality, monthly_rent, deposit, advance,
    duration, movein_date, pet_allowed, special, agent_name, agent_mobile,
    html_content
  } = req.body
  const { data, error } = await req.supabase
    .from('loi_documents')
    .insert({
      loi_date, listing_id, property_name, address, unit_no,
      area_sqm:     area_sqm     || null,
      furnished, tenant_name, nationality,
      monthly_rent: monthly_rent || null,
      deposit, advance, duration,
      movein_date:  movein_date  || null,
      pet_allowed, special, agent_name, agent_mobile,
      html_content,
      created_by: req.user.id
    })
    .select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.status(201).json(data)
})

// PATCH /api/loi/:id — 수정
router.patch('/:id', auth, async (req, res) => {
  const allowed = [
    'loi_date','listing_id','property_name','address','unit_no','area_sqm',
    'furnished','tenant_name','nationality','monthly_rent','deposit','advance',
    'duration','movein_date','pet_allowed','special','agent_name','agent_mobile',
    'html_content'
  ]
  const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)))
  updates.updated_at = new Date().toISOString()
  const { data, error } = await req.supabase
    .from('loi_documents').update(updates).eq('id', req.params.id).select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// DELETE /api/loi/:id — 삭제
router.delete('/:id', auth, async (req, res) => {
  const { error } = await req.supabase
    .from('loi_documents').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ message: 'Deleted' })
})

module.exports = router
