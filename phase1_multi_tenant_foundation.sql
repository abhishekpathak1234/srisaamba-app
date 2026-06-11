-- ════════════════════════════════════════════════════════════════
-- Phase 1 · Multi-tenant foundation
-- AutoClient (Sri Saamba AI)
--
--   Tables:    dealerships, dealership_members, invitations
--   Helpers:   current_dealership_id(), current_user_role()
--   RPCs:      create_dealership, create_invitation,
--              accept_invitation, claim_pending_invitations
--   Security:  RLS enabled on all three tables
--
-- Apply with `supabase db push`, or paste into the Supabase
-- dashboard SQL editor and run once.
-- ════════════════════════════════════════════════════════════════

-- ── 1 · Tables ──────────────────────────────────────────────────

create table public.dealerships (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  logo_url            text,
  website             text,
  phone               text,
  address             text,
  timezone            text,
  business_hours      jsonb,
  subscription_plan   text not null default 'starter',
  subscription_status text not null default 'trial',
  created_by          uuid references auth.users(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table public.dealership_members (
  id            uuid primary key default gen_random_uuid(),
  dealership_id uuid not null references public.dealerships(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  role          text not null check (role in ('owner','manager','staff')),
  created_at    timestamptz not null default now(),
  unique (dealership_id, user_id)
);

create index dealership_members_user_id_idx
  on public.dealership_members (user_id);

create table public.invitations (
  id            uuid primary key default gen_random_uuid(),
  dealership_id uuid not null references public.dealerships(id) on delete cascade,
  email         text not null,
  role          text not null check (role in ('owner','manager','staff')),
  token         text unique not null
                  default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  status        text not null default 'pending'
                  check (status in ('pending','accepted','expired','revoked')),
  expires_at    timestamptz not null default now() + interval '7 days',
  created_at    timestamptz not null default now()
);

create index invitations_pending_email_idx
  on public.invitations (lower(email)) where status = 'pending';

-- Keep dealerships.updated_at fresh on every update
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger dealerships_set_updated_at
  before update on public.dealerships
  for each row execute function public.set_updated_at();

-- ── 2 · Helper functions ────────────────────────────────────────
-- SECURITY DEFINER so RLS policies can consult dealership_members
-- without recursing into that table's own policies.

create or replace function public.current_dealership_id()
returns uuid
language sql stable security definer
set search_path = public
as $$
  select dealership_id
  from dealership_members
  where user_id = auth.uid()
  order by created_at
  limit 1;
$$;

create or replace function public.current_user_role()
returns text
language sql stable security definer
set search_path = public
as $$
  select role
  from dealership_members
  where user_id = auth.uid()
  order by created_at
  limit 1;
$$;

-- ── 3 · Row Level Security ──────────────────────────────────────

alter table public.dealerships        enable row level security;
alter table public.dealership_members enable row level security;
alter table public.invitations        enable row level security;

-- dealerships: every member (owner/manager/staff) can read their own
-- dealership; only owners can update or delete it. There is no INSERT
-- policy on purpose: dealerships are created through create_dealership()
-- so the owner membership is always created atomically with the row.

create policy "members_select_dealership"
  on public.dealerships for select to authenticated
  using (id = public.current_dealership_id());

create policy "owner_update_dealership"
  on public.dealerships for update to authenticated
  using (id = public.current_dealership_id()
         and public.current_user_role() = 'owner')
  with check (id = public.current_dealership_id()
              and public.current_user_role() = 'owner');

create policy "owner_delete_dealership"
  on public.dealerships for delete to authenticated
  using (id = public.current_dealership_id()
         and public.current_user_role() = 'owner');

-- dealership_members: the whole team can read the roster of their own
-- dealership; only owners can add, change, or remove members.

create policy "members_select_roster"
  on public.dealership_members for select to authenticated
  using (dealership_id = public.current_dealership_id());

create policy "owner_insert_member"
  on public.dealership_members for insert to authenticated
  with check (dealership_id = public.current_dealership_id()
              and public.current_user_role() = 'owner');

create policy "owner_update_member"
  on public.dealership_members for update to authenticated
  using (dealership_id = public.current_dealership_id()
         and public.current_user_role() = 'owner')
  with check (dealership_id = public.current_dealership_id()
              and public.current_user_role() = 'owner');

create policy "owner_delete_member"
  on public.dealership_members for delete to authenticated
  using (dealership_id = public.current_dealership_id()
         and public.current_user_role() = 'owner');

-- invitations: owners only. Invited users never query this table
-- directly — they join through the SECURITY DEFINER accept RPCs below.

create policy "owner_all_invitations"
  on public.invitations for all to authenticated
  using (dealership_id = public.current_dealership_id()
         and public.current_user_role() = 'owner')
  with check (dealership_id = public.current_dealership_id()
              and public.current_user_role() = 'owner');

-- ── 4 · RPCs ────────────────────────────────────────────────────

-- Onboarding: create the dealership and its owner membership in one
-- transaction. Rejects users who already belong to a dealership.
create or replace function public.create_dealership(
  p_name              text,
  p_logo_url          text  default null,
  p_website           text  default null,
  p_phone             text  default null,
  p_address           text  default null,
  p_timezone          text  default null,
  p_business_hours    jsonb default null,
  p_subscription_plan text  default 'starter'
)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'Dealership name is required';
  end if;
  if exists (select 1 from dealership_members where user_id = auth.uid()) then
    raise exception 'You already belong to a dealership';
  end if;

  insert into dealerships
    (name, logo_url, website, phone, address, timezone, business_hours,
     subscription_plan, created_by)
  values
    (btrim(p_name),
     nullif(btrim(coalesce(p_logo_url, '')), ''),
     nullif(btrim(coalesce(p_website, '')), ''),
     nullif(btrim(coalesce(p_phone, '')), ''),
     nullif(btrim(coalesce(p_address, '')), ''),
     nullif(btrim(coalesce(p_timezone, '')), ''),
     p_business_hours,
     coalesce(nullif(btrim(coalesce(p_subscription_plan, '')), ''), 'starter'),
     auth.uid())
  returning id into v_id;

  insert into dealership_members (dealership_id, user_id, role)
  values (v_id, auth.uid(), 'owner');

  return v_id;
end;
$$;

-- Team invitations (backend only in Phase 1): owners mint a token.
-- Share the link as  login.html?invite=<token>
create or replace function public.create_invitation(
  p_email     text,
  p_role      text     default 'staff',
  p_valid_for interval default interval '7 days'
)
returns text
language plpgsql security definer
set search_path = public
as $$
declare
  v_token text;
begin
  if public.current_user_role() is distinct from 'owner' then
    raise exception 'Only owners can invite team members';
  end if;
  if coalesce(btrim(p_email), '') = '' then
    raise exception 'Email is required';
  end if;
  if p_role not in ('owner','manager','staff') then
    raise exception 'Invalid role: %', p_role;
  end if;

  insert into invitations (dealership_id, email, role, expires_at)
  values (public.current_dealership_id(), lower(btrim(p_email)), p_role,
          now() + p_valid_for)
  returning token into v_token;

  return v_token;
end;
$$;

-- Join via an explicit token (?invite=TOKEN on the login link).
-- Rejects unknown, non-pending, expired, or wrong-email invitations.
create or replace function public.accept_invitation(p_token text)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_inv   invitations%rowtype;
  v_email text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_inv from invitations where token = p_token for update;
  if not found or v_inv.status <> 'pending' then
    raise exception 'Invitation is not valid';
  end if;
  if v_inv.expires_at < now() then
    update invitations set status = 'expired' where id = v_inv.id;
    raise exception 'Invitation has expired';
  end if;

  v_email := lower(coalesce(auth.jwt() ->> 'email', ''));
  if lower(v_inv.email) <> v_email then
    raise exception 'This invitation was issued for a different email address';
  end if;

  insert into dealership_members (dealership_id, user_id, role)
  values (v_inv.dealership_id, auth.uid(), v_inv.role)
  on conflict (dealership_id, user_id) do nothing;

  update invitations set status = 'accepted' where id = v_inv.id;

  return v_inv.dealership_id;
end;
$$;

-- Auto-join: accept every pending, unexpired invitation addressed to
-- the signed-in user's email. Expired ones are marked expired.
-- Returns the first dealership joined, or null if none.
create or replace function public.claim_pending_invitations()
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_email  text;
  v_inv    record;
  v_joined uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  v_email := lower(coalesce(auth.jwt() ->> 'email', ''));
  if v_email = '' then
    return null;
  end if;

  for v_inv in
    select * from invitations
    where lower(email) = v_email and status = 'pending'
    order by created_at
    for update
  loop
    if v_inv.expires_at < now() then
      update invitations set status = 'expired' where id = v_inv.id;
    else
      insert into dealership_members (dealership_id, user_id, role)
      values (v_inv.dealership_id, auth.uid(), v_inv.role)
      on conflict (dealership_id, user_id) do nothing;
      update invitations set status = 'accepted' where id = v_inv.id;
      v_joined := coalesce(v_joined, v_inv.dealership_id);
    end if;
  end loop;

  return v_joined;
end;
$$;

-- ── 5 · Function grants ─────────────────────────────────────────
-- Only signed-in users may call the RPCs; anonymous clients may not.

revoke execute on function public.create_dealership(text,text,text,text,text,text,jsonb,text) from public, anon;
revoke execute on function public.create_invitation(text,text,interval) from public, anon;
revoke execute on function public.accept_invitation(text) from public, anon;
revoke execute on function public.claim_pending_invitations() from public, anon;

grant execute on function public.create_dealership(text,text,text,text,text,text,jsonb,text) to authenticated;
grant execute on function public.create_invitation(text,text,interval) to authenticated;
grant execute on function public.accept_invitation(text) to authenticated;
grant execute on function public.claim_pending_invitations() to authenticated;

grant execute on function public.current_dealership_id() to authenticated;
grant execute on function public.current_user_role() to authenticated;
