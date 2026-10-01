-- NDS initial schema (PDR §6). Applied by `npm run migrate` (src/db/migrate.ts).
-- All statements are idempotent so re-running the migration is a no-op.

create table if not exists jobs (
  id                uuid primary key default gen_random_uuid(),
  idempotency_key   text unique not null,
  type              text not null check (type in ('email', 'webhook')),
  payload           jsonb not null,
  status            text not null default 'queued'
                      check (status in ('queued', 'processing', 'completed', 'failed', 'dead_letter')),
  attempts          int not null default 0,
  max_attempts      int not null default 5,
  last_error        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists jobs_status_idx on jobs (status);
create index if not exists jobs_idempotency_key_idx on jobs (idempotency_key);
