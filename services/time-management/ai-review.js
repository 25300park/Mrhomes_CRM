const { z } = require('zod')
const { calculatePlanVariance } = require('./planning')

const dailyReviewSchema = z.object({
  keywords: z.array(z.string().min(1)).min(1).max(7),
  summary: z.string().min(1).max(500),
  wins: z.array(z.string()).max(3),
  blockers: z.array(z.string()).max(3),
  nextActions: z.array(z.string()).min(1).max(3)
})

const reviewInputSchema = z.object({
  reflectionText: z.string().min(1),
  planVsActual: z.object({
    plannedMinutes: z.number().int().min(0),
    trackedMinutes: z.number().int().min(0),
    varianceMinutes: z.number().int().min(0)
  }).strict()
}).strict()

function safeProviderError() {
  return new Error('AI review could not be generated.')
}

async function generateAiReview({ provider, reflectionText, planVsActual }) {
  const input = reviewInputSchema.parse({ reflectionText, planVsActual })
  let response
  try {
    response = await provider.review(input)
  } catch (_error) {
    throw safeProviderError()
  }
  try {
    return dailyReviewSchema.parse(response)
  } catch (_error) {
    throw safeProviderError()
  }
}

function createOpenAiReviewProvider({ apiKey, fetchImpl = globalThis.fetch, model = process.env.TIME_AI_REVIEW_MODEL || 'gpt-4.1-mini' } = {}) {
  return {
    async review({ reflectionText, planVsActual }) {
      if (!apiKey || typeof fetchImpl !== 'function') throw safeProviderError()
      const response = await fetchImpl('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          store: false,
          input: [{ role: 'user', content: `Reflection:\n${reflectionText}\n\nPlan vs actual:\n${JSON.stringify(planVsActual)}` }],
          text: { format: { type: 'json_schema', name: 'daily_review', strict: true, schema: {
            type: 'object', additionalProperties: false,
            required: ['keywords', 'summary', 'wins', 'blockers', 'nextActions'],
            properties: {
              keywords: { type: 'array', minItems: 1, maxItems: 7, items: { type: 'string', minLength: 1 } },
              summary: { type: 'string', minLength: 1, maxLength: 500 },
              wins: { type: 'array', maxItems: 3, items: { type: 'string' } },
              blockers: { type: 'array', maxItems: 3, items: { type: 'string' } },
              nextActions: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string' } }
            }
          } } }
        })
      })
      if (!response.ok) throw safeProviderError()
      const body = await response.json()
      if (typeof body.output_text !== 'string') throw safeProviderError()
      try { return JSON.parse(body.output_text) } catch (_error) { throw safeProviderError() }
    }
  }
}

async function getPlanVsActual({ supabase, userId, businessDate }) {
  const planResult = await supabase.from('time_daily_plans').select('id, available_minutes')
    .eq('user_id', userId).eq('business_date', businessDate).single()
  if (planResult.error && planResult.error.code !== 'PGRST116') throw safeProviderError()
  const [allocationResult, entryResult] = await Promise.all([
    planResult.data
      ? supabase.from('time_plan_allocations').select('standard_category_id, planned_minutes')
        .eq('daily_plan_id', planResult.data.id).eq('user_id', userId)
      : Promise.resolve({ data: [], error: null }),
    supabase.from('time_entries').select('standard_category_id, duration_seconds').eq('user_id', userId).eq('business_date', businessDate)
  ])
  if (allocationResult.error || entryResult.error) throw safeProviderError()
  const allocations = allocationResult.data || []
  const entries = (entryResult.data || []).filter(entry => entry.duration_seconds !== null)
  return {
    plannedMinutes: allocations.reduce((total, item) => total + item.planned_minutes, 0),
    trackedMinutes: Math.round(entries.reduce((total, item) => total + item.duration_seconds, 0) / 60),
    varianceMinutes: calculatePlanVariance({ allocations, entries })
  }
}

async function retryAiReview({ supabase, job, provider }) {
  const payload = job.payload || {}
  const reflectionResult = await supabase.from('time_reflections')
    .select('id, user_id, business_date, reflection_text, version')
    .eq('id', payload.reflectionId).eq('user_id', job.user_id).eq('version', payload.reflectionVersion).single()
  if (reflectionResult.error || !reflectionResult.data) throw safeProviderError()
  const reflection = reflectionResult.data
  const review = await generateAiReview({
    provider,
    reflectionText: reflection.reflection_text,
    planVsActual: await getPlanVsActual({ supabase, userId: reflection.user_id, businessDate: reflection.business_date })
  })
  const saved = await supabase.from('time_ai_reviews').insert({
    reflection_id: reflection.id,
    user_id: reflection.user_id,
    reflection_version: reflection.version,
    keywords: review.keywords,
    summary: review.summary,
    wins: review.wins,
    blockers: review.blockers,
    next_actions: review.nextActions
  }).select('id').single()
  if (saved.error) {
    if (saved.error.code !== '23505') throw safeProviderError()
    const existing = await supabase.from('time_ai_reviews').select('id')
      .eq('reflection_id', reflection.id).eq('reflection_version', reflection.version).single()
    if (existing.error || !existing.data) throw safeProviderError()
    return { reviewId: existing.data.id, deduplicated: true }
  }
  return { reviewId: saved.data.id, deduplicated: false }
}

module.exports = { dailyReviewSchema, generateAiReview, createOpenAiReviewProvider, getPlanVsActual, retryAiReview }
