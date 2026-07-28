const { TimeManagementError } = require('./errors')
const { requireActiveTimeActor } = require('./access-policy')

const TYPES = ['CONTACT', 'LISTING', 'LEAD', 'DEAL']

function databaseError(error) {
  return new TimeManagementError('DATABASE_ERROR', 'CRM 연결 대상을 조회할 수 없습니다.', 500, { cause: error })
}

function safeLabel(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, '\\$&')
}

function sortLinks(left, right) {
  return left.label.localeCompare(right.label) || left.type.localeCompare(right.type) || left.id.localeCompare(right.id)
}

async function searchCrmLinks({ supabase, actor, query = '', types = TYPES, limit = 20 }) {
  requireActiveTimeActor(actor)
  const selected = types.filter(type => TYPES.includes(type))
  const requestLimit = Math.min(limit, 50)
  const pattern = query ? `%${escapeLike(query)}%` : null
  const work = []

  // The CRM's existing list routes expose all four record types to every
  // authenticated actor. This service mirrors that scope and projects only
  // immutable link snapshots; it deliberately does not add guessed ownership
  // filters that would disagree with those routes. Every query is ordered by
  // the same label fields used below, so retrieving `limit` candidates per
  // type is sufficient before the deterministic whole-result limit is applied.
  if (selected.includes('CONTACT')) {
    let request = supabase.from('contacts').select('id, name')
    if (pattern) request = request.ilike('name', pattern)
    work.push(request.order('name', { ascending: true }).order('id', { ascending: true }).limit(requestLimit).then(({ data, error }) => {
      if (error) throw databaseError(error)
      return (data || []).map(row => ({ id: row.id, type: 'CONTACT', label: safeLabel(row.name) }))
    }))
  }
  if (selected.includes('LISTING')) {
    let request = supabase.from('listings').select('id, name')
    if (pattern) request = request.ilike('name', pattern)
    work.push(request.order('name', { ascending: true }).order('id', { ascending: true }).limit(requestLimit).then(({ data, error }) => {
      if (error) throw databaseError(error)
      return (data || []).map(row => ({ id: row.id, type: 'LISTING', label: safeLabel(row.name) }))
    }))
  }
  if (selected.includes('LEAD')) {
    let request = supabase.from('leads').select('id, contact:contacts!inner(name)')
    if (pattern) request = request.ilike('contact.name', pattern)
    work.push(request.order('name', { referencedTable: 'contact', ascending: true }).order('id', { ascending: true }).limit(requestLimit)
      .then(({ data, error }) => {
        if (error) throw databaseError(error)
        return (data || []).map(row => ({ id: row.id, type: 'LEAD', label: safeLabel(row.contact?.name) })).filter(item => item.label)
      }))
  }
  if (selected.includes('DEAL')) {
    let request = supabase.from('deals').select('id, contract_date, listing:listings!inner(name)')
    if (pattern) request = request.ilike('listing.name', pattern)
    work.push(request.order('name', { referencedTable: 'listing', ascending: true }).order('contract_date', { ascending: true }).order('id', { ascending: true }).limit(requestLimit)
      .then(({ data, error }) => {
        if (error) throw databaseError(error)
        return (data || []).map(row => {
          const listing = safeLabel(row.listing?.name)
          const date = safeLabel(row.contract_date)
          return { id: row.id, type: 'DEAL', label: listing && date ? `${listing} — ${date}` : listing }
        }).filter(item => item.label)
      }))
  }

  return (await Promise.all(work)).flat().filter(item => item.label).sort(sortLinks).slice(0, requestLimit)
}

module.exports = { CRM_LINK_TYPES: TYPES, escapeLike, searchCrmLinks }
