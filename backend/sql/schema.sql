-- =========================================================================
-- CCDI Supreme Student Government Election — Supabase schema
-- -------------------------------------------------------------------------
-- Run this once in the Supabase SQL editor (Project → SQL Editor → New
-- query → paste → Run) before starting the backend.
-- =========================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- students
-- Imported from the school's CSV (id_no, name, block). New applicants add
-- their details and ID photo, then receive credentials only after approval.
-- Column order: id_no, first_name, last_name, suffix, block, email,
-- id_photo, approval_status, approval_note, username, password_hash,
-- registered, registered_at, voted, voted_at, created_at.
-- ---------------------------------------------------------------------
create table if not exists students (
  id_no          text primary key check (length(trim(id_no)) > 0),
  first_name     text,
  last_name      text,
  suffix         text,
  block          text,
  email          text,
  id_photo       text,
  approval_status text not null default 'not_submitted',
  approval_note  text,
  username       text unique,
  password_hash  text,
  registered     boolean not null default false,
  registered_at  timestamptz,
  voted          boolean not null default false,
  voted_at       timestamptz,
  created_at     timestamptz not null default now()
);

create index if not exists idx_students_email on students (lower(email));

-- ---------------------------------------------------------------------
-- admins
-- Election officer accounts. Self sign-up or added by another admin from
-- the dashboard, both go through the same table.
-- ---------------------------------------------------------------------
create table if not exists admins (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  email          text unique not null,
  username       text unique not null,
  password_hash  text not null,
  created_at     timestamptz not null default now()
);

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

-- ---------------------------------------------------------------------
-- candidates
-- ---------------------------------------------------------------------
create table if not exists candidates (
  id          uuid primary key default gen_random_uuid(),
  position    text not null,
  name        text not null,
  slogan      text,
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
-- Row Level Security
-- The backend talks to Supabase using the service role key, which
-- bypasses RLS, so the API remains the only door into this data. RLS is
-- still enabled and left with no public policies as defence in depth —
-- if the anon/public key ever leaks, it can't read or write anything.
-- ---------------------------------------------------------------------
alter table students enable row level security;
alter table admins enable row level security;
alter table admin_otp_codes enable row level security;
alter table candidates enable row level security;
alter table votes enable row level security;
alter table settings enable row level security;

-- Registration review fields for existing installations.
alter table students add column if not exists first_name text;
alter table students add column if not exists last_name text;
alter table students add column if not exists suffix text;
alter table students add column if not exists id_photo text;
alter table students add column if not exists approval_status text not null default 'not_submitted';
alter table students add column if not exists approval_note text;
update students set approval_status = 'not_submitted'
where approval_status = 'approved' and registered = false and email is null;

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
