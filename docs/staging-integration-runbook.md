# Chatflow AI — Phase 6A staging integration preflight and execution runbook

**Prepared:** 2026-10-23. **Disposition:** BLOCKED — ACTION REQUIRED; this document grants no deployment permission.
**Read-only baselines inspected:** dashboard Phase 5D `2731da62a232cc2f2cdff7162fecef374dded7a0`; backend PR #145 `63a69f44cec1ed10d2e4d54fdd62c019d03ed6ea`.
**Scope:** isolated, disposable two-agent website demonstration; text knowledge only. No production access, PR merge, deployment, paid provider call, migration, credential publication, or website-agent flag change is authorized.

## 1. Evidence and boundaries

- Dashboard PR #1 (5A, base main), #2 (5B, base 5A), #3 (5C, base 5B), #4 (5D, base 5C) are open, draft, unmerged. Phase 5D HEAD matches the pinned commit. Backend #145 targets `feature/codex-update`, is open and unmerged at the pinned commit.
- Dashboard workflow [#45](https://github.com/Umer1299/chatflow-dashboard/actions/runs/39895464285) on the pinned HEAD passed typecheck, lint, 115 Vitest tests/26 files, production build, audit (zero reported vulnerabilities), and a 12-test Playwright job. Backend [#94](https://github.com/Umer1299/chatbot-backend/actions/runs/39377250405) on the pinned HEAD passed 207 Node tests, zero failed/skipped, with disposable PostgreSQL 16/pgvector and Redis configured in CI. **These are CI executions, not executions in Phase 6A or deployed staging.**
- Backend CI installation emitted 35 npm dependency vulnerabilities (1 low, 18 moderate, 14 high, 2 critical). Require an actionable, package-level advisory/exploitability review before staging approval. Do not claim that a green functional test run resolves this.
- PR #4 had 6 resolved review threads and PR #145 had 36 resolved threads when checked. A resolved review thread is not evidence of live service isolation.
- Code sources: dashboard `src/lib/api/proxy-policy.ts`, `src/lib/api/proxy-security.ts`, `src/app/api/backend/[...segments]/route.ts`, `src/components/{auth,agencies,businesses,agents}/`, `src/lib/server/{workspace,agents}.ts`; backend `src/{app.js,auth/accountAuth.js,middleware/accountAuth.js,api/{agenciesV1,agentsV1,agentRuntimeV1,agentChat}.js,services/{agencyAccess,agentKnowledge,websiteDeployment}.js}`.
- Freeze deployment/change windows. Do not merge/rebase the five existing PRs or edit the Phase 5D branch. Do not apply `render.staging.yaml`, `render.yaml`, provision services, enable `AGENT_WEBSITE_ENABLED`, run paid canaries, or execute SQL against shared or production data without explicit, subsequent owner approval.

## 2. Contract compatibility matrix (code inspection, not deployed E2E)

All dashboard browser management calls go through `/api/backend/...` (the BFF rewrites to `/api/...`); management auth is a recognized host-only Better Auth session cookie, plus exact dashboard Origin and JSON for mutations. **VERIFIED (static)** means the requested path and payload correspond to inspected source files or backend routes, not a live test. **MISMATCH** flags a specific routing/configuration inconsistency. **BLOCKED** means the relevant deployed E2E behavior has not been executed. Never interpret these labels as a deployed staging pass. `O/A` = agency owner/admin or explicitly granted business editor; `B-view` = authorized business viewer for non-sensitive metadata only; `Auth` = verified active Better Auth account.

| Frontend operation | Backend HTTP endpoint | Required permission | Configuration prerequisite | Result | Evidence |
|---|---|---|---|---|---|
| Signup / signin | POST `/api/account/sign-up/email`, POST `/api/account/sign-in/email` | unauthenticated initial requests; verified email for signin | `ACCOUNT_AUTH_ENABLED`, auth secret/URL/origins, DB, Resend, HTTPS/cookies | VERIFIED (static); MISMATCH (if auth base points to dashboard); BLOCKED (E2E) | dashboard `auth-form.tsx`; backend `accountAuth.js`, `accountAuth.js` middleware |
| Verify session / signout | GET `/api/account/get-session`, POST `/api/account/sign-out` | Auth, current nonrevoked cookie | as above | VERIFIED (static); BLOCKED (E2E) | dashboard `workspace.ts`, `proxy-security.ts`; backend `accountAuth.js` middleware |
| Agency creation | POST `/api/account/organization/create` `{name,slug}` | Auth; organization owner created by Better Auth | auth, DB, email verification | VERIFIED (static); BLOCKED (E2E) | dashboard `create-agency.tsx`; backend `accountAuth.js` |
| Business creation | POST `/api/v1/agencies/:agencyId/businesses` `{business_name,industry,owner_email}` | owner/admin | Auth, migration 009 | VERIFIED (static); BLOCKED (E2E) | dashboard `create-business.tsx`; backend `agenciesV1.js` |
| Agent creation/list | POST/GET `/api/v1/businesses/:businessId/agents` | O/A for POST; B-view for list | migration 010, Auth | VERIFIED (static); BLOCKED (E2E) | dashboard `create-agent.tsx`; backend `agentsV1.js` |
| Agent details/lifecycle | GET/PATCH `/api/v1/businesses/:businessId/agents/:agentId` | B-view GET; O/A PATCH | active config/model entitlement before activation | VERIFIED (static); BLOCKED (E2E) | dashboard `agent-status.tsx`; backend `agentsV1.js` |
| Agent configuration | GET/PUT `/api/v1/businesses/:businessId/agents/:agentId/config`; PUT full body with `expected_version` | O/A | model catalog/entitlement, migration 010 | VERIFIED (static); BLOCKED (E2E) | dashboard `agent-configuration.tsx`; backend `agentsV1.js` |
| Text knowledge | POST/GET/DELETE `/api/v1/businesses/:businessId/agents/:agentId/knowledge[/:knowledgeId]`; POST `{source_key,text}` | O/A | migrations 010/011, PostgreSQL vector, OpenAI embedding access | VERIFIED (static); BLOCKED (E2E) | dashboard `agent-knowledge.tsx`; backend `agentRuntimeV1.js`, `agentKnowledge.js` |
| Website deployment issue/list | POST/GET `/api/v1/businesses/:businessId/agents/:agentId/deployments`; POST `{allowed_origins}` | O/A | migration 011, approved controlled HTTPS origin(s) | VERIFIED (static); BLOCKED (E2E) | dashboard `agent-deployments.tsx`; backend `agentRuntimeV1.js` |
| Deployment activation/pause | PATCH `/api/v1/businesses/:businessId/agents/:agentId/deployments/:deploymentId` `{status,allowed_origins?}` | O/A | active agent/config/entitled catalog model | VERIFIED (static); BLOCKED (E2E) | same files |
| Credential rotation/revocation | POST `.../deployments/:deploymentId/rotate`, POST `.../revoke`; body `{}` | O/A | migration 011; protected one-time token handling | VERIFIED (static); BLOCKED (E2E) | same files; backend `websiteDeployment.js` |
| Public JSON chat/session creation | POST `/api/agent-chat` JSON `{sessionId,message}` with `x-agent-token`, `Origin` | valid *public deployment token*, not dashboard cookie | `AGENT_WEBSITE_ENABLED=true` **only after approval**, active deployment, origin, model, DB, Redis, provider | VERIFIED (backend code); BLOCKED (no dashboard widget; deployed E2E) | backend `agentChat.js`; dashboard `agent-deployments.tsx` guidance |
| Public buffered SSE | POST `/api/agent-chat?stream=true` with same headers/body | same public credential | same | Backend contract code-aligned; no dashboard streaming widget; live blocked | backend `agentChat.js` |
| Lead/inquiry/conversation review | GET `/api/v1/businesses/:businessId/agents/:agentId/{leads,inquiries,conversations,conversations/:sessionId}` | O/A | Auth, migration 011; actual chat record | VERIFIED (backend/allowlist); BLOCKED (no complete UI; E2E) | BFF `proxy-policy.ts`; backend `agentRuntimeV1.js` |

The listed dashboard **management** method/path/payload pairs appear code-aligned; this does not establish a live HTTPS/DB integration. **Authentication email-link routing is a configuration-dependent mismatch if `ACCOUNT_AUTH_URL` is set to the dashboard origin:** Better Auth uses `baseURL + basePath` for emailed links (normally `/api/account/verify-email`), but the Next.js dashboard only mounts its BFF at `/api/backend/account/...` and has no `/api/account/...` route/rewrite. As checked, `next.config.ts` defines no rewrite, while the backend directly mounts `/api/account/*`. The preferred staging configuration is to set `ACCOUNT_AUTH_URL` to the **public HTTPS backend API origin**, and to include both the dashboard and API origins in `ACCOUNT_TRUSTED_ORIGINS` with the dashboard FIRST (invitations use the first trusted origin). Validate the actual generated verification/reset URLs and cross-origin return callback in a controlled HTTPS email test; if backend HTTPS cannot serve those routes, separately review a same-origin routing solution before approval. Do not change code or relax Origin/CSRF in preflight. The signup `callbackURL` must point back to the dashboard's `/sign-in`. A standalone embeddable website widget is NOT implemented/verified; the documented pilot uses direct API clients. OAuth/Google Calendar login or callback support is not enabled by this Better Auth configuration; do not fabricate OAuth routes.

Common management errors: unauthenticated 401, wrong role 403, foreign resource 404, invalid JSON/payload 400 or 415, stale config version or activation prerequisites 409, unavailable auth/provider/feature 503/502 as appropriate. Responses are contract-dependent; record observed status and safely redacted response during staging.

## 3. Infrastructure and configuration manifest

**Database:** isolated PostgreSQL **16**, `pgvector` enabled, database `chatflow_staging`, separate reviewed migration/runtime privilege model, TLS reviewed, backup and *tested restore* into independent disposable database. Migration files `001_initial_schema.sql`, `002_plan_limits.sql`, both lexicographically ordered `003_*.sql`, `004_inquiries.sql`, `005_security_boundaries.sql`, `006_durable_chatbot_settings.sql`, `007_knowledge_cache_revision.sql`, `008_account_auth.sql`, `009_agency_business_access.sql`, `010_agent_foundation.sql`, `011_agent_runtime.sql`, `012_agent_chat_turn_claims.sql`, `013_legacy_knowledge_mutation_claims.sql`. Verify `chatflow_schema_migrations` 008–013; agent config versions, per-agent knowledge revision/triggers, tenant-coupled deployments/sessions/leads and composite FKs. Never use unguarded `node src/db/migrate.js` on an initialized database. Guarded `npm run staging:migrate` accepts only the exact empty isolated DB or a verified complete no-op state and may partially execute SQL if interrupted; preserve evidence and inspect/rebuild only disposable data after any failure.

**Redis/Valkey:** Redis 7 or compatible Valkey 8 with `noeviction`, internal networking, authenticated access, persistence/alerts, memory limit and queue retention tested. BullMQ connection/retry behavior tested under controlled failure. Current legacy file upload API puts bytes in `os.tmpdir()` and puts the local path on a queue: the separate Render worker cannot be assumed to read it. **Block file uploads and scrape/file handoff E2E claims until durable shared handoff is designed and independently approved. Text-only agent knowledge does not use this file-worker path.**

**API/worker:** Node >=22.18 (blueprint pins 24.21.0), separate `npm start` and `npm run worker`, protected env injection, bounded startup and queue shutdown/retries. `GET /healthz` expected 200 `OK` for liveness, `GET /readyz` expected 503 during initialization/dependency outage and 200 `{"status":"ready"}` after DB/vector/Redis readiness; test actual ingress. Do not treat `/healthz` alone as readiness.

**Frontend:** Node >=22.18, `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run test:e2e`; host Next.js SSR as a **separate HTTPS web service** (not declared in the backend Render Blueprint). Server-only `CHATFLOW_BACKEND_URL=https://<staging-api-origin>` and `CHATFLOW_DASHBOARD_ORIGIN=https://<staging-dashboard-origin>` must be exact bare origins (no credentials, path, query); do not use `NEXT_PUBLIC_*`. BFF fixed allowlist accepts JSON mutations only, requires exact browser Origin for unsafe requests, sends only recognized Better Auth cookie names, filters Set-Cookie and prevents untrusted upstream redirect. Confirm real browser cookie scope, generated email verification/reset URL routing, safe callback redirects, invitation URLs and ingress forwarded IP behavior. Do not turn off CSRF/Origin rules to make tests pass.

**API secrets/configuration by service (names only; do not print values):**
- API DB/Redis: `NODE_VERSION`, `NODE_ENV=production`, `CHATFLOW_ENVIRONMENT=isolated-staging`, `DATABASE_URL`, `STAGING_DATABASE_URL`, `REDIS_URL`, `STAGING_REDIS_URL`, `PORT` (host-assigned as applicable).
- API identity/network: `ACCOUNT_AUTH_ENABLED` (blueprint defaults false; requires approval to set true), `ACCOUNT_AUTH_URL` (public HTTPS backend **API** origin for directly served emailed Better Auth links; confirm the actual link target and callback), `ACCOUNT_AUTH_SECRET`, `ACCOUNT_TRUSTED_ORIGINS` (dashboard origin **first** for agency-invitation links, plus the public API auth base origin), `DASHBOARD_ALLOWED_ORIGINS`, `WIDGET_ALLOWED_ORIGINS`, `ACCOUNT_PROXY_MODE=trusted`, `TRUSTED_PROXY_CIDRS`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `RESEND_FROM_NAME`, `JWT_SECRET` for legacy initialization.
- API release safety: `AGENT_WEBSITE_ENABLED=false` until separately approved, `STAGING_BASE_URL`, `STAGING_READINESS_CONFIRM=I_CONFIRM_NON_PRODUCTION_STAGING`, and migration-only `STAGING_MIGRATION_CONFIRM=I_CONFIRM_EMPTY_STAGING_DATABASE` when appropriate.
- API providers: `OPENAI_API_KEY` required for text knowledge embeddings; `ANTHROPIC_API_KEY` only if using Anthropic completion; optional bounded canary config `LIVE_PROVIDER*` and `LIVE_PROVIDER_TEST_APPROVED` require separate approval.
- Worker: `NODE_VERSION`, `NODE_ENV`, `CHATFLOW_ENVIRONMENT`, `DATABASE_URL`, `REDIS_URL`, `WORKER_CONCURRENCY`, provider key for permitted file jobs. Worker deployment does not cure local temporary-file handoff.
- Dashboard: `CHATFLOW_BACKEND_URL`, `CHATFLOW_DASHBOARD_ORIGIN`, `NODE_ENV=production`; do not put secrets in public environment.
- No OAuth provider/callback is configured for Phase 6A. Verify Better Auth verification/reset and agency invitation HTTPS links. Google Calendar OAuth, voice/WhatsApp, external CRMs, widget SDK and billing activation are out of scope.

**Config discrepancy:** `render.staging.yaml` intentionally leaves BOTH auth and website chat disabled. `scripts/staging-readiness.js` requires account auth enabled for its complete PASS state while *also* requiring the website flag disabled; these are separate gates and must be sequenced. The local disposable test `.env.staging.example` points to `chatflow_security_test`; the managed migration runner instead insists on `chatflow_staging`. Never aim one command at the other's database. Existing production `render.yaml` pins unsupported Node 20 and Redis eviction `allkeys-lru` and must not be applied to this pilot.

## 4. Security preflight and gaps

Code inspection finds Better Auth verified-active session checks, DB-backed sessions with cookie caching disabled, seven-day expiry and revocation, HttpOnly/Secure/SameSite=Lax production cookie settings, Origin and CSRF protections, rate-limit middleware, a separate legacy JWT trust boundary, agency owner/admin vs grant-based business viewer/editor checks, organization-row locking for certain mutations, tenant-scoped SQL predicates/foreign keys, agent knowledge revisions/retrieval scoping, hashed one-time website credentials and rotate/revoke, exact deployment Origin validation, post-model database rechecks of deployment/config/version and request-scoped chat admission. Existing CI exercises many DB/auth and two-agent scenarios using deterministic provider mocks.

**Do not claim verified live:** platform-wide admin permission workflow (distinct from legacy admin-key API) is not demonstrated by this pilot; actual HTTPS cookie delivery, Resend verification, ingress IP/proxy/rate limiting, secure secret stores/log redaction, PostgreSQL runtime-role least privilege, authorized domain ownership, per-tenant cache clearing under actual Redis topology, independent credential rotation across replicas, live model account authorization, model-instruction resistance, Redis outage/recovery, and backup/restore require isolated staging checks. Origin headers are not identity protection against non-browser clients.

**Outstanding risks:** backend npm vulnerability list (including critical advisories) must be triaged; `src/db/pool.js` sets `rejectUnauthorized:false` for production PG TLS; file worker local-file handoff; staging frontend not in blueprint; and missing HTTP idempotency key means lost responses may be retried as duplicate chat turns. No architecture change approved in this phase. Document and sign off mitigations before staging permission.

## 5. Pre-deployment safety gates (no side effects)

1. Freeze and record all five PR heads and verify CI is still green and no new security review thread is unresolved. Owner review needed for any deviation.
2. Review high/critical dependency advisories; classify reachable/runtime vs transitive/development with evidence and an approved risk decision. Do not upgrade dependencies casually during preflight.
3. Review Render pricing and confirm an **isolated** workspace/DB/Redis, hostname, network rules, TLS chain, independent service identities and domain ownership; explicit owner approval needed before billing.
4. Prepare nonproduction DNS/HTTPS, email sender, secrets, test identities and OpenAI embeddings key without sharing values. Explicit owner approval to fund/send test emails/provider calls.
5. Separately rehearse destructive recovery procedure against an approved disposable backup; validate DDL role and lock budget.
6. Perform the already-defined no-credential and CI checks first. `npm run staging:check` is read-only but must never receive shared/production URLs. Its database/Redis read-only checks are gated by positive staging identity.
7. Confirm required `AGENT_WEBSITE_ENABLED=false`; do not toggle as part of this preflight.

## 6. Staging execution order — **FUTURE, OWNER-APPROVED ONLY**

**Approval A — resource provisioning and migration:** (1) reserve isolated Render workspace, agree on estimated charges, (2) provision PostgreSQL 16/pgvector and Redis/Valkey `noeviction` with verified backup/restore, (3) provision separate API and worker according to blueprint **without enabling public chat**, (4) configure all protected server variables, exact HTTPS trusted origins, email and trusted proxy details, (5) on a **confirmed empty** `chatflow_staging` DB, after backup and approval, run `npm run staging:migrate` using its dedicated confirmation; never run against an existing shared DB, (6) verify migration ledger, extension, tables, triggers, constraints, sequences, access roles and no unwanted data changes, (7) start API and worker separately, verify `/healthz`, `/readyz`, Redis INFO `noeviction`, worker queue connectivity, worker shutdown/retry behavior; disable file-upload tests until handoff resolved, (8) start the separately configured Next.js HTTPS web service and verify production build and connectivity.

**Approval B — authentication and test data:** (9) approve enabling `ACCOUNT_AUTH_ENABLED=true` for isolated staging, run `npm run staging:check` with the feature gate still OFF, (10) sign up a test user from the dashboard, verify via real test email, sign in and check the Secure HttpOnly session, expiry, logout, revoked session and CSRF/Origin behavior using actual HTTPS requests, (11) create agency and business with test-only owner details, verify viewer/editor/owner roles and cross-tenant 403/404, (12) create **Sales** and **Support** agents (same isolated business, different IDs), (13) PUT full agent configuration using current `expected_version`, set active catalog model, add intentionally disjoint text sources, inspect returned `completed`/skipped chunk counts, verify source list and durable knowledge revisions, (14) independently PATCH each agent to active, POST its own paused website deployment with approved controlled origin(s), collect each token only in protected test memory/secret manager, PATCH deployment to active. No public chat yet.

**Approval C — website chat plus provider spend:** (15) owner explicitly approves public flag enablement **only for isolated staging**, plus bounded provider usage; set `AGENT_WEBSITE_ENABLED=true`, validate deployed API/worker config and healthy service, (16) run cases in §7 with tokens and one fresh unique `sessionId` per conversation, record redacted HTTP responses, source IDs, record counts and negative results, (17) optionally run the separate `smoke:provider` canary only with its explicit approval guard and conservative `<= $0.05` cap, operator-verified unit prices and provider billing limits; never interpret a mock as a paid canary, (18) disable the website flag immediately after the demonstration, revoke pilot credentials, inspect cleanup/usage/audit records. Do not automatically keep any paid service running.

**Never** enable the flag in production as an incidental consequence of isolated staging.

## 7. Two-agent fixtures, test cases and expected observable results

Use owner-approved, entirely synthetic sources and contact addresses. Do not insert customer data. Choose distinct marker phrases to allow exact retrieval/source attribution (e.g. Sales-only sentinel `SALES-ALPHA-PALETTE`; Support-only `SUPPORT-BETA-RESET`), not production secrets.

- **Agent A — Sales:** name `Sales Assistant`, purpose `sales` or `lead_generation`; system prompt answers website development packages, price/timeline and captures consented lead contact. `source_key=sales_packages` text contains package descriptions, synthetic £ or $ test prices, the Sales-only sentinel, and delivery windows. Enable `lead_capture` with explicit approved fields.
- **Agent B — Support:** name `Customer Support`, purpose `customer_support`; prompt answers troubleshooting, service policies, refunds and escalations. `source_key=support_policy` text contains test-only policy and Support-only sentinel. Turn on appropriate `human_escalation`/inquiry flow as supported by the backend; do not assume generic extraction.
- Separate `agentId`, deployment, token, allowed origin, session IDs, knowledge source and config version for each. Same business tests **agent** isolation; a second business and verified user prove **tenant** isolation.

| Test | Procedure | Expected pass evidence (not executed here) |
|---|---|---|
| T00 public gate | POST valid-looking chat while flag=false | HTTP 503, no DB chat writes |
| T01 session/auth | register, verify, sign in, call get-session, revoke/sign out | proper Better Auth cookie, live DB-backed user/session, no access after revoke |
| T02 permissions | owner/admin, grant editor, viewer, agency member without grant, foreign user | editing permitted only owner/admin/editor; viewer cannot read agent secrets/knowledge/conversations; forbidden 403 or scoped 404 |
| T03 configure concurrently | two PUT config requests with same `expected_version` | exactly one version increment; stale PUT 409 |
| T04 knowledge A | POST `sales_packages`, list sources, duplicate same key/text | first 201 `{success:true,status:"completed",inserted,...,sourceId}`; unchanged duplicate 200 `status:"skipped"`; only A sources listed |
| T05 knowledge B | POST `support_policy`, then GET both lists | B source only in B list; A list unchanged; independent knowledge revisions |
| T06 positive JSON | Sales token + Sales Origin, POST `/api/agent-chat` | 200 JSON with non-empty `reply`, `creditsUsed`, `usage`; stored A session/messages; inspect provider input context for Sales-only text |
| T07 positive SSE | Support token + Support Origin, POST `/api/agent-chat?stream=true` | 200 `text/event-stream`; `ready`, `{text,token}`, `meta`, `[DONE]`; content complete **after** DB transaction; stored B messages |
| T08 cross-agent retrieval | ask A about B sentinel, B about A sentinel; inspect provider mock/instrumented retrieval | disallowed source absent from counterpart retrieval context, SQL results and cache; don't judge solely on natural-language answer |
| T09 sessions/leads/inquiries | submit consented named/email sales message and support issue message; GET scoped lists | A only owns A session/lead; B only B session/inquiry; foreign agent's session/list absent; no cross-tenant rows |
| T10 credential mismatch | missing/malformed/random or other deployment token with wrong origin | 403, no writes; correct token + its *own* allowed origin may validly identify that agent, so do not mistake it for a user identity |
| T11 invalid Origin | valid token + missing, malformed, or unapproved Origin | 403, no writes; verify browser CORS preflight separately |
| T12 rotate and revoke | rotate A token, repeat old and new; revoke B token, retry | old A 403, new A permitted if deployment remains active; revoked B 403 and deployment paused; GET list never returns token |
| T13 deactivation | pause agent A / deployment and retry; attempt in-flight config modification | paused agent may return 200 disabled `isDisabled:true` with zero usage and **no writes** if deployment remains active; paused deployment 403; in-flight stale config 409, no success record |
| T14 concurrency and Redis | same session simultaneous turns; simulated unavailable Redis/queue | one concurrent turn 409 as implemented; unavailable Redis fails closed where quotas require it, not a silent bypass; preserve committed data |
| T15 migration/rollback | isolate a disposable DB, verify 001–013 + schema/count checks, simulate application rollback | rows/knowledge preserved; flag-off denies chat; additive tables retained; no destructive rollback |
| T16 HTTP retry ambiguity | force simulated acknowledgement loss after commit then retry | record possible duplicate chat turn; no exactly-once claim; mitigate operationally, do not assert a nonexistent idempotency key |
| T17 API/worker | start separately and test health/queue without file upload | both services connect to Redis; queues are durable; file handoff **BLOCKED** pending independent storage solution |

**Expected public chat errors:** bad `{sessionId,message}` 400; bad/missing token or Origin 403; paused/revoked deployment 403; disabled feature 503; active deployment with paused agent: disabled JSON/SSE response rather than necessarily 403; concurrent same-session work or changed config 409; model/embed outage can yield 502. Record exact observed bodies without leaking credentials; do not make success depend on LLM answering deterministically. For the SSE route, implementation buffers a full completion and emits one text event; it is **not** token-by-token model streaming.

## 8. Executable safe verification commands (no staging deployment)

Use the pinned commits in separate local checkouts **only when source checkout and local tooling are available**. `npm ci` and test scripts are nonproduction but can use network/dependency installers; review before running. Never export real secrets into logs.

```sh
# Dashboard (Node >=22.18), on pinned Phase 5D checkout
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e

# Backend, pinned PR #145 checkout, no external provider call
npm ci --ignore-scripts
npm test
# Only against a positively identified, isolated test/staging target:
npm run staging:check
# Do NOT run staging:migrate, smoke:provider or change flags in preflight.
```

For **disposable local tests only**, `docker compose -f docker-compose.staging.yml up -d` creates loopback pgvector/PostgreSQL (`chatflow_security_test`) and Redis. With deliberate `TEST_DATABASE_CONFIRM=I_CONFIRM_DISPOSABLE_TEST_DATABASE`, `TEST_DATABASE_URL`, `STAGING_REDIS_URL` and `CHATFLOW_ENVIRONMENT=isolated-staging`, `npm run test:staging` runs actual Better Auth/PostgreSQL/Redis integration fixtures with mocked provider/email delivery. This is **not** a managed Render smoke test. If Docker/DB/Redis is not present or no explicit test-DB confirmation is set, mark BLOCKED; never point those fixtures at a shared DB.

## 9. Failure investigation

- 401: verify active confirmed email, Better Auth session expiry, host-only cookie and BFF cookie forwarding. Never paste cookie/token values into tickets.
- 403/404: inspect effective agency/business role/grant, business active state, coupled resource IDs, exact Origin, deployment token version, and deployment status; do not loosen permissions to pass.
- 409: fetch latest config version; confirm active agent/config/model/plan; retry only an explicitly idempotent operation after inspection.
- 415 or BFF 404: check JSON content type, method/path fixed allowlist and browser Origin/CSRF; never bypass BFF.
- 502: check provider availability/embedding error or backend reachability using scrubbed logs; a confirmed source insert cannot be inferred from a timeout.
- 503: feature intentionally disabled, missing auth config, unready DB/vector or Redis; `/readyz` provides status.
- 200 SSE with missing data: inspect events and DB commit status; ensure buffering is not broken by reverse proxy.
- Worker failure: check Redis policy, job IDs/retry/dead-letter/queue state, separate process startup and file locality. Do not replay ambiguous writes indiscriminately.
- Migration failure: stop, preserve schema/ledger and logs, compare against backup, seek owner approval before recovery; **do not blindly rerun**.
- Safety: scrub request bodies, auth cookies, x-agent-token, provider keys, email reset/verification links from all diagnostic artifacts.

## 10. Rollback and cleanup (**explicit owner approval required**)

1. Set `AGENT_WEBSITE_ENABLED=false` on the isolated staging API first, disable traffic, confirm future chat 503 and no new writes.
2. Pause/revoke both test deployments and stop test provider usage. Revoke exposed tokens; never print or retain them in issue bodies.
3. If an application rollback is approved, deploy the previously pinned compatible commit only after DB/worker schema compatibility review. Preserve additive tables, domain policies and knowledge revision triggers. Do not drop chat/session/agent/tenant records for an application rollback.
4. If DB restore is genuinely required, use the separately validated isolated backup and explicit recovery approval; never restore production/shared contents to test.
5. Archive redacted test results and exact versions; delete disposable test accounts/data/services **only** with approval and a positive isolation check. Stop billable resources when no longer required.

## 11. Cost estimate and price provenance (no purchase approved)

Render's [published pricing](https://render.com/pricing) lists legacy Starter/modern `0.5c-512mb` at **$7/month** per service, PostgreSQL `0.5c-1g` at **$19/month**, and Key Value `256mb` at **$10/month** (retrieved 2026-10-23). Based on the checked-in blueprint: API $7 + worker $7 + database $19 + Redis-compatible key value $10 = **$43/month list-rate**. The separately hosted Next.js dashboard would add **approximately $7/month** at the same compute plan: **$50/month estimated nominal five-service baseline**. Workspace fees (if any), any PostgreSQL storage beyond the initially included 1 GB (published expansion rate $0.30/GB-month), bandwidth, builds, taxes, plan changes, downtime vs hourly prorating, email delivery, provider usage and backup features are excluded and must be verified in the owner's actual account before approval. No claim is made that $50 is a final bill.

OpenAI embedding and OpenAI/Anthropic completion costs depend on the *operator-selected current model prices and token totals*. No provider price is treated as verified in this preflight. The separate canary enforces an operator-configured ceiling of at most $0.05 for its bounded test *only when separately approved*; this is **not** the total end-to-end demo cost.

## 12. Final preflight decision and signoff

**BLOCKED — ACTION REQUIRED.** The management interface and backed API are substantially code-aligned, and CI tests including disposable PostgreSQL/Redis integrations passed. No Phase 6A cloud services were provisioned, no production migrations, paid AI calls or real HTTPS E2E runs occurred. The remaining gates before owner-approved staging are: review high/critical dependency advisories, resolve the configuration-dependent Better Auth emailed verification/reset link route, validate PostgreSQL TLS and roles, verify actual external HTTPS/cookies/proxy/email configuration, confirm isolated backup/restore and billing, add/start a separate Next.js frontend service, and explicitly acknowledge the file-worker storage topology is out of scope for text-only demo. Owner approval is required independently for infrastructure and database setup, test-user/email/provider setup, website flag change and live chat/provider spend. **This runbook is not authorization to execute any of those steps.**

