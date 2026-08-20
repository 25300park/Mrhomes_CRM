# Time-management release evidence

Status: the local release-candidate gate is complete on the marked isolated external test database. Staging/production backup, migration, smoke testing, Railway deployment, and GitHub push remain pending separate authorization. No production SQL, staging SQL, deploy, external send, or `git push` was performed.

## Candidate identity

- Required base SHA: `63b0acb6ef14f77c0b5d585d5cf558c98be36f43`
- Branch: `feature/time-management`
- Task 12 release-candidate commit: `ca43c039c1a3e07e6abdf7bb69173c0c32a5d6da`
- Release-gate security and DB-test fix commit: `22dc9b1`
- DB-test and full-audit fix commit: `8da60c2dd24b9fefe6dd6867951d7ddfc0154522`
- Real release-boundary fix commit: `583b2d79055c419f105f15fc72111138faa2b928`
- Guarded rollout runbook commit: `f71a951`
- Final production-smoke gate commit: `3b65ad1c81681f56c37c73b46b3cdaa26bbf8b61`
- Verification date/time zone: 2026-07-29, Asia/Seoul
- Verification runtime: Node `v24.18.0`, PostgreSQL client `18.4`, Chromium `151.0.7922.34`

## Automated evidence

The following commands were run from exact tested candidate `3b65ad1c81681f56c37c73b46b3cdaa26bbf8b61`. Every listed command exited zero.

| Command | Result |
|---|---|
| `npm ci` | PASS: installed 234 packages; audited 235; 0 vulnerabilities |
| `npm --prefix time-management-ui ci` | PASS: installed 218 packages; audited 219; 0 vulnerabilities |
| `npm run test:unit` | PASS: 12 files, 79 tests |
| `npm run test:integration` | PASS on the marked isolated external database: 11 files, 90 tests, 95.76 seconds |
| `npm run test:regression` | PASS: 5 files, 19 tests |
| `npm --prefix time-management-ui test -- --run --coverage` | PASS: 14 files, 58 tests; statements 87.4%, branches 80.9%, functions 86.89%, lines 91.87% |
| `npm run build` | PASS: Railway/Nixpacks root build performed clean UI install and built 102 modules |
| `npm run build:time` | PASS: 102 modules; generated base-path assets `index-BPiOSMp7.js` and `index-C9r66V34.css` |
| `npx playwright test` | PASS: 17/17 Chromium tests in 26.5 seconds through the real local Express boundary with stateful Supabase/RPC/storage fixtures and one worker |
| `npm audit` | PASS: complete root dependency tree, 0 vulnerabilities |
| `npm audit --omit=dev` | PASS: root production dependency tree, 0 vulnerabilities |
| `npm --prefix time-management-ui audit --omit=dev` | PASS: UI production dependency tree, 0 vulnerabilities |

The release-gate rerun also confirmed that the two high-connection database tests no longer depend on repeated remote TLS connections or enlarged test timeouts. Their SQL behavior and rollback assertions remain exercised against the marked external database.

## Manual gates owned by the release operator

- Backup/restore rehearsal and explicitly authorized staging migration.
- Staging CRM/time-management smoke test and operational log review.
- Production authorization, SQL migration, Railway deploy, forced re-login notice, health checks, and rollback decision.
- Explicit authorization before any `git push`.

## Git and rollout boundary

`git remote -v` reported `origin https://github.com/25300park/Mrhomes_CRM.git` for fetch and push. The final candidate remained on `feature/time-management`. No GitHub push, Railway command, external message/send, staging or production database connection, migration, backup, or deploy was run while collecting this evidence.
