const jwt = require('jsonwebtoken')

module.exports = function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1]
  if (!token) return res.status(401).json({ error: '인증 토큰이 필요합니다' })
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET)
    next()
  } catch {
    res.status(401).json({ error: '유효하지 않은 토큰입니다' })
  }
}
