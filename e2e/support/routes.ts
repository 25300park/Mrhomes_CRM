import type { Page, Route } from '@playwright/test'

export type FixtureState = {
  calls: Array<{ method: string, path: string, body: unknown }>
  externalRequests: string[]
  activeTimer: Record<string, unknown> | null
  failNext(path: string, status?: number): void
  setServerTimer(timer: Record<string, unknown> | null): void
}

const core = { id: 'category-core', name: 'Core work' }
const client = { id: 'category-client', name: 'Client service' }
const entry = {
  id: 'entry-existing', started_at: '2026-07-29T00:00:00.000Z', ended_at: '2026-07-29T01:00:00.000Z',
  standard_category_id: core.id, notes: 'Initial note', linked_entity_id: null, linked_entity_label: null,
  revisions: [{ id: 'revision-1', changedAt: '2026-07-29T01:05:00.000Z', changedBySelf: true, changedFields: ['notes'] }]
}

async function respond(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

export async function installSafeRoutes(page: Page, options: { role?: 'admin' | 'agent', reminderDate?: string } = {}): Promise<FixtureState> {
  const calls: FixtureState['calls'] = []
  const externalRequests: string[] = []
  const failures = new Map<string, number>()
  const duplicateResults = new Map<string, Record<string, unknown>>()
  let activeTimer: Record<string, unknown> | null = null
  let reflectionText = ''
  let reflectionStatus = 'NOT_STARTED'
  let statusPolls = 0
  const state: FixtureState = {
    calls, externalRequests, activeTimer,
    failNext(path, status = 503) { failures.set(path, status) },
    setServerTimer(timer) { activeTimer = timer; state.activeTimer = timer }
  }

  await page.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin !== 'http://127.0.0.1:4177') {
      externalRequests.push(request.url())
      return route.abort('blockedbyclient')
    }
    if (!url.pathname.startsWith('/api/') || url.pathname.startsWith('/api/auth/')) return route.fallback()
    let body: unknown
    try { body = request.postDataJSON() } catch { body = request.postData() }
    calls.push({ method: request.method(), path: `${url.pathname}${url.search}`, body })
    const failure = failures.get(url.pathname)
    if (failure) { failures.delete(url.pathname); return respond(route, { error: { code: 'SAFE_FIXTURE_FAILURE', message: 'Deterministic failure' } }, failure) }

    if (url.pathname.startsWith('/api/time-management/')) {
      const path = url.pathname.slice('/api/time-management'.length)
      if (path === '/session') return respond(route, { role: options.role ?? 'admin' })
      if (path === '/csrf') return respond(route, { csrfToken: 'fixture-csrf-token' })
      if (path === '/categories') return respond(route, { standard: [core, client], personal: [] })
      if (path.startsWith('/plans/')) return request.method() === 'PUT'
        ? respond(route, { warning: null, plan: { available_minutes: 480 } })
        : respond(route, { plan: { available_minutes: 480 }, allocations: [{ standard_category_id: core.id, planned_minutes: 420 }], varianceMinutes: 0 })
      if (path === '/crm-links') return respond(route, { data: [{ type: 'contact', id: 'contact-1', label: 'Safe Fixture Contact' }] })
      if (path === '/entries/timer/reconcile') return respond(route, { matches: true, authoritativeEntry: activeTimer })
      if (path === '/entries/timer/start' || path === '/entries/timer/switch') {
        const value = body as { requestId: string, standardCategoryId: string, crmLink?: { type: string, id: string } }
        if (duplicateResults.has(value.requestId)) {
          activeTimer = duplicateResults.get(value.requestId)!
          state.activeTimer = activeTimer
          return respond(route, { entry: activeTimer })
        }
        const startedAt = new Date(Date.parse('2026-07-29T00:00:00.000Z') + duplicateResults.size * 60_000).toISOString()
        activeTimer = {
          id: `entry-${duplicateResults.size + 1}`, standard_category_id: value.standardCategoryId,
          started_at: startedAt, linked_entity_type: value.crmLink?.type ?? null,
          linked_entity_id: value.crmLink?.id ?? null, linked_entity_label: value.crmLink ? 'Safe Fixture Contact' : null
        }
        state.activeTimer = activeTimer
        duplicateResults.set(value.requestId, activeTimer)
        return respond(route, { entry: activeTimer }, path.endsWith('/start') ? 201 : 200)
      }
      if (path === '/entries/timer/stop') { activeTimer = null; state.activeTimer = null; return respond(route, { stopped: true }) }
      if (path === '/entries') return respond(route, { entries: [entry] })
      if (path === '/entries/manual') return respond(route, { entry: { id: 'entry-manual' } }, 201)
      if (path.startsWith('/entries/')) return respond(route, { entry: { ...entry, notes: (body as { notes?: string })?.notes ?? entry.notes } })
      if (path === '/reflections/today/status') {
        if (reflectionStatus === 'PROCESSING' && ++statusPolls >= 2) reflectionStatus = 'COMPLETED'
        return respond(route, { status: reflectionStatus })
      }
      if (path === '/reflections/today') {
        if (request.method() === 'PUT') {
          reflectionText = (body as { reflectionText: string }).reflectionText
          reflectionStatus = 'PROCESSING'; statusPolls = 0
          return respond(route, { reflection: { reflection_text: reflectionText }, ai: { status: 'PROCESSING' } }, 201)
        }
        return respond(route, { reflection: reflectionText ? { reflection_text: reflectionText } : null, review: reflectionStatus === 'COMPLETED' ? { summary: 'Safe deterministic review' } : null })
      }
      if (path === '/reflections/today/retry') { reflectionStatus = 'PROCESSING'; statusPolls = 0; return respond(route, { ai: { status: 'PROCESSING' } }, 201) }
      if (path === '/analytics/personal/today') return respond(route, { metrics: { completion: { plan: true, time: true, reflection: true }, planVarianceMinutes: -60, coreWorkRatio: 0.75 } })
      if (path.startsWith('/analytics/admin/members/')) return respond(route, [{ user: { id: 'agent-1', name: 'Agent One' }, metrics: { completion: { plan: true, time: true }, planVarianceMinutes: 0, coreWorkRatio: 0.8 } }])
      if (path === '/analytics/admin/team-keywords') return respond(route, { keywords: [{ keyword: 'follow-up', contributorCount: 2, occurrenceCount: 3 }] })
      if (path === '/push/reminders/pending') return respond(route, { reminders: options.reminderDate ? [{ businessDate: options.reminderDate }] : [] })
      if (path === '/push/vapid-public-key') return respond(route, { publicKey: 'BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })
      if (path === '/push/subscriptions') return respond(route, { subscription: { id: 'safe-subscription', endpoint: 'https://push.example.test/safe', is_active: true } }, 201)
      return respond(route, { error: { code: 'NOT_FOUND', message: 'Unknown fixture route' } }, 404)
    }

    if (url.pathname === '/api/dashboard') return respond(route, { kpi: { contacts: 0, active_listings: 0, active_leads: 0, gross_commission: 0, deal_count: 0 }, followup_needed: [], active_listings: [], recent_deals: [], pipeline: { NEW: 0, SEARCHING: 0, OFFER_SENT: 0, NEGOTIATING: 0 } })
    if (url.pathname.startsWith('/api/contacts')) return respond(route, { data: [], total: 0 })
    if (url.pathname.startsWith('/api/listings') || url.pathname.startsWith('/api/leads') || url.pathname.startsWith('/api/deals')) return respond(route, [])
    if (url.pathname.startsWith('/api/staff/performance') || url.pathname.startsWith('/api/staff')) return respond(route, [])
    if (url.pathname.startsWith('/api/accounting/summary')) return respond(route, { income: { gross: 0, deal_count: 0, agent_fees: 0 }, expenses: { total: 0, items: [], by_category: {} }, profit: 0, deals: [] })
    if (url.pathname.startsWith('/api/listing-reports') || url.pathname.startsWith('/api/loi') || url.pathname.startsWith('/api/ack')) return respond(route, [])
    if (url.pathname === '/api/pms-payments/stats') return respond(route, { awaiting: 0, paid: 0, overdue: 0, totalPaid: 0 })
    if (url.pathname.startsWith('/api/pms-payments') || url.pathname.startsWith('/api/pms-care') || url.pathname.startsWith('/api/notifications') || url.pathname.startsWith('/api/activities')) return respond(route, [])
    if (url.pathname.startsWith('/api/upload/')) return respond(route, { url: '/safe-fixtures/upload.jpg' }, 201)
    return respond(route, { error: 'Unknown safe CRM fixture route' }, 404)
  })
  return state
}
