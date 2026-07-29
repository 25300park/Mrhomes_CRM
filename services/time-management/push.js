const crypto = require('node:crypto')
const dns = require('node:dns')
const https = require('node:https')
const net = require('node:net')
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

function loadPushKeyring(env = process.env) {
  const activeKeyId = env.TIME_PUSH_ACTIVE_KEY_ID
  const encodedEntries = env.TIME_PUSH_ENCRYPTION_KEYS
  if (!activeKeyId || !/^[A-Za-z0-9._-]{1,64}$/.test(activeKeyId)) {
    throw new Error('TIME_PUSH_ACTIVE_KEY_ID must name a configured key.')
  }
  if (!encodedEntries) throw new Error('TIME_PUSH_ENCRYPTION_KEYS must be configured.')
  const keys = new Map()
  for (const entry of encodedEntries.split(',')) {
    const separator = entry.indexOf('=')
    const keyId = entry.slice(0, separator)
    const encoded = entry.slice(separator + 1)
    if (separator < 1 || !/^[A-Za-z0-9._-]{1,64}$/.test(keyId) || keys.has(keyId)) {
      throw new Error('TIME_PUSH_ENCRYPTION_KEYS contains an invalid or duplicate key id.')
    }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new Error('Push encryption keys must use canonical base64.')
    }
    const key = Buffer.from(encoded, 'base64')
    if (key.toString('base64') !== encoded) throw new Error('Push encryption keys must use canonical base64.')
    if (key.length !== 32) throw new Error('Push encryption keys must be 32-byte AES-256 keys.')
    keys.set(keyId, key)
  }
  if (!keys.has(activeKeyId)) throw new Error('TIME_PUSH_ACTIVE_KEY_ID must name a configured key.')
  return { activeKeyId, keys }
}

function encryptPushKey(value) {
  const { activeKeyId, keys } = loadPushKeyring()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', keys.get(activeKeyId), iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return `v1:${activeKeyId}:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${encrypted.toString('base64url')}`
}

function decryptPushKey(value) {
  const parts = String(value).split(':')
  const [version, keyId, iv, tag, ciphertext] = parts
  if (parts.length !== 5 || version !== 'v1' || !keyId || !iv || !tag || !ciphertext) throw new Error('Push subscription key ciphertext is invalid.')
  const { keys } = loadPushKeyring()
  const key = keys.get(keyId)
  if (!key) throw new Error('Push subscription key id is not configured.')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
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
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value || '')
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59 || Number(match[3] || 0) > 59) {
    throw new TimeManagementError('INVALID_REMINDER_PREFERENCE', 'Reminder close time must be between 00:00 and 23:59.', 500)
  }
  return `${match[1]}:${match[2]}:${match[3] || '00'}`
}

function ipv4Number(address) {
  return address.split('.').reduce((value, part) => (value * 256) + Number(part), 0) >>> 0
}

function inIpv4Range(address, base, prefix) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (ipv4Number(address) & mask) === (ipv4Number(base) & mask)
}

function isPublicAddress(address) {
  const family = net.isIP(address)
  if (family === 4) {
    const denied = [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
      ['224.0.0.0', 4], ['240.0.0.0', 4]
    ]
    return !denied.some(([base, prefix]) => inIpv4Range(address, base, prefix))
  }
  if (family === 6) {
    const normalized = address.toLowerCase()
    if (normalized === '::' || normalized === '::1' || normalized.startsWith('::ffff:')) return false
    if (/^f[cd]/.test(normalized) || /^fe[89a-f]/.test(normalized) || /^ff/.test(normalized)) return false
    if (/^(?:64:ff9b(?::1)?|100|2002)(?::|$)/.test(normalized)) return false
    if (/^2001:db8(?::|$)/.test(normalized)) return false
    return true
  }
  return false
}

function unsafeEndpointError() {
  return new TimeManagementError('UNSAFE_PUSH_ENDPOINT', 'Push endpoint is not allowed.', 400)
}

async function defaultResolveAddresses(hostname) {
  return dns.promises.lookup(hostname, { all: true, verbatim: true })
}

async function resolvePublicAddresses(hostname, resolveAddresses = defaultResolveAddresses) {
  let addresses
  try { addresses = await resolveAddresses(hostname) } catch { throw unsafeEndpointError() }
  const normalized = (Array.isArray(addresses) ? addresses : [addresses]).map((entry) => typeof entry === 'string'
    ? { address: entry, family: net.isIP(entry) }
    : { address: entry?.address, family: entry?.family || net.isIP(entry?.address) })
  if (!normalized.length || normalized.some((entry) => !isPublicAddress(entry.address))) throw unsafeEndpointError()
  return normalized
}

async function assertSafePushEndpoint(endpoint, { resolveAddresses = defaultResolveAddresses } = {}) {
  let parsed
  try { parsed = new URL(endpoint) } catch { throw unsafeEndpointError() }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) throw unsafeEndpointError()
  await resolvePublicAddresses(parsed.hostname, resolveAddresses)
  return parsed
}

function createSafeLookup({ resolveAddresses = defaultResolveAddresses } = {}) {
  return (hostname, options, callback) => {
    const normalizedOptions = typeof options === 'number' ? { family: options } : (options || {})
    resolvePublicAddresses(hostname, resolveAddresses).then((addresses) => {
      const candidates = normalizedOptions.family ? addresses.filter((entry) => entry.family === normalizedOptions.family) : addresses
      if (!candidates.length) throw unsafeEndpointError()
      if (normalizedOptions.all) callback(null, candidates)
      else callback(null, candidates[0].address, candidates[0].family)
    }).catch((error) => callback(error))
  }
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

async function savePushSubscription({ supabase, actor, subscription, resolveAddresses = defaultResolveAddresses }) {
  requireActiveTimeActor(actor)
  await assertSafePushEndpoint(subscription.endpoint, { resolveAddresses })
  const existing = await supabase.from('time_push_subscriptions').select('id, user_id, endpoint, is_active')
    .eq('endpoint', subscription.endpoint).single()
  if (existing.error && existing.error.code !== 'PGRST116') throw databaseError('Push subscription could not be saved.')
  if (existing.data && existing.data.user_id !== actor.id) {
    throw new TimeManagementError('PUSH_ENDPOINT_CONFLICT', 'Push endpoint is already registered.', 409)
  }
  const encrypted = {
    p256dh: encryptPushKey(subscription.keys.p256dh),
    auth_secret: encryptPushKey(subscription.keys.auth),
    is_active: true,
    last_error_code: null
  }
  let saved
  if (existing.data) {
    saved = await supabase.from('time_push_subscriptions').update(encrypted)
      .eq('id', existing.data.id).eq('user_id', actor.id).select('id, endpoint, is_active').single()
  } else {
    saved = await supabase.from('time_push_subscriptions').insert({ user_id: actor.id, endpoint: subscription.endpoint, ...encrypted })
      .select('id, endpoint, is_active').single()
  }
  if (saved.error?.code === '23505') throw new TimeManagementError('PUSH_ENDPOINT_CONFLICT', 'Push endpoint is already registered.', 409)
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
  privateKey = process.env.VAPID_PRIVATE_KEY,
  resolveAddresses = defaultResolveAddresses,
  transport = webpush.sendNotification
} = {}) {
  if (!subject || !publicKey || !privateKey) throw new Error('VAPID_SUBJECT, VAPID_PUBLIC_KEY, and VAPID_PRIVATE_KEY must be configured.')
  const agent = new https.Agent({ keepAlive: true, lookup: createSafeLookup({ resolveAddresses }) })
  return async ({ endpoint, p256dh, authSecret, payload }) => {
    await assertSafePushEndpoint(endpoint, { resolveAddresses })
    return transport({ endpoint, keys: { p256dh, auth: authSecret } }, JSON.stringify(payload), {
      TTL: 300,
      urgency: 'high',
      agent,
      vapidDetails: { subject, publicKey, privateKey }
    })
  }
}

function errorStatus(error) {
  return Number(error?.statusCode || error?.status || error?.code)
}

async function deactivateSubscription({ supabase, id, status }) {
  const result = await supabase.from('time_push_subscriptions')
    .update({ is_active: false, last_error_code: String(status) }).eq('id', id)
  if (result.error) throw databaseError('Push subscription could not be deactivated.')
}

async function sendReflectionReminder({ supabase, job, sender, resolveAddresses = defaultResolveAddresses }) {
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

  const activeSender = sender || createVapidPushSender({ resolveAddresses })
  let delivered = 0
  let deactivated = 0
  const payload = { body: REMINDER_BODY, url: REMINDER_URL }
  for (const subscription of subscriptions.data) {
    try {
      await assertSafePushEndpoint(subscription.endpoint, { resolveAddresses })
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
    .order('created_at', { ascending: false }).limit(31)
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

async function scheduleReflectionReminders({ supabase, now = new Date(), scheduleUser = scheduleReflectionReminder }) {
  const batchSize = 200
  const outcomes = []
  for (let offset = 0; ; offset += batchSize) {
    const users = await supabase.from('users').select('id, role, is_active').eq('is_active', true)
      .order('id', { ascending: true }).range(offset, offset + batchSize - 1)
    if (users.error) throw databaseError('Active users could not be loaded.')
    const batch = users.data || []
    outcomes.push(...await Promise.all(batch.map((user) => scheduleUser({ supabase, user, now }))))
    if (batch.length < batchSize) break
  }
  return { scheduled: outcomes.filter((outcome) => outcome.scheduled).length, outcomes }
}

module.exports = {
  REMINDER_BODY,
  REMINDER_URL,
  assertSafePushEndpoint,
  createSafeLookup,
  createVapidPushSender,
  decryptPushKey,
  encryptPushKey,
  getPendingInAppReminders,
  loadPushKeyring,
  savePushSubscription,
  scheduleReflectionReminder,
  scheduleReflectionReminders,
  sendReflectionReminder
}
