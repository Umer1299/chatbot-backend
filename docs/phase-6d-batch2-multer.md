# Phase 6D Batch 2: Multer and legacy upload boundaries

This draft is stacked on PR #148 (`7306ba7c15ffa4a4c549d1bdb508a9254942538c`). It does not change the Batch 1 proxy-addr, protobufjs or gRPC resolutions. No deployment or migration is part of this change.

## Advisory and dependency scope

`multer@1.4.5-lts.2` is affected by [GHSA-535w-7cp7-47q4](https://github.com/advisories/GHSA-535w-7cp7-47q4) (`<2.3.0`, high severity). The crafted `items[4294967294]` and `items[key]` field sequence can exhaust CPU through sparse-array conversion. The first patched release is `2.3.0`, which adds `limits.fieldArrayIndexLimit`; set to `0` because neither route accepts numbered form fields. A live audit identified [GHSA-3pph-fpjx-jg34](https://github.com/advisories/GHSA-3pph-fpjx-jg34) (orphaned writes on aborted uploads, fixed in 2.4.0) and [GHSA-q7qp-rjg7-q26m](https://github.com/advisories/GHSA-q7qp-rjg7-q26m) (crash with asynchronous file filters, fixed in 2.5.0). The direct dependency is therefore pinned at `2.5.0`. Its dependency graph removes `concat-stream`, `buffer-from`, `typedarray`, `mkdirp` and `minimist`; no unrelated installed package version changes. Multer 2.x retains `.array()`, `.single()`, `memoryStorage()`, and the file properties used by the queue.

The advisory previously did not appear in npm audit JSON; absence from that report alone is not evidence of remediation. The upstream patched range and request-level array-index regression are both required.

## Request order and limits

The public `/api/upsert` and `/api/scrape/supplement/file` paths first pass app-level `requireAuth` (JWT verified against the current business DB row) and `dashboardLimiter` (120 per minute per verified business). `/api/upsert` then runs `requireKnowledgeOwner` to derive the namespace from the authenticated business and reject a missing bot; the staging gate precedes multipart parsing. The scrape file route repeats `requireAuth` (cached verification on the same request) and applies the staging gate. Both use in-memory Multer storage only after those checks. JWT and ownership rejection do not enqueue work or store files.

| Endpoint | Form contract | Limits | Result |
| --- | --- | --- | --- |
| `POST /api/upsert` | Optional `text`, up to three `files` | 50 MiB per file; 3 files; 1 text field; 5-part Busboy sentinel limit (four permitted); 32-byte field name; 100 KiB text field; index 0 | Text chunks or queued file IDs; uploaded file bytes are written to the existing private temporary directory before enqueue. |
| `POST /api/scrape/supplement/file` | One `file`, no fields | 5 MiB file; 1 file; 0 fields; 2-part Busboy sentinel limit (one permitted); 32-byte field name; 100 KiB field value ceiling; index 0 | Text is processed in the API; no worker job or temporary file. PDF/DOCX remain unsupported. |

Busboy emits its part-limit event *upon reaching* the configured count, hence one sentinel above the permitted number. Multer returns bounded 400 errors for file/field/count/index violations and 413 for file size. Invalid boundaries are 400. `memoryStorage` retains the existing 150 MiB worst-case per `/api/upsert` request (three 50 MiB files), with a separate per-business rate limit; this is bounded but concurrent authorized uploads can still create material memory pressure. Ingress body/concurrency limits should be verified in staging before allowing files. The regression suite verifies the app remains responsive and creates no jobs after a malformed/aborted request.

The existing `stageUpload` writes the original buffer to a private file with exclusive creation and a job-ID name. The worker receives `{ namespace, businessId, filePath, originalName, mimeType, jobId }`; those keys and cleanup/acknowledgement behavior are unchanged. Integration tests inspect the on-disk bytes and payload, plus existing worker retry and orphan cleanup tests. They do not establish an API-to-worker cross-container handoff.

## Text-only staging isolation

The isolated staging blueprint and `.env.staging.example` explicitly set `STAGING_DISABLE_LEGACY_FILE_UPLOADS=true`. The route gate blocks multipart `/api/upsert` (including the trailing-slash alias) and `/api/scrape/supplement/file` before Multer whenever either `CHATFLOW_ENVIRONMENT=isolated-staging` or the upload-disable flag is true. Missing/invalid flag values cannot re-enable uploads in an explicitly isolated staging environment. JSON text knowledge on `/api/upsert` and `/api/v1/.../knowledge` remains available for the two-agent demonstration. `AGENT_WEBSITE_ENABLED=false` alone does not block legacy uploads. The independent staging blueprint has not been applied; confirm the environment marker, flag, and ingress paths on the actual staging service before lifting its upload blocker. The API-to-worker durable file handoff also remains unproven, so legacy file uploads must stay blocked in the separate-container staging topology.

## Verification and outstanding work

The stacked PR's authorization CI uses isolated PostgreSQL 16/pgvector and Redis 7 fixtures. The separate Batch 2 audit job pins Node 24.21.0, verifies ancestry and dependency versions, runs `npm ci --ignore-scripts`, preserves exit statuses, validates four JSON reports with the existing sanitizer, checks zero critical advisories, and publishes only sanitized evidence for one day. Before/after totals and exact CI URLs are recorded in the PR after completion. All remaining high and moderate advisories are outside this narrow batch. Production Redis, PostgreSQL TLS, HTTPS authentication, migrations, and the cross-container file handoff require separate review before deployment.
