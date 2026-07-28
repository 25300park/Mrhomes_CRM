const { TimeManagementError } = require('./errors')
const { requireActiveTimeActor, requireTimeAdmin, requireTimeOwner } = require('./access-policy')

function databaseError(error) {
  return new TimeManagementError('DATABASE_ERROR', '시간 관리 데이터를 처리할 수 없습니다.', 500, { cause: error })
}

function isNotFound(error) {
  return error?.code === 'PGRST116'
}

async function listAvailableCategories({ supabase, actor }) {
  requireActiveTimeActor(actor)
  const [standardResult, personalResult] = await Promise.all([
    supabase.from('time_standard_categories')
      .select('id, name, description, sort_order, is_focus, is_active')
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true }),
    supabase.from('time_personal_categories')
      .select('id, user_id, parent_standard_category_id, name, sort_order, is_active')
      .eq('user_id', actor.id)
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true })
  ])
  if (standardResult.error) throw databaseError(standardResult.error)
  if (personalResult.error) throw databaseError(personalResult.error)
  const standard = standardResult.data || []
  const activeStandardIds = new Set(standard.map(category => category.id))
  return {
    standard,
    personal: (personalResult.data || []).filter(category => activeStandardIds.has(category.parent_standard_category_id))
  }
}

async function createStandardCategory({ supabase, actor, input }) {
  requireTimeAdmin(actor)
  const { data, error } = await supabase.from('time_standard_categories').insert({
    name: input.name,
    description: input.description || null,
    sort_order: input.sortOrder ?? 0,
    is_focus: input.isFocus ?? false,
    is_active: input.isActive ?? true,
    created_by: actor.id
  }).select().single()
  if (error) throw databaseError(error)
  return data
}

async function updateStandardCategory({ supabase, actor, categoryId, input }) {
  requireTimeAdmin(actor)
  const updates = { updated_at: new Date().toISOString() }
  if (input.name !== undefined) updates.name = input.name
  if (input.description !== undefined) updates.description = input.description
  if (input.sortOrder !== undefined) updates.sort_order = input.sortOrder
  if (input.isFocus !== undefined) updates.is_focus = input.isFocus
  if (input.isActive !== undefined) updates.is_active = input.isActive
  const { data, error } = await supabase.from('time_standard_categories')
    .update(updates).eq('id', categoryId).select().single()
  if (error || !data) {
    if (!error || isNotFound(error)) throw new TimeManagementError('CATEGORY_NOT_FOUND', '카테고리를 찾을 수 없습니다.', 404)
    throw databaseError(error)
  }
  return data
}

async function createPersonalCategory({ supabase, actor, input }) {
  requireActiveTimeActor(actor)
  const { data: parent, error: parentError } = await supabase
    .from('time_standard_categories')
    .select('id, is_active')
    .eq('id', input.parentStandardCategoryId)
    .eq('is_active', true)
    .single()
  if (parentError || !parent) {
    if (parentError && !isNotFound(parentError)) throw databaseError(parentError)
    throw new TimeManagementError('INACTIVE_STANDARD_CATEGORY', '활성 표준 카테고리를 선택해야 합니다.', 422)
  }
  const { data, error } = await supabase.from('time_personal_categories').insert({
    user_id: actor.id,
    parent_standard_category_id: parent.id,
    name: input.name,
    sort_order: input.sortOrder ?? 0,
    is_active: true
  }).select().single()
  if (error) throw databaseError(error)
  return data
}

async function updatePersonalCategory({ supabase, actor, categoryId, input }) {
  requireActiveTimeActor(actor)
  const { data: existing, error: existingError } = await supabase.from('time_personal_categories')
    .select('id, user_id')
    .eq('id', categoryId)
    .single()
  if (existingError || !existing) {
    if (!existingError || isNotFound(existingError)) throw new TimeManagementError('CATEGORY_NOT_FOUND', '카테고리를 찾을 수 없습니다.', 404)
    throw databaseError(existingError)
  }
  requireTimeOwner(actor, existing.user_id)
  const updates = { updated_at: new Date().toISOString() }
  if (input.name !== undefined) updates.name = input.name
  if (input.sortOrder !== undefined) updates.sort_order = input.sortOrder
  if (input.isActive !== undefined) updates.is_active = input.isActive
  const { data, error } = await supabase.from('time_personal_categories')
    .update(updates).eq('id', categoryId).select().single()
  if (error || !data) {
    if (!error || isNotFound(error)) throw new TimeManagementError('CATEGORY_NOT_FOUND', '카테고리를 찾을 수 없습니다.', 404)
    throw databaseError(error)
  }
  return data
}

async function deactivatePersonalCategory({ supabase, actor, categoryId }) {
  return updatePersonalCategory({ supabase, actor, categoryId, input: { isActive: false } })
}

module.exports = {
  listAvailableCategories,
  createStandardCategory,
  updateStandardCategory,
  createPersonalCategory,
  updatePersonalCategory,
  deactivatePersonalCategory
}
