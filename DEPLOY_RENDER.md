# Deploying `chatbot-backend` to Render

This project should be deployed as **two Render services**:

1. **Web Service** (Express API)
2. **Background Worker** (`src/workers/fileWorker.js`) for queue processing

A Redis instance is also required.

---

## 1) Quick deploy (recommended): Blueprint

This repo includes `render.yaml` so you can provision all services in one go.

### Steps

1. Push this repository to GitHub.
2. In Render: **Dashboard → New → Blueprint**.
3. Select this repository.
4. Render will detect `render.yaml` and create:
   - `chatflow-backend` (web)
   - `chatflow-file-worker` (worker)
   - `chatflow-redis` (Redis)
5. Fill the secret environment variables when prompted.
6. Deploy.

---

## 2) Manual deploy (UI form) — exact values

If creating from **New Web Service** UI instead of blueprint, use these values.

### Web service

- **Name:** `chatflow-backend`
- **Language/Runtime:** Node
- **Branch:** `main`
- **Region:** Virginia (or same region as Redis)
- **Root Directory:** *(leave empty)*
- **Build Command:** `npm ci`
- **Start Command:** `npm start` *(this runs `node src/server.js`)*
- **Health Check Path:** `/healthz`

> In your screenshot, `node index.js` is selected. This repo does **not** use `index.js` as entrypoint, so use `npm start`.

### Worker service

Create a separate **Background Worker**:

- **Name:** `chatflow-file-worker`
- **Language/Runtime:** Node
- **Branch:** `main`
- **Region:** same as web service
- **Build Command:** `npm ci`
- **Start Command:** `npm run worker`

### Redis

Create a Render Redis service:

- **Name:** `chatflow-redis`
- **Plan:** Starter (or higher)
- Copy its internal URL to `REDIS_URL` for both web + worker.

---


## Screenshot values (exact fields from your Render form)

Use this mapping for the **New Web Service** screen you shared:

- **Source Code:** `Umer1299/chatbot-backend`
- **Name:** `ChatflowAI-Backend` *(or `chatflow-backend` for lowercase convention)*
- **Project / Environment:** `Chatflow / Production`
- **Language:** `Node`
- **Branch:** `main`
- **Region:** `Virginia (US East)`
- **Root Directory:** *(empty)*
- **Build Command:** `npm ci` *(or `npm install` if you prefer; `npm ci` is more reproducible)*
- **Start Command:** `npm start` **(not `node index.js`)**
- **Health Check Path:** `/healthz`
- **Instance Type:** `Free` (dev/test) or `Starter/Standard` (prod)

## 3) Environment variables

Set these on **both web and worker** unless marked web-only.

### Required

- `OPENAI_API_KEY`
- `PINECONE_API_KEY`
- `PINECONE_INDEX`
- `REDIS_URL`

### Recommended defaults

- `DEFAULT_MODEL=gpt-4.1-mini`
- `FALLBACK_MODEL=gpt-4.1-mini`
- `MODERATION_ENABLED=true`
- `WORKER_CONCURRENCY=2` *(worker only; web can ignore)*

### Optional (only if you use lead capture integration)

- `BUBBLE_API_URL`

### Auto-provided by Render

- `PORT` (your server already reads this automatically)

---

## 4) Post-deploy checks

After deploy succeeds:

1. Open `https://<your-web-service>.onrender.com/healthz` → should return `OK`.
2. Open `https://<your-web-service>.onrender.com/readyz` → should return `Ready`.
3. Trigger an `/api/upsert` flow and confirm jobs are consumed by worker logs.
4. Verify `/api/chat` responses and fallback behavior if model errors.

---

## 5) Common pitfalls

- **Wrong start command**: `node index.js` will fail for this repo.
- **Only deploying web service**: queue jobs won't process unless worker is running.
- **Missing Redis**: token auth/rate limit/queue and chatbot configs rely on Redis.
- **Region mismatch**: keep web, worker, and Redis in same region for lower latency.
- **Using free plan for worker+redis under load**: can throttle or sleep unexpectedly.

---

## 6) Suggested production hardening

- Upgrade web + worker plans beyond free for stability.
- Add Render alerts for failed deploys and high restart count.
- Restrict CORS in `src/app.js` for known domains.
- Keep secrets in Render env vars (never commit `.env`).

