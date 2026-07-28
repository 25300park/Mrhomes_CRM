function canonicalDatabaseFingerprint(value) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('Database connection must be a valid PostgreSQL URL.')
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('Database connection must be a valid PostgreSQL URL.')
  }
  if (!parsed.hostname || !parsed.username || !parsed.pathname || parsed.pathname === '/') {
    throw new Error('Database connection must be a valid PostgreSQL URL.')
  }

  return {
    host: parsed.hostname.toLowerCase(),
    port: parsed.port || '5432',
    database: decodeURIComponent(parsed.pathname.slice(1))
  }
}

function createDdlSafetyState() {
  return { safeTargetVerified: false, schemaCreated: false }
}

function markSafeTargetVerified(state) {
  state.safeTargetVerified = true
}

function markSchemaCreated(state) {
  if (!state.safeTargetVerified) {
    throw new Error('Schema creation requires safe target verification.')
  }
  state.schemaCreated = true
}

function mayCleanupSchema(state) {
  return state.safeTargetVerified === true && state.schemaCreated === true
}

function runGuardedSchemaSetup(state, { verifyTarget, createSchema }) {
  verifyTarget()
  markSafeTargetVerified(state)
  createSchema()
  markSchemaCreated(state)
}

function runGuardedSchemaCleanup(state, dropSchema) {
  if (mayCleanupSchema(state)) dropSchema()
}

module.exports = {
  canonicalDatabaseFingerprint,
  createDdlSafetyState,
  markSafeTargetVerified,
  markSchemaCreated,
  mayCleanupSchema,
  runGuardedSchemaSetup,
  runGuardedSchemaCleanup
}
