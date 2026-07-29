const { encryptPushKey, scheduleReflectionReminder, sendReflectionReminder } = require('../../services/time-management/push')

const USER = { id: '10000000-0000-4000-8000-000000000001', is_active: true }
const REMINDER_BODY = '오늘의 시간관리 회고를 작성해 주세요.'
const REMINDER_URL = '/time-management#reflection'

beforeEach(() => {
  process.env.TIME_PUSH_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
})

test('queues one Seoul-business-date reminder at the user close time with a privacy-safe payload', async () => {
  const fixture = reminderSupabase({ preference: { work_end_time: '17:30:00', push_enabled: true, in_app_enabled: true } })

  const result = await scheduleReflectionReminder({
    supabase: fixture.supabase,
    user: USER,
    now: new Date('2026-07-29T08:30:00.000Z')
  })

  expect(result).toMatchObject({ scheduled: true, businessDate: '2026-07-29', jobDeduplicated: false })
  expect(fixture.jobs).toEqual([{
    user_id: USER.id,
    job_type: 'REMINDER_PUSH',
    dedupe_key: `${USER.id}:2026-07-29`,
    payload: { businessDate: '2026-07-29', body: REMINDER_BODY, url: REMINDER_URL }
  }])
  expect(JSON.stringify(fixture.jobs[0].payload)).not.toMatch(/reflection_text|notes|contact|listing|lead|deal/i)
})

test('uses the default 18:00 Seoul close time before queuing a reminder', async () => {
  const fixture = reminderSupabase({ preference: null })

  const result = await scheduleReflectionReminder({
    supabase: fixture.supabase,
    user: USER,
    now: new Date('2026-07-29T08:59:00.000Z')
  })

  expect(result).toEqual({ scheduled: false, reason: 'BEFORE_CLOSE_TIME', businessDate: '2026-07-29' })
  expect(fixture.jobs).toEqual([])
})

test('does not queue a reminder after that business date already has a reflection', async () => {
  const fixture = reminderSupabase({ reflection: { id: 'reflection-1' } })

  await expect(scheduleReflectionReminder({
    supabase: fixture.supabase,
    user: USER,
    now: new Date('2026-07-29T12:00:00.000Z')
  })).resolves.toEqual({ scheduled: false, reason: 'REFLECTION_EXISTS', businessDate: '2026-07-29' })
  expect(fixture.jobs).toEqual([])
})

test('keeps the in-app reflection reminder pending when Push delivery is unavailable', async () => {
  const fixture = deliverySupabase({ subscriptions: [] })

  const result = await sendReflectionReminder({
    supabase: fixture.supabase,
    job: { id: 'job-1', user_id: USER.id, payload: { businessDate: '2026-07-29', body: REMINDER_BODY, url: REMINDER_URL } },
    sender: async () => { throw new Error('sender must not be called without subscriptions') }
  })

  expect(result).toEqual({ push: 'NOT_CONFIGURED', inApp: 'PENDING', businessDate: '2026-07-29' })
})

test('deactivates subscriptions that a Push service reports as gone', async () => {
  const fixture = deliverySupabase({ subscriptions: [{ id: 'subscription-1', endpoint: 'https://push.example/subscription', p256dh: encryptPushKey('key'), auth_secret: encryptPushKey('secret') }] })

  const result = await sendReflectionReminder({
    supabase: fixture.supabase,
    job: { id: 'job-1', user_id: USER.id, payload: { businessDate: '2026-07-29', body: REMINDER_BODY, url: REMINDER_URL } },
    sender: async () => { const error = new Error('gone'); error.statusCode = 410; throw error }
  })

  expect(result).toEqual({ push: 'DEACTIVATED', inApp: 'PENDING', businessDate: '2026-07-29' })
  expect(fixture.deactivated).toEqual([{ id: 'subscription-1', is_active: false, last_error_code: '410' }])
})

function reminderSupabase({ preference = { work_end_time: '18:00:00', push_enabled: true, in_app_enabled: true }, reflection = null } = {}) {
  const jobs = []
  return {
    jobs,
    supabase: {
      from(table) {
        const filters = {}
        const query = {
          select() { return query },
          eq(key, value) { filters[key] = value; return query },
          single: async () => {
            if (table === 'time_reminder_preferences') return { data: preference, error: preference ? null : { code: 'PGRST116' } }
            if (table === 'time_reflections') return { data: reflection, error: reflection ? null : { code: 'PGRST116' } }
            if (table === 'time_jobs') return { data: null, error: { code: 'PGRST116' } }
            throw new Error(`Unexpected ${table}.single`)
          },
          insert(value) {
            jobs.push(value)
            return { select() { return { single: async () => ({ data: { id: 'job-1', ...value }, error: null }) } } }
          }
        }
        return query
      }
    }
  }
}

function deliverySupabase({ subscriptions }) {
  const deactivated = []
  return {
    deactivated,
    supabase: {
      from(table) {
        const filters = {}
        const query = {
          select() { return query },
          eq(key, value) { filters[key] = value; return query },
          single: async () => table === 'time_reminder_preferences'
            ? { data: { work_end_time: '18:00:00', push_enabled: true, in_app_enabled: true }, error: null }
            : { data: null, error: { code: 'PGRST116' } },
          then(resolve, reject) {
            if (table === 'time_push_subscriptions') return Promise.resolve({ data: subscriptions, error: null }).then(resolve, reject)
            return Promise.resolve({ data: [], error: null }).then(resolve, reject)
          },
          update(value) {
            return { eq(key, valueToMatch) { if (table === 'time_push_subscriptions' && key === 'id') deactivated.push({ id: valueToMatch, ...value }); return Promise.resolve({ data: null, error: null }) } }
          }
        }
        return query
      }
    }
  }
}
