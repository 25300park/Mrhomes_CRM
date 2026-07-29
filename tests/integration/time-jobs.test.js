const { enqueueTimeJob } = require('../../services/time-management/job-queue')

test('deduplicates an AI review job per reflection version', async () => {
  const existing = { id: 'job-existing', job_type: 'AI_REVIEW', dedupe_key: 'reflection-1:2' }
  const supabase = {
    from(table) {
      expect(table).toBe('time_jobs')
      return {
        insert() { return { select() { return { single: async () => ({ data: null, error: { code: '23505' } }) } } } },
        select() { return this },
        eq() { return this },
        single: async () => ({ data: existing, error: null })
      }
    }
  }
  await expect(enqueueTimeJob({
    supabase, userId: 'user-1', jobType: 'AI_REVIEW', dedupeKey: 'reflection-1:2', payload: { reflectionId: 'reflection-1', reflectionVersion: 2 }
  })).resolves.toEqual({ job: existing, deduplicated: true })
})

test('revives only a failed deduplicated AI review job for an explicit retry', async () => {
  const existing = { id: 'job-existing', status: 'FAILED', job_type: 'AI_REVIEW', dedupe_key: 'reflection-1:2' }
  const revived = { ...existing, status: 'PENDING', attempts: 0 }
  let update
  const supabase = {
    from() {
      let operation = 'read'
      const query = {
        insert() { return { select() { return { single: async () => ({ data: null, error: { code: '23505' } }) } } } },
        select() { return query },
        eq() { return query },
        update(value) { operation = 'update'; update = value; return query },
        single: async () => operation === 'update' ? { data: revived, error: null } : { data: existing, error: null }
      }
      return query
    }
  }

  await expect(enqueueTimeJob({
    supabase, userId: 'user-1', jobType: 'AI_REVIEW', dedupeKey: 'reflection-1:2', payload: { reflectionId: 'reflection-1', reflectionVersion: 2 }, retryFailed: true
  })).resolves.toEqual({ job: revived, deduplicated: true, retried: true })
  expect(update).toMatchObject({ status: 'PENDING', attempts: 0, last_error_code: null })
})
