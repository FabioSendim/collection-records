-- Run in the Supabase SQL Editor as the project administrator.
-- Public visitors can read the collection; only the configured owner can save.

begin;

create table if not exists public.collection_state (
  id boolean primary key default true check (id),
  version bigint not null default 0 check (version >= 0),
  payload jsonb,
  updated_at timestamptz not null default now(),
  constraint collection_state_payload_check check (
    (version = 0 and payload is null)
    or (version > 0 and payload is not null and jsonb_typeof(payload) = 'object')
  )
);

-- Store images separately so editing a note does not upload every image again.
create table if not exists public.collection_assets (
  hash text primary key check (hash ~ '^[0-9a-f]{64}$'),
  content text not null check (
    content ~ '^data:image/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$'
  ),
  created_at timestamptz not null default now()
);

alter table public.collection_state enable row level security;
alter table public.collection_assets enable row level security;

revoke all on public.collection_state from public, anon, authenticated;
revoke all on public.collection_assets from public, anon, authenticated;
grant select on public.collection_state to anon, authenticated;
grant select on public.collection_assets to anon, authenticated;
grant insert on public.collection_assets to authenticated;

drop policy if exists collection_state_public_read on public.collection_state;
create policy collection_state_public_read on public.collection_state
  for select to anon, authenticated using (true);

drop policy if exists collection_assets_public_read on public.collection_assets;
create policy collection_assets_public_read on public.collection_assets
  for select to anon, authenticated using (true);

drop policy if exists collection_assets_owner_insert on public.collection_assets;
create policy collection_assets_owner_insert on public.collection_assets
  for insert to authenticated
  with check (auth.uid() = 'e585fe35-5450-4588-b33a-0098fbf93415'::uuid);

insert into public.collection_state (id) values (true)
  on conflict (id) do nothing;

-- Compare versions atomically to prevent a stale browser overwriting changes
-- saved on another device. Direct updates are not granted to browser clients.
create or replace function public.save_collection(
  expected_version bigint,
  new_payload jsonb
)
returns public.collection_state
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved public.collection_state;
begin
  if auth.uid() is distinct from 'e585fe35-5450-4588-b33a-0098fbf93415'::uuid then
    raise exception 'Only the collection owner can save changes.'
      using errcode = '42501';
  end if;

  if expected_version is null or expected_version < 0
    or new_payload is null or pg_catalog.jsonb_typeof(new_payload) <> 'object' then
    raise exception 'Invalid collection payload or version.'
      using errcode = '22023';
  end if;

  update public.collection_state
  set payload = new_payload,
      version = version + 1,
      updated_at = pg_catalog.now()
  where id = true and version = expected_version
  returning * into saved;

  if not found then
    raise exception 'The collection changed on another device. Reload before saving.'
      using errcode = '40001';
  end if;

  return saved;
end;
$$;

revoke all on function public.save_collection(bigint, jsonb) from public, anon;
grant execute on function public.save_collection(bigint, jsonb) to authenticated;

commit;
