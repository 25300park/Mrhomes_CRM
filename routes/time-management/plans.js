const router = require('express').Router()
const { z } = require('zod')
const planning = require('../../services/time-management/planning')
const { businessDateAt } = require('../../services/time-management/time')

const uuid = z.string().uuid()
const emptyQuery = z.object({}).strict()
const allocation = z.object({
  standardCategoryId: uuid,
  personalCategoryId: uuid.nullish(),
  plannedMinutes: z.number().int().min(0).max(1440)
}).strict()
const saveSchema = z.object({
  availableMinutes: z.number().int().min(0).max(1440),
  allocations: z.array(allocation).max(100)
}).strict()
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
}, 'Invalid calendar date')

router.put('/today', async (req, res, next) => {
  try {
    emptyQuery.parse(req.query)
    const input = saveSchema.parse(req.body)
    res.json(await planning.saveDailyPlan({ supabase: req.supabase, actor: req.user, input }))
  } catch (error) { next(error) }
})

router.get('/today', async (req, res, next) => {
  try {
    emptyQuery.parse(req.query)
    res.json(await planning.getDailyPlan({ supabase: req.supabase, actor: req.user, businessDate: businessDateAt(new Date()) }))
  } catch (error) { next(error) }
})

router.get('/:businessDate', async (req, res, next) => {
  try {
    emptyQuery.parse(req.query)
    const businessDate = dateSchema.parse(req.params.businessDate)
    res.json(await planning.getDailyPlan({ supabase: req.supabase, actor: req.user, businessDate }))
  } catch (error) { next(error) }
})

module.exports = router
