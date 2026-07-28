const { TimeManagementError } = require('./errors')
const { requireActiveTimeActor } = require('./access-policy')

const TYPES = ['CONTACT', 'LISTING', 'LEAD', 'DEAL']

function databaseError(error) {
  return new TimeManagementError('DATABASE_ERROR', 'CRM 연결 대상을 조회할 수 없습니다.', 500, { cause: error })
}

function safeLabel(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

async function searchCrmLinks({ supabase, actor, query = '', types = TYPES, limit = 20 }) {
  requireActiveTimeActor(actor)
  const selected = types.filter(type => TYPES.includes(type))
  const requestLimit = Math.min(limit, 50)
  const { data, error } = await supabase.rpc('time_search_crm_links', {
    p_query: query,
    p_types: selected,
    p_limit: requestLimit
  })
  if (error) throw databaseError(error)
  return (data || []).map(row => ({ id: row.id, type: row.type, label: safeLabel(row.label) })).filter(item => item.label)
}

module.exports = { CRM_LINK_TYPES: TYPES, searchCrmLinks }
