const router = require('express').Router()
const auth   = require('../middleware/auth')

// GET /api/activities
router.get('/', auth, async (req, res) => {
  const { contact_id, lead_id, listing_id, limit = 50 } = req.query
  let query = req.supabase
    .from('activities')
    .select(`
      *,
      contact:contacts(id, name, type),
      listing:listings(id, name, code),
      created_by_user:users!activities_created_by_fkey(id, name)
    `)
    .order('created_at', { ascending: false })
    .limit(Number(limit))

  if (contact_id) query = query.eq('contact_id', contact_id)
  if (lead_id)    query = query.eq('lead_id', lead_id)
  if (listing_id) query = query.eq('listing_id', listing_id)

  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// POST /api/activities
router.post('/', auth, async (req, res) => {
  const { type, contact_id, lead_id, listing_id, notes, next_followup_at } = req.body
  if (!type) return res.status(400).json({ error: '활동 유형은 필수입니다' })

  const { data, error } = await req.supabase
    .from('activities')
    .insert({
      type, contact_id: contact_id || null,
      lead_id: lead_id || null,
      listing_id: listing_id || null,
      notes, next_followup_at: next_followup_at || null,
      created_by: req.user.id
    })
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })

  // 리드 팔로업 날짜 자동 업데이트
  if (lead_id && next_followup_at) {
    await req.supabase.from('leads')
      .update({ next_followup_at, updated_at: new Date().toISOString() })
      .eq('id', lead_id)
  }

  res.status(201).json(data)
})

// DELETE /api/activities/:id
router.delete('/:id', auth, async (req, res) => {
  const { error } = await req.supabase.from('activities').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ message: '삭제 완료' })
})

module.exports = router
