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
const USER_C = '00000000-0000-0000-0000-000000000003'
const STANDARD_A = '10000000-0000-0000-0000-000000000001'
const PERSONAL_B = '20000000-0000-0000-0000-000000000002'
const CONTACT_A = '30000000-0000-0000-0000-000000000001'
const CONTACT_DELETE = '30000000-0000-0000-0000-000000000002'
const CONTACT_FOR_LEAD = '30000000-0000-0000-0000-000000000003'
const LISTING_A = '40000000-0000-0000-0000-000000000001'
const LISTING_DELETE = '40000000-0000-0000-0000-000000000002'
const LISTING_FOR_DEAL = '40000000-0000-0000-0000-000000000003'
const LEAD_DELETE = '60000000-0000-0000-0000-000000000001'
const DEAL_DELETE = '70000000-0000-0000-0000-000000000001'
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
    const diagnostic = (result.stderr || '').split('\n').filter(line => /^(ERROR|DETAIL|CONTEXT):/.test(line)).join(' ')
    throw new Error(`Isolated PostgreSQL command failed: ${diagnostic || 'no PostgreSQL diagnostic'}`)
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
        ('${USER_B}', 'Agent B', 'agent-b@example.test', 'fixture', 'agent'),
        ('${USER_C}', 'Agent C', 'agent-c@example.test', 'fixture', 'agent');
      INSERT INTO contacts (id, name) VALUES
        ('${CONTACT_A}', 'Fixture contact'),
        ('${CONTACT_DELETE}', 'Deleted contact'),
        ('${CONTACT_FOR_LEAD}', 'Deleted lead contact');
      INSERT INTO listings (id, name) VALUES
        ('${LISTING_A}', 'Fixture listing'),
        ('${LISTING_DELETE}', 'Deleted listing'),
        ('${LISTING_FOR_DEAL}', 'Deleted deal listing');
      INSERT INTO leads (id, contact_id) VALUES ('${LEAD_DELETE}', '${CONTACT_FOR_LEAD}');
      INSERT INTO deals (id, listing_id, contract_date)
      VALUES ('${DEAL_DELETE}', '${LISTING_FOR_DEAL}', '2026-07-20');
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
    const actorAwareStart = `${schemaName}.time_start_timer(uuid,text,text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,timestamptz,text)`
    expect(runSql(`SELECT has_function_privilege('service_role', '${actorAwareStart}', 'EXECUTE');`)).toBe('t')
    expect(runSql(`SELECT has_function_privilege('anon', '${actorAwareStart}', 'EXECUTE');`)).toBe('f')
    expect(runSql(`SELECT has_function_privilege('authenticated', '${actorAwareStart}', 'EXECUTE');`)).toBe('f')
  })

  test('removes every actor-unaware CRM mutation RPC signature', () => {
    const legacySignatures = [
      'time_apply_timer_command(uuid,text,text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,timestamptz,text)',
      'time_start_timer(uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,timestamptz,text)',
      'time_switch_timer(uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,timestamptz,text)',
      'time_stop_timer(uuid,text,timestamptz,text)',
      'time_create_manual_entry(uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,timestamptz,timestamptz,text,text)',
      'time_revise_entry(uuid,uuid,text,uuid,uuid,timestamptz,timestamptz,text,text[],uuid,uuid,uuid,uuid,text)',
      'time_resolve_crm_link(text,uuid)',
      'time_search_crm_links(text,text[],integer)'
    ]
    const catalogList = legacySignatures
      .map(signature => `'${schemaName}.${signature}'`)
      .join(',')
    expect(runSql(`SELECT count(*) FROM pg_catalog.unnest(ARRAY[${catalogList}]) signature
      WHERE pg_catalog.to_regprocedure(signature) IS NOT NULL;`)).toBe('0')

    runSql(`GRANT USAGE ON SCHEMA ${schemaName} TO service_role, authenticated, anon;`)
    for (const role of ['service_role', 'authenticated', 'anon']) {
      expectSqlFailure(`SET ROLE ${role}; SELECT * FROM ${schemaName}.time_start_timer(
        '${USER_A}'::uuid, 'legacy-direct-call'::text, '${STANDARD_A}'::uuid,
        NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid,
        'forged label'::text, '2026-07-15T00:00:00Z'::timestamptz, 'Asia/Seoul'::text);`,
      { sqlState: '42883' })
    }
    runSql(`REVOKE USAGE ON SCHEMA ${schemaName} FROM service_role, authenticated, anon;`)
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
      FROM time_search_crm_links('${USER_A}', 'agent', '', ARRAY['LEAD', 'DEAL']::text[], 2);`)).toBe('LEAD:Alpha|DEAL:Alpha — 2026-07-01')
    expect(runSql(`SELECT has_function_privilege('service_role', '${schemaName}.time_search_crm_links(uuid,text,text,text[],integer)', 'EXECUTE');`)).toBe('t')
    expect(runSql(`SELECT has_function_privilege('anon', '${schemaName}.time_search_crm_links(uuid,text,text,text[],integer)', 'EXECUTE');`)).toBe('f')
  })

  test('uses one active actor/action policy for CRM search and exact resolution', () => {
    const policyResults = runSql(`
      BEGIN;
      SELECT 'active_actor_resolves|' || count(*) FROM time_resolve_crm_link(
        '${USER_A}', 'agent', 'CONTACT', '${CONTACT_A}');
      SELECT 'forged_role_is_rejected|' || count(*) FROM time_resolve_crm_link(
        '${USER_A}', 'admin', 'CONTACT', '${CONTACT_A}');
      SELECT 'missing_link_is_rejected|' || count(*) FROM time_resolve_crm_link(
        '${USER_A}', 'agent', 'CONTACT', 'ffffffff-ffff-4fff-8fff-ffffffffffff');
      UPDATE users SET is_active = false WHERE id = '${USER_A}';
      SELECT 'inactive_actor_cannot_resolve|' || count(*) FROM time_resolve_crm_link(
        '${USER_A}', 'agent', 'CONTACT', '${CONTACT_A}');
      SELECT 'inactive_actor_cannot_search|' || count(*) FROM time_search_crm_links(
        '${USER_A}', 'agent', '', ARRAY['CONTACT']::text[], 20);
      UPDATE users SET is_active = true WHERE id = '${USER_A}';
      COMMIT;
    `).split(/\r?\n/)

    expect(policyResults).toEqual([
      'active_actor_resolves|1',
      'forged_role_is_rejected|0',
      'missing_link_is_rejected|0',
      'inactive_actor_cannot_resolve|0',
      'inactive_actor_cannot_search|0'
    ])
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
      FROM time_start_timer('${USER_A}', 'agent', 'start-concurrent', '${STANDARD_A}',
        p_started_at => '2026-07-15T15:30:00Z');`)
    const starts = await Promise.all([start(), start()])
    expect(new Set(starts.map((value) => value.replace(/\|[01]$/, ''))).size).toBe(1)
    expect(starts.filter((value) => /\|1$/.test(value))).toHaveLength(1)
    expect(runSql(`SELECT business_date FROM time_entries WHERE user_id = '${USER_A}' AND ended_at IS NULL;`)).toBe('2026-07-16')

    const switchTimer = () => runSqlAsync(`SELECT stopped_entry_id || '|' ||
      COALESCE(started_entry_id::text, '') || '|' || CASE WHEN replayed THEN '1' ELSE '0' END
      FROM time_switch_timer('${USER_A}', 'agent', 'switch-concurrent', '${STANDARD_A}',
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
    expectSqlFailure(`SELECT * FROM time_stop_timer('${USER_A}', 'agent', 'bad-zone',
      '2026-07-15T16:00:00Z', 'UTC');`, { sqlState: '22023' })

    const stop = () => runSqlAsync(`SELECT stopped_entry_id || '|' || COALESCE(started_entry_id::text, '') || '|' ||
      CASE WHEN replayed THEN '1' ELSE '0' END
      FROM time_stop_timer('${USER_A}', 'agent', 'stop-concurrent', '2026-07-15T16:00:00Z', 'Asia/Seoul');`)
    const stops = await Promise.all([stop(), stop()])
    expect(new Set(stops.map((value) => value.replace(/\|[01]$/, ''))).size).toBe(1)
    expect(stops.filter((value) => /\|1$/.test(value))).toHaveLength(1)
    expect(runSql(`SELECT duration_seconds FROM time_entries
      WHERE request_id = 'switch-concurrent';`)).toBe('900')
  })

  test('rolls back the stopped timer if the replacement insert fails', () => {
    runSql(`SELECT * FROM time_start_timer('${USER_A}', 'agent', 'rollback-start', '${STANDARD_A}',
      p_started_at => '2026-07-15T17:00:00Z');`)
    const activeBefore = runSql(`SELECT id FROM time_entries WHERE user_id = '${USER_A}' AND ended_at IS NULL;`)
    expectSqlFailure(`SELECT * FROM time_switch_timer(
      '${USER_A}', 'agent', 'rollback-switch', '${STANDARD_A}',
      p_daily_plan_id => '${WRONG_DATE_PLAN}', p_started_at => '2026-07-15T17:30:00Z');`,
    { sqlState: '23503', constraint: 'time_entries_plan_owner_date_fk' })
    expect(runSql(`SELECT id FROM time_entries WHERE user_id = '${USER_A}' AND ended_at IS NULL;`)).toBe(activeBefore)
  })

  test('rejects inactive users and another user personal category', () => {
    runSql(`DELETE FROM time_commands WHERE user_id IN ('${USER_A}', '${USER_B}');
      DELETE FROM time_entries WHERE user_id IN ('${USER_A}', '${USER_B}');
      UPDATE users SET is_active = false WHERE id = '${USER_B}';`)
    expectSqlFailure(`SELECT * FROM time_start_timer(
      '${USER_B}', 'agent', 'inactive-user', '${STANDARD_A}',
      p_started_at => '2026-07-15T18:00:00Z');`, { sqlState: '42501' })
    runSql(`UPDATE users SET is_active = true WHERE id = '${USER_B}';`)
    expectSqlFailure(`SELECT * FROM time_start_timer(
      '${USER_A}', 'agent', 'other-personal-category', '${STANDARD_A}',
      p_personal_category_id => '${PERSONAL_B}',
      p_started_at => '2026-07-15T18:00:00Z');`, { sqlState: '42501' })
  })

  test('replays omitted timestamps and rejects reused request IDs with different semantics', async () => {
    runSql(`DELETE FROM time_commands WHERE user_id = '${USER_A}';
      DELETE FROM time_entries WHERE user_id = '${USER_A}';`)

    const first = runSql(`SELECT started_entry_id FROM time_start_timer(
      '${USER_A}', 'agent', 'omitted-sequential', '${STANDARD_A}');`)
    const replay = runSql(`SELECT started_entry_id FROM time_start_timer(
      '${USER_A}', 'agent', 'omitted-sequential', '${STANDARD_A}');`)
    expect(replay).toBe(first)
    expect(runSql(`SELECT
      ((command.response_payload ->> 'started_entry_id')::uuid = entry.id)
      FROM time_commands command
      JOIN time_entries entry ON entry.id = (command.response_payload ->> 'started_entry_id')::uuid
      WHERE command.user_id = '${USER_A}' AND command.request_id = 'omitted-sequential';`)).toBe('t')
    expectSqlFailure(`SELECT * FROM time_stop_timer(
      '${USER_A}', 'agent', 'omitted-sequential', NULL, 'Asia/Seoul');`,
    { sqlState: '23505', constraint: 'time_commands_user_id_request_id_key' })
    expectSqlFailure(`SELECT * FROM time_start_timer(
      '${USER_A}', 'agent', 'omitted-sequential', '${STANDARD_A}',
      p_contact_id => '${CONTACT_A}', p_linked_entity_label => 'different');`,
    { sqlState: '23505', constraint: 'time_commands_user_id_request_id_key' })
    runSql(`SELECT * FROM time_stop_timer('${USER_A}', 'agent', 'omitted-cleanup', NULL, 'Asia/Seoul');`)

    runSql(`DELETE FROM time_commands WHERE user_id = '${USER_A}';
      DELETE FROM time_entries WHERE user_id = '${USER_A}';`)
    const omittedConcurrent = () => runSqlAsync(`SELECT started_entry_id FROM time_start_timer(
      '${USER_A}', 'agent', 'omitted-concurrent', '${STANDARD_A}');`)
    const concurrent = await Promise.all([omittedConcurrent(), omittedConcurrent()])
    expect(new Set(concurrent).size).toBe(1)
    expect(runSql(`SELECT count(*) FROM time_entries
      WHERE user_id = '${USER_A}' AND request_id = 'omitted-concurrent';`)).toBe('1')
    runSql(`SELECT * FROM time_stop_timer('${USER_A}', 'agent', 'omitted-concurrent-cleanup', NULL, 'Asia/Seoul');`)

    runSql(`DELETE FROM time_commands WHERE user_id = '${USER_A}';
      DELETE FROM time_entries WHERE user_id = '${USER_A}';`)
    const explicit = runSql(`SELECT started_entry_id FROM time_start_timer(
      '${USER_A}', 'agent', 'explicit-time', '${STANDARD_A}',
      p_started_at => '2026-07-15T19:00:00Z');`)
    expect(runSql(`SELECT started_entry_id FROM time_start_timer(
      '${USER_A}', 'agent', 'explicit-time', '${STANDARD_A}',
      p_started_at => '2026-07-15T19:00:00Z');`)).toBe(explicit)
    expectSqlFailure(`SELECT * FROM time_start_timer(
      '${USER_A}', 'agent', 'explicit-time', '${STANDARD_A}',
      p_started_at => '2026-07-15T19:00:01Z');`,
    { sqlState: '23505', constraint: 'time_commands_user_id_request_id_key' })
  }, 30_000)

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
  }, 30_000)

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

  test('atomically replaces daily-plan allocations and rolls back invalid replacements', async () => {
    runSql(`DELETE FROM time_plan_allocations WHERE daily_plan_id = '${PLAN_A}';`)
    const valid = `[{"standardCategoryId":"${STANDARD_A}","personalCategoryId":null,"plannedMinutes":90}]`
    expect(runSql(`SELECT allocation_total FROM time_save_daily_plan(
      '${USER_A}', '2026-07-16', 480, '${valid}'::jsonb);`)).toBe('90')
    expect(runSql(`SELECT sum(planned_minutes) FROM time_plan_allocations WHERE daily_plan_id = '${PLAN_A}';`)).toBe('90')

    const invalid = `[{"standardCategoryId":"${STANDARD_A}","personalCategoryId":"${PERSONAL_B}","plannedMinutes":30}]`
    expectSqlFailure(`SELECT * FROM time_save_daily_plan(
      '${USER_A}', '2026-07-16', 480, '${invalid}'::jsonb);`, { sqlState: '42501' })
    expect(runSql(`SELECT sum(planned_minutes) FROM time_plan_allocations WHERE daily_plan_id = '${PLAN_A}';`)).toBe('90')

    const save = (minutes) => runSqlAsync(`SELECT allocation_total FROM time_save_daily_plan(
      '${USER_A}', '2026-07-16', 480,
      '[{"standardCategoryId":"${STANDARD_A}","personalCategoryId":null,"plannedMinutes":${minutes}}]'::jsonb);`)
    await Promise.all([save(120), save(150)])
    expect(runSql(`SELECT count(*) || '|' || sum(planned_minutes) FROM time_plan_allocations WHERE daily_plan_id = '${PLAN_A}';`)).toMatch(/^1\|(120|150)$/)
  })

  test('creates idempotent complete manual entries and rejects overlaps', () => {
    runSql(`DELETE FROM time_commands WHERE user_id = '${USER_A}'; DELETE FROM time_entries WHERE user_id = '${USER_A}';`)
    const created = runSql(`SELECT entry_id FROM time_create_manual_entry(
      '${USER_A}', 'manual-db-1', '${STANDARD_A}', NULL, '${PLAN_A}',
      '${CONTACT_A}', NULL, NULL, NULL, 'Fixture contact',
      '2026-07-16T01:00:00Z', '2026-07-16T02:00:00Z', 'note', 'Asia/Seoul', 'agent');`)
    expect(runSql(`SELECT entry_id || '|' || replayed FROM time_create_manual_entry(
      '${USER_A}', 'manual-db-1', '${STANDARD_A}', NULL, '${PLAN_A}',
      '${CONTACT_A}', NULL, NULL, NULL, 'Fixture contact',
      '2026-07-16T01:00:00Z', '2026-07-16T02:00:00Z', 'note', 'Asia/Seoul', 'agent');`)).toMatch(new RegExp(`^${created}\\|(t|true)$`))
    expect(runSql(`SELECT entry_type || '|' || duration_seconds || '|' || linked_entity_label FROM time_entries WHERE id = '${created}';`)).toBe('MANUAL|3600|Fixture contact')
    expectSqlFailure(`SELECT * FROM time_create_manual_entry(
      '${USER_A}', 'manual-db-overlap', '${STANDARD_A}', NULL, '${PLAN_A}',
      NULL, NULL, NULL, NULL, NULL,
      '2026-07-16T01:30:00Z', '2026-07-16T02:30:00Z', NULL, 'Asia/Seoul', 'agent');`, { sqlState: '23P01', constraint: 'time_entries_user_time_overlap' })
  })

  test('atomically revises owned entries and keeps revision rows immutable', () => {
    const entryId = runSql(`SELECT entry_id FROM time_create_manual_entry(
      '${USER_A}', 'manual-db-1', '${STANDARD_A}', NULL, '${PLAN_A}',
      '${CONTACT_A}', NULL, NULL, NULL, 'Fixture contact',
      '2026-07-16T01:00:00Z', '2026-07-16T02:00:00Z', 'note', 'Asia/Seoul', 'agent');`)
    const revised = runSql(`SELECT revision_id FROM time_revise_entry(
      '${USER_A}', '${entryId}', 'revise-db-1', NULL, NULL,
      NULL, NULL, 'revised', ARRAY['notes']::text[],
      NULL, NULL, NULL, NULL, NULL, 'agent');`)
    expect(runSql(`SELECT (before_value->>'notes') || '|' || (after_value->>'notes') FROM time_entry_revisions WHERE id = '${revised}';`)).toBe('note|revised')
    expect(runSql(`SELECT revision_id FROM time_revise_entry(
      '${USER_A}', '${entryId}', 'revise-db-1', NULL, NULL,
      NULL, NULL, 'revised', ARRAY['notes']::text[],
      NULL, NULL, NULL, NULL, NULL, 'agent');`)).toBe(revised)
    expectSqlFailure(`UPDATE time_entry_revisions SET after_value = '{}' WHERE id = '${revised}';`, { sqlState: '42501' })
    expectSqlFailure(`SELECT * FROM time_revise_entry(
      '${USER_B}', '${entryId}', 'revise-other-owner', NULL, NULL,
      NULL, NULL, 'stolen', ARRAY['notes']::text[],
      NULL, NULL, NULL, NULL, NULL, 'agent');`, { sqlState: '42501' })
  })

  test('enforces non-overlap for direct writes, timer commands, manual entries, and revisions', () => {
    const overlapConstraintCount = () => runSql(`SELECT count(*)
      FROM pg_catalog.pg_constraint
      WHERE conrelid = 'time_entries'::regclass
        AND conname = 'time_entries_user_time_overlap';`)
    expect(overlapConstraintCount()).toBe('1')

    runSql(`DELETE FROM time_commands WHERE user_id = '${USER_C}'; DELETE FROM time_entries WHERE user_id = '${USER_C}';`)
    runSql(`INSERT INTO time_entries
      (user_id, business_date, standard_category_id, entry_type, started_at, ended_at, duration_seconds)
      VALUES ('${USER_C}', '2026-07-16', '${STANDARD_A}', 'MANUAL',
        '2026-07-16T01:00:00Z', '2026-07-16T02:00:00Z', 3600);`)
    expectSqlFailure(`INSERT INTO time_entries
      (user_id, business_date, standard_category_id, entry_type, started_at, ended_at, duration_seconds)
      VALUES ('${USER_C}', '2026-07-16', '${STANDARD_A}', 'MANUAL',
        '2026-07-16T01:30:00Z', '2026-07-16T02:30:00Z', 3600);`,
    { sqlState: '23P01', constraint: 'time_entries_user_time_overlap' })
    runSql(`INSERT INTO time_entries
      (user_id, business_date, standard_category_id, entry_type, started_at, ended_at, duration_seconds)
      VALUES ('${USER_C}', '2026-07-16', '${STANDARD_A}', 'MANUAL',
        '2026-07-16T02:00:00Z', '2026-07-16T03:00:00Z', 3600);`)

    expectSqlFailure(`SELECT * FROM time_start_timer(
      '${USER_C}', 'agent', 'backdated-start-overlap', '${STANDARD_A}',
      p_started_at => '2026-07-16T01:15:00Z');`,
    { sqlState: '23P01', constraint: 'time_entries_user_time_overlap' })
    expectSqlFailure(`SELECT * FROM time_create_manual_entry(
      '${USER_C}', 'manual-overlap-db-constraint', '${STANDARD_A}', NULL, NULL,
      NULL, NULL, NULL, NULL, NULL,
      '2026-07-16T02:30:00Z', '2026-07-16T03:30:00Z', NULL, 'Asia/Seoul', 'agent');`,
    { sqlState: '23P01', constraint: 'time_entries_user_time_overlap' })

    const boundaryId = runSql(`SELECT id FROM time_entries WHERE user_id = '${USER_C}'
      AND started_at = '2026-07-16T02:00:00Z';`)
    expectSqlFailure(`SELECT * FROM time_revise_entry(
      '${USER_C}', '${boundaryId}', 'revise-overlap-db-constraint', NULL, NULL,
      '2026-07-16T01:30:00Z', NULL, NULL, ARRAY['startedAt']::text[],
      NULL, NULL, NULL, NULL, NULL, 'agent');`,
    { sqlState: '23P01', constraint: 'time_entries_user_time_overlap' })
    expect(runSql(`SELECT started_at FROM time_entries WHERE id = '${boundaryId}';`)).toBe('2026-07-16 02:00:00+00')
    expect(runSql(`SELECT count(*) FROM time_entry_revisions WHERE entry_id = '${boundaryId}';`)).toBe('0')

    try {
      runSql(`DELETE FROM time_commands WHERE user_id = '${USER_C}'; DELETE FROM time_entries WHERE user_id = '${USER_C}';
        ALTER TABLE time_entries DROP CONSTRAINT time_entries_user_time_overlap;
        INSERT INTO time_entries
          (user_id, business_date, standard_category_id, entry_type, started_at, ended_at, duration_seconds)
        VALUES
          ('${USER_C}', '2026-07-18', '${STANDARD_A}', 'MANUAL', '2026-07-18T01:00:00Z', '2026-07-18T03:00:00Z', 7200),
          ('${USER_C}', '2026-07-18', '${STANDARD_A}', 'MANUAL', '2026-07-18T02:00:00Z', '2026-07-18T04:00:00Z', 7200);`)
      const conflictingMigration = psql(migrationSql().schema)
      expect(conflictingMigration.status).not.toBe(0)
      expect(conflictingMigration.stderr).toContain('time_entries_user_time_overlap')
    } finally {
      runSql(`DELETE FROM time_entries WHERE user_id = '${USER_C}' AND business_date = '2026-07-18';`)
      const restoredMigration = psql(migrationSql().schema)
      if (restoredMigration.status !== 0) {
        throw new Error('Could not restore time_entries_user_time_overlap after conflict probe.')
      }
    }
    expect(overlapConstraintCount()).toBe('1')
  }, 40_000)

  test('replays canonical CRM commands before actor and mutable source checks', () => {
    runSql(`DELETE FROM time_commands WHERE user_id = '${USER_B}'; DELETE FROM time_entries WHERE user_id = '${USER_B}';`)
    const first = runSql(`SELECT entry_id FROM time_create_manual_entry(
      '${USER_B}', 'crm-replay-before-lookup', '${STANDARD_A}', NULL, NULL,
      '${CONTACT_DELETE}', NULL, NULL, NULL, NULL,
      '2026-07-20T01:00:00Z', '2026-07-20T02:00:00Z', 'original', 'Asia/Seoul', 'agent');`)
    expect(runSql(`SELECT linked_entity_label FROM time_entries WHERE id = '${first}';`)).toBe('Deleted contact')
    runSql(`UPDATE contacts SET name = 'Renamed after command' WHERE id = '${CONTACT_DELETE}';
      UPDATE users SET is_active = false WHERE id = '${USER_B}';`)
    expect(runSql(`SELECT entry_id || '|' || replayed FROM time_create_manual_entry(
      '${USER_B}', 'crm-replay-before-lookup', '${STANDARD_A}', NULL, NULL,
      '${CONTACT_DELETE}', NULL, NULL, NULL, 'ignored changed label',
      '2026-07-20T01:00:00Z', '2026-07-20T02:00:00Z', 'original', 'Asia/Seoul', 'agent');`))
      .toMatch(new RegExp(`^${first}\\|(t|true)$`))
    runSql(`UPDATE users SET is_active = true WHERE id = '${USER_B}'; DELETE FROM contacts WHERE id = '${CONTACT_DELETE}';`)
    expect(runSql(`SELECT entry_id FROM time_create_manual_entry(
      '${USER_B}', 'crm-replay-before-lookup', '${STANDARD_A}', NULL, NULL,
      '${CONTACT_DELETE}', NULL, NULL, NULL, NULL,
      '2026-07-20T01:00:00Z', '2026-07-20T02:00:00Z', 'original', 'Asia/Seoul', 'agent');`)).toBe(first)
    expectSqlFailure(`SELECT * FROM time_create_manual_entry(
      '${USER_B}', 'crm-replay-before-lookup', '${STANDARD_A}', NULL, NULL,
      NULL, NULL, NULL, NULL, NULL,
      '2026-07-20T01:00:00Z', '2026-07-20T02:00:00Z', 'changed', 'Asia/Seoul', 'agent');`,
    { sqlState: '23505', constraint: 'time_commands_user_id_request_id_key' })
  })

  test('preserves attached snapshots through source deletion and no-link revisions', () => {
    const listingEntry = runSql(`SELECT entry_id FROM time_create_manual_entry(
      '${USER_B}', 'detach-listing', '${STANDARD_A}', NULL, NULL,
      NULL, '${LISTING_DELETE}', NULL, NULL, NULL,
      '2026-07-20T02:00:00Z', '2026-07-20T03:00:00Z', NULL, 'Asia/Seoul', 'agent');`)
    const leadEntry = runSql(`SELECT entry_id FROM time_create_manual_entry(
      '${USER_B}', 'detach-lead', '${STANDARD_A}', NULL, NULL,
      NULL, NULL, '${LEAD_DELETE}', NULL, NULL,
      '2026-07-20T03:00:00Z', '2026-07-20T04:00:00Z', NULL, 'Asia/Seoul', 'agent');`)
    const dealEntry = runSql(`SELECT entry_id FROM time_create_manual_entry(
      '${USER_B}', 'detach-deal', '${STANDARD_A}', NULL, NULL,
      NULL, NULL, NULL, '${DEAL_DELETE}', NULL,
      '2026-07-20T04:00:00Z', '2026-07-20T05:00:00Z', NULL, 'Asia/Seoul', 'agent');`)

    runSql(`DELETE FROM listings WHERE id = '${LISTING_DELETE}';
      DELETE FROM leads WHERE id = '${LEAD_DELETE}';
      DELETE FROM deals WHERE id = '${DEAL_DELETE}';`)
    expect(runSql(`SELECT count(*) FROM time_entries
      WHERE request_id IN ('crm-replay-before-lookup', 'detach-listing', 'detach-lead', 'detach-deal')
      AND num_nonnulls(contact_id, listing_id, lead_id, deal_id) = 0
      AND linked_entity_type IS NOT NULL AND linked_entity_id IS NOT NULL
      AND btrim(linked_entity_label) <> '' AND linked_entity_detached_at IS NOT NULL;`)).toBe('4')

    expectSqlFailure(`INSERT INTO time_entries
      (user_id, business_date, standard_category_id, entry_type, started_at, ended_at, duration_seconds,
       linked_entity_type, linked_entity_id, linked_entity_label, linked_entity_detached_at)
      VALUES ('${USER_B}', '2026-07-20', '${STANDARD_A}', 'MANUAL',
       '2026-07-20T05:00:00Z', '2026-07-20T06:00:00Z', 3600,
       'CONTACT', '${CONTACT_A}', 'forged detached snapshot', now());`,
    { sqlState: '23514', constraint: 'time_entries_crm_snapshot_transition' })

    const attached = runSql(`SELECT entry_id FROM time_create_manual_entry(
      '${USER_B}', 'attached-direct-orphan', '${STANDARD_A}', NULL, NULL,
      '${CONTACT_A}', NULL, NULL, NULL, NULL,
      '2026-07-20T05:00:00Z', '2026-07-20T06:00:00Z', NULL, 'Asia/Seoul', 'agent');`)
    expectSqlFailure(`UPDATE time_entries SET contact_id = NULL, linked_entity_detached_at = now()
      WHERE id = '${attached}';`, { sqlState: '23514', constraint: 'time_entries_crm_snapshot_transition' })

    runSql(`SELECT * FROM time_revise_entry(
      '${USER_B}', '${listingEntry}', 'detached-notes-revision', NULL, NULL,
      NULL, NULL, 'snapshot remains', ARRAY['notes','notes']::text[],
      NULL, NULL, NULL, NULL, NULL, 'agent');`)
    expect(runSql(`SELECT linked_entity_type || '|' || linked_entity_label || '|' ||
      (linked_entity_detached_at IS NOT NULL) FROM time_entries WHERE id = '${listingEntry}';`))
      .toMatch(/^LISTING\|Deleted listing\|(t|true)$/)
    expect(runSql(`SELECT replayed FROM time_revise_entry(
      '${USER_B}', '${listingEntry}', 'detached-notes-revision', NULL, NULL,
      NULL, NULL, 'snapshot remains', ARRAY['notes']::text[],
      NULL, NULL, NULL, NULL, NULL, 'agent');`)).toMatch(/^(t|true)$/)
    expect(runSql(`SELECT count(*) FROM time_entries WHERE id IN ('${listingEntry}', '${leadEntry}', '${dealEntry}');`)).toBe('3')
  })

  test('writes revision audit before update and rolls it back when the update fails', () => {
    const entryId = runSql(`SELECT entry_id FROM time_create_manual_entry(
      '${USER_A}', 'audit-order-entry', '${STANDARD_A}', NULL, NULL,
      NULL, NULL, NULL, NULL, NULL,
      '2026-07-21T01:00:00Z', '2026-07-21T02:00:00Z', 'before', 'Asia/Seoul', 'agent');`)
    runSql(`CREATE FUNCTION time_test_require_audit_before_update() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM ${schemaName}.time_entry_revisions WHERE entry_id = OLD.id) THEN
          RAISE EXCEPTION 'revision audit must exist before update';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER time_test_require_audit_before_update_trg
      BEFORE UPDATE ON time_entries FOR EACH ROW EXECUTE FUNCTION time_test_require_audit_before_update();`)
    expect(runSql(`SELECT revision_id FROM time_revise_entry(
      '${USER_A}', '${entryId}', 'audit-before-update', NULL, NULL,
      NULL, NULL, 'after', ARRAY['notes']::text[],
      NULL, NULL, NULL, NULL, NULL, 'agent');`)).toMatch(/^[0-9a-f-]{36}$/)
    runSql(`DROP TRIGGER time_test_require_audit_before_update_trg ON time_entries;
      DROP FUNCTION time_test_require_audit_before_update();`)

    const beforeCount = runSql(`SELECT count(*) FROM time_entry_revisions WHERE entry_id = '${entryId}';`)
    runSql(`CREATE FUNCTION time_test_fail_after_entry_update() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced update failure'; END $$;
      CREATE TRIGGER time_test_fail_after_entry_update_trg
      AFTER UPDATE ON time_entries FOR EACH ROW EXECUTE FUNCTION time_test_fail_after_entry_update();`)
    expectSqlFailure(`SELECT * FROM time_revise_entry(
      '${USER_A}', '${entryId}', 'audit-rollback', NULL, NULL,
      NULL, NULL, 'must rollback', ARRAY['notes']::text[],
      NULL, NULL, NULL, NULL, NULL, 'agent');`, { sqlState: 'P0001' })
    expect(runSql(`SELECT count(*) FROM time_entry_revisions WHERE entry_id = '${entryId}';`)).toBe(beforeCount)
    expect(runSql(`SELECT notes FROM time_entries WHERE id = '${entryId}';`)).toBe('after')
    expect(runSql(`SELECT count(*) FROM time_commands WHERE user_id = '${USER_A}' AND request_id = 'audit-rollback';`)).toBe('0')
    runSql(`DROP TRIGGER time_test_fail_after_entry_update_trg ON time_entries;
      DROP FUNCTION time_test_fail_after_entry_update();`)
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
