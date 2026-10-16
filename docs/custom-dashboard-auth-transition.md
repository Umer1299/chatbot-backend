# Custom dashboard authentication transition

Decision: the future dashboard is Next.js/React/TypeScript with the existing Express API, PostgreSQL/pgvector and Redis/BullMQ. Bubble is a legacy integration, not a new identity provider. This PR does not build login, agency membership, multiple agents or channel integrations.

## Legacy dependencies retained for compatibility

| Location | Current dependency | Transition |
| --- | --- | --- |
| `src/api/auth.js` | Private `/api/auth/token` bridge accepts `bubbleUserId`; provisions one business per Bubble user and signs a business-subject JWT. | Keep server-to-server only. A future custom login must never call this bridge with an arbitrary ID or expose `ADMIN_API_KEY` in browser code. Add a separate verified user/session login path in the next PR. |
| `src/middleware/jwtAuth.js` | Validates legacy `bubbleUserId` against `businesses.bubble_user_id`; JWT `sub` is a business UUID. | Keep checks for existing tokens. Introduce a separately versioned user-subject token/session contract; never reinterpret an old business subject as a user ID. |
| `001_initial_schema.sql`, `businesses` | Unique, non-null `bubble_user_id`; unique `bot_id`; unique `bot_configs.business_id` enforces one configuration per business. | Add an external-identity mapping and ownership/membership tables before relaxing legacy constraints. No fabricated Bubble IDs for new users. Preserve existing business UUIDs, records and public bot IDs. |
| `src/api/chat.js` | Optional lead mirroring via `BUBBLE_API_URL` / `BUBBLE_API_KEY`. | Keep as an optional legacy CRM export until existing users migrate. Identity/permissions must not depend on export success. Later replace with a generic integration adapter. |
| `src/tools/leadCaptureTool.js`, `src/routes/lead.js` | Global Bubble webhook, protected by server admin key. | Retain temporarily; do not expose as the custom dashboard's tenant-aware lead endpoint. Use the existing scoped lead API. |
| `src/app.js` | Billing redirect supports `BUBBLE_APP_URL` and `FRONTEND_URL`. | Use `FRONTEND_URL` for the coded frontend; configure/remove the legacy redirect override during a reviewed cutover. No environment values were changed here. |
| `src/services/emailService.js` | Dashboard links use `BUBBLE_APP_URL` / `BUBBLE_API_URL`; `EMAIL_BUTTON_URL` is an existing explicit override. | Move links to a generic dashboard URL as part of frontend cutover; preserve legacy recipients/URLs until then. |
| `src/api/business.js`, migration 003 | Disable provenance defaults to `bubble`; DB enum allows `bubble` / `admin`. | Later add neutral actor/user provenance with a reviewed additive migration; do not label new custom users as Bubble users. |
| `src/agents/registerSaasSoftware.js` | “Bubble” appears as a service-detection keyword. | Content taxonomy, not an authentication/infrastructure dependency. No removal needed. |

## Recommended model for the next PR

- `users(id, status, ...)` is an independent identity. `external_identities(user_id, provider, provider_subject)` maps verified legacy/provider identities with a unique `(provider, provider_subject)` key. Never link accounts from an unverified email match or a browser-supplied legacy ID.
- `auth_sessions(id, user_id, expires_at, revoked_at, refresh_family, ...)` supports revocation, rotation and theft detection. Prefer an established OIDC provider or reviewed authentication library. Do not design password reset/MFA yourself; use authorization code + PKCE, state and nonce validation where applicable.
- Use a same-origin Next.js BFF or Secure, HttpOnly, SameSite cookies. Apply CSRF protection to cookie-authenticated mutations, strict allowed origins, and session rotation. Keep secrets/refresh credentials out of localStorage and client bundles. If bearer access tokens are needed, keep them short-lived, validate algorithm/issuer/audience and bind them to a revocable session ID.
- `agencies`, `agency_memberships(agency_id,user_id,role,status)`, `businesses.agency_id` and `business_memberships(business_id,user_id,role,status)` establish explicit authorization. Owner/admin/staff and client roles need a permission matrix; client access to one business must not imply agency-wide access.
- `agents(id,business_id,...)` gives each client multiple agents; configuration, knowledge sources, channels, conversations, leads, integration credentials and usage must carry the required business/agent identifiers. Client-supplied IDs select resources only after membership checks. Use tenant-coupled foreign keys where possible.
- Authorize from current membership and resource ownership on every request. JWT role/plan/agency claims are hints, not the source of truth. Add PostgreSQL RLS as defense in depth only after connection-pool tenant context and reset behavior are tested.
- Separate quotas by verified user/session and business/agency budgets; aggregate billing by owned resources. Public widget tokens grant only public chat capabilities. Server admin credentials must not become dashboard credentials.

## Safe cutover sequence

1. Merge and stage this security work; retain the legacy bridge and current business-scoped JWT verification. Current management quotas use that verified business identity across IPs/token refreshes, not raw headers.
2. Add user/session authentication with an explicit token version/audience and new middleware. Keep legacy endpoints distinct with a documented retirement path. No broad acceptance of arbitrary JWT shapes.
3. Link existing businesses through verified external identities or an audited ownership transfer. Backfill memberships without changing customer UUIDs or inferring ownership from email alone.
4. Add agency/business role boundaries and negative authorization tests, then multiple agents and scoped knowledge. The RAG business revision introduced here is intentionally a business boundary; agent-specific knowledge needs agent scope in the next cache design.
5. Cut over the coded dashboard, email/billing links and client APIs in staging. Revoke old sessions/tokens and retire the bridge only when active legacy consumers and export integrations have been accounted for.

No custom dashboard, new authentication provider, or Bubble dependency was introduced by this PR.
