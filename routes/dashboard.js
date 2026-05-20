const router = require('express').Router()
const auth   = require('../middleware/auth')

// GET /api/dashboard  (메인 대시보드 전체 데이터 한 번에)
router.get('/', auth, async (req, res) => {
  const today  = new Date().toISOString().split('T')[0]
  const period = today.slice(0, 7)
  const [y, m] = period.split('-')
  const from   = `${y}-${m}-01`
  const to     = new Date(Number(y), Number(m), 0).toISOString().split('T')[0]

  const [
    { data: kpiDeals },
    { data: kpiExp },
    { data: followup },
    { data: activeListings },
    { data: recentDeals },
    { data: staffPerf },
    { data: pipelineCounts },
  ] = await Promise.all([
    // 이달 계약 KPI
    req.supabase.from('deals')
      .select('gross_commission, total_agent_fees, net_company_income')
      .gte('contract_date', from).lte('contract_date', to),
    // 이달 지출
    req.supabase.from('expenses').select('amount').eq('period', period),
    // 오늘 팔로업 필요
    req.supabase.from('v_leads_followup').select('*'),
    // 활동중 매물
    req.supabase.from('listings')
      .select('id, code, name, transaction_type, property_type, price, status, assigned_user:users(name)')
      .eq('status', 'ACTIVE').limit(10),
    // 최근 계약 3건
    req.supabase.from('deals')
      .select(`id, contract_date, contract_type, gross_commission, net_company_income, is_co_broke,
               listing:listings(name), owner_agent:users!deals_owner_agent_user_id_fkey(name), tenant_agent:users!deals_tenant_agent_user_id_fkey(name)`)
      .order('contract_date', { ascending: false }).limit(5),
    // 직원별 이달 커미션
    req.supabase.from('v_staff_commission_monthly')
      .select('*').eq('period', period),
    // 파이프라인 단계별 건수
    req.supabase.from('leads')
      .select('status')
      .not('status', 'in', '("CLOSED_WON","CLOSED_LOST")'),
  ])

  const gross  = kpiDeals?.reduce((s, d) => s + Number(d.gross_commission), 0) || 0
  const fees   = kpiDeals?.reduce((s, d) => s + Number(d.total_agent_fees), 0) || 0
  const net    = kpiDeals?.reduce((s, d) => s + Number(d.net_company_income), 0) || 0
  const exp    = kpiExp?.reduce((s, e) => s + Number(e.amount), 0) || 0

  const pipeline = {}
  ;['NEW','SEARCHING','OFFER_SENT','NEGOTIATING'].forEach(s => {
    pipeline[s] = pipelineCounts?.filter(l => l.status === s).length || 0
  })

  res.json({
    kpi: {
      gross_commission: gross,
      agent_fees: fees,
      net_income: net,
      expenses: exp,
      operating_profit: net - exp,
      deal_count: kpiDeals?.length || 0,
    },
    followup_needed: followup || [],
    active_listings: activeListings || [],
    recent_deals:    recentDeals || [],
    staff:           staffPerf || [],
    pipeline,
  })
})

module.exports = router
