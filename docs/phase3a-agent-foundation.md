# Phase 3A — agent management foundation

This phase adds management records only. It does not route public traffic to agents, deploy channels, share knowledge with new agents, or change existing bot behavior. `active` in the new tables means management readiness, not a live deployment. Phase 3B must add separately authorized runtime activation.

## Audit and mapping

| Existing resource | Current owner/routing | Phase 3A treatment |
|---|---|---|
| businesses.bot_id | Unique public legacy bot identifier per business | Unchanged; mapped to one new draft agent by migration 010 |
| bot_configs | At most one config per business (unique constraint retained) | Remains live source; never replaced by agent_configs |
| sessions / messages | Business-scoped sessions; messages tied to sessions | Existing messages.agent_id is a legacy text phase label, not the new UUID identity; history preserved |
| knowledge_chunks | Business-scoped chunks; bot namespace resolves business | No import/sharing with newly created agents |
| leads / inquiries | Business-scoped records, scoped session references where present | No ownership rewrite |
| Widget JWT / domain settings | Legacy bot identity + durable business domain-policy revisions | Tokens, expiry, durable policy and public JSON/SSE unchanged |
| Retrieval cache | Business UUID + durable knowledge revision + query/limit hash | Existing business keys/triggers unchanged |
| Legacy management | Business JWT ownership bridge | Preserved; never accepted by agent APIs |
| Phase 2 management | Better Auth user → agency role or explicit business grant | Reused for every agent endpoint |

Migration 010 creates a draft agent and empty draft configuration for each business present at migration time. `legacy_agent_mappings` couples its business, existing bot ID and agent ID through foreign keys. The source configuration remains verbatim in bot_configs, including any historical unsupported settings. No settings are silently coerced, no public identifiers change, no Bubble identity is invented, and no agency access is inferred. A future explicit import must validate legacy settings before activating the mapped agent. Businesses created after the migration start with no agents until an authorized create request; migration replay does not add duplicates or change this rule.

## Schema and invariants

`agents`: UUID primary key, immutable business UUID and opaque unique public UUID, name, description, purpose, lifecycle (`draft`, `active`, `paused`, `archived`), timestamps. Index `(business_id,created_at,id)` supports business listing. Names need not be unique. Public UUID is an identifier, not a credential or usable runtime route in this phase.

`agent_configs`: exactly one independently created configuration per API-created/backfilled agent, tenant-coupled `(agent_id,business_id)` foreign key, optimistic integer version starting at 1, draft/active readiness, prompt, welcome, starter prompts, nullable provider/model for drafts, temperature, generation settings, selected capabilities, lead-capture and escalation settings. The API uses full replacement with explicit expected version; successful saves increment once. Concurrent saves of the same version yield one success and one 409. This is the current configuration plus version counter, not a revision-history/audit-log implementation. Config changes never activate an agent; saving a draft config pauses an active management agent. Archival is non-destructive and terminal in this API; archived metadata/config remains readable according to permissions but cannot be edited or restored.

Settings are strictly allowlisted and bounded. Models must exist, match the requested provider and currently be active in model_configs; no fallback silently accepts unknown models. Temperature is 0–2 for OpenAI, 0–1 for Anthropic, max output tokens 1–8192 and top_p 0–1. Phase 3B must additionally validate runtime model-specific token/features against the deployed provider adapter before use. Capabilities currently describe lead_capture/human_escalation only. They do not grant database, integration, credential or execution permissions. No provider keys, arbitrary tool definitions, webhook URLs or authorization claims are accepted. Future credentials must live in encrypted server-managed bindings, never this JSON.

Immutable identity/terminal archival are also database-trigger protected. Configuration model references and mapping ownership use foreign keys. JSON shape and core lifecycle/version constraints are checked in PostgreSQL; detailed supported settings are validated at the management API boundary. The application database role must be restricted from arbitrary direct writes; direct SQL is not an alternative configuration API.

## Ownership and API contracts

All routes are beneath `/api/v1/businesses/:businessId/agents`, after the existing Better Auth session, mutation-origin/JSON checks and per-user quota. A legacy business JWT is not a user session. Business must be active and authorized through Phase 2. Agency owners/admins manage all its agents; an explicitly granted business editor can manage that business; viewers read agent metadata only. Unrelated users and agent substitutions return generic 404. Viewers get 403 for configuration access. Neither client-supplied IDs nor configuration fields establish authority.

| Method / suffix | Contract |
|---|---|
| POST `/` | `{name,description?,purpose?,status?}` → 201 `{agent}`; default draft, cannot start active |
| GET `/` | `{agents:[...]}` including archived records, ordered by creation/ID |
| GET `/:agentId` | `{agent}` |
| PATCH `/:agentId` | Non-empty subset of name/description/purpose/status → `{agent}`; no identity moves; status active requires active valid config; status archived archives |
| GET `/:agentId/config` | Editors/managers only → `{config}` |
| PUT `/:agentId/config` | Full validated config plus `expected_version` → `{config}`; stale version/archived state 409 |

Full config body: `expected_version,status,system_prompt,welcome_message,starter_prompts,provider,model_id,temperature,generation_settings,capabilities,lead_capture:{enabled,fields},escalation:{enabled,message?}`. Unknown fields are rejected 400, as are unsupported/inactive models. API JSON uses snake_case matching the backend's existing record conventions. No DELETE endpoint is provided; PATCH status archived is the deletion contract. Collections are currently unpaginated, consistent with Phase 2; pagination/quotas should precede high-volume onboarding.

Mutations lock the organization first, lock the business, recheck current authorization, then lock the agent. This follows Phase 2's member/grant lock order and serializes grant revocation with writes. Creation and its independent config commit together. Config saves lock the agent and use a version predicate; activation and archival use the same lock so a config save cannot revive an archived agent. SQL is parameterized; dynamic field names come exclusively from the validated whitelist.

## Migration, rollout and rollback

Apply existing 005 → 006 → 007 → 008 → 009, then **010_agent_foundation.sql** in staging first. It is transactional and uses the existing advisory migration lock and ledger. 009 is required; rerunning 010 is idempotent. It adds tables/indexes and a `(id,bot_id)` uniqueness constraint on businesses; it never rewrites existing customer resources. The redundant unique business index requires a lock/scan on the existing business table and legacy backfill writes one agent/config/mapping per business. Measure size, lock wait and duration in staging, take/restore a backup, and schedule an appropriate maintenance window. Do not execute production migrations as part of this PR.

Verify before/after exact business/bot IDs, config counts/content, session/message/knowledge/lead/inquiry counts, domain restrictions and knowledge revisions. Verify mapping count equals the migration-time business count, all mapped agents are draft, legacy widgets still return JSON/SSE, grants and concurrent saves behave correctly, and migration replay preserves rows. No staging/production validation is claimed by disposable CI tests.

Rollback application routes to the previous build first; retain new tables and all newly authored data. Legacy runtime does not depend on them. Do not drop tables to roll back after customer use. A future schema rollback must export new agent/config/mapping records and inspect dependent foreign keys/triggers before an explicitly reviewed migration. Do not roll back 009 to NOT NULL Bubble IDs after custom businesses exist.

Production prerequisites from prior phases remain: validated migrations/backup restore, Node >=22.18 (CI uses 24; existing Render blueprint still needs an explicit runtime rollout), exact HTTPS origins/session cookies, sanitized trusted proxy configuration, verified email delivery, durable domain settings and Redis configuration, and a real API-to-worker upload handoff test in the actual topology. Separate containers using local temporary files remain a deployment blocker; one API cleanup owner per staging directory is required. This phase does not redesign object storage.

## Phase 3B — required runtime isolation

1. Add nullable agent ownership to knowledge sources/chunks and sessions, with tenant-coupled foreign keys. Explicitly map historical records only to each business's legacy mapped agent; verify counts and retain old business/bot identifiers throughout dual-read rollout. Messages inherit agent scope through a tenant-coupled session link; leads/inquiries must couple to the same agent/session. Add indexes before enabling filters and validate historical constraints after reconciliation, never guess ownership.
2. Introduce durable **per-agent** knowledge revisions and cache keys containing business UUID, agent UUID and revision. Scope ingestion, source replacement, deletion and retrieval together; never partly switch cache keys or retrieval filters. The existing messages.agent_id text column and agents_used labels must not be reinterpreted as new UUIDs; add a distinct, explicit ownership column or a separately reviewed rename/backfill. Newly created agents start with no knowledge. Sharing, if later supported, requires an explicit authorized resource relation.
3. Add channel deployments separately from core agents: a deployment references `(agent_id,business_id)`, has a channel, lifecycle, durable domain/channel policy and rotatable scoped public credentials. Agent ID alone grants no public access. Website/hosted chat, WhatsApp and voice reuse agent identity/config through separate deployments. Server-managed encrypted integration/credential bindings require explicit business/agent permissions; config cannot manufacture these grants.
4. Route public chat securely to deployment + agent; validate business/agent/config/deployment readiness and domain/token policy before side effects. Support independent activation/pause without changing sibling agents or bypassing legacy disabled responses. Keep legacy routing until explicit opt-in and compatibility verification.
5. Usage/billing events must carry immutable business, agent, deployment and operation/idempotency identity; billable ownership is server derived. Leads/inquiries/inbox queries must scope business and agent consistently.
6. Prove end-to-end with two agents in one business: distinct config/knowledge/cache, separate conversations/leads, token substitution rejection, independent activation and unchanged legacy JSON/SSE. Add migrations/backfill verification and concurrent ingestion/routing tests before enabling new deployments.

No Next.js dashboard, agency hierarchy redesign, channel integration or provider credential storage is implemented here. Independent user/agency identity is already the Phase 2 foundation; subsequent work should build Phase 3B on those sessions and memberships.
