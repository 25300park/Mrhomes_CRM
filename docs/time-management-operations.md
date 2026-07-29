# Time-management operations runbook

This is a procedure, not evidence that a rollout occurred. Task 12 did not push, deploy, or execute SQL.

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
