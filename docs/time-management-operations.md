# Time-management operations runbook

This is a procedure, not evidence that a rollout occurred. Task 12 did not push, deploy, or execute SQL.

## Release-candidate build (local or CI)

Run these exact commands from the repository root with Node.js 22.22 or newer:

```bash
npm ci
npm --prefix time-management-ui ci
npm run build
npm run test:unit
npm run test:regression
npm run test:e2e
test -f public/time-management/index.html
```

Railway/Nixpacks is committed in `nixpacks.toml`. Its install phase runs both lockfiles, its build phase runs `npm run build`, and its start command is `npm start`. Do not override those commands in the Railway service UI.

## Marked staging migration commands

These commands are examples for an already authorized staging window. The operator must obtain `STAGING_DATABASE_URL` from the approved secret manager; never paste it into a ticket or shell history.

```bash
test "$TARGET_ENV" = "staging"
test -n "$STAGING_DATABASE_URL"
pg_dump --format=custom --no-owner --no-acl --file "$APPROVED_BACKUP_PATH" "$STAGING_DATABASE_URL"
test -s "$APPROVED_BACKUP_PATH"
pg_restore --list "$APPROVED_BACKUP_PATH" >/dev/null
psql "$STAGING_DATABASE_URL" -v ON_ERROR_STOP=1 -f database/time-management.sql
psql "$STAGING_DATABASE_URL" -v ON_ERROR_STOP=1 -f database/time-management-functions.sql
```

## Exact production rollout procedure (separate authorization required)

These PowerShell 7 examples are an execution procedure only. They were not run for Task 12. Replace every `<...>` placeholder from the approved change record or secret manager. Never paste a database URL, token, cookie, or variable value into captured evidence.

The Railway syntax below was checked against the official [`variable`](https://docs.railway.com/cli/variable), [`up`](https://docs.railway.com/cli/up), [`deployment`](https://docs.railway.com/cli/deployment), [`logs`](https://docs.railway.com/cli/logs), and [deployment actions](https://docs.railway.com/deployments/deployment-actions) documentation on 2026-07-29. `railway up` accepts explicit project, environment, and service targets; `railway variable set` accepts service/environment targets and `--skip-deploys`; historical deployment rollback remains a dashboard action, so the command-only rollback below deploys a verified previous Git SHA with `railway up <PATH> --path-as-root`.

### 1. Bind the approved change, application SHA, and targets

```powershell
$env:TARGET_ENV = "production"
$env:CHANGE_APPROVAL_ID = "<approved-change-id>"
$env:CHANGE_APPROVAL_CONFIRMED = "<yes-after-separate-authorization>"
$env:CANDIDATE_SHA = "<40-char-reviewed-candidate-sha>"
$env:PREVIOUS_APP_SHA = "<40-char-previous-production-sha>"
$env:PRODUCTION_DATABASE_URL = "<load-from-approved-secret-manager-into-this-shell>"
$env:EXPECTED_DB_HOST = "<approved-production-db-host>"
$env:EXPECTED_DB_FINGERPRINT = "<approved-production-db-name>|<approved-production-db-host>|<approved-production-marker>"
$env:APPROVED_BACKUP_PATH = "<absolute-approved-backup-path>"
$env:TIME_SCHEMA_SHA256 = "<reviewed-time-management.sql-sha256>"
$env:TIME_FUNCTIONS_SHA256 = "<reviewed-time-management-functions.sql-sha256>"
$env:RAILWAY_PROJECT_ID = "<production-project-id>"
$env:RAILWAY_ENVIRONMENT_ID = "<production-environment-id>"
$env:RAILWAY_SERVICE_ID = "<production-service-id>"
$env:EXPECTED_RAILWAY_TARGET = "$env:RAILWAY_PROJECT_ID|$env:RAILWAY_ENVIRONMENT_ID|$env:RAILWAY_SERVICE_ID"
$env:RAILWAY_TARGET_VERIFIED = "<set-after-status-and-dashboard-target-check>"
$env:AUTH_INVALID_BEFORE = "<YYYY-MM-DDTHH:mm:ssZ-approved-rollout-instant>"
$env:APP_BASE_URL = "<https-production-application-origin>"
$env:PRE_ROLLOUT_COOKIE_JAR = "<absolute-path-to-approved-pre-rollout-cookie-jar>"

function Assert-ApprovedChange {
  if ($env:TARGET_ENV -ne "production" -or $env:CHANGE_APPROVAL_CONFIRMED -ne "yes" -or $env:CHANGE_APPROVAL_ID -like "<*") { throw "Separate production approval is missing." }
  $head = (git rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $head -ne $env:CANDIDATE_SHA) { throw "HEAD is not the reviewed candidate SHA." }
  if (git status --porcelain) { throw "The candidate worktree is not clean." }
}

function Assert-ApprovedProductionTarget {
  Assert-ApprovedChange
  if ($env:DB_TARGET_VERIFIED -ne $env:EXPECTED_DB_FINGERPRINT) { throw "Production database target is not verified." }
}

function Assert-ApprovedRailwayTarget {
  Assert-ApprovedChange
  if ($env:RAILWAY_TARGET_VERIFIED -ne $env:EXPECTED_RAILWAY_TARGET) { throw "Railway production target is not verified." }
}

Assert-ApprovedChange
$databaseUri = [System.Uri]$env:PRODUCTION_DATABASE_URL
if ($databaseUri.Host -ne $env:EXPECTED_DB_HOST) { throw "Production database hostname mismatch." }
Assert-ApprovedChange
$dbNameAndMarker = (psql "$env:PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atc "SELECT current_database() || '|' || current_setting('app.environment', true)").Trim()
if ($LASTEXITCODE -ne 0 -or $dbNameAndMarker.Split('|').Count -ne 2) { throw "Production database marker lookup failed." }
$dbFingerprint = "$($dbNameAndMarker.Split('|')[0])|$($databaseUri.Host)|$($dbNameAndMarker.Split('|')[1])"
if ($LASTEXITCODE -ne 0 -or $dbFingerprint -ne $env:EXPECTED_DB_FINGERPRINT) { throw "Production database fingerprint mismatch." }
$env:DB_TARGET_VERIFIED = $dbFingerprint

Assert-ApprovedChange
railway status
if ($LASTEXITCODE -ne 0) { throw "Railway status failed." }
```

Compare the non-secret project, environment, and service IDs printed by `railway status` with the three approved IDs and the Railway dashboard. Only then set `$env:RAILWAY_TARGET_VERIFIED` to `<production-project-id>|<production-environment-id>|<production-service-id>` and run both assertion functions. `railway status` does not display service variable values.

### 2. Stop Push/AI jobs and force re-login before migration

`SCHEDULER_ENABLED=false` stops both Push/reminder delivery and AI job leasing. `AUTH_INVALID_BEFORE` invalidates sessions issued before the approved UTC instant.

```powershell
Assert-ApprovedRailwayTarget
railway variable set "SCHEDULER_ENABLED=false" --skip-deploys --service "$env:RAILWAY_SERVICE_ID" --environment "$env:RAILWAY_ENVIRONMENT_ID"
if ($LASTEXITCODE -ne 0) { throw "Railway variable update failed." }
Assert-ApprovedRailwayTarget
railway variable set "AUTH_INVALID_BEFORE=$env:AUTH_INVALID_BEFORE" --skip-deploys --service "$env:RAILWAY_SERVICE_ID" --environment "$env:RAILWAY_ENVIRONMENT_ID"
if ($LASTEXITCODE -ne 0) { throw "Railway variable update failed." }
```

Confirm only the variable names in the Railway dashboard; values must remain masked. Do not use a Railway variable-list command or any machine-readable variable output. Set the confirmation only after the dashboard shows the names `SCHEDULER_ENABLED` and `AUTH_INVALID_BEFORE` with masked values.

```powershell
$env:RAILWAY_MASKED_NAMES_CONFIRMED = "<yes-after-dashboard-confirms-names-with-masked-values>"
if ($env:RAILWAY_MASKED_NAMES_CONFIRMED -ne "yes") { throw "Masked Railway variable-name check is incomplete." }
Assert-ApprovedRailwayTarget
railway redeploy --service "$env:RAILWAY_SERVICE_ID" --yes
if ($LASTEXITCODE -ne 0) { throw "Scheduler-stop redeploy failed." }
Assert-ApprovedRailwayTarget
railway status
if ($LASTEXITCODE -ne 0) { throw "Railway status failed after scheduler stop." }
```

In the dashboard, confirm the current deployment is successful and no new time job is leased before continuing.

### 3. Create and verify the production backup, then apply only reviewed SQL

```powershell
Assert-ApprovedProductionTarget
pg_dump --format=custom --no-owner --no-acl --file "$env:APPROVED_BACKUP_PATH" "$env:PRODUCTION_DATABASE_URL"
if ($LASTEXITCODE -ne 0) { throw "Production backup failed." }
if (-not (Test-Path -LiteralPath $env:APPROVED_BACKUP_PATH) -or (Get-Item -LiteralPath $env:APPROVED_BACKUP_PATH).Length -le 0) { throw "Production backup is empty." }
Assert-ApprovedProductionTarget
pg_restore --list "$env:APPROVED_BACKUP_PATH" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Production backup cannot be listed." }

$schemaHash = (Get-FileHash -Algorithm SHA256 -LiteralPath "database/time-management.sql").Hash.ToLowerInvariant()
$functionsHash = (Get-FileHash -Algorithm SHA256 -LiteralPath "database/time-management-functions.sql").Hash.ToLowerInvariant()
if ($schemaHash -ne $env:TIME_SCHEMA_SHA256 -or $functionsHash -ne $env:TIME_FUNCTIONS_SHA256) { throw "Reviewed SQL checksum mismatch." }

Assert-ApprovedProductionTarget
psql "$env:PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "database/time-management.sql"
if ($LASTEXITCODE -ne 0) { throw "Production schema apply failed; stop and enter rollback decision." }
Assert-ApprovedProductionTarget
psql "$env:PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "database/time-management-functions.sql"
if ($LASTEXITCODE -ne 0) { throw "Production functions apply failed; stop and enter rollback decision." }
```

Save only command names, exit codes, approved IDs, file checksums, and the non-secret fingerprint in evidence. Never save the connection string.

### 4. Deploy the reviewed candidate and run smoke checks

`railway up` is intentionally attached: according to the CLI contract, exit `0` means the deployment reached `SUCCESS`. Do not use detached mode for this gate.

```powershell
Assert-ApprovedRailwayTarget
railway up . --project "$env:RAILWAY_PROJECT_ID" --environment "$env:RAILWAY_ENVIRONMENT_ID" --service "$env:RAILWAY_SERVICE_ID" --message "approved $env:CHANGE_APPROVAL_ID candidate $env:CANDIDATE_SHA"
if ($LASTEXITCODE -ne 0) { throw "Candidate Railway deployment failed." }
Assert-ApprovedRailwayTarget
railway deployment list --service "$env:RAILWAY_SERVICE_ID" --environment "$env:RAILWAY_ENVIRONMENT_ID" --limit 5
if ($LASTEXITCODE -ne 0) { throw "Railway deployment status lookup failed." }
$env:NEW_DEPLOYMENT_ID = "<deployment-id-copied-from-plain-list-or-dashboard>"
Assert-ApprovedRailwayTarget
railway logs "$env:NEW_DEPLOYMENT_ID" --deployment --lines 200 --service "$env:RAILWAY_SERVICE_ID" --environment "$env:RAILWAY_ENVIRONMENT_ID"
if ($LASTEXITCODE -ne 0) { throw "Railway deployment log lookup failed." }
Assert-ApprovedRailwayTarget
railway status
if ($LASTEXITCODE -ne 0) { throw "Railway status failed after candidate deploy." }

Assert-ApprovedRailwayTarget
$healthCode = curl.exe --silent --show-error --output NUL --write-out "%{http_code}" "$env:APP_BASE_URL/health"
if ($LASTEXITCODE -ne 0 -or $healthCode -ne "200") { throw "Production health smoke failed." }
Assert-ApprovedRailwayTarget
$staleSessionCode = curl.exe --silent --show-error --output NUL --write-out "%{http_code}" --cookie "$env:PRE_ROLLOUT_COOKIE_JAR" "$env:APP_BASE_URL/api/auth/me"
if ($LASTEXITCODE -ne 0 -or $staleSessionCode -ne "401") { throw "Forced re-login smoke failed." }
```

Inspect the bounded logs for build/start success and confirm they contain no credentials, authorization headers, Push endpoints/keys, notes, or reflection text. Complete the approved CRM login, read-only time-management, private-API denial, CSRF/CORS, direct-refresh, and asset-base smoke checklist in the change record.

### 5. Re-enable Push/AI scheduling only after smoke approval

```powershell
$env:SCHEDULER_REENABLE_APPROVED = "<yes-after-health-auth-privacy-and-job-queue-smoke>"
if ($env:SCHEDULER_REENABLE_APPROVED -ne "yes") { throw "Scheduler re-enable is not approved." }
Assert-ApprovedRailwayTarget
railway variable set "SCHEDULER_ENABLED=true" --skip-deploys --service "$env:RAILWAY_SERVICE_ID" --environment "$env:RAILWAY_ENVIRONMENT_ID"
if ($LASTEXITCODE -ne 0) { throw "Railway variable update failed." }
```

Confirm only the `SCHEDULER_ENABLED` name in the Railway dashboard with its value masked, then apply the change and repeat health/log checks.

```powershell
$env:RAILWAY_MASKED_NAMES_CONFIRMED = "<yes-after-dashboard-confirms-SCHEDULER_ENABLED-name-with-masked-value>"
if ($env:RAILWAY_MASKED_NAMES_CONFIRMED -ne "yes") { throw "Masked Railway variable-name check is incomplete." }
Assert-ApprovedRailwayTarget
railway redeploy --service "$env:RAILWAY_SERVICE_ID" --yes
if ($LASTEXITCODE -ne 0) { throw "Scheduler re-enable redeploy failed." }
Assert-ApprovedRailwayTarget
railway status
if ($LASTEXITCODE -ne 0) { throw "Railway status failed after scheduler re-enable." }
```

## Exact rollback procedure (new approval required)

Do not improvise reverse SQL. Record whether application-only rollback is sufficient before selecting a database action. The CLI does not select a historical Railway deployment; the command path below checks out and deploys the exact previous application SHA. The Railway dashboard's historical Rollback action is an operator alternative, but it restores both the old image and its custom variables, so `SCHEDULER_ENABLED=false` must be re-applied and confirmed immediately afterward.

### 1. Approve rollback and stop Push/AI scheduling

```powershell
$env:ROLLBACK_APPROVAL_ID = "<approved-rollback-change-id>"
$env:ROLLBACK_CONFIRMED = "<yes-after-separate-rollback-authorization>"
$env:ROLLBACK_WORKTREE = "<absolute-temporary-rollback-worktree>"
$env:DB_ROLLBACK_DECISION = "<no-schema-rollback|logical-restore|provider-pitr>"
$env:WRITES_STOPPED_CONFIRMED = "<yes-after-maintenance-mode-and-write-drain>"

function Assert-ApprovedRollback {
  Assert-ApprovedRailwayTarget
  if ($env:ROLLBACK_CONFIRMED -ne "yes" -or $env:ROLLBACK_APPROVAL_ID -like "<*") { throw "Separate rollback approval is missing." }
}

Assert-ApprovedRollback
Assert-ApprovedRailwayTarget
railway variable set "SCHEDULER_ENABLED=false" --skip-deploys --service "$env:RAILWAY_SERVICE_ID" --environment "$env:RAILWAY_ENVIRONMENT_ID"
if ($LASTEXITCODE -ne 0) { throw "Railway variable update failed." }
```

Confirm only the `SCHEDULER_ENABLED` name in the dashboard with its value masked, set `$env:RAILWAY_MASKED_NAMES_CONFIRMED` to `yes`, then deploy the stop switch.

```powershell
if ($env:RAILWAY_MASKED_NAMES_CONFIRMED -ne "yes") { throw "Masked Railway variable-name check is incomplete." }
Assert-ApprovedRollback
Assert-ApprovedRailwayTarget
railway redeploy --service "$env:RAILWAY_SERVICE_ID" --yes
if ($LASTEXITCODE -ne 0) { throw "Rollback scheduler-stop redeploy failed." }
```

### 2. Deploy the exact previous application SHA

```powershell
Assert-ApprovedRollback
git worktree add --detach "$env:ROLLBACK_WORKTREE" "$env:PREVIOUS_APP_SHA"
if ($LASTEXITCODE -ne 0) { throw "Previous-SHA worktree creation failed." }
$rollbackHead = (git -C "$env:ROLLBACK_WORKTREE" rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $rollbackHead -ne $env:PREVIOUS_APP_SHA) { throw "Rollback worktree SHA mismatch." }
Assert-ApprovedRollback
Assert-ApprovedRailwayTarget
railway up "$env:ROLLBACK_WORKTREE" --path-as-root --project "$env:RAILWAY_PROJECT_ID" --environment "$env:RAILWAY_ENVIRONMENT_ID" --service "$env:RAILWAY_SERVICE_ID" --message "approved rollback $env:ROLLBACK_APPROVAL_ID sha $env:PREVIOUS_APP_SHA"
if ($LASTEXITCODE -ne 0) { throw "Previous-SHA Railway rollback deploy failed." }
```

### 3. Decide database recovery explicitly

- `no-schema-rollback`: use when the reviewed migration remains backward-compatible and data is intact; do not run a restore.
- `logical-restore`: requires stopped writes and restores the verified pre-migration dump. This can discard post-backup writes.
- `provider-pitr`: stop here and use the separately approved Supabase PITR workflow for the approved backup identifier/time. Do not also run `pg_restore`.

```powershell
if ($env:DB_ROLLBACK_DECISION -eq "logical-restore") {
  if ($env:WRITES_STOPPED_CONFIRMED -ne "yes") { throw "Writes must be stopped before logical restore." }
  Assert-ApprovedRollback
  Assert-ApprovedProductionTarget
pg_restore --clean --if-exists --no-owner --no-acl --dbname "$env:PRODUCTION_DATABASE_URL" "$env:APPROVED_BACKUP_PATH"
  if ($LASTEXITCODE -ne 0) { throw "Logical database restore failed; keep writes and scheduler stopped." }
} elseif ($env:DB_ROLLBACK_DECISION -eq "provider-pitr") {
  throw "Pause CLI work and execute only the separately approved provider PITR dashboard procedure."
} elseif ($env:DB_ROLLBACK_DECISION -ne "no-schema-rollback") {
  throw "A valid database rollback decision is required."
}
```

### 4. Post-rollback smoke and controlled scheduler recovery

```powershell
$env:ROLLBACK_DEPLOYMENT_ID = "<rollback-deployment-id-copied-from-dashboard-or-plain-list>"
Assert-ApprovedRollback
Assert-ApprovedRailwayTarget
railway status
if ($LASTEXITCODE -ne 0) { throw "Post-rollback Railway status failed." }
Assert-ApprovedRollback
Assert-ApprovedRailwayTarget
railway logs "$env:ROLLBACK_DEPLOYMENT_ID" --deployment --lines 200 --service "$env:RAILWAY_SERVICE_ID" --environment "$env:RAILWAY_ENVIRONMENT_ID"
if ($LASTEXITCODE -ne 0) { throw "Post-rollback log lookup failed." }
Assert-ApprovedRollback
Assert-ApprovedRailwayTarget
$rollbackHealthCode = curl.exe --silent --show-error --output NUL --write-out "%{http_code}" "$env:APP_BASE_URL/health"
if ($LASTEXITCODE -ne 0 -or $rollbackHealthCode -ne "200") { throw "Post-rollback health smoke failed." }
Assert-ApprovedRollback
Assert-ApprovedRailwayTarget
$rollbackStaleSessionCode = curl.exe --silent --show-error --output NUL --write-out "%{http_code}" --cookie "$env:PRE_ROLLOUT_COOKIE_JAR" "$env:APP_BASE_URL/api/auth/me"
if ($LASTEXITCODE -ne 0 -or $rollbackStaleSessionCode -ne "401") { throw "Post-rollback forced-login smoke failed." }
```

Repeat the approved CSRF/CORS, private denial, CRM regression, data reconciliation, queued-job, direct-refresh, and asset checks. Keep writes and `SCHEDULER_ENABLED=false` until the incident owner separately approves reopening them. Record approvals, target IDs, SHAs, deployment IDs, non-secret fingerprints, backup/PITR identifiers, exit codes, smoke results, and unresolved jobs.
