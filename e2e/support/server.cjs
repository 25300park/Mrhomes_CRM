const bcrypt = require('bcryptjs')
const { createApp } = require('../../app')

const PORT = 4177
process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'task-12-local-fixture-secret-with-32-bytes'
process.env.SCHEDULER_ENABLED = 'false'
delete process.env.AUTH_INVALID_BEFORE

function usersQuery(user) {
  let matches = true
  let update
  const query = {
    select() { return query },
    eq(column, value) {
      if (update) {
        if (column === 'id' && user.id === value) Object.assign(user, update)
      } else if (user[column] !== value) matches = false
      return query
    },
    update(value) { update = value; return query },
    single: async () => matches ? { data: { ...user }, error: null } : { data: null, error: { code: 'PGRST116' } },
    then(resolve, reject) { return Promise.resolve({ data: matches ? { ...user } : null, error: matches ? null : { code: 'PGRST116' } }).then(resolve, reject) }
  }
  return query
}

async function startServer() {
  const user = {
    id: '10000000-0000-4000-8000-000000000001', name: 'Release Admin', email: 'release-admin@example.test',
    role: 'admin', is_active: true, work_mode: 'office', mobile: null, base_salary: 0,
    password_hash: await bcrypt.hash('fixture-password', 4)
  }
  const app = createApp({
    supabase: { from(table) { if (table !== 'users') throw new Error(`E2E fixture forbids external table access: ${table}`); return usersQuery(user) } },
    schedulerEnabled: false,
    allowedOrigins: [`http://127.0.0.1:${PORT}`]
  })
  return new Promise((resolve, reject) => {
    const server = app.listen(PORT, '127.0.0.1', () => {
      console.log(`[E2E] safe local fixture listening on ${PORT}`)
      resolve(server)
    })
    server.on('error', reject)
  })
}

if (require.main === module) {
  startServer().catch(error => { console.error('[E2E] fixture failed:', error.message); process.exit(1) })
}

module.exports = { startServer }
