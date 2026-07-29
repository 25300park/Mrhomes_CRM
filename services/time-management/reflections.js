const { TimeManagementError } = require('./errors')
const { requireActiveTimeActor } = require('./access-policy')
const { businessDateAt, DEFAULT_BUSINESS_TIME_ZONE } = require('./time')
const { enqueueTimeJob } = require('./job-queue')

function databaseError() {
  return new TimeManagementError('DATABASE_ERROR', 'Reflection could not be completed.', 500)
}

async function findReflection({ supabase, userId, businessDate }) {
  const result = await supabase.from('time_reflections')
    .select('id, user_id, business_date, reflection_text, version, created_at, updated_at')
    .eq('user_id', userId).eq('business_date', businessDate).single()
  if (result.error?.code === 'PGRST116') return null
  if (result.error) throw databaseError()
  return result.data
}

async function saveReflection({ supabase, actor, input, now = new Date() }) {
  requireActiveTimeActor(actor)
  const businessDate = businessDateAt(now, DEFAULT_BUSINESS_TIME_ZONE)
  const current = await findReflection({ supabase, userId: actor.id, businessDate })
  let saved
  if (current) {
    const update = await supabase.from('time_reflections')
      .update({ reflection_text: input.reflectionText, version: current.version + 1 })
      .eq('id', current.id).eq('user_id', actor.id).select('*').single()
    if (update.error || !update.data) throw databaseError()
    saved = update.data
  } else {
    const insert = await supabase.from('time_reflections').insert({
      user_id: actor.id, business_date: businessDate, reflection_text: input.reflectionText
    }).select('*').single()
    if (insert.error || !insert.data) throw databaseError()
    saved = insert.data
  }
  const queued = await enqueueTimeJob({
    supabase,
    userId: actor.id,
    jobType: 'AI_REVIEW',
    dedupeKey: `${saved.id}:${saved.version}`,
    payload: { reflectionId: saved.id, reflectionVersion: saved.version }
  })
  return { reflection: saved, job: queued.job, jobDeduplicated: queued.deduplicated }
}

async function getReflection({ supabase, actor, businessDate }) {
  requireActiveTimeActor(actor)
  const reflection = await findReflection({ supabase, userId: actor.id, businessDate })
  if (!reflection) return { reflection: null, review: null }
  const reviewResult = await supabase.from('time_ai_reviews')
    .select('id, reflection_id, reflection_version, keywords, summary, wins, blockers, next_actions, created_at')
    .eq('reflection_id', reflection.id).eq('reflection_version', reflection.version).single()
  if (reviewResult.error && reviewResult.error.code !== 'PGRST116') throw databaseError()
  return { reflection, review: reviewResult.data || null }
}

async function getReflectionAiStatus({ supabase, actor, businessDate }) {
  requireActiveTimeActor(actor)
  const reflection = await findReflection({ supabase, userId: actor.id, businessDate })
  if (!reflection) return { status: 'NOT_STARTED' }
  const reviewResult = await supabase.from('time_ai_reviews')
    .select('id').eq('reflection_id', reflection.id).eq('reflection_version', reflection.version).single()
  if (reviewResult.error && reviewResult.error.code !== 'PGRST116') throw databaseError()
  if (reviewResult.data) return { status: 'COMPLETED' }
  const jobResult = await supabase.from('time_jobs').select('status')
    .eq('user_id', actor.id).eq('job_type', 'AI_REVIEW').eq('dedupe_key', `${reflection.id}:${reflection.version}`).single()
  if (jobResult.error?.code === 'PGRST116') return { status: 'PROCESSING' }
  if (jobResult.error) throw databaseError()
  return { status: jobResult.data?.status === 'FAILED' ? 'FAILED' : 'PROCESSING' }
}

module.exports = { findReflection, saveReflection, getReflection, getReflectionAiStatus }
