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

For production, replace the target only inside a separately authorized production window, require `TARGET_ENV=production`, take and verify a new production backup, and retain `SCHEDULER_ENABLED=false` until all smoke checks pass.

## Railway smoke and rollback commands

After an authorized deployment, record the candidate SHA and run:

```bash
railway status
railway variables --kv
railway logs --deployment
curl --fail --show-error --silent "$APP_BASE_URL/health"
```

Do not print secret values in captured evidence. If rollback is required, first set `SCHEDULER_ENABLED=false` through the Railway variable control, redeploy that configuration, then roll back to the recorded previous deployment in Railway and repeat the health/auth/privacy smoke checks.

## Preconditions

- Use a separately authorized staging or production change window.
- Confirm `SUPABASE_URL` identifies the intended environment. Never infer the target from a shell prompt.
- Capture the release commit SHA and a timestamped backup location.
- Keep `SCHEDULER_ENABLED=false` during migration and smoke testing. This is the emergency stop for both AI and Push/reminder job delivery.

## Backup and staging

1. Back up the target with the provider's point-in-time recovery/snapshot feature and a logical `pg_dump --format=custom --no-owner --no-acl --file <approved-backup-path> <approved-staging-or-production-url>`.
2. Verify the dump exits zero, is non-empty, and can be listed with `pg_restore --list <approved-backup-path>`.
3. Apply `database/time-management.sql` and `database/time-management-functions.sql` to the marked staging database only. Save the command, exit code, target marker, and migration output.
4. Run the marked database integration suite and the full release suite from the exact candidate SHA.
5. Smoke test CRM login/logout/password change plus `/time-management`, `/records`, `/review`, `/settings`, and admin authorization. Confirm direct refresh and built assets.

## Production rollout (separate authorization required)

1. Announce the change window and forced re-login. Set `AUTH_INVALID_BEFORE` to the approved canonical UTC rollout instant.
2. Set `SCHEDULER_ENABLED=false`, redeploy that configuration, and confirm no time jobs are leased.
3. Capture and verify the production backup as above.
4. Apply the two reviewed time-management SQL files to the explicitly marked production target. Never paste ad-hoc SQL from chat or documentation.
5. Deploy the reviewed commit through Railway. Confirm the build includes `npm run build:time` before `npm start`.
6. Check `/health`, CRM authentication, a read-only member flow, private API denial, asset base paths, and logs for secrets/private reflection text.
7. Re-enable `SCHEDULER_ENABLED=true` only after health and privacy checks pass. This re-enables both AI and Push/reminder processing.

## Rollback

1. Immediately set `SCHEDULER_ENABLED=false` to stop AI and Push/reminder job delivery.
2. Roll Railway back to the previously recorded application SHA.
3. If schema rollback is required, stop writes and restore the verified backup/PITR snapshot according to the Supabase incident procedure. Do not improvise reverse SQL.
4. Re-run health, authentication, CSRF/CORS, private denial, CRM regression, and data reconciliation checks before reopening writes or scheduling.
5. Record timestamps, operators, SHAs, backup identifiers, health results, and unresolved queued jobs in the incident record.
