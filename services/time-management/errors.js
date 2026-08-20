class TimeManagementError extends Error {
  constructor(code, message = '시간 관리 요청을 처리할 수 없습니다.', status = 400, options) {
    super(message, options)
    this.name = 'TimeManagementError'
    this.code = code
    this.status = status
  }
}

module.exports = { TimeManagementError }
