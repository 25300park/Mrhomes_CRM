const { createTimeJobPoll } = require('../../services/scheduler')

test('a reminder scheduling failure never prevents the existing leased queue poll', async () => {
  const calls = []
  const poll = createTimeJobPoll({
    supabase: {},
    workerId: 'worker-1',
    provider: {},
    scheduleReminders: async () => { calls.push('schedule'); throw new Error('reminder scan failed') },
    processJobs: async ({ handlers }) => {
      calls.push('queue')
      expect(Object.keys(handlers).sort()).toEqual(['AI_REVIEW', 'REMINDER_PUSH'])
      return { claimed: 0, completed: 0, failed: 0 }
    },
    logger: { error: (...args) => calls.push(['error', ...args]) }
  })

  await poll()

  expect(calls[0]).toBe('schedule')
  expect(calls).toContain('queue')
  expect(calls.some((call) => Array.isArray(call) && call[0] === 'error')).toBe(true)
})
