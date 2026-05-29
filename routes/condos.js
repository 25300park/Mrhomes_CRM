const router = require('express').Router()
const auth   = require('../middleware/auth')

// GET /api/condos?q=검색어
router.get('/', auth, async (req, res) => {
  const { q } = req.query
  if (!q || q.trim().length < 2) return res.json([])

  const { data, error } = await req.supabase
    .from('condos')
    .select('id, name, alias, address, area, city, property_type')
    .or(`name.ilike.%${q}%,alias.ilike.%${q}%`)
    .order('name')
    .limit(8)

  if (error) return res.status(500).json({ error: error.message })
  res.json(data || [])
})

module.exports = router
