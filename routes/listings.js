const router = require('express').Router()
const auth   = require('../middleware/auth')

// 연락처 프라이버시 마스킹 (소유주 연락처용)
function maskContact(contact, userId, isAdmin) {
  if (!contact) return null
  const canSee = isAdmin || contact.assigned_user_id === userId || contact.created_by === userId
  return canSee
    ? { ...contact, _private: false }
    : { ...contact, mobile: null, email: null, _private: true }
}

// GET /api/listings
router.get('/', auth, async (req, res) => {
  const { type, ptype, status, agent, q } = req.query
  let query = req.supabase
    .from('listings')
    .select(`*, assigned_user:users(id, name),
      listing_source:contacts(id, name, type, mobile, email, assigned_user_id, created_by)`)
    .order('created_at', { ascending: false })

  if (type)   query = query.eq('transaction_type', type.toUpperCase())
  if (ptype)  query = query.eq('property_type', ptype.toUpperCase())
  if (status) query = query.eq('status', status.toUpperCase())
  if (agent)  query = query.eq('assigned_user_id', agent)
  if (q)      query = query.ilike('name', `%${q}%`)

  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })

  const isAdmin = req.user.role === 'admin'
  const result  = (data || []).map(l => ({
    ...l,
    listing_source: maskContact(l.listing_source, req.user.id, isAdmin)
  }))
  res.json(result)
})

// GET /api/listings/:id
router.get('/:id', auth, async (req, res) => {
  const { data, error } = await req.supabase
    .from('listings')
    .select(`*, assigned_user:users(id, name),
      listing_source:contacts(id, name, type, mobile, email, platform, nationality, assigned_user_id, created_by)`)
    .eq('id', req.params.id)
    .single()
  if (error) return res.status(404).json({ error: '매물을 찾을 수 없습니다' })

  const isAdmin = req.user.role === 'admin'
  res.json({
    ...data,
    listing_source: maskContact(data.listing_source, req.user.id, isAdmin)
  })
})

// POST /api/listings
router.post('/', auth, async (req, res) => {
  const {
    transaction_type, property_type, name, unit_no, address, floor,
    area_sqm, bedrooms, bathrooms, parking, price,
    is_furnished, pet_friendly, listing_source_id, assigned_user_id,
    photo_url, photos, hyperlink, remarks
  } = req.body

  if (!transaction_type || !name) return res.status(400).json({ error: '거래유형과 매물명은 필수입니다' })

  const { data, error } = await req.supabase
    .from('listings')
    .insert({
      transaction_type, property_type, name, unit_no, address, floor,
      area_sqm, bedrooms, bathrooms, parking, price,
      is_furnished, pet_friendly,
      listing_source_id: listing_source_id || null,
      assigned_user_id: assigned_user_id || req.user.id,
      photo_url, photos: photos || [], hyperlink, remarks, status: 'ACTIVE'
    })
    .select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.status(201).json(data)
})

// PATCH /api/listings/:id
router.patch('/:id', auth, async (req, res) => {
  const allowed = [
    'transaction_type','property_type','name','unit_no','address','floor',
    'area_sqm','bedrooms','bathrooms','parking','price',
    'is_furnished','pet_friendly','listing_source_id','assigned_user_id',
    'photo_url','photos','hyperlink','remarks','status'
  ]
  const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)))
  updates.updated_at = new Date().toISOString()

  const { data, error } = await req.supabase
    .from('listings').update(updates).eq('id', req.params.id).select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

module.exports = router
