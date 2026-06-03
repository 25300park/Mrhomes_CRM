// routes/pms-payments.js
// PMS 납부 영수증 검토 API
// CRM admin/agent 전용

const router = require('express').Router()
const auth   = require('../middleware/auth')

// ── GET /api/pms-payments
// 전체 납부 스케줄 목록 (검토 대기 우선 정렬)
router.get('/', auth, async (req, res) => {
  try {
    const { status, search } = req.query

    let query = req.supabase
      .from('payment_schedules')
      .select(`
        *,
        deal:deals(
          id,
          monthly_rent,
          contract_end_date,
          listing:listings(id, name, unit_no, address),
          tenant_contact:contacts!deals_tenant_contact_id_fkey(id, name, mobile, email),
          owner_contact:contacts!deals_owner_contact_id_fkey(id, name, mobile)
        )
      `)
      .order('status', { ascending: true })   // AWAITING_APPROVAL 우선
      .order('due_date', { ascending: false })

    if (status && status !== 'ALL') {
      query = query.eq('status', status)
    }

    const { data, error } = await query
    if (error) return res.status(500).json({ error: error.message })

    // 검색 필터 (임차인명 또는 유닛)
    let result = data || []
    if (search) {
      const s = search.toLowerCase()
      result = result.filter(p =>
        p.deal?.tenant_contact?.name?.toLowerCase().includes(s) ||
        p.deal?.listing?.name?.toLowerCase().includes(s) ||
        p.deal?.listing?.unit_no?.toLowerCase().includes(s)
      )
    }

    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── GET /api/pms-payments/stats
// 요약 통계
router.get('/stats', auth, async (req, res) => {
  try {
    const { data, error } = await req.supabase
      .from('payment_schedules')
      .select('status, amount_due')

    if (error) return res.status(500).json({ error: error.message })

    const stats = {
      awaiting:  0,
      paid:      0,
      overdue:   0,
      pending:   0,
      totalPaid: 0,
    }

    for (const p of data || []) {
      if (p.status === 'AWAITING_APPROVAL') stats.awaiting++
      else if (p.status === 'PAID')         { stats.paid++; stats.totalPaid += Number(p.amount_due) }
      else if (p.status === 'OVERDUE')      stats.overdue++
      else if (p.status === 'PENDING')      stats.pending++
    }

    res.json(stats)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── PATCH /api/pms-payments/:id/approve
// 영수증 승인 → PAID (admin 전용)
router.patch('/:id/approve', auth, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: '관리자만 승인할 수 있습니다.' })
  }

  try {
    const { data, error } = await req.supabase
      .from('payment_schedules')
      .update({
        status:      'PAID',
        verified_at: new Date().toISOString(),
        verified_by: req.user.id,
      })
      .eq('id', req.params.id)
      .eq('status', 'AWAITING_APPROVAL')  // 검토 대기 상태만 승인 가능
      .select()
      .single()

    if (error) return res.status(500).json({ error: error.message })
    if (!data)  return res.status(404).json({ error: '해당 납부 건을 찾을 수 없습니다.' })

    // PMS 임차인에게 알림 생성
    // pms_auth_map에서 auth_uid 조회 후 pms_notifications에 insert
    const { data: dealData } = await req.supabase
      .from('payment_schedules')
      .select('deal:deals(tenant_contact_id)')
      .eq('id', req.params.id)
      .single()

    if (dealData?.deal?.tenant_contact_id) {
      const { data: authMap } = await req.supabase
        .from('pms_auth_map')
        .select('auth_uid')
        .eq('contact_id', dealData.deal.tenant_contact_id)
        .single()

      if (authMap?.auth_uid) {
        await req.supabase.from('pms_notifications').insert({
          auth_uid:     authMap.auth_uid,
          title:        '납부가 확인되었습니다 ✅',
          body:         `${new Date(data.due_date).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long' })} 임대료 납부가 확인되었습니다.`,
          related_type: 'payment',
          related_id:   data.id,
        })
      }
    }

    res.json(data)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── PATCH /api/pms-payments/:id/reject
// 영수증 반려 → PENDING (admin 전용)
router.patch('/:id/reject', auth, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: '관리자만 반려할 수 있습니다.' })
  }

  try {
    const { reason } = req.body

    const { data, error } = await req.supabase
      .from('payment_schedules')
      .update({
        status:           'PENDING',
        receipt_image_url: null,
        receipt_notes:    reason ? `[반려] ${reason}` : '[반려됨]',
      })
      .eq('id', req.params.id)
      .eq('status', 'AWAITING_APPROVAL')
      .select()
      .single()

    if (error) return res.status(500).json({ error: error.message })
    if (!data)  return res.status(404).json({ error: '해당 납부 건을 찾을 수 없습니다.' })

    res.json(data)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

module.exports = router
