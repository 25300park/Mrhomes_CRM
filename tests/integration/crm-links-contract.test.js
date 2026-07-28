const jwt = require('jsonwebtoken')
const request = require('supertest')
const { createTestApp } = require('../helpers/app')

function literalLikeMatch(value, pattern) {
  const needle = pattern.slice(1, -1).replace(/\\([%_\\])/g, '$1')
  return value.toLocaleLowerCase().includes(needle.toLocaleLowerCase())
}

function crmFake(actor, { rows = {}, errors = {} } = {}) {
  const calls = []
  return {
    calls,
    supabase: {
      from(table) {
        const state = { offset: 0, limit: undefined, ilike: null }
        const query = {
          select(columns) { calls.push({ table, operation: 'select', columns }); return query },
          eq(column, value) { calls.push({ table, operation: 'eq', column, value }); return query },
          ilike(column, pattern) { state.ilike = { column, pattern }; calls.push({ table, operation: 'ilike', column, pattern }); return query },
          order(column) { calls.push({ table, operation: 'order', column }); return query },
          range(from, to) { state.offset = from; state.limit = to - from + 1; calls.push({ table, operation: 'range', from, to }); return query },
          limit(limit) { state.limit = limit; calls.push({ table, operation: 'limit', limit }); return query },
          single() { return Promise.resolve(table === 'users' ? { data: actor, error: null } : { data: null, error: { code: 'PGRST116' } }) },
          then(resolve, reject) {
            if (errors[table]) return Promise.resolve({ data: null, error: errors[table] }).then(resolve, reject)
            let data = [...(rows[table] || [])]
            if (state.ilike?.column === 'name') data = data.filter(row => literalLikeMatch(row.name, state.ilike.pattern))
            if (state.ilike?.column === 'contact.name') data = data.filter(row => literalLikeMatch(row.contact?.name || '', state.ilike.pattern))
            if (state.ilike?.column === 'listing.name') data = data.filter(row => literalLikeMatch(row.listing?.name || '', state.ilike.pattern))
            if (state.limit !== undefined) data = data.slice(state.offset, state.offset + state.limit)
            return Promise.resolve({ data, error: null }).then(resolve, reject)
          }
        }
        return query
      }
    }
  }
}

function bearer(actor) {
  return `Bearer ${jwt.sign({ id: actor.id }, process.env.JWT_SECRET)}`
}

test('CRM link search applies one deterministic limit across all selected types', async () => {
  const actor = { id: 'agent-1', role: 'agent', is_active: true }
  const fixture = crmFake(actor, { rows: {
    contacts: [{ id: 'contact-z', name: 'Zulu' }],
    listings: [{ id: 'listing-a', name: 'Alpha' }],
    leads: [{ id: 'lead-b', contact: { name: 'Bravo' } }],
    deals: [{ id: 'deal-c', contract_date: '2026-07-01', listing: { name: 'Charlie' } }]
  } })
  const response = await request(createTestApp({ supabase: fixture.supabase }))
    .get('/api/time-management/crm-links?types=contact,listing,lead,deal&limit=2')
    .set('Authorization', bearer(actor))

  expect(response.status).toBe(200)
  expect(response.body.data).toEqual([
    { id: 'listing-a', type: 'LISTING', label: 'Alpha' },
    { id: 'lead-b', type: 'LEAD', label: 'Bravo' }
  ])
})

test('CRM link search finds a lead match beyond the first client page before applying the final limit', async () => {
  const actor = { id: 'agent-1', role: 'agent', is_active: true }
  const leads = Array.from({ length: 21 }, (_value, index) => ({
    id: `lead-${index + 1}`,
    contact: { name: index === 20 ? 'Needle client' : `Other ${index + 1}` }
  }))
  const fixture = crmFake(actor, { rows: { leads } })
  const response = await request(createTestApp({ supabase: fixture.supabase }))
    .get('/api/time-management/crm-links?q=needle&types=lead&limit=1')
    .set('Authorization', bearer(actor))

  expect(response.status).toBe(200)
  expect(response.body.data).toEqual([{ id: 'lead-21', type: 'LEAD', label: 'Needle client' }])
  expect(fixture.calls).toContainEqual({ table: 'leads', operation: 'ilike', column: 'contact.name', pattern: '%needle%' })
})

test('CRM link search treats ILIKE wildcard characters as literal search text', async () => {
  const actor = { id: 'agent-1', role: 'agent', is_active: true }
  const fixture = crmFake(actor, { rows: { contacts: [{ id: 'percent', name: '100% complete' }] } })
  const response = await request(createTestApp({ supabase: fixture.supabase }))
    .get('/api/time-management/crm-links?q=%25&types=contact')
    .set('Authorization', bearer(actor))

  expect(response.status).toBe(200)
  expect(response.body.data).toEqual([{ id: 'percent', type: 'CONTACT', label: '100% complete' }])
  expect(fixture.calls).toContainEqual({ table: 'contacts', operation: 'ilike', column: 'name', pattern: '%\\%%' })
  for (const call of fixture.calls.filter(call => call.operation === 'select' && call.table !== 'users')) {
    expect(call.columns).not.toMatch(/mobile|address|remarks|gross_commission/i)
  }
})

test('CRM link search maps CRM query failures to a stable database error', async () => {
  const actor = { id: 'agent-1', role: 'agent', is_active: true }
  const fixture = crmFake(actor, { errors: { contacts: { code: '42501', message: 'denied' } } })
  const response = await request(createTestApp({ supabase: fixture.supabase }))
    .get('/api/time-management/crm-links?types=contact')
    .set('Authorization', bearer(actor))

  expect(response.status).toBe(500)
  expect(response.body.error.code).toBe('DATABASE_ERROR')
})
