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
    'is_furnished','furnished_type','pet_friendly','listing_source_id','assigned_user_id',
    'photo_url','photos','hyperlink','remarks','status'
  ]
  const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)))
  updates.updated_at = new Date().toISOString()

  const { data, error } = await req.supabase
    .from('listings').update(updates).eq('id', req.params.id).select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// DELETE /api/listings/:id
router.delete('/:id', auth, async (req, res) => {
  // 입력자 또는 admin만 삭제 가능
  const { data: listing } = await req.supabase
    .from('listings').select('assigned_user_id').eq('id', req.params.id).single()
  if (!listing) return res.status(404).json({ error: 'Not found' })
  if (req.user.role !== 'admin' && listing.assigned_user_id !== req.user.id)
    return res.status(403).json({ error: 'Permission denied' })

  const { error } = await req.supabase.from('listings').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ message: 'Deleted' })
})

// POST /api/listings/:id/publish  (rbs-homes.com 에 퍼블리시)
router.post('/:id/publish', auth, async (req, res) => {
  const RBS_API_URL    = process.env.RBS_HOMES_URL    // e.g. https://rbs-homes.com
  const RBS_API_SECRET = process.env.RBS_SYNC_SECRET  // 공유 시크릿

  if (!RBS_API_URL || !RBS_API_SECRET) {
    return res.status(500).json({ error: 'RBS_HOMES_URL or RBS_SYNC_SECRET not configured' })
  }

  // 매물 정보 조회
  const { data: listing, error } = await req.supabase
    .from('listings')
    .select('*')
    .eq('id', req.params.id)
    .single()

  if (error || !listing) return res.status(404).json({ error: 'Listing not found' })

  try {
    const payload = {
      crm_listing_id:   listing.id,
      rbs_unit_id:      listing.rbs_unit_id || null,
      title:            listing.name,
      transaction_type: listing.transaction_type,
      property_type:    listing.property_type,
      address:          listing.address,
      unit_no:          listing.unit_no,
      area_sqm:         listing.area_sqm,
      floor:            listing.floor,
      bedrooms:         listing.bedrooms,
      bathrooms:        listing.bathrooms,
      parking:          listing.parking,
      furnished_type:   listing.furnished_type,
      pet_friendly:     listing.pet_friendly,
      price:            listing.price,
      remarks:          listing.remarks,
      photo_url:        listing.photo_url,
      photos:           listing.photos || [],
    }

    const response = await fetch(`${RBS_API_URL}/api/sync-unit`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${RBS_API_SECRET}`
      },
      body: JSON.stringify(payload)
    })

    const result = await response.json()
    if (!response.ok) throw new Error(result.error || 'Publish failed')

    // CRM listing 업데이트 (퍼블리시 상태 저장)
    await req.supabase
      .from('listings')
      .update({
        is_published: true,
        rbs_unit_id:  result.rbs_unit_id,
        published_at: new Date().toISOString()
      })
      .eq('id', req.params.id)

    res.json({
      success:     true,
      rbs_unit_id: result.rbs_unit_id,
      message:     result.message,
      url:         `${RBS_API_URL}/detail/${result.rbs_unit_id}`
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/listings/:id/publish  (rbs-homes.com 에서 내리기)
router.delete('/:id/publish', auth, async (req, res) => {
  const RBS_API_URL    = process.env.RBS_HOMES_URL
  const RBS_API_SECRET = process.env.RBS_SYNC_SECRET

  const { data: listing } = await req.supabase
    .from('listings').select('rbs_unit_id').eq('id', req.params.id).single()

  if (!listing?.rbs_unit_id) return res.status(400).json({ error: 'Not published yet' })

  try {
    const response = await fetch(`${RBS_API_URL}/api/sync-unit`, {
      method:  'DELETE',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RBS_API_SECRET}` },
      body:    JSON.stringify({ rbs_unit_id: listing.rbs_unit_id })
    })

    if (!response.ok) throw new Error('Unpublish failed')

    await req.supabase
      .from('listings')
      .update({ is_published: false, published_at: null })
      .eq('id', req.params.id)

    res.json({ success: true, message: 'Unpublished from rbs-homes.com' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
