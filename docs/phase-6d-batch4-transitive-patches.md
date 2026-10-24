# Phase 6D Batch 4 — compatible transitive security patches

Baseline: reviewed Phase 6E commit `5ddd4f9e4451564f744295c613c4266f0787b15f`. This is a lockfile-only change; `package.json` and application code are unchanged. No Batch 4 update authorizes a merge, deployment, migration, file upload or website-agent activation.

| Package (all resolved copies) | Old → new | Parent range and observed path | Security and application reachability |
| --- | --- | --- | --- |
| `js-yaml` | 4.1.1 → 4.3.2 | `@langchain/community@0.3.59 → js-yaml` and `langchain@0.3.37 → js-yaml`, both `^4.1.0` | Clears merge-alias and ordered-map CPU advisories. Backend imports PDF/CSV LangChain loaders, not a YAML loader; untrusted YAML parsing via application code is not demonstrated. Bounded YAML parser fixtures exercise valid documents, alias merges, malformed tags and nesting. |
| `undici` | 7.25.0 → 7.30.1 | `cheerio@1.2.0 → undici`, `^7.19.0`; Node requirement `>=20.18.1` | Backend uses `cheerio.load` for direct HTML parsing, not Cheerio's `fromURL`. Cheerio exports a `fromURL` path that internally creates an Undici client; no application call to it was found. Phase 6E's direct `http`/`https` destination validation, DNS pinning, redirect, deadline and response-size enforcement remains intact. Dependency update alone does not prove arbitrary SSRF safety. |
| `ws` | 8.20.0 → 8.21.0 | `@langchain/community` peer `^8.14.2`, `@browserbasehq/stagehand@1.14.0` dependency `^8.18.0`, OpenAI SDK optional peer `^8.18.0` | Clears memory-disclosure and fragmentation-memory advisories. The backend does not register a WebSocket endpoint or use OpenAI realtime/Stagehand at runtime. Controlled Receiver fixtures cover valid, malformed, oversized and many-fragment frames; SDK construction/module import requires no provider call. |

The verified lockfile has one top-level copy of each target and no vulnerable nested copies. All previously patched `ipaddr.js@1.9.1`, Multer 2.5.0, proxy-addr 2.0.8, protobufjs 7.6.6, gRPC 1.14.6, body-parser 1.20.9, express-rate-limit 8.6.0, ip-address 10.7.4, follow-redirects 1.16.1, xmldom 0.8.15 and form-data 4.0.6 remain unchanged. The lockfile diff is limited to target versions, registry integrity fields and js-yaml funding metadata. No override, direct dependency or major version was introduced.

## Advisory evidence

On the same local npm advisory feed, full package-record totals changed **0 critical / 14 high / 9 moderate / 0 low → 0 / 11 / 9 / 0**; production changed **0 / 13 / 9 / 0 → 0 / 10 / 9 / 0**. Only the three target package records disappeared, no new records appeared, and unchanged inherited LangChain/Stagehand records remain because of other vulnerable paths. Package-record totals are not counts of distinct underlying advisories. The pinned CI audit independently rechecks the exact parent lockfile and the proposed lockfile against one feed, validates both baseline JSON audits plus all four current reports with the Phase 6C sanitizer, and publishes a one-day redacted artifact and provenance. Nonzero npm audit/outdated exits are retained, not treated as JSON failure.

Eliminated direct advisory IDs in the observed feed:

- `js-yaml`: GHSA-h67p-54hq-rp68, GHSA-52cp-r559-cp3m, GHSA-5p4m-2wfm-xmqj, GHSA-2883-xcg3-v3hh.
- `undici`: GHSA-vmh5-mc38-953g, GHSA-p88m-4jfj-68fv, GHSA-vxpw-j846-p89q, GHSA-hm92-r4w5-c3mj, GHSA-g8m3-5g58-fq7m, GHSA-pr7r-676h-xcf6, GHSA-8xcm-r25x-g524, GHSA-4cwx-7wf7-3272, GHSA-m8rv-5g2x-5cg5, GHSA-jr45-8vmc-qm54, GHSA-v3r7-h72x-cjcm, GHSA-35p6-xmwp-9g52, GHSA-pmjh-fq2x-6v4x, GHSA-r53p-7pc4-xj5r, GHSA-rfgv-xxqx-mfg5, GHSA-3xpg-4rpp-hhhm, GHSA-2jfj-6hjv-fm6j, GHSA-2gqq-gqf2-x968, GHSA-w293-vg96-wgc3, GHSA-8436-99hf-9mmv, GHSA-rx4f-c7p8-82vq, GHSA-4qv8-2p9j-2685, GHSA-f72v-6w45-q472, GHSA-xjj6-f33q-929c.
- `ws`: GHSA-58qx-3vcg-4xpx, GHSA-96hv-2xvq-fx4p.

## Regression scope and remaining work

`test/batch4TransitiveSecurity.test.js` uses bounded local fixtures for YAML, Cheerio, WebSocket Receiver, OpenAI SDK and Stagehand import. The full suite also reruns Phase 6E private/mixed/rebinding/redirect destination and dummy Firecrawl credential regressions, authorization/tenant isolation, proxy identity, upload, queue/worker and website-agent-disabled behavior. Local Node 24.22.1/npm 11.9.0: 207 passed, 0 failed, 3 PostgreSQL/Redis-dependent tests skipped; the GitHub workflow pins Node 24.21.0/npm 11.19.0 with isolated PostgreSQL 16/pgvector and Redis 7. Tests do not exercise deployed egress, real providers, external WebSocket peers or hostile YAML at unbounded scale.

Future narrowly scoped work: Axios and `ibm-cloud-sdk-core` parent pinning and compatibility; LangSmith/LangChain family migrations; OpenAI SDK compatibility; Zod 3→4 migration; remaining moderate advisories. Do not combine these with this lockfile patch. Firecrawl provider-side egress, HTTPS→HTTP scraper fallback, concurrent 150 MiB uploads, ingress/concurrency limits, API-to-worker file handoff, staging proxy, PostgreSQL TLS, guarded migrations and real HTTPS authentication remain separate deployment blockers.
