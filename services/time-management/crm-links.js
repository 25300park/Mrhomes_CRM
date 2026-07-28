const { TimeManagementError } = require('./errors')
const { requireActiveTimeActor } = require('./access-policy')

const TYPES = ['CONTACT', 'LISTING', 'LEAD', 'DEAL']

function databaseError(error) {
  return new TimeManagementError('DATABASE_ERROR', 'CRM 연결 대상을 조회할 수 없습니다.', 500, { cause: error })
}

function matches(label, query) {
  return !query || label.toLocaleLowerCase().includes(query.toLocaleLowerCase())
}

function safeLabel(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

async function searchCrmLinks({ supabase, actor, query = '', types = TYPES, limit = 20 }) {
  requireActiveTimeActor(actor)
  const selected = types.filter(type => TYPES.includes(type))
  const requestLimit = Math.min(limit, 50)
  const work = []

  // The CRM's existing list routes expose all four record types to every
  // authenticated actor. This service mirrors that scope and projects only
  // immutable link snapshots; it deliberately does not add guessed ownership
  // filters that would disagree with those routes.
  if (selected.includes('CONTACT')) {
    let request = supabase.from('contacts').select('id, name')
    if (query) request = request.ilike('name', `%${query}%`)
    work.push(request.limit(requestLimit).then(({ data, error }) => {
      if (error) throw databaseError(error)
      return (data || []).map(row => ({ id: row.id, type: 'CONTACT', label: safeLabel(row.name) }))
    }))
  }
  if (selected.includes('LISTING')) {
    let request = supabase.from('listings').select('id, name')
    if (query) request = request.ilike('name', `%${query}%`)
    work.push(request.limit(requestLimit).then(({ data, error }) => {
      if (error) throw databaseError(error)
      return (data || []).map(row => ({ id: row.id, type: 'LISTING', label: safeLabel(row.name) }))
    }))
  }
  if (selected.includes('LEAD')) {
    work.push(supabase.from('leads').select('id, contact:contacts(name)').limit(requestLimit)
      .then(({ data, error }) => {
        if (error) throw databaseError(error)
        return (data || []).map(row => ({ id: row.id, type: 'LEAD', label: safeLabel(row.contact?.name) }))
          .filter(item => item.label && matches(item.label, query))
      }))
  }
  if (selected.includes('DEAL')) {
    work.push(supabase.from('deals').select('id, contract_date, listing:listings(name)').limit(requestLimit)
      .then(({ data, error }) => {
        if (error) throw databaseError(error)
        return (data || []).map(row => {
          const listing = safeLabel(row.listing?.name)
          const date = safeLabel(row.contract_date)
          return { id: row.id, type: 'DEAL', label: listing && date ? `${listing} — ${date}` : listing }
        }).filter(item => item.label && matches(item.label, query))
      }))
  }

  return (await Promise.all(work)).flat().filter(item => item.label)
}

module.exports = { CRM_LINK_TYPES: TYPES, searchCrmLinks }
