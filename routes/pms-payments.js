// routes/pms-payments.js (v2)
// payment_schedules 자동 생성 + 조회/승인/반려

const router = require('express').Router()
const auth   = require('../middleware/auth')

// ── GET /api/pms-payments
router.get('/', auth, async (req, res) => {
  try {
    const { status } = req.query
    let query = req.supabase
      .from('payment_schedules')
      .select(`
        *,
        deal:deals(
          id, monthly_rent, contract_end_date,
          listing:listings(id, name, unit_no, address),
          tenant_contact:contacts!deals_tenant_contact_id_fkey(id, name, mobile, email),
          owner_contact:contacts!deals_owner_contact_id_fkey(id, name, mobile)
        )
      `)
      .order('status', { ascending: true })
      .order('due_date', { ascending: false })

    if (status && status !== 'ALL') query = query.eq('status', status)
    const { data, error } = await query
    if (error) return res.status(500).json({ error: error.message })
    res.json(data || [])
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── GET /api/pms-payments/stats
router.get('/stats', auth, async (req, res) => {
  try {
    const { data, error } = await req.supabase
      .from('payment_schedules').select('status, amount_due')
    if (error) return res.status(500).json({ error: error.message })
    const stats = { awaiting: 0, paid: 0, overdue: 0, pending: 0, totalPaid: 0 }
    for (const p of data || []) {
      if (p.status === 'AWAITING_APPROVAL') stats.awaiting++
      else if (p.status === 'PAID')         { stats.paid++; stats.totalPaid += Number(p.amount_due) }
      else if (p.status === 'OVERDUE')      stats.overdue++
      else if (p.status === 'PENDING')      stats.pending++
    }
    res.json(stats)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── GET /api/pms-payments/deal/:dealId
// 특정 계약의 납부 스케줄 전체 조회
router.get('/deal/:dealId', auth, async (req, res) => {
  try {
    const { data, error } = await req.supabase
      .from('payment_schedules')
      .select('*')
      .eq('deal_id', req.params.dealId)
      .order('due_date', { ascending: true })
    if (error) return res.status(500).json({ error: error.message })
    res.json(data || [])
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── POST /api/pms-payments/generate/:dealId
// 납부 스케줄 자동 생성 (계약 기간 전체)
router.post('/generate/:dealId', auth, async (req, res) => {
  try {
    const { data: deal, error: dealError } = await req.supabase
      .from('deals')
      .select('id, move_in_date, contract_months, monthly_rent, payment_type, tenant_info(*)')
      .eq('id', req.params.dealId)
      .single()

    if (dealError || !deal) return res.status(404).json({ error: '계약 정보를 찾을 수 없습니다.' })
    if (!deal.move_in_date || !deal.contract_months) {
      return res.status(400).json({ error: 'Move-in date와 Contract months를 먼저 입력해주세요.' })
    }

    // 기존 스케줄 확인
    const { data: existing } = await req.supabase
      .from('payment_schedules')
      .select('id')
      .eq('deal_id', deal.id)

    if (existing && existing.length > 0) {
      return res.status(400).json({ error: `이미 ${existing.length}건의 납부 스케줄이 존재합니다. 삭제 후 재생성하세요.` })
    }

    // 납부일 계산 (기본: 매월 5일, utility_payment_day 우선)
    const payDay = deal.tenant_info?.utility_payment_day || 5
    const moveIn = new Date(deal.move_in_date)
    const schedules = []

    for (let i = 0; i < deal.contract_months; i++) {
      const dueDate = new Date(moveIn)
      dueDate.setMonth(dueDate.getMonth() + i)
      dueDate.setDate(payDay)

      schedules.push({
        deal_id:    deal.id,
        due_date:   dueDate.toISOString().slice(0, 10),
        amount_due: deal.monthly_rent,
        status:     'PENDING',
      })
    }

    const { data: created, error: insertError } = await req.supabase
      .from('payment_schedules')
      .insert(schedules)
      .select()

    if (insertError) return res.status(500).json({ error: insertError.message })
    res.json({ created: created.length, schedules: created })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── DELETE /api/pms-payments/deal/:dealId
// 특정 계약의 납부 스케줄 전체 삭제 (PENDING만)
router.delete('/deal/:dealId', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '관리자만 삭제할 수 있습니다.' })
  try {
    const { error } = await req.supabase
      .from('payment_schedules')
      .delete()
      .eq('deal_id', req.params.dealId)
      .in('status', ['PENDING', 'OVERDUE'])
    if (error) return res.status(500).json({ error: error.message })
    res.json({ message: '삭제 완료' })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── PATCH /api/pms-payments/:id/approve
router.patch('/:id/approve', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '관리자만 승인할 수 있습니다.' })
  try {
    const { data, error } = await req.supabase
      .from('payment_schedules')
      .update({ status: 'PAID', verified_at: new Date().toISOString(), verified_by: req.user.id })
      .eq('id', req.params.id)
      .eq('status', 'AWAITING_APPROVAL')
      .select().single()

    if (error) return res.status(500).json({ error: error.message })
    if (!data)  return res.status(404).json({ error: '해당 납부 건을 찾을 수 없습니다.' })

    // 임차인 알림
    const { data: ps } = await req.supabase
      .from('payment_schedules')
      .select('deal:deals(tenant_contact_id)')
      .eq('id', req.params.id).single()

    if (ps?.deal?.tenant_contact_id) {
      const { data: authMap } = await req.supabase
        .from('pms_auth_map').select('auth_uid')
        .eq('contact_id', ps.deal.tenant_contact_id).single()
      if (authMap?.auth_uid) {
        await req.supabase.from('pms_notifications').insert({
          auth_uid:     authMap.auth_uid,
          title:        '납부가 확인되었습니다 ✅',
          body:         `${new Date(data.due_date).toLocaleDateString('ko-KR', { year:'numeric', month:'long' })} 임대료 납부가 확인되었습니다.`,
          related_type: 'payment',
          related_id:   data.id,
        })
      }
    }
    res.json(data)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── PATCH /api/pms-payments/:id/reject
router.patch('/:id/reject', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '관리자만 반려할 수 있습니다.' })
  try {
    const { reason } = req.body
    const { data, error } = await req.supabase
      .from('payment_schedules')
      .update({ status: 'PENDING', receipt_image_url: null, receipt_notes: reason ? `[반려] ${reason}` : '[반려됨]' })
      .eq('id', req.params.id).eq('status', 'AWAITING_APPROVAL')
      .select().single()
    if (error) return res.status(500).json({ error: error.message })
    if (!data)  return res.status(404).json({ error: '해당 납부 건을 찾을 수 없습니다.' })
    res.json(data)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

module.exports = router
