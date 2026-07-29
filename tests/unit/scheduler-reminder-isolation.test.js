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

test('reports only an aggregate count when individual user reminder schedules fail', async () => {
  const signals = []
  const poll = createTimeJobPoll({
    supabase: {},
    workerId: 'worker-1',
    provider: {},
    scheduleReminders: async () => ({
      scheduled: 1,
      outcomes: [
        { scheduled: false, reason: 'SCHEDULE_FAILED', userId: 'private-user-one' },
        { scheduled: true, userId: 'private-user-two' },
        { scheduled: false, reason: 'SCHEDULE_FAILED', userId: 'private-user-three' }
      ]
    }),
    processJobs: async () => ({ claimed: 0, completed: 0, failed: 0 }),
    logger: { error: (...args) => signals.push(args), warn: (...args) => signals.push(args) }
  })

  await poll()

  expect(signals).toHaveLength(1)
  expect(signals[0]).toEqual(['[Scheduler] reflection reminder user scheduling failures:', 2])
  expect(JSON.stringify(signals)).not.toContain('private-user')
})
