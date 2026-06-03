const router = require('express').Router()
const auth   = require('../middleware/auth')

// GET /api/listing-reports
router.get('/', auth, async (req, res) => {
  const isAdmin       = req.user.role === 'admin'
  const includeShared = req.query.include_shared === '1'

  let query = req.supabase
    .from('listing_reports')
    .select('*')
    .order('report_date', { ascending: false })

  if (isAdmin) {
    // Admin: 전체 조회
  } else if (includeShared) {
    // 내 Report + 공유된 Report
    query = query.or(`created_by.eq.${req.user.id},is_shared.eq.true`)
  } else {
    // 내 Report만
    query = query.eq('created_by', req.user.id)
  }

  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })
  res.json(data || [])
})

// POST /api/listing-reports
router.post('/', auth, async (req, res) => {
  const { client_name, report_date, agent_name, listing_ids } = req.body
  const { data, error } = await req.supabase
    .from('listing_reports')
    .insert({
      client_name, report_date, agent_name,
      listing_ids: listing_ids || [],
      created_by:  req.user.id
    })
    .select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.status(201).json(data)
})

// PATCH /api/listing-reports/:id
router.patch('/:id', auth, async (req, res) => {
  const allowed = ['client_name','report_date','agent_name','listing_ids','is_shared','shared_at']
  const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)))
  updates.updated_at = new Date().toISOString()
  const { data, error } = await req.supabase
    .from('listing_reports').update(updates).eq('id', req.params.id).select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// DELETE /api/listing-reports/:id (작성자 또는 admin만)
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
