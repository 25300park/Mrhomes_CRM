function databaseError(error) {
  const safe = new Error('Time-management job operation failed.')
  safe.code = error?.code
  return safe
}

async function enqueueTimeJob({ supabase, userId, jobType, dedupeKey, payload, retryFailed = false }) {
  const record = { user_id: userId, job_type: jobType, dedupe_key: dedupeKey, payload }
  const { data, error } = await supabase.from('time_jobs').insert(record).select('*').single()
  if (!error) return { job: data, deduplicated: false }
  if (error.code !== '23505') throw databaseError(error)

  const existing = await supabase.from('time_jobs').select('*')
    .eq('job_type', jobType).eq('dedupe_key', dedupeKey).single()
  if (existing.error || !existing.data) throw databaseError(existing.error || error)
  if (!retryFailed || existing.data.status !== 'FAILED') return { job: existing.data, deduplicated: true }

  const revived = await supabase.from('time_jobs').update({
    status: 'PENDING', attempts: 0, ready_at: new Date().toISOString(), last_error_code: null, result: null
  }).eq('id', existing.data.id).eq('user_id', userId).eq('status', 'FAILED').select('*').single()
  if (revived.error || !revived.data) throw databaseError(revived.error || error)
  return { job: revived.data, deduplicated: true, retried: true }
}

function isLostLease(error) {
  return error?.code === '42501'
}

function runWithTimeout(work, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Time job handler timed out.')), timeoutMs)
    Promise.resolve().then(work).then(
      (result) => { clearTimeout(timer); resolve(result) },
      (error) => { clearTimeout(timer); reject(error) }
    )
  })
}

async function processReadyTimeJobs({ supabase, workerId, handlers, limit = 3, leaseSeconds = 60, handlerTimeoutMs }) {
  const claimLimit = Math.min(Math.max(Number(limit) || 1, 1), 5)
  const claim = await supabase.rpc('time_claim_jobs', {
    p_limit: claimLimit,
    p_worker_id: workerId,
    p_lease_seconds: leaseSeconds
  })
  if (claim.error) throw databaseError(claim.error)
  const jobs = claim.data || []
  const timeoutMs = Math.max(1_000, Math.min(
    Number(handlerTimeoutMs) || (leaseSeconds * 1000) - 5_000,
    (leaseSeconds * 1000) - 1_000
  ))
  const outcomes = await Promise.all(jobs.map(async (job) => {
    try {
      const handler = handlers?.[job.job_type]
      if (!handler) throw new Error('No job handler is configured.')
      const result = await runWithTimeout(() => handler(job), timeoutMs)
      const completion = await supabase.rpc('time_complete_job', {
        p_job_id: job.id,
        p_worker_id: workerId,
        p_lease_token: job.lease_token,
        p_result: result ?? null
      })
      if (!completion.error) return 'completed'
      if (isLostLease(completion.error)) return 'failed'
    } catch (_error) {
      // The DB RPC remains authoritative; an already-lost lease is terminal for this worker only.
    }
    try {
      const failure = await supabase.rpc('time_fail_job', {
        p_job_id: job.id,
        p_worker_id: workerId,
        p_lease_token: job.lease_token,
        p_error_code: `${job.job_type || 'UNKNOWN'}_FAILED`
      })
      if (failure.error && !isLostLease(failure.error)) return 'failed'
    } catch (_error) {
      // A failed release must not abort other independently leased jobs.
    }
    return 'failed'
  }))
  return { claimed: jobs.length, completed: outcomes.filter(outcome => outcome === 'completed').length, failed: outcomes.filter(outcome => outcome === 'failed').length }
}

module.exports = { enqueueTimeJob, processReadyTimeJobs }
