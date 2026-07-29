# Time-management release evidence

Status: local release-candidate verification is complete with the external database and registry-audit gates still outstanding. No Git push, Railway deploy, production SQL, staging SQL, or production/external send was performed by Task 12.

## Candidate identity

- Required base SHA: `63b0acb6ef14f77c0b5d585d5cf558c98be36f43`
- Branch: `feature/time-management`
- Pre-commit HEAD recorded before the release-candidate commit: `63b0acb6ef14f77c0b5d585d5cf558c98be36f43`
- Candidate commit: created after this evidence is reviewed; the ignored `task-12-report.md` records its resulting SHA
- Verification date/time zone: 2026-07-29, Asia/Seoul

## Automated evidence

The final command table is recorded only after each command is run. A non-zero command is never represented as passing.

| Command | Result |
|---|---|
| `npm ci` | PASS: installed 236 packages from root lock; deprecation warnings for Multer 1.x and uuid <=10 |
| `npm --prefix time-management-ui ci` | PASS after final lock update: installed 219 packages; install-script approval warnings for esbuild/msw |
| `npm run test:unit` | PASS: 12 files, 79 tests |
| `npm run test:integration` | BLOCKED/FAIL (exit 1): 69 passed, 21 guarded DB tests skipped; dedicated DB marker or Supabase service roles missing, so DDL was refused |
| `npm run test:regression` | PASS: 5 files, 10 tests |
| `npm --prefix time-management-ui test -- --run --coverage` | PASS after exact Vitest/coverage-v8 4.1.10 install: 14 files, 58 tests; statements 87.4%, branches 80.9%, functions 86.89%, lines 91.87%; no configured threshold failure |
| `npm run build:time` | PASS: 57 modules; generated base-path assets `index-BBsZKavF.js` and `index-C9r66V34.css` |
| `npx playwright test` | PASS final rerun: 15/15 Chromium tests in 14.1 seconds with deterministic local fixtures and one worker |
| `npm audit --omit=dev` | BLOCKED (exit 1): sandboxed registry audit endpoint returned an error; escalation was rejected because it would expose dependency inventory without explicit user authorization |
| `npm --prefix time-management-ui audit --omit=dev` | BLOCKED (exit 1): same registry/network restriction; no vulnerability result was returned |

## Manual gates owned by release operator

- Marked isolated database schema/integration gate.
- Backup/restore rehearsal, staging migration, and staging smoke test.
- Production authorization, SQL migration, Railway deploy, forced re-login notice, health checks, and rollback decision.
- Explicit authorization before any `git push`.

## Git and rollout boundary

`git remote -v` reported `origin https://github.com/25300park/Mrhomes_CRM.git` for fetch and push. No `git push`, Railway command, external message/send, staging or production database connection, migration, backup, or deploy was run. The worktree remained on `feature/time-management` while this evidence was collected.
