const { TimeManagementError } = require('./errors')
const { requireActiveTimeActor, requireTimeAdmin } = require('./access-policy')
const { calculatePlanVariance } = require('./planning')

function analyticsDatabaseError(error) {
  return new TimeManagementError('DATABASE_ERROR', 'Time analytics could not be completed.', 500, { cause: error })
}

function completedEntries(entries = []) {
  return entries.filter(entry => Number.isInteger(entry.durationSeconds ?? entry.duration_seconds))
}

function isCoreWork(entry) {
  return entry.isCoreWork === true || entry.is_core_work === true || entry.is_focus === true || entry.time_standard_categories?.is_focus === true
}

function calculateDailyMetrics({ plan = null, allocations = [], entries = [], reflection = null } = {}) {
  const completed = completedEntries(entries)
  const totalSeconds = completed.reduce((total, entry) => total + (entry.durationSeconds ?? entry.duration_seconds), 0)
  const coreWorkSeconds = completed.filter(isCoreWork)
    .reduce((total, entry) => total + (entry.durationSeconds ?? entry.duration_seconds), 0)

  return {
    completion: {
      plan: plan?.isCompleted === true || plan?.is_completed === true,
      time: completed.length > 0,
      reflection: Boolean(reflection?.reflectionText?.trim?.() || reflection?.reflection_text?.trim?.())
    },
    planVarianceMinutes: calculatePlanVariance({ allocations, entries: completed }),
    coreWorkRatio: totalSeconds === 0 ? null : coreWorkSeconds / totalSeconds
  }
}

function requireRows(result) {
  if (result.error) throw analyticsDatabaseError(result.error)
  return result.data || []
}

async function getPersonalReview({ supabase, actor, businessDate }) {
  requireActiveTimeActor(actor)
  const planResult = await supabase.from('time_daily_plans')
    .select('id, user_id, business_date, available_minutes, is_completed, completed_at')
    .eq('user_id', actor.id).eq('business_date', businessDate).single()
  if (planResult.error && planResult.error.code !== 'PGRST116') throw analyticsDatabaseError(planResult.error)
  const plan = planResult.data || null
  const [allocationResult, entryResult, reflectionResult] = await Promise.all([
    plan
      ? supabase.from('time_plan_allocations').select('daily_plan_id, standard_category_id, planned_minutes')
        .eq('daily_plan_id', plan.id).eq('user_id', actor.id)
      : Promise.resolve({ data: [], error: null }),
    supabase.from('time_entries').select('standard_category_id, duration_seconds, ended_at, time_standard_categories(is_focus)')
      .eq('user_id', actor.id).eq('business_date', businessDate),
    supabase.from('time_reflections').select('id, user_id, business_date, reflection_text, version, created_at, updated_at')
      .eq('user_id', actor.id).eq('business_date', businessDate).single()
  ])
  const reflection = reflectionResult.error?.code === 'PGRST116' ? null : reflectionResult.data
  if (reflectionResult.error && reflectionResult.error.code !== 'PGRST116') throw analyticsDatabaseError(reflectionResult.error)
  const reviewResult = reflection
    ? await supabase.from('time_ai_reviews')
      .select('id, reflection_id, reflection_version, keywords, summary, wins, blockers, next_actions, created_at')
      .eq('reflection_id', reflection.id).eq('reflection_version', reflection.version).eq('user_id', actor.id).single()
    : { data: null, error: null }
  if (reviewResult.error && reviewResult.error.code !== 'PGRST116') throw analyticsDatabaseError(reviewResult.error)
  return {
    metrics: calculateDailyMetrics({ plan, allocations: requireRows(allocationResult), entries: requireRows(entryResult), reflection }),
    reflection,
    review: reviewResult.data || null
  }
}

function publicMetrics(metrics) {
  return {
    completion: { plan: metrics.completion.plan, time: metrics.completion.time },
    planVarianceMinutes: metrics.planVarianceMinutes,
    coreWorkRatio: metrics.coreWorkRatio
  }
}

async function getAdminMemberSummaries({ supabase, actor, businessDate }) {
  requireTimeAdmin(actor)
  const users = requireRows(await supabase.from('users').select('id, name').eq('is_active', true))
  if (users.length === 0) return []
  const userIds = users.map(user => user.id)
  const [plansResult, entriesResult] = await Promise.all([
    supabase.from('time_daily_plans').select('id, user_id, business_date, is_completed')
      .in('user_id', userIds).eq('business_date', businessDate),
    supabase.from('time_entries').select('user_id, business_date, standard_category_id, duration_seconds, time_standard_categories(is_focus)')
      .in('user_id', userIds).eq('business_date', businessDate)
  ])
  const plans = requireRows(plansResult)
  const planIds = plans.map(plan => plan.id)
  const allocations = planIds.length === 0 ? [] : requireRows(await supabase.from('time_plan_allocations')
    .select('daily_plan_id, standard_category_id, planned_minutes').in('daily_plan_id', planIds))
  const plansByUser = new Map(plans.map(plan => [plan.user_id, plan]))
  const allocationsByPlan = new Map()
  for (const allocation of allocations) {
    const list = allocationsByPlan.get(allocation.daily_plan_id) || []
    list.push(allocation)
    allocationsByPlan.set(allocation.daily_plan_id, list)
  }
  const entriesByUser = new Map()
  for (const entry of requireRows(entriesResult)) {
    const list = entriesByUser.get(entry.user_id) || []
    list.push(entry)
    entriesByUser.set(entry.user_id, list)
  }
  return users.map(user => {
    const plan = plansByUser.get(user.id) || null
    const metrics = calculateDailyMetrics({
      plan,
      allocations: plan ? allocationsByPlan.get(plan.id) || [] : [],
      entries: entriesByUser.get(user.id) || []
    })
    return { user: { id: user.id, name: user.name }, metrics: publicMetrics(metrics) }
  })
}

function normalizeKeyword(keyword) {
  return typeof keyword === 'string' ? keyword.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US') : ''
}

async function aggregateTeamKeywords({ supabase, actor, periodStart, periodEnd }) {
  requireTimeAdmin(actor)
  const users = requireRows(await supabase.from('users').select('id').eq('is_active', true))
  const activeUserIds = new Set(users.map(user => user.id))
  const reflections = requireRows(await supabase.from('time_reflections').select('id, user_id, business_date, version')
    .gte('business_date', periodStart).lte('business_date', periodEnd))
    .filter(reflection => activeUserIds.has(reflection.user_id))
  const reflectionById = new Map(reflections.map(reflection => [reflection.id, reflection]))
  const reviews = reflections.length === 0 ? [] : requireRows(await supabase.from('time_ai_reviews')
    .select('reflection_id, user_id, reflection_version, keywords').in('reflection_id', reflections.map(reflection => reflection.id)))
  const keywords = new Map()
  const contributorIds = new Set()
  for (const review of reviews) {
    const reflection = reflectionById.get(review.reflection_id)
    if (!reflection || reflection.user_id !== review.user_id || reflection.version !== review.reflection_version || !activeUserIds.has(review.user_id)) continue
    const normalizedKeywords = (Array.isArray(review.keywords) ? review.keywords : []).map(normalizeKeyword).filter(Boolean)
    if (normalizedKeywords.length === 0) continue
    contributorIds.add(review.user_id)
    for (const keyword of normalizedKeywords) {
      const aggregate = keywords.get(keyword) || { contributors: new Set(), occurrenceCount: 0 }
      aggregate.contributors.add(review.user_id)
      aggregate.occurrenceCount += 1
      keywords.set(keyword, aggregate)
    }
  }
  if (contributorIds.size < 3) return { status: 'INSUFFICIENT_DATA', contributorCount: contributorIds.size, keywords: [] }
  const aggregates = [...keywords.entries()]
    .map(([keyword, aggregate]) => ({ keyword, contributorCount: aggregate.contributors.size, occurrenceCount: aggregate.occurrenceCount }))
    .filter(aggregate => aggregate.contributorCount >= 3)
    .sort((left, right) => left.keyword.localeCompare(right.keyword))
  if (aggregates.length > 0) {
    const rows = aggregates.map(({ keyword, contributorCount, occurrenceCount }) => ({
      period_start: periodStart,
      period_end: periodEnd,
      keyword,
      contributor_count: contributorCount,
      occurrence_count: occurrenceCount
    }))
    const write = await supabase.from('time_team_keyword_aggregates').upsert(rows, {
      onConflict: 'period_start,period_end,keyword'
    })
    if (write.error) throw analyticsDatabaseError(write.error)
  }
  return { status: 'OK', contributorCount: contributorIds.size, keywords: aggregates }
}

module.exports = { calculateDailyMetrics, getPersonalReview, getAdminMemberSummaries, aggregateTeamKeywords, normalizeKeyword }
