-- one52 USM locked-door backend schema (Supabase / Postgres).
-- Proprietary USM data (prices, article numbers) is service_role-only; the app sees one52 data only.
-- Apply to the chosen project ONLY with the owner's go-ahead (modifies live infra).

-- one52 parts catalog (shippable: ids/labels/families/dims) — readable by authenticated users.
create table if not exists public.part_catalog (
  part   text primary key,
  label  text not null,
  family text not null,
  dims   int[]  default '{}',
  side   text
);
alter table public.part_catalog enable row level security;
drop policy if exists part_catalog_read on public.part_catalog;
create policy part_catalog_read on public.part_catalog for select to authenticated using (true);

-- PROPRIETARY article data (USM prices / article numbers / names) — service_role only.
-- RLS enabled with NO policies => anon & authenticated are denied; only service_role bypasses RLS.
create table if not exists public.private_article (
  art_no   text primary key,
  price_eur numeric,
  weight    numeric,
  name_en   text,
  name_de   text
);
alter table public.private_article enable row level security;
revoke all on public.private_article from anon, authenticated;

-- A user's uploaded configuration (.pxpz stored in the private 'proprietary' bucket).
create table if not exists public.project (
  id         uuid primary key default gen_random_uuid(),
  owner      uuid not null references auth.users(id) default auth.uid(),
  name       text,
  pxpz_path  text,
  created_at timestamptz not null default now()
);
alter table public.project enable row level security;
drop policy if exists project_owner on public.project;
create policy project_owner on public.project for all to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());

-- Solved one52 payload (RealityKit transforms + one52 ids; NO USM identifiers). Owner-only.
create table if not exists public.placement (
  project_id uuid primary key references public.project(id) on delete cascade,
  payload    jsonb not null,
  solved_at  timestamptz not null default now()
);
alter table public.placement enable row level security;
drop policy if exists placement_owner on public.placement;
create policy placement_owner on public.placement for all to authenticated
  using (exists (select 1 from public.project p where p.id = project_id and p.owner = auth.uid()))
  with check (exists (select 1 from public.project p where p.id = project_id and p.owner = auth.uid()));

-- Private storage bucket for proprietary engine data + uploads (create via API/dashboard):
--   insert into storage.buckets (id, name, public) values ('proprietary','proprietary',false);
