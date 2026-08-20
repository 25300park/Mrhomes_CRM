const {
  canonicalDatabaseFingerprint,
  createDdlSafetyState,
  markSafeTargetVerified,
  markSchemaCreated,
  mayCleanupSchema,
  runGuardedSchemaSetup,
  runGuardedSchemaCleanup
} = require('../helpers/time-db-safety')

describe('isolated database safety gate', () => {
  test('canonicalizes PostgreSQL aliases, host casing, default port, and query order', () => {
    expect(canonicalDatabaseFingerprint(
      'postgres://agent:secret@DB.EXAMPLE.test/crm_test?sslmode=require&application_name=a'
    )).toEqual(canonicalDatabaseFingerprint(
      'postgresql://agent:different@db.example.test:5432/crm_test?application_name=b&sslmode=disable'
    ))
  })

  test('returns database identity without credentials or connection user', () => {
    const fingerprint = canonicalDatabaseFingerprint(
      'postgresql://test_user:do-not-return@localhost:5433/time_test'
    )

    expect(fingerprint).toEqual({
      host: 'localhost',
      port: '5433',
      database: 'time_test'
    })
    expect(JSON.stringify(fingerprint)).not.toContain('do-not-return')
    expect(JSON.stringify(fingerprint)).not.toContain('test_user')
  })

  test('treats different users as the same production database target', () => {
    const testTarget = canonicalDatabaseFingerprint(
      'postgresql://isolated_runner:test-secret@DB.EXAMPLE.test/time_test'
    )
    const productionTarget = canonicalDatabaseFingerprint(
      'postgres://production_owner:production-secret@db.example.test:5432/time_test'
    )

    expect(testTarget).toEqual(productionTarget)
  })

  test('canonicalizes Supabase direct and pooler URLs by project ref', () => {
    const direct = canonicalDatabaseFingerprint(
      'postgresql://postgres:direct-secret@db.abcdefghijklmnopqrst.supabase.co:5432/postgres'
    )
    const pooler = canonicalDatabaseFingerprint(
      'postgresql://postgres.abcdefghijklmnopqrst:pooler-secret@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres'
    )

    expect(direct).toEqual({ provider: 'supabase', projectRef: 'abcdefghijklmnopqrst' })
    expect(pooler).toEqual(direct)
    expect(JSON.stringify(pooler)).not.toContain('pooler-secret')
    expect(JSON.stringify(pooler)).not.toContain('postgres.')
  })

  test('distinguishes Supabase projects that share a pooler host and database', () => {
    const first = canonicalDatabaseFingerprint(
      'postgresql://postgres.abcdefghijklmnopqrst:first-secret@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres'
    )
    const second = canonicalDatabaseFingerprint(
      'postgresql://postgres.zxywvutsrqponmlkjihg:second-secret@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres'
    )

    expect(first).not.toEqual(second)
  })

  test('fails closed for invalid or non-PostgreSQL URLs', () => {
    expect(() => canonicalDatabaseFingerprint('not-a-url')).toThrow('valid PostgreSQL URL')
    expect(() => canonicalDatabaseFingerprint('https://db.example.test/database')).toThrow('valid PostgreSQL URL')
  })

  test('permits cleanup only after both marker verification and schema creation', () => {
    const state = createDdlSafetyState()
    expect(state).toEqual({ safeTargetVerified: false, schemaCreated: false })
    expect(mayCleanupSchema(state)).toBe(false)

    markSafeTargetVerified(state)
    expect(mayCleanupSchema(state)).toBe(false)

    markSchemaCreated(state)
    expect(mayCleanupSchema(state)).toBe(true)
  })

  test('rejects schema-created state before safe target verification', () => {
    const state = createDdlSafetyState()
    expect(() => markSchemaCreated(state)).toThrow('safe target verification')
    expect(mayCleanupSchema(state)).toBe(false)
  })

  test('executes zero DDL calls when target verification fails', () => {
    const state = createDdlSafetyState()
    const calls = { create: 0, drop: 0 }

    expect(() => runGuardedSchemaSetup(state, {
      verifyTarget: () => { throw new Error('marker mismatch') },
      createSchema: () => { calls.create += 1 }
    })).toThrow('marker mismatch')
    runGuardedSchemaCleanup(state, () => { calls.drop += 1 })

    expect(calls).toEqual({ create: 0, drop: 0 })
    expect(state).toEqual({ safeTargetVerified: false, schemaCreated: false })
  })
})
