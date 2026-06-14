-- ════════════════════════════════════════════════════════════════
-- Phase 3b · Calendar Stabilization
-- AutoClient (Sri Saamba AI)
--
--   Extends:  public.appointments
--     + customer_name  text   — denormalised display name (avoids
--                               join failures when customer_id is null
--                               or RLS blocks the FK lookup)
--
-- Idempotent (uses IF NOT EXISTS).
-- Apply after phase3_calendar_extension.sql.
-- ════════════════════════════════════════════════════════════════

ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS customer_name text;

COMMENT ON COLUMN public.appointments.customer_name IS
  'Denormalised customer display name — stored at booking time so the '
  'Calendar page never shows "Unknown" when the customers FK join is null.';

-- Backfill from the customers join for all existing rows
UPDATE public.appointments a
SET customer_name = trim(
      coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, ''))
FROM public.customers c
WHERE a.customer_id = c.id
  AND (a.customer_name IS NULL OR a.customer_name = '');
