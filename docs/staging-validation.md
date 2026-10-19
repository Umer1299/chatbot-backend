# Chatflow AI staging validation

This runbook verifies the existing agent website runtime. It uses disposable local infrastructure and the authenticated APIs already implemented in this repository. It does not deploy anything, alter a Render service, or contact a live provider unless the separate provider canary is explicitly approved.

## Readiness matrix

| Area | Verified locally | Verified in CI | Verified in staging | Current status |
| --- | --- | --- | --- | --- |
| Node runtime | Node 24.19.0 was available in the coding environment; project requires `>=22.18.0` | Workflow runs Node 24 | Not run | `render.staging.yaml` pins Node 24.21.0 for both staging services; existing production `render.yaml` remains unchanged and still specifies Node 20 |
| PostgreSQL and pgvector | No Docker, `psql`, or local PostgreSQL service was available | PostgreSQL 16 with pgvector; migrations 001–013 and replay tests | Not run | New guarded runner applies 001–013 only to an empty database named `chatflow_staging`; synthetic fixtures are not a representative customer snapshot |
| Redis | No local Redis service was available | Redis 7 connectivity and `noeviction` policy are checked in CI | Not run | The separate staging blueprint requests `noeviction`; existing production `render.yaml` remains `allkeys-lru` and unchanged |
| Better Auth and onboarding | Full flow is encoded in the isolated Express/PostgreSQL integration fixture | Registration, email verification through an in-memory test outbox, session login, agency, business, two agents, and deployments pass | Not run | Staging still needs an approved test sender and HTTPS cookie/proxy validation |
| Two-agent website behavior | Fixture uses controlled model and embedding adapters | Sales and support prompts, knowledge, JSON/SSE, sessions, leads/inquiries and cross-agent denial pass | Not run | No live provider response is claimed |
| Provider adapters | Optional canary is implemented; it was not run | Mock adapter settings and timeout forwarding pass | Not run | No approved test keys were supplied |
| Upload worker topology | Code inspection | Existing worker tests pass | Not run | **Blocked**: API writes to `os.tmpdir()` and queues that path; Render API and worker are separate services with no demonstrated shared durable filesystem |
| Readiness and startup | Unit tests for startup gate and live dependency checks | HTTP readiness behavior covered by tests | Not run | `/healthz` is liveness; `/readyz` now stays 503 until database/vector/index/Redis initialization completes and checks PostgreSQL and Redis on each request |

## Environment requirements

- Node.js `>=22.18.0`; the CI-tested runtime is Node 24.
- Docker Compose v2 for the disposable local stack.
- PostgreSQL 16 with the pgvector extension.
- Redis 7 configured with `maxmemory-policy noeviction` for BullMQ state.
- `npm ci` from the lockfile.
- Optional live canary: one approved test provider key, a provider model allowed for the staging business, and a non-production environment confirmation.

`docker-compose.staging.yml` binds PostgreSQL and Redis to loopback only. PostgreSQL data is held in container `tmpfs` and disappears when the container stops. The database name and test user are deliberately dedicated to tests. Do not change these values to point at a shared, staging, or production database. The tests apply SQL inside randomly named private schemas and drop only those schemas; PostgreSQL extensions are installed in the disposable database's `public` schema.

## Exact configuration variables

Copy `.env.staging.example` to the ignored `.env.staging` file. It contains placeholders, not real keys.

Required by the staging test runner:

| Variable | Example | Purpose |
| --- | --- | --- |
| `CHATFLOW_ENVIRONMENT` | `isolated-staging` | Required runner mode; prevents accidental use as a general database command |
| `TEST_DATABASE_URL` | `postgres://chatflow_test:local_test_only@127.0.0.1:55432/chatflow_security_test` | Must be loopback and name exactly `chatflow_security_test` |
| `TEST_DATABASE_CONFIRM` | `I_CONFIRM_DISPOSABLE_TEST_DATABASE` | Positive confirmation required before SQL rehearsal |
| `STAGING_REDIS_URL` | `redis://127.0.0.1:56379/0` | Must be a loopback Redis address |
| `LIVE_PROVIDER_TEST_APPROVED` | `I_APPROVE_ONE_BOUNDED_PROVIDER_CANARY` | Explicit opt-in for live provider calls |
| `LIVE_PROVIDER` | `openai`, `anthropic`, or `combined` | `openai` tests OpenAI embedding + completion; `anthropic` tests Anthropic completion only; `combined` tests OpenAI embedding + Anthropic completion |
| `LIVE_PROVIDER_MODEL` | approved provider model ID | Required completion model |
| `LIVE_PROVIDER_MAX_COST_USD` | `0.01` | Caller limit, hard capped by the script at `$0.05` |
| `LIVE_PROVIDER_INPUT_USD_PER_1M` | operator supplied | Current completion input price |
| `LIVE_PROVIDER_OUTPUT_USD_PER_1M` | operator supplied | Current completion output price |
| `LIVE_PROVIDER_EMBEDDING_USD_PER_1M` | operator supplied | Current OpenAI embedding input price; required only for `openai` and `combined` |

For running the actual Express app against a separately prepared isolated staging database, also configure `DATABASE_URL`, `REDIS_URL`, `ACCOUNT_AUTH_ENABLED=true`, `ACCOUNT_AUTH_URL`, `ACCOUNT_AUTH_SECRET` (at least 32 random characters), `ACCOUNT_TRUSTED_ORIGINS`, `ACCOUNT_PROXY_MODE`, `TRUSTED_PROXY_CIDRS` when proxy mode is `trusted`, `DASHBOARD_ALLOWED_ORIGINS`, explicit HTTPS `WIDGET_ALLOWED_ORIGINS`, an independent 32+ character staging `JWT_SECRET` for the legacy auth bridge, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, and the required test provider key (`OPENAI_API_KEY` or `ANTHROPIC_API_KEY`). Set `AGENT_WEBSITE_ENABLED=true` only in an isolated staging service after migrations and preflight checks. The committed example leaves it `false`.

The existing production Render blueprint does not currently define the Better Auth URL/secret/origins, trusted proxy mode/CIDRs, Resend sender/key, `ACCOUNT_AUTH_ENABLED`, `AGENT_WEBSITE_ENABLED`, legacy JWT secret or explicit widget origins. Keep real values in the staging provider's secret manager; never commit them or put session cookies or one-time deployment tokens in logs.

## Start the disposable stack and run the deterministic end-to-end fixture

From the repository root:

```sh
npm ci
docker compose -f docker-compose.staging.yml up -d --wait
cp .env.staging.example .env.staging
set -a
. ./.env.staging
set +a
npm run test:staging
docker compose -f docker-compose.staging.yml down
```

The staging runner refuses to start unless the explicit confirmation is present, `CHATFLOW_ENVIRONMENT=isolated-staging`, the PostgreSQL URL is loopback with the exact disposable database name, and Redis is loopback. `npm run test:staging` runs the two PostgreSQL integration roots and the real Redis preflight. It never reads `DATABASE_URL` for migrations. The integration roots also enforce loopback and database-name checks themselves.

To run the complete suite against the disposable stack rather than only the focused end-to-end/migration roots:

```sh
npm test
```

With the example environment loaded, these integration tests require `TEST_DATABASE_CONFIRM`. Without `TEST_DATABASE_URL`, PostgreSQL tests are skipped by Node's test runner. Do not treat skipped database tests as validation.

The account integration fixture uses the existing Better Auth signup and email-verification endpoints. Its injected mail outbox captures the verification link in memory, then verifies by following that link; it does not directly mark a user as verified in SQL. It creates an agency through Better Auth organization endpoints, adds a client business through the agency API, creates two agents/configurations, adds knowledge through the authorized knowledge endpoint, activates both agents and creates/activates independent website deployments. It then uses the issued credentials through `/api/agent-chat` and `/api/agent-chat?stream=true`.

The Sales Assistant uses sales services/pricing/timelines and configured email capture. The Customer Support agent uses refund/troubleshooting knowledge and creates inquiries. Assertions inspect the provider input prompts, retrieval context, independent durable revisions, stored conversation history and scoped leads/inquiries. Negative cases cover foreign business/agent IDs, token substitution, invalid origin, pause/revoke behavior, session collision, Redis failures, and configuration changes during generation. Provider calls are deterministic mocks in this fixture.

## Migration rehearsal and data preservation

The integration tests are the safe migration rehearsal. They apply migrations 001–013 to a fresh random schema in a disposable PostgreSQL database. A second synthetic historical-data fixture applies 005–013 with legacy businesses, configurations, conversations, messages, leads, inquiries and knowledge already present. Tests compare before/after historical records, exercise legacy bot mapping and agency memberships, verify composite ownership constraints and vector retrieval, replay migrations 005–008 and 009–013, and verify revision triggers and rollback behavior.

There is no approved sanitized customer snapshot in this workspace. The historical fixture is synthetic and must not be described as a rehearsal against customer data. Staging must separately rehearse 005–013 against an approved sanitized snapshot if one becomes available. Record table counts, UUIDs, bot IDs, configuration counts, session/message/lead/inquiry counts, knowledge/vector counts, membership and mapping counts, and policy values before and after that rehearsal.

Migrations 008–013 use a transaction-scoped advisory lock (key `145008`) and a migration ledger. Migrations 001–007 do not use that shared lock. The test suite checks ordering and replay but does not measure lock wait under concurrent production-like traffic, table-lock duration at customer scale, extension-install permissions under the actual runtime role, or backup restoration. CI does not collect per-migration timings. Capture those in staging with representative data and the intended migration role.

Do not run `node src/db/migrate.js` against an initialized database: it blindly executes every migration file in order, and migrations 001–007 are not a safe replay command. The application server does not run 001–013 automatically. It listens before initialization, but `/readyz` remains 503 until vector/table/index setup and Redis ping succeed; the readiness route also checks PostgreSQL and Redis per request. `setupVectorTable()` now propagates errors so the startup gate cannot report ready after failed vector setup. Use `npm run staging:migrate` only with the dedicated isolated staging guard described below. The command accepts either a fully verified already-migrated staging database (no-op) or a fresh empty `chatflow_staging` database; it refuses any other non-empty state. No production migration is authorized here.

## Optional live-provider canary

The test fixture and CI use mocks; they do not establish that provider credentials, account billing, model access, or network access work. Provider-specific behavior is explicit: `openai` makes one OpenAI embedding call and one OpenAI completion; `anthropic` makes one Anthropic completion and needs no OpenAI credential or embedding price; `combined` makes one OpenAI embedding call and one Anthropic completion, and requires both credentials. All completion modes require `LIVE_PROVIDER_MODEL` and current input/output prices; embedding modes also require the OpenAI embedding price. Each SDK request receives a 20-second abort signal and completion output is capped at 32 tokens. Before calls, the script enforces a conservative request ceiling using up to 64 embedding tokens, 256 completion input tokens and 32 completion output tokens, plus a caller-selected cost cap hard-limited to $0.05. It prints provider mode, token counts, estimated cost and (only when embedding runs) dimensions; it never prints prompts, responses, vectors or keys. The estimates rely on prices supplied by the operator, so also use the provider account's own spend controls.

Only run it after confirming a non-production environment and approved test credentials:

```sh
CHATFLOW_ENVIRONMENT=isolated-staging \
LIVE_PROVIDER_TEST_APPROVED=I_APPROVE_ONE_BOUNDED_PROVIDER_CANARY \
LIVE_PROVIDER=openai \
LIVE_PROVIDER_MODEL=<approved-model-id> \
LIVE_PROVIDER_MAX_COST_USD=0.01 \
LIVE_PROVIDER_INPUT_USD_PER_1M=<current-input-price> \
LIVE_PROVIDER_OUTPUT_USD_PER_1M=<current-output-price> \
LIVE_PROVIDER_EMBEDDING_USD_PER_1M=<current-embedding-price> \
OPENAI_API_KEY=<approved-test-key> \
npm run smoke:provider
```

For Anthropic-only mode, use `LIVE_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`; do not provide or configure OpenAI credentials. For combined mode, use `LIVE_PROVIDER=combined`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and the embedding price. Unsupported mode values fail before any provider call. The canary has no PostgreSQL write and does not prove agent configuration, RAG insertion/retrieval, chat history, leads/inquiries, JSON/SSE routing, or real API deployment behavior. A live full-runtime check requires a separate isolated staging API/business and should run through the authenticated management and public chat APIs with a tightly controlled test account. No live provider calls were made for this change because approved credentials and a staging endpoint were unavailable.

## Deployment audit and production blockers

- **Node:** `package.json` declares `>=22.18.0`; existing `render.yaml` pins `NODE_VERSION=20` on both production services. The new independent `render.staging.yaml` selects Node 24.21.0 for the staging API and worker. The file has not been applied or validated by Render's deploy planner.
- **Redis:** existing production `render.yaml` sets `maxmemoryPolicy: allkeys-lru`; it is unchanged. The independent staging blueprint requests `noeviction`. Confirm this policy in Render and monitor memory/queue growth before any staging traffic.
- **Files:** uploads are staged under `os.tmpdir()` by the API and the queue payload sends that local path to a separate worker service. Unless the deployed services demonstrably share durable storage, the worker cannot read the API file. This blocks file uploads on that topology; no object-storage or shared-filesystem redesign is included.
- **Database startup:** the listener begins before initialization, but `/readyz` remains unavailable until vector/index setup and Redis ping succeed; it then checks database and Redis connectivity on every request. `/healthz` is liveness only. This behavior is unit tested, not verified behind a deployed proxy.
- **Database TLS and roles:** `src/db/pool.js` disables certificate verification in production mode with `rejectUnauthorized:false`. Validate the provider's TLS requirements and certificate chain; prefer verifiable TLS when compatible. Confirm pgvector extension privileges and use separate migration/runtime roles where supported. CI uses an isolated test owner and does not prove least-privilege operation.
- **Better Auth/email:** runtime auth fails closed unless `ACCOUNT_AUTH_ENABLED=true`, `RESEND_API_KEY` exists, exact trusted origins/auth URL are configured, and production proxy mode is explicit. Configure HTTPS, cookie host/path, sender reputation, verification/invitation delivery and account recovery in staging.
- **Proxy and rate limits:** supply only the actual ingress IP/CIDRs in `TRUSTED_PROXY_CIDRS`; do not use blanket trust or a guessed hop count. Validate forwarded IP handling, secure cookies, HTTPS origin and rate-limit behavior through the staging ingress.
- **Agent rollout:** `AGENT_WEBSITE_ENABLED` defaults off. Keep it off on production until migrations 005–013, domain policy, credential revocation, provider calls, Redis and the full staging two-agent test pass.
- **Retries:** same-session concurrent turns are rejected while a claim is active, and config changes cannot persist stale replies. There is no client request idempotency key, however. If a transaction commits but its HTTP response is lost, resending the same message can commit a duplicate user/assistant pair. If claim deletion succeeds in PostgreSQL but its acknowledgement is lost, the server can return failure and a retry can also create a duplicate turn. Leads/inquiries upsert by session, but messages are not deduplicated. Exactly-once delivery is not provided.

## Backup, restore and rollback

Before staging migration rehearsal, create a database snapshot/backup using the provider-supported mechanism and verify restore into a separate disposable database. Record the backup identifier, migration ledger versions and the pre-migration counts listed above. After rehearsal, compare all preserved data and run account/chat/knowledge smoke tests.

For an application rollback, first set the staging website-agent feature flag off, stop agent traffic, and roll back application code to the prior commit. Keep additive tables and data until a reviewed rollback migration exists; do not drop agent tables or legacy rows as part of application rollback. A failed DDL migration may have rolled back transactionally where wrapped; inspect the migration ledger and schema before retrying. Restore the verified backup only for an approved recovery event, never as a routine test cleanup.

## Next.js dashboard integration

The future dashboard should call Better Auth endpoints for sign-up, sign-in, verification and session retrieval, with HTTPS `HttpOnly`, `Secure`, `SameSite=Lax` cookies and exact trusted origins. It should call `/api/v1/agencies`, `/api/v1/agencies/:agencyId/businesses`, `/api/v1/businesses/:businessId/agents`, each agent's `/config`, `/knowledge` and `/deployments` routes using the user's session cookie and CSRF/Origin protections. Keep provider keys and deployment bearer tokens out of browser logs; display a deployment token only at issuance/rotation. Public site widgets use only the scoped `x-agent-token` and approved website Origin with `/api/agent-chat`; that credential cannot call management routes. The server derives user roles and business access from the Better Auth session and database grants, never from dashboard-supplied role claims.

## Full staging checklist

- [ ] Review and apply `render.staging.yaml` manually; confirm both API and worker run Node `>=22.18.0` (CI-tested Node 24). Existing `render.yaml` must remain untouched.
- [ ] Provision isolated PostgreSQL 16/pgvector and Redis with `noeviction`; verify persistence, backups, restore and network policy.
- [ ] Apply/rehearse migrations 001–013 in order using a dedicated migration role; capture timings and locks; compare preservation counts; verify a sanitized snapshot only if approved.
- [ ] Confirm application runtime role access and pgvector/TLS configuration without granting broad DDL privileges.
- [ ] Configure staging-only auth URL/secret/trusted origins, proxy CIDRs, HTTPS cookies, Resend verification/invitation/recovery, request limits and secret-manager values.
- [ ] Start API and worker separately; verify file upload handoff with a real cross-service test. Until it passes, file uploads are blocked on separate containers.
- [ ] Run `npm run test:staging` on disposable local services and retain the output; run the full CI suite with zero PostgreSQL skips.
- [ ] Register a staging user through Better Auth; verify email through the approved sender; create agency, client business, Sales and Support agents, configs, knowledge and deployments using management APIs.
- [ ] Run real-provider canary only with explicit approval; then perform a bounded full-runtime check covering embeddings, retrieval, prompts, multiple turns, usage, leads/inquiries, JSON/SSE and cross-agent denial.
- [ ] Verify invalid/revoked tokens, bad origins, paused agents, cross-business IDs, config races, Redis outage, same-session concurrency and retry-after-response-loss behavior.
- [ ] Verify health/readiness timing, startup failure handling, queue retention, Redis memory alerts, rollback steps and that the public agent feature flag remains off outside staging.

**Current assessment:** CI provides strong automated two-agent and migration evidence. No local container runtime, staging service, approved sanitized customer snapshot, or provider credentials were available for this task. Staging readiness is **pending**; production readiness is **blocked**.

## Phase 4B verification record — 2026-10-19

The PR head `c63e4de9563174496f5ce8e1aa0193958236bd02` was checked without changing cloud infrastructure or using customer data.

| Check | Result | Evidence |
| --- | --- | --- |
| Node compatibility and dependency install | **PASS** | Local Node `v24.19.0`; `npm ci --ignore-scripts` completed; `npm ls --depth=0` reported no invalid dependencies. |
| Full pull-request CI | **PASS** | [Run 39212695343](https://github.com/Umer1299/chatbot-backend/actions/runs/39212695343): 191 tests, 191 passed, 0 failed, 0 skipped. The job ran Node 24, PostgreSQL 16/pgvector and Redis 7; database integration tests and migration fixtures ran in that isolated CI job. |
| Local unit/security suite | **PASS with infrastructure skips** | `npm test`: 157 total, 154 passed, 0 failed, 3 skipped. The skips require local PostgreSQL/Redis URLs. |
| Disposable local migration rehearsal | **BLOCKED** | Docker and Docker Compose are not installed. The staging runner was invoked without confirmation and correctly exited 2 before opening a database or running SQL. |
| Redis local connectivity/policy | **BLOCKED** | No local Redis or Docker runtime. CI's Redis 7 service and integration check passed; no Render Redis settings were changed. |
| Agency onboarding/two-agent integration | **PASS in CI; NOT RUN against a deployed staging API** | The PostgreSQL integration suite exercises Better Auth/API onboarding and the two-agent isolation fixture with test-only data and controlled provider mocks. No real staging account or service was available. |
| Live provider canary | **NOT RUN** | No approved non-production API credentials or live staging endpoint were supplied. Invoking the canary without explicit approval exited 2 before provider calls. Mock-mode canary tests ran as part of the suite. |
| Full real-provider website RAG | **NOT RUN** | Requires an isolated staging API, approved provider credentials, and a real staging deployment. A canary unit test is not evidence of full application RAG. |
| Render/HTTPS/proxy/email/file handoff | **BLOCKED** | No staging Render service was authorized or available. Existing blueprint issues remain: Node 20 conflicts with `>=22.18.0`, Redis `allkeys-lru` conflicts with queue-safe `noeviction`, and API-to-worker temporary files are not proven shared. |
| Historical backup/restore rehearsal | **NOT RUN** | No sanitized historical snapshot and no isolated staging database were provided. CI uses synthetic fixtures only. |

Local verification commands included `npm ci --ignore-scripts`, `npm ls --depth=0`, `npm test`, `node --check scripts/live-provider-canary.js`, `node --check scripts/run-staging-tests.js`, and a guarded `npm run test:staging` invocation. The latter refused to proceed without the disposable-database confirmation, as intended. The CI result, rather than the local skips, is the evidence for PostgreSQL/pgvector and Redis integration coverage.

Required separate staging configuration changes remain: select Node `>=22.18.0` (CI-tested Node 24) for both API and worker; use a dedicated Redis configured with `noeviction`; provision isolated PostgreSQL 16/pgvector and verify backup/restore; set an HTTPS staging URL plus explicit trusted proxy CIDRs, secure Better Auth cookies, exact trusted origins and test email delivery; set `AGENT_WEBSITE_ENABLED=true` only in that isolated service after migrations and preflight pass; and prove file upload handoff across the actual API/worker topology before allowing file uploads. These are manual, separately reviewed staging changes. No Render service or production setting was changed during this verification.

## Phase 4C staging preparation

This section supersedes the Phase 4B statements about adding a future blueprint/readiness endpoint. It prepares configuration and local guards only. No Render blueprint was applied, no cloud service was created, no migration was run in this environment, and no staging or provider call is claimed.

### Separate blueprint and resources

`render.staging.yaml` is an independent Render Blueprint file. It defines a staging API web service, a separate staging file worker, a PostgreSQL 16 database named `chatflow_staging`, and a Render Key Value service configured with `noeviction`. Render currently describes new Key Value instances as Valkey, a Redis-protocol compatible implementation ([Render Key Value docs](https://render.com/docs/key-value), [Valkey FAQ](https://render.com/docs/valkey-faq)); do not describe this as an actual Redis 7 server without checking the service's reported product/version. CI uses Redis 7, so compatibility with the selected managed Valkey version remains a staging validation item. Both Node services pin Node 24.21.0, matching the package engine requirement `>=22.18.0`. Auto-deploy is disabled. The API uses `/readyz`, and its pre-deploy command is the guarded staging migration runner. Agent chat and Better Auth start disabled. Secret variables use Render's manual `sync: false` flow; no values are committed. `WIDGET_ALLOWED_ORIGINS` is explicit and must be set to the one or more approved HTTPS widget origins. The database and Redis have empty IP allowlists in the blueprint and are referenced through same-region internal service URLs.

The YAML was parsed locally as YAML, and the repository unit tests cover its supporting guard/health behavior. It has **not** been submitted to Render's blueprint planner; review the Blueprint Preview and verify empty private-service IP allowlists are accepted before applying. Blueprint application creates potentially billable resources and may start an initial deployment despite auto-deploy being off. Stop at the preview until the owner has reviewed costs, service region, access policy and resource plans. Existing `render.yaml` remains unchanged.

The proposed services are one small web service, one small worker, one managed PostgreSQL 16 instance and one managed Render Key Value instance (currently Redis-protocol-compatible Valkey). Managed cloud service plans may incur charges; exact pricing depends on current plan selection and region. A local Docker Compose rehearsal uses local compute and no managed cloud service. No paid resource was provisioned here.

### Environment validation

Run the read-only preflight after the isolated staging services exist and before enabling agent chat:

```sh
npm run staging:check
```

It checks Node `>=22.18.0`; explicit isolated-staging marker/confirmation; matching staging/application DB and Redis URLs; exact `chatflow_staging` database identity; Better Auth enabled with HTTPS URL/origins, a 32+ character secret, trusted proxy CIDRs and mail sender settings; explicit widget HTTPS origins and a separate 32+ character legacy JWT secret; agent feature flag off; required provider credential presence (without an API call); PostgreSQL connectivity, pgvector, migration ledger/schema/revision triggers; Redis-protocol server major version 7, PING and `noeviction`; then HTTPS `/healthz` and `/readyz`. It prints only statuses and non-secret diagnostic text. Any unsafe target prevents database and Redis connections. It does not write data, run migrations, validate external AI credentials, verify email delivery, or prove proxy/cookie behavior. Since the readiness command requires the feature flag to remain off, save its clean preflight output before enabling the flag in staging. Disable the flag again before repeating preflight.

Readiness status meanings: **PASS** means that exact read-only check succeeded; **FAIL** means a check ran and failed; **BLOCKED** means required configuration or a safe target was missing; **NOT RUN** means an unsafe target guard prevented a connection. Exit status is nonzero unless every check passes. Never paste raw environment dumps, connection URLs, cookie jars, deployment tokens or provider keys into tickets or logs.

The migration command is intentionally separate from the preflight:

```sh
npm run staging:migrate
```

It requires all of: `CHATFLOW_ENVIRONMENT=isolated-staging`, `STAGING_MIGRATION_CONFIRM=I_CONFIRM_EMPTY_STAGING_DATABASE`, `STAGING_DATABASE_URL` naming exactly `chatflow_staging`, and `DATABASE_URL` exactly matching it. It takes a dedicated advisory lock. It migrates only a fresh empty public schema in the exact staging DB, or returns a no-op after verifying all required tables, 008–013 ledger entries, pgvector and knowledge revision triggers. Any other existing schema is refused. A partial failure exits nonzero with a stop/review warning; do not rerun against a partially migrated DB. This is not a general migration runner and must never be pointed at a customer/production DB.

### Exact manual service setup

The following steps require the project owner's Render account, approved staging credentials and explicit cost approval. They have not been performed in this workspace.

1. Review `render.staging.yaml`, current Render plan pricing, region and private network settings. In Render, create a Blueprint from this file on `fix/tenant-security-boundaries`; inspect the complete Blueprint Preview and confirm it references only the new `chatflow-staging-*` resources. Do not edit the existing production Blueprint. Do not apply until you approve any recurring charges.
2. Provision the isolated PostgreSQL and Redis-compatible service before configuring the app. Confirm PostgreSQL major version 16, `vector` extension availability, internal-only access, backups/retention, the managed Key Value product/version (Render currently uses Redis-protocol-compatible Valkey), persistence and `noeviction`. The preflight accepts Redis 7 or Valkey 7 protocol versions and fails closed for other major versions. Use the staging runtime owner initially only if required for extension/schema setup; later split migration and runtime roles if the app's permissions support it. Do not paste credentials into repository files.
3. Configure the complete staging environment through Render's protected environment UI before the first app deploy. Set `NODE_ENV=production`, `CHATFLOW_ENVIRONMENT=isolated-staging`, `STAGING_READINESS_CONFIRM=I_CONFIRM_NON_PRODUCTION_STAGING`, a staging-only `JWT_SECRET` (32+ characters), a staging-only `ACCOUNT_AUTH_SECRET` (32+ characters), `ACCOUNT_AUTH_ENABLED=true`, `AGENT_WEBSITE_ENABLED=false`, and matching `DATABASE_URL`/`STAGING_DATABASE_URL` and `REDIS_URL`/`STAGING_REDIS_URL`. Set `STAGING_BASE_URL` to the assigned HTTPS API origin. Set `ACCOUNT_AUTH_URL` and exact HTTPS `ACCOUNT_TRUSTED_ORIGINS`, `DASHBOARD_ALLOWED_ORIGINS`, and `WIDGET_ALLOWED_ORIGINS`; do not use wildcard origins. Configure `TRUSTED_PROXY_CIDRS` from the actual staging ingress, plus staging-only `RESEND_API_KEY`/`RESEND_FROM_EMAIL` for verification mail. Supply approved staging provider credentials (OpenAI for embeddings and at least one completion provider); readiness checks only their presence and makes no paid call. Never copy production secrets.
4. Verify the newly provisioned database is empty and disposable before setting `STAGING_MIGRATION_CONFIRM=I_CONFIRM_EMPTY_STAGING_DATABASE`. Then run `npm run staging:migrate` from a protected operator shell with the exact staging/app DB URLs and isolated-staging marker. This guarded initialization step only needs the migration variables and confirmation; it does not depend on Better Auth. It applies 001–013 to a fresh empty `chatflow_staging` database and refuses initialized incomplete schemas. The blueprint's pre-deploy command runs the same guard; retain the confirmation only for this dedicated disposable staging DB. Never run it against production or customer data.
5. Start/deploy the isolated API and worker manually, with `ACCOUNT_AUTH_ENABLED=true` and `AGENT_WEBSITE_ENABLED=false`. The deploy's pre-deploy migration check should report either a fresh guarded migration or a verified complete-schema no-op. Confirm `/healthz` and `/readyz` return 200 on the deployed HTTPS host. If startup or migration fails, stop and inspect protected logs; do not bypass the checks.
6. After all auth, HTTPS, proxy, email and database settings are present and the application is running, execute the complete `npm run staging:check` from a protected operator shell with the same isolated target configuration and no shell tracing. It requires Better Auth enabled, secure-cookie production mode, exact approved HTTPS origins, a trusted proxy, email settings, provider credential presence, agent flag off, migrations/schema, PostgreSQL/pgvector, Redis protocol version 7 and `noeviction`, plus live HTTPS health/readiness. Save only redacted status output. This full readiness check is intentionally distinct from the migration-only preflight in step 4; do not disable authentication to make it pass.
7. Verify Better Auth onboarding while the website-agent flag remains off. Use a separate staging browser or protected curl session with HTTPS. Register through Better Auth `/api/account/sign-up/email`, complete the verification link received by the approved staging test mailbox, then sign in through `/api/account/sign-in/email`. Use only those returned Better Auth cookies for management calls. Do not create or directly insert privileged users/sessions using SQL.
8. Create an agency through Better Auth organization endpoints; create a client business through `/api/v1/agencies/:agencyId/businesses`; create two draft agents through `POST /api/v1/businesses/:businessId/agents`; configure each with `PUT /api/v1/businesses/:businessId/agents/:agentId/config` using the returned `expected_version`; add separate text sources through each agent's `POST .../knowledge`; activate each with the management PATCH after confirming its config/model is valid. Keep Agent A sales content and Agent B support content distinct.
9. For each agent, create a website deployment using `POST /api/v1/businesses/:businessId/agents/:agentId/deployments` and an explicit `allowed_origins` array. The response contains a one-time bearer token. Capture it only in a protected local secret store/terminal, never in screenshots, shell history, CI output or logs. Activate via deployment PATCH. If a token is lost, rotate it; the server does not reveal stored tokens. At this point the public chat feature is still disabled; do not call the chat routes yet.
10. Complete and save the feature-disabled safety evidence: readiness passed, auth/onboarding worked, agent/deployment configuration is present, and a request to `/api/agent-chat` is rejected by the disabled feature gate without creating chat records. Then set `AGENT_WEBSITE_ENABLED=true` on this isolated staging API only and manually restart/redeploy as required. Never set this flag on production.
11. After restart, verify the staging route is enabled, then send real HTTP JSON and buffered SSE requests to `POST https://<staging-host>/api/agent-chat` and `POST .../api/agent-chat?stream=true`. Set `Origin` to each deployment's exact allowed site origin, use the matching `x-agent-token`, and use distinct session IDs. Confirm sales knowledge/lead belongs only to Agent A and support knowledge/inquiry belongs only to Agent B using authorized `conversations`, `leads`, and `inquiries` management reads. Then test invalid origin, invalid/revoked credential and cross-agent session reuse; verify rejected requests create no records. Do not copy bearer tokens into command-line arguments visible to other local users; use a mode-0600 curl config or protected secret manager.
12. Keep mock-based validation, optional provider-canary validation, and full website-agent RAG validation as separate results. `npm run smoke:provider` is the only live provider canary and requires its explicit `LIVE_PROVIDER_TEST_APPROVED` guard, non-production credentials, and bounded cost/time/output limits. Run paid calls only after separate approval. A successful provider canary alone does not prove full application RAG; record real chat/RAG as verified only after the isolated staging conversations above use the actual configured provider.
13. Inspect Render logs and metrics without enabling request-body or authorization-header logging. Verify database backup/restore procedure in an isolated destination and review queue/Redis memory. Do not test file upload as successful until a separate API-to-worker file handoff test proves the same file bytes are durably accessible from the worker.
14. Demonstrate rollback by setting `AGENT_WEBSITE_ENABLED=false` in this staging API and manually restarting/redeploying. Verify the agent-chat route returns the disabled response and no new chat records are written; retain existing staging data and additive tables. Revoke staging deployment credentials if exposed; roll application code back to the prior known-good commit if needed. Do not run destructive down migrations. If a migration failed, stop and inspect logs, migration ledger and schema; recreate only a demonstrably disposable empty staging DB after preserving useful staging evidence.

### Staging API smoke request guide

The automated mock smoke command is `npm run smoke:staging`. It aliases the existing `test:staging` harness, which requires loopback PostgreSQL/Redis, `CHATFLOW_ENVIRONMENT=isolated-staging` and `TEST_DATABASE_CONFIRM=I_CONFIRM_DISPOSABLE_TEST_DATABASE`; it runs real HTTP requests against the Express app with controlled model/embedding mocks and disposable test schemas. It makes no provider calls. It is not a request to a deployed Render endpoint. The same onboarding and isolation fixture runs in CI.

For the deployed environment, follow the numbered authenticated workflow above. Management endpoints are under `/api/v1`; they require Better Auth session cookies and the verified agency/business permission checks. Agent knowledge, deployment, conversations, leads and inquiries routes are scoped under `/businesses/:businessId/agents/:agentId`. Website chat uses only a deployment-scoped `x-agent-token`, the `Origin` policy and `/api/agent-chat`; it grants no management or business-list access. Public deployment tokens are displayed only when issued/rotated. `AGENT_WEBSITE_ENABLED` must remain off until migrations and authentication preflight pass.

The new staging validation tests use injected PostgreSQL/Redis/HTTP fakes for guard and health semantics. Actual PostgreSQL 16/pgvector, Redis `noeviction`, Render Blueprint validation, external HTTPS/proxy cookies, email delivery, live provider calls, backup/restore and real web-to-worker file access still require the manual staging environment above.

### Phase 4C readiness checklist

- [ ] Owner reviews and approves the separate Blueprint preview and any service charges; no existing production resource is selected.
- [ ] Render accepts the YAML, private DB/Key Value access is confirmed, staging hostname/HTTPS exists, and auto-deploy remains off.
- [ ] API and worker report Node >=22.18.0; queue service reports supported Redis-protocol version 7 and `noeviction`; PostgreSQL is 16 with pgvector.
- [ ] Fresh disposable staging DB migration 001–013 and verified replay/no-op complete; migration times, locks and DB role permissions are recorded.
- [ ] Backup is made and restore to an isolated destination is proved; no sanitized historical snapshot is used without approval.
- [ ] `/readyz` remains 503 during startup/unavailable dependencies and returns 200 only after verified readiness; secure cookies, CSRF origins, proxy IPs and test email delivery work over HTTPS.
- [ ] `npm run staging:check` reports all PASS while the agent feature flag is off; output contains no secret values; JWT secret and widget origins are staging-only and distinct from production.
- [ ] Better Auth signup, email verification, sign-in, agency/business onboarding and two-agent configuration use only supported APIs.
- [ ] Sales and support deployments use separate origins/credentials; real HTTP JSON and buffered SSE chats persist only scoped sessions, messages, leads and inquiries.
- [ ] Bad origin/token, revoked token, paused agent, cross-agent session and legacy `/api/chat` compatibility are validated in staging.
- [ ] Real model/embedding smoke is run only with explicit approval and non-production credentials; mock, provider canary and full application RAG evidence are recorded separately.
- [ ] API-to-worker temporary-file handoff passes an end-to-end check before any staging file uploads are allowed; otherwise uploads remain disabled/blocked.
- [ ] Runtime is disabled and staging app rollback procedure is recorded before ending the demo.

**Phase 4C assessment:** repository-side staging preparation is implemented and locally testable. Staging readiness remains **BLOCKED** until the owner approves/provisions isolated managed services and performs the checks above. Production readiness remains **NO**: production changes are outside this task, existing production Node/Redis settings are not modified, and file handoff, backup/restore, proxy/cookie behavior and real provider behavior are not verified.

### Phase 4C local verification record — 2026-10-19

| Check | Result | Evidence |
| --- | --- | --- |
| Branch/repository state | **PASS** | Started from `fix/tenant-security-boundaries` at `45605993a0743a3fcb3b8a12161f7f7da2167a56`; worktree was clean apart from this task's edits. |
| Dependency installation | **PASS with upstream deprecation warnings** | `npm ci --ignore-scripts` installed 429 packages; `npm ls --depth=0` reported the lockfile dependency tree without invalid packages. npm warned that the currently locked Multer 1.x line has a patched 2.x successor; dependency upgrade is a separate reviewed change. |
| Syntax/YAML/diff checks | **PASS** | `node --check` on new staging scripts and touched server/app files; `render.staging.yaml` parsed as YAML with 3 services and 1 database; `git diff --check` clean. YAML parsing is not Render Blueprint Preview validation. |
| New readiness/migration tests | **PASS** | `node --test test/stagingReadiness.test.js test/stagingMigrations.test.js`: 11 passed, 0 failed, 0 skipped. Tests cover safety guards, exact migration ordering/no-op/refusal, Node/version/feature/policy checks, readiness and secret redaction using fakes. |
| Full local suite | **PASS with service-dependent skips** | `npm test`: 168 total, 165 passed, 0 failed, 3 skipped. PostgreSQL/Redis integration roots require isolated services. This local run does not replace CI. |
| Staging readiness command without credentials | **BLOCKED as expected** | `npm run staging:check` exited 1: 2 PASS, 1 FAIL (secure production-cookie mode missing), 7 BLOCKED, 2 NOT RUN. No DB or Redis connection was attempted; the command printed no secrets. |
| Migration command without safety confirmation | **BLOCKED as expected** | `npm run staging:migrate` exited 1 before connecting: isolated-staging marker/confirmation absent. No SQL was applied. |
| Disposable HTTP/DB/Redis smoke | **BLOCKED** | `npm run test:staging` exited 2 before connecting because the required disposable DB confirmation is absent. `docker`, `psql`, and `redis-cli` are not installed in this environment. |
| PostgreSQL 16/pgvector migration rehearsal | **PASS in prior CI; NOT RUN locally for this change** | Existing CI baseline on `45605993` passed 191/191 with PostgreSQL 16/pgvector and Redis 7. This change's CI must rerun before merge. No new local migration was run. |
| Render preview, cloud staging, backup/restore | **NOT RUN / BLOCKED** | No Render account/service access, disposable managed DB or owner approval for potentially billable resources was available. |
| Real provider and full hosted RAG | **NOT RUN** | No approved test credentials or deployed isolated staging endpoint. Automated agent tests use deterministic provider mocks. |
| Production changes/customer data | **PASS (none made)** | No deployment, production migration, credential change, DNS change, or customer-data access was performed. |

The current remote CI baseline remains 191 passed, 0 failed, 0 skipped on commit `45605993`; it is not evidence that this new commit passed CI. A fresh PR CI run and Codex review are required after this change is pushed.

### Phase 4C verification follow-up

Before this follow-up, review of the staging checks found that a connected PostgreSQL instance should be positively checked as major version 16, rather than inferred from the Blueprint. `staging:check` now reports the connected major version, and `staging:migrate` refuses before schema inspection or SQL unless the exact `chatflow_staging` database is PostgreSQL 16. Readiness also requires the legacy JWT secret and explicit legacy widget HTTPS origins; the managed Render Key Value product/version is reported as Redis-protocol Redis 7 or Valkey 7, and incompatible major versions fail closed.

Latest local verification after these adjustments: focused staging tests **13 passed, 0 failed, 0 skipped**; full `npm test`: **170 total, 167 passed, 0 failed, 3 skipped**. Syntax checks and `git diff --check` passed. PostgreSQL 16/pgvector and Redis/Valkey service connectivity remain unverified locally because Docker and service endpoints are unavailable; CI on the follow-up commit is required.

The PostgreSQL 16/pgvector and Redis 7 CI run completed on commit `85a42ac42ba345b67b860720b0a2d0d49311903a`: [Authorization boundaries CI run 39219207938](https://github.com/Umer1299/chatbot-backend/actions/runs/39219207938) — **204 passed, 0 failed, 0 skipped**. This is isolated CI evidence only; no managed staging migration, Render Blueprint Preview, backup/restore, staging HTTP deployment or live provider call occurred.
