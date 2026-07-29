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
