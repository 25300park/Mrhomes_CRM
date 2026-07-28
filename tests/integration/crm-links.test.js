const jwt = require('jsonwebtoken')
const request = require('supertest')
const { createTestApp } = require('../helpers/app')

function createCrmLinkSupabase(actor) {
  const rows = {
    contacts: [{ id: 'contact-1', name: 'Jane Client', mobile: 'secret' }],
    listings: [{ id: 'listing-1', name: 'Riverside Tower', address: 'secret' }],
    leads: [{ id: 'lead-1', contact: { name: 'Jane Client' }, remarks: 'secret' }],
    deals: [{ id: 'deal-1', contract_date: '2026-07-01', listing: { name: 'Riverside Tower' }, gross_commission: 999 }]
  }

  return {
    from(table) {
      const state = { filters: [] }
      const query = {
        select() { return query },
        eq(column, value) { state.filters.push([column, value]); return query },
        ilike() { return query },
        limit() { return query },
        single() {
          if (table === 'users') return Promise.resolve({ data: actor, error: null })
          return Promise.resolve({ data: null, error: { message: 'not found' } })
        },
        then(resolve, reject) {
          return Promise.resolve({ data: rows[table] || [], error: null }).then(resolve, reject)
        }
      }
      return query
    }
  }
}

test('CRM link search returns only safe labels for the CRM records visible to an active actor', async () => {
  const actor = { id: 'agent-1', role: 'agent', is_active: true }
  const token = jwt.sign({ id: actor.id }, process.env.JWT_SECRET)
  const response = await request(createTestApp({ supabase: createCrmLinkSupabase(actor) }))
    .get('/api/time-management/crm-links?types=contact,listing,lead,deal')
    .set('Authorization', `Bearer ${token}`)

  expect(response.status).toBe(200)
  expect(response.body.data).toEqual([
    { id: 'contact-1', type: 'CONTACT', label: 'Jane Client' },
    { id: 'listing-1', type: 'LISTING', label: 'Riverside Tower' },
    { id: 'lead-1', type: 'LEAD', label: 'Jane Client' },
    { id: 'deal-1', type: 'DEAL', label: 'Riverside Tower — 2026-07-01' }
  ])
  for (const item of response.body.data) {
    expect(Object.keys(item).sort()).toEqual(['id', 'label', 'type'])
  }
})

test('CRM link search validates query parameters before querying CRM tables', async () => {
  const actor = { id: 'agent-1', role: 'agent', is_active: true }
  const token = jwt.sign({ id: actor.id }, process.env.JWT_SECRET)
  const response = await request(createTestApp({ supabase: createCrmLinkSupabase(actor) }))
    .get('/api/time-management/crm-links?q=&types=invoice')
    .set('Authorization', `Bearer ${token}`)

  expect(response.status).toBe(400)
  expect(response.body.error.code).toBe('INVALID_REQUEST')
})
