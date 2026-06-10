const router = require('express').Router()
const auth   = require('../middleware/auth')

// 커미션 계산 서비스 (DB 트리거와 동일 로직 - 프론트 실시간 계산용)
function calcCommission({ gross, contract_type, is_co_broke, owner_is_ext, tenant_is_ext }) {
  const company_share = is_co_broke ? gross * 0.5 : gross
  const rate          = contract_type === 'RENT' ? 0.10 : 0.15
  const owner_fee     = owner_is_ext  ? 0 : company_share * rate
  const tenant_fee    = tenant_is_ext ? 0 : company_share * rate
  const total_fees    = owner_fee + tenant_fee
  return { company_share, rate, owner_fee, tenant_fee, total_fees, net: company_share - total_fees }
}

// GET /api/deals/calculate  (실시간 계산 - 저장 전 프리뷰)
router.get('/calculate', auth, (req, res) => {
  const {
    gross = 0, contract_type = 'RENT',
    is_co_broke = false, owner_is_ext = false, tenant_is_ext = false
  } = req.query
  const result = calcCommission({
    gross: Number(gross),
    contract_type,
    is_co_broke: is_co_broke === 'true',
    owner_is_ext: owner_is_ext === 'true',
    tenant_is_ext: tenant_is_ext === 'true',
  })
  res.json(result)
})

// GET /api/deals  (계약 목록)
router.get('/', auth, async (req, res) => {
  const { period, type } = req.query
  let query = req.supabase
    .from('deals')
    .select(`
      *,
      listing:listings(id, code, name, transaction_type, property_type, status),
      owner_contact:contacts!deals_owner_contact_id_fkey(id, name),
      tenant_contact:contacts!deals_tenant_contact_id_fkey(id, name),
      owner_agent:users!deals_owner_agent_user_id_fkey(id, name),
      tenant_agent:users!deals_tenant_agent_user_id_fkey(id, name)
    `)
    .order('contract_date', { ascending: false })

  if (period) {
    const [y, m] = period.split('-')
    const from = `${y}-${m}-01`
    const to   = new Date(Number(y), Number(m), 0).toISOString().split('T')[0]
    query = query.gte('contract_date', from).lte('contract_date', to)
  }
  if (type) query = query.eq('contract_type', type.toUpperCase())

  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// GET /api/deals/:id
router.get('/:id', auth, async (req, res) => {
  const { data, error } = await req.supabase
    .from('deals')
    .select(`*, listing:listings(*), owner_contact:contacts!deals_owner_contact_id_fkey(*), tenant_contact:contacts!deals_tenant_contact_id_fkey(*), owner_agent:users!deals_owner_agent_user_id_fkey(id,name), tenant_agent:users!deals_tenant_agent_user_id_fkey(id,name)`)
    .eq('id', req.params.id)
    .single()
  if (error) return res.status(404).json({ error: '계약을 찾을 수 없습니다' })
  res.json(data)
})

// POST /api/deals  (계약 등록 → 커미션 자동 계산 + 매물 상태 변경)
router.post('/', auth, async (req, res) => {
  const {
    listing_id, contract_type, contract_date, move_in_date, contract_months,
    monthly_rent, sale_price, gross_commission,
    co_broke_rate,
    owner_contact_id, owner_agent_user_id, owner_agent_is_external,
    tenant_contact_id, tenant_agent_user_id, tenant_agent_is_external,
    is_co_broke, remarks
  } = req.body

  if (!listing_id || !contract_date)
    return res.status(400).json({ error: '매물과 계약일은 필수입니다' })
  // 수수료는 선택사항 — Admin이 나중에 설정 가능

  const { data: deal, error } = await req.supabase
    .from('deals')
    .insert({
      listing_id, contract_type, contract_date, move_in_date, contract_months,
      monthly_rent, sale_price, gross_commission,
      co_broke_rate: co_broke_rate || 0.50,
      owner_contact_id, owner_agent_user_id, owner_agent_is_external: !!owner_agent_is_external,
      tenant_contact_id, tenant_agent_user_id, tenant_agent_is_external: !!tenant_agent_is_external,
      is_co_broke: !!is_co_broke, remarks,
      created_by: req.user.id
    })
    .select()
    .single()
  if (error) return res.status(500).json({ error: error.message })

  // 매물 상태 → CONTRACTED 자동 변경
  await req.supabase
    .from('listings')
    .update({ status: 'CONTRACTED', updated_at: new Date().toISOString() })
    .eq('id', listing_id)

  res.status(201).json(deal)
})

// PATCH /api/deals/:id (상태·비고 수정 + 연동된 Listing 상태 자동 변경)
router.patch('/:id', auth, async (req, res) => {
  const { remarks, status, move_in_date, contract_months, monthly_rent } = req.body
  const updates = { updated_at: new Date().toISOString() }
  if (remarks         !== undefined) updates.remarks         = remarks
  if (status          !== undefined) updates.status          = status
  if (move_in_date    !== undefined) updates.move_in_date    = move_in_date
  if (contract_months !== undefined) updates.contract_months = contract_months
  if (monthly_rent    !== undefined) updates.monthly_rent    = monthly_rent

  const { data, error } = await req.supabase
    .from('deals').update(updates)
    .eq('id', req.params.id).select().single()
  if (error) return res.status(500).json({ error: error.message })

  // Deal 상태에 따른 Listing 상태 자동 동기화
  if (data.listing_id && status) {
    let listingStatus = null
    if (status === 'CANCELLED' || status === 'CLOSED_LOST') {
      listingStatus = 'ACTIVE'   // 계약 취소 → 매물 다시 활성화
    } else if (status === 'COMPLETED') {
      listingStatus = 'CLOSED'   // 계약 완료 → 매물 종료
    }
    if (listingStatus) {
      await req.supabase
        .from('listings')
        .update({ status: listingStatus, updated_at: new Date().toISOString() })
        .eq('id', data.listing_id)
    }
  }

  // RENT 계약 완료 시 rbs-homes LeaseContract 자동 생성
  if (status === 'COMPLETED' && data.listing_id) {
    try {
      const RBS_API_URL    = process.env.RBS_HOMES_URL
      const RBS_API_SECRET = process.env.RBS_SYNC_SECRET

      if (RBS_API_URL && RBS_API_SECRET) {
        // listing 조회해서 rbs_unit_id와 transaction_type 확인
        const { data: listing } = await req.supabase
          .from('listings')
          .select('rbs_unit_id, transaction_type')
          .eq('id', data.listing_id)
          .single()

        if (listing?.rbs_unit_id && listing?.transaction_type === 'RENT') {
          // move_in_date + contract_months로 endDate 계산
          const startDate = data.move_in_date
            ? new Date(data.move_in_date)
            : new Date()
          const endDate = new Date(startDate)
          endDate.setMonth(endDate.getMonth() + (data.contract_months || 12))

          const leaseResponse = await fetch(`http://54.254.24.249:3000/api/pms/leases`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${RBS_API_SECRET}`,
              'Host': 'rbs-homes.com'
            },
            body: JSON.stringify({
              unitId: listing.rbs_unit_id,
              landlordId: null,
              tenantId: null,
              startDate: startDate.toISOString(),
              endDate: endDate.toISOString(),
              monthlyRent: data.monthly_rent || 0,
              paymentType: 'MONTHLY_TRANSFER',
              crmDealId: data.id,
              notes: `CRM Deal 자동 연동 - ${data.remarks || ''}`
            })
          })

          if (leaseResponse.ok) {
            const leaseResult = await leaseResponse.json()
            // deals 테이블에 rbs_lease_id 저장 시도 (컬럼 없으면 무시)
            await req.supabase
              .from('deals')
              .update({ rbs_lease_id: leaseResult.leaseId })
              .eq('id', data.id)
              .then(() => {})
              .catch(() => {})
            console.log(`✅ LeaseContract 생성 완료: leaseId=${leaseResult.leaseId}`)
          } else {
            console.error('❌ LeaseContract 생성 실패:', await leaseResponse.text())
          }
        }
      }
    } catch (leaseErr) {
      console.error('❌ rbs-homes 연동 오류:', leaseErr.message, leaseErr.cause?.message, leaseErr.cause?.code)
    }
  }

  res.json(data)
})

// DELETE /api/deals/:id (계약 삭제 → 연동된 Listing ACTIVE 복귀)
router.delete('/:id', auth, async (req, res) => {
  const { data: deal } = await req.supabase
    .from('deals').select('listing_id').eq('id', req.params.id).single()

  const { error } = await req.supabase.from('deals').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })

  // 연동된 Listing → ACTIVE 복귀
  if (deal?.listing_id) {
    await req.supabase
      .from('listings')
      .update({ status: 'ACTIVE', updated_at: new Date().toISOString() })
      .eq('id', deal.listing_id)
  }
  res.json({ message: 'Deal deleted, listing reverted to Active' })
})

// GET /api/deals/summary/monthly  (월별 요약)
router.get('/summary/monthly', auth, async (req, res) => {
  const { data, error } = await req.supabase.from('v_monthly_pl').select('*')
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

module.exports = router
