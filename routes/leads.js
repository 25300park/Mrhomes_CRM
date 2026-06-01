const router = require('express').Router()
const auth   = require('../middleware/auth')

// GET /api/leads  (리드 파이프라인)
router.get('/', auth, async (req, res) => {
  const { status, agent, type, followup_today, contact_id } = req.query
  let query = req.supabase
    .from('leads')
    .select(`*, contact:contacts(id, name, nickname, mobile, type), assigned_user:users(id, name)`)
    .order('next_followup_at', { ascending: true })

  if (status)         query = query.eq('status', status)
  if (agent)          query = query.eq('assigned_user_id', agent)
  if (type)           query = query.eq('request_type', type.toUpperCase())
  if (contact_id)     query = query.eq('contact_id', contact_id)
  if (followup_today === 'true') {
    const today = new Date().toISOString().split('T')[0]
    query = query.lte('next_followup_at', today).not('status', 'in', '("CLOSED_WON","CLOSED_LOST")')
  }

  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// GET /api/leads/followup  (오늘 팔로업 필요 목록)
router.get('/followup', auth, async (req, res) => {
  const { data, error } = await req.supabase.from('v_leads_followup').select('*')
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// GET /api/leads/:id
router.get('/:id', auth, async (req, res) => {
  const { data, error } = await req.supabase
    .from('leads')
    .select(`*, contact:contacts(*), assigned_user:users(id,name), activities(*)`)
    .eq('id', req.params.id)
    .single()
  if (error) return res.status(404).json({ error: '리드를 찾을 수 없습니다' })
  res.json(data)
})

// POST /api/leads
router.post('/', auth, async (req, res) => {
  const {
    contact_id, request_type, property_type, budget, location_pref,
    bedrooms_min, bedrooms_max, area_min, area_max,
    is_furnished, pet_allowed, target_move_in,
    assigned_user_id, next_followup_at, remarks
  } = req.body
  if (!contact_id || !request_type) return res.status(400).json({ error: '고객과 요청유형은 필수입니다' })

  const { data, error } = await req.supabase
    .from('leads')
    .insert({
      contact_id, request_type, property_type, budget, location_pref,
      bedrooms_min, bedrooms_max, area_min, area_max,
      is_furnished, pet_allowed, target_move_in,
      assigned_user_id: assigned_user_id || req.user.id,
      next_followup_at, remarks, status: 'NEW'
    })
    .select()
    .single()
  if (error) return res.status(500).json({ error: error.message })
  res.status(201).json(data)
})

// PATCH /api/leads/:id  (상태 변경·팔로업 업데이트)
router.patch('/:id', auth, async (req, res) => {
  const allowed = [
    'status','budget','location_pref','assigned_user_id','request_type',
    'next_followup_at','remarks','closed_reason','move_in_date','property_type',
    'bedrooms_min','bedrooms_max','area_min','area_max',
    'parking_required','pet_allowed','pdc_available',
    'view_preference','preferred_buildings'
  ]
  const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)))
  updates.updated_at = new Date().toISOString()

  const { data, error } = await req.supabase
    .from('leads').update(updates).eq('id', req.params.id).select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// POST /api/leads/:id/activity  (활동 기록 추가)
router.post('/:id/activity', auth, async (req, res) => {
  const { type, result_code, notes, next_followup_at, listing_id } = req.body
  const lead = await req.supabase.from('leads').select('contact_id').eq('id', req.params.id).single()

  const { data, error } = await req.supabase
    .from('activities')
    .insert({
      type, result_code, notes,
      lead_id: req.params.id,
      contact_id: lead.data?.contact_id,
      listing_id,
      next_followup_at,
      created_by: req.user.id
    })
    .select()
    .single()
  if (error) return res.status(500).json({ error: error.message })

  // 팔로업 날짜 업데이트
  if (next_followup_at) {
    await req.supabase.from('leads')
      .update({ next_followup_at, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
  }
  res.status(201).json(data)
})

module.exports = router
