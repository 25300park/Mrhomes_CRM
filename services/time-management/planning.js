const { TimeManagementError } = require('./errors')
const { requireActiveTimeActor } = require('./access-policy')
const { businessDateAt, DEFAULT_BUSINESS_TIME_ZONE } = require('./time')

function databaseError(error) {
  if (error?.code === '42501') return new TimeManagementError('FORBIDDEN', '시간 계획에 접근할 수 없습니다.', 403)
  if (['23503', '23505', '22023'].includes(error?.code)) {
    return new TimeManagementError('INVALID_DAILY_PLAN', '시간 계획의 카테고리 또는 배분이 올바르지 않습니다.', 422)
  }
  return new TimeManagementError('DATABASE_ERROR', '시간 계획을 처리할 수 없습니다.', 500, { cause: error })
}

function calculatePlanVariance({ allocations = [], entries = [] }) {
  const planned = new Map()
  const trackedSeconds = new Map()
  for (const allocation of allocations) {
    const id = allocation.standardCategoryId ?? allocation.standard_category_id
    const minutes = allocation.plannedMinutes ?? allocation.planned_minutes ?? 0
    planned.set(id, (planned.get(id) || 0) + minutes)
  }
  for (const entry of entries) {
    const id = entry.standardCategoryId ?? entry.standard_category_id
    const seconds = entry.durationSeconds ?? entry.duration_seconds ?? 0
    trackedSeconds.set(id, (trackedSeconds.get(id) || 0) + seconds)
  }
  const categoryIds = new Set([...planned.keys(), ...trackedSeconds.keys()])
  let variance = 0
  for (const id of categoryIds) {
    variance += Math.abs((planned.get(id) || 0) - Math.round((trackedSeconds.get(id) || 0) / 60))
  }
  return variance
}

async function saveDailyPlan({ supabase, actor, input, now = new Date() }) {
  requireActiveTimeActor(actor)
  const businessDate = businessDateAt(now, DEFAULT_BUSINESS_TIME_ZONE)
  const { data, error } = await supabase.rpc('time_save_daily_plan', {
    p_user_id: actor.id,
    p_business_date: businessDate,
    p_available_minutes: input.availableMinutes,
    p_allocations: input.allocations
  })
  if (error) throw databaseError(error)
  const plan = Array.isArray(data) ? data[0] : data
  if (!plan) throw databaseError(new Error('Plan RPC returned no row'))
  const allocationTotal = input.allocations.reduce((sum, item) => sum + item.plannedMinutes, 0)
  return {
    plan,
    warning: allocationTotal === input.availableMinutes ? null : {
      code: 'ALLOCATION_TOTAL_MISMATCH',
      differenceMinutes: allocationTotal - input.availableMinutes
    }
  }
}

async function getDailyPlan({ supabase, actor, businessDate }) {
  requireActiveTimeActor(actor)
  const { data: plan, error } = await supabase.from('time_daily_plans')
    .select('id, user_id, business_date, available_minutes, is_completed, completed_at, created_at, updated_at')
    .eq('user_id', actor.id)
    .eq('business_date', businessDate)
    .single()
  if (error || !plan) {
    if (!error || error.code === 'PGRST116') return { plan: null, allocations: [], varianceMinutes: 0 }
    throw databaseError(error)
  }
  const [allocationResult, entryResult] = await Promise.all([
    supabase.from('time_plan_allocations')
      .select('id, daily_plan_id, standard_category_id, personal_category_id, planned_minutes')
      .eq('daily_plan_id', plan.id)
      .eq('user_id', actor.id)
      .order('created_at', { ascending: true }),
    supabase.from('time_entries')
      .select('standard_category_id, duration_seconds')
      .eq('user_id', actor.id)
      .eq('business_date', businessDate)
  ])
  if (allocationResult.error) throw databaseError(allocationResult.error)
  if (entryResult.error) throw databaseError(entryResult.error)
  const allocations = allocationResult.data || []
  const entries = (entryResult.data || []).filter(entry => entry.duration_seconds !== null)
  return { plan, allocations, varianceMinutes: calculatePlanVariance({ allocations, entries }) }
}

module.exports = { calculatePlanVariance, saveDailyPlan, getDailyPlan }
