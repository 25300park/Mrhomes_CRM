const fs = require('node:fs')
const path = require('node:path')

const { businessDateAt } = require('../../services/time-management/time')
const { TimeManagementError } = require('../../services/time-management/errors')

describe('time-management database contract', () => {
  test('calculates the Seoul business date at the UTC day boundary', () => {
    expect(businessDateAt(new Date('2026-07-15T15:30:00Z'))).toBe('2026-07-16')
    expect(businessDateAt(new Date('2026-07-15T14:59:59Z'))).toBe('2026-07-15')
    expect(businessDateAt(new Date('2026-01-01T04:00:00Z'), 'America/New_York')).toBe('2025-12-31')
  })

  test('provides stable API errors', () => {
    const error = new TimeManagementError('INVALID_ENTRY', '잘못된 시간 기록입니다.', 422)

    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({
      name: 'TimeManagementError',
      code: 'INVALID_ENTRY',
      message: '잘못된 시간 기록입니다.',
      status: 422
    })
  })

  test('defines every approved time-management table', () => {
    const schema = fs.readFileSync(path.resolve('database/time-management.sql'), 'utf8')
    const approvedTables = [
      'time_standard_categories',
      'time_personal_categories',
      'time_daily_plans',
      'time_plan_allocations',
      'time_entries',
      'time_entry_revisions',
      'time_reflections',
      'time_ai_reviews',
      'time_daily_metrics',
      'time_team_keyword_aggregates',
      'time_reminder_preferences',
      'time_push_subscriptions',
      'time_jobs'
    ]

    for (const table of approvedTables) {
      expect(schema).toMatch(new RegExp(`create\\s+table\\s+if\\s+not\\s+exists\\s+${table}\\b`, 'i'))
    }

    // The approved 13-table model has no place to replay STOP commands, so a
    // minimal command ledger is required for the approved idempotency rule.
    expect(schema).toMatch(/create\s+table\s+if\s+not\s+exists\s+time_commands\b/i)

    expect(schema).toMatch(/references\s+users\s*\(\s*id\s*\)/i)
    expect(schema).toMatch(/num_nonnulls\s*\(\s*contact_id\s*,\s*listing_id\s*,\s*lead_id\s*,\s*deal_id\s*\)\s*<=\s*1/i)
    expect(schema).toMatch(/create\s+unique\s+index[\s\S]*on\s+time_entries\s*\(\s*user_id\s*\)[\s\S]*where\s+entry_type\s*=\s*'TIMER'\s+and\s+ended_at\s+is\s+null/i)
    expect(schema).toMatch(/unique\s*\(\s*user_id\s*,\s*business_date\s*\)/i)
    expect(schema).toMatch(/parent_standard_category_id\s+uuid\s+not\s+null/i)
    expect(schema).toMatch(/unique\s*\(\s*id\s*,\s*parent_standard_category_id\s*\)/i)
    expect(schema).toMatch(/duration_seconds\s+is\s+null\s+or\s+duration_seconds\s*>=\s*0/i)
    expect(schema).toMatch(/linked_entity_id\s*=\s*coalesce\s*\(\s*contact_id\s*,\s*listing_id\s*,\s*lead_id\s*,\s*deal_id\s*\)/i)
    expect(schema).toMatch(/business_date\s+date\s+not\s+null/i)
    expect(schema).toMatch(/on\s+time_entries\s*\(\s*user_id\s*,\s*business_date/i)
    expect(schema).toMatch(/unique\s*\(\s*user_id\s*,\s*request_id\s*\)/i)
    expect(schema).toMatch(/unique\s*\(\s*endpoint\s*\)/i)
    expect(schema).toMatch(/lease_until\s+timestamptz/i)
    expect(schema).toMatch(/business_time_zone\s*=\s*'Asia\/Seoul'/i)
    expect(schema).not.toMatch(/uuid_generate_v4/i)
    expect(schema).not.toMatch(/create\s+extension/i)
    expect(schema).toMatch(/server_version_num[\s\S]*130000/i)
    expect(schema).toMatch(/to_regprocedure\s*\(\s*'pg_catalog\.gen_random_uuid\(\)'\s*\)/i)
    expect(schema).toMatch(/default\s+pg_catalog\.gen_random_uuid\s*\(\s*\)/i)
    expect(schema).toMatch(/locked_by\s+is\s+null\s+or\s+btrim\s*\(\s*locked_by\s*\)\s*<>\s*''/i)
    expect(schema).toMatch(/unique\s*\(\s*id\s*,\s*user_id\s*,\s*business_date\s*\)/i)
    expect(schema).toMatch(/foreign\s+key\s*\(\s*daily_plan_id\s*,\s*user_id\s*,\s*business_date\s*\)/i)
    expect(schema).toMatch(/time_plan_allocations_standard_uq[\s\S]*where\s+personal_category_id\s+is\s+null/i)
    expect(schema).toMatch(/foreign\s+key\s*\(\s*personal_category_id\s*,\s*user_id\s*,\s*standard_category_id\s*\)/i)
    expect(schema).toMatch(/entry_type\s*=\s*'MANUAL'[\s\S]*ended_at\s+is\s+not\s+null[\s\S]*duration_seconds\s+is\s+not\s+null/i)
    expect(schema).toMatch(/entry_type\s*=\s*'TIMER'[\s\S]*ended_at\s+is\s+null/i)
    expect(schema).toMatch(/where\s+entry_type\s*=\s*'TIMER'\s+and\s+ended_at\s+is\s+null/i)
  })

  test('locks every time table behind the Express service role', () => {
    const schema = fs.readFileSync(path.resolve('database/time-management.sql'), 'utf8')

    expect(schema).toMatch(/alter\s+table\s+time_entries\s+enable\s+row\s+level\s+security/i)
    expect(schema).toMatch(/alter\s+table\s+time_entries\s+force\s+row\s+level\s+security/i)
    expect(schema).toMatch(/revoke\s+all[\s\S]*time_entries[\s\S]*from\s+public/i)
    expect(schema).toMatch(/rolname\s*=\s*'anon'/i)
    expect(schema).toMatch(/rolname\s*=\s*'authenticated'/i)
    expect(schema).toMatch(/rolname\s*=\s*'service_role'/i)
    expect(schema).toMatch(/grant\s+select\s*,\s*insert\s*,\s*update\s*,\s*delete/i)
  })

  test('defines hardened atomic timer and queue functions', () => {
    const functions = fs.readFileSync(path.resolve('database/time-management-functions.sql'), 'utf8')

    expect(functions).toMatch(/create\s+or\s+replace\s+function\s+(?:public\.)?time_switch_timer/i)
    expect(functions).toMatch(/create\s+or\s+replace\s+function\s+(?:public\.)?time_start_timer/i)
    expect(functions).toMatch(/create\s+or\s+replace\s+function\s+(?:public\.)?time_stop_timer/i)
    expect(functions).toMatch(/pg_advisory_xact_lock/i)
    expect(functions).toMatch(/request_id/i)
    expect(functions).toMatch(/create\s+or\s+replace\s+function\s+(?:public\.)?time_claim_jobs/i)
    expect(functions).toMatch(/for\s+update\s+skip\s+locked/i)
    expect(functions).toMatch(/least\s*\(/i)
    expect(functions).toMatch(/security\s+definer/i)
    expect(functions).toMatch(/set\s+search_path\s*=\s*pg_catalog\s*,\s*pg_temp/i)
    expect(functions).toMatch(/public\.time_entries/i)
    expect(functions).toMatch(/lease_until\s*<=\s*pg_catalog\.now\s*\(\s*\)/i)
    expect(functions).toMatch(/interval\s+'1 minute'/i)
    expect(functions).toMatch(/interval\s+'5 minutes'/i)
    expect(functions).toMatch(/interval\s+'30 minutes'/i)
    expect(functions).toMatch(/lease_until\s*>\s*pg_catalog\.now\s*\(\s*\)/i)
    expect(functions).toMatch(/revoke\s+all[\s\S]+from\s+public/i)
    expect(functions).toMatch(/from\s+anon/i)
    expect(functions).toMatch(/from\s+authenticated/i)
  })
})
