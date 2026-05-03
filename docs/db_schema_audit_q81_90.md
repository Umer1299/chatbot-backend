# Database Schema Audit (Q81–Q90)

Source: `src/db/migrations/001_initial_schema.sql` and `src/db/migrate.js`.

- Lists all current tables and purpose.
- Identifies `business_id` and `bot_id` usage.
- Verifies foreign keys and indexes.
- Confirms pgvector extension and embedding dimension.
- Notes production/idempotency risks.
- Highlights likely missing tables for agents, gap tracking, audit logs, and weekly reports.
