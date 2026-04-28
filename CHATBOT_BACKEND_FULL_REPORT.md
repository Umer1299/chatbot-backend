# Chatbot Backend Full System Report

This document explains how the `chatbot-backend` is wired end-to-end, how each subsystem connects (Widget ↔ API ↔ Redis ↔ Pinecone ↔ OpenAI), and what happens in both chat streaming and knowledge upsert flows.

---

## 1) Runtime entrypoints

- **HTTP API server** starts from `src/server.js`, loads env config, imports the Express app, and listens on `PORT` (default `3000`).
- **Background file worker** starts from `src/workers/fileWorker.js` and processes BullMQ jobs for uploaded files.

Together these two processes provide:
- Request/response APIs for widget and admin actions.
- Async ingestion pipeline for large file upserts into Pinecone.

---

## 2) App routing and middleware map

In `src/app.js`:

1. CORS is configured using `WIDGET_ALLOWED_ORIGINS`.
2. JSON body parsing is enabled.
3. Health/readiness routes are exposed (`/health`, `/healthz`, `/ready`, `/readyz`).
4. A Redis-backed `sessionRateLimiter` is applied to all `/api/*` routes.
5. Route groups are mounted:
   - `/api/chat`
   - `/api/upsert`
   - `/api/chatbots`
   - `/api/moderate`
   - `/api/lead`

This keeps a single gateway for widget traffic and admin operations.

---

## 3) Security model (token + domain + CORS)

### 3.1 Token auth

`tokenAuth` middleware expects `x-chatbot-token` from the caller. It resolves token → namespace via Redis key `chatbot_token:<token>`. If valid:
- `req.chatbotToken` and `req.namespace` are attached.
- Otherwise request is rejected (`401`/`403`).

### 3.2 Domain restriction

`domainRestriction` reads `Origin` header and compares host against chatbot's `allowedDomains` stored in Redis (`chatbot:<namespace>`). It supports exact match and wildcard patterns (`*.example.com`).

### 3.3 CORS

CORS in `app.js` allows:
- All origins if `WIDGET_ALLOWED_ORIGINS` is empty.
- Only listed origins when configured.
- Headers include `x-chatbot-token` so browser widget can authenticate safely.

### 3.4 Rate limiting

`sessionRateLimiter` uses Redis store and a key composed from token + IP to throttle request volume (`30` per minute by default).

---

## 4) Chatbot configuration and identity

`/api/chatbots` manages bot settings in Redis:

- `POST /api/chatbots/:namespace`
  - Stores `model`, `systemPrompt`, `allowedDomains` in `chatbot:<namespace>`.
  - Creates/returns long-lived bot token mapping:
    - `chatbot_token:<token> -> <namespace>`
    - `chatbot_namespace_token:<namespace> -> <token>`

- `GET /api/chatbots/:namespace` returns bot settings.
- `GET /api/chatbots` lists all bot configs.
- `DELETE /api/chatbots/:namespace` removes Redis mappings and clears Pinecone namespace.

Namespace is the multitenancy boundary used across chat history and vector retrieval.

---

## 5) `/api/chat` flow (streaming and non-stream)

Route: `POST /api/chat` (optionally `?stream=true`), protected by `tokenAuth` + `domainRestriction`.

### 5.1 Request contract

Expected payload supports:
- `botId`
- `userId` (optional)
- `sessionId`
- `message`
- `model` (optional)
- `systemPrompt` (optional)

Validation and safety checks:
- `botId`, `sessionId`, `message` required.
- `botId` must match token scope (`req.namespace`).
- message must be non-empty.
- model must be in `ALLOWED_MODELS`.
- moderation check can block flagged input.
- input token limit protection (`600`).

### 5.2 Data/read path before model call

Inside `runModel(modelName)`:
1. Load conversation history from Redis list `chat_history:<namespace>:<sessionId>`.
2. Build RAG cache key `rag:<namespace>:<message-prefix>`.
3. Try Redis cache for RAG docs.
4. On cache miss, query Pinecone retriever (`getRetriever(namespace, 4)`) then cache docs in Redis for 5 minutes.
5. Build `systemWithContext` = base prompt + retrieved context.
6. Trim context if token budget exceeds limit.

### 5.3 Generation and streaming behavior

- Creates `ChatOpenAI` with `streaming: isStreaming`.
- While streaming, every token callback writes SSE chunk to response.
- Current chunk shape is backward-compatible:
  - `data: {"text":"...","token":"..."}`
  - `text` is preferred, `token` kept for legacy widgets.

When `?stream=true`:
- Headers:
  - `Content-Type: text/event-stream`
  - `Cache-Control: no-cache`
  - `Connection: keep-alive`
  - `X-Accel-Buffering: no`
- Sends immediate `ready` frame, keep-alive comments every 15s, and a 30s timeout guard.
- On success sends:
  1. `meta` payload (`reply`, token counts, model, creditsUsed)
  2. `[DONE]`

When `stream` is not true:
- Returns normal JSON `{ reply, creditsUsed, ... }`.

### 5.4 Post-generation write path

After model response is ready:
- Save user and assistant messages to Redis history list.
- Increment running cost metric `cost_usd:<namespace>`.
- Run lead detection; if contact intent found, invoke lead capture tool and dedupe with Redis TTL key.

### 5.5 Error handling

- Streaming errors use SSE `event: error` + JSON payload.
- Error messages are sanitized to avoid exposing provider secrets or internal details.
- Non-stream errors return JSON `{ error }`.
- Fallback model logic runs **only** for non-stream mode.

---

## 6) Pinecone integration details

`src/services/pinecone.js`:
- Initializes singleton Pinecone client via `PINECONE_API_KEY`.
- Uses OpenAI embeddings (`text-embedding-3-small`).
- Builds vector store against `PINECONE_INDEX` and per-bot namespace.
- Exposes retriever (`k=4` default used in chat route).

This keeps tenant data isolated by namespace while enabling semantic retrieval for prompts.

---

## 7) Redis usage map

Redis is central for auth, memory, caching, metrics, and async jobs.

Key patterns used:
- `chatbot_token:<token>` → namespace
- `chatbot_namespace_token:<namespace>` → token
- `chatbot:<namespace>` → bot settings
- `chat_history:<namespace>:<sessionId>` → rolling chat memory
- `rag:<namespace>:<message-prefix>` → cached retrieval docs
- `cost_usd:<namespace>` → accumulated model cost
- `lead:<namespace>:<sessionId>` → lead dedupe marker
- `job:<jobId>` → file ingestion job status

---

## 8) Knowledge ingestion (`/api/upsert` + worker)

### 8.1 Synchronous text upsert

`POST /api/upsert` with `text`:
- Checks duplicate content (`isDuplicateContent`).
- Splits text into chunks (1000/200).
- Upserts chunks directly to Pinecone namespace vector store.

### 8.2 Asynchronous file upsert

`POST /api/upsert` with files:
- Files are written to temp storage.
- Each file enqueued in BullMQ `file-processing` queue.
- Returns `jobIds` immediately.

`src/workers/fileWorker.js` then:
- Reads file from disk.
- Loads/parses docs by mime type.
- Removes duplicate docs.
- Splits and upserts chunks to Pinecone namespace.
- Writes final job status to Redis.

`GET /api/upsert/job/:jobId` reads status from Redis.

---

## 9) Moderation and lead capture

- `/api/moderate` wraps OpenAI moderation (optional toggle `MODERATION_ENABLED`).
- Lead detection is done during chat via `detectLead(message)`.
- Lead capture tool posts to `BUBBLE_API_URL` with normalized lead payload.

This allows chat to remain conversational while producing CRM signals asynchronously.

---

## 10) End-to-end request lifecycles

### 10.1 Widget streaming chat lifecycle

1. Widget sends `POST /api/chat?stream=true` with `x-chatbot-token` and payload (`botId`, `sessionId`, `message`, optional fields).
2. Auth + domain checks pass.
3. History + RAG context are assembled from Redis/Pinecone.
4. OpenAI streams tokens; backend forwards SSE chunks immediately.
5. Backend sends `meta` then `[DONE]`.
6. Widget should persist final transcript on `[DONE]` (Bubble save flow).
7. Backend persists history/cost internally.

### 10.2 Knowledge update lifecycle

1. Admin/system calls `/api/upsert` with text/files.
2. Text gets immediate chunk+upsert; files get queued.
3. Worker processes queue and upserts vectors.
4. Future chats retrieve updated knowledge via Pinecone retriever.

---

## 11) Environment variables to verify in production

- `OPENAI_API_KEY`
- `PINECONE_API_KEY`
- `PINECONE_INDEX`
- `REDIS_URL`
- `DEFAULT_MODEL`
- `FALLBACK_MODEL` (optional)
- `MODERATION_ENABLED` (`true/false`)
- `WIDGET_ALLOWED_ORIGINS` (comma-separated URLs)
- `BUBBLE_API_URL` (for lead capture)
- `PORT`
- `WORKER_CONCURRENCY` (worker process)

---

## 12) Operational notes and recommendations

- Keep **API server** and **worker** as separate Render services/processes.
- Use strict `WIDGET_ALLOWED_ORIGINS` in production (do not leave open if not necessary).
- Monitor Redis memory growth from history and cache keys.
- Ensure upstream proxy/CDN does not buffer SSE responses.
- Keep widget parser compatible with both `payload.text` and legacy `payload.token` during migration.

---

## 13) Quick verification checklist

- [ ] `/healthz` and `/readyz` return success.
- [ ] `POST /api/chat?stream=true` returns token chunks quickly.
- [ ] Stream ends with `[DONE]` and includes `meta` payload.
- [ ] Non-stream `/api/chat` returns JSON payload.
- [ ] `/api/upsert` text path writes vectors.
- [ ] `/api/upsert` file path queues jobs and worker completes them.
- [ ] `allowedDomains` and CORS match widget host.
- [ ] Rate limiting is effective but not overly restrictive.

