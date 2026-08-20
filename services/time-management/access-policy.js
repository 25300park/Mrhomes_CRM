const { TimeManagementError } = require('./errors')

function requireActiveTimeActor(actor) {
  if (!actor || actor.is_active !== true) {
    throw new TimeManagementError('INACTIVE_ACTOR', '활성 사용자만 시간 관리 기능을 사용할 수 있습니다.', 403)
  }
}

function requireTimeOwner(actor, userId) {
  requireActiveTimeActor(actor)
  if (actor.id !== userId) {
    throw new TimeManagementError('FORBIDDEN', '접근할 수 없습니다.', 403)
  }
}

function requireTimeAdmin(actor) {
  requireActiveTimeActor(actor)
  if (actor.role !== 'admin') {
    throw new TimeManagementError('FORBIDDEN', '관리자 권한이 필요합니다.', 403)
  }
}

module.exports = { requireActiveTimeActor, requireTimeOwner, requireTimeAdmin }
