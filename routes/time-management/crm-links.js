const router = require('express').Router()
const { z } = require('zod')
const { CRM_LINK_TYPES, searchCrmLinks } = require('../../services/time-management/crm-links')

const searchSchema = z.object({
  q: z.string().trim().max(100).optional().default(''),
  types: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional().default(20)
}).strict()

router.get('/', async (req, res, next) => {
  try {
    const input = searchSchema.parse(req.query)
    const types = input.types ? input.types.split(',').map(type => type.trim().toUpperCase()).filter(Boolean) : CRM_LINK_TYPES
    if (!types.length || types.some(type => !CRM_LINK_TYPES.includes(type))) {
      const error = new z.ZodError([{ code: 'custom', path: ['types'], message: 'Unsupported CRM link type' }])
      throw error
    }
    res.json({ data: await searchCrmLinks({ supabase: req.supabase, actor: req.user, query: input.q, types, limit: input.limit }) })
  } catch (error) { next(error) }
})

module.exports = router
