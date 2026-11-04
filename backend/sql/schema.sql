-- =========================================================================
-- CCDI Supreme Student Government Election — Supabase schema
-- -------------------------------------------------------------------------
-- Run this once in the Supabase SQL editor (Project → SQL Editor → New
-- query → paste → Run) before starting the backend.
-- =========================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- students
-- Imported from the school's CSV (id_no, name, block). Students receive
-- credentials after their submitted ID, name, and block match the roster.
-- Column order: id_no, first_name, last_name, suffix, block, email,
-- username, password_hash, registered, registered_at, voted, voted_at,
-- created_at.
-- ---------------------------------------------------------------------
create table if not exists students (
  id_no          text primary key check (length(trim(id_no)) > 0),
  first_name     text,
  last_name      text,
  suffix         text,
  block          text,
  email          text,
  username       text unique,
  password_hash  text,
  registered     boolean not null default false,
  registered_at  timestamptz,
  voted          boolean not null default false,
  voted_at       timestamptz,
  created_at     timestamptz not null default now()
);

create index if not exists idx_students_email on students (lower(email));
create unique index if not exists idx_students_email_unique
  on students (lower(btrim(email)))
  where email is not null and btrim(email) <> '';

-- ---------------------------------------------------------------------
-- admins
-- Admin and Staff accounts. Election officers keep the Admin role; Staff
-- accounts are created by an Admin and have restricted dashboard access.
-- ---------------------------------------------------------------------
create table if not exists admins (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  email          text unique not null,
  party_list     text,
  username       text unique not null,
  password_hash  text not null,
  role           text not null default 'admin' check (role in ('admin', 'staff')),
  created_at     timestamptz not null default now()
);

alter table admins add column if not exists role text not null default 'admin';

-- ---------------------------------------------------------------------
-- admin_otp_codes
-- Short-lived one-time codes emailed to an admin's Gmail at login.
-- ---------------------------------------------------------------------
create table if not exists admin_otp_codes (
  id          uuid primary key default gen_random_uuid(),
  admin_id    uuid not null references admins(id) on delete cascade,
  code        text not null,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

-- Separate one-time codes for admin password recovery; kept separate from
-- login OTPs so a reset code can never be used to sign in.
create table if not exists admin_password_reset_codes (
  id          uuid primary key default gen_random_uuid(),
  admin_id    uuid not null references admins(id) on delete cascade,
  code        text not null,
  expires_at  timestamptz not null,
  attempts    integer not null default 0,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- candidates
-- ---------------------------------------------------------------------
create table if not exists candidates (
  id          uuid primary key default gen_random_uuid(),
  position    text not null,
  name        text not null,
  id_no       text,
  block       text,
  party       text,
  photo       text,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- votes
-- One row per student per position. The unique constraint is what
-- actually stops a student voting twice for the same position even if
-- two requests land at the same time.
-- ---------------------------------------------------------------------
create table if not exists votes (
  id               uuid primary key default gen_random_uuid(),
  student_id_no    text not null references students(id_no) on delete cascade,
  position         text not null,
  candidate_name   text not null,
  created_at       timestamptz not null default now(),
  unique (student_id_no, position)
);

-- ---------------------------------------------------------------------
-- settings
-- Single row per key. Currently just the global voting on/off switch.
-- ---------------------------------------------------------------------
create table if not exists settings (
  key    text primary key,
  value  text
);
insert into settings (key, value) values ('voting_open', 'false')
  on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- activity_logs
-- Admin-visible audit trail. Never store passwords, OTPs, or vote choices.
-- ---------------------------------------------------------------------
create table if not exists activity_logs (
  id          uuid primary key default gen_random_uuid(),
  actor_role  text not null,
  actor_id    text,
  actor_name  text not null,
  action      text not null,
  summary     text not null,
  target_type text,
  target_id   text,
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists idx_activity_logs_created_at
  on activity_logs (created_at desc);

-- ---------------------------------------------------------------------
-- Independent elections created from the VoteDesk admin dashboard.
-- The original tables above remain the legacy/current-election storage.
-- Passwords in election_voters are bcrypt hashes only.
-- ---------------------------------------------------------------------
create table if not exists elections (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (length(trim(name)) > 0),
  year          integer not null check (year between 1900 and 9999),
  election_date date not null,
  is_sample     boolean not null default false,
  status        text not null default 'Upcoming'
                check (status in ('Upcoming', 'Open', 'Certified', 'Archived')),
  voting_open   boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (id, year)
);
alter table elections add column if not exists is_sample boolean not null default false;
create unique index if not exists idx_elections_year_name_unique
  on elections (year, lower(btrim(name)));
create index if not exists idx_elections_date on elections (election_date desc);

create table if not exists election_voters (
  id                    uuid primary key default gen_random_uuid(),
  election_id           uuid not null references elections(id) on delete cascade,
  voter_id              text not null,
  name                  text not null check (length(trim(name)) > 0),
  normalized_name       text not null,
  block                 text not null check (length(trim(block)) > 0),
  email                 text not null,
  username              text not null,
  password_hash         text not null,
  credential_delivery   text not null default 'pending'
                        check (credential_delivery in ('pending', 'sent', 'failed', 'sample')),
  voted                 boolean not null default false,
  voted_at              timestamptz,
  created_at            timestamptz not null default now(),
  unique (election_id, id),
  unique (election_id, voter_id)
);
create unique index if not exists idx_election_voters_username_unique
  on election_voters (election_id, lower(btrim(username)));
create unique index if not exists idx_election_voters_email_unique
  on election_voters (election_id, lower(btrim(email)));
create index if not exists idx_election_voters_election_block
  on election_voters (election_id, block);
create index if not exists idx_election_voters_election_name
  on election_voters (election_id, normalized_name);

create table if not exists election_candidates (
  id            uuid primary key default gen_random_uuid(),
  election_id   uuid not null references elections(id) on delete cascade,
  voter_id      uuid not null,
  position      text not null check (length(trim(position)) > 0),
  name          text not null check (length(trim(name)) > 0),
  block         text not null,
  slate         text not null default 'Independent',
  ballot_number integer not null,
  created_at    timestamptz not null default now(),
  unique (election_id, id),
  unique (election_id, position, voter_id),
  unique (election_id, position, ballot_number),
  foreign key (election_id, voter_id)
    references election_voters(election_id, id) on delete cascade
);
create index if not exists idx_election_candidates_election_position
  on election_candidates (election_id, position, ballot_number);

create table if not exists election_votes (
  id             uuid primary key default gen_random_uuid(),
  election_id    uuid not null references elections(id) on delete cascade,
  voter_id       uuid not null,
  candidate_id   uuid not null,
  position       text not null,
  created_at     timestamptz not null default now(),
  foreign key (election_id, voter_id)
    references election_voters(election_id, id) on delete cascade,
  foreign key (election_id, candidate_id)
    references election_candidates(election_id, id) on delete cascade,
  unique (voter_id, position)
);
create index if not exists idx_election_votes_election_position
  on election_votes (election_id, position);

-- ---------------------------------------------------------------------
-- Row Level Security
-- The backend talks to Supabase using the service role key, which
-- bypasses RLS, so the API remains the only door into this data. RLS is
-- still enabled and left with no public policies as defence in depth —
-- if the anon/public key ever leaks, it can't read or write anything.
-- ---------------------------------------------------------------------
alter table students enable row level security;
alter table admins enable row level security;
alter table admin_otp_codes enable row level security;
alter table admin_password_reset_codes enable row level security;
alter table candidates enable row level security;
alter table votes enable row level security;
alter table settings enable row level security;
alter table activity_logs enable row level security;
alter table elections enable row level security;
alter table election_voters enable row level security;
alter table election_candidates enable row level security;
alter table election_votes enable row level security;

-- Name fields for existing installations.
alter table students add column if not exists first_name text;
alter table students add column if not exists last_name text;
alter table students add column if not exists suffix text;

-- Migrate older installations that still have the combined name column.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'students' and column_name = 'name'
  ) then
    execute 'update students
      set last_name = coalesce(last_name, nullif(split_part(name, '','', 1), '''')),
          first_name = coalesce(first_name, nullif(trim(split_part(name, '','', 2)), ''''))
      where first_name is null or last_name is null';
    execute 'alter table students drop column name';
  end if;
end $$;

-- Block already contains the course and section (for example, BSCS-3).
alter table students drop column if exists course;
alter table admins add column if not exists party_list text;
alter table candidates add column if not exists party text;
alter table candidates add column if not exists photo text;
alter table candidates add column if not exists id_no text;
alter table candidates add column if not exists block text;
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'candidates' and column_name = 'slogan'
  ) then
    execute 'update public.candidates set party = slogan where party is null and slogan is not null';
  end if;
end $$;
alter table candidates drop column if exists slogan;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'students_id_no_not_blank'
  ) then
    alter table students add constraint students_id_no_not_blank check (length(trim(id_no)) > 0);
  end if;
end $$;
-- (No policies are created, which means: no access via the anon/public
--  key at all. Only the service role key, used server-side, can read or
--  write these tables.)
