-- Shared procurement workspace.  Access is limited to authenticated team members;
-- no Google-specific provider or role hierarchy is required.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  created_at timestamptz not null default now()
);

create table if not exists public.catalog_items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  material text not null,
  characteristics text not null default '',
  synonyms text not null default '',
  source_url text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.procurements (
  id uuid primary key default gen_random_uuid(),
  external_id text unique,
  source text not null,
  block text not null check (block in ('budget', 'commercial')),
  title text not null,
  buyer text not null default '',
  region text not null default '',
  budget numeric,
  currency text not null default 'UAH',
  deadline timestamptz,
  url text,
  status text not null default 'active',
  material text not null default '',
  characteristics text not null default '',
  volume text not null default '',
  evidence text not null default '',
  winner text not null default '',
  winner_contacts text not null default '',
  document_confidence text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.procurement_documents (
  id uuid primary key default gen_random_uuid(),
  procurement_id uuid not null references public.procurements(id) on delete cascade,
  title text not null,
  format text not null default '',
  external_url text,
  storage_path text,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  check (external_url is not null or storage_path is not null)
);

create table if not exists public.document_analyses (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.procurement_documents(id) on delete cascade,
  status text not null,
  reason text,
  text_length integer,
  findings jsonb not null default '[]'::jsonb,
  analyzed_at timestamptz not null default now(),
  analyzed_by uuid references public.profiles(id) on delete set null
);

create index if not exists procurements_block_deadline_idx on public.procurements(block, deadline desc);
create index if not exists procurement_documents_procurement_idx on public.procurement_documents(procurement_id);
create index if not exists document_analyses_document_idx on public.document_analyses(document_id);

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists catalog_items_updated_at on public.catalog_items;
create trigger catalog_items_updated_at before update on public.catalog_items
for each row execute procedure public.set_updated_at();

drop trigger if exists procurements_updated_at on public.procurements;
create trigger procurements_updated_at before update on public.procurements
for each row execute procedure public.set_updated_at();

create or replace function public.create_profile_for_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(id, email, display_name)
  values (new.id, coalesce(new.email, ''), new.raw_user_meta_data ->> 'display_name')
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute procedure public.create_profile_for_user();

alter table public.profiles enable row level security;
alter table public.catalog_items enable row level security;
alter table public.procurements enable row level security;
alter table public.procurement_documents enable row level security;
alter table public.document_analyses enable row level security;

drop policy if exists "team reads profiles" on public.profiles;
create policy "team reads profiles" on public.profiles for select to authenticated using (true);
drop policy if exists "user updates own profile" on public.profiles;
create policy "user updates own profile" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "team reads catalog" on public.catalog_items;
create policy "team reads catalog" on public.catalog_items for select to authenticated using (true);
drop policy if exists "team creates catalog" on public.catalog_items;
create policy "team creates catalog" on public.catalog_items for insert to authenticated with check (created_by = auth.uid());
drop policy if exists "team updates catalog" on public.catalog_items;
create policy "team updates catalog" on public.catalog_items for update to authenticated using (true) with check (true);
drop policy if exists "team deletes catalog" on public.catalog_items;
create policy "team deletes catalog" on public.catalog_items for delete to authenticated using (true);

drop policy if exists "team reads procurements" on public.procurements;
create policy "team reads procurements" on public.procurements for select to authenticated using (true);
drop policy if exists "team creates procurements" on public.procurements;
create policy "team creates procurements" on public.procurements for insert to authenticated with check (created_by = auth.uid());
drop policy if exists "team updates procurements" on public.procurements;
create policy "team updates procurements" on public.procurements for update to authenticated using (true) with check (true);
drop policy if exists "team deletes procurements" on public.procurements;
create policy "team deletes procurements" on public.procurements for delete to authenticated using (true);

drop policy if exists "team reads documents" on public.procurement_documents;
create policy "team reads documents" on public.procurement_documents for select to authenticated using (true);
drop policy if exists "team creates documents" on public.procurement_documents;
create policy "team creates documents" on public.procurement_documents for insert to authenticated with check (true);
drop policy if exists "team updates documents" on public.procurement_documents;
create policy "team updates documents" on public.procurement_documents for update to authenticated using (true) with check (true);
drop policy if exists "team deletes documents" on public.procurement_documents;
create policy "team deletes documents" on public.procurement_documents for delete to authenticated using (true);

drop policy if exists "team reads analyses" on public.document_analyses;
create policy "team reads analyses" on public.document_analyses for select to authenticated using (true);
drop policy if exists "team creates analyses" on public.document_analyses;
create policy "team creates analyses" on public.document_analyses for insert to authenticated with check (analyzed_by = auth.uid());
drop policy if exists "team updates analyses" on public.document_analyses;
create policy "team updates analyses" on public.document_analyses for update to authenticated using (true) with check (true);

insert into storage.buckets (id, name, public)
values ('procurement-files', 'procurement-files', false)
on conflict (id) do nothing;

drop policy if exists "team reads stored files" on storage.objects;
create policy "team reads stored files" on storage.objects for select to authenticated
using (bucket_id = 'procurement-files');
drop policy if exists "team uploads stored files" on storage.objects;
create policy "team uploads stored files" on storage.objects for insert to authenticated
with check (bucket_id = 'procurement-files');
drop policy if exists "team updates stored files" on storage.objects;
create policy "team updates stored files" on storage.objects for update to authenticated
using (bucket_id = 'procurement-files') with check (bucket_id = 'procurement-files');
drop policy if exists "team deletes stored files" on storage.objects;
create policy "team deletes stored files" on storage.objects for delete to authenticated
using (bucket_id = 'procurement-files');
