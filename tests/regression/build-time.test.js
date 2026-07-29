const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function runRootBuild() {
  if (process.platform === 'win32') {
    return spawnSync(process.env.ComSpec, ['/d', '/s', '/c', 'npm.cmd run build'], {
      cwd: path.resolve(__dirname, '../..'),
      encoding: 'utf8'
    })
  }
  return spawnSync('npm', ['run', 'build'], {
    cwd: path.resolve(__dirname, '../..'),
    encoding: 'utf8'
  })
}

test('the root time-management build script produces the CRM-hosted UI', () => {
  const result = runRootBuild()

  expect(result.error).toBeUndefined()
  expect(result.status).toBe(0)
  const index = fs.readFileSync(path.resolve(__dirname, '../../public/time-management/index.html'), 'utf8')
  const script = index.match(/src="\/time-management\/(assets\/[^\"]+\.js)"/)

  expect(index).toContain('<div id="root"></div>')
  expect(script).not.toBeNull()
  expect(fs.readFileSync(path.resolve(__dirname, '../../public/time-management', script[1]), 'utf8')).not.toContain('jsxDEV')
})

test('Nixpacks installs both lockfiles, runs the root build, and starts the server', () => {
  const config = fs.readFileSync(path.resolve(__dirname, '../../nixpacks.toml'), 'utf8')
  expect(config).toContain('npm ci')
  expect(config).toContain('npm --prefix time-management-ui ci')
  expect(config).toContain('npm run build')
  expect(config).toContain('npm start')
})

test('production migration commands require approval and a verified database fingerprint', () => {
  const runbook = fs.readFileSync(path.resolve(__dirname, '../../docs/time-management-operations.md'), 'utf8')

  expect(runbook).toContain('$env:TARGET_ENV = "production"')
  expect(runbook).toContain('$env:CHANGE_APPROVAL_ID = "<approved-change-id>"')
  expect(runbook).toContain('$env:EXPECTED_DB_FINGERPRINT = "<approved-production-db-name>|<approved-production-db-host>|<approved-production-marker>"')
  expect(runbook).toContain('Assert-ApprovedProductionTarget\npg_dump --format=custom --no-owner --no-acl --file "$env:APPROVED_BACKUP_PATH" "$env:PRODUCTION_DATABASE_URL"')
  expect(runbook).toContain('Assert-ApprovedProductionTarget\npsql "$env:PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "database/time-management.sql"')
  expect(runbook).toContain('Assert-ApprovedProductionTarget\npsql "$env:PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "database/time-management-functions.sql"')
})

test('Railway rollout and previous-SHA rollback commands are explicit and independently gated', () => {
  const runbook = fs.readFileSync(path.resolve(__dirname, '../../docs/time-management-operations.md'), 'utf8')

  for (const command of [
    'railway variable set "SCHEDULER_ENABLED=false" --skip-deploys --service "$env:RAILWAY_SERVICE_ID" --environment "$env:RAILWAY_ENVIRONMENT_ID"',
    'railway variable set "AUTH_INVALID_BEFORE=$env:AUTH_INVALID_BEFORE" --skip-deploys --service "$env:RAILWAY_SERVICE_ID" --environment "$env:RAILWAY_ENVIRONMENT_ID"',
    'railway up . --project "$env:RAILWAY_PROJECT_ID" --environment "$env:RAILWAY_ENVIRONMENT_ID" --service "$env:RAILWAY_SERVICE_ID" --message "approved $env:CHANGE_APPROVAL_ID candidate $env:CANDIDATE_SHA"',
    'railway deployment list --service "$env:RAILWAY_SERVICE_ID" --environment "$env:RAILWAY_ENVIRONMENT_ID" --limit 5',
    'railway logs "$env:NEW_DEPLOYMENT_ID" --deployment --lines 200 --service "$env:RAILWAY_SERVICE_ID" --environment "$env:RAILWAY_ENVIRONMENT_ID"',
    'railway variable set "SCHEDULER_ENABLED=true" --skip-deploys --service "$env:RAILWAY_SERVICE_ID" --environment "$env:RAILWAY_ENVIRONMENT_ID"',
    'railway up "$env:ROLLBACK_WORKTREE" --path-as-root --project "$env:RAILWAY_PROJECT_ID" --environment "$env:RAILWAY_ENVIRONMENT_ID" --service "$env:RAILWAY_SERVICE_ID" --message "approved rollback $env:ROLLBACK_APPROVAL_ID sha $env:PREVIOUS_APP_SHA"',
    'pg_restore --clean --if-exists --no-owner --no-acl --dbname "$env:PRODUCTION_DATABASE_URL" "$env:APPROVED_BACKUP_PATH"'
  ]) {
    expect(runbook).toContain(`Assert-Approved${command.startsWith('pg_restore') ? 'ProductionTarget' : 'RailwayTarget'}\n${command}`)
  }
  expect(runbook).toContain('$env:DB_ROLLBACK_DECISION = "<no-schema-rollback|logical-restore|provider-pitr>"')
  expect(runbook).toContain('$env:PREVIOUS_APP_SHA = "<40-char-previous-production-sha>"')
  expect(runbook).toContain('$env:PRE_ROLLOUT_COOKIE_JAR = "<absolute-path-to-approved-pre-rollout-cookie-jar>"')
})

test('Railway variable verification never retrieves values', () => {
  const runbook = fs.readFileSync(path.resolve(__dirname, '../../docs/time-management-operations.md'), 'utf8')

  expect(runbook).not.toMatch(/railway\s+(?:variable|variables|vars|var)\s+list\b/i)
  expect(runbook).not.toMatch(/railway\s+(?:variable|variables|vars|var)[^\r\n]*(?:--kv|-k|--json)\b/i)
  expect(runbook).toContain('Confirm only the variable names in the Railway dashboard; values must remain masked.')
  expect(runbook).toContain('if ($LASTEXITCODE -ne 0) { throw "Railway variable update failed." }')
})
