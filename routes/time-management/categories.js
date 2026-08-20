const router = require('express').Router()
const { z } = require('zod')
const categories = require('../../services/time-management/categories')

const name = z.string().trim().min(1).max(100)
const categoryId = z.string().trim().min(1).max(100)
const standardCreateSchema = z.object({
  name,
  description: z.string().trim().max(2000).optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
  isFocus: z.boolean().optional(),
  isActive: z.boolean().optional()
}).strict()
const standardUpdateSchema = standardCreateSchema.partial().refine(value => Object.keys(value).length > 0)
const personalCreateSchema = z.object({
  name,
  parentStandardCategoryId: categoryId,
  sortOrder: z.number().int().min(0).max(100000).optional()
}).strict()
const personalUpdateSchema = z.object({
  name: name.optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
  isActive: z.boolean().optional()
}).strict().refine(value => Object.keys(value).length > 0)
const listQuerySchema = z.object({}).strict()

function parse(schema, source) {
  return schema.parse(source)
}

router.get('/', async (req, res, next) => {
  try {
    parse(listQuerySchema, req.query)
    res.json(await categories.listAvailableCategories({ supabase: req.supabase, actor: req.user }))
  } catch (error) { next(error) }
})

router.post('/standard', async (req, res, next) => {
  try {
    const input = parse(standardCreateSchema, req.body)
    res.status(201).json(await categories.createStandardCategory({ supabase: req.supabase, actor: req.user, input }))
  } catch (error) { next(error) }
})

router.patch('/standard/:categoryId', async (req, res, next) => {
  try {
    const input = parse(standardUpdateSchema, req.body)
    res.json(await categories.updateStandardCategory({ supabase: req.supabase, actor: req.user, categoryId: parse(categoryId, req.params.categoryId), input }))
  } catch (error) { next(error) }
})

router.post('/personal', async (req, res, next) => {
  try {
    const input = parse(personalCreateSchema, req.body)
    res.status(201).json(await categories.createPersonalCategory({ supabase: req.supabase, actor: req.user, input }))
  } catch (error) { next(error) }
})

router.patch('/personal/:categoryId', async (req, res, next) => {
  try {
    const input = parse(personalUpdateSchema, req.body)
    res.json(await categories.updatePersonalCategory({ supabase: req.supabase, actor: req.user, categoryId: parse(categoryId, req.params.categoryId), input }))
  } catch (error) { next(error) }
})

router.delete('/personal/:categoryId', async (req, res, next) => {
  try {
    parse(listQuerySchema, req.query)
    res.json(await categories.deactivatePersonalCategory({ supabase: req.supabase, actor: req.user, categoryId: parse(categoryId, req.params.categoryId) }))
  } catch (error) { next(error) }
})

module.exports = router
