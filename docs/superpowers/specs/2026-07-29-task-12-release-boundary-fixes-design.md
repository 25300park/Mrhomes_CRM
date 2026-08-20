# Task 12 Release Boundary Fixes Design

## Goal

Make the Task 12 release gate exercise the real local Express application boundary while retaining deterministic, non-production fixtures and blocking every external browser request.

## Scope and boundaries

- The E2E server listens only on `127.0.0.1` and wraps the production `createApp` instance.
- E2E-only reset, delay, failure, timer, state, and log controls live on the outer fixture server. They are never registered by `createApp` or reachable in production.
- Browser routing may abort requests whose origin differs from the local fixture origin. It must not fulfill or alter same-origin application API responses.
- The injected Supabase fixture is stateful and implements the table, RPC, and storage behavior needed by the planned safe flows. It never opens a Supabase, AI, email, Push, Railway, or other external connection.
- Production/staging SQL, deploys, pushes, and external sends remain prohibited.

## Application and fixture architecture

`createApp` continues to mount the real CORS, body parsing, cookie, request ID, CSRF, authentication, legacy CRM, time-management, static asset, and error middleware. It gains optional logging dependencies whose defaults preserve the existing console and morgan behavior. The E2E wrapper injects an in-memory log sink and the stateful Supabase fixture, then mounts that app after the local-only control router.

The fake records every table, RPC, storage, and outbound-adapter call without credentials or request bodies that contain private text. Query builders apply the minimum filtering, ordering, selection, mutation, and single-row semantics required by the exercised routes. Time RPCs preserve request-ID replay, active timer state, entry revisions, plans, reflections, review jobs, and safe error mapping. Control requests can reset state, delay the next named operation beyond the UI timeout, inject one Supabase/RPC error, set the authoritative timer, and read sanitized calls/logs.

## E2E behavior

- Daily-loop tests use real cookie login, CSRF, time routes, services, and RPCs.
- Network tests prove duplicate request-ID replay through `time_get_command_replay`, an AbortController timeout against a delayed real entry route, injected RPC error mapping, offline timer persistence, and reconnect reconciliation.
- CRM regression tests exercise safe authenticated read/write operations for Contacts, Listings, Leads, Deals, Staff, Accounting, Dashboard, Documents, every planned PMS family including Accounts and Documents, Notifications, and Upload. External-send endpoints such as publish, email, AI, or document delivery are not invoked.
- Accessibility tests run the selected WCAG A/AA axe rules without a color-contrast exemption on CRM login and every time-management route. CSS changes are limited to verified violations.
- Privacy tests send sentinel reflection data through real reflection/job routes, then assert it is absent from sanitized application logs, real admin responses, recorded outbound adapter calls, and Push delivery payloads.

## Release build and operations

The root `build` command performs a clean UI install followed by the time-management build. Nixpacks/Railway configuration calls the root build before `npm start`. The runbook uses exact placeholder commands for target fingerprint/marker verification, PostgreSQL backup and migration, Railway variable/deploy gates, exit-code checks, and HTTP smoke tests. README states the repository's Node `>=22.22.0` floor.

## Test and evidence strategy

Each review finding receives an observable failing test before implementation and a focused passing rerun afterward. The Task 12 report records validity, boundary decisions, RED/GREEN commands, exact results, and any deferred minor. Completion requires focused tests, the marked real-database integration suite, full release suite, production audits, diff/self-review, and at least one local commit without push.
