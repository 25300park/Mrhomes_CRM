const router = require('express').Router()
const auth   = require('../middleware/auth')

// ── GET /api/tenants  (RENT 계약 목록 + tenant_info) ───────
router.get('/', auth, async (req, res) => {
  const { data, error } = await req.supabase
    .from('deals')
    .select(`
      *,
      listing:listings(id, name, address, unit_no, property_type),
      tenant_contact:contacts!deals_tenant_contact_id_fkey(id, name, mobile, email, platform),
      lessor_contact:contacts!deals_owner_contact_id_fkey(id, name, mobile, email, platform),
      tenant_agent:users!deals_tenant_agent_user_id_fkey(id, name),
      owner_agent:users!deals_owner_agent_user_id_fkey(id, name),
      tenant_info(*)
    `)
    .eq('contract_type', 'RENT')
    .not('status', 'eq', 'CANCELLED')
    .order('contract_date', { ascending: false })

  if (error) return res.status(500).json({ error: error.message })
  res.json(data || [])
})

// ── GET /api/tenants/:dealId/requests ─────────────────────
router.get('/:dealId/requests', auth, async (req, res) => {
  const { data, error } = await req.supabase
    .from('tenant_requests')
    .select(`*, assigned_user:users!tenant_requests_assigned_to_fkey(id, name)`)
    .eq('deal_id', req.params.dealId)
    .order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  res.json(data || [])
})

// ── POST /api/tenants/:dealId/info  (추가정보 저장/수정) ───
router.post('/:dealId/info', auth, async (req, res) => {
  const { deposit, utility_payment_day, ac_cleaning_interval, ac_last_cleaned, notes } = req.body
  const dealId = req.params.dealId

  // ac_next_cleaning 자동 계산
  let ac_next_cleaning = null
  if (ac_last_cleaned && ac_cleaning_interval) {
    const d = new Date(ac_last_cleaned)
    d.setMonth(d.getMonth() + Number(ac_cleaning_interval))
    ac_next_cleaning = d.toISOString().split('T')[0]
  }

  const { data, error } = await req.supabase
    .from('tenant_info')
    .upsert({ deal_id: dealId, deposit, utility_payment_day, ac_cleaning_interval,
               ac_last_cleaned, ac_next_cleaning, notes, updated_at: new Date().toISOString() },
             { onConflict: 'deal_id' })
    .select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// ── POST /api/tenants/:dealId/requests  (요청 접수) ────────
router.post('/:dealId/requests', auth, async (req, res) => {
  const { type, title, description, requester, assigned_to } = req.body
  if (!type || !title) return res.status(400).json({ error: 'Type and title required' })

  const { data, error } = await req.supabase
    .from('tenant_requests')
    .insert({ deal_id: req.params.dealId, type, title, description,
               requester: requester || 'TENANT', assigned_to: assigned_to || null,
               status: 'PENDING' })
    .select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// ── PATCH /api/tenants/requests/:id  (요청 처리 결과 입력) ─
router.patch('/requests/:id', auth, async (req, res) => {
  const { status, result, assigned_to } = req.body
  const updates = { updated_at: new Date().toISOString() }
  if (status)      updates.status      = status
  if (result)      updates.result      = result
  if (assigned_to) updates.assigned_to = assigned_to
  if (status === 'COMPLETED') updates.resolved_at = new Date().toISOString()

  const { data, error } = await req.supabase
    .from('tenant_requests').update(updates).eq('id', req.params.id).select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// ── DELETE /api/tenants/requests/:id ───────────────────────
router.delete('/requests/:id', auth, async (req, res) => {
  const { error } = await req.supabase.from('tenant_requests').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ message: 'Deleted' })
})

module.exports = router
