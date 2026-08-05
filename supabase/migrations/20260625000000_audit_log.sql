-- ════════════════════════════════════════════════════════════════
-- Audit log  ·  AutoClient (Sri Saamba AI)
--
--   Table:  audit_logs — append-only record of security-relevant
--           actions, tenant-scoped by dealership_id.
--   RLS:    members read their own dealership's log; only owners/
--           managers may read; NOBODY may update or delete (append-only).
--   RPC:    log_audit_event() — SECURITY DEFINER insert helper so the
--           app and edge functions can write entries without granting
--           direct INSERT on the table.
--
-- Additive and safe to apply on a live database. Apply with
-- `supabase db push` (or paste into the Supabase SQL editor).
-- Requires the Phase 1 migration (current_dealership_id / current_user_role).
-- ════════════════════════════════════════════════════════════════

create table if not exists public.audit_logs (
  id            uuid primary key default gen_random_uuid(),
  dealership_id uuid references public.dealerships(id) on delete cascade,
  user_id       uuid references auth.users(id) on delete set null,
  action        text not null,          -- e.g. 'login', 'user.delete', 'role.change', 'appointment.delete'
  entity        text,                   -- table/entity affected, e.g. 'appointments'
  entity_id     text,                   -- affected row id (text — may be non-uuid)
  old_value     jsonb,
  new_value     jsonb,
  ip_address    inet,
  user_agent    text,
  created_at    timestamptz not null default now()
);

create index if not exists audit_logs_dealer_idx
  on public.audit_logs (dealership_id, created_at desc);
create index if not exists audit_logs_action_idx
  on public.audit_logs (action, created_at desc);

alter table public.audit_logs enable row level security;

-- Read: owners and managers of the dealership only. (Append-only: no
-- insert/update/delete policies — writes go exclusively through the
-- SECURITY DEFINER function below, reads are scoped, mutation is denied.)
drop policy if exists "managers_read_audit" on public.audit_logs;
create policy "managers_read_audit"
  on public.audit_logs for select to authenticated
  using (
    dealership_id = public.current_dealership_id()
    and public.current_user_role() in ('owner', 'manager')
  );

-- Append helper. Stamps dealership_id/user_id from the caller's session by
-- default so callers cannot forge another tenant's log entry. Edge functions
-- (service role) may pass p_dealership_id / p_user_id explicitly.
create or replace function public.log_audit_event(
  p_action        text,
  p_entity        text  default null,
  p_entity_id     text  default null,
  p_old_value     jsonb default null,
  p_new_value     jsonb default null,
  p_ip_address    inet  default null,
  p_user_agent    text  default null,
  p_dealership_id uuid  default null,
  p_user_id       uuid  default null
)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_id     uuid;
  v_dealer uuid := coalesce(p_dealership_id, public.current_dealership_id());
  v_user   uuid := coalesce(p_user_id, auth.uid());
begin
  if coalesce(btrim(p_action), '') = '' then
    raise exception 'action is required';
  end if;

  insert into audit_logs
    (dealership_id, user_id, action, entity, entity_id,
     old_value, new_value, ip_address, user_agent)
  values
    (v_dealer, v_user, p_action, p_entity, p_entity_id,
     p_old_value, p_new_value, p_ip_address, p_user_agent)
  returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function public.log_audit_event(text,text,text,jsonb,jsonb,inet,text,uuid,uuid) from public, anon;
grant  execute on function public.log_audit_event(text,text,text,jsonb,jsonb,inet,text,uuid,uuid) to authenticated;
