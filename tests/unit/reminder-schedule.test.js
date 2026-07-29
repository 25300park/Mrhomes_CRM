const {
  assertSafePushEndpoint,
  createSafeLookup,
  decryptPushKey,
  encryptPushKey,
  getPendingInAppReminders,
  scheduleReflectionReminder,
  scheduleReflectionReminders,
  sendReflectionReminder
} = require('../../services/time-management/push')

const USER = { id: '10000000-0000-4000-8000-000000000001', is_active: true }
const REMINDER_BODY = '오늘의 시간관리 회고를 작성해 주세요.'
const REMINDER_URL = '/time-management#reflection'

beforeEach(() => {
  process.env.TIME_PUSH_ACTIVE_KEY_ID = 'current'
  process.env.TIME_PUSH_ENCRYPTION_KEYS = `current=${Buffer.alloc(32, 7).toString('base64')}`
})

const PUBLIC_DNS = async () => [{ address: '142.250.72.14', family: 4 }]

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

test('accepts midnight but rejects out-of-range user close times', async () => {
  const midnight = reminderSupabase({ preference: { work_end_time: '00:00:00', push_enabled: true, in_app_enabled: true } })
  await expect(scheduleReflectionReminder({ supabase: midnight.supabase, user: USER, now: new Date('2026-07-28T15:00:00.000Z') }))
    .resolves.toMatchObject({ scheduled: true, businessDate: '2026-07-29' })

  const invalid = reminderSupabase({ preference: { work_end_time: '24:00:00', push_enabled: true, in_app_enabled: true } })
  await expect(scheduleReflectionReminder({ supabase: invalid.supabase, user: USER, now: new Date('2026-07-29T12:00:00.000Z') }))
    .rejects.toMatchObject({ code: 'INVALID_REMINDER_PREFERENCE' })
})

test('returns the existing reminder job when the per-user business-date enqueue is duplicated', async () => {
  const fixture = reminderSupabase({ duplicateJob: true })
  const result = await scheduleReflectionReminder({ supabase: fixture.supabase, user: USER, now: new Date('2026-07-29T12:00:00.000Z') })

  expect(result).toMatchObject({ scheduled: true, jobDeduplicated: true, job: { id: 'existing-job' } })
  expect(fixture.jobs).toHaveLength(1)
})

test('pages active users in bounded scheduler batches without starving users after the first batch', async () => {
  const ranges = []
  const users = Array.from({ length: 201 }, (_, index) => ({ id: `user-${index}`, is_active: true }))
  const supabase = {
    from(table) {
      expect(table).toBe('users')
      let window = [0, 199]
      const query = {
        select() { return query },
        eq() { return query },
        order() { return query },
        range(start, end) { window = [start, end]; ranges.push(window); return query },
        then(resolve, reject) { return Promise.resolve({ data: users.slice(window[0], window[1] + 1), error: null }).then(resolve, reject) }
      }
      return query
    }
  }

  const result = await scheduleReflectionReminders({
    supabase,
    scheduleUser: async ({ user }) => ({ scheduled: false, userId: user.id })
  })
  expect(result.outcomes).toHaveLength(201)
  expect(ranges).toEqual([[0, 199], [200, 399]])
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

test.each([404, 410])('deactivates subscriptions that a Push service reports as %i', async (statusCode) => {
  const fixture = deliverySupabase({ subscriptions: [{ id: 'subscription-1', endpoint: 'https://push.example/subscription', p256dh: encryptPushKey('key'), auth_secret: encryptPushKey('secret') }] })

  const result = await sendReflectionReminder({
    supabase: fixture.supabase,
    job: { id: 'job-1', user_id: USER.id, payload: { businessDate: '2026-07-29', body: REMINDER_BODY, url: REMINDER_URL } },
    resolveAddresses: PUBLIC_DNS,
    sender: async () => { const error = new Error('gone'); error.statusCode = statusCode; throw error }
  })

  expect(result).toEqual({ push: 'DEACTIVATED', inApp: 'PENDING', businessDate: '2026-07-29' })
  expect(fixture.deactivated).toEqual([{ id: 'subscription-1', is_active: false, last_error_code: String(statusCode) }])
})

test('decrypts keys only at send time and sends the exact privacy-safe payload', async () => {
  const fixture = deliverySupabase({ subscriptions: [{ id: 'subscription-1', endpoint: 'https://push.example/subscription', p256dh: encryptPushKey('browser-public-key'), auth_secret: encryptPushKey('browser-auth-secret') }] })
  let sent

  const result = await sendReflectionReminder({
    supabase: fixture.supabase,
    job: { id: 'job-1', user_id: USER.id, payload: { businessDate: '2026-07-29', body: 'tampered', url: '/private' } },
    resolveAddresses: PUBLIC_DNS,
    sender: async (message) => { sent = message }
  })

  expect(result.push).toBe('SENT')
  expect(sent).toEqual({
    endpoint: 'https://push.example/subscription',
    p256dh: 'browser-public-key',
    authSecret: 'browser-auth-secret',
    payload: { body: REMINDER_BODY, url: REMINDER_URL }
  })
  expect(JSON.stringify(sent.payload)).not.toMatch(/businessDate|user_id|reflection_text|notes|contact|listing|lead|deal/i)
})

test('keeps a bounded historical in-app reminder pending only until its reflection exists', async () => {
  const pending = pendingSupabase({ reflectedDates: [] })
  await expect(getPendingInAppReminders({ supabase: pending.supabase, actor: USER })).resolves.toEqual({
    reminders: [{ businessDate: '2026-07-29', body: REMINDER_BODY, url: REMINDER_URL }]
  })
  expect(pending.limit).toBe(31)

  const completed = pendingSupabase({ reflectedDates: ['2026-07-29'] })
  await expect(getPendingInAppReminders({ supabase: completed.supabase, actor: USER })).resolves.toEqual({ reminders: [] })
})

test('rejects private resolution on save and on connection-time lookup without network access', async () => {
  await expect(assertSafePushEndpoint('https://push.example/subscription', {
    resolveAddresses: async () => [{ address: '127.0.0.1', family: 4 }]
  })).rejects.toMatchObject({ code: 'UNSAFE_PUSH_ENDPOINT' })

  const lookup = createSafeLookup({ resolveAddresses: async () => [{ address: 'fc00::1', family: 6 }] })
  await expect(new Promise((resolve, reject) => lookup('push.example', { all: false }, (error, address) => error ? reject(error) : resolve(address))))
    .rejects.toMatchObject({ code: 'UNSAFE_PUSH_ENDPOINT' })
})

test.each(['fec0::1', '64:ff9b::1', '100::1', '2002::1'])(
  'rejects reserved IPv6 address %s for a Push endpoint',
  async (address) => {
    await expect(assertSafePushEndpoint('https://push.example/subscription', {
      resolveAddresses: async () => [{ address, family: 6 }]
    })).rejects.toMatchObject({ code: 'UNSAFE_PUSH_ENDPOINT' })
  }
)

test('uses the active encryption key id for new ciphertext while retaining old-key decryption', () => {
  const oldKey = Buffer.alloc(32, 3).toString('base64')
  const newKey = Buffer.alloc(32, 4).toString('base64')
  process.env.TIME_PUSH_ACTIVE_KEY_ID = 'old'
  process.env.TIME_PUSH_ENCRYPTION_KEYS = `old=${oldKey},new=${newKey}`
  const oldCiphertext = encryptPushKey('rotating-secret')

  process.env.TIME_PUSH_ACTIVE_KEY_ID = 'new'
  expect(decryptPushKey(oldCiphertext)).toBe('rotating-secret')
  expect(encryptPushKey('new-secret')).toMatch(/^v1:new:/)
})

test('rejects ciphertext envelopes with trailing unverified fields', () => {
  const ciphertext = encryptPushKey('secret')
  expect(() => decryptPushKey(`${ciphertext}:ignored`)).toThrow(/ciphertext is invalid/)
})

test('rejects non-canonical or wrong-length encryption keys before encryption', () => {
  process.env.TIME_PUSH_ACTIVE_KEY_ID = 'bad'
  process.env.TIME_PUSH_ENCRYPTION_KEYS = `bad=${Buffer.alloc(32, 7).toString('base64').replace(/=$/, '')}`
  expect(() => encryptPushKey('secret')).toThrow(/canonical base64/)

  process.env.TIME_PUSH_ENCRYPTION_KEYS = `bad=${Buffer.alloc(31, 7).toString('base64')}`
  expect(() => encryptPushKey('secret')).toThrow(/32-byte/)
})

function reminderSupabase({ preference = { work_end_time: '18:00:00', push_enabled: true, in_app_enabled: true }, reflection = null, duplicateJob = false } = {}) {
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
            if (table === 'time_jobs') return { data: { id: 'existing-job', job_type: 'REMINDER_PUSH', dedupe_key: `${USER.id}:2026-07-29` }, error: null }
            throw new Error(`Unexpected ${table}.single`)
          },
          insert(value) {
            jobs.push(value)
            return { select() { return { single: async () => duplicateJob
              ? { data: null, error: { code: '23505' } }
              : { data: { id: 'job-1', ...value }, error: null } } } }
          }
        }
        return query
      }
    }
  }
}

function pendingSupabase({ reflectedDates }) {
  const fixture = { limit: null }
  fixture.supabase = {
    from(table) {
      const filters = {}
      const query = {
        select() { return query },
        eq(key, value) { filters[key] = value; return query },
        order() { return query },
        limit(value) { fixture.limit = value; return query },
        single: async () => {
          const found = table === 'time_reflections' && reflectedDates.includes(filters.business_date)
          return found ? { data: { id: 'reflection-1' }, error: null } : { data: null, error: { code: 'PGRST116' } }
        },
        then(resolve, reject) {
          const data = table === 'time_jobs' ? [{ payload: { businessDate: '2026-07-29' }, created_at: '2026-07-29T09:00:00Z' }] : []
          return Promise.resolve({ data, error: null }).then(resolve, reject)
        }
      }
      return query
    }
  }
  return fixture
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
