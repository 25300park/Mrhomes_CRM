const router = require('express').Router()
const { z } = require('zod')
const push = require('../../services/time-management/push')

const subscriptionSchema = z.object({
  endpoint: z.string().url().refine((value) => new URL(value).protocol === 'https:', 'Push endpoint must use HTTPS.'),
  keys: z.object({ p256dh: z.string().min(1).max(1024), auth: z.string().min(1).max(1024) }).strict()
}).strict()
const endpointSchema = z.object({ endpoint: z.string().url().refine((value) => new URL(value).protocol === 'https:', 'Push endpoint must use HTTPS.') }).strict()

router.get('/vapid-public-key', (req, res, next) => {
  try {
    const publicKey = req.app.locals.timePushSecurity.vapidPublicKey || process.env.VAPID_PUBLIC_KEY
    if (typeof publicKey !== 'string' || !publicKey) throw new Error('Push VAPID public key is not configured.')
    res.json({ publicKey })
  } catch (error) { next(error) }
})

router.post('/subscriptions', async (req, res, next) => {
  try {
    const result = await push.savePushSubscription({
      supabase: req.supabase,
      actor: req.user,
      subscription: subscriptionSchema.parse(req.body),
      ...req.app.locals.timePushSecurity
    })
    res.status(201).json(result)
  } catch (error) { next(error) }
})

router.delete('/subscriptions', async (req, res, next) => {
  try {
    const { endpoint } = endpointSchema.parse(req.body)
    const result = await req.supabase.from('time_push_subscriptions').update({ is_active: false })
      .eq('user_id', req.user.id).eq('endpoint', endpoint)
    if (result.error) throw result.error
    res.status(204).end()
  } catch (error) { next(error) }
})

router.get('/reminders/pending', async (req, res, next) => {
  try { res.json(await push.getPendingInAppReminders({ supabase: req.supabase, actor: req.user })) } catch (error) { next(error) }
})

module.exports = router
