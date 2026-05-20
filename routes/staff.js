const router = require('express').Router()
const auth   = require('../middleware/auth')

// GET /api/staff  (직원 목록)
router.get('/', auth, async (req, res) => {
  const { data, error } = await req.supabase
    .from('users')
    .select('id, name, email, role, work_mode, base_salary, is_active')
    .eq('role', 'agent')
    .eq('is_active', true)
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// GET /api/staff/performance?period=2026-05
router.get('/performance', auth, async (req, res) => {
  const { period = new Date().toISOString().slice(0, 7) } = req.query
  const [y, m] = period.split('-')
  const from = `${y}-${m}-01`
  const to   = new Date(Number(y), Number(m), 0).toISOString().split('T')[0]

  // 직원 기본 정보
  const { data: agents } = await req.supabase
    .from('users')
    .select('id, name, base_salary, work_mode')
    .eq('role', 'agent').eq('is_active', true)

  // 이달 계약
  const { data: deals } = await req.supabase
    .from('deals')
    .select('owner_agent_user_id, tenant_agent_user_id, owner_agent_fee, tenant_agent_fee, contract_type, contract_date, listings(name)')
    .gte('contract_date', from).lte('contract_date', to)

  // 활성 리드
  const { data: leads } = await req.supabase
    .from('leads')
    .select('assigned_user_id, status')
    .not('status', 'in', '("CLOSED_WON","CLOSED_LOST")')

  // 담당 매물
  const { data: listings } = await req.supabase
    .from('listings')
    .select('assigned_user_id, status')
    .not('status', 'eq', 'CLOSED')

  const result = agents?.map(ag => {
    const ownerDeals  = deals?.filter(d => d.owner_agent_user_id === ag.id) || []
    const tenantDeals = deals?.filter(d => d.tenant_agent_user_id === ag.id) || []
    const allDeals    = [...new Set([...ownerDeals, ...tenantDeals])]

    const owner_commission  = ownerDeals.reduce((s, d) => s + Number(d.owner_agent_fee || 0), 0)
    const tenant_commission = tenantDeals.reduce((s, d) => s + Number(d.tenant_agent_fee || 0), 0)
    const total_commission  = owner_commission + tenant_commission
    const total_payout      = ag.base_salary + total_commission

    return {
      ...ag,
      period,
      deal_count:        allDeals.length,
      owner_commission,
      tenant_commission,
      total_commission,
      total_payout,
      active_leads:      leads?.filter(l => l.assigned_user_id === ag.id).length || 0,
      active_listings:   listings?.filter(l => l.assigned_user_id === ag.id).length || 0,
      deals:             allDeals.map(d => ({
        property:        d.listings?.name,
        date:            d.contract_date,
        type:            d.contract_type,
        owner_fee:       d.owner_agent_user_id === ag.id ? d.owner_agent_fee : 0,
        tenant_fee:      d.tenant_agent_user_id === ag.id ? d.tenant_agent_fee : 0,
      }))
    }
  }) || []

  res.json(result)
})

// GET /api/staff/:id/deals?period=2026-05  (개인 계약 내역)
router.get('/:id/deals', auth, async (req, res) => {
  const { period } = req.query
  const [y, m] = (period || new Date().toISOString().slice(0,7)).split('-')
  const from = `${y}-${m}-01`
  const to   = new Date(Number(y), Number(m), 0).toISOString().split('T')[0]

  const { data, error } = await req.supabase
    .from('deals')
    .select(`*, listing:listings(code, name)`)
    .or(`owner_agent_user_id.eq.${req.params.id},tenant_agent_user_id.eq.${req.params.id}`)
    .gte('contract_date', from).lte('contract_date', to)
    .order('contract_date', { ascending: false })

  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

module.exports = router
