-- Additive schema for VoteDesk's election-scoped data.
-- Safe to run on an existing project; does not alter legacy tables.

create extension if not exists pgcrypto;

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

alter table elections enable row level security;
alter table election_voters enable row level security;
alter table election_candidates enable row level security;
alter table election_votes enable row level security;
