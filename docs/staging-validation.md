# Chatflow AI staging validation

This runbook verifies the existing agent website runtime. It uses disposable local infrastructure and the authenticated APIs already implemented in this repository. It does not deploy anything, alter a Render service, or contact a live provider unless the separate provider canary is explicitly approved.

## Readiness matrix

| Area | Verified locally | Verified in CI | Verified in staging | Current status |
| --- | --- | --- | --- | --- |
| Node runtime | Node 24.19.0 was available in the coding environment; project requires `>=22.18.0` | Workflow runs Node 24 | No staging environment was available | Render blueprint still pins Node 20 for API and worker, so the declared runtime is incompatible until a reviewed staging blueprint uses a matching supported runtime |
| PostgreSQL and pgvector | No Docker, `psql`, or local PostgreSQL service was available | PostgreSQL 16 with pgvector; migrations 001–013 and migration replay tests | Not run | CI validates the schema and the synthetic preserved-history fixture, not a customer snapshot |
| Redis | No local Redis service was available | Redis 7 connectivity and `noeviction` policy are checked by the staging services test | Not run | Render blueprint currently specifies `allkeys-lru`, which can evict BullMQ queue state; a separate reviewed staging change must use a non-evicting queue policy |
| Better Auth and onboarding | Full flow is encoded in the isolated Express/PostgreSQL integration fixture | Registration, email verification through an in-memory test outbox, session login, agency, business, two agents, and deployments pass | Not run | Staging still needs an approved test sender and HTTPS cookie/proxy validation |
| Two-agent website behavior | Fixture uses controlled model and embedding adapters | Sales and support prompts, knowledge, JSON/SSE, sessions, leads/inquiries and cross-agent denial pass | Not run | No live provider response is claimed |
| Provider adapters | Optional canary is implemented; it was not run | Mock adapter settings and timeout forwarding pass | Not run | No approved test keys were supplied |
| Upload worker topology | Code inspection | Existing worker tests pass | Not run | **Blocked**: API writes to `os.tmpdir()` and queues that path; Render API and worker are separate services with no demonstrated shared durable filesystem |
| Readiness and startup | Code inspection | Existing tests cover route behavior, not deployment startup ordering | Not run | `/healthz` is a static response and `server.js` listens before database/vector initialization completes; operational readiness needs staging verification or a later health-check change |

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

For running the actual Express app against a separately prepared isolated staging database, also configure `DATABASE_URL`, `REDIS_URL`, `ACCOUNT_AUTH_ENABLED=true`, `ACCOUNT_AUTH_URL`, `ACCOUNT_AUTH_SECRET` (at least 32 random characters), `ACCOUNT_TRUSTED_ORIGINS`, `ACCOUNT_PROXY_MODE`, `TRUSTED_PROXY_CIDRS` when proxy mode is `trusted`, `DASHBOARD_ALLOWED_ORIGINS`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, and the required test provider key (`OPENAI_API_KEY` or `ANTHROPIC_API_KEY`). Set `AGENT_WEBSITE_ENABLED=true` only in an isolated staging service after migrations and preflight checks. The committed example leaves it `false`.

The production Render blueprint does not currently define the Better Auth URL/secret/origins, trusted proxy mode/CIDRs, Resend sender/key, `ACCOUNT_AUTH_ENABLED`, or `AGENT_WEBSITE_ENABLED`. Keep real values in the staging provider's secret manager; never commit them or put session cookies or one-time deployment tokens in logs.

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

Do not run `node src/db/migrate.js` against an initialized database: it blindly executes every migration file in order, and migrations 001–007 are not a safe replay command. The application server does not run 001–013 automatically; it does call `setupVectorTable()` during startup, which attempts extension/table/index setup and logs initialization failures after the HTTP listener is already open. Use a reviewed migration procedure, a verified backup, and the integration rehearsal before any staging application. No production migration is authorized here.

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

- **Node:** `package.json` declares `>=22.18.0`; `render.yaml` pins `NODE_VERSION=20` on both services. Propose a separate reviewed staging blueprint that selects a Node version meeting the package engine (CI uses Node 24), then test the API and worker before changing any production blueprint.
- **Redis:** the blueprint sets `maxmemoryPolicy: allkeys-lru`. That policy can evict BullMQ job state and makes Redis cache/session-related behavior difficult to reason about under memory pressure. Validate a separate staging Redis with `noeviction`, monitor memory, and document job retention/alerting before rollout.
- **Files:** uploads are staged under `os.tmpdir()` by the API and the queue payload sends that local path to a separate worker service. Unless the deployed services demonstrably share durable storage, the worker cannot read the API file. This blocks file uploads on that topology; no object-storage or shared-filesystem redesign is included.
- **Database startup:** `server.js` listens before vector/index initialization completes, catches initialization failure, and health routes return static success. Verify startup and readiness in staging; do not infer database readiness from `/healthz`.
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

- [ ] Create a separate staging blueprint; confirm both API and worker run Node `>=22.18.0` (CI-tested Node 24).
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
