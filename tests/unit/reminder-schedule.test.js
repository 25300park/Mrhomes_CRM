const crypto = require('node:crypto')
const {
  assertSafePushEndpoint,
  createSafeLookup,
  createSharedPushSender,
  decryptPushKey,
  encryptPushKey,
  getPendingInAppReminders,
  scheduleReflectionReminder,
  scheduleReflectionReminders,
  sendReflectionReminder,
  validatePushRuntimeConfig
} = require('../../services/time-management/push')

const USER = { id: '10000000-0000-4000-8000-000000000001', is_active: true }
const REMINDER_BODY = '오늘의 시간관리 회고를 작성해 주세요.'
const REMINDER_URL = '/time-management#reflection'

beforeEach(() => {
  process.env.TIME_PUSH_ACTIVE_KEY_ID = 'current'
  process.env.TIME_PUSH_ENCRYPTION_KEYS = `current=${Buffer.alloc(32, 7).toString('base64')}`
  delete process.env.TIME_PUSH_LEGACY_KEY_IDS
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
    scheduleUser: async ({ user }) => {
      if (user.id === 'user-0') throw new Error('one user is malformed')
      return { scheduled: false, userId: user.id }
    }
  })
  expect(result.outcomes).toHaveLength(201)
  expect(result.outcomes[0]).toMatchObject({ scheduled: false, reason: 'SCHEDULE_FAILED', userId: 'user-0' })
  expect(result.outcomes.at(-1)).toMatchObject({ userId: 'user-200' })
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

test('paginates every historical reminder and batch-loads reflections without dropping unresolved dates', async () => {
  const dates = Array.from({ length: 35 }, (_, index) => new Date(Date.UTC(2026, 4, index + 1)).toISOString().slice(0, 10))
  const pending = pendingSupabase({ dates, reflectedDates: [dates[3], dates[32]] })
  const result = await getPendingInAppReminders({ supabase: pending.supabase, actor: USER, pageSize: 20 })

  expect(result.reminders).toHaveLength(33)
  expect(result.reminders.map((item) => item.businessDate)).not.toContain(dates[3])
  expect(result.reminders.map((item) => item.businessDate)).toContain(dates[34])
  expect(pending.ranges).toEqual([[0, 19], [20, 39]])
  expect(pending.reflectionQueries).toHaveLength(2)
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

test('decrypts the legacy four-part v1 envelope with configured legacy keys', () => {
  const oldKey = Buffer.alloc(32, 3)
  const currentKey = Buffer.alloc(32, 4)
  process.env.TIME_PUSH_ACTIVE_KEY_ID = 'current'
  process.env.TIME_PUSH_ENCRYPTION_KEYS = `current=${currentKey.toString('base64')},old=${oldKey.toString('base64')}`
  process.env.TIME_PUSH_LEGACY_KEY_IDS = 'old,current'

  expect(decryptPushKey(legacyCiphertext('legacy-secret', oldKey))).toBe('legacy-secret')
})

test('rejects non-canonical base64url and wrong IV or authentication-tag lengths', () => {
  const valid = encryptPushKey('secret').split(':')
  expect(() => decryptPushKey([...valid.slice(0, 2), `${valid[2]}=`, ...valid.slice(3)].join(':'))).toThrow(/ciphertext is invalid/)
  expect(() => decryptPushKey([valid[0], valid[1], Buffer.alloc(11).toString('base64url'), valid[3], valid[4]].join(':'))).toThrow(/ciphertext is invalid/)
  expect(() => decryptPushKey([valid[0], valid[1], valid[2], Buffer.alloc(15).toString('base64url'), valid[4]].join(':'))).toThrow(/ciphertext is invalid/)
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

test('validates Push keyring and VAPID configuration during production startup', () => {
  const valid = {
    NODE_ENV: 'production',
    TIME_PUSH_ACTIVE_KEY_ID: 'current',
    TIME_PUSH_ENCRYPTION_KEYS: `current=${Buffer.alloc(32, 7).toString('base64')}`,
    VAPID_SUBJECT: 'mailto:ops@example.com',
    VAPID_PUBLIC_KEY: 'public',
    VAPID_PRIVATE_KEY: 'private'
  }
  expect(() => validatePushRuntimeConfig({ ...valid, TIME_PUSH_ENCRYPTION_KEYS: 'current=bad' })).toThrow(/canonical base64|32-byte/)
  expect(() => validatePushRuntimeConfig({ ...valid, VAPID_PRIVATE_KEY: '' })).toThrow(/VAPID_PRIVATE_KEY/)
  expect(validatePushRuntimeConfig(valid)).toMatchObject({ activeKeyId: 'current' })
  expect(validatePushRuntimeConfig({ NODE_ENV: 'test' })).toBeNull()
})

test('shares one lazy Push sender and destroys its keepalive agent once', async () => {
  let created = 0
  let destroyed = 0
  const shared = createSharedPushSender({ createSender() {
    created++
    const sender = async (message) => message.endpoint
    sender.destroy = () => { destroyed++ }
    return sender
  } })

  await shared({ endpoint: 'one' })
  await shared({ endpoint: 'two' })
  shared.destroy()
  shared.destroy()

  expect(created).toBe(1)
  expect(destroyed).toBe(1)
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

function pendingSupabase({ dates, reflectedDates }) {
  const fixture = { ranges: [], reflectionQueries: [] }
  fixture.supabase = {
    from(table) {
      const filters = {}
      let window = [0, 199]
      const query = {
        select() { return query },
        eq(key, value) { filters[key] = value; return query },
        order() { return query },
        range(start, end) { window = [start, end]; fixture.ranges.push(window); return query },
        in(key, values) { filters[key] = values; fixture.reflectionQueries.push(values); return query },
        then(resolve, reject) {
          const data = table === 'time_jobs'
            ? dates.slice(window[0], window[1] + 1).map((businessDate) => ({ payload: { businessDate }, created_at: `${businessDate}T09:00:00Z` }))
            : reflectedDates.filter((businessDate) => filters.business_date.includes(businessDate)).map((business_date) => ({ business_date }))
          return Promise.resolve({ data, error: null }).then(resolve, reject)
        }
      }
      return query
    }
  }
  return fixture
}

function legacyCiphertext(value, key) {
  const iv = Buffer.alloc(12, 9)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return `v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${ciphertext.toString('base64url')}`
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
