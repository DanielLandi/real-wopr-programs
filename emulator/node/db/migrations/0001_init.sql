-- 0001_init.sql — NORAD Databanks baseline (plain Postgres / Neon).
-- Source of truth for the schema. Applied in deployment by the engine
-- repo's db/apply.sh from the imported pack copy. Replaces the engine
-- repo's never-applied Supabase migrations 0001–0005 (design:
-- real-wopr docs/superpowers/specs/2026-08-09-neon-migration-design.md).
-- Forward-only from here: never edit this file after it has been applied
-- to a live database; add 0002_*.sql instead.

create table if not exists rooms (
    code         text primary key,
    created_at   timestamptz not null default now(),
    last_seen_at timestamptz not null default now()
);

create table if not exists sessions (
    id                uuid primary key default gen_random_uuid(),
    surface           text not null check (surface in ('home-terminal','norad-terminal','norad-bigboard')),
    link_profile      text not null,
    defcon            int  not null default 5 check (defcon between 1 and 5),
    -- Identity is the WOPR_OPERATORS roster; this column holds a callsign
    -- (the Python field is still Session.user_id).
    operator_callsign text,
    room_code         text references rooms (code),
    system_id         text,
    created_at        timestamptz not null default now(),
    last_seen_at      timestamptz not null default now()
);
create index if not exists idx_sessions_room on sessions (room_code);

-- set_operator persists clearance here so it survives restarts; the roster
-- env var remains the authority at logon time.
create table if not exists operator_clearances (
    callsign   text primary key,
    level      int  not null check (level between 1 and 5),
    updated_at timestamptz not null default now()
);

create table if not exists game_states (
    id             uuid primary key default gen_random_uuid(),
    session_id     uuid not null references sessions (id) on delete cascade,
    game_id        text not null,
    state          text not null,  -- opaque STATE block, stored verbatim
    status         text not null check (status in ('PLAYING','WIN','LOSS','DRAW','NO-WIN','ERROR','QUIT')),
    turn           int  not null default 0,
    interpretation text not null default 'core',
    updated_at     timestamptz not null default now()
);
create index if not exists game_states_session_idx on game_states (session_id, updated_at desc);
create index if not exists game_states_latest_idx on game_states (game_id, status, updated_at desc);

create table if not exists event_logs (
    id         bigint generated always as identity primary key,
    session_id uuid references sessions (id) on delete set null,
    ts         timestamptz not null default now(),
    kind       text not null check (kind in ('input','route','core','joshua','handshake','error')),
    actor      text not null check (actor in ('user','wopr','joshua','system')),
    payload    jsonb not null default '{}'::jsonb
);
create index if not exists event_logs_session_idx on event_logs (session_id, ts desc);

create table if not exists session_system_state (
    session_id uuid primary key references sessions (id) on delete cascade,
    state      text not null default '',
    updated_at timestamptz not null default now()
);

-- The phone book. No RLS, no anon grants: the bridge is the only client;
-- registration is forced approved=false at the application layer.
create table if not exists exchanges (
    id         text primary key check (id ~ '^[a-z0-9-]{2,40}$'),
    name       text not null check (char_length(name) between 2 and 60),
    region     text not null check (char_length(region) between 2 and 40),
    api        text not null check (api ~ '^https://'),
    link       text not null check (link ~ '^wss://'),
    joshua     text not null check (joshua in ('claude','period')),
    operator   text,
    approved   boolean not null default false,
    created_at timestamptz not null default now()
);
