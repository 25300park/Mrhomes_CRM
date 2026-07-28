const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const {
  canonicalDatabaseFingerprint,
  createDdlSafetyState,
  runGuardedSchemaSetup,
  runGuardedSchemaCleanup
} = require('../helpers/time-db-safety')

const USER_A = '00000000-0000-0000-0000-000000000001'
const USER_B = '00000000-0000-0000-0000-000000000002'
const STANDARD_A = '10000000-0000-0000-0000-000000000001'
const PERSONAL_B = '20000000-0000-0000-0000-000000000002'
const CONTACT_A = '30000000-0000-0000-0000-000000000001'
const LISTING_A = '40000000-0000-0000-0000-000000000001'
const PLAN_A = '50000000-0000-0000-0000-000000000001'
const PLAN_B = '50000000-0000-0000-0000-000000000002'
const WRONG_DATE_PLAN = '50000000-0000-0000-0000-000000000003'
const MARKER_SCOPE = 'mrhomes-time-management-isolated-test-v1'

const connectionString = process.env.TEST_DATABASE_URL
const markerToken = process.env.TIME_DB_TEST_MARKER_TOKEN
const schemaName = `time_test_${process.pid}_${Date.now()}`
const ddlSafety = createDdlSafetyState()

function psqlArgs() {
  return [
    '--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--quiet',
    '--tuples-only', '--no-align', '--dbname', connectionString
  ]
}

function psql(sql) {
  return spawnSync('psql', psqlArgs(), {
    input: `\\set VERBOSITY verbose\n${sql}`,
    encoding: 'utf8',
    windowsHide: true
  })
}

function assertSafeTarget() {
  if (!connectionString || !markerToken) {
    throw new Error('Dedicated DB required: set TEST_DATABASE_URL and TIME_DB_TEST_MARKER_TOKEN.')
  }
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(markerToken)) {
    throw new Error('TIME_DB_TEST_MARKER_TOKEN must be a 16-128 character opaque marker.')
  }
  const targetFingerprint = canonicalDatabaseFingerprint(connectionString)
  const productionUrls = [process.env.DATABASE_URL, process.env.SUPABASE_DB_URL].filter(Boolean)
  let productionFingerprints
  try {
    productionFingerprints = productionUrls.map(canonicalDatabaseFingerprint)
  } catch {
    throw new Error('Production database URL is invalid; refusing all DDL.')
  }
  if (productionFingerprints.some((value) => JSON.stringify(value) === JSON.stringify(targetFingerprint))) {
    throw new Error('TEST_DATABASE_URL matches a production database variable; refusing all DDL.')
  }

  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(targetFingerprint.host)
  if (!isLocal && process.env.TIME_DB_TEST_REMOTE_ALLOW !== 'yes') {
    throw new Error('Remote test DB requires TIME_DB_TEST_REMOTE_ALLOW=yes in addition to its marker.')
  }

  const marker = psql(`
    BEGIN READ ONLY;
    SELECT
      (SELECT count(*) FROM public.time_management_test_marker
        WHERE scope = '${MARKER_SCOPE}' AND token = '${markerToken}') || '|' ||
      (SELECT count(*) FROM pg_catalog.pg_roles
        WHERE rolname = 'service_role' AND rolbypassrls = true) || '|' ||
      (SELECT count(*) FROM pg_catalog.pg_roles
        WHERE rolname IN ('anon', 'authenticated')) || '|' ||
      (SELECT count(*) FROM pg_catalog.pg_roles
        WHERE rolname = current_user AND (rolsuper OR rolbypassrls));
    COMMIT;
  `)
  if (marker.status !== 0 || marker.stdout.trim() !== '1|1|2|1') {
    throw new Error('Dedicated DB marker or Supabase service roles are missing; refusing all DDL.')
  }
}

function runSql(sql) {
  const result = psql(`SET search_path TO ${schemaName}, public;\n${sql}`)
  if (result.status !== 0) {
    throw new Error('Isolated PostgreSQL command failed; inspect dedicated test DB logs.')
  }
  return result.stdout.trim()
}

function expectSqlFailure(sql, { sqlState, constraint }) {
  const result = psql(`SET search_path TO ${schemaName}, public;\n${sql}`)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain(`ERROR:  ${sqlState}:`)
  if (constraint) expect(result.stderr).toContain(constraint)
}

function runSqlAsync(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn('psql', psqlArgs(), { windowsHide: true })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.on('error', () => reject(new Error('Could not start psql for isolated DB test.')))
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim())
      else reject(new Error('Concurrent isolated PostgreSQL command failed.'))
    })
    child.stdin.end(`\\set VERBOSITY verbose\nSET search_path TO ${schemaName}, public;\n${sql}`)
  })
}

function migrationSql() {
  const qualifyForTestSchema = (sql) => sql
    .replaceAll('SET LOCAL search_path = public, pg_temp', `SET LOCAL search_path = ${schemaName}, pg_temp`)
    .replaceAll('public.', `${schemaName}.`)

  return {
    schema: qualifyForTestSchema(fs.readFileSync(path.resolve('database/time-management.sql'), 'utf8')),
    functions: qualifyForTestSchema(
      fs.readFileSync(path.resolve('database/time-management-functions.sql'), 'utf8')
    )
  }
}

describe('time-management SQL on a marked isolated Supabase/PostgreSQL database', () => {
  beforeAll(() => {
    const version = spawnSync('psql', ['--version'], { encoding: 'utf8', windowsHide: true })
    if (version.status !== 0) throw new Error('psql is required for real PostgreSQL integration tests.')
    runGuardedSchemaSetup(ddlSafety, {
      verifyTarget: assertSafeTarget,
      createSchema: () => {
        const created = psql(`CREATE SCHEMA ${schemaName};`)
        if (created.status !== 0) throw new Error('Could not create isolated fixture schema.')
      }
    })

    const base = psql(`
      SET search_path TO ${schemaName}, public;
      CREATE TABLE users (
        id UUID PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL, role TEXT NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT true
      );
      CREATE TABLE contacts (id UUID PRIMARY KEY);
      CREATE TABLE listings (id UUID PRIMARY KEY);
      CREATE TABLE leads (id UUID PRIMARY KEY);
      CREATE TABLE deals (id UUID PRIMARY KEY);
      INSERT INTO users (id, name, email, password_hash, role) VALUES
        ('${USER_A}', 'Agent A', 'agent-a@example.test', 'fixture', 'agent'),
        ('${USER_B}', 'Agent B', 'agent-b@example.test', 'fixture', 'agent');
      INSERT INTO contacts (id) VALUES ('${CONTACT_A}');
      INSERT INTO listings (id) VALUES ('${LISTING_A}');
    `)
    if (base.status !== 0) throw new Error('Could not create isolated fixture tables.')

    const migrations = migrationSql()
    for (let pass = 0; pass < 2; pass += 1) {
      const result = psql(`${migrations.schema}\n${migrations.functions}`)
      if (result.status !== 0) throw new Error(`Migration repeatability pass ${pass + 1} failed.`)
    }

    runSql(`
      INSERT INTO time_standard_categories (id, name)
      VALUES ('${STANDARD_A}', 'Customer service');
      INSERT INTO time_personal_categories
        (id, user_id, parent_standard_category_id, name)
      VALUES ('${PERSONAL_B}', '${USER_B}', '${STANDARD_A}', 'Agent B private');
      INSERT INTO time_daily_plans (id, user_id, business_date, available_minutes)
      VALUES
        ('${PLAN_A}', '${USER_A}', '2026-07-16', 480),
        ('${PLAN_B}', '${USER_B}', '2026-07-16', 480),
        ('${WRONG_DATE_PLAN}', '${USER_A}', '2026-07-17', 480);
    `)
  }, 40_000)

  afterAll(() => {
    runGuardedSchemaCleanup(ddlSafety, () => {
      psql(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE;`)
    })
  })

  test('is repeatable and exposes time tables only to service_role', () => {
    const catalog = runSql(`
      SELECT count(*) FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = '${schemaName}' AND c.relname LIKE 'time_%'
        AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity;
    `)
    expect(catalog).toBe('14')

    expectSqlFailure(`SET ROLE anon; SELECT * FROM ${schemaName}.time_entries;`, { sqlState: '42501' })
    expectSqlFailure(`SET ROLE authenticated; SELECT * FROM ${schemaName}.time_entries;`, { sqlState: '42501' })
    expect(runSql(`SELECT has_table_privilege('service_role', '${schemaName}.time_entries', 'SELECT');`)).toBe('t')
    expect(runSql(`SELECT has_function_privilege('service_role', '${schemaName}.time_start_timer(uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,timestamptz,text)', 'EXECUTE');`)).toBe('t')
    expect(runSql(`SELECT has_function_privilege('anon', '${schemaName}.time_start_timer(uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,timestamptz,text)', 'EXECUTE');`)).toBe('f')
  })

  test('enforces plan/personal ownership and NULL-safe allocation uniqueness', () => {
    expectSqlFailure(`
      INSERT INTO time_plan_allocations
        (daily_plan_id, user_id, standard_category_id, planned_minutes)
      VALUES ('${PLAN_A}', '${USER_B}', '${STANDARD_A}', 30);
    `, { sqlState: '23503', constraint: 'time_plan_allocations_plan_owner_fk' })
    expectSqlFailure(`
      INSERT INTO time_plan_allocations
        (daily_plan_id, user_id, standard_category_id, personal_category_id, planned_minutes)
      VALUES ('${PLAN_A}', '${USER_A}', '${STANDARD_A}', '${PERSONAL_B}', 30);
    `, { sqlState: '23503', constraint: 'time_plan_allocations_personal_owner_fk' })
    runSql(`INSERT INTO time_plan_allocations
      (daily_plan_id, user_id, standard_category_id, planned_minutes)
      VALUES ('${PLAN_A}', '${USER_A}', '${STANDARD_A}', 30);`)
    expectSqlFailure(`INSERT INTO time_plan_allocations
      (daily_plan_id, user_id, standard_category_id, planned_minutes)
      VALUES ('${PLAN_A}', '${USER_A}', '${STANDARD_A}', 45);`,
    { sqlState: '23505', constraint: 'time_plan_allocations_standard_uq' })
  })

  test('enforces entry type state, CRM link, and active timer constraints by name', () => {
    expectSqlFailure(`INSERT INTO time_entries
      (user_id, business_date, standard_category_id, entry_type, started_at)
      VALUES ('${USER_A}', '2026-07-16', '${STANDARD_A}', 'MANUAL', now());`,
    { sqlState: '23514', constraint: 'time_entries_type_state_ck' })
    expectSqlFailure(`INSERT INTO time_entries
      (user_id, business_date, standard_category_id, entry_type, started_at,
       ended_at, duration_seconds, contact_id, listing_id,
       linked_entity_type, linked_entity_id, linked_entity_label)
      VALUES ('${USER_A}', '2026-07-16', '${STANDARD_A}', 'MANUAL',
       now() - interval '1 hour', now(), 3600, '${CONTACT_A}', '${LISTING_A}',
       'CONTACT', '${CONTACT_A}', 'fixture');`,
    { sqlState: '23514' })
    expectSqlFailure(`INSERT INTO time_entries
      (user_id, business_date, standard_category_id, entry_type, started_at,
       ended_at, duration_seconds, linked_entity_type, linked_entity_id,
       linked_entity_label)
      VALUES ('${USER_A}', '2026-07-16', '${STANDARD_A}', 'MANUAL',
       now() - interval '1 hour', now(), 3600, 'CONTACT', '${CONTACT_A}',
       'orphan snapshot');`,
    { sqlState: '23514', constraint: 'time_entries_crm_snapshot_ck' })

    runSql(`INSERT INTO time_entries
      (user_id, business_date, standard_category_id, entry_type, started_at)
      VALUES ('${USER_A}', '2026-07-16', '${STANDARD_A}', 'TIMER',
        '2026-07-15T15:00:00Z');`)
    expectSqlFailure(`INSERT INTO time_entries
      (user_id, business_date, standard_category_id, entry_type, started_at)
      VALUES ('${USER_A}', '2026-07-16', '${STANDARD_A}', 'TIMER',
        '2026-07-15T15:01:00Z');`,
    { sqlState: '23505', constraint: 'time_entries_active_user_uq' })
    runSql(`DELETE FROM time_entries WHERE user_id = '${USER_A}';`)
  })

  test('concurrently replays start and stop commands with immutable Seoul business date', async () => {
    runSql(`DELETE FROM time_commands WHERE user_id = '${USER_A}'; DELETE FROM time_entries WHERE user_id = '${USER_A}';`)
    const start = () => runSqlAsync(`SELECT COALESCE(stopped_entry_id::text, '') || '|' ||
      COALESCE(started_entry_id::text, '') || '|' || CASE WHEN replayed THEN '1' ELSE '0' END
      FROM time_start_timer('${USER_A}', 'start-concurrent', '${STANDARD_A}',
        p_started_at => '2026-07-15T15:30:00Z');`)
    const starts = await Promise.all([start(), start()])
    expect(new Set(starts.map((value) => value.replace(/\|[01]$/, ''))).size).toBe(1)
    expect(starts.filter((value) => /\|1$/.test(value))).toHaveLength(1)
    expect(runSql(`SELECT business_date FROM time_entries WHERE user_id = '${USER_A}' AND ended_at IS NULL;`)).toBe('2026-07-16')

    const switchTimer = () => runSqlAsync(`SELECT stopped_entry_id || '|' ||
      COALESCE(started_entry_id::text, '') || '|' || CASE WHEN replayed THEN '1' ELSE '0' END
      FROM time_switch_timer('${USER_A}', 'switch-concurrent', '${STANDARD_A}',
        p_started_at => '2026-07-15T15:45:00Z');`)
    const switches = await Promise.all([switchTimer(), switchTimer()])
    expect(new Set(switches.map((value) => value.replace(/\|[01]$/, ''))).size).toBe(1)
    expect(switches.filter((value) => /\|1$/.test(value))).toHaveLength(1)
    expect(runSql(`SELECT duration_seconds FROM time_entries
      WHERE request_id = 'start-concurrent';`)).toBe('900')
    expect(runSql(`SELECT business_date FROM time_entries
      WHERE request_id = 'switch-concurrent' AND ended_at IS NULL;`)).toBe('2026-07-16')

    expectSqlFailure(`UPDATE time_entries SET business_date = '2026-07-17'
      WHERE user_id = '${USER_A}' AND ended_at IS NULL;`,
    { sqlState: '23514', constraint: 'time_entries_business_date_immutable' })
    expectSqlFailure(`SELECT * FROM time_stop_timer('${USER_A}', 'bad-zone',
      '2026-07-15T16:00:00Z', 'UTC');`, { sqlState: '22023' })

    const stop = () => runSqlAsync(`SELECT stopped_entry_id || '|' || COALESCE(started_entry_id::text, '') || '|' ||
      CASE WHEN replayed THEN '1' ELSE '0' END
      FROM time_stop_timer('${USER_A}', 'stop-concurrent', '2026-07-15T16:00:00Z');`)
    const stops = await Promise.all([stop(), stop()])
    expect(new Set(stops.map((value) => value.replace(/\|[01]$/, ''))).size).toBe(1)
    expect(stops.filter((value) => /\|1$/.test(value))).toHaveLength(1)
    expect(runSql(`SELECT duration_seconds FROM time_entries
      WHERE request_id = 'switch-concurrent';`)).toBe('900')
  })

  test('rolls back the stopped timer if the replacement insert fails', () => {
    runSql(`SELECT * FROM time_start_timer('${USER_A}', 'rollback-start', '${STANDARD_A}',
      p_started_at => '2026-07-15T17:00:00Z');`)
    const activeBefore = runSql(`SELECT id FROM time_entries WHERE user_id = '${USER_A}' AND ended_at IS NULL;`)
    expectSqlFailure(`SELECT * FROM time_switch_timer(
      '${USER_A}', 'rollback-switch', '${STANDARD_A}',
      p_daily_plan_id => '${WRONG_DATE_PLAN}', p_started_at => '2026-07-15T17:30:00Z');`,
    { sqlState: '23503', constraint: 'time_entries_plan_owner_date_fk' })
    expect(runSql(`SELECT id FROM time_entries WHERE user_id = '${USER_A}' AND ended_at IS NULL;`)).toBe(activeBefore)
  })

  test('claims disjoint batches, reclaims stale leases, and applies retry backoff', async () => {
    runSql(`DELETE FROM time_jobs; INSERT INTO time_jobs (user_id, job_type, dedupe_key)
      SELECT '${USER_A}', 'DAILY_METRICS', 'claim-' || number FROM generate_series(1, 6) number;`)
    expectSqlFailure(`SELECT * FROM time_claim_jobs(1, '   ', 60);`, { sqlState: '22023' })
    const claim = (worker) => runSqlAsync(`BEGIN; SELECT id FROM time_claim_jobs(3, '${worker}', 60); SELECT pg_sleep(0.3); COMMIT;`)
    const [left, right] = await Promise.all([claim('worker-a'), claim('worker-b')])
    const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
    const ids = [...(left.match(uuidPattern) || []), ...(right.match(uuidPattern) || [])]
    expect(ids).toHaveLength(6)
    expect(new Set(ids).size).toBe(6)

    const staleId = runSql(`INSERT INTO time_jobs
      (user_id, job_type, dedupe_key, status, attempts, ready_at, locked_at, locked_by, lease_until)
      VALUES ('${USER_A}', 'AI_REVIEW', 'stale', 'PROCESSING', 1, NULL,
        now() - interval '2 minutes', 'dead-worker', now() - interval '1 minute') RETURNING id;`)
    const [reclaimResult, expiredWorkerResult] = await Promise.allSettled([
      runSqlAsync(`SELECT id FROM time_claim_jobs(1, 'reclaimer', 60)
        WHERE id = '${staleId}';`),
      runSqlAsync(`SELECT id FROM time_complete_job('${staleId}', 'dead-worker', '{}');`)
    ])
    expect(reclaimResult).toMatchObject({ status: 'fulfilled', value: staleId })
    expect(expiredWorkerResult.status).toBe('rejected')
    expect(runSql(`SELECT attempts FROM time_jobs WHERE id = '${staleId}';`)).toBe('2')
    expectSqlFailure(`SELECT * FROM time_fail_job('${staleId}', 'dead-worker', 'LATE_RESULT');`,
    { sqlState: '42501' })
    const retrySeconds = Number(runSql(`SELECT EXTRACT(epoch FROM (ready_at - now()))::integer
      FROM time_fail_job('${staleId}', 'reclaimer', 'PROVIDER_TIMEOUT');`))
    expect(retrySeconds).toBeGreaterThanOrEqual(295)
    expect(retrySeconds).toBeLessThanOrEqual(300)
  })

  test('keeps Push endpoints globally unique and tracks account reassignment', () => {
    runSql(`INSERT INTO time_push_subscriptions
      (user_id, endpoint, p256dh, auth_secret, ownership_changed_at)
      VALUES ('${USER_A}', 'https://push.example.test/sub-1', 'key-a', 'auth-a', now() - interval '1 day');`)
    expectSqlFailure(`INSERT INTO time_push_subscriptions
      (user_id, endpoint, p256dh, auth_secret)
      VALUES ('${USER_B}', 'https://push.example.test/sub-1', 'key-b', 'auth-b');`,
    { sqlState: '23505', constraint: 'time_push_subscriptions_endpoint_key' })
    expect(runSql(`UPDATE time_push_subscriptions SET user_id = '${USER_B}'
      WHERE endpoint = 'https://push.example.test/sub-1'
      RETURNING (ownership_changed_at > created_at);`)).toBe('t')
  })
})
