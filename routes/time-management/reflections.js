const router = require('express').Router()
const { z } = require('zod')
const reflections = require('../../services/time-management/reflections')
const { businessDateAt } = require('../../services/time-management/time')

const emptyQuery = z.object({}).strict()
const saveSchema = z.object({ reflectionText: z.string().trim().min(1).max(5000) }).strict()
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
}, 'Invalid calendar date')

router.put('/today', async (req, res, next) => {
  try {
    emptyQuery.parse(req.query)
    const result = await reflections.saveReflection({ supabase: req.supabase, actor: req.user, input: saveSchema.parse(req.body) })
    res.status(result.jobDeduplicated ? 200 : 201).json(result)
  } catch (error) { next(error) }
})

router.post('/today/retry', async (req, res, next) => {
  try {
    emptyQuery.parse(req.query)
    z.object({}).strict().parse(req.body || {})
    const result = await reflections.retryReflectionAiReview({ supabase: req.supabase, actor: req.user })
    res.status(result.jobDeduplicated ? 200 : 201).json(result)
  } catch (error) { next(error) }
})

router.get('/today', async (req, res, next) => {
  try {
    emptyQuery.parse(req.query)
    res.json(await reflections.getReflection({ supabase: req.supabase, actor: req.user, businessDate: businessDateAt(new Date()) }))
  } catch (error) { next(error) }
})

router.get('/today/status', async (req, res, next) => {
  try {
    emptyQuery.parse(req.query)
    res.json(await reflections.getReflectionAiStatus({ supabase: req.supabase, actor: req.user, businessDate: businessDateAt(new Date()) }))
  } catch (error) { next(error) }
})

router.get('/:businessDate', async (req, res, next) => {
  try {
    emptyQuery.parse(req.query)
    res.json(await reflections.getReflection({ supabase: req.supabase, actor: req.user, businessDate: dateSchema.parse(req.params.businessDate) }))
  } catch (error) { next(error) }
})

module.exports = router
