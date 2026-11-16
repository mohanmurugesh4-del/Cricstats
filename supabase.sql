-- CricStats database setup.
-- Run this whole file once in Supabase: SQL Editor -> New query -> paste -> Run.

create extension if not exists pgcrypto with schema extensions;

-- ---------- tables ----------

-- One row per user. Created automatically at sign-up. role is 'viewer' or 'admin'.
create table public.profiles (
  id    uuid primary key references auth.users(id) on delete cascade,
  email text,
  role  text not null default 'viewer' check (role in ('viewer', 'admin'))
);

-- Hashes of admin invite codes. No policies, so the website can never read or write it.
create table public.admin_codes (
  code_hash text primary key
);

create table public.matches (
  id             uuid primary key default gen_random_uuid(),
  owner          uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title          text not null,
  team_a         text not null,
  team_b         text not null,
  overs          int  not null check (overs between 1 and 50),
  batting_first  text not null default 'a' check (batting_first in ('a', 'b')),
  published      boolean not null default false,   -- false = only the owner can see it
  created_at     timestamptz not null default now()
);

create table public.players (
  id       uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches(id) on delete cascade,
  team     text not null check (team in ('a', 'b')),
  position int  not null,
  name     text not null check (length(trim(name)) > 0)
);

-- The scoring log. Each row is one delivery. Scores are worked out from these rows.
create table public.match_events (
  id       bigint generated always as identity primary key,
  match_id uuid not null references public.matches(id) on delete cascade,
  innings  int  not null check (innings in (1, 2)),
  seq      int  not null,
  ball     jsonb not null,
  unique (match_id, seq)
);

-- ---------- helper functions ----------

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin');
$$;

create or replace function public.can_view_match(mid uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from matches m
    where m.id = mid and (m.owner = auth.uid() or (m.published and auth.uid() is not null))
  );
$$;

create or replace function public.is_match_owner(mid uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (select 1 from matches m where m.id = mid and m.owner = auth.uid());
$$;

-- Admin registration: the website sends the invite code; only a code that is in admin_codes works.
create or replace function public.claim_admin(code text)
returns boolean language plpgsql security definer set search_path = public, extensions
as $$
begin
  if auth.uid() is null then
    return false;
  end if;
  if exists (select 1 from admin_codes where code_hash = encode(extensions.digest(code, 'sha256'), 'hex')) then
    update profiles set role = 'admin' where id = auth.uid();
    return found;
  end if;
  return false;
end;
$$;

-- Creates a profile for every new sign-up.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- row level security ----------

alter table public.profiles    enable row level security;
alter table public.admin_codes enable row level security;
alter table public.matches     enable row level security;
alter table public.players     enable row level security;
alter table public.match_events enable row level security;

create policy "read own profile" on public.profiles
  for select using (id = auth.uid());

-- Matches: the owner always sees their match; other signed-in users see it only when published.
create policy "view matches" on public.matches
  for select using (owner = auth.uid() or (published and auth.uid() is not null));
create policy "admins create matches" on public.matches
  for insert with check (owner = auth.uid() and is_admin());
create policy "owner updates match" on public.matches
  for update using (owner = auth.uid()) with check (owner = auth.uid());
create policy "owner deletes match" on public.matches
  for delete using (owner = auth.uid());

-- Players (names): visible wherever the match is visible; only the owner changes them.
create policy "view players" on public.players
  for select using (can_view_match(match_id));
create policy "owner adds players" on public.players
  for insert with check (is_match_owner(match_id));
create policy "owner renames players" on public.players
  for update using (is_match_owner(match_id)) with check (is_match_owner(match_id));
create policy "owner removes players" on public.players
  for delete using (is_match_owner(match_id));

-- Scoring: anyone who can see the match can read the balls; only an admin who owns it can score.
create policy "view balls" on public.match_events
  for select using (can_view_match(match_id));
create policy "owner adds balls" on public.match_events
  for insert with check (is_match_owner(match_id) and is_admin());
create policy "owner removes balls" on public.match_events
  for delete using (is_match_owner(match_id) and is_admin());

-- ---------- live updates ----------

alter publication supabase_realtime add table public.matches, public.players, public.match_events;

-- ---------- admin invite codes ----------
-- Add an admin code. Replace MY-SECRET-CODE with your own code and keep it private.
-- Anyone who registers as an admin with this exact code gets admin rights.
-- Run this line separately whenever you want to add a code:
--
-- insert into public.admin_codes (code_hash) values (encode(extensions.digest('MY-SECRET-CODE', 'sha256'), 'hex'));
