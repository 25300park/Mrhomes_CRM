const router = require('express').Router()
const auth   = require('../middleware/auth')

// GET /api/listing-reports
router.get('/', auth, async (req, res) => {
  const isAdmin = req.user.role === 'admin'
  let query = req.supabase
    .from('listing_reports')
    .select('*')
    .order('report_date', { ascending: false })
  if (!isAdmin) query = query.eq('created_by', req.user.id)
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
  const allowed = ['client_name','report_date','agent_name','listing_ids']
  const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)))
  updates.updated_at = new Date().toISOString()
  const { data, error } = await req.supabase
    .from('listing_reports').update(updates).eq('id', req.params.id).select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// DELETE /api/listing-reports/:id
router.delete('/:id', auth, async (req, res) => {
  const { error } = await req.supabase
    .from('listing_reports').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ message: 'Deleted' })
})

module.exports = router
