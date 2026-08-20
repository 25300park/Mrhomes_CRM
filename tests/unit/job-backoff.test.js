const { processReadyTimeJobs } = require('../../services/time-management/job-queue')

test('completes successful leased jobs and fails unsuccessful jobs with a sanitized code', async () => {
  const completed = []
  const failed = []
  const supabase = {
    async rpc(name, args) {
      if (name === 'time_claim_jobs') return { data: [
        { id: 'job-ok', job_type: 'AI_REVIEW', user_id: 'user-1', lease_token: 'lease-ok' },
        { id: 'job-fail', job_type: 'AI_REVIEW', user_id: 'user-1', lease_token: 'lease-fail' }
      ], error: null }
      if (name === 'time_complete_job') { completed.push(args); return { data: {}, error: null } }
      if (name === 'time_fail_job') { failed.push(args); return { data: {}, error: null } }
      throw new Error(`Unexpected RPC ${name}`)
    }
  }

  const result = await processReadyTimeJobs({
    supabase, workerId: 'test-worker',
    handlers: { AI_REVIEW: async (job) => {
      if (job.id === 'job-fail') throw new Error('provider key leaked: sk-secret')
      return { reviewId: 'review-1' }
    } }
  })

  expect(result).toEqual({ claimed: 2, completed: 1, failed: 1 })
  expect(completed).toEqual([{ p_job_id: 'job-ok', p_worker_id: 'test-worker', p_lease_token: 'lease-ok', p_result: { reviewId: 'review-1' } }])
  expect(failed).toEqual([{ p_job_id: 'job-fail', p_worker_id: 'test-worker', p_lease_token: 'lease-fail', p_error_code: 'AI_REVIEW_FAILED' }])
})

test('starts a bounded claimed batch concurrently and continues after a lost completion lease', async () => {
  const started = []
  const completed = []
  const failed = []
  let releaseFirst
  const firstStarted = new Promise(resolve => { releaseFirst = resolve })
  let releaseHandler
  const handlerRelease = new Promise(resolve => { releaseHandler = resolve })
  const supabase = {
    async rpc(name, args) {
      if (name === 'time_claim_jobs') return { data: [
        { id: 'job-lost', job_type: 'AI_REVIEW', user_id: 'user-1', lease_token: 'lease-lost' },
        { id: 'job-ok', job_type: 'AI_REVIEW', user_id: 'user-1', lease_token: 'lease-ok' }
      ], error: null }
      if (name === 'time_complete_job') {
        completed.push(args.p_job_id)
        return args.p_job_id === 'job-lost' ? { data: null, error: { code: '42501' } } : { data: {}, error: null }
      }
      if (name === 'time_fail_job') { failed.push(args.p_job_id); return { data: null, error: { code: '42501' } } }
      throw new Error(`Unexpected RPC ${name}`)
    }
  }
  const processing = processReadyTimeJobs({
    supabase, workerId: 'test-worker', limit: 2, leaseSeconds: 60,
    handlers: { AI_REVIEW: async (job) => {
      started.push(job.id)
      if (job.id === 'job-lost') {
        releaseFirst()
        await handlerRelease
      }
      return { reviewId: job.id }
    } }
  })
  await firstStarted
  await Promise.resolve()
  expect(started).toEqual(['job-lost', 'job-ok'])
  releaseHandler()
  const result = await processing
  expect(completed).toHaveLength(2)
  expect(completed).toEqual(expect.arrayContaining(['job-lost', 'job-ok']))
  expect(failed).toEqual([])
  expect(result).toEqual({ claimed: 2, completed: 1, failed: 1 })
})
