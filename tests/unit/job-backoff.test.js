const { retryDelayMinutes, processReadyTimeJobs } = require('../../services/time-management/job-queue')

test('uses three retries at 1, 5, and 30 minutes after the initial attempt', () => {
  expect([1, 2, 3].map(retryDelayMinutes)).toEqual([1, 5, 30])
  expect(retryDelayMinutes(4)).toBeNull()
})

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
