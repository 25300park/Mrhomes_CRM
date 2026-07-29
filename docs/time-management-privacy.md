# Time-management privacy contract

Time entries, CRM links, plan allocations, reflection text, AI review content, Push subscription secrets, session cookies, CSRF tokens, and service credentials are private.

- Members may read and change only their own time-management records through the authenticated API.
- Admin summaries contain identity plus aggregate completion/variance/core-work metrics. They never contain reflection text, entry notes, raw activity, CRM private fields, AI prompts/results, or Push keys.
- Reflection text may enter the authenticated reflection API and the configured AI job payload only. It must not enter admin responses, Push payloads, URLs, console/application logs, analytics events, or browser persistence.
- Push messages use a generic reminder body and `/time-management#reflection`; private job fields are discarded before delivery. Subscription secrets remain encrypted at rest and never return from APIs.
- Browser authentication uses the `HttpOnly`, `SameSite=Lax`, root-path session cookie. Cookie-authenticated mutations require CSRF. Only explicitly configured CORS origins receive credentialed access.
- The CRM login must not save or repopulate passwords. Legacy `crm_saved_*` and `crm_remember*` storage keys are deleted on load.
- E2E fixtures are local/in-memory, block external requests, use fake AI completion, and never send email, Push, AI, Supabase, Railway, or production traffic.

When investigating incidents, log request IDs, stable error codes, counts, and timing only. Redact bodies, authorization/cookie headers, reflection/notes text, CRM labels, Push endpoints/keys, VAPID private values, and provider credentials.
