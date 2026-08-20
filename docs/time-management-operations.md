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
$env:FORCED_RELOGIN_NOTICE_IMPACT = "<approved-user-impact-summary>"
$env:FORCED_RELOGIN_ROLLBACK_CONTACT = "<approved-rollback-contact>"
$env:SMOKE_BUSINESS_DATE = "<YYYY-MM-DD-approved-business-date>"
$env:PRIVACY_SENTINEL = "<approved-non-secret-reflection-sentinel>"
$env:DISALLOWED_SMOKE_ORIGIN = "https://disallowed-smoke.invalid"

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

### 2. Prove a live pre-cutoff session and acknowledge the forced-login notice

Before opening a captured terminal, load `CRM_CANARY_EMAIL`, `CRM_CANARY_PASSWORD`, and `CRM_CANARY_NEW_PASSWORD` from the approved secret manager into environment variables. Use a dedicated canary account. Never place any of those values in this document, a command argument, output, evidence, or shell history. The new password must be unique to this change and different from the approved original.

The following creates a fresh in-memory session, logs in before the cutoff, and proves `/api/auth/me` returns `200`. Keep `$preCutoffSession` in memory; do not serialize its cookies.

```powershell
foreach ($secretName in @("CRM_CANARY_EMAIL", "CRM_CANARY_PASSWORD", "CRM_CANARY_NEW_PASSWORD")) {
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($secretName))) { throw "Approved canary secret environment is incomplete." }
}
if ($env:CRM_CANARY_PASSWORD -eq $env:CRM_CANARY_NEW_PASSWORD) { throw "Canary current and temporary passwords must differ." }
$cutoff = [DateTimeOffset]::ParseExact($env:AUTH_INVALID_BEFORE, "yyyy-MM-ddTHH:mm:ssZ", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal)
if ($cutoff -le [DateTimeOffset]::UtcNow) { throw "Choose an approved cutoff after the pre-cutoff canary baseline." }

$preCutoffSession = [Microsoft.PowerShell.Commands.WebRequestSession]::new()
$preCutoffLoginBody = @{ email = $env:CRM_CANARY_EMAIL; password = $env:CRM_CANARY_PASSWORD } | ConvertTo-Json -Compress
Assert-ApprovedRailwayTarget
$preCutoffLogin = Invoke-WebRequest -Method Post -Uri "$env:APP_BASE_URL/api/auth/login" -WebSession $preCutoffSession -ContentType "application/json" -Body $preCutoffLoginBody -SkipHttpErrorCheck
if ($preCutoffLogin.StatusCode -ne 200) { throw "Pre-cutoff canary login failed; stop rollout." }
Assert-ApprovedRailwayTarget
$preCutoffMe = Invoke-WebRequest -Method Get -Uri "$env:APP_BASE_URL/api/auth/me" -WebSession $preCutoffSession -SkipHttpErrorCheck
if ($preCutoffMe.StatusCode -ne 200) { throw "Pre-cutoff canary authentication baseline failed; stop rollout." }
$preCutoffAuthenticatedAt = [DateTimeOffset]::UtcNow
if ($preCutoffAuthenticatedAt -ge $cutoff) { throw "Canary baseline did not complete before the cutoff; choose a new approved cutoff." }
if ($preCutoffSession.Cookies.GetCookies([Uri]$env:APP_BASE_URL).Count -eq 0) { throw "Pre-cutoff canary session has no cookie; stop rollout." }
```

Publish this template through the approved operator channel. It contains no credentials:

```powershell
$forcedReloginNotice = @"
Forced re-login notice
Impact: $env:FORCED_RELOGIN_NOTICE_IMPACT
Cutoff UTC: $env:AUTH_INVALID_BEFORE
Rollback contact: $env:FORCED_RELOGIN_ROLLBACK_CONTACT
"@
Write-Host $forcedReloginNotice
$env:FORCED_RELOGIN_NOTICE_ACK = Read-Host "Enter ACK-$env:CHANGE_APPROVAL_ID after the notice is delivered"

function Assert-ForcedReloginNoticeAcknowledged {
  if ($env:FORCED_RELOGIN_NOTICE_IMPACT -like "<*" -or $env:FORCED_RELOGIN_ROLLBACK_CONTACT -like "<*" -or $env:FORCED_RELOGIN_NOTICE_ACK -ne "ACK-$env:CHANGE_APPROVAL_ID") { throw "Forced re-login notice acknowledgment is missing." }
  if ([DateTimeOffset]::UtcNow -lt $cutoff) { throw "Approved forced-login cutoff has not arrived." }
}
```

### 3. Stop Push/AI jobs and apply the forced-login cutoff before migration

`SCHEDULER_ENABLED=false` stops both Push/reminder delivery and AI job leasing. `AUTH_INVALID_BEFORE` invalidates sessions issued before the approved UTC instant. The explicit notice acknowledgment must pass before the cutoff variable is staged or deployed.

```powershell
Assert-ApprovedRailwayTarget
railway variable set "SCHEDULER_ENABLED=false" --skip-deploys --service "$env:RAILWAY_SERVICE_ID" --environment "$env:RAILWAY_ENVIRONMENT_ID"
if ($LASTEXITCODE -ne 0) { throw "Railway variable update failed." }
Assert-ForcedReloginNoticeAcknowledged
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

### 4. Create and verify the production backup, then apply only reviewed SQL

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

### 5. Deploy the reviewed candidate and run smoke checks

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
$candidateHealth = Invoke-WebRequest -Method Get -Uri "$env:APP_BASE_URL/health" -SkipHttpErrorCheck
if ($candidateHealth.StatusCode -ne 200) { throw "Production health smoke failed; stop and roll back." }
Assert-ApprovedRailwayTarget
$postCutoffStaleMe = Invoke-WebRequest -Method Get -Uri "$env:APP_BASE_URL/api/auth/me" -WebSession $preCutoffSession -SkipHttpErrorCheck
if ($postCutoffStaleMe.StatusCode -ne 401) { throw "The proven pre-cutoff session was not invalidated; stop and roll back." }

$postCutoffSession = [Microsoft.PowerShell.Commands.WebRequestSession]::new()
$postCutoffLoginBody = @{ email = $env:CRM_CANARY_EMAIL; password = $env:CRM_CANARY_PASSWORD } | ConvertTo-Json -Compress
Assert-ApprovedRailwayTarget
$postCutoffLogin = Invoke-WebRequest -Method Post -Uri "$env:APP_BASE_URL/api/auth/login" -WebSession $postCutoffSession -ContentType "application/json" -Body $postCutoffLoginBody -SkipHttpErrorCheck
if ($postCutoffLogin.StatusCode -ne 200) { throw "Fresh post-cutoff login failed; stop and roll back." }
Assert-ApprovedRailwayTarget
$postCutoffFreshMe = Invoke-WebRequest -Method Get -Uri "$env:APP_BASE_URL/api/auth/me" -WebSession $postCutoffSession -SkipHttpErrorCheck
if ($postCutoffFreshMe.StatusCode -ne 200) { throw "Fresh post-cutoff authentication failed; stop and roll back." }
```

The `401` check above reuses the exact session object proven live before the cutoff; a new or unrelated cookie cannot satisfy it. The fresh `200` checks distinguish intentional session invalidation from a broken authentication service.

### 6. Run exact CRM, password-recovery, privacy, CSRF, CORS, and asset smoke

Every request below is read-only or uses the dedicated canary. Password mutation must be immediately reversed and verified with the original approved password. Any unexpected status blocks scheduler re-enable and starts the approved rollback procedure. Response bodies and credentials must not be printed.

```powershell
Assert-ApprovedRailwayTarget
$dashboardSmoke = Invoke-WebRequest -Method Get -Uri "$env:APP_BASE_URL/api/dashboard" -WebSession $postCutoffSession -SkipHttpErrorCheck
if ($dashboardSmoke.StatusCode -ne 200) { throw "Authenticated CRM read smoke failed; stop and roll back." }
Assert-ApprovedRailwayTarget
$csrfResponse = Invoke-WebRequest -Method Get -Uri "$env:APP_BASE_URL/api/auth/csrf" -WebSession $postCutoffSession -SkipHttpErrorCheck
$csrfPayload = $csrfResponse.Content | ConvertFrom-Json
if ($csrfResponse.StatusCode -ne 200 -or [string]::IsNullOrWhiteSpace($csrfPayload.csrfToken)) { throw "CSRF token smoke failed; stop and roll back." }
$csrfHeaders = @{ "X-CSRF-Token" = [string]$csrfPayload.csrfToken }

Assert-ApprovedRailwayTarget
$noCsrfMutation = Invoke-WebRequest -Method Post -Uri "$env:APP_BASE_URL/api/auth/logout" -WebSession $postCutoffSession -SkipHttpErrorCheck
if ($noCsrfMutation.StatusCode -ne 403) { throw "CSRF denial smoke failed; stop and roll back." }

$passwordChangeBody = @{ current = $env:CRM_CANARY_PASSWORD; next_pw = $env:CRM_CANARY_NEW_PASSWORD } | ConvertTo-Json -Compress
Assert-ApprovedRailwayTarget
$passwordChange = Invoke-WebRequest -Method Post -Uri "$env:APP_BASE_URL/api/auth/change-password" -WebSession $postCutoffSession -Headers $csrfHeaders -ContentType "application/json" -Body $passwordChangeBody -SkipHttpErrorCheck
if ($passwordChange.StatusCode -ne 200) { throw "Canary password change failed; stop and roll back." }
$passwordRestoreBody = @{ current = $env:CRM_CANARY_NEW_PASSWORD; next_pw = $env:CRM_CANARY_PASSWORD } | ConvertTo-Json -Compress
Assert-ApprovedRailwayTarget
$passwordRestore = Invoke-WebRequest -Method Post -Uri "$env:APP_BASE_URL/api/auth/change-password" -WebSession $postCutoffSession -Headers $csrfHeaders -ContentType "application/json" -Body $passwordRestoreBody -SkipHttpErrorCheck
if ($passwordRestore.StatusCode -ne 200) { throw "CRITICAL: canary password restore failed; stop, keep scheduling disabled, and roll back." }

$originalPasswordSession = [Microsoft.PowerShell.Commands.WebRequestSession]::new()
$originalPasswordLoginBody = @{ email = $env:CRM_CANARY_EMAIL; password = $env:CRM_CANARY_PASSWORD } | ConvertTo-Json -Compress
Assert-ApprovedRailwayTarget
$originalPasswordLogin = Invoke-WebRequest -Method Post -Uri "$env:APP_BASE_URL/api/auth/login" -WebSession $originalPasswordSession -ContentType "application/json" -Body $originalPasswordLoginBody -SkipHttpErrorCheck
if ($originalPasswordLogin.StatusCode -ne 200) { throw "Original canary password was not restored; stop and roll back." }
Assert-ApprovedRailwayTarget
$originalPasswordMe = Invoke-WebRequest -Method Get -Uri "$env:APP_BASE_URL/api/auth/me" -WebSession $originalPasswordSession -SkipHttpErrorCheck
if ($originalPasswordMe.StatusCode -ne 200) { throw "Restored canary authentication failed; stop and roll back." }

if ($env:PRIVACY_SENTINEL -like "<*" -or $env:SMOKE_BUSINESS_DATE -like "<*") { throw "Approved privacy smoke inputs are missing." }
Assert-ApprovedRailwayTarget
$anonymousAdmin = Invoke-WebRequest -Method Get -Uri "$env:APP_BASE_URL/api/time-management/analytics/admin/members/$env:SMOKE_BUSINESS_DATE" -SkipHttpErrorCheck
if ($anonymousAdmin.StatusCode -ne 401 -or $anonymousAdmin.Content -match [regex]::Escape($env:PRIVACY_SENTINEL)) { throw "Anonymous private-data denial smoke failed; stop and roll back." }
Assert-ApprovedRailwayTarget
$disallowedCors = Invoke-WebRequest -Method Get -Uri "$env:APP_BASE_URL/health" -Headers @{ Origin = $env:DISALLOWED_SMOKE_ORIGIN } -SkipHttpErrorCheck
if ($disallowedCors.StatusCode -ne 403 -or $disallowedCors.Headers.ContainsKey("Access-Control-Allow-Origin")) { throw "CORS denial smoke failed; stop and roll back." }

Assert-ApprovedRailwayTarget
$rootDirect = Invoke-WebRequest -Method Get -Uri "$env:APP_BASE_URL/" -SkipHttpErrorCheck
if ($rootDirect.StatusCode -ne 200) { throw "CRM root direct-route smoke failed; stop and roll back." }
Assert-ApprovedRailwayTarget
$timeRoot = Invoke-WebRequest -Method Get -Uri "$env:APP_BASE_URL/time-management" -SkipHttpErrorCheck
if ($timeRoot.StatusCode -ne 200) { throw "Time-management root direct-route smoke failed; stop and roll back." }
Assert-ApprovedRailwayTarget
$timeDirect = Invoke-WebRequest -Method Get -Uri "$env:APP_BASE_URL/time-management/records" -SkipHttpErrorCheck
if ($timeDirect.StatusCode -ne 200) { throw "Time-management nested direct-route smoke failed; stop and roll back." }
$assetPaths = [regex]::Matches($timeRoot.Content, '/time-management/assets/[^"]+') | ForEach-Object { $_.Value } | Sort-Object -Unique
if ($assetPaths.Count -eq 0) { throw "Built time-management assets were not referenced; stop and roll back." }
foreach ($assetPath in $assetPaths) {
  Assert-ApprovedRailwayTarget
  $assetResponse = Invoke-WebRequest -Method Get -Uri "$env:APP_BASE_URL$assetPath" -SkipHttpErrorCheck
  if ($assetResponse.StatusCode -ne 200) { throw "Referenced time-management asset smoke failed; stop and roll back." }
}

Assert-ApprovedRailwayTarget
$originalSessionCsrfResponse = Invoke-WebRequest -Method Get -Uri "$env:APP_BASE_URL/api/auth/csrf" -WebSession $originalPasswordSession -SkipHttpErrorCheck
$originalSessionCsrf = ($originalSessionCsrfResponse.Content | ConvertFrom-Json).csrfToken
if ($originalSessionCsrfResponse.StatusCode -ne 200 -or [string]::IsNullOrWhiteSpace($originalSessionCsrf)) { throw "Canary cleanup CSRF lookup failed; stop and roll back." }
Assert-ApprovedRailwayTarget
$originalLogout = Invoke-WebRequest -Method Post -Uri "$env:APP_BASE_URL/api/auth/logout" -WebSession $originalPasswordSession -Headers @{ "X-CSRF-Token" = $originalSessionCsrf } -SkipHttpErrorCheck
if ($originalLogout.StatusCode -ne 200) { throw "Restored canary cleanup failed; stop and roll back." }
Assert-ApprovedRailwayTarget
$postCutoffLogout = Invoke-WebRequest -Method Post -Uri "$env:APP_BASE_URL/api/auth/logout" -WebSession $postCutoffSession -Headers $csrfHeaders -SkipHttpErrorCheck
if ($postCutoffLogout.StatusCode -ne 200) { throw "Canary session cleanup failed; stop and roll back." }
```

Inspect the candidate's bounded logs for build/start success and confirm they contain no credentials, authorization headers, Push endpoints/keys, notes, or reflection text. Record only statuses, approved non-secret identifiers, and asset paths.

### 7. Re-enable Push/AI scheduling only after smoke approval

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
railway deployment list --service "$env:RAILWAY_SERVICE_ID" --environment "$env:RAILWAY_ENVIRONMENT_ID" --limit 5
if ($LASTEXITCODE -ne 0) { throw "Scheduler deployment status lookup failed." }
$env:SCHEDULER_DEPLOYMENT_ID = "<scheduler-reenable-deployment-id-from-plain-list-or-dashboard>"
Assert-ApprovedRailwayTarget
$schedulerLogs = railway logs "$env:SCHEDULER_DEPLOYMENT_ID" --deployment --lines 200 --service "$env:RAILWAY_SERVICE_ID" --environment "$env:RAILWAY_ENVIRONMENT_ID"
if ($LASTEXITCODE -ne 0) { throw "Scheduler startup log lookup failed; disable scheduling and roll back." }
$schedulerLogText = $schedulerLogs -join "`n"
$serverStartupSignal = "RBS Homes CRM: http://0.0.0.0:"
$schedulerStartupSignal = "팔로업 스케줄러 시작"
$schedulerFailurePattern = "\[Scheduler\] failed to start:|\[Scheduler\] time job processing failed:|Required environment variables are missing:|UnhandledPromiseRejection|uncaught exception|npm ERR!"
if ($schedulerLogText -notmatch [regex]::Escape($serverStartupSignal) -or $schedulerLogText -notmatch [regex]::Escape($schedulerStartupSignal) -or $schedulerLogText -match $schedulerFailurePattern) { throw "Scheduler startup evidence failed; disable scheduling and roll back." }
Assert-ApprovedRailwayTarget
$schedulerHealth = Invoke-WebRequest -Method Get -Uri "$env:APP_BASE_URL/health" -SkipHttpErrorCheck
if ($schedulerHealth.StatusCode -ne 200) { throw "Scheduler re-enable health smoke failed; disable scheduling and roll back." }
```

These checks only prove process/scheduler startup and health. Do not invoke a test Push, AI review, email, reminder, or any other external send as part of this smoke gate.

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
$rollbackHealth = Invoke-WebRequest -Method Get -Uri "$env:APP_BASE_URL/health" -SkipHttpErrorCheck
if ($rollbackHealth.StatusCode -ne 200) { throw "Post-rollback health smoke failed." }
$rollbackSession = [Microsoft.PowerShell.Commands.WebRequestSession]::new()
$rollbackLoginBody = @{ email = $env:CRM_CANARY_EMAIL; password = $env:CRM_CANARY_PASSWORD } | ConvertTo-Json -Compress
Assert-ApprovedRollback
Assert-ApprovedRailwayTarget
$rollbackLogin = Invoke-WebRequest -Method Post -Uri "$env:APP_BASE_URL/api/auth/login" -WebSession $rollbackSession -ContentType "application/json" -Body $rollbackLoginBody -SkipHttpErrorCheck
if ($rollbackLogin.StatusCode -ne 200) { throw "Post-rollback canary login failed." }
Assert-ApprovedRollback
Assert-ApprovedRailwayTarget
$rollbackMe = Invoke-WebRequest -Method Get -Uri "$env:APP_BASE_URL/api/auth/me" -WebSession $rollbackSession -SkipHttpErrorCheck
if ($rollbackMe.StatusCode -ne 200) { throw "Post-rollback canary authentication failed." }
```

Repeat the approved CSRF/CORS, private denial, CRM regression, data reconciliation, queued-job, direct-refresh, and asset checks. Keep writes and `SCHEDULER_ENABLED=false` until the incident owner separately approves reopening them. Record approvals, target IDs, SHAs, deployment IDs, non-secret fingerprints, backup/PITR identifiers, exit codes, smoke results, and unresolved jobs.
