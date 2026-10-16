# Security migration readiness and rollout

Scope: migrations 005, 006 and the cache fix's additive migration 007. No production migrations, deployments, credentials or customer-data cleanup are part of this work.

## Ordering and integrity

Run pending migrations in filename order against an already baselined schema: 005 → 006 → 007. The existing runner replays all historical files and lacks a migration ledger; do not use it just to apply these changes. The two 003 files sort deterministically but should receive a ledger/unique sequence in a later infrastructure PR.

| Migration | Compatibility and retained data | Locks / staging checks |
| --- | --- | --- |
| 005 | Adds nullable `leads.assigned_to`; unique `(sessions.id,business_id)` index is compatible with existing globally unique `sessions.id`. Adds message tenant FK and non-null checks as `NOT VALID`, retaining old null/mismatched rows while enforcing new/updated rows. No deletion/reassignment. | Transactional DDL and non-concurrent index builds can block writers; `ALTER TABLE` needs strong locks. Inspect counts and existing definitions first. Schedule a window, set a short session `lock_timeout` and suitable `statement_timeout`; retry the whole file after failure. Large deployments may need separately reviewed concurrent index builds outside its transaction. |
| 006 | New `chatbot_settings` table stores JSON domain policies, a random revision and a deletion tombstone. No automatic runtime DDL or inference of unrestricted policy from a missing row. Existing rows survive reruns. | `CREATE TABLE IF NOT EXISTS` does not repair an incompatible pre-existing table. Verify column types, constraints and privileges. Policy import reads surviving legacy Redis settings and uses insert-if-absent; expired policies require explicit recovery/re-entry. |
| 007 | Adds `businesses.knowledge_revision BIGINT NOT NULL DEFAULT 0`. Statement-level INSERT/UPDATE/DELETE triggers on `knowledge_chunks` increment each affected business's revision in the same transaction, including tenant moves. Partial committed mutations advance revision; rolled-back mutations do not. No chunk deletion/backfill. | PostgreSQL 11+ fast constant defaults avoid a volatile UUID backfill; validate the actual production major version. Adding the column/trigger definitions takes table locks. Writes serialize revision updates per business; measure bulk uploads and concurrent writers. Do not disable triggers or use `TRUNCATE` as a cache invalidation path. |

The new generation scheme reads revisions from the PostgreSQL primary, not a lagging replica. Old `rag:<namespace>:...` and old revision keys are never read and expire naturally after their existing TTL. No RAG `KEYS`/mass deletion is required. The full query and retrieval limit are hashed; no visitor text is embedded in new cache keys. A request whose authorization/revision read predates a concurrent mutation may already be in flight; subsequent requests after a successful commit observe the new generation.

## Preflight and release prerequisites

1. Back up the database and preserve surviving legacy bot settings before their Redis TTLs expire. Run `docs/security-schema-preflight.sql` and compare the live schema, constraints and indexes with migration definitions. Ensure a tested restore procedure and appropriate migration-role DDL/function permissions; the runtime role needs knowledge writes and permission to update business revisions through the trigger (the function is deliberately not `SECURITY DEFINER`).
2. In an isolated staging copy, apply only pending 005/006/007 with `ON_ERROR_STOP=1`. Run read-only preflight first, set bounded lock/statement timeouts on the migration connection, and check invalid indexes/partially applied files if a previous attempt failed. 005 and 007 are transactional; 006 is a single atomic statement.
3. Import/re-save all intended domain policies through the authenticated admin API while legacy settings still exist. Admin listing and settings/widget reads promote surviving legacy rows; confirm durable policies match intended domains before traffic cutover. Missing/corrupt policy returns an error, never an empty allowlist. Keep explicit `[]` only for intentionally unrestricted bots.
4. Verify all writer processes use the new database revision mechanism. Deploy backend/worker code only after migrations are installed. Old writers using normal INSERT/UPDATE/DELETE still fire the triggers; old **readers** still using namespace RAG caches must be drained/replaced for deletion guarantees. Do not run mixed old/new retrieval code indefinitely.
5. Stage the legacy bridge caller changes from PR #145 and test public JSON/SSE chat, previews, owner uploads, deletion, re-scrapes, domain restrictions, and authenticated quota sharing. The upcoming dashboard uses custom authentication as described in `custom-dashboard-auth-transition.md`; it must not put the legacy admin key into the browser.
6. Quarantine/repair historical inconsistent records only through a separate approved data change. Then explicitly validate 005's three constraints. This PR does not perform customer-data cleanup or validate away pre-existing violations.

## Rollback

Prefer forward fixes. Never roll back to the original public token issuance or widget management permissions. Keep the additive tables/columns/indexes and valid domain policies during an application rollback. The hardened previous branch uses durable domains but has the old RAG-cache mismatch; returning to that reader loses deletion guarantees. If rollback is necessary, disable/bypass RAG caching or apply the revision-aware reader patch and stage deletion tests first. Keep the database trigger active for every writer while any revision-aware readers run.

Do not reset knowledge revisions or reuse a deleted business identifier: that could revive old cache generations. Do not drop `chatbot_settings` tombstones or reconstruct policies from stale cache during rollback. Stop/drain incompatible readers/writers before considering any later schema reversal; no destructive rollback SQL is included.

## Integration verification

`test/migrations.integration.test.js` uses only `TEST_DATABASE_URL`, requires a loopback host and the exact database name `chatflow_security_test`, and creates a random private schema. It never reads `DATABASE_URL` or `.env`, and cleans up only its own test schema. CI supplies a disposable PostgreSQL 16 + pgvector service with dummy credentials.

The suite applies the real baseline SQL, inserts historical mismatched/null fixtures, and runs 005/006/007. It checks new write constraints, retained history, domain policy validation/tombstones, revision triggers for bulk writes/tenant moves/rollback, real pgvector retrieval with stale Redis entries, upload/replacement/deletion, and repeat application without data loss. Local runs without that dedicated test database skip this suite explicitly. CI results must be checked before merging.

Still requiring production-like staging validation: database size/DDL lock timing, existing schema drift, actual application-role permissions, backup/restore, domain import completeness, replica routing, concurrent workload behavior and the complete external frontend/integration flow. Passing disposable-database tests does not replace these operational checks.

## Final hardening runtime check

No additional migration was required for transactional replacement, supplemental error propagation, CORS or removal of global SQL patches. Re-check that the runtime role can lock its business row and update knowledge/revisions. Website replacement prepares embeddings outside the transaction, then holds a business-row lock through source replacement and commit; measure this window with realistic chunk counts in staging. Confirm failed replacements roll back the previous source and its revision, while confirmed supplemental partial commits remain retrievable and retryable. The CI database suite covers these correctness cases; it does not establish production lock timing.

See `pr145-final-hardening.md` for CORS trust configuration, file-storage handoff constraints and all remaining release prerequisites.
