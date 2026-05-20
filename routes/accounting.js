const router = require('express').Router()
const auth   = require('../middleware/auth')

// GET /api/accounting/summary?period=2026-05
router.get('/summary', auth, async (req, res) => {
  const { period = new Date().toISOString().slice(0, 7) } = req.query
  const [y, m] = period.split('-')
  const from = `${y}-${m}-01`
  const to   = new Date(Number(y), Number(m), 0).toISOString().split('T')[0]

  // 이달 계약(수수료 수입)
  const { data: deals } = await req.supabase
    .from('deals')
    .select('gross_commission, total_agent_fees, net_company_income, contract_type')
    .gte('contract_date', from).lte('contract_date', to)

  // 이달 지출
  const { data: exps } = await req.supabase
    .from('expenses')
    .select('*')
    .eq('period', period)
    .order('date')

  const gross     = deals?.reduce((s, d) => s + Number(d.gross_commission), 0) || 0
  const agentFees = deals?.reduce((s, d) => s + Number(d.total_agent_fees), 0) || 0
  const netDeals  = deals?.reduce((s, d) => s + Number(d.net_company_income), 0) || 0
  const totalExp  = exps?.reduce((s, e) => s + Number(e.amount), 0) || 0
  const profit    = netDeals - totalExp

  // 지출 카테고리별 집계
  const byCategory = (exps || []).reduce((acc, e) => {
    acc[e.category] = (acc[e.category] || 0) + Number(e.amount)
    return acc
  }, {})

  res.json({
    period,
    income: { gross, agent_fees: agentFees, net_from_deals: netDeals, deal_count: deals?.length || 0 },
    expenses: { total: totalExp, by_category: byCategory, items: exps || [] },
    profit,
    deals: deals || []
  })
})

// GET /api/accounting/expenses?period=2026-05
router.get('/expenses', auth, async (req, res) => {
  const { period } = req.query
  let query = req.supabase.from('expenses').select('*').order('date', { ascending: false })
  if (period) query = query.eq('period', period)
  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// POST /api/accounting/expenses
router.post('/expenses', auth, async (req, res) => {
  const { category, description, amount, date } = req.body
  if (!category || !amount || !date) return res.status(400).json({ error: '분류·금액·날짜는 필수입니다' })

  const { data, error } = await req.supabase
    .from('expenses')
    .insert({ category, description, amount: Number(amount), date, created_by: req.user.id })
    .select()
    .single()
  if (error) return res.status(500).json({ error: error.message })
  res.status(201).json(data)
})

// DELETE /api/accounting/expenses/:id
router.delete('/expenses/:id', auth, async (req, res) => {
  const { error } = await req.supabase.from('expenses').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ message: '삭제 완료' })
})

// GET /api/accounting/pl  (월별 P&L 요약 - 최근 6개월)
router.get('/pl', auth, async (req, res) => {
  const { data, error } = await req.supabase.from('v_monthly_pl').select('*').limit(6)
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

module.exports = router
