const RETRY_DELAYS_MINUTES = Object.freeze([1, 5, 30])

function retryDelayMinutes(attempt) {
  return RETRY_DELAYS_MINUTES[attempt - 1] ?? null
}

function databaseError(error) {
  const safe = new Error('Time-management job operation failed.')
  safe.code = error?.code
  return safe
}

async function enqueueTimeJob({ supabase, userId, jobType, dedupeKey, payload }) {
  const record = { user_id: userId, job_type: jobType, dedupe_key: dedupeKey, payload }
  const { data, error } = await supabase.from('time_jobs').insert(record).select('*').single()
  if (!error) return { job: data, deduplicated: false }
  if (error.code !== '23505') throw databaseError(error)

  const existing = await supabase.from('time_jobs').select('*')
    .eq('job_type', jobType).eq('dedupe_key', dedupeKey).single()
  if (existing.error || !existing.data) throw databaseError(existing.error || error)
  return { job: existing.data, deduplicated: true }
}

async function processReadyTimeJobs({ supabase, workerId, handlers, limit = 10, leaseSeconds = 60 }) {
  const claim = await supabase.rpc('time_claim_jobs', {
    p_limit: limit,
    p_worker_id: workerId,
    p_lease_seconds: leaseSeconds
  })
  if (claim.error) throw databaseError(claim.error)
  const jobs = claim.data || []
  let completed = 0
  let failed = 0

  for (const job of jobs) {
    try {
      const handler = handlers?.[job.job_type]
      if (!handler) throw new Error('No job handler is configured.')
      const result = await handler(job)
      const completion = await supabase.rpc('time_complete_job', {
        p_job_id: job.id,
        p_worker_id: workerId,
        p_lease_token: job.lease_token,
        p_result: result ?? null
      })
      if (completion.error) throw databaseError(completion.error)
      completed += 1
    } catch (_error) {
      const failure = await supabase.rpc('time_fail_job', {
        p_job_id: job.id,
        p_worker_id: workerId,
        p_lease_token: job.lease_token,
        p_error_code: `${job.job_type || 'UNKNOWN'}_FAILED`
      })
      if (failure.error) throw databaseError(failure.error)
      failed += 1
    }
  }
  return { claimed: jobs.length, completed, failed }
}

module.exports = { RETRY_DELAYS_MINUTES, retryDelayMinutes, enqueueTimeJob, processReadyTimeJobs }
