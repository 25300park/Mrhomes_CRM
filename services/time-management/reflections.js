const { TimeManagementError } = require('./errors')
const { requireActiveTimeActor } = require('./access-policy')
const { businessDateAt, DEFAULT_BUSINESS_TIME_ZONE } = require('./time')
const { enqueueTimeJob } = require('./job-queue')

function databaseError() {
  return new TimeManagementError('DATABASE_ERROR', 'Reflection could not be completed.', 500)
}

function aiState(job) {
  return job?.status === 'FAILED'
    ? { status: 'FAILED', retryable: true }
    : { status: 'PROCESSING', retryable: false }
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
  try {
    const queued = await enqueueTimeJob({
      supabase,
      userId: actor.id,
      jobType: 'AI_REVIEW',
      dedupeKey: `${saved.id}:${saved.version}`,
      payload: { reflectionId: saved.id, reflectionVersion: saved.version }
    })
    return { reflection: saved, job: queued.job, jobDeduplicated: queued.deduplicated, ai: aiState(queued.job) }
  } catch (_error) {
    // The reflection write is already durable; make the independently failed AI enqueue retryable.
    return { reflection: saved, job: null, jobDeduplicated: false, ai: { status: 'FAILED', retryable: true } }
  }
}

async function retryReflectionAiReview({ supabase, actor, now = new Date() }) {
  requireActiveTimeActor(actor)
  const reflection = await findReflection({ supabase, userId: actor.id, businessDate: businessDateAt(now, DEFAULT_BUSINESS_TIME_ZONE) })
  if (!reflection) throw new TimeManagementError('REFLECTION_NOT_FOUND', 'No reflection is available to retry.', 404)
  try {
    const queued = await enqueueTimeJob({
      supabase,
      userId: actor.id,
      jobType: 'AI_REVIEW',
      dedupeKey: `${reflection.id}:${reflection.version}`,
      payload: { reflectionId: reflection.id, reflectionVersion: reflection.version },
      retryFailed: true
    })
    return { reflection, job: queued.job, jobDeduplicated: queued.deduplicated, ai: aiState(queued.job) }
  } catch (_error) {
    return { reflection, job: null, jobDeduplicated: false, ai: { status: 'FAILED', retryable: true } }
  }
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
  if (jobResult.error?.code === 'PGRST116') return { status: 'FAILED', retryable: true }
  if (jobResult.error) throw databaseError()
  return aiState(jobResult.data)
}

module.exports = { findReflection, saveReflection, retryReflectionAiReview, getReflection, getReflectionAiStatus }
