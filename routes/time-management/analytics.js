const router = require('express').Router()
const { z } = require('zod')
const analytics = require('../../services/time-management/analytics')
const { businessDateAt } = require('../../services/time-management/time')

const emptyQuery = z.object({}).strict()
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
}, 'Invalid calendar date')
const periodSchema = z.object({ periodStart: dateSchema, periodEnd: dateSchema }).strict().refine(value => value.periodEnd >= value.periodStart, 'Invalid period')

router.get('/personal/today', async (req, res, next) => {
  try {
    emptyQuery.parse(req.query)
    res.json(await analytics.getPersonalReview({ supabase: req.supabase, actor: req.user, businessDate: businessDateAt(new Date()) }))
  } catch (error) { next(error) }
})

router.get('/personal/:businessDate', async (req, res, next) => {
  try {
    emptyQuery.parse(req.query)
    res.json(await analytics.getPersonalReview({ supabase: req.supabase, actor: req.user, businessDate: dateSchema.parse(req.params.businessDate) }))
  } catch (error) { next(error) }
})

router.get('/admin/members/:businessDate', async (req, res, next) => {
  try {
    emptyQuery.parse(req.query)
    res.json(await analytics.getAdminMemberSummaries({ supabase: req.supabase, actor: req.user, businessDate: dateSchema.parse(req.params.businessDate) }))
  } catch (error) { next(error) }
})

router.post('/admin/team-keywords', async (req, res, next) => {
  try {
    emptyQuery.parse(req.query)
    res.json(await analytics.aggregateTeamKeywords({ supabase: req.supabase, actor: req.user, ...periodSchema.parse(req.body) }))
  } catch (error) { next(error) }
})

module.exports = router
