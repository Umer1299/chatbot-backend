# PR #145 final hardening and release gate

This PR secures the existing business boundary. The future dashboard is custom-coded Next.js/React/TypeScript; Bubble remains a private legacy bridge/export integration only. No custom login, agency hierarchy, channels or dashboard were implemented. No production credentials, data, migrations or deployments were touched.

## Ingestion outcomes and data preservation

`upsertSupplementalChunks()` now throws a `KnowledgeIngestionError` for database failure or a null/throwing/malformed embedding response. `error.result` carries confirmed `inserted`, `skipped`, `failed` counts and `status: failed|partial`. A partial error is an error, not a successful upload; confirmed earlier chunk commits remain present, with their migration-007 revisions. Empty valid inputs return `empty`; current stored duplicates return `skipped`; successful writes return `completed`.

The manual upload endpoint preserves successful response fields and adds `ingestionStatus`. Operational failures return non-2xx with `success: false`, a generic error, stable code and optional ingestion counts. Internal database/provider messages are not returned. Confirmed counts cannot resolve an ambiguous network failure at COMMIT/INSERT; recovery must recheck stored content rather than assume no write occurred.

Current business/source content is checked in SQL on each supplemental attempt, so sequential retries skip confirmed chunks. Redis dedup markers are no longer authoritative for skipping uploads: stale markers after deletion cannot prevent re-upload. Markers are written only after successful ingestion, and marker write failure does not undo committed knowledge. Strict exactly-once behavior for concurrent identical requests is not claimed; a future ingestion-idempotency constraint/job ledger is separate work.

Website re-scraping no longer deletes all existing business knowledge before queueing. Replacement prepares every embedding first, then locks the business row and replaces only the requested source in one PostgreSQL transaction. Insert failure rolls back both chunks and revision changes. Empty replacement input is a no-op, preserving working website data. Owner uploads and other businesses are unaffected by website replacement. A later analysis/configuration step can still fail after a valid knowledge replacement; the full scrape pipeline is not one database transaction.

File processing verifies business ownership before parsing or any duplicate/empty completion. Failed/partial ingestion rejects the BullMQ processor and writes `status: queued` while retries remain and terminal `status: failed` only on the final attempt, retaining namespace/business metadata and optional ingestion details. Retryable failures retain source bytes; final configured failures clean up the temporary file. Successful/empty/duplicate jobs keep the JSON status format and safe completion semantics. Polling additionally verifies stored business ID when present. Queued status is written before BullMQ submission so a fast worker terminal state is never overwritten. Queue acceptance (`success: true, queued: true`) is distinct from ingestion completion; polling remains authoritative. Each BullMQ job uses the application job ID. A failure before enqueue is attempted removes the unaccepted source file. An ambiguous enqueue acknowledgement returns HTTP 503 with `success: false`, `acceptanceUnknown: true` and pollable `jobIds`; it preserves source bytes and the queued/worker status because Redis may already have accepted the job. Clients must poll these IDs before submitting replacements. Unaccepted ambiguous jobs and orphaned files require operational reconciliation/retention; automatic deletion without proof of nonacceptance is unsafe.

## CORS and domain policy

Origin values are parsed as HTTP(S) origins, rejecting userinfo, paths, query/fragment delimiters, backslashes, opaque/null origins and malformed values. Hostnames are normalized by URL parsing; wildcard comparisons require a dot boundary. `attackerexample.com` and `sub.example.com.attacker.test` cannot match `*.example.com`.

- `WIDGET_ALLOWED_ORIGINS` continues to govern public chat, moderation and public bot previews. Existing empty configuration permits valid HTTP(S) origins for these public endpoints only, with credentials disabled. This preserves public token-based widgets without introducing credentialed access.
- Explicit origins compare normalized scheme, host and port. Wildcard rules may be `*.example.com`, `https://*.example.com` or include a configured port. Bare wildcards permit HTTP/HTTPS with default ports; a scheme-qualified rule enforces that scheme. Wildcards exclude the apex: configure `https://example.com` separately if needed.
- `DASHBOARD_ALLOWED_ORIGINS` is the exact trusted origin list for credentialed management/auth/admin access. Wildcards never grant dashboard credentials. For legacy compatibility only, when the new variable is absent, valid exact origins in the old widget list are used; an explicitly empty dashboard list trusts none. Replace legacy trust with the coded dashboard's exact origins during cutover. No production environment values were changed.
- Browser widget requests should use their public token and omit ambient credentials. Server-to-server requests without Origin remain supported and still require their applicable authentication. Business domain policy is always loaded durably; missing policy fails closed. A malformed supplied Origin never falls back to Referer/Host or an empty allowlist.

CORS/Origin is supplementary browser protection, never identity proof. Non-browser callers can choose Origin headers; authorization and tenant checks remain mandatory.

## Global SQL side effects removed

Importing chat wrappers no longer changes `pool.query`. Recent scoped history and session memory are loaded explicitly; free-plan email policy is applied to chat configuration without changing shared database results. Inquiry-only lead suppression is checked explicitly by business/session at the lead-saving call, not by intercepting every matching SQL string globally. JSON/SSE pricing/response wrappers remain request-local and retain their behavior.

The existing short-lived inquiry classification is still process-local and is not a durable cross-worker workflow state. Moving it into a database-backed classification model belongs in a later workflow/data-model PR, without restoring global SQL interception.

## Executed validation and outstanding release gate

Local and clean-install suites passed 91 tests; the dedicated PostgreSQL suite was explicitly skipped locally because no local server was available. CI runs the complete suite against disposable PostgreSQL 16 + pgvector. Final exact CI totals and review status are recorded on PR #145. JavaScript syntax checks, whitespace checks, fresh `npm ci --ignore-scripts --no-audit --no-fund` and clean-install `npm ls --depth=0` are run; no lint script is configured.

The real database suite now also checks atomic replacement rollback, preserved revisions/data, confirmed partial supplemental commits and sequential retry deduplication. Other tests cover public JSON/SSE, lead saving/classification, inquiry access, cross-business authorization, quota isolation, domain-policy persistence, file/scrape ingestion failure and CORS.

Production deployment is still blocked pending:

1. Backups/restore rehearsal, schema drift and runtime-role checks; apply pending 005 → 006 → 007 in isolated staging with bounded lock/statement timeouts. Preserve historical rows and import/recover all intended bot restrictions. See `security-migration-readiness.md`.
2. Staging verification of lock duration, concurrent ingestion, revision triggers, Redis permissions/store prefixes, trusted proxy/client-IP handling and the actual Node runtime. Existing CI uses Node 24; deployment configuration must be reviewed rather than assumed identical.
3. Exact trusted dashboard-origin configuration and private legacy bridge caller cutover. Never move the admin key into a coded frontend or loosen origins/authentication to bypass an error.
4. End-to-end file handoff between the actual web/worker services. The existing implementation queues a local temporary file path; separate containers need shared/durable storage. This pre-existing deployment constraint is not solved by in-process worker tests. Ensure crash cleanup and retention policies for orphaned temporary files.
5. Drain old cache readers and workers before relying on deletion/ingestion guarantees. Keep durable domain tombstones and revision triggers during any safe application rollback. Do not revert to the original authentication or cache code.

Separate hardening remains for scrape SSRF, database TLS certificate verification, upload parsers/resource limits, vulnerable/committed dependency cleanup and historical transcripts/prompts that contain previously captured information. This PR does not claim complete production security certification.

## PR #146: Custom User Authentication and Agency Identity Foundation

Implement independent `users`, verified external identities, revocable/rotating sessions, `agencies` and agency memberships with a permission matrix and negative authorization tests. Add a safe, verified legacy-business ownership mapping; do not fabricate Bubble IDs or link by unverified email. Introduce an explicit user-subject token/session version rather than reinterpreting legacy business-subject JWTs. Use an established authentication mechanism with secure cookies/BFF and CSRF protection where applicable.

Keep #146 focused on identity and authorization foundations. Workspace UI, multiple agents per client and channel/integration features should follow after those boundaries are tested. See `custom-dashboard-auth-transition.md` for the transition inventory and detailed model.
