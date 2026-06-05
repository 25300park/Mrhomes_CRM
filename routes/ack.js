const router = require('express').Router()
const auth   = require('../middleware/auth')

// GET /api/ack
router.get('/', auth, async (req, res) => {
  const isAdmin = req.user.role === 'admin'
  let query = req.supabase
    .from('ack_documents')
    .select('*')
    .order('ack_date', { ascending: false })
  if (!isAdmin) query = query.eq('created_by', req.user.id)
  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })
  res.json(data || [])
})

// POST /api/ack
router.post('/', auth, async (req, res) => {
  const { ack_date, client_id, client_name, confirmer, category, content, amount, ref_no, html_content } = req.body
  if (!client_name) return res.status(400).json({ error: 'client_name is required' })
  const { data, error } = await req.supabase
    .from('ack_documents')
    .insert({
      ack_date:     ack_date || new Date().toISOString().slice(0,10),
      client_id:    client_id || null,
      client_name,
      confirmer:    confirmer || null,
      category:     category || 'General',
      content:      content || null,
      amount:       amount || null,
      ref_no:       ref_no || null,
      html_content: html_content || null,
      created_by:   req.user.id
    })
    .select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.status(201).json(data)
})

// PATCH /api/ack/:id
router.patch('/:id', auth, async (req, res) => {
  const allowed = ['ack_date','client_id','client_name','confirmer','category','content','amount','ref_no','html_content']
  const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)))
  updates.updated_at = new Date().toISOString()
  const { data, error } = await req.supabase
    .from('ack_documents').update(updates).eq('id', req.params.id).select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// DELETE /api/ack/:id
router.delete('/:id', auth, async (req, res) => {
  const { error } = await req.supabase
    .from('ack_documents').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ message: 'Deleted' })
})

module.exports = router
