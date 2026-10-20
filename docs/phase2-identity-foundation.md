# Phase 2 identity foundation: migration plan

## Audit and decision (before implementation)

The baseline is commit 4bc42d9 on fix/tenant-security-boundaries. Existing management JWTs have a business UUID subject and a verified private Bubble bridge claim. businesses.bubble_user_id is unique and non-null; bot_id is a unique public namespace; bot_configs.business_id is unique. Widget tokens identify a namespace, never a dashboard user. Existing knowledge, history, leads, inquiries and RAG revisions are business scoped. These legacy APIs must retain their current authentication and must not accept new user sessions as legacy JWTs.

Use Better Auth's maintained email/password and organization plugin with its PostgreSQL adapter and Express 4 ESM integration. Organizations represent agencies. Reuse the library's user/session/account/verification/organization/member/invitation tables with explicit chatflow-prefixed names; do not duplicate passwords, reset tokens or agency membership. Account status is a non-input user field checked against PostgreSQL, not cookie claims. Disable cookie session caching so revocation and account status take effect on the next request.

Generate the library schema with the pinned official CLI against a configuration with no production connection. Review and wrap generated DDL as migration 008. Migration 009 makes only legacy bubble_user_id nullable (retaining non-null uniqueness) and adds an explicit one-agency-per-business relationship and business memberships. Existing rows receive no inferred owner, agency or user. No linking by matching email; verified ownership transfer is separate reviewed work. Keep business UUIDs, bot IDs, widget tokens, configurations and all customer records unchanged.

Versioned /api/v1 agency/business APIs authorize current sessions and database memberships. Owners/admins manage agency clients; ordinary agency members require explicit business grants. Verified client users have business-only access and do not inherit agency membership. New business creation and ownership assignment run in one transaction. No existing management endpoint is automatically converted. No dashboard, multi-agent/channel/integration work is included.

Enforce uniqueness/FKs and protect final-owner transitions in PostgreSQL, including concurrent changes. Raw auth endpoints are limited to reviewed authentication and organization operations, with verified active-account gates for organization calls. Do not expose server-only direct-member insertion or organization deletion. Retain Better Auth's own permission and invitation-recipient checks and add stricter verified-email requirements.

New authentication is explicitly enabled/configured, mounted before express.json(), and uses a distinct /api/account namespace, Secure/HttpOnly/SameSite cookies in production, exact trusted origins and CSRF checks. Missing configuration, email delivery or Redis quota infrastructure must not create an authentication bypass. Use the existing Resend provider for transactional identity email, without logging tokens/links.

## Rollout boundary

Apply only reviewed pending migrations 005 → 006 → 007 → 008 → 009 in isolated staging first. Do not run the existing replay-all migration runner against production. Back up/restore and inspect table-name/schema drift, indexes, DDL locks, runtime permissions and historical data. Application rollback disables the new account/versioned APIs while retaining additive identity/relationship tables and nullable legacy identity; never delete customers or restore insecure legacy code. A rollback to NOT NULL is unsafe once new businesses exist.

Production is not authorized. Existing API-to-worker temporary-file handoff remains an explicit deployment blocker for separate containers until end-to-end topology testing proves it works. New auth requires validated Node runtime, HTTPS/reverse proxy, email delivery, exact trusted origins, Redis behavior and secure Next.js BFF/session integration. Final API contract and verification evidence will be recorded here and on PR #145.

## Implemented tables and invariants

Better Auth 1.7.10 is pinned. `chatflow_user`, `chatflow_session`, `chatflow_account`, `chatflow_verification`, `chatflow_organization`, `chatflow_member`, `chatflow_invitation` and `chatflow_rate_limit` are the library schema. `status` is a server-only active/disabled user attribute. Organization = agency; a member has exactly one owner/admin/member role. Uniqueness covers normalized email, external provider identity and one membership per user/agency.

`agency_businesses` assigns each business to at most one agency and records its creator. `business_memberships` grants viewer/editor access to verified users. Staff grants carry a tenant-coupled member FK; removing an agency member removes their business grants, including earlier client grants in that agency. Ordinary agency membership alone grants no business access. PostgreSQL serializes membership changes on the organization row and rejects the final owner's removal/demotion, including concurrent changes. Direct SQL authority remains privileged infrastructure; do not give clients database credentials.

New business creation and ownership assignment commit together. Grants upsert one `(business_id,user_id)` row; cross-agency references fail database constraints. New businesses have a real UUID/bot namespace and `bubble_user_id=NULL`; the existing single configuration constraint remains. They are initially unconfigured and cannot chat until a later authorized onboarding/configuration API is provided. This phase does not issue legacy JWTs for new identities or adapt all old management endpoints.

For future multiple-agency collaboration, replace the single managing-agency primary key only through a reviewed model with explicit per-agency permissions and billing ownership. Do not relax the current uniqueness to infer shared control.

## Permissions

| Operation | Agency owner | Agency admin | Agency member | Client user |
|---|---|---|---|---|
| View agency | Yes | Yes | Own agency | No inherited access |
| Update agency; invite/remove ordinary staff | Yes | Yes | No | No |
| Grant owner role/manage owners | Yes, retaining an owner | No | No | No |
| Create/list all agency client businesses | Yes | Yes | Only list explicitly granted businesses | No agency access |
| Read business metadata | All managed businesses | All managed businesses | Explicit viewer/editor grant | Explicit viewer/editor grant |
| Update allowed business metadata | Yes | Yes | Explicit editor grant | Explicit editor grant |
| Grant/revoke/list business memberships | Yes | Yes | No | No |

Final-owner checks run in both the library and PostgreSQL. Native organization operations retain Better Auth's permission checks; direct member creation, dynamic role creation, organization/user deletion and email identity changes are not exposed. Owner transfer uses inviting/promoting another verified owner before leaving. Account disabling is a privileged operational action, not a self-service field; do not disable the last effective owner without an audited succession/recovery plan.

## Dashboard API contract

All new API calls use the session cookie with credentials included. Unsafe calls require an exact trusted `Origin` and `Content-Type: application/json`. No legacy Authorization header, user ID or submitted role proves identity. IDs in URLs select resources only after current membership checks. New Express management errors are generic; foreign resources return 404, authenticated denied permissions 403, missing/expired/revoked/disabled/unverified identity 401. Do not depend on exact library error wording.

### Independent account and agency endpoints

Base `/api/account`; native Better Auth request/response shapes (camelCase):

| Method/path | Required input / result |
|---|---|
| POST `/sign-up/email` | `{name,email,password}`; sends verification, no auto-login. Password 12–128 characters. |
| POST `/sign-in/email` | `{email,password}`; requires verified email and active account, sets HttpOnly session cookie. |
| GET `/verify-email` | Emailed token/callback URL; native verification flow. |
| POST `/send-verification-email` | `{email,callbackURL?}`; normal library anti-enumeration behavior. |
| GET `/get-session` | Live current verified active user/session. |
| POST `/sign-out` | `{}`; revokes current session and clears cookie. |
| GET `/list-sessions` | Own sessions only. |
| POST `/revoke-session` | `{token}` for an owned session. Never store tokens in browser localStorage. |
| POST `/revoke-sessions`, `/revoke-other-sessions` | `{}`; library revocation. |
| POST `/request-password-reset` | `{email,redirectTo?}`; library-generated emailed link. |
| GET `/reset-password/:token` | Emailed library callback redirects to the trusted frontend reset page with the token. |
| POST `/reset-password` | `{token,newPassword}`; library token/password validation, revokes sessions. |
| POST `/organization/create` | `{name,slug,logo?,metadata?}`; creates agency and owner membership for the signed-in verified user. |
| GET `/organization/list` | Own agencies. Equivalent focused application list: GET `/api/v1/agencies`. |
| GET `/organization/get-full-organization` | `?organizationId=<id>`; membership required. |
| POST `/organization/update` | `{organizationId,data:{name?,slug?,logo?,metadata?}}`; owner/admin. |
| POST `/organization/invite-member` | `{organizationId,email,role}`; role owner/admin/member, restricted by actor role. |
| POST `/organization/accept-invitation`, `/organization/reject-invitation` | `{invitationId}`; verified matching recipient required. |
| POST `/organization/cancel-invitation` | `{invitationId}`; authorized inviter/manager. |
| GET `/organization/get-invitation` | `?id=<invitationId>`; library recipient checks. |
| GET `/organization/list-invitations`, `/organization/list-members` | `?organizationId=<id>`; membership/permissions required. |
| GET `/organization/list-user-invitations` | Current verified recipient. |
| POST `/organization/update-member-role` | `{organizationId,memberId,role}`; restricted role assignment, final-owner protection. |
| POST `/organization/remove-member` | `{organizationId,memberIdOrEmail}`; restricted, final-owner protection. |
| POST `/organization/leave` | `{organizationId}`; cannot remove final owner. |

The invitation email contains a frontend `/accept-invitation?invitationId=...` link on the first trusted origin; configure that origin as the dashboard. The frontend then calls the accept/reject endpoint after verified sign-in. Team invitations grant agency membership only; business grants remain explicit. Client onboarding in this foundation is registration → verification → the agency manager assigns the verified client's user ID. Pending email-only business invitations are not implemented, and an agency invitation must not be used to give a client implicit agency access.

### Versioned client business endpoints

| Method/path under `/api/v1` | Contract |
|---|---|
| GET `/agencies` | `{agencies:[{id,name,slug,logo,role}]}` |
| GET `/agencies/:agencyId` | `{agency}` for current member |
| POST `/agencies/:agencyId/businesses` | Owner/admin; `{business_name,industry,owner_email,website_url?,owner_phone?,timezone?,primary_color?}` → HTTP 201 `{business}` |
| GET `/agencies/:agencyId/businesses` | `{businesses}`; owner/admin all, member only explicit grants |
| GET `/businesses` | `{businesses}` across the current user's permitted agency/client grants |
| GET `/businesses/:businessId` | `{business}` with metadata and effective agency/business roles; foreign/inactive 404 |
| PATCH `/businesses/:businessId` | Metadata fields above only; owner/admin or editor. Identity, plan, bot ID, disable and ownership fields are rejected. |
| GET `/businesses/:businessId/members` | Owner/admin; `{members:[{user_id,role,grant_kind,name,email}]}` |
| PUT `/businesses/:businessId/members/:userId` | Owner/admin; `{role:"viewer"|"editor"}`; target must already be verified/active; idempotent upsert |
| DELETE `/businesses/:businessId/members/:userId` | Owner/admin; revoke explicit grant, `{success:true}` |

`industry`: construction/web_agency/real_estate/healthcare/law_firm/other. Email is business contact metadata, never ownership proof. New business access does not authorize unrelated legacy lead, knowledge or billing endpoints. Follow-up resource APIs must call `agencyAccess`/`businessAccess` with the current account identity and bind resource queries to that business.

## Environment and Next.js integration

Enable only after migrations and staging:

- `ACCOUNT_AUTH_ENABLED=true` (otherwise new account routes return 503; legacy APIs continue).
- `ACCOUNT_AUTH_URL`: explicit external HTTP(S) origin, no path; HTTPS required in production. Base path is `/api/account`.
- `ACCOUNT_PROXY_MODE=trusted` plus `TRUSTED_PROXY_CIDRS`: exact IPs/CIDRs of the actual platform ingress/proxy chain. Configure from verified platform/network topology; no production CIDRs are guessed or changed here. The ingress must sanitize forwarding headers. Blanket trust, numeric hop counts, named broad ranges and /0 networks are rejected. Express scans the forwarded chain from the trusted socket to the nearest untrusted peer, so distinct clients retain distinct authentication quotas.
- `ACCOUNT_PROXY_MODE=direct`: explicit alternative only for a server actually receiving client connections directly; leave `TRUSTED_PROXY_CIDRS` empty. Production account auth fails closed unless one of these modes is selected. Legacy default remains no proxy trust when nothing is configured. Stage and verify client IPs before enabling behind Render/another HTTPS proxy; do not use direct mode to bypass a missing topology configuration.
- `ACCOUNT_AUTH_SECRET`: new random secret of at least 32 characters, kept server-side and separate from legacy JWT/admin credentials. Use secret-manager rotation planning; do not commit real values.
- `ACCOUNT_TRUSTED_ORIGINS`: comma-separated exact origins, dashboard first, including the account base origin. No wildcard or HTTP production origins.
- `DASHBOARD_ALLOWED_ORIGINS`: existing CORS exact trust must also permit the dashboard origin. This is not broadened automatically from widget origins.
- Existing `DATABASE_URL`, `REDIS_URL`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `RESEND_FROM_NAME`: use reviewed server configuration; no credentials changed here. Identity email errors fail rather than being silently skipped.
- Node **22.18+**, with Node 24 matching CI recommended. Existing Render blueprint's Node 20 setting is not changed/deployed by this task and must be reviewed before enabling this code.

Prefer a same-origin Next.js BFF/reverse proxy for `/api/account` and `/api/v1`. Forward the original method, body, cookies and trusted Origin, and return Set-Cookie intact (including multiple headers). Set the auth URL to the external BFF origin and explicitly trust it. Use server components/BFF for session reads; never put secrets/admin keys or session tokens in client bundles/localStorage. Native Better Auth clients should use `basePath:'/api/account'` and the organization client plugin. Login may return library token fields; rely on the cookie, not persistent JavaScript token storage.

Cookies are host-only, HttpOnly, SameSite=Lax, Secure in production, expire after seven days, and use the library's refresh/revocation mechanisms. Cookie caching is disabled; PostgreSQL session/user status is checked live. Mutating versioned operations have explicit Origin/JSON checks; Better Auth CSRF/origin checks remain enabled. GET email verification is token-authorized. No bearer plugin or OAuth provider is enabled. IP quotas run before account requests; verified-user quotas isolate versioned operations. Missing Redis quota infrastructure fails closed. The auth handler and versioned identity middleware overwrite their internal IP header from the configured Express req.ip, so caller-controlled forwarded headers cannot choose library quota identity.

## Migration generation and release checks

Generation command (temporary pinned CLI, no CLI runtime dependency):

`npm exec --yes --package=auth@1.7.10 -- auth generate --config ./scripts/auth-schema.config.js --output /tmp/chatflow-auth-generated.sql --yes`

The generation config presents an empty schema for metadata introspection through a disconnected pg.Pool. It never executes SQL, loads .env or opens a production connection. The CLI's expected missing-table notice describes this empty schema. 008 retains generated columns/indexes inside a transaction/ledger wrapper; 009 adds application invariants. Versions are recorded in `chatflow_schema_migrations`; a transaction advisory lock serializes 008/009 application. Do not run generic `auth migrate` against production, or regenerate over reviewed historical SQL.

Staging must confirm migrations on an actual sanitized customer-like copy, table-name drift/collisions, existing Bubble uniqueness, row counts and bot/session/message/knowledge/lead preservation. DDL/index builds and owner-trigger organization locks require bounded timeouts and concurrency testing. Runtime roles need grants on new tables/sequences and permission for trigger queries; use non-superuser staging verification. Guard against direct schema access by application clients. Review backup/restore and point-in-time recovery, email delivery/domain alignment, trusted origin/proxy/IP handling, Secure cookies on HTTPS, reset/invitation links and session revocation across web replicas.

Existing 005/006/007 prerequisites and the separate-container temporary-file upload blocker remain. No staging or production migrations/deployment are claimed. Application rollback disables the new API surfaces and retains new tables/data and nullable Bubble IDs; never drop users, memberships, businesses or old revision/domain protections to roll back.

## Next milestone

Multi-Agent Foundation: introduce explicit agent identity/configuration/ownership underneath each permitted business, with resource authorization and tenant-coupled foreign keys, agent-specific knowledge/cache scope, public widget routing and negative isolation tests. Preserve business UUIDs and the current single configuration until a reviewed migration maps it to an initial agent. Do not mix channel integrations or dashboard UI into that schema PR.

## Executed verification

The clean dependency installation (`npm ci --ignore-scripts --no-audit --no-fund`), `npm ls --depth=0`, JavaScript syntax and whitespace checks passed. No lint script is configured. Local tests passed 118 tests, failed 0 and explicitly skipped the two PostgreSQL root suites because no usable local PostgreSQL server was available.

The first Phase 2 run exposed the test fixture's use of one IP across multiple rapid registrations, hitting the unchanged native library sign-in throttle. Fixtures now reset only their own disposable-schema quota rows between independent scenarios; an explicit test confirms the native 429 behavior remains enabled. Commit c0645c74 passed **130/130 tests, 0 failures, 0 skips** in [PostgreSQL 16 + pgvector CI](https://github.com/Umer1299/chatbot-backend/actions/runs/38991479394). Final latest-commit totals/review status are maintained on PR #145, including later session-revocation regression coverage.

The database suite uses real Better Auth HTTP flows with captured test email delivery, not live Resend, and isolated random schemas in the explicitly named loopback test database. It exercises verification/reset tokens, sessions and role/invitation/agency/client boundaries, concurrent ownership/grants and 008/009 replay with retained legacy rows. This is not staging or production validation. No production migrations, credentials, data or deployment were changed.

Implementation references: [Express integration](https://better-auth.com/docs/integrations/express), [PostgreSQL adapter/schema generation](https://better-auth.com/docs/adapters/postgresql), [organization plugin](https://better-auth.com/docs/plugins/organization), [email flows](https://better-auth.com/docs/concepts/email). The pinned installed package and generated SQL are the implementation authority; review API/schema changes before upgrading.

The fresh Phase 2 review identified shared proxy-IP quotas as a P1 issue. The correction adds explicit bounded CIDR trust before all quota middleware and an explicit production proxy-mode requirement, with tests for distinct forwarded clients, the nearest untrusted boundary, direct-peer spoofing, and the real library throttle behind a trusted ingress. Actual production proxy CIDRs/header sanitation still require staging validation; no live values were set. See [Express proxy guidance](https://expressjs.com/en/guide/behind-proxies/).

### Temporary upload reconciliation (review follow-up)

The review also identified unaccepted uploads orphaned after queue errors. Owner file uploads now perform a bounded, read-only queue preflight before staging bytes. After an actual enqueue rejection, the deterministic job ID and terminal polling state distinguish confirmed acceptance (HTTP 200 queued acceptance), confirmed rejection (HTTP 503 and immediate source cleanup) and uncertain acceptance (HTTP 503 with pollable job IDs, source retained). Only read operations have a three-second deadline; a pending enqueue is never timed out and incorrectly treated as rejected.

New sources use a private `chatflow-upload-staging` temporary directory and job-ID filenames, with exclusive 0600 file creation. An API janitor runs at startup and every ten minutes, rotating over at most 100 aged candidates per scan. After a one-hour grace it deletes only app-managed regular files whose job is confirmed absent from BullMQ; active/delayed/retrying jobs and unavailable queue state are preserved. Current-process staging/enqueues are held against cleanup until settled. Queue outages block new staging, and healthy scans later reconcile abandoned sources. Symlinks, unrelated files and legacy temporary names are never swept. This is source-file cleanup, never customer knowledge deletion.

This local janitor assumes one API staging/cleanup process per staging directory. Do not share that directory across multiple API processes without coordinated leases. A file worker can consume the same path but does not run the janitor. Capacity/retention monitoring, legacy orphan handling and actual web-to-worker file handoff remain staging/deployment requirements. This is not an object-storage or distributed-upload redesign, and separate-container production deployment remains blocked.

Multi-file enqueue failures return HTTP 503 with `success:false`, `partial:true` and ordered `jobIds` for the already accepted files. Earlier source files/jobs continue untouched; only a proven rejected source is removed. This also applies when a later preflight, file write or status write fails. Clients must poll the returned accepted IDs and retry only the remaining files, rather than resubmitting the entire upload. Truly ambiguous acknowledgements retain their existing `acceptanceUnknown:true` response and pollable IDs.
