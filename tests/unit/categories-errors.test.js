const {
  createPersonalCategory,
  deactivatePersonalCategory,
  updateStandardCategory
} = require('../../services/time-management/categories')

const actor = { id: 'agent-1', role: 'agent', is_active: true }
const admin = { id: 'admin-1', role: 'admin', is_active: true }

function failingSupabase(tableErrors) {
  return {
    from(table) {
      const error = tableErrors[table]
      const query = {
        select() { return query },
        eq() { return query },
        update() { return query },
        single() { return Promise.resolve({ data: null, error }) }
      }
      return query
    }
  }
}

test('a standard parent lookup only maps a known no-row response to category validation', async () => {
  await expect(createPersonalCategory({
    supabase: failingSupabase({ time_standard_categories: { code: '42501', message: 'denied' } }),
    actor,
    input: { name: 'Follow-up', parentStandardCategoryId: 'standard-1' }
  })).rejects.toMatchObject({ code: 'DATABASE_ERROR', status: 500 })
})

test('personal category ownership lookup maps database failures to a stable server error', async () => {
  await expect(deactivatePersonalCategory({
    supabase: failingSupabase({ time_personal_categories: { code: '42501', message: 'denied' } }),
    actor,
    categoryId: 'personal-1'
  })).rejects.toMatchObject({ code: 'DATABASE_ERROR', status: 500 })
})

test('standard category mutation only maps a known no-row response to 404', async () => {
  await expect(updateStandardCategory({
    supabase: failingSupabase({ time_standard_categories: { code: '42501', message: 'denied' } }),
    actor: admin,
    categoryId: 'standard-1',
    input: { name: 'Reports' }
  })).rejects.toMatchObject({ code: 'DATABASE_ERROR', status: 500 })
})

test('only Supabase no-row errors receive category not-found responses', async () => {
  const noRows = { code: 'PGRST116', message: 'no rows' }

  await expect(updateStandardCategory({
    supabase: failingSupabase({ time_standard_categories: noRows }),
    actor: admin,
    categoryId: 'standard-1',
    input: { name: 'Reports' }
  })).rejects.toMatchObject({ code: 'CATEGORY_NOT_FOUND', status: 404 })

  await expect(deactivatePersonalCategory({
    supabase: failingSupabase({ time_personal_categories: noRows }),
    actor,
    categoryId: 'personal-1'
  })).rejects.toMatchObject({ code: 'CATEGORY_NOT_FOUND', status: 404 })
})
