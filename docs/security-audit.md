# Authentication and tenant-boundary audit

**Scope note:** This document records the security baseline through 4bc42d9. The same working branch now also contains the separately requested Phase 2 user/agency/business foundation. See [the current Phase 2 contract and 008/009 rollout](phase2-identity-foundation.md); statements below about features not implemented refer to the earlier security phase.

**Dashboard decision:** the future dashboard is custom-coded Next.js/React/TypeScript; Bubble is legacy only. See [authentication transition](custom-dashboard-auth-transition.md) and [migration readiness](security-migration-readiness.md).

Scope: `feature/codex-update` at `e78715d8387e642b6b75fd02e7369847a996e156`.
This change secures the existing **business** tenant boundary. It does not introduce agency membership, client management, multiple agents, WhatsApp, voice, OAuth, n8n, or a new billing system.

## Findings and fixes

| Severity | Finding | Resolution |
| --- | --- | --- |
| Critical | Anyone could submit a known Bubble user ID to `/api/auth/token` and receive that business's JWT. | Require existing `x-admin-key` on a trusted server-to-server bridge before any lookup/provisioning. Browser-supplied identity alone is never accepted. |
| High | Issued JWTs had no expiration and verification accepted unspecified algorithms/issuer/audience and arbitrary claim shapes. | HS256 only, fixed issuer/audience, matching subject and UUID business ID, required `iat`/`exp`, maximum age one hour. Reload current business identity, active state, plan and bot ID from PostgreSQL. Reject old nonexpiring tokens. |
| Critical | Chat selected and mutated sessions by caller-controlled session ID; concurrent inserts ignored conflicts without checking ownership. | Authenticate token and bot scope before inquiry processing. Atomically insert-if-absent, then select by both session ID and business ID. Reject collisions, including historical sessions without an owner. Scope all chat history/memory reads and session writes, including emergency and phase paths. Check cached config's business against the authorized session. |
| High | Inquiry wrapper performed reads/writes before the inner router authenticated. | Outer authentication, domain checks and session ownership guard run before configuration, inquiry extraction, notification hooks or model calls. |
| Critical | A public widget token could read all inquiries, transcripts and analytics for a business. | Inquiry reads require dashboard JWT. A widget header cannot override dashboard identity. Scope inquiry transcript query by business. |
| High | Public widget tokens could upload/poison knowledge; namespace delete accepted a different tenant's namespace and used an undefined Pinecone initializer. | All upsert routes require owner JWT; resolve namespace from the current business and reject mismatched URL namespaces. Delete that business's pgvector chunks, matching the active storage implementation. |
| High | Any authenticated user could read another tenant's scrape status, including generated prompts. | Add business ID predicate to scrape job status lookup. |
| High | Lead detail's related messages/notifications lacked business predicates. | Scope related records and lead-to-session joins by business; preserve existing owner-scoped list/update APIs. |
| High | Legacy lead webhook was unauthenticated and had no tenant-aware routing. | Restrict `/api/lead/capture` to trusted backend/admin key. Public chat's existing tenant-aware lead flow remains. |
| High | `/api/billing/select-plan` directly granted paid entitlements with a dashboard JWT. | Require both owner JWT and server admin key until a payment-confirmed flow exists. |
| High | Domain settings expired in Redis after 30 days while widget tokens lived for a year; missing settings silently allowed every origin. | Persist settings in PostgreSQL via migration 006. Verify the durable revision before using a five-minute revision-keyed cache; fall back to PostgreSQL on Redis errors, and fail closed on missing policy or database failure. Domain/Origin checks remain supplementary, not identity verification. |
| Medium | Owner knowledge routes still used the public widget quota. Knowledge deletion swallowed PostgreSQL failures as zero deletions. | Mount `/api/upsert` under the dashboard limiter; rethrow database deletion errors so failed deletion never returns `{ success: true }`. |
| Medium | File jobs overwrote JSON status with a Redis hash, or omitted namespace on duplicate/failure status. Polling could fail or deny the owner. | Keep JSON with namespace in all states. Queue current business ID and reject conflicting business resolution before writes. Retain compatibility with already queued namespace-only jobs. |

## Final cache and quota hardening

- RAG cache keys now use `rag:v2:<business UUID>:<durable knowledge revision>:<full-query/limit SHA-256>`. Migration 007's statement-level PostgreSQL triggers invalidate generations atomically with every normal knowledge mutation, including uploads, replacement, deletion and partial writes. Redis failure cannot revive stale data, and RAG no longer scans keys. Actual chat tests verify deleted knowledge is absent from subsequent JSON and streaming model prompts.
- Auth endpoints keep 120 requests/minute with an IPv6-safe IP key, independent of Authorization/forwarded-IP headers. Management keeps 120/minute keyed by verified current business identity, shared across its tokens/IPs and isolated from other businesses. Widgets keep 60/minute per verified bot/IP. Redis store prefixes separate quota families. The existing optional session limiter retains 30/minute and its IP handling is corrected.
- Public previews keep a separate IP-based 120/minute quota. Previously unmetered server-admin routes now receive a 120/minute/IP quota after admin verification to bound expensive operations; no global admin key is exposed to callers. These additions and the move from per-token/IP to per-business management accounting are intentional security changes, not numeric limit changes.
- JWT middleware memoizes verification only inside the current request using a private symbol; quota and route authorization share that verified identity. Invalid/expired JWTs still fail before authenticated quota lookup. No user, session or membership architecture is built here.

## Required caller changes before rollout

- For existing legacy bridge callers, `/api/auth/token` keeps its POST body and response fields. It is now **server-to-server only**. Configure Bubble's private/backend API workflow to derive `bubbleUserId` from its authenticated current user, then add the existing private `x-admin-key`. Do not accept an arbitrary client-supplied ID in that workflow. Never embed this key in Bubble page JavaScript, a public workflow parameter, or a widget.
- New admin `/api/chatbots/:namespace` settings require an explicit `allowedDomains` array. Use `[]` only when unrestricted origins are intentional. Omitting the field on an existing settings update preserves the saved policy. GET/POST/list response shapes and existing widget tokens remain unchanged.
- Reissue dashboard tokens through that bridge on login/expiry. Previously issued JWTs are intentionally rejected. There is no insecure legacy-token compatibility switch.
- Send `Authorization: Bearer <dashboard JWT>` to `/api/upsert`, its job/delete routes, and all inquiry routes. A public `x-chatbot-token` is insufficient for these operations.
- Plan activation requires owner JWT plus private `x-admin-key`, invoked only after your backend verifies payment/admin approval. Legacy `/api/lead/capture` requires private `x-admin-key` and remains a global integration, not a public multi-tenant endpoint.
- Public website chat retains its URL, body, widget header and JSON/SSE response shapes. Use high-entropy random visitor session IDs. The existing public session ID remains a bearer capability **within a business**; visitor identity and signed session capabilities are future work.
- No production credentials were read or modified. If an admin key has previously been exposed in frontend code, treat it as compromised and rotate it through your operational process before enabling the bridge.

## Schema inconsistencies

| Existing inconsistency | Treatment |
| --- | --- |
| `messages.session_id` and `business_id` had independent foreign keys and nullable ownership, permitting cross-business relationships. `sessions.business_id` was nullable. | Add migration `005_security_boundaries.sql`: composite session/business reference and non-null checks, all `NOT VALID`, plus supporting indexes. New inserts/updates are checked; historical rows are retained without automatic cleanup. |
| Lead PATCH allows `assigned_to`, but no migration defined it. | Add nullable `leads.assigned_to TEXT` in 005. |
| Preview reads `bot_configs.is_disabled/disabled_reason`, but migrations define these on `businesses`. | Read the business columns. |
| `bubble_user_id` is unique, `businesses` has one `bot_id`, and `bot_configs.business_id` is unique. | Existing one-business/one-bot model retained. These constraints do not support the proposed agency/client/multiple-agent hierarchy; redesign separately with membership/role rules. |
| `leads.session_id`/`inquiries.session_id` have no tenant-coupled foreign keys; `sessions.lead_id` can reference a foreign business. | Reads are explicitly tenant-scoped. Included read-only preflight counts inconsistent historical relationships. Constraints/repair for these relationships require a separate reviewed migration. |
| `src/db/migrate.js` reruns every SQL file with no migration ledger, two files share prefix 003, and global pipeline seeds use a nullable unique key. | Flagged, not rewritten here. Replaying 001 can duplicate global pipeline stages because NULLs do not conflict; automatic cleanup would be outside this non-destructive task. |
| The existing package lock omitted declared runtime dependencies and pinned incompatible Anthropic SDK/UUID versions, causing clean `npm ci` to fail. | Regenerated the lockfile to match the existing manifest, without changing dependency ranges. |
| RAG retrieval and invalidation used different identifiers; Redis failure could retain stale knowledge. | Add migration 007 with a business knowledge revision and transactional statement-level chunk triggers. Retrieval uses only current business/revision keys, never the old namespace cache. |
| Bot domain settings had no durable schema. | Add migration 006 with `chatbot_settings` (namespace, JSON settings, random revision, deletion tombstone, timestamp). No automatic runtime DDL. |
| Runtime setup also adds/repairs quick-answer, inquiry and branding columns, so deployed schemas can differ from migrations. | Compare staging schema to migrations; do not assume runtime setup proves a clean migration. |

### Domain caching guarantees

PostgreSQL is authoritative, including on cache hits: each settings read checks its current revision and tombstone. Cached payloads live for five minutes under a revision-specific key, and writes use a new random revision even when recreating a deleted namespace. This avoids invalidation races and revision reuse. Redis cache failure falls back to PostgreSQL; PostgreSQL failure does not authorize from an old Redis value. A request already reading the old revision when an update occurs may finish under that revision; subsequent reads check the updated revision. Public token lookup still depends on Redis and fails closed if token validation is unavailable.

### Database rollout

1. Back up the database and run `docs/security-schema-preflight.sql` on a staging copy. No production SQL was executed for this work.
2. Apply **only the pending new migrations**, 005 then 006 then 007, to an already migrated staging database. For example, use `psql "$STAGING_DATABASE_URL" -v ON_ERROR_STOP=1 -f src/db/migrations/005_security_boundaries.sql` and then the same command with `006_durable_chatbot_settings.sql` and `007_knowledge_cache_revision.sql`. Skip migrations already applied. Avoid replaying the existing runner merely to install these changes. No production migrations were executed for this PR.
3. `NOT VALID` retains old bad rows but rejects new inconsistent writes and updates to bad rows. Review/quarantine such records manually; no records are deleted or reassigned by this PR.
4. After resolving preflight findings, validate `messages_session_business_fk`, `messages_tenant_required` and `sessions_tenant_required` using explicit `ALTER TABLE ... VALIDATE CONSTRAINT ...` commands in a separate operational change.
5. Before routing widget traffic to the new code, apply 006 and import or re-save domain policies. Surviving `chatbot:<namespace>` Redis settings are promoted to PostgreSQL on first settings read, widget request, or admin listing, using insert-if-absent so concurrent admin updates win. Existing deleted-policy tombstones prevent resurrection. If legacy settings have already expired, recover/re-enter the intended domains through the authenticated admin POST; the API intentionally returns 503 for widgets until policy is restored. Never infer unrestricted access from an absent policy.
6. Test the Bubble bridge, owner dashboard, uploads, public JSON/SSE chat, file worker and database constraints in staging, then deploy through the usual release process. Index creation and `ALTER TABLE` can lock tables; schedule accordingly. Do not roll back to the insecure auth flow.

## Validation and limits

`npm test` uses Node's built-in test runner with experimental module mocks; use Node 24 for tests (the existing production Render configuration remains unchanged). HTTP tests run real Express routers, JWT verification, chat wrappers/history optimization and ownership middleware against in-memory PostgreSQL/Redis/service doubles. Worker tests replace queue and I/O dependencies. Tests use dummy secrets, never load `.env`, and never contact live services.

Coverage includes unauthorized JWT issuance, token expiry/claim/algorithm failures, inactive/deleted accounts, cross-tenant lead/inquiry read and update denial, positive owner access, public-widget management denial, knowledge namespace checks, scrape/file job isolation, entitlement/webhook protection, chat side-effect ordering, session collision and concurrent first requests, positive chat, input validation and cache failures. A separate fresh directory passed `npm ci --ignore-scripts --no-audit --no-fund` and the original 26 tests with the corrected lockfile. The earlier follow-up suite had 44 passing tests, adding the real app limiter mount, actual knowledge helper/endpoint database failures, domain cache expiry with a still-valid token, durable reads/writes, revision races, cache outages/corruption, missing policy rejection, legacy promotion, and deletion tombstones. CI runs the same suite without production secrets.

A mock suite does not prove real PostgreSQL locking, FK behavior, Redis durability or external integrations. No PostgreSQL server was available locally. The final suite adds an isolated PostgreSQL/pgvector CI service and migration/retrieval integration checks; production-like locks, permissions and concurrent workload behavior remain staging checks. Source syntax checks and `git diff --check` are also run.

This is not a full production security certification. Separate reviews remain for scrape URL/SSRF policy, upload parsing limits and malware handling, dependency vulnerabilities (including committed `node_modules`), PostgreSQL TLS certificate verification, credential/rate-limit lifecycle, payment webhooks, and durable cross-worker workflow classification. Global pool query monkey patches have now been removed in favor of explicit scoped service calls. No new channel features were implemented.

Earlier verification: 58 local tests passed (one database suite explicitly skipped); CI passed 64/64 tests with no skips against disposable PostgreSQL 16 + pgvector. Final hardening extends ingestion, CORS and SQL-isolation coverage; see `pr145-final-hardening.md` and PR #145 for the latest executed totals. A fresh locked dependency installation passed `npm ls --depth=0`. Production-like staging checks remain. The CI link is recorded in PR #145. See `security-migration-readiness.md` for pending migrations 005–007 and operational prerequisites.

Final hardening: [ingestion outcomes, CORS policy, SQL side effects, exact release gates and PR #146 scope](pr145-final-hardening.md). Staging and production validation have not been claimed.
