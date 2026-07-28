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
  expect(result.stderr).toContain(`${sqlState}:`)
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
      CREATE TABLE contacts (id UUID PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE listings (id UUID PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE leads (id UUID PRIMARY KEY, contact_id UUID REFERENCES contacts(id));
      CREATE TABLE deals (id UUID PRIMARY KEY, listing_id UUID REFERENCES listings(id), contract_date DATE NOT NULL);
      INSERT INTO users (id, name, email, password_hash, role) VALUES
        ('${USER_A}', 'Agent A', 'agent-a@example.test', 'fixture', 'agent'),
        ('${USER_B}', 'Agent B', 'agent-b@example.test', 'fixture', 'agent');
      INSERT INTO contacts (id, name) VALUES ('${CONTACT_A}', 'Fixture contact');
      INSERT INTO listings (id, name) VALUES ('${LISTING_A}', 'Fixture listing');
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
      const dropped = psql(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE;`)
      if (dropped.status !== 0) throw new Error('Could not clean up isolated fixture schema.')
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

  test('returns exact CRM link top-N in the database when an earlier label belongs to the 21st parent', () => {
    runSql(`
      INSERT INTO contacts (id, name)
      SELECT pg_catalog.md5('link-contact-' || value)::uuid,
        CASE WHEN value = 21 THEN 'Alpha' ELSE 'Zulu' END
      FROM pg_catalog.generate_series(1, 21) AS value;
      INSERT INTO leads (id, contact_id)
      SELECT pg_catalog.md5('link-lead-' || value)::uuid,
        pg_catalog.md5('link-contact-' || value)::uuid
      FROM pg_catalog.generate_series(1, 21) AS value;
      INSERT INTO listings (id, name) VALUES
        ('80000000-0000-0000-0000-000000000001', 'Alpha');
      INSERT INTO deals (id, listing_id, contract_date) VALUES
        ('90000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000001', '2026-07-01');
    `)

    expect(runSql(`SELECT string_agg(type || ':' || label, '|' ORDER BY label, type, id)
      FROM time_search_crm_links('', ARRAY['LEAD', 'DEAL']::text[], 2);`)).toBe('LEAD:Alpha|DEAL:Alpha — 2026-07-01')
    expect(runSql(`SELECT has_function_privilege('service_role', '${schemaName}.time_search_crm_links(text,text[],integer)', 'EXECUTE');`)).toBe('t')
    expect(runSql(`SELECT has_function_privilege('anon', '${schemaName}.time_search_crm_links(text,text[],integer)', 'EXECUTE');`)).toBe('f')
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
    expectSqlFailure(`INSERT INTO time_entries
      (user_id, business_date, standard_category_id, entry_type, started_at,
       ended_at, duration_seconds, contact_id, linked_entity_label)
      VALUES ('${USER_A}', '2026-07-16', '${STANDARD_A}', 'MANUAL',
       now() - interval '1 hour', now(), 3600, '${CONTACT_A}',
       'missing snapshot identity');`,
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

  test('rejects inactive users and another user personal category', () => {
    runSql(`DELETE FROM time_commands WHERE user_id IN ('${USER_A}', '${USER_B}');
      DELETE FROM time_entries WHERE user_id IN ('${USER_A}', '${USER_B}');
      UPDATE users SET is_active = false WHERE id = '${USER_B}';`)
    expectSqlFailure(`SELECT * FROM time_start_timer(
      '${USER_B}', 'inactive-user', '${STANDARD_A}',
      p_started_at => '2026-07-15T18:00:00Z');`, { sqlState: '42501' })
    runSql(`UPDATE users SET is_active = true WHERE id = '${USER_B}';`)
    expectSqlFailure(`SELECT * FROM time_start_timer(
      '${USER_A}', 'other-personal-category', '${STANDARD_A}',
      p_personal_category_id => '${PERSONAL_B}',
      p_started_at => '2026-07-15T18:00:00Z');`, { sqlState: '42501' })
  })

  test('replays omitted timestamps and rejects reused request IDs with different semantics', async () => {
    runSql(`DELETE FROM time_commands WHERE user_id = '${USER_A}';
      DELETE FROM time_entries WHERE user_id = '${USER_A}';`)

    const first = runSql(`SELECT started_entry_id FROM time_start_timer(
      '${USER_A}', 'omitted-sequential', '${STANDARD_A}');`)
    const replay = runSql(`SELECT started_entry_id FROM time_start_timer(
      '${USER_A}', 'omitted-sequential', '${STANDARD_A}');`)
    expect(replay).toBe(first)
    expect(runSql(`SELECT
      ((response_payload ->> 'effectiveCommandAt')::timestamptz = entry.started_at)
      FROM time_commands command
      JOIN time_entries entry ON entry.id = (command.response_payload ->> 'startedEntryId')::uuid
      WHERE command.user_id = '${USER_A}' AND command.request_id = 'omitted-sequential';`)).toBe('t')
    expectSqlFailure(`SELECT * FROM time_stop_timer(
      '${USER_A}', 'omitted-sequential');`,
    { sqlState: '23505', constraint: 'time_commands_user_id_request_id_key' })
    expectSqlFailure(`SELECT * FROM time_start_timer(
      '${USER_A}', 'omitted-sequential', '${STANDARD_A}',
      p_contact_id => '${CONTACT_A}', p_linked_entity_label => 'different');`,
    { sqlState: '23505', constraint: 'time_commands_user_id_request_id_key' })
    runSql(`SELECT * FROM time_stop_timer('${USER_A}', 'omitted-cleanup');`)

    runSql(`DELETE FROM time_commands WHERE user_id = '${USER_A}';
      DELETE FROM time_entries WHERE user_id = '${USER_A}';`)
    const omittedConcurrent = () => runSqlAsync(`SELECT started_entry_id FROM time_start_timer(
      '${USER_A}', 'omitted-concurrent', '${STANDARD_A}');`)
    const concurrent = await Promise.all([omittedConcurrent(), omittedConcurrent()])
    expect(new Set(concurrent).size).toBe(1)
    expect(runSql(`SELECT count(*) FROM time_entries
      WHERE user_id = '${USER_A}' AND request_id = 'omitted-concurrent';`)).toBe('1')
    runSql(`SELECT * FROM time_stop_timer('${USER_A}', 'omitted-concurrent-cleanup');`)

    runSql(`DELETE FROM time_commands WHERE user_id = '${USER_A}';
      DELETE FROM time_entries WHERE user_id = '${USER_A}';`)
    const explicit = runSql(`SELECT started_entry_id FROM time_start_timer(
      '${USER_A}', 'explicit-time', '${STANDARD_A}',
      p_started_at => '2026-07-15T19:00:00Z');`)
    expect(runSql(`SELECT started_entry_id FROM time_start_timer(
      '${USER_A}', 'explicit-time', '${STANDARD_A}',
      p_started_at => '2026-07-15T19:00:00Z');`)).toBe(explicit)
    expectSqlFailure(`SELECT * FROM time_start_timer(
      '${USER_A}', 'explicit-time', '${STANDARD_A}',
      p_started_at => '2026-07-15T19:00:01Z');`,
    { sqlState: '23505', constraint: 'time_commands_user_id_request_id_key' })
  })

  test('claims disjoint batches and rejects same-worker stale lease ABA', async () => {
    runSql(`DELETE FROM time_jobs; INSERT INTO time_jobs (user_id, job_type, dedupe_key)
      SELECT '${USER_A}', 'DAILY_METRICS', 'claim-' || number FROM generate_series(1, 6) number;`)
    expectSqlFailure(`SELECT * FROM time_claim_jobs(1, '   ', 60);`, { sqlState: '22023' })
    const claim = (worker) => runSqlAsync(`BEGIN; SELECT id FROM time_claim_jobs(3, '${worker}', 60); SELECT pg_sleep(0.3); COMMIT;`)
    const [left, right] = await Promise.all([claim('worker-a'), claim('worker-b')])
    const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
    const ids = [...(left.match(uuidPattern) || []), ...(right.match(uuidPattern) || [])]
    expect(ids).toHaveLength(6)
    expect(new Set(ids).size).toBe(6)

    const oldLeaseToken = '60000000-0000-0000-0000-000000000001'
    const staleId = runSql(`INSERT INTO time_jobs
      (user_id, job_type, dedupe_key, status, attempts, ready_at, locked_at,
       locked_by, lease_until, lease_token)
      VALUES ('${USER_A}', 'AI_REVIEW', 'stale', 'PROCESSING', 1, NULL,
        now() - interval '2 minutes', 'same-worker', now() - interval '1 minute',
        '${oldLeaseToken}') RETURNING id;`)
    const [reclaimResult, expiredWorkerResult] = await Promise.allSettled([
      runSqlAsync(`SELECT lease_token FROM time_claim_jobs(1, 'same-worker', 60)
        WHERE id = '${staleId}';`),
      runSqlAsync(`SELECT id FROM time_complete_job(
        '${staleId}', 'same-worker', '${oldLeaseToken}', '{}');`)
    ])
    expect(reclaimResult.status).toBe('fulfilled')
    expect(expiredWorkerResult.status).toBe('rejected')
    const newLeaseToken = reclaimResult.value
    expect(newLeaseToken).not.toBe(oldLeaseToken)
    expect(runSql(`SELECT attempts FROM time_jobs WHERE id = '${staleId}';`)).toBe('2')
    expectSqlFailure(`SELECT * FROM time_fail_job(
      '${staleId}', 'same-worker', '${oldLeaseToken}', 'LATE_RESULT');`,
    { sqlState: '42501' })
    expect(runSql(`SELECT status FROM time_complete_job(
      '${staleId}', 'same-worker', '${newLeaseToken}', '{}');`)).toBe('COMPLETED')
  })

  test('applies 1/5/30 minute retries before the fourth final failure', () => {
    runSql(`DELETE FROM time_jobs;`)
    const jobId = runSql(`INSERT INTO time_jobs (user_id, job_type, dedupe_key)
      VALUES ('${USER_A}', 'AI_REVIEW', 'retry-sequence') RETURNING id;`)
    expect(runSql(`SELECT max_attempts FROM time_jobs WHERE id = '${jobId}';`)).toBe('4')

    const expectedBackoffs = [60, 300, 1800]
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const leaseToken = runSql(`SELECT lease_token FROM time_claim_jobs(
        1, 'retry-worker', 60) WHERE id = '${jobId}';`)
      const retrySeconds = Number(runSql(`SELECT EXTRACT(epoch FROM (ready_at - now()))::integer
        FROM time_fail_job('${jobId}', 'retry-worker', '${leaseToken}', 'FAIL_${attempt}');`))
      expect(retrySeconds).toBeGreaterThanOrEqual(expectedBackoffs[attempt - 1] - 5)
      expect(retrySeconds).toBeLessThanOrEqual(expectedBackoffs[attempt - 1])
      runSql(`UPDATE time_jobs SET ready_at = now() WHERE id = '${jobId}';`)
    }

    const finalLeaseToken = runSql(`SELECT lease_token FROM time_claim_jobs(
      1, 'retry-worker', 60) WHERE id = '${jobId}';`)
    expect(runSql(`SELECT status || '|' || attempts || '|' || (ready_at IS NULL)
      FROM time_fail_job('${jobId}', 'retry-worker', '${finalLeaseToken}', 'FAIL_4');`)).toMatch(/^FAILED\|4\|(t|true)$/)
  })

  test('allows only one normal complete-or-fail lease transition', async () => {
    runSql(`DELETE FROM time_jobs;`)
    const jobId = runSql(`INSERT INTO time_jobs
      (user_id, job_type, dedupe_key, max_attempts)
      VALUES ('${USER_A}', 'DAILY_METRICS', 'terminal-race', 1) RETURNING id;`)
    const leaseToken = runSql(`SELECT lease_token FROM time_claim_jobs(
      1, 'race-worker', 60) WHERE id = '${jobId}';`)
    const results = await Promise.allSettled([
      runSqlAsync(`SELECT status FROM time_complete_job(
        '${jobId}', 'race-worker', '${leaseToken}', '{}');`),
      runSqlAsync(`SELECT status FROM time_fail_job(
        '${jobId}', 'race-worker', '${leaseToken}', 'RACE_FAILURE');`)
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(runSql(`SELECT status || '|' || attempts || '|' ||
      (lease_token IS NULL) FROM time_jobs WHERE id = '${jobId}';`)).toMatch(/^(COMPLETED|FAILED)\|1\|(t|true)$/)
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
