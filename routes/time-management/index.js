const router = require('express').Router()
const { ZodError } = require('zod')
const auth = require('../../middleware/auth')
const { TimeManagementError } = require('../../services/time-management/errors')

router.use(auth)
router.use('/categories', require('./categories'))
router.use('/crm-links', require('./crm-links'))

router.use((error, _req, res, next) => {
  if (error instanceof TimeManagementError) {
    return res.status(error.status).json({ error: { code: error.code, message: error.message } })
  }
  if (error instanceof ZodError) {
    return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: '요청 형식이 올바르지 않습니다.' } })
  }
  next(error)
})

module.exports = router
