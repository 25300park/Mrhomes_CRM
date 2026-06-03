// routes/pms-care.js
// PMS 홈케어 신청 관리 API
// CRM admin/agent 전용

const router = require('express').Router()
const auth   = require('../middleware/auth')

// ── GET /api/pms-care
// 전체 홈케어 신청 목록
router.get('/', auth, async (req, res) => {
  try {
    const { status } = req.query

    let query = req.supabase
      .from('care_service_requests')
      .select(`
        *,
        deal:deals(
          id,
          listing:listings(id, name, unit_no, address),
          tenant_contact:contacts!deals_tenant_contact_id_fkey(id, name, mobile, email)
        )
      `)
      .order('created_at', { ascending: false })

    if (status && status !== 'ALL') {
      query = query.eq('status', status)
    }

    const { data, error } = await query
    if (error) return res.status(500).json({ error: error.message })
    res.json(data || [])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── PATCH /api/pms-care/:id/schedule
// 일정 확정 → SCHEDULED
router.patch('/:id/schedule', auth, async (req, res) => {
  try {
    const { scheduled_at, assigned_to } = req.body
    if (!scheduled_at) return res.status(400).json({ error: '확정 일시가 필요합니다.' })

    const { data, error } = await req.supabase
      .from('care_service_requests')
      .update({
        status:       'SCHEDULED',
        scheduled_at,
        assigned_to:  assigned_to || null,
        updated_at:   new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .eq('status', 'PENDING')
      .select()
      .single()

    if (error) return res.status(500).json({ error: error.message })
    if (!data)  return res.status(404).json({ error: '접수 상태의 신청만 확정할 수 있습니다.' })

    // 임차인 알림 전송
    await sendCareNotif(req.supabase, data, '홈케어 일정이 확정되었습니다 📅',
      `${new Date(scheduled_at).toLocaleString('ko-KR')}${assigned_to ? ' · 담당: ' + assigned_to : ''}`)

    res.json(data)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── PATCH /api/pms-care/:id/complete
// 완료 처리 → COMPLETED
router.patch('/:id/complete', auth, async (req, res) => {
  try {
    const { price } = req.body

    const { data, error } = await req.supabase
      .from('care_service_requests')
      .update({
        status:       'COMPLETED',
        completed_at: new Date().toISOString(),
        price:        price || null,
        updated_at:   new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .eq('status', 'SCHEDULED')
      .select()
      .single()

    if (error) return res.status(500).json({ error: error.message })
    if (!data)  return res.status(404).json({ error: '확정 상태의 신청만 완료 처리할 수 있습니다.' })

    // 임차인 알림
    await sendCareNotif(req.supabase, data, '홈케어 서비스가 완료되었습니다 ✅',
      price ? `서비스 금액: ₱${Number(price).toLocaleString('en-PH')}` : '서비스가 완료되었습니다.')

    res.json(data)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── PATCH /api/pms-care/:id/cancel
// 취소 처리 → CANCELLED
router.patch('/:id/cancel', auth, async (req, res) => {
  try {
    const { data, error } = await req.supabase
      .from('care_service_requests')
      .update({
        status:     'CANCELLED',
        updated_at: new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .in('status', ['PENDING', 'SCHEDULED'])
      .select()
      .single()

    if (error) return res.status(500).json({ error: error.message })
    if (!data)  return res.status(404).json({ error: '취소할 수 없는 상태입니다.' })

    res.json(data)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── 알림 헬퍼 ────────────────────────────────────────────────
async function sendCareNotif(supabase, careReq, title, body) {
  try {
    const { data: dealData } = await supabase
      .from('deals')
      .select('tenant_contact_id')
      .eq('id', careReq.deal_id)
      .single()

    if (!dealData?.tenant_contact_id) return

    const { data: authMap } = await supabase
      .from('pms_auth_map')
      .select('auth_uid')
      .eq('contact_id', dealData.tenant_contact_id)
      .single()

    if (!authMap?.auth_uid) return

    await supabase.from('pms_notifications').insert({
      auth_uid:     authMap.auth_uid,
      title,
      body,
      related_type: 'care',
      related_id:   careReq.id,
    })
  } catch (e) {
    console.error('Care notification error:', e.message)
  }
}

module.exports = router
