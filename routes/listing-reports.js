// routes/listing-reports.js (v2)
// contact_id 연결 지원

const router = require('express').Router()
const auth   = require('../middleware/auth')

// GET /api/listing-reports
router.get('/', auth, async (req, res) => {
  const isAdmin       = req.user.role === 'admin'
  const includeShared = req.query.include_shared === '1'
  const contactId     = req.query.contact_id

  let query = req.supabase
    .from('listing_reports')
    .select('*')
    .order('report_date', { ascending: false })

  if (contactId) {
    query = query.eq('contact_id', contactId)
  } else if (isAdmin) {
    // Admin: 전체 조회
  } else if (includeShared) {
    query = query.or(`created_by.eq.${req.user.id},is_shared.eq.true`)
  } else {
    query = query.eq('created_by', req.user.id)
  }

  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })
  res.json(data || [])
})

// POST /api/listing-reports
router.post('/', auth, async (req, res) => {
  const { client_name, report_date, agent_name, listing_ids, contact_id } = req.body
  const { data, error } = await req.supabase
    .from('listing_reports')
    .insert({
      client_name, report_date, agent_name,
      listing_ids: listing_ids || [],
      contact_id:  contact_id || null,
      created_by:  req.user.id
    })
    .select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.status(201).json(data)
})

// PATCH /api/listing-reports/:id
router.patch('/:id', auth, async (req, res) => {
  const allowed = ['client_name','report_date','agent_name','listing_ids','is_shared','shared_at','contact_id']
  const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)))
  updates.updated_at = new Date().toISOString()
  const { data, error } = await req.supabase
    .from('listing_reports').update(updates).eq('id', req.params.id).select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// DELETE /api/listing-reports/:id
router.delete('/:id', auth, async (req, res) => {
  const { data: report } = await req.supabase
    .from('listing_reports').select('created_by').eq('id', req.params.id).single()
  if (!report) return res.status(404).json({ error: 'Not found' })
  if (req.user.role !== 'admin' && report.created_by !== req.user.id)
    return res.status(403).json({ error: 'Permission denied' })
  const { error } = await req.supabase
    .from('listing_reports').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ message: 'Deleted' })
})

module.exports = router
