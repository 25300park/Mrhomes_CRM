const { TimeManagementError } = require('./errors')
const { requireActiveTimeActor } = require('./access-policy')
const { DEFAULT_BUSINESS_TIME_ZONE } = require('./time')

const LINK_COLUMNS = { CONTACT: 'contact', LISTING: 'listing', LEAD: 'lead', DEAL: 'deal' }

function mapDatabaseError(error) {
  const constraint = error?.constraint || error?.details || ''
  if (error?.code === 'P0003') return new TimeManagementError('CRM_LINK_NOT_FOUND', '연결할 수 있는 CRM 항목을 찾을 수 없습니다.', 404)
  if (error?.code === 'P0002') return new TimeManagementError('ACTIVE_TIMER_NOT_FOUND', '진행 중인 타이머를 찾을 수 없습니다.', 404)
  if (error?.code === '23505' && String(constraint).includes('active_user')) return new TimeManagementError('ACTIVE_TIMER_EXISTS', '이미 진행 중인 타이머가 있습니다.', 409)
  if (error?.code === '23505') return new TimeManagementError('REQUEST_ID_CONFLICT', '이미 다른 요청에 사용된 요청 ID입니다.', 409)
  if (error?.code === '23P01' || (error?.code === '23514' && String(constraint).includes('overlap'))) return new TimeManagementError('TIME_ENTRY_OVERLAP', '업무 기록 시간이 기존 기록과 겹칩니다.', 409)
  if (error?.code === '23503' || error?.code === '23514') return new TimeManagementError('INVALID_TIME_ENTRY', '업무 기록 조건이 올바르지 않습니다.', 422)
  if (error?.code === '42501') return new TimeManagementError('FORBIDDEN', '업무 기록에 접근할 수 없습니다.', 403)
  return new TimeManagementError('DATABASE_ERROR', '업무 기록을 처리할 수 없습니다.', 500, { cause: error })
}

async function resolveCrmLink(supabase, crmLink) {
  if (!crmLink) return null
  const { data, error } = await supabase.rpc('time_resolve_crm_link', { p_type: crmLink.type, p_id: crmLink.id })
  if (error) throw mapDatabaseError(error)
  const resolved = Array.isArray(data) ? data[0] : data
  if (!resolved || resolved.id !== crmLink.id || resolved.type !== crmLink.type || !resolved.label?.trim()) {
    throw new TimeManagementError('CRM_LINK_NOT_FOUND', '연결할 수 있는 CRM 항목을 찾을 수 없습니다.', 404)
  }
  return { type: resolved.type, id: resolved.id, label: resolved.label.trim() }
}

function linkArguments(link) {
  const values = { p_contact_id: null, p_listing_id: null, p_lead_id: null, p_deal_id: null, p_linked_entity_label: null }
  if (!link) return values
  values[`p_${LINK_COLUMNS[link.type]}_id`] = link.id
  return values
}

function compactPayload(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null))
}

function canonicalTimestamp(value) {
  return value == null ? value : new Date(value).toISOString()
}

function canonicalCrmLink(crmLink) {
  return crmLink ? { type: crmLink.type, id: crmLink.id } : crmLink
}

async function getCommandReplay(supabase, actor, requestId, commandType, requestPayload) {
  const { data, error } = await supabase.rpc('time_get_command_replay', {
    p_user_id: actor.id,
    p_request_id: requestId,
    p_command_type: commandType,
    p_request_payload: compactPayload(requestPayload)
  })
  if (error) throw mapDatabaseError(error)
  const row = Array.isArray(data) ? data[0] : data
  return row?.response_payload ? { ...row.response_payload, replayed: true } : null
}

function timerArguments(actor, input, link, timestampKey) {
  return {
    p_user_id: actor.id,
    p_actor_role: actor.role,
    p_request_id: input.requestId,
    p_standard_category_id: input.standardCategoryId,
    p_personal_category_id: input.personalCategoryId ?? null,
    p_daily_plan_id: input.dailyPlanId ?? null,
    ...linkArguments(link),
    [timestampKey]: input.commandAt ?? null,
    p_business_time_zone: DEFAULT_BUSINESS_TIME_ZONE
  }
}

async function runTimer({ supabase, actor, input, rpc, timestampKey }) {
  requireActiveTimeActor(actor)
  const commandType = rpc === 'time_start_timer' ? 'START' : 'SWITCH'
  const replay = await getCommandReplay(supabase, actor, input.requestId, commandType, {
    standardCategoryId: input.standardCategoryId,
    personalCategoryId: input.personalCategoryId,
    dailyPlanId: input.dailyPlanId,
    crmLink: canonicalCrmLink(input.crmLink),
    commandAt: canonicalTimestamp(input.commandAt),
    businessTimeZone: DEFAULT_BUSINESS_TIME_ZONE
  })
  if (replay) return replay
  const { data, error } = await supabase.rpc(rpc, timerArguments(actor, input, input.crmLink, timestampKey))
  if (error) throw mapDatabaseError(error)
  return Array.isArray(data) ? data[0] : data
}

function startTimer(args) { return runTimer({ ...args, rpc: 'time_start_timer', timestampKey: 'p_started_at' }) }
function switchTimer(args) { return runTimer({ ...args, rpc: 'time_switch_timer', timestampKey: 'p_started_at' }) }

async function stopTimer({ supabase, actor, input }) {
  requireActiveTimeActor(actor)
  const replay = await getCommandReplay(supabase, actor, input.requestId, 'STOP', {
    commandAt: canonicalTimestamp(input.commandAt),
    businessTimeZone: DEFAULT_BUSINESS_TIME_ZONE
  })
  if (replay) return replay
  const { data, error } = await supabase.rpc('time_stop_timer', {
    p_user_id: actor.id,
    p_actor_role: actor.role,
    p_request_id: input.requestId,
    p_stopped_at: input.commandAt ?? null,
    p_business_time_zone: DEFAULT_BUSINESS_TIME_ZONE
  })
  if (error) throw mapDatabaseError(error)
  return Array.isArray(data) ? data[0] : data
}

async function createManualEntry({ supabase, actor, input }) {
  requireActiveTimeActor(actor)
  const replay = await getCommandReplay(supabase, actor, input.requestId, 'MANUAL', {
    standardCategoryId: input.standardCategoryId,
    personalCategoryId: input.personalCategoryId,
    dailyPlanId: input.dailyPlanId,
    crmLink: canonicalCrmLink(input.crmLink),
    startedAt: canonicalTimestamp(input.startedAt),
    endedAt: canonicalTimestamp(input.endedAt),
    notes: input.notes,
    businessTimeZone: DEFAULT_BUSINESS_TIME_ZONE
  })
  if (replay) return replay
  const { data, error } = await supabase.rpc('time_create_manual_entry', {
    p_user_id: actor.id, p_actor_role: actor.role, p_request_id: input.requestId,
    p_standard_category_id: input.standardCategoryId,
    p_personal_category_id: input.personalCategoryId ?? null,
    p_daily_plan_id: input.dailyPlanId ?? null,
    ...linkArguments(input.crmLink),
    p_started_at: input.startedAt, p_ended_at: input.endedAt,
    p_notes: input.notes ?? null, p_business_time_zone: DEFAULT_BUSINESS_TIME_ZONE
  })
  if (error) throw mapDatabaseError(error)
  return Array.isArray(data) ? data[0] : data
}

async function reviseTimeEntry({ supabase, actor, entryId, input }) {
  requireActiveTimeActor(actor)
  const patchFields = [...new Set(Object.keys(input).filter(key => key !== 'requestId'))].sort()
  const replay = await getCommandReplay(supabase, actor, input.requestId, 'REVISE', {
    entryId,
    standardCategoryId: input.standardCategoryId,
    personalCategoryId: input.personalCategoryId,
    startedAt: canonicalTimestamp(input.startedAt),
    endedAt: canonicalTimestamp(input.endedAt),
    notes: input.notes,
    patchFields,
    crmLink: canonicalCrmLink(input.crmLink)
  })
  if (replay) return replay
  const args = {
    p_user_id: actor.id, p_actor_role: actor.role, p_entry_id: entryId, p_request_id: input.requestId,
    p_standard_category_id: input.standardCategoryId ?? null,
    p_personal_category_id: input.personalCategoryId ?? null,
    p_started_at: input.startedAt ?? null, p_ended_at: input.endedAt ?? null,
    p_notes: input.notes === undefined ? null : input.notes,
    p_patch_fields: patchFields,
    ...linkArguments(input.crmLink)
  }
  const { data, error } = await supabase.rpc('time_revise_entry', args)
  if (error) throw mapDatabaseError(error)
  return Array.isArray(data) ? data[0] : data
}

async function reconcileActiveTimer({ supabase, actor, clientState }) {
  requireActiveTimeActor(actor)
  const { data, error } = await supabase.from('time_entries')
    .select('id, user_id, business_date, daily_plan_id, standard_category_id, personal_category_id, started_at, notes, linked_entity_type, linked_entity_id, linked_entity_label')
    .eq('user_id', actor.id).eq('entry_type', 'TIMER').is('ended_at', null).maybeSingle()
  if (error) throw mapDatabaseError(error)
  const sameStart = !clientState.displayedStartedAt || Date.parse(clientState.displayedStartedAt) === Date.parse(data?.started_at)
  const matches = Boolean(data && clientState.displayedEntryId === data.id && sameStart)
  return { matches, authoritativeEntry: data || null }
}

async function listTimeEntries({ supabase, actor, businessDate }) {
  requireActiveTimeActor(actor)
  const { data: entries, error: entryError } = await supabase.from('time_entries')
    .select('id, user_id, business_date, daily_plan_id, standard_category_id, personal_category_id, entry_type, started_at, ended_at, duration_seconds, notes, linked_entity_type, linked_entity_id, linked_entity_label')
    .eq('user_id', actor.id)
    .eq('business_date', businessDate)
    .order('started_at', { ascending: false })
  if (entryError) throw mapDatabaseError(entryError)
  const records = entries || []
  if (!records.length) return { entries: [] }
  const { data: revisions, error: revisionError } = await supabase.from('time_entry_revisions')
    .select('id, entry_id, user_id, changed_by, changed_at, before_value, after_value')
    .eq('user_id', actor.id)
    .in('entry_id', records.map(entry => entry.id))
    .order('changed_at', { ascending: false })
  if (revisionError) throw mapDatabaseError(revisionError)
  const byEntry = new Map()
  for (const revision of revisions || []) {
    const existing = byEntry.get(revision.entry_id) || []
    existing.push(revision)
    byEntry.set(revision.entry_id, existing)
  }
  return { entries: records.map(entry => ({
    ...entry,
    revisions: (byEntry.get(entry.id) || []).map(revision => {
      const before = revision.before_value || {}
      const after = revision.after_value || {}
      const changedFields = [...new Set([...Object.keys(before), ...Object.keys(after)])]
        .filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
        .sort()
      return {
        id: revision.id,
        entryId: revision.entry_id,
        changedAt: revision.changed_at,
        changedFields,
        changedBySelf: revision.changed_by === actor.id
      }
    })
  })) }
}

module.exports = { startTimer, switchTimer, stopTimer, createManualEntry, reviseTimeEntry, reconcileActiveTimer, listTimeEntries, mapDatabaseError }
