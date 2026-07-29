# Task 12 Release Boundary Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace browser-fulfilled release tests with deterministic tests of the real Express boundary, close accessibility/privacy/build gaps, and record auditable RED/GREEN release evidence.

**Architecture:** A local-only outer Express server exposes fixture controls and mounts the real `createApp`. A stateful Supabase/RPC/storage fake drives application behavior without external I/O; Playwright routing only blocks non-local origins. Production logging remains unchanged unless an explicit sink is injected.

**Tech Stack:** Node.js 22.22+, Express 4, Supabase-compatible in-memory fake, Vitest, Playwright Chromium, React/Vite, axe-core, Nixpacks/Railway.

## Global Constraints

- Never execute staging/production SQL, Railway deploys, git push, external sends, or unmarked database connections.
- Never print credentials, cookies, authorization headers, reflection text, notes, Push endpoints/keys, or provider secrets.
- Preserve existing CRM behavior and Task 7-11 tests.
- Keep all E2E controls outside production `createApp` routes.
- Use the marked test database only for the final actual-database integration gate.

---

### Task 1: Real Express E2E fixture boundary

**Files:**
- Create: `e2e/support/supabase.cjs`
- Modify: `e2e/support/server.cjs`
- Modify: `e2e/support/routes.ts`
- Test: `e2e/time-daily-loop.spec.ts`

**Interfaces:**
- Produces: `createE2eSupabaseFixture()` with `supabase`, `reset()`, `control(input)`, and `snapshot()`.
- Produces: local-only `POST /__e2e/reset`, `POST /__e2e/control`, and `GET /__e2e/state` before the mounted `createApp`.
- Produces: `installSafeRoutes(page)` that resets server state and aborts only non-`http://127.0.0.1:4177` requests.

- [ ] Add a failing daily-loop assertion that server state recorded real auth, table, and RPC calls while same-origin APIs were never fulfilled by Playwright.
- [ ] Run `npx playwright test e2e/time-daily-loop.spec.ts --project=chromium` and record the missing state/control failure.
- [ ] Implement the query builder, fixture tables, time RPCs, storage adapter, outer control router, and external-origin-only browser route.
- [ ] Re-run the daily-loop test and confirm the real cookie/CSRF/routes/services/RPC path passes.

### Task 2: Idempotency, timeout, and database-error network boundaries

**Files:**
- Modify: `e2e/support/supabase.cjs`
- Modify: `e2e/support/routes.ts`
- Modify: `e2e/time-network.spec.ts`

**Interfaces:**
- Consumes: `FixtureState.failNext`, `delayNext`, `setServerTimer`, and `snapshot` backed by local control HTTP.
- Produces: replay state keyed by user/request/command and one-shot delay/error injection at named RPC operations.

- [ ] Replace the browser duplicate map and instant 504 assertion with tests that inspect real `time_get_command_replay`/timer RPC calls, delay `time_start_timer` beyond 10 seconds, and inject a Supabase RPC error.
- [ ] Run the focused network spec and record RED because the current fixture does not expose server controls or real RPC behavior.
- [ ] Implement replay, delayed RPC resolution, error objects with stable codes, and authoritative timer reconciliation in the fake.
- [ ] Re-run the network spec and confirm duplicate replay, AbortController UI failure, database error mapping, offline state, and reconnect pass.

### Task 3: Legacy CRM and PMS route-family coverage

**Files:**
- Modify: `e2e/support/supabase.cjs`
- Modify: `e2e/crm-regression.spec.ts`

**Interfaces:**
- Consumes: real authenticated Express CRM routes and fixture table/storage calls.
- Produces: safe read/write evidence for Contacts, Listings, Leads, Deals, Staff, Accounting, Dashboard, listing reports/documents, PMS Payments/Care/Accounts/Documents, Notifications, and Upload.

- [ ] Add rendered-data and direct HTTP assertions for every planned family, including at least one safe mutation in each applicable local-data family and uppercase CRM link types.
- [ ] Run the CRM spec and record RED for unsupported table/storage calls and missing PMS Accounts/Documents coverage.
- [ ] Extend only the fake rows/query operations needed by those safe routes; do not call publish, email, AI, PMS sync, or document-send endpoints.
- [ ] Re-run the CRM spec and confirm real route responses plus sanitized fixture call evidence.

### Task 4: WCAG A/AA color contrast

**Files:**
- Modify: `e2e/accessibility.spec.ts`
- Modify: `public/index.html`
- Modify: `time-management-ui/src/shared/app-shell.css`
- Modify: `time-management-ui/src/features/today/today-page.css`
- Modify: `time-management-ui/src/features/records/records-page.css`
- Modify: `time-management-ui/src/features/reflection/reflection-panel.css`
- Modify: `time-management-ui/src/features/review/personal-review-page.css`
- Modify: `time-management-ui/src/features/settings/push-settings-page.css`
- Modify: `time-management-ui/src/features/admin/admin-summary-page.css`

**Interfaces:**
- Produces: full selected `wcag2a`/`wcag2aa` axe analysis with no disabled color-contrast rule.

- [ ] Remove the axe color-contrast exemption.
- [ ] Run the accessibility spec and record every failing rule/target.
- [ ] Change only colors on the reported targets, preserving layout and interaction.
- [ ] Rebuild the UI and rerun accessibility until CRM login and all five time routes have zero serious/critical violations.

### Task 5: Real application privacy and log capture

**Files:**
- Modify: `app.js`
- Modify: `e2e/support/server.cjs`
- Modify: `e2e/support/supabase.cjs`
- Modify: `e2e/time-privacy.spec.ts`
- Test: `tests/regression/health.test.js`

**Interfaces:**
- Produces: optional `createApp({ logger, httpLogStream })`; omitted values retain current `console.error` and morgan output.
- Produces: sanitized E2E application log and outbound-adapter snapshots.

- [ ] Add a failing regression test for injected HTTP/error logging and a failing Playwright privacy test that sends a sentinel through real reflection/job/admin routes.
- [ ] Run both focused tests and record RED because logs and real private flows are not observable.
- [ ] Inject logging defaults, capture E2E logs, and implement reflection/job/admin fake behavior without logging bodies.
- [ ] Verify sentinel absence from application stdout/stderr capture, admin responses, outbound adapter calls, and real Push payloads.

### Task 6: Railway build contract, runbook, minor fixes, and report

**Files:**
- Create: `nixpacks.toml`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tests/regression/build-time.test.js`
- Modify: `README.md`
- Modify: `docs/time-management-operations.md`
- Modify: `.superpowers/sdd/2026-07-16-mrhomes-crm-time-management-integration/task-12-report.md`

**Interfaces:**
- Produces: root `npm run build` that performs `npm --prefix time-management-ui ci` then `npm run build:time`.
- Produces: Nixpacks install/build/start phases and exact guarded operator commands.

- [ ] Add failing regression assertions for the root build script, Nixpacks phases, Node 22.22+ README text, and exact runbook command blocks.
- [ ] Run the focused regression test and record RED.
- [ ] Implement the build/config/docs changes and mark machine-readable logs/checksums deferred unless a secret-safe ignored artifact contract is explicit.
- [ ] Append a fix-round section to the Task 12 report with finding validity, code evidence, boundaries, and exact RED/GREEN outputs.
- [ ] Run focused tests, `npm ci`, UI clean install/tests/coverage/build, unit/integration/regression suites, Playwright, full audits, `git diff --check`, and self-review.
- [ ] Commit implementation and report locally; do not push.
