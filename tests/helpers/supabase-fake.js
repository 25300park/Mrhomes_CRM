function createSupabaseFake(overrides = {}) {
  return {
    from(table) {
      const handler = overrides[table]
      if (!handler) {
        throw new Error(`Unexpected Supabase table access: ${table}`)
      }
      return typeof handler === 'function' ? handler() : handler
    }
  }
}

module.exports = { createSupabaseFake }
