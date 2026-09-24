create extension if not exists pgcrypto;

create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  external_id text not null unique,
  name text not null,
  email text not null,
  phone text,
  created_at timestamptz not null default now()
);

create table if not exists journeys (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id) on delete cascade,
  journey_type text not null check (journey_type in ('ecommerce', 'fintech', 'logistics')),
  status text not null default 'active' check (status in ('active', 'resolved', 'abandoned')),
  started_at timestamptz not null default now(),
  resolved_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  check ((status = 'resolved' and resolved_at is not null) or status <> 'resolved')
);

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  journey_id uuid not null references journeys(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  event_type text not null,
  occurred_at timestamptz not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists events_journey_occurred_at_idx on events (journey_id, occurred_at);

create table if not exists friction_scores (
  id uuid primary key default gen_random_uuid(),
  journey_id uuid not null references journeys(id) on delete cascade,
  score numeric(5, 2) not null check (score >= 0 and score <= 100),
  factors jsonb not null default '[]'::jsonb,
  predicted_frustration_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists friction_scores_journey_created_at_idx on friction_scores (journey_id, created_at desc);

create table if not exists resolutions (
  id uuid primary key default gen_random_uuid(),
  journey_id uuid not null references journeys(id) on delete cascade,
  resolution_type text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'executed', 'failed')),
  action_payload jsonb not null default '{}'::jsonb,
  compensation_amount numeric(12, 2),
  executed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists resolutions_journey_created_at_idx on resolutions (journey_id, created_at desc);