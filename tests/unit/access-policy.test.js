const {
  requireTimeOwner,
  requireTimeAdmin
} = require('../../services/time-management/access-policy')

const agent = { id: 'agent-1', role: 'agent', is_active: true }
const admin = { id: 'admin-1', role: 'admin', is_active: true }

describe('time-management access policy', () => {
  test('allows an active agent to access their own time data', () => {
    expect(() => requireTimeOwner(agent, 'agent-1')).not.toThrow()
  })

  test('denies an agent access to another user time data', () => {
    expect(() => requireTimeOwner(agent, 'agent-2')).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN', status: 403 })
    )
  })

  test('allows an active admin to use an explicit aggregate action', () => {
    expect(() => requireTimeAdmin(admin)).not.toThrow()
  })

  test('does not let an admin bypass another users private reflection', () => {
    expect(() => requireTimeOwner(admin, 'agent-1')).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN', status: 403 })
    )
  })

  test('denies inactive actors before any ownership or admin check', () => {
    const inactiveAdmin = { ...admin, is_active: false }

    expect(() => requireTimeOwner(inactiveAdmin, 'admin-1')).toThrow(
      expect.objectContaining({ code: 'INACTIVE_ACTOR', status: 403 })
    )
    expect(() => requireTimeAdmin(inactiveAdmin)).toThrow(
      expect.objectContaining({ code: 'INACTIVE_ACTOR', status: 403 })
    )
  })
})
