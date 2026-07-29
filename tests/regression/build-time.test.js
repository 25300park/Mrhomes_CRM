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
})

test('Railway variable verification never retrieves values', () => {
  const runbook = fs.readFileSync(path.resolve(__dirname, '../../docs/time-management-operations.md'), 'utf8')

  expect(runbook).not.toMatch(/railway\s+(?:variable|variables|vars|var)\s+list\b/i)
  expect(runbook).not.toMatch(/railway\s+(?:variable|variables|vars|var)[^\r\n]*(?:--kv|-k|--json)\b/i)
  expect(runbook).toContain('Confirm only the variable names in the Railway dashboard; values must remain masked.')
  expect(runbook).toContain('if ($LASTEXITCODE -ne 0) { throw "Railway variable update failed." }')
})

test('forced re-login proves the same live canary session crosses the acknowledged cutoff', () => {
  const runbook = fs.readFileSync(path.resolve(__dirname, '../../docs/time-management-operations.md'), 'utf8')

  expect(runbook).toContain('$preCutoffSession = [Microsoft.PowerShell.Commands.WebRequestSession]::new()')
  expect(runbook).toContain('$preCutoffLoginBody = @{ email = $env:CRM_CANARY_EMAIL; password = $env:CRM_CANARY_PASSWORD } | ConvertTo-Json -Compress')
  expect(runbook).toContain('if ($preCutoffMe.StatusCode -ne 200) { throw "Pre-cutoff canary authentication baseline failed; stop rollout." }')
  expect(runbook).toContain('$preCutoffAuthenticatedAt = [DateTimeOffset]::UtcNow')
  expect(runbook).toContain('Impact: $env:FORCED_RELOGIN_NOTICE_IMPACT')
  expect(runbook).toContain('Cutoff UTC: $env:AUTH_INVALID_BEFORE')
  expect(runbook).toContain('Rollback contact: $env:FORCED_RELOGIN_ROLLBACK_CONTACT')
  expect(runbook).toContain('$env:FORCED_RELOGIN_NOTICE_ACK = Read-Host "Enter ACK-$env:CHANGE_APPROVAL_ID after the notice is delivered"')
  expect(runbook).toContain('Assert-ForcedReloginNoticeAcknowledged\nAssert-ApprovedRailwayTarget\nrailway variable set "AUTH_INVALID_BEFORE=$env:AUTH_INVALID_BEFORE"')
  expect(runbook).toContain('$postCutoffStaleMe = Invoke-WebRequest -Method Get -Uri "$env:APP_BASE_URL/api/auth/me" -WebSession $preCutoffSession -SkipHttpErrorCheck')
  expect(runbook).toContain('if ($postCutoffStaleMe.StatusCode -ne 401) { throw "The proven pre-cutoff session was not invalidated; stop and roll back." }')
  expect(runbook).toContain('if ($postCutoffFreshMe.StatusCode -ne 200) { throw "Fresh post-cutoff authentication failed; stop and roll back." }')
  expect(runbook).not.toContain('PRE_ROLLOUT_COOKIE_JAR')
})

test('canary CRM smoke covers auth, reversible password change, privacy, CSRF, CORS, and built assets', () => {
  const runbook = fs.readFileSync(path.resolve(__dirname, '../../docs/time-management-operations.md'), 'utf8')

  for (const contract of [
    '$dashboardSmoke = Invoke-WebRequest -Method Get -Uri "$env:APP_BASE_URL/api/dashboard" -WebSession $postCutoffSession -SkipHttpErrorCheck',
    '$csrfResponse = Invoke-WebRequest -Method Get -Uri "$env:APP_BASE_URL/api/auth/csrf" -WebSession $postCutoffSession -SkipHttpErrorCheck',
    '$noCsrfMutation = Invoke-WebRequest -Method Post -Uri "$env:APP_BASE_URL/api/auth/logout" -WebSession $postCutoffSession -SkipHttpErrorCheck',
    '$passwordChangeBody = @{ current = $env:CRM_CANARY_PASSWORD; next_pw = $env:CRM_CANARY_NEW_PASSWORD } | ConvertTo-Json -Compress',
    '$passwordRestoreBody = @{ current = $env:CRM_CANARY_NEW_PASSWORD; next_pw = $env:CRM_CANARY_PASSWORD } | ConvertTo-Json -Compress',
    '$anonymousAdmin = Invoke-WebRequest -Method Get -Uri "$env:APP_BASE_URL/api/time-management/analytics/admin/members/$env:SMOKE_BUSINESS_DATE" -SkipHttpErrorCheck',
    '$disallowedCors = Invoke-WebRequest -Method Get -Uri "$env:APP_BASE_URL/health" -Headers @{ Origin = $env:DISALLOWED_SMOKE_ORIGIN } -SkipHttpErrorCheck',
    '$timeDirect = Invoke-WebRequest -Method Get -Uri "$env:APP_BASE_URL/time-management/records" -SkipHttpErrorCheck',
    '$assetResponse = Invoke-WebRequest -Method Get -Uri "$env:APP_BASE_URL$assetPath" -SkipHttpErrorCheck'
  ]) expect(runbook).toContain(contract)

  expect(runbook).toContain('if ($passwordChange.StatusCode -ne 200) { throw "Canary password change failed; stop and roll back." }')
  expect(runbook).toContain('if ($passwordRestore.StatusCode -ne 200) { throw "CRITICAL: canary password restore failed; stop, keep scheduling disabled, and roll back." }')
  expect(runbook).toContain('if ($originalPasswordLogin.StatusCode -ne 200) { throw "Original canary password was not restored; stop and roll back." }')
  expect(runbook).toContain('if ($anonymousAdmin.StatusCode -ne 401 -or $anonymousAdmin.Content -match [regex]::Escape($env:PRIVACY_SENTINEL)) { throw "Anonymous private-data denial smoke failed; stop and roll back." }')
  expect(runbook).toContain('if ($noCsrfMutation.StatusCode -ne 403) { throw "CSRF denial smoke failed; stop and roll back." }')
  expect(runbook).toContain('if ($disallowedCors.StatusCode -ne 403 -or $disallowedCors.Headers.ContainsKey("Access-Control-Allow-Origin")) { throw "CORS denial smoke failed; stop and roll back." }')
  expect(runbook).toContain('$assetPaths = [regex]::Matches($timeRoot.Content, \'/time-management/assets/[^"]+\')')
})

test('canary secrets stay in environment-backed in-memory request bodies', () => {
  const runbook = fs.readFileSync(path.resolve(__dirname, '../../docs/time-management-operations.md'), 'utf8')

  expect(runbook).toContain('@("CRM_CANARY_EMAIL", "CRM_CANARY_PASSWORD", "CRM_CANARY_NEW_PASSWORD")')
  expect(runbook).not.toMatch(/\$env:CRM_CANARY_(?:EMAIL|PASSWORD|NEW_PASSWORD)\s*=/)
  expect(runbook).not.toMatch(/(?:curl\.exe|railway|psql|pg_dump)[^\r\n]*CRM_CANARY_/i)
  expect(runbook).not.toMatch(/Write-(?:Host|Output)[^\r\n]*CRM_CANARY_/i)
})

test('scheduler re-enable proves health and bounded successful startup logs', () => {
  const runbook = fs.readFileSync(path.resolve(__dirname, '../../docs/time-management-operations.md'), 'utf8')

  expect(runbook).toContain('$env:SCHEDULER_DEPLOYMENT_ID = "<scheduler-reenable-deployment-id-from-plain-list-or-dashboard>"')
  expect(runbook).toContain('$schedulerLogs = railway logs "$env:SCHEDULER_DEPLOYMENT_ID" --deployment --lines 200 --service "$env:RAILWAY_SERVICE_ID" --environment "$env:RAILWAY_ENVIRONMENT_ID"')
  expect(runbook).toContain('$serverStartupSignal = "RBS Homes CRM: http://0.0.0.0:"')
  expect(runbook).toContain('$schedulerStartupSignal = "팔로업 스케줄러 시작"')
  expect(runbook).toContain('$schedulerFailurePattern = "\\[Scheduler\\] failed to start:|\\[Scheduler\\] time job processing failed:|Required environment variables are missing:|UnhandledPromiseRejection|uncaught exception|npm ERR!"')
  expect(runbook).toContain('if ($schedulerLogText -notmatch [regex]::Escape($serverStartupSignal) -or $schedulerLogText -notmatch [regex]::Escape($schedulerStartupSignal) -or $schedulerLogText -match $schedulerFailurePattern) { throw "Scheduler startup evidence failed; disable scheduling and roll back." }')
  expect(runbook).toContain('$schedulerHealth = Invoke-WebRequest -Method Get -Uri "$env:APP_BASE_URL/health" -SkipHttpErrorCheck')
  expect(runbook).toContain('if ($schedulerHealth.StatusCode -ne 200) { throw "Scheduler re-enable health smoke failed; disable scheduling and roll back." }')
  expect(fs.readFileSync(path.resolve(__dirname, '../../server.js'), 'utf8')).toContain('RBS Homes CRM: http://0.0.0.0:')
})
