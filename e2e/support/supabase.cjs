const bcrypt = require('bcryptjs')

const IDS = Object.freeze({
  user: '10000000-0000-4000-8000-000000000001',
  agent2: '10000000-0000-4000-8000-000000000002',
  agent3: '10000000-0000-4000-8000-000000000003',
  core: '20000000-0000-4000-8000-000000000001',
  client: '20000000-0000-4000-8000-000000000002',
  plan: '30000000-0000-4000-8000-000000000001',
  allocation: '40000000-0000-4000-8000-000000000001',
  entry: '50000000-0000-4000-8000-000000000001',
  contact: '60000000-0000-4000-8000-000000000001',
  listing: '61000000-0000-4000-8000-000000000001',
  lead: '62000000-0000-4000-8000-000000000001',
  deal: '63000000-0000-4000-8000-000000000001'
})

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)) }
function safeArgs(args) {
  if (!args || typeof args !== 'object') return args
  const hidden = new Set(['reflection_text', 'reflectionText', 'password_hash', 'payload', 'p_request_payload', 'p_notes'])
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, hidden.has(key) ? '[REDACTED]' : value]))
}
function uuid(counter) { return `90000000-0000-4000-8000-${String(counter).padStart(12, '0')}` }

async function initialState(options = {}) {
  const password_hash = await bcrypt.hash('fixture-password', 4)
  const businessDate = '2026-07-29'
  return {
    options,
    counter: 1,
    calls: [], logs: [], outbound: [], controls: { failures: {}, delays: {} }, replay: {}, statusPolls: 0,
    tables: {
      users: [
        { id: IDS.user, name: 'Release Admin', email: 'release-admin@example.test', role: options.role || 'admin', is_active: true, work_mode: 'office', mobile: null, base_salary: 0, password_hash },
        { id: IDS.agent2, name: 'Agent One', email: 'agent-one@example.test', role: 'agent', is_active: true, work_mode: 'office', mobile: null, base_salary: 0, password_hash },
        { id: IDS.agent3, name: 'Agent Two', email: 'agent-two@example.test', role: 'agent', is_active: true, work_mode: 'office', mobile: null, base_salary: 0, password_hash }
      ],
      time_standard_categories: [
        { id: IDS.core, name: 'Core work', description: null, sort_order: 1, is_focus: true, is_active: true },
        { id: IDS.client, name: 'Client service', description: null, sort_order: 2, is_focus: false, is_active: true }
      ],
      time_personal_categories: [],
      time_daily_plans: [{ id: IDS.plan, user_id: IDS.user, business_date: businessDate, available_minutes: 480, is_completed: true, completed_at: `${businessDate}T09:00:00.000Z` }],
      time_plan_allocations: [{ id: IDS.allocation, daily_plan_id: IDS.plan, user_id: IDS.user, standard_category_id: IDS.core, personal_category_id: null, planned_minutes: 420, created_at: `${businessDate}T00:00:00.000Z` }],
      time_entries: [{ id: IDS.entry, user_id: IDS.user, business_date: businessDate, daily_plan_id: IDS.plan, standard_category_id: IDS.core, personal_category_id: null, entry_type: 'MANUAL', started_at: `${businessDate}T00:00:00.000Z`, ended_at: `${businessDate}T01:00:00.000Z`, duration_seconds: 3600, notes: 'Initial note', linked_entity_type: null, linked_entity_id: null, linked_entity_label: null, time_standard_categories: { is_focus: true } }],
      time_entry_revisions: [{ id: '70000000-0000-4000-8000-000000000001', entry_id: IDS.entry, user_id: IDS.user, changed_by: IDS.user, changed_at: `${businessDate}T01:05:00.000Z`, before_value: { notes: 'Old note' }, after_value: { notes: 'Initial note' } }],
      time_reflections: [
        { id: '80000000-0000-4000-8000-000000000002', user_id: IDS.agent2, business_date: businessDate, reflection_text: 'Safe seeded reflection', version: 1 },
        { id: '80000000-0000-4000-8000-000000000003', user_id: IDS.agent3, business_date: businessDate, reflection_text: 'Safe seeded reflection', version: 1 }
      ],
      time_ai_reviews: [
        { id: '81000000-0000-4000-8000-000000000002', reflection_id: '80000000-0000-4000-8000-000000000002', reflection_version: 1, user_id: IDS.agent2, keywords: ['follow-up'], summary: 'Safe review' },
        { id: '81000000-0000-4000-8000-000000000003', reflection_id: '80000000-0000-4000-8000-000000000003', reflection_version: 1, user_id: IDS.agent3, keywords: ['follow-up'], summary: 'Safe review' }
      ],
      time_jobs: options.reminderDate ? [{ id: '82000000-0000-4000-8000-000000000001', user_id: IDS.user, job_type: 'REMINDER_PUSH', dedupe_key: `${IDS.user}:${options.reminderDate}`, payload: { businessDate: options.reminderDate }, status: 'COMPLETED', created_at: `${options.reminderDate}T10:00:00.000Z` }] : [],
      time_team_keyword_aggregates: [],
      contacts: [{ id: IDS.contact, name: 'Safe Fixture Contact', type: 'OWNER', status: 'ACTIVE', mobile: '000-TEST', email: 'safe@example.test', assigned_user_id: IDS.user, created_by: IDS.user }],
      listings: [{ id: IDS.listing, code: 'LIST-1', name: 'Safe Fixture Listing', transaction_type: 'RENT', property_type: 'CONDO', status: 'ACTIVE', price: 1000, assigned_user_id: IDS.user }],
      leads: [{ id: IDS.lead, contact_id: IDS.contact, request_type: 'RENT', status: 'NEW', assigned_user_id: IDS.user, next_followup_at: businessDate }],
      deals: [{ id: IDS.deal, listing_id: IDS.listing, contract_type: 'RENT', contract_date: businessDate, gross_commission: 100, total_agent_fees: 10, net_company_income: 90 }],
      expenses: [], activities: [], v_leads_followup: [], v_staff_commission_monthly: [], v_monthly_pl: [],
      time_reminder_preferences: [], time_notification_preferences: [], time_push_subscriptions: [],
      staff: [], listing_reports: [], lois: [], acknowledgements: [],
      pms_payments: [], pms_care: [], pms_auth_map: [], pms_accounts: [], pms_documents: [], notifications: []
    },
    storage: []
  }
}

class Query {
  constructor(owner, table) {
    this.owner = owner; this.table = table; this.filters = []; this.mode = 'select'; this.values = null
    this.limitCount = null; this.rangeValue = null; this.singleMode = null; this.countRequested = false
  }
  select(_columns, options = {}) { this.countRequested = Boolean(options.count); return this }
  insert(values) { this.mode = 'insert'; this.values = values; return this }
  update(values) { this.mode = 'update'; this.values = values; return this }
  upsert(values) { this.mode = 'upsert'; this.values = values; return this }
  delete() { this.mode = 'delete'; return this }
  eq(key, value) { this.filters.push(row => row[key] === value); return this }
  neq(key, value) { this.filters.push(row => row[key] !== value); return this }
  is(key, value) { this.filters.push(row => row[key] === value); return this }
  in(key, values) { this.filters.push(row => values.includes(row[key])); return this }
  gte(key, value) { this.filters.push(row => row[key] >= value); return this }
  lte(key, value) { this.filters.push(row => row[key] <= value); return this }
  ilike(key, pattern) { const needle = String(pattern).replaceAll('%', '').toLowerCase(); this.filters.push(row => String(row[key] || '').toLowerCase().includes(needle)); return this }
  not() { return this }
  or() { return this }
  contains(key, value) { this.filters.push(row => Object.entries(value).every(([k, v]) => row[key]?.[k] === v)); return this }
  order() { return this }
  limit(value) { this.limitCount = Number(value); return this }
  range(from, to) { this.rangeValue = [Number(from), Number(to)]; return this }
  single() { this.singleMode = 'single'; return this.execute() }
  maybeSingle() { this.singleMode = 'maybe'; return this.execute() }
  then(resolve, reject) { return this.execute().then(resolve, reject) }
  async execute() {
    const state = this.owner.state
    state.calls.push({ operation: this.mode, target: this.table, args: safeArgs(this.values) })
    let rows = state.tables[this.table] || []
    const matches = row => this.filters.every(filter => filter(row))
    let selected = rows.filter(matches)
    if (this.mode === 'insert') {
      const input = Array.isArray(this.values) ? this.values : [this.values]
      const inserted = input.map(value => ({
        id: value.id || uuid(state.counter++), created_at: value.created_at || new Date().toISOString(),
        ...(this.table === 'time_reflections' ? { version: 1 } : {}),
        ...(this.table === 'time_jobs' ? { status: 'PENDING', attempts: 0 } : {}),
        ...clone(value)
      }))
      if (this.table === 'time_jobs' && rows.some(row => inserted.some(item => row.job_type === item.job_type && row.dedupe_key === item.dedupe_key))) return { data: null, error: { code: '23505' } }
      rows.push(...inserted); selected = inserted
    } else if (this.mode === 'update') {
      selected.forEach(row => Object.assign(row, clone(this.values))); selected = rows.filter(matches)
    } else if (this.mode === 'delete') {
      state.tables[this.table] = rows.filter(row => !matches(row)); selected = []
    } else if (this.mode === 'upsert') {
      const input = Array.isArray(this.values) ? this.values : [this.values]
      for (const value of input) { const existing = rows.find(row => row.id === value.id); existing ? Object.assign(existing, clone(value)) : rows.push({ id: value.id || uuid(state.counter++), ...clone(value) }) }
      selected = input
    }
    if (this.table === 'time_jobs' && this.mode === 'select' && this.singleMode && selected[0]?.status === 'PENDING') {
      state.statusPolls += 1
      if (state.statusPolls >= 2) {
        selected[0].status = 'COMPLETED'
        const reflection = state.tables.time_reflections.find(item => `${item.id}:${item.version}` === selected[0].dedupe_key)
        if (reflection && !state.tables.time_ai_reviews.some(item => item.reflection_id === reflection.id && item.reflection_version === reflection.version)) {
          state.tables.time_ai_reviews.push({ id: uuid(state.counter++), reflection_id: reflection.id, reflection_version: reflection.version, user_id: reflection.user_id, keywords: ['follow-up'], summary: 'Safe deterministic review', wins: [], blockers: [], next_actions: [] })
        }
      }
    }
    if (this.rangeValue) selected = selected.slice(this.rangeValue[0], this.rangeValue[1] + 1)
    if (this.limitCount != null) selected = selected.slice(0, this.limitCount)
    const count = selected.length
    if (this.singleMode) {
      const data = selected[0] || null
      return { data: clone(data), error: data || this.singleMode === 'maybe' ? null : { code: 'PGRST116', message: 'Not found' }, count }
    }
    return { data: clone(selected), error: null, count }
  }
}

class FakeSupabase {
  constructor(state) { this.state = state }
  from(table) { return new Query(this, table) }
  async rpc(name, args = {}) {
    const state = this.state
    state.calls.push({ operation: 'rpc', target: name, args: safeArgs(args) })
    const delay = state.controls.delays[name]
    if (delay) { delete state.controls.delays[name]; await new Promise(resolve => setTimeout(resolve, delay)) }
    const failure = state.controls.failures[name]
    if (failure) { delete state.controls.failures[name]; return { data: null, error: failure } }
    if (name === 'time_get_command_replay') {
      const replay = state.replay[`${args.p_user_id}:${args.p_request_id}`]
      return { data: replay ? [{ response_payload: clone(replay) }] : [], error: null }
    }
    if (name === 'time_save_daily_plan') {
      let plan = state.tables.time_daily_plans.find(item => item.user_id === args.p_user_id && item.business_date === args.p_business_date)
      if (!plan) { plan = { id: uuid(state.counter++), user_id: args.p_user_id, business_date: args.p_business_date }; state.tables.time_daily_plans.push(plan) }
      Object.assign(plan, { available_minutes: args.p_available_minutes, is_completed: true })
      state.tables.time_plan_allocations = state.tables.time_plan_allocations.filter(item => item.daily_plan_id !== plan.id)
      for (const allocation of args.p_allocations) state.tables.time_plan_allocations.push({ id: uuid(state.counter++), daily_plan_id: plan.id, user_id: args.p_user_id, standard_category_id: allocation.standardCategoryId, personal_category_id: allocation.personalCategoryId || null, planned_minutes: allocation.plannedMinutes })
      return { data: [clone(plan)], error: null }
    }
    if (name === 'time_search_crm_links') return { data: [{ type: 'CONTACT', id: IDS.contact, label: 'Safe Fixture Contact' }], error: null }
    if (name === 'time_resolve_crm_link') return { data: [{ type: args.p_type, id: args.p_id, label: 'Safe Fixture Contact' }], error: null }
    if (['time_start_timer', 'time_switch_timer'].includes(name)) {
      const stopped = state.tables.time_entries.find(entry => entry.user_id === args.p_user_id && entry.entry_type === 'TIMER' && entry.ended_at === null)
      if (stopped) { stopped.ended_at = args.p_started_at || new Date().toISOString(); stopped.duration_seconds = 60 }
      const entry = { id: uuid(state.counter++), user_id: args.p_user_id, business_date: '2026-07-29', daily_plan_id: args.p_daily_plan_id, standard_category_id: args.p_standard_category_id, personal_category_id: args.p_personal_category_id, entry_type: 'TIMER', started_at: args.p_started_at || new Date().toISOString(), ended_at: null, duration_seconds: null, notes: null, linked_entity_type: args.p_contact_id ? 'CONTACT' : null, linked_entity_id: args.p_contact_id, linked_entity_label: args.p_contact_id ? 'Safe Fixture Contact' : null }
      state.tables.time_entries.push(entry)
      const result = { stopped_entry_id: stopped?.id || null, started_entry_id: entry.id, replayed: false }
      state.replay[`${args.p_user_id}:${args.p_request_id}`] = result
      return { data: [result], error: null }
    }
    if (name === 'time_stop_timer') {
      const entry = state.tables.time_entries.find(item => item.user_id === args.p_user_id && item.entry_type === 'TIMER' && item.ended_at === null)
      if (!entry) return { data: null, error: { code: 'P0002' } }
      entry.ended_at = args.p_stopped_at || new Date().toISOString(); entry.duration_seconds = 60
      const result = { stopped_entry_id: entry.id, replayed: false }; state.replay[`${args.p_user_id}:${args.p_request_id}`] = result
      return { data: [result], error: null }
    }
    if (name === 'time_create_manual_entry') {
      const entry = { id: uuid(state.counter++), user_id: args.p_user_id, business_date: '2026-07-29', standard_category_id: args.p_standard_category_id, personal_category_id: args.p_personal_category_id, entry_type: 'MANUAL', started_at: args.p_started_at, ended_at: args.p_ended_at, duration_seconds: Math.round((Date.parse(args.p_ended_at) - Date.parse(args.p_started_at)) / 1000), notes: args.p_notes, linked_entity_type: null, linked_entity_id: null, linked_entity_label: null }
      state.tables.time_entries.push(entry); const result = { entry_id: entry.id, replayed: false }; state.replay[`${args.p_user_id}:${args.p_request_id}`] = result
      return { data: [result], error: null }
    }
    if (name === 'time_revise_entry') {
      const entry = state.tables.time_entries.find(item => item.id === args.p_entry_id && item.user_id === args.p_user_id)
      if (!entry) return { data: null, error: { code: 'P0002' } }
      const before = clone(entry); if (args.p_patch_fields.includes('notes')) entry.notes = args.p_notes
      const revision = { id: uuid(state.counter++), entry_id: entry.id, user_id: args.p_user_id, changed_by: args.p_user_id, changed_at: new Date().toISOString(), before_value: before, after_value: clone(entry) }
      state.tables.time_entry_revisions.push(revision); const result = { entry_id: entry.id, revision_id: revision.id, replayed: false }; state.replay[`${args.p_user_id}:${args.p_request_id}`] = result
      return { data: [result], error: null }
    }
    return { data: [], error: null }
  }
  get storage() {
    const state = this.state
    return { from(bucket) { return {
      async upload(path, data) { state.calls.push({ operation: 'storage.upload', target: bucket, args: { path, size: data?.size } }); state.storage.push({ bucket, path }); return { data: { path }, error: null } },
      async remove(paths) { state.calls.push({ operation: 'storage.remove', target: bucket, args: { paths } }); return { data: [], error: null } },
      getPublicUrl(path) { return { data: { publicUrl: `/safe-fixtures/${path.split('/').pop()}` } } }
    } } }
  }
}

async function createFixture(options) { const state = await initialState(options); return { state, supabase: new FakeSupabase(state) } }
module.exports = { createFixture, FakeSupabase, IDS }
