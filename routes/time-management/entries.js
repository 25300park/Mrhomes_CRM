const router = require('express').Router()
const { z } = require('zod')
const entries = require('../../services/time-management/time-entries')

const uuid = z.string().uuid()
const requestId = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/)
const timestamp = z.string().datetime({ offset: true })
const crmLink = z.object({ type: z.enum(['CONTACT', 'LISTING', 'LEAD', 'DEAL']), id: uuid }).strict()
const emptyQuery = z.object({}).strict()
const timerSchema = z.object({ requestId, standardCategoryId: uuid, personalCategoryId: uuid.nullish(), dailyPlanId: uuid.nullish(), crmLink: crmLink.nullish(), commandAt: timestamp.optional() }).strict()
const stopSchema = z.object({ requestId, commandAt: timestamp.optional() }).strict()
const manualSchema = z.object({ requestId, standardCategoryId: uuid, personalCategoryId: uuid.nullish(), dailyPlanId: uuid.nullish(), crmLink: crmLink.nullish(), startedAt: timestamp, endedAt: timestamp, notes: z.string().trim().max(5000).nullish() }).strict()
  .refine(value => Date.parse(value.endedAt) > Date.parse(value.startedAt), { path: ['endedAt'], message: 'endedAt must be after startedAt' })
const revisionSchema = z.object({ requestId, standardCategoryId: uuid.optional(), personalCategoryId: uuid.nullish(), crmLink: crmLink.nullish(), startedAt: timestamp.optional(), endedAt: timestamp.optional(), notes: z.string().trim().max(5000).nullish() }).strict()
  .refine(value => Object.keys(value).some(key => key !== 'requestId'), 'At least one revision field is required')
  .refine(value => !value.startedAt || !value.endedAt || Date.parse(value.endedAt) > Date.parse(value.startedAt), { path: ['endedAt'], message: 'endedAt must be after startedAt' })
const reconcileSchema = z.object({ displayedEntryId: uuid.nullish(), displayedStartedAt: timestamp.nullish() }).strict()
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
}, 'Invalid calendar date')
const listSchema = z.object({ businessDate: dateSchema }).strict()

function route(handler) { return async (req, res, next) => { try { await handler(req, res) } catch (error) { next(error) } } }

router.get('/', route(async (req, res) => {
  const { businessDate } = listSchema.parse(req.query)
  res.json(await entries.listTimeEntries({ supabase: req.supabase, actor: req.user, businessDate }))
}))
router.post('/timer/start', route(async (req, res) => {
  emptyQuery.parse(req.query)
  const result = await entries.startTimer({ supabase: req.supabase, actor: req.user, input: timerSchema.parse(req.body) })
  res.status(result?.replayed ? 200 : 201).json(result)
}))
router.post('/timer/switch', route(async (req, res) => {
  emptyQuery.parse(req.query)
  res.json(await entries.switchTimer({ supabase: req.supabase, actor: req.user, input: timerSchema.parse(req.body) }))
}))
router.post('/timer/stop', route(async (req, res) => {
  emptyQuery.parse(req.query)
  res.json(await entries.stopTimer({ supabase: req.supabase, actor: req.user, input: stopSchema.parse(req.body) }))
}))
router.post('/timer/reconcile', route(async (req, res) => {
  emptyQuery.parse(req.query)
  res.json(await entries.reconcileActiveTimer({ supabase: req.supabase, actor: req.user, clientState: reconcileSchema.parse(req.body) }))
}))
router.post('/manual', route(async (req, res) => {
  emptyQuery.parse(req.query)
  const result = await entries.createManualEntry({ supabase: req.supabase, actor: req.user, input: manualSchema.parse(req.body) })
  res.status(result?.replayed ? 200 : 201).json(result)
}))
router.patch('/:entryId', route(async (req, res) => {
  emptyQuery.parse(req.query)
  const entryId = uuid.parse(req.params.entryId)
  res.json(await entries.reviseTimeEntry({ supabase: req.supabase, actor: req.user, entryId, input: revisionSchema.parse(req.body) }))
}))

module.exports = router
