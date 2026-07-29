const router = require('express').Router()
const crypto = require('node:crypto')
const { ZodError } = require('zod')
const auth = require('../../middleware/auth')
const { TimeManagementError } = require('../../services/time-management/errors')

router.use((req, _res, next) => {
  const inbound = req.get('X-Request-Id')
  req.timeRequestId ||= typeof inbound === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(inbound)
    ? inbound
    : crypto.randomUUID()
  next()
})
router.use(auth)
router.use('/categories', require('./categories'))
router.use('/crm-links', require('./crm-links'))
router.use('/plans', require('./plans'))
router.use('/entries', require('./entries'))
router.use('/reflections', require('./reflections'))

router.use((req, res) => {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: 'Time-management route not found.', requestId: req.timeRequestId }
  })
})

router.use((error, req, res, next) => {
  if (error instanceof TimeManagementError) {
    return res.status(error.status).json({ error: { code: error.code, message: error.message, requestId: req.timeRequestId } })
  }
  if (error instanceof ZodError) {
    return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: '요청 형식이 올바르지 않습니다.', requestId: req.timeRequestId } })
  }
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Time-management request could not be completed.', requestId: req.timeRequestId }
  })
})

module.exports = router
