const crypto = require('node:crypto')
const webpush = require('web-push')
const { TimeManagementError } = require('./errors')
const { requireActiveTimeActor } = require('./access-policy')
const { businessDateAt, DEFAULT_BUSINESS_TIME_ZONE } = require('./time')
const { enqueueTimeJob } = require('./job-queue')

const REMINDER_BODY = '오늘의 시간관리 회고를 작성해 주세요.'
const REMINDER_URL = '/time-management#reflection'
const DEFAULT_CLOSE_TIME = '18:00:00'

function databaseError(message = 'Reflection reminder could not be completed.') {
  return new TimeManagementError('DATABASE_ERROR', message, 500)
}

function pushEncryptionKey() {
  const encoded = process.env.TIME_PUSH_ENCRYPTION_KEY
  if (!encoded) throw new Error('TIME_PUSH_ENCRYPTION_KEY must be configured.')
  const key = Buffer.from(encoded, 'base64')
  if (key.length !== 32) throw new Error('TIME_PUSH_ENCRYPTION_KEY must be a base64-encoded 32-byte key.')
  return key
}

function encryptPushKey(value) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', pushEncryptionKey(), iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return `v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${encrypted.toString('base64url')}`
}

function decryptPushKey(value) {
  const [version, iv, tag, ciphertext] = String(value).split(':')
  if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('Push subscription key ciphertext is invalid.')
  const decipher = crypto.createDecipheriv('aes-256-gcm', pushEncryptionKey(), Buffer.from(iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8')
}

function localTimeAt(date, zone = DEFAULT_BUSINESS_TIME_ZONE) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).map((part) => [part.type, part.value]))
  return `${values.hour}:${values.minute}:${values.second}`
}

function normalizeCloseTime(value) {
  return /^\d{2}:\d{2}(:\d{2})?$/.test(value || '') ? `${value}:00`.slice(0, 8) : DEFAULT_CLOSE_TIME
}

async function findReflection({ supabase, userId, businessDate }) {
  const result = await supabase.from('time_reflections').select('id')
    .eq('user_id', userId).eq('business_date', businessDate).single()
  if (result.error?.code === 'PGRST116') return null
  if (result.error) throw databaseError()
  return result.data
}

async function getPreference({ supabase, userId }) {
  const result = await supabase.from('time_reminder_preferences')
    .select('work_end_time, in_app_enabled, push_enabled').eq('user_id', userId).single()
  if (result.error?.code === 'PGRST116') return { work_end_time: DEFAULT_CLOSE_TIME, in_app_enabled: true, push_enabled: false }
  if (result.error) throw databaseError()
  return result.data
}

async function savePushSubscription({ supabase, actor, subscription }) {
  requireActiveTimeActor(actor)
  const saved = await supabase.from('time_push_subscriptions').upsert({
    user_id: actor.id,
    endpoint: subscription.endpoint,
    p256dh: encryptPushKey(subscription.keys.p256dh),
    auth_secret: encryptPushKey(subscription.keys.auth),
    is_active: true,
    last_error_code: null
  }, { onConflict: 'endpoint' }).select('id, endpoint, is_active').single()
  if (saved.error || !saved.data) throw databaseError('Push subscription could not be saved.')
  return { subscription: saved.data }
}

async function scheduleReflectionReminder({ supabase, user, now = new Date() }) {
  requireActiveTimeActor(user)
  const businessDate = businessDateAt(now, DEFAULT_BUSINESS_TIME_ZONE)
  const preference = await getPreference({ supabase, userId: user.id })
  const closeTime = normalizeCloseTime(preference.work_end_time)
  if (localTimeAt(now) < closeTime) return { scheduled: false, reason: 'BEFORE_CLOSE_TIME', businessDate }
  if (await findReflection({ supabase, userId: user.id, businessDate })) {
    return { scheduled: false, reason: 'REFLECTION_EXISTS', businessDate }
  }
  if (preference.in_app_enabled === false && preference.push_enabled !== true) {
    return { scheduled: false, reason: 'REMINDERS_DISABLED', businessDate }
  }
  const queued = await enqueueTimeJob({
    supabase,
    userId: user.id,
    jobType: 'REMINDER_PUSH',
    dedupeKey: `${user.id}:${businessDate}`,
    payload: { businessDate, body: REMINDER_BODY, url: REMINDER_URL }
  })
  return { scheduled: true, businessDate, job: queued.job, jobDeduplicated: queued.deduplicated }
}

function createVapidPushSender({
  subject = process.env.VAPID_SUBJECT,
  publicKey = process.env.VAPID_PUBLIC_KEY,
  privateKey = process.env.VAPID_PRIVATE_KEY
} = {}) {
  if (!subject || !publicKey || !privateKey) throw new Error('VAPID_SUBJECT, VAPID_PUBLIC_KEY, and VAPID_PRIVATE_KEY must be configured.')
  return async ({ endpoint, p256dh, authSecret, payload }) => webpush.sendNotification({
    endpoint,
    keys: { p256dh, auth: authSecret }
  }, JSON.stringify(payload), {
    TTL: 300,
    urgency: 'high',
    vapidDetails: { subject, publicKey, privateKey }
  })
}

function errorStatus(error) {
  return Number(error?.statusCode || error?.status || error?.code)
}

async function deactivateSubscription({ supabase, id, status }) {
  const result = await supabase.from('time_push_subscriptions')
    .update({ is_active: false, last_error_code: String(status) }).eq('id', id)
  if (result.error) throw databaseError('Push subscription could not be deactivated.')
}

async function sendReflectionReminder({ supabase, job, sender }) {
  const businessDate = job?.payload?.businessDate
  if (!job?.user_id || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate || '')) throw new Error('REMINDER_PUSH job payload is invalid.')
  if (await findReflection({ supabase, userId: job.user_id, businessDate })) {
    return { push: 'SKIPPED_REFLECTION_EXISTS', inApp: 'CLEARED', businessDate }
  }
  const subscriptions = await supabase.from('time_push_subscriptions')
    .select('id, endpoint, p256dh, auth_secret').eq('user_id', job.user_id).eq('is_active', true)
  if (subscriptions.error) throw databaseError('Push subscriptions could not be loaded.')
  if (!subscriptions.data?.length) return { push: 'NOT_CONFIGURED', inApp: 'PENDING', businessDate }
  const preference = await getPreference({ supabase, userId: job.user_id })
  if (preference.push_enabled !== true) return { push: 'DISABLED', inApp: preference.in_app_enabled === false ? 'DISABLED' : 'PENDING', businessDate }

  const activeSender = sender || createVapidPushSender()
  let delivered = 0
  let deactivated = 0
  const payload = { body: REMINDER_BODY, url: REMINDER_URL }
  for (const subscription of subscriptions.data) {
    try {
      await activeSender({
        endpoint: subscription.endpoint,
        p256dh: decryptPushKey(subscription.p256dh),
        authSecret: decryptPushKey(subscription.auth_secret),
        payload
      })
      delivered++
    } catch (error) {
      const status = errorStatus(error)
      if (status !== 404 && status !== 410) throw error
      await deactivateSubscription({ supabase, id: subscription.id, status })
      deactivated++
    }
  }
  return {
    push: delivered ? 'SENT' : deactivated ? 'DEACTIVATED' : 'NOT_CONFIGURED',
    inApp: preference.in_app_enabled === false ? 'DISABLED' : 'PENDING',
    businessDate
  }
}

async function getPendingInAppReminders({ supabase, actor }) {
  requireActiveTimeActor(actor)
  const jobs = await supabase.from('time_jobs').select('payload, created_at')
    .eq('user_id', actor.id).eq('job_type', 'REMINDER_PUSH')
  if (jobs.error) throw databaseError('In-app reminders could not be loaded.')
  const reminders = []
  for (const job of jobs.data || []) {
    const businessDate = job.payload?.businessDate
    if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate || '')) continue
    if (!(await findReflection({ supabase, userId: actor.id, businessDate }))) {
      reminders.push({ businessDate, body: REMINDER_BODY, url: REMINDER_URL })
    }
  }
  return { reminders }
}

async function scheduleReflectionReminders({ supabase, now = new Date() }) {
  const users = await supabase.from('users').select('id, role, is_active').eq('is_active', true)
  if (users.error) throw databaseError('Active users could not be loaded.')
  const outcomes = await Promise.all((users.data || []).map((user) => scheduleReflectionReminder({ supabase, user, now })))
  return { scheduled: outcomes.filter((outcome) => outcome.scheduled).length, outcomes }
}

module.exports = {
  REMINDER_BODY,
  REMINDER_URL,
  createVapidPushSender,
  decryptPushKey,
  encryptPushKey,
  getPendingInAppReminders,
  savePushSubscription,
  scheduleReflectionReminder,
  scheduleReflectionReminders,
  sendReflectionReminder
}
